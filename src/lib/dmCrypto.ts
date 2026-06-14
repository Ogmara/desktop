/**
 * Direct Message E2E orchestration (P1, protocol §8.2) — **per-sender keys**.
 * Mirrors web `dmCrypto.ts`; desktop uses the built-in wallet to sign and a random
 * stable per-install `device_id`.
 *
 * Each participant has their OWN sending key (`conv_key`), wrapped (ECIES) to every
 * device of both participants via `ChannelKeyEnvelope` (0x61), keyed on the node by
 * author. To decrypt a message from author X, the recipient fetches X's key. This
 * avoids the cross-node shared-key "split-brain" (two epoch-1 keys colliding under
 * first-write-wins). In-memory cache keyed by (conversation, epoch, author).
 */
import {
  computeConversationId,
  randomConvKey,
  wrapConvKey,
  unwrapConvKey,
  buildChannelKeyEnvelope,
  buildEncryptedDirectMessage,
  buildEncryptedDmEdit,
  decryptDmContent,
  encPublicKeyHex,
  KeyScopeKind,
  type WrappedKey,
} from '@ogmara/sdk';
import { decode } from '@msgpack/msgpack';
import { getClient } from './api';
import { getSigner, walletAddress } from './auth';
import { getOrCreateEncKeypair, getOrCreateDeviceId } from './deviceEnc';
import { e2elog, withRetry } from './e2eDebug';

export const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** In-memory key cache: `${conversationIdHex}:${epoch}:${author}` → 32-byte key. */
const convKeys = new Map<string, Uint8Array>();
const cacheKey = (convIdHex: string, epoch: number, author: string) =>
  `${convIdHex}:${epoch}:${author}`;

// --- key-vault integration (P3) --------------------------------------------
// The `keyVault.ts` layer registers into these so DM + channel content keys
// persist to the wallet-encrypted vault and restore on a fresh device. Kept as a
// callback registry (not a direct import) so dmCrypto/channelCrypto never depend
// on the vault module — no import cycle.
let keyringChangeListener: (() => void) | null = null;
let vaultRestoreRequester: (() => void) | null = null;

/** Register a callback fired whenever a content key is cached (the vault layer
 *  debounces it into a backup publish). */
export function setKeyringChangeListener(fn: (() => void) | null): void {
  keyringChangeListener = fn;
}
/** Register the session-once, background vault-restore trigger. */
export function setVaultRestoreRequester(fn: (() => void) | null): void {
  vaultRestoreRequester = fn;
}
/** Notify the vault layer that the keyring changed (called by channelCrypto too). */
export function notifyKeyringChanged(): void {
  keyringChangeListener?.();
}
/** Ask the vault layer to restore persisted keys (session-once, background). Called
 *  from a decrypt-miss so old history (keys wrapped only to a prior device) recovers. */
export function requestVaultRestore(): void {
  vaultRestoreRequester?.();
}
/** Cache a DM conv_key and signal the vault layer to back it up. */
function cacheConvKey(k: string, key: Uint8Array): void {
  convKeys.set(k, key);
  notifyKeyringChanged();
}
/** Snapshot DM conv_keys for the vault (`${convIdHex}:${epoch}:${author}` → key). */
export function exportConvKeysForVault(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of convKeys) out[k] = v;
  return out;
}
/** Merge vault-restored DM conv_keys in; never clobber a key already cached this
 *  session (the in-memory one is at least as fresh). Returns how many were added. */
export function importConvKeysFromVault(rec: Record<string, Uint8Array>): number {
  let added = 0;
  for (const [k, v] of Object.entries(rec)) {
    if (!convKeys.has(k) && v instanceof Uint8Array && v.length === 32) {
      convKeys.set(k, v);
      added++;
    }
  }
  return added;
}

/** Highest cached epoch of `author`'s key for a conversation, or null. */
function cachedLatest(convIdHex: string, author: string): { key: Uint8Array; epoch: number } | null {
  const suffix = `:${author}`;
  let best: { key: Uint8Array; epoch: number } | null = null;
  for (const [k, v] of convKeys) {
    if (k.startsWith(`${convIdHex}:`) && k.endsWith(suffix)) {
      const epoch = Number(k.slice(convIdHex.length + 1, k.length - suffix.length));
      if (!best || epoch > best.epoch) best = { key: v, epoch };
    }
  }
  return best;
}

