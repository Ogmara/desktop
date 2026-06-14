/**
 * Encrypted PRIVATE channels (P2 OECK). A private channel has a single random
 * 32-byte `channel_key` per epoch, delivered to every member device via
 * `ChannelKeyEnvelope` (0x61, channel scope) and used to XChaCha20-Poly1305-encrypt
 * each message's TEXT (mentions/reply_to/content_rating stay plaintext, spec §3.3).
 *
 * Mirrors `dmCrypto.ts` but the key is a GROUP key (shared by all members, fetched
 * author-agnostically) instead of a per-sender DM key. Only the creator/mods
 * ESTABLISH an epoch; regular members fetch + decrypt + cover new joiners.
 */
import {
  computeChannelScope,
  wrapConvKey,
  unwrapConvKey,
  randomConvKey,
  decryptDmContent,
  buildChannelKeyEnvelope,
  buildEncryptedChannelMessage,
  KeyScopeKind,
  type WrappedKey,
} from '@ogmara/sdk';
import { decode } from '@msgpack/msgpack';
import { getClient } from './api';
import { getSigner } from './auth';
import { e2elog, withRetry } from './e2eDebug';
import {
  deviceCtx, toHex, fromHex, targetKey, toBytes,
  type DeviceCtx, type Target, type DmDisplay,
} from './dmCrypto';

/** Channel group-key cache: `${channelScopeHex}:${epoch}` → 32-byte key. */
const channelKeys = new Map<string, Uint8Array>();
const ckey = (scopeHex: string, epoch: number) => `${scopeHex}:${epoch}`;

/** Highest cached epoch for a channel scope, or null. */
function cachedLatest(scopeHex: string): { key: Uint8Array; epoch: number } | null {
  let best: { key: Uint8Array; epoch: number } | null = null;
  for (const [k, v] of channelKeys) {
    if (k.startsWith(`${scopeHex}:`)) {
      const epoch = Number(k.slice(scopeHex.length + 1));
      if (!best || epoch > best.epoch) best = { key: v, epoch };
    }
  }
  return best;
}

/** Per-channel in-flight establishment, so a double-send doesn't fork the key. */
const establishing = new Map<number, Promise<{ key: Uint8Array; epoch: number }>>();
/** Which `(target, device)` we've wrapped the key to, per `${scopeHex}:${epoch}`. */
const wrappedToDevices = new Map<string, Set<string>>();
const lastCoverMs = new Map<number, number>();
const COVER_THROTTLE_MS = 10_000;

export function clearChannelKeyCache(): void {
  channelKeys.clear();
  establishing.clear();
  wrappedToDevices.clear();
  lastCoverMs.clear();
}

const asBytes = (v: unknown): Uint8Array | null =>
  v instanceof Uint8Array ? v : Array.isArray(v) ? Uint8Array.from(v as number[]) : null;

/**
 * Fetch every member's device enc keys and dedup to one wrap per `(member, device)`
 * keeping the newest enc_pub. Private channels are small groups (single page).
 */
async function getChannelTargets(channelId: number): Promise<Target[]> {
  const client = getClient();
  // Page through the full member set — a member we miss never gets the key and
  // permanently sees "can't decrypt", so we must not silently truncate at one page.
  const PAGE = 200;
  const members: { address: string }[] = [];
  for (let page = 1; page <= 50; page++) {
    const resp = await withRetry(
      () => client.getChannelMembers(channelId, { page, limit: PAGE }),
      'fetch channel members',
    );
    members.push(...resp.members);
    if (resp.members.length < PAGE) break;
    if (page === 50) e2elog('channel targets: member pagination cap hit (>10k)', { channelId });
  }
  const raw: Target[] = [];
  for (const m of members) {
    let keys: { device_id: string; enc_pub: string; created_at?: number }[] = [];
    try {
      keys = (await withRetry(() => client.getEncKeys(m.address), 'fetch enc keys')).keys;
    } catch {
      // A member whose enc keys we can't fetch right now is covered on the next pass.
      continue;
    }
    for (const k of keys) {
      raw.push({ target: m.address, deviceId: k.device_id, encPub: k.enc_pub, createdAt: k.created_at ?? 0 });
    }
  }
  const byDevice = new Map<string, Target>();
  for (const t of raw) {
    const prev = byDevice.get(targetKey(t));
    if (!prev || t.createdAt > prev.createdAt) byDevice.set(targetKey(t), t);
  }
  return [...byDevice.values()];
}

/** Fetch + unwrap MY wrapped channel key for `epoch` (latest if omitted). Author is
 *  the canonical empty string — channel keys are a group key, stored author-agnostic. */
