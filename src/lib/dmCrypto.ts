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

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** In-memory key cache: `${conversationIdHex}:${epoch}:${author}` → 32-byte key. */
const convKeys = new Map<string, Uint8Array>();
const cacheKey = (convIdHex: string, epoch: number, author: string) =>
  `${convIdHex}:${epoch}:${author}`;

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

/** Clear cached keys (e.g. on logout / wallet switch). */
export function clearDmKeyCache(): void {
  convKeys.clear();
  establishing.clear();
  wrappedToDevices.clear();
  coveredThisSession.clear();
}

interface DeviceCtx {
  signer: ReturnType<typeof getSigner>;
  encPriv: Uint8Array;
  deviceId: string;
  wallet: string;
}

async function deviceCtx(): Promise<DeviceCtx | null> {
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
interface Target { target: string; deviceId: string; encPub: string; createdAt: number }

/** Which `(target, deviceId)` we've already wrapped MY key to, per `${convIdHex}:${epoch}`. */
const wrappedToDevices = new Map<string, Set<string>>();
const wrappedSetKey = (convIdHex: string, epoch: number) => `${convIdHex}:${epoch}`;
const targetKey = (t: Target) => `${t.target}:${(t.deviceId ?? '').toLowerCase()}`;

/** Current device set of both participants, deduped to the newest enc_pub per
 *  `(target, device_id)` (the node keys channel_keys by device_id, FWW). */
async function getConvTargets(ctx: DeviceCtx, recipient: string): Promise<Target[]> {
  const client = getClient();
  const empty = () => ({ keys: [] as { device_id: string; enc_pub: string; created_at: number }[] });
  const [recipKeys, myKeys] = await Promise.all([
    client.getEncKeys(recipient).catch(empty),
    client.getEncKeys(ctx.wallet).catch(empty),
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

async function establishMyKey(
  ctx: DeviceCtx,
  conversationId: Uint8Array,
  convIdHex: string,
  recipient: string,
): Promise<{ key: Uint8Array; epoch: number }> {
  const targets = await getConvTargets(ctx, recipient);
  e2elog('establish: targets', {
    convIdHex, recipient,
    targets: targets.map((t) => `${t.target.slice(0, 10)}…/${t.deviceId.slice(0, 8)}`),
  });
  if (targets.length === 0) {
    throw new Error('no device encryption keys found for either participant');
  }
  const convKey = randomConvKey();
  const epoch = 1;
  await wrapMyKeyToTargets(ctx, conversationId, convIdHex, recipient, convKey, epoch, targets);
  convKeys.set(cacheKey(convIdHex, epoch, ctx.wallet), convKey);
  e2elog('establish: published', { convIdHex, epoch, deviceCount: targets.length });
  return { key: convKey, epoch };
}

/** Conversations whose current device set we've reconciled this session. */
const coveredThisSession = new Set<string>();

/** Cover late/newly-registered devices: wrap MY existing `convKey` to any current
 *  device we haven't wrapped to yet this epoch. Closes the "device joined after
 *  establishment → waits forever" gap. Once per conversation+epoch per session. */
async function coverDevices(
  ctx: DeviceCtx, conversationId: Uint8Array, convIdHex: string,
  recipient: string, convKey: Uint8Array, epoch: number,
): Promise<void> {
  const sessKey = wrappedSetKey(convIdHex, epoch);
  if (coveredThisSession.has(sessKey)) return;
  coveredThisSession.add(sessKey);
  try {
    const targets = await getConvTargets(ctx, recipient);
    const done = wrappedToDevices.get(sessKey) ?? new Set<string>();
    const missing = targets.filter((t) => !done.has(targetKey(t)));
    if (missing.length > 0) {
      await wrapMyKeyToTargets(ctx, conversationId, convIdHex, recipient, convKey, epoch, missing);
      e2elog('covered late devices', { convIdHex, epoch, count: missing.length });
    }
  } catch (e) {
    coveredThisSession.delete(sessKey);
    e2elog('coverDevices skipped', { err: (e as Error)?.message });
  }
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
    convKeys.set(cacheKey(convIdHex, ep, author), key);
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

  let inflight = establishing.get(convIdHex);
  if (!inflight) {
    inflight = establishMyKey(ctx, conversationId, convIdHex, recipient).finally(() =>
      establishing.delete(convIdHex),
    );
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

interface RawDmPayload {
  conversation_id?: Uint8Array;
  content?: Uint8Array | string;
  nonce?: Uint8Array;
  key_epoch?: number;
}

function toBytes(payload: number[] | Uint8Array | string): Uint8Array | null {
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
  if (!bytes) return { kind: 'error' };
  let decoded: RawDmPayload;
  try {
    decoded = decode(bytes) as RawDmPayload;
  } catch {
    return { kind: 'error' };
  }
  if (typeof decoded.content === 'string') return { kind: 'plain', text: decoded.content };
  if ((decoded.key_epoch ?? 0) === 0) {
    if (decoded.content instanceof Uint8Array) {
      try {
        return { kind: 'plain', text: new TextDecoder().decode(decoded.content) };
      } catch {
        return { kind: 'error' };
      }
    }
    return { kind: 'error' };
  }
  if (!(decoded.content instanceof Uint8Array) || !(decoded.nonce instanceof Uint8Array)) {
    return { kind: 'error' };
  }
  const conversationId = decoded.conversation_id;
  if (!(conversationId instanceof Uint8Array)) return { kind: 'error' };
  const epoch = decoded.key_epoch ?? 1;
  const convIdHex = toHex(conversationId);

  const ctx = await deviceCtx();
  if (!ctx) return { kind: 'waiting' };
  const keyAuthor = author ?? ctx.wallet;

  let key = convKeys.get(cacheKey(convIdHex, epoch, keyAuthor));
  if (!key) {
    const fetched = await fetchConvKey(ctx, conversationId, convIdHex, keyAuthor, epoch);
    if (fetched === 'missing') return { kind: 'waiting' };
    if (fetched === 'corrupt') return { kind: 'error' };
    key = fetched.key;
  }
  try {
    const pt = decryptDmContent(key, conversationId, epoch, decoded.content, decoded.nonce);
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
  }

  // eslint-disable-next-line no-console
  console.info('[e2e] self-check', report);
  return report;
}

if (typeof window !== 'undefined') {
  (window as unknown as { __ogmaraE2E?: typeof e2eSelfCheck }).__ogmaraE2E = e2eSelfCheck;
}