/** Per-conversation in-flight establishment, so a double-send doesn't fork my key. */
const establishing = new Map<string, Promise<{ key: Uint8Array; epoch: number }>>();

/** Clear cached keys (e.g. on logout / wallet switch). Zeroes the key buffers first
 *  (best-effort hygiene — JS can't guarantee it, but it drops the obvious copies). */
export function clearDmKeyCache(): void {
  for (const v of convKeys.values()) v.fill(0);
  convKeys.clear();
  establishing.clear();
  wrappedToDevices.clear();
  lastCoverMs.clear();
}

export interface DeviceCtx {
  signer: ReturnType<typeof getSigner>;
  encPriv: Uint8Array;
  deviceId: string;
  wallet: string;
}

export async function deviceCtx(): Promise<DeviceCtx | null> {
  const signer = getSigner();
  const wallet = walletAddress();
  if (!signer || !wallet) return null;
  const kp = await getOrCreateEncKeypair();
  return { signer, encPriv: kp.privateKey, deviceId: getOrCreateDeviceId(), wallet };
}

/**
 * Establish MY sending key: generate a random `conv_key`, wrap it to every device
 * of both participants, publish one `ChannelKeyEnvelope` (0x61) per device (authored
 * by me). `peer` is always the recipient. Caches + returns my key.
 */
export interface Target { target: string; deviceId: string; encPub: string; createdAt: number }

/** Which `(target, deviceId)` we've already wrapped MY key to, per `${convIdHex}:${epoch}`. */
const wrappedToDevices = new Map<string, Set<string>>();
const wrappedSetKey = (convIdHex: string, epoch: number) => `${convIdHex}:${epoch}`;
export const targetKey = (t: Target) => `${t.target}:${(t.deviceId ?? '').toLowerCase()}`;

/** Current device set of both participants, deduped to the newest enc_pub per
 *  `(target, device_id)` (the node keys channel_keys by device_id, FWW). */
async function getConvTargets(ctx: DeviceCtx, recipient: string): Promise<Target[]> {
  const client = getClient();
  // Let a genuine fetch FAILURE propagate (don't swallow to empty): an empty key
  // set drives the "recipient hasn't enabled encryption" gate, so a server/network
  // error must NOT be mistaken for a genuinely keyless recipient. A real keyless
  // recipient returns a 200 with `keys: []`, which resolves normally. withRetry
  // absorbs transient 429s first; callers that can tolerate failure (coverDevices)
  // already wrap this in try/catch.
  const fetchKeys = (addr: string) =>
    withRetry(() => client.getEncKeys(addr), 'fetch enc keys');
  const [recipKeys, myKeys] = await Promise.all([
    fetchKeys(recipient),
    fetchKeys(ctx.wallet),
  ]);
  const raw: Target[] = [
    ...recipKeys.keys.map((k) => ({ target: recipient, deviceId: k.device_id, encPub: k.enc_pub, createdAt: k.created_at ?? 0 })),
    ...myKeys.keys.map((k) => ({ target: ctx.wallet, deviceId: k.device_id, encPub: k.enc_pub, createdAt: k.created_at ?? 0 })),
  ];
  const byDevice = new Map<string, Target>();
  for (const t of raw) {
    const prev = byDevice.get(targetKey(t));
    if (!prev || t.createdAt > prev.createdAt) byDevice.set(targetKey(t), t);
  }
  return [...byDevice.values()];
}

/** Wrap MY `convKey` to each `target` and publish (0x61). Records coverage. 429-resilient. */
async function wrapMyKeyToTargets(
  ctx: DeviceCtx, conversationId: Uint8Array, convIdHex: string,
  recipient: string, convKey: Uint8Array, epoch: number, targets: Target[],
): Promise<void> {
  const client = getClient();
  const covered = wrappedToDevices.get(wrappedSetKey(convIdHex, epoch)) ?? new Set<string>();
  for (const tg of targets) {
    const wrapped: WrappedKey = wrapConvKey(convKey, fromHex(tg.encPub), conversationId);
    const envelope = await buildChannelKeyEnvelope(ctx.signer!, {
      keyScope: conversationId, scopeKind: KeyScopeKind.DM, epoch,
      target: tg.target, deviceId: tg.deviceId, peer: recipient, wrapped,
    });
    await withRetry(() => client.publishKeyEnvelope(envelope), 'publish key envelope');
    covered.add(targetKey(tg));
  }
  wrappedToDevices.set(wrappedSetKey(convIdHex, epoch), covered);
}