type FetchResult = { key: Uint8Array; epoch: number } | 'missing' | 'corrupt';
async function fetchChannelKey(
  ctx: DeviceCtx, channelId: number, scope: Uint8Array, scopeHex: string, epoch?: number,
): Promise<FetchResult> {
  let resp;
  try {
    resp = await withRetry(() => getClient().getKeyEnvelope(scopeHex, ctx.deviceId, '', epoch), 'fetch channel key');
  } catch (e) {
    e2elog('channel fetchKey: network → missing', { channelId, epoch, err: (e as Error)?.message });
    return 'missing';
  }
  if (!resp.envelope) return 'missing';
  try {
    const env = resp.envelope;
    const wrapped: WrappedKey = { ephPub: fromHex(env.eph_pub), nonce: fromHex(env.nonce), wrapped: fromHex(env.wrapped) };
    const key = unwrapConvKey(wrapped, ctx.encPriv, scope); // salt = channel scope (matches wrap)
    const ep = resp.epoch ?? env.epoch;
    channelKeys.set(ckey(scopeHex, ep), key);
    return { key, epoch: ep };
  } catch (e) {
    e2elog('channel fetchKey: unwrap FAILED → corrupt', { channelId, epoch, err: (e as Error)?.message });
    return 'corrupt';
  }
}

/** Wrap `key` to each target's device and publish one envelope per device. */
async function wrapKeyToMembers(
  ctx: DeviceCtx, channelId: number, scope: Uint8Array, scopeHex: string,
  key: Uint8Array, epoch: number, targets: Target[],
): Promise<void> {
  const client = getClient();
  const covered = wrappedToDevices.get(ckey(scopeHex, epoch)) ?? new Set<string>();
  for (const tg of targets) {
    const wrapped: WrappedKey = wrapConvKey(key, fromHex(tg.encPub), scope);
    const envelope = await buildChannelKeyEnvelope(ctx.signer!, {
      keyScope: scope, scopeKind: KeyScopeKind.Channel, epoch,
      target: tg.target, deviceId: tg.deviceId, channelId, wrapped,
    });
    await withRetry(() => client.publishKeyEnvelope(envelope), 'publish channel key');
    covered.add(targetKey(tg));
  }
  wrappedToDevices.set(ckey(scopeHex, epoch), covered);
}

const bytesEq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Establish epoch `epoch`: random key, wrap to all member devices, read-back-adopt
 *  the node's first-write-wins winner so everyone converges on one key. */
async function establishChannelKey(
  ctx: DeviceCtx, channelId: number, scope: Uint8Array, scopeHex: string, epoch: number,
): Promise<{ key: Uint8Array; epoch: number }> {
  const targets = await getChannelTargets(channelId);
  const key = randomConvKey();
  await wrapKeyToMembers(ctx, channelId, scope, scopeHex, key, epoch, targets);
  channelKeys.set(ckey(scopeHex, epoch), key);
  // FWW read-back: adopt the node's stored key if ours lost a concurrent establish.
  const confirmed = await fetchChannelKey(ctx, channelId, scope, scopeHex, epoch);
  if (typeof confirmed !== 'string' && !bytesEq(confirmed.key, key)) {
    // We lost the race: devices we wrapped OUR (orphaned) key to must be re-wrapped
    // with the adopted key. Drop the covered-set so coverChannelMembers re-covers
    // them with the winning key instead of skipping them as "already done".
    wrappedToDevices.delete(ckey(scopeHex, epoch));
    e2elog('channel establish: adopted node FWW key, cleared cover set', { channelId, epoch });
    void coverChannelMembers(channelId);
    return { key: confirmed.key, epoch };
  }
  e2elog('channel establish: published', { channelId, epoch, devices: targets.length });
  return { key, epoch };
}

/** Wrap the current channel key to any member device we haven't covered yet
 *  (new joiners). Throttled; FWW makes re-wraps to covered devices no-ops. */
export async function coverChannelMembers(channelId: number): Promise<void> {
  const ctx = await deviceCtx();
  if (!ctx) return;
  const now = Date.now();
  if (now - (lastCoverMs.get(channelId) ?? 0) < COVER_THROTTLE_MS) return;
  lastCoverMs.set(channelId, now);
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);
  let entry = cachedLatest(scopeHex);
  if (!entry) {
    const fetched = await fetchChannelKey(ctx, channelId, scope, scopeHex);
    if (typeof fetched === 'string') return; // I don't have the key myself yet
    entry = fetched;
  }
  try {
    const targets = await getChannelTargets(channelId);
    const done = wrappedToDevices.get(ckey(scopeHex, entry.epoch)) ?? new Set<string>();
    const missing = targets.filter((t) => !done.has(targetKey(t)));
    if (missing.length > 0) {
      await wrapKeyToMembers(ctx, channelId, scope, scopeHex, entry.key, entry.epoch, missing);
      e2elog('channel cover: wrapped to new devices', { channelId, count: missing.length });
    }
  } catch (e) {
    lastCoverMs.set(channelId, 0);
    e2elog('channel cover skipped', { err: (e as Error)?.message });
  }
}