const bytesEq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Establish MY sending key at `epoch`. CRITICAL FWW read-back: the node keys
 * envelopes by `(author, target-device, epoch)` first-write-wins and returns 200
 * even when a write is silently dropped. So after publishing we re-fetch our own
 * key and ADOPT whatever the node serves — guaranteeing we encrypt with the key
 * recipients will fetch (a fresh epoch has no prior envelopes, so ours wins all).
 */
async function establishMyKey(
  ctx: DeviceCtx,
  conversationId: Uint8Array,
  convIdHex: string,
  recipient: string,
  epoch = 1,
): Promise<{ key: Uint8Array; epoch: number }> {
  const targets = await getConvTargets(ctx, recipient);
  e2elog('establish: targets', {
    convIdHex, recipient, epoch,
    targets: targets.map((t) => `${t.target.slice(0, 10)}…/${t.deviceId.slice(0, 8)}`),
  });
  if (targets.length === 0) {
    throw new Error('no device encryption keys found for either participant');
  }
  // The recipient must have at least one registered enc key, or the message would
  // be wrapped only to my own devices and they could never decrypt it. Surface a
  // distinguishable error so the UI can tell the user instead of silently waiting.
  if (!targets.some((t) => t.target === recipient)) {
    throw new Error('RECIPIENT_NO_ENC_KEYS');
  }
  const convKey = randomConvKey();
  await wrapMyKeyToTargets(ctx, conversationId, convIdHex, recipient, convKey, epoch, targets);
  cacheConvKey(cacheKey(convIdHex, epoch, ctx.wallet), convKey);
  const confirmed = await fetchConvKey(ctx, conversationId, convIdHex, ctx.wallet, epoch);
  if (typeof confirmed !== 'string' && !bytesEq(confirmed.key, convKey)) {
    e2elog('establish: adopted node FWW key (local lost the race)', { convIdHex, epoch });
    return { key: confirmed.key, epoch };
  }
  e2elog('establish: published', { convIdHex, epoch, deviceCount: targets.length });
  return { key: convKey, epoch };
}

/** Highest epoch the node has for `author`'s key in this conversation (0 = none). */
async function latestEpochFor(
  ctx: DeviceCtx, conversationId: Uint8Array, convIdHex: string, author: string,
): Promise<number> {
  const r = await fetchConvKey(ctx, conversationId, convIdHex, author);
  return typeof r === 'string' ? 0 : r.epoch;
}

/**
 * Re-key the conversation with a clean epoch bump (max(myLatest,peerLatest)+1).
 * A fresh epoch has no prior envelopes, so one establish wins FWW on EVERY device
 * → one consistent key (escapes a corrupted epoch). BOTH participants must re-key.
 */
export async function reKeyConversation(
  recipient: string,
): Promise<{ epoch: number } | null> {
  const ctx = await deviceCtx();
  if (!ctx) return null;
  const conversationId = computeConversationId(ctx.wallet, recipient);
  const convIdHex = toHex(conversationId);
  const [mine, theirs] = await Promise.all([
    latestEpochFor(ctx, conversationId, convIdHex, ctx.wallet),
    latestEpochFor(ctx, conversationId, convIdHex, recipient),
  ]);
  const epoch = Math.max(mine, theirs, 0) + 1;
  lastCoverMs.delete(wrappedSetKey(convIdHex, epoch));
  const res = await establishMyKey(ctx, conversationId, convIdHex, recipient, epoch);
  e2elog('reKey: bumped epoch', { convIdHex, from: Math.max(mine, theirs, 0), to: res.epoch });
  return { epoch: res.epoch };
}

/** Last reconcile time per `${convIdHex}:${epoch}` — throttles the getEncKeys
 *  round-trip so coverDevices can run on send AND on each incoming DM. */
const lastCoverMs = new Map<string, number>();
const COVER_THROTTLE_MS = 10_000;

/** Cover late/newly-registered devices: wrap MY existing `convKey` to any current
 *  device we haven't wrapped to yet this epoch. Closes the "device joined after
 *  establishment → waits forever" gap. Re-runnable (throttled ~10 s); FWW + the
 *  wrappedToDevices set make re-wraps to covered devices no-ops. */
async function coverDevices(
  ctx: DeviceCtx, conversationId: Uint8Array, convIdHex: string,
  recipient: string, convKey: Uint8Array, epoch: number,
): Promise<void> {
  const k = wrappedSetKey(convIdHex, epoch);
  const now = Date.now();
  if (now - (lastCoverMs.get(k) ?? 0) < COVER_THROTTLE_MS) return;
  lastCoverMs.set(k, now);
  try {
    const targets = await getConvTargets(ctx, recipient);
    const done = wrappedToDevices.get(k) ?? new Set<string>();
    const missing = targets.filter((t) => !done.has(targetKey(t)));
    if (missing.length > 0) {
      await wrapMyKeyToTargets(ctx, conversationId, convIdHex, recipient, convKey, epoch, missing);
      e2elog('covered late devices', { convIdHex, epoch, count: missing.length });
    }
  } catch (e) {
    lastCoverMs.set(k, 0); // failed — allow an immediate retry on the next trigger
    e2elog('coverDevices skipped', { err: (e as Error)?.message });
  }
}

/**
 * Ensure MY conv_key is wrapped to all of `recipient`'s CURRENT devices — call on an
 * incoming DM so a peer device that joined after my key was established gets my key
 * without an app reload. No-op if I have no key for this conversation yet.
 */
export async function coverPeerDevices(recipient: string): Promise<void> {
  const ctx = await deviceCtx();
  if (!ctx) return;
  const conversationId = computeConversationId(ctx.wallet, recipient);
  const convIdHex = toHex(conversationId);
  let entry = cachedLatest(convIdHex, ctx.wallet);
  if (!entry) {
    const fetched = await fetchConvKey(ctx, conversationId, convIdHex, ctx.wallet);
    if (typeof fetched !== 'string') entry = fetched;
  }
  if (entry) await coverDevices(ctx, conversationId, convIdHex, recipient, entry.key, entry.epoch);
}

/** `missing` = not delivered yet (retry); `corrupt` = present but unwrap failed (error). */
type FetchResult = { key: Uint8Array; epoch: number } | 'missing' | 'corrupt';

/** Fetch + unwrap author `author`'s `conv_key` for a scope/epoch, addressed to my device. */
async function fetchConvKey(
  ctx: DeviceCtx,
  conversationId: Uint8Array,
  convIdHex: string,
  author: string,
  epoch?: number,
): Promise<FetchResult> {
  let resp;
  try {
    resp = await withRetry(() => getClient().getKeyEnvelope(convIdHex, ctx.deviceId, author, epoch), 'fetch key envelope');
  } catch (e) {
    e2elog('fetchConvKey: network error → missing', { author, epoch, deviceId: ctx.deviceId, err: (e as Error)?.message });
    return 'missing';
  }
  if (!resp.envelope) {
    e2elog('fetchConvKey: no envelope → waiting', { author, epoch, deviceId: ctx.deviceId });
    return 'missing';
  }
  try {
    const env = resp.envelope;
    const wrapped: WrappedKey = {
      ephPub: fromHex(env.eph_pub),
      nonce: fromHex(env.nonce),
      wrapped: fromHex(env.wrapped),
    };
    const key = unwrapConvKey(wrapped, ctx.encPriv, conversationId);
    const ep = resp.epoch ?? env.epoch;
    cacheConvKey(cacheKey(convIdHex, ep, author), key);
    e2elog('fetchConvKey: unwrapped OK', { author, epoch: ep, deviceId: ctx.deviceId });
    return { key, epoch: ep };
  } catch (e) {
    // Envelope present but unwrap failed = wrap targeted a different enc_pub than
    // our local enc-priv (binding divergence) → "can't decrypt".
    e2elog('fetchConvKey: unwrap FAILED → corrupt', { author, epoch, deviceId: ctx.deviceId, err: (e as Error)?.message });
    return 'corrupt';
  }
}