/**
 * Ensure a channel key for sending. Returns the key, or `'waiting'` when none exists
 * yet and this client may not establish (a non-mod member must wait for a mod to
 * seed/cover the key), or `null` if the device isn't ready.
 *
 * @param canEstablish creator/mods only — gates seeding a fresh epoch (client policy
 *   matching the node's group-key model; see l2-node 0.72.0).
 */
export async function ensureChannelKeyForSend(
  channelId: number, canEstablish: boolean,
): Promise<{ convKey: Uint8Array; epoch: number } | 'waiting' | null> {
  const ctx = await deviceCtx();
  if (!ctx) return null;
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);

  const cached = cachedLatest(scopeHex);
  if (cached) {
    void coverChannelMembers(channelId);
    return { convKey: cached.key, epoch: cached.epoch };
  }
  const fetched = await fetchChannelKey(ctx, channelId, scope, scopeHex);
  if (typeof fetched !== 'string') {
    void coverChannelMembers(channelId);
    return { convKey: fetched.key, epoch: fetched.epoch };
  }
  if (!canEstablish) return 'waiting';

  let inflight = establishing.get(channelId);
  if (!inflight) {
    inflight = establishChannelKey(ctx, channelId, scope, scopeHex, 1)
      .finally(() => establishing.delete(channelId));
    establishing.set(channelId, inflight);
  }
  const res = await inflight;
  return { convKey: res.key, epoch: res.epoch };
}

/** Build a signed, encrypted ChatMessage for a private channel. */
export async function buildEncryptedChannelMsg(
  channelId: number, canEstablish: boolean, text: string,
  opts?: { replyTo?: string; mentions?: string[]; contentRating?: 'general' | 'teen' | 'mature' | 'explicit' },
): Promise<Uint8Array | 'waiting'> {
  const established = await ensureChannelKeyForSend(channelId, canEstablish);
  if (established === 'waiting') return 'waiting';
  if (!established) throw new Error('device not ready for encrypted channels');
  const signer = getSigner();
  if (!signer) throw new Error('no signer');
  return buildEncryptedChannelMessage(signer, {
    channelId, convKey: established.convKey, epoch: established.epoch,
    text, replyTo: opts?.replyTo, mentions: opts?.mentions, contentRating: opts?.contentRating,
  });
}

interface RawChannelPayload {
  content?: unknown;
  enc_content?: unknown;
  enc_nonce?: unknown;
  key_epoch?: number;
}

/**
 * Decrypt a channel message for rendering. v1 plaintext (`content` set, no
 * `enc_content`) returns as-is; v2 fetches the channel key for the message's epoch.
 */
export async function decryptChannelMessage(
  payload: number[] | Uint8Array | string, channelId: number,
): Promise<DmDisplay> {
  const bytes = toBytes(payload);
  if (!bytes) return { kind: 'error' };
  let decoded: RawChannelPayload;
  try {
    decoded = decode(bytes) as RawChannelPayload;
  } catch {
    return { kind: 'error' };
  }
  const enc = asBytes(decoded.enc_content);
  if (!enc) {
    // v1 plaintext (or empty/attachment-only) message.
    return { kind: 'plain', text: typeof decoded.content === 'string' ? decoded.content : '' };
  }
  const nonce = asBytes(decoded.enc_nonce);
  if (!nonce) return { kind: 'error' };
  const epoch = decoded.key_epoch ?? 1;

  const ctx = await deviceCtx();
  if (!ctx) return { kind: 'waiting' };
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);
  let key = channelKeys.get(ckey(scopeHex, epoch));
  if (!key) {
    const fetched = await fetchChannelKey(ctx, channelId, scope, scopeHex, epoch);
    if (fetched === 'missing') return { kind: 'waiting' };
    if (fetched === 'corrupt') return { kind: 'error' };
    key = fetched.key;
  }
  try {
    const pt = decryptDmContent(key, scope, epoch, enc, nonce);
    return { kind: 'text', text: pt.text };
  } catch {
    return { kind: 'error' };
  }
}