/** Ensure MY sending key for `recipient` (establishing it if first message). */
export async function ensureConvKeyForSend(
  recipient: string,
): Promise<{ convKey: Uint8Array; epoch: number; conversationId: Uint8Array } | null> {
  const ctx = await deviceCtx();
  if (!ctx) return null;
  const conversationId = computeConversationId(ctx.wallet, recipient);
  const convIdHex = toHex(conversationId);

  const cached = cachedLatest(convIdHex, ctx.wallet);
  if (cached) {
    void coverDevices(ctx, conversationId, convIdHex, recipient, cached.key, cached.epoch);
    return { convKey: cached.key, epoch: cached.epoch, conversationId };
  }

  const fetched = await fetchConvKey(ctx, conversationId, convIdHex, ctx.wallet);
  if (typeof fetched !== 'string') {
    void coverDevices(ctx, conversationId, convIdHex, recipient, fetched.key, fetched.epoch);
    return { convKey: fetched.key, epoch: fetched.epoch, conversationId };
  }

  // Establish at a FRESH epoch above anything either side has — never re-establish
  // an existing epoch (re-collides with a polluted epoch; read-back adopts a stale key).
  let inflight = establishing.get(convIdHex);
  if (!inflight) {
    inflight = (async () => {
      const [mine, theirs] = await Promise.all([
        latestEpochFor(ctx, conversationId, convIdHex, ctx.wallet),
        latestEpochFor(ctx, conversationId, convIdHex, recipient),
      ]);
      const epoch = Math.max(mine, theirs, 0) + 1;
      return establishMyKey(ctx, conversationId, convIdHex, recipient, epoch);
    })().finally(() => establishing.delete(convIdHex));
    establishing.set(convIdHex, inflight);
  }
  const res = await inflight;
  return { convKey: res.key, epoch: res.epoch, conversationId };
}

/** Build a signed, encrypted DirectMessage envelope for `recipient`. */
export async function buildEncryptedDm(
  recipient: string,
  text: string,
  replyTo?: string,
): Promise<Uint8Array> {
  const established = await ensureConvKeyForSend(recipient);
  if (!established) throw new Error('device not ready for encrypted DMs');
  const signer = getSigner();
  if (!signer) throw new Error('no signer');
  return buildEncryptedDirectMessage(signer, {
    recipient,
    convKey: established.convKey,
    epoch: established.epoch,
    text,
    replyTo,
  });
}

/**
 * Build a signed, encrypted `DirectMessageEdit` envelope. The new content is
 * sealed under the conversation's current `conv_key` (same path as a fresh DM),
 * so the node never sees the edited plaintext.
 */
export async function buildEncryptedDmEditEnvelope(
  recipient: string,
  msgId: string,
  text: string,
): Promise<Uint8Array> {
  const established = await ensureConvKeyForSend(recipient);
  if (!established) throw new Error('device not ready for encrypted DMs');
  const signer = getSigner();
  if (!signer) throw new Error('no signer');
  return buildEncryptedDmEdit(signer, {
    recipient,
    msgId,
    convKey: established.convKey,
    epoch: established.epoch,
    content: text,
  });
}

interface RawDmPayload {
  conversation_id?: Uint8Array;
  content?: Uint8Array | string;
  nonce?: Uint8Array;
  key_epoch?: number;
}

export function toBytes(payload: number[] | Uint8Array | string): Uint8Array | null {
  if (typeof payload === 'string') {
    try {
      const bin = atob(payload);
      const b = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
      return b;
    } catch {
      return null;
    }
  }
  return payload instanceof Uint8Array ? payload : new Uint8Array(payload);
}

/** Display outcome for a DM message. */
export type DmDisplay =
  | { kind: 'text'; text: string }
  | { kind: 'plain'; text: string }
  | { kind: 'waiting' }
  | { kind: 'error' };

/** Decrypt a DM message for rendering. `author` is the message sender — we fetch
 * THAT author's key. Plaintext (optimistic local / legacy key_epoch 0) passes through. */
export async function decryptDmMessage(
  payload: number[] | Uint8Array | string,
  author?: string,
): Promise<DmDisplay> {
  const bytes = toBytes(payload);
  if (!bytes) {
    e2elog('decode: toBytes failed', { payloadType: Array.isArray(payload) ? 'array' : typeof payload });
    return { kind: 'error' };
  }
  let decoded: RawDmPayload;
  try {
    decoded = decode(bytes) as RawDmPayload;
  } catch (e) {
    e2elog('decode: msgpack failed', { byteLen: bytes.length, err: (e as Error)?.message });
    return { kind: 'error' };
  }
  if (typeof decoded.content === 'string') return { kind: 'plain', text: decoded.content };

  // An EDITED DM's payload is re-encoded server-side with rmp_serde, which emits
  // `Vec<u8>` / `[u8;N]` as msgpack ARRAYS (not `bin`), so @msgpack/msgpack yields
  // `number[]` here — not `Uint8Array`. A fresh DM arrives as `bin` → `Uint8Array`.
  // Coerce so an edited DM decrypts exactly like a never-edited one.
  const asBytes = (v: unknown): Uint8Array | null =>
    v instanceof Uint8Array ? v : Array.isArray(v) ? Uint8Array.from(v as number[]) : null;
  const contentBytes = asBytes(decoded.content);

  if ((decoded.key_epoch ?? 0) === 0) {
    if (contentBytes) {
      try {
        return { kind: 'plain', text: new TextDecoder().decode(contentBytes) };
      } catch {
        return { kind: 'error' };
      }
    }
    e2elog('decode: legacy epoch0 but content not bytes', { contentType: typeof decoded.content });
    return { kind: 'error' };
  }
  const nonceBytes = asBytes(decoded.nonce);
  if (!contentBytes || !nonceBytes) {
    e2elog('decode: content/nonce not bytes', {
      keyEpoch: decoded.key_epoch ?? null,
      contentType: contentBytes ? 'bytes' : typeof decoded.content,
      nonceType: nonceBytes ? 'bytes' : typeof decoded.nonce,
    });
    return { kind: 'error' };
  }
  const conversationId = asBytes(decoded.conversation_id);
  if (!conversationId) {
    e2elog('decode: conversation_id not bytes', { convIdType: typeof decoded.conversation_id });
    return { kind: 'error' };
  }
  const epoch = decoded.key_epoch ?? 1;
  const convIdHex = toHex(conversationId);

  const ctx = await deviceCtx();
  if (!ctx) return { kind: 'waiting' };
  const keyAuthor = author ?? ctx.wallet;

  let key = convKeys.get(cacheKey(convIdHex, epoch, keyAuthor));
  if (!key) {
    const fetched = await fetchConvKey(ctx, conversationId, convIdHex, keyAuthor, epoch);
    if (fetched === 'missing') {
      // The node has no envelope for my device at this epoch (e.g. history wrapped
      // only to a prior device). Pull the wallet-encrypted vault in the background;
      // the next decrypt retry finds the restored key.
      requestVaultRestore();
      return { kind: 'waiting' };
    }
    if (fetched === 'corrupt') return { kind: 'error' };
    key = fetched.key;
  }
  try {
    const pt = decryptDmContent(key, conversationId, epoch, contentBytes, nonceBytes);
    return { kind: 'text', text: pt.text };
  } catch (e) {
    e2elog('decrypt: AEAD failed', { author: keyAuthor, epoch, err: (e as Error)?.message });
    return { kind: 'error' };
  }
}

/**
 * One-shot E2E self-check for support/debugging. Run in the devtools console:
 *   await window.__ogmaraE2E()                  // my binding only
 *   await window.__ogmaraE2E('klv1…peer')       // + this conversation
 * Reads/derives public material only — no secrets are printed.
 */
export async function e2eSelfCheck(peer?: string): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  const ctx = await deviceCtx();
  if (!ctx) {
    report.error = 'device not ready (no signer/wallet) — not logged in?';
    // eslint-disable-next-line no-console
    console.warn('[e2e] self-check:', report);
    return report;
  }
  const localEncPub = encPublicKeyHex(ctx.encPriv);
  report.wallet = ctx.wallet;
  report.deviceId = ctx.deviceId;
  report.localEncPub = localEncPub;

  try {
    const { keys } = await getClient().getEncKeys(ctx.wallet);
    const mine = keys.find((k) => (k.device_id ?? '').toLowerCase() === ctx.deviceId.toLowerCase());
    report.registryEntries = keys.map((k) => ({
      device_id: k.device_id, enc_pub: k.enc_pub,
      thisDevice: (k.device_id ?? '').toLowerCase() === ctx.deviceId.toLowerCase(),
    }));
    report.bindingVerdict = !mine
      ? '❌ MY device_id is NOT in the registry — binding never landed (peers can\'t wrap to me)'
      : (mine.enc_pub ?? '').toLowerCase() === localEncPub.toLowerCase()
        ? '✓ binding OK (registry enc_pub matches local)'
        : `❌ DIVERGENCE: registry enc_pub=${mine.enc_pub} ≠ local=${localEncPub} → "can't decrypt"; re-login to self-heal`;
  } catch (e) {
    report.bindingVerdict = `⚠️ couldn't read registry: ${(e as Error)?.message}`;
  }

  if (peer) {
    const conversationId = computeConversationId(ctx.wallet, peer);
    const convIdHex = toHex(conversationId);
    report.peer = peer;
    report.conversationId = convIdHex;
    try {
      const { keys } = await getClient().getEncKeys(peer);
      report.peerDevices = keys.map((k) => `${k.device_id}/${k.enc_pub}`);
    } catch (e) {
      report.peerDevices = `⚠️ ${(e as Error)?.message}`;
    }
    const mineFetch = await fetchConvKey(ctx, conversationId, convIdHex, ctx.wallet);
    const peerFetch = await fetchConvKey(ctx, conversationId, convIdHex, peer);
    const verdict = (r: typeof mineFetch) =>
      r === 'missing' ? '❌ MISSING (no envelope for my device → "waiting for key")'
        : r === 'corrupt' ? '❌ CORRUPT (envelope found but unwrap failed → "can\'t decrypt")'
          : `✓ OK (epoch ${r.epoch})`;
    report.myKey = verdict(mineFetch);
    report.peerKey = verdict(peerFetch);

    // Probe the ACTUAL stored messages: payload shape + decode + decrypt outcome.
    // Catches failures BEFORE any key fetch (msgpack/shape) — which is why
    // "can't decrypt" can appear with no [e2e] crypto logs.
    try {
      const resp = await getClient().getDmMessages(peer);
      const msgs = ((resp as { messages?: unknown[] }).messages || []).slice(-3);
      report.recentMessages = [];
      for (const m of msgs as Array<{ payload: unknown; author?: string }>) {
        const entry: Record<string, unknown> = {
          author: m.author,
          payloadType: Array.isArray(m.payload) ? 'array' : typeof m.payload,
        };
        const bytes = toBytes(m.payload as never);
        if (!bytes) {
          entry.decode = '❌ toBytes failed';
        } else {
          entry.byteLen = bytes.length;
          try {
            const d = decode(bytes) as RawDmPayload;
            entry.keyEpoch = d.key_epoch ?? null;
            entry.contentType = d.content instanceof Uint8Array ? 'bytes' : typeof d.content;
            entry.hasNonce = d.nonce instanceof Uint8Array;
            entry.hasConvId = d.conversation_id instanceof Uint8Array;
          } catch (e) {
            entry.decode = `❌ decode error: ${(e as Error)?.message}`;
          }
        }
        entry.decryptResult = (await decryptDmMessage(m.payload as never, m.author)).kind;
        (report.recentMessages as unknown[]).push(entry);
      }
    } catch (e) {
      report.recentMessages = `⚠️ ${(e as Error)?.message}`;
    }
  }

  // eslint-disable-next-line no-console
  console.info('[e2e] self-check', report);
  return report;
}

if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __ogmaraE2E?: typeof e2eSelfCheck;
    __ogmaraE2EReKey?: typeof reKeyConversation;
  };
  w.__ogmaraE2E = e2eSelfCheck;
  w.__ogmaraE2EReKey = reKeyConversation; // __ogmaraE2EReKey('<peer>') — clean epoch bump
}
