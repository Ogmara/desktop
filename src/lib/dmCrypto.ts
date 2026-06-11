/**
 * Direct Message E2E orchestration (P1, protocol §8.2). Mirrors web `dmCrypto.ts`.
 *
 * A DM conversation is a two-member group with a random per-epoch `conv_key`,
 * delivered to each participant device via `ChannelKeyEnvelope` (0x61) and used to
 * XChaCha20-Poly1305-encrypt each message. This module owns the conv_key lifecycle:
 * establish on first send, fetch+unwrap on demand, cache in memory, encrypt/decrypt.
 * The L2 node only ever sees opaque ciphertext + wrapped keys.
 *
 * Desktop uses the built-in wallet for signing and a random stable per-install
 * `device_id` (see deviceEnc.ts). Cross-device/restart key recovery is P3 (vault).
 */
import {
  computeConversationId,
  randomConvKey,
  wrapConvKey,
  unwrapConvKey,
  buildChannelKeyEnvelope,
  buildEncryptedDirectMessage,
  decryptDmContent,
  KeyScopeKind,
  type WrappedKey,
} from '@ogmara/sdk';
import { decode } from '@msgpack/msgpack';
import { getClient } from './api';
import { getSigner, walletAddress } from './auth';
import { getOrCreateEncKeypair, getOrCreateDeviceId } from './deviceEnc';

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** In-memory conv_key cache: `${conversationIdHex}:${epoch}` → 32-byte key. */
const convKeys = new Map<string, Uint8Array>();
const cacheKey = (convIdHex: string, epoch: number) => `${convIdHex}:${epoch}`;

/** Highest cached epoch for a conversation, or null. */
function cachedLatest(convIdHex: string): { key: Uint8Array; epoch: number } | null {
  let best: { key: Uint8Array; epoch: number } | null = null;
  for (const [k, v] of convKeys) {
    if (k.startsWith(`${convIdHex}:`)) {
      const epoch = Number(k.slice(convIdHex.length + 1));
      if (!best || epoch > best.epoch) best = { key: v, epoch };
    }
  }
  return best;
}

/** Per-conversation in-flight establishment, so a double-send doesn't fork the key. */
const establishing = new Map<string, Promise<{ key: Uint8Array; epoch: number }>>();

/** Clear cached keys (e.g. on logout / wallet switch). */
export function clearDmKeyCache(): void {
  convKeys.clear();
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
 * Establish a brand-new `conv_key`: wrap it to every device of BOTH participants
 * and publish one `ChannelKeyEnvelope` (0x61) per device. `peer` is always the
 * recipient so the node's `key_scope == conversation_id(author, peer)` check holds.
 */
async function establishConvKey(
  ctx: DeviceCtx,
  conversationId: Uint8Array,
  recipient: string,
  convKey: Uint8Array,
  epoch: number,
): Promise<void> {
  const client = getClient();
  const [recipKeys, myKeys] = await Promise.all([
    client.getEncKeys(recipient).catch(() => ({ keys: [] as { device_id: string; enc_pub: string }[] })),
    client.getEncKeys(ctx.wallet).catch(() => ({ keys: [] as { device_id: string; enc_pub: string }[] })),
  ]);

  const targets: { target: string; deviceId: string; encPub: string }[] = [
    ...recipKeys.keys.map((k) => ({ target: recipient, deviceId: k.device_id, encPub: k.enc_pub })),
    ...myKeys.keys.map((k) => ({ target: ctx.wallet, deviceId: k.device_id, encPub: k.enc_pub })),
  ];
  if (targets.length === 0) {
    throw new Error('no device encryption keys found for either participant');
  }

  for (const tg of targets) {
    const wrapped: WrappedKey = wrapConvKey(convKey, fromHex(tg.encPub), conversationId);
    const envelope = await buildChannelKeyEnvelope(ctx.signer!, {
      keyScope: conversationId,
      scopeKind: KeyScopeKind.DM,
      epoch,
      target: tg.target,
      deviceId: tg.deviceId,
      peer: recipient,
      wrapped,
    });
    await client.publishKeyEnvelope(envelope);
  }
}

/**
 * Establish a new conv_key, then re-fetch our own device's envelope so we adopt the
 * first-write-wins winner (converge if the peer raced us). Falls back to our
 * candidate if the envelope isn't readable back yet.
 */
async function establishAndAdopt(
  ctx: DeviceCtx,
  conversationId: Uint8Array,
  convIdHex: string,
  recipient: string,
): Promise<{ key: Uint8Array; epoch: number }> {
  const candidate = randomConvKey();
  const epoch = 1;
  await establishConvKey(ctx, conversationId, recipient, candidate, epoch);
  const winner = await fetchConvKey(ctx, conversationId, convIdHex, epoch);
  if (typeof winner !== 'string') return winner;
  convKeys.set(cacheKey(convIdHex, epoch), candidate);
  return { key: candidate, epoch };
}

/** `missing` = not delivered yet (retry); `corrupt` = present but unwrap failed (error). */
type FetchResult = { key: Uint8Array; epoch: number } | 'missing' | 'corrupt';

/** Fetch + unwrap this device's `conv_key` for a scope/epoch. */
async function fetchConvKey(
  ctx: DeviceCtx,
  conversationId: Uint8Array,
  convIdHex: string,
  epoch?: number,
): Promise<FetchResult> {
  let resp;
  try {
    resp = await getClient().getKeyEnvelope(convIdHex, ctx.deviceId, epoch);
  } catch {
    return 'missing'; // network/transient — retry later
  }
  if (!resp.envelope) return 'missing';
  try {
    const env = resp.envelope;
    const wrapped: WrappedKey = {
      ephPub: fromHex(env.eph_pub),
      nonce: fromHex(env.nonce),
      wrapped: fromHex(env.wrapped),
    };
    const key = unwrapConvKey(wrapped, ctx.encPriv, conversationId);
    const ep = resp.epoch ?? env.epoch;
    convKeys.set(cacheKey(convIdHex, ep), key);
    return { key, epoch: ep };
  } catch {
    return 'corrupt'; // envelope present but unwrap failed — a real error, not "waiting"
  }
}

/** Ensure a usable `conv_key` for sending to `recipient` (establishing at epoch 1 if new). */
export async function ensureConvKeyForSend(
  recipient: string,
): Promise<{ convKey: Uint8Array; epoch: number; conversationId: Uint8Array } | null> {
  const ctx = await deviceCtx();
  if (!ctx) return null;
  const conversationId = computeConversationId(ctx.wallet, recipient);
  const convIdHex = toHex(conversationId);

  // 1) In-memory cache first — no node round-trip on the hot path.
  const cached = cachedLatest(convIdHex);
  if (cached) return { convKey: cached.key, epoch: cached.epoch, conversationId };

  // 2) Node: our wrapped envelope (latest epoch), unwrapped + cached.
  const fetched = await fetchConvKey(ctx, conversationId, convIdHex);
  if (typeof fetched !== 'string') {
    return { convKey: fetched.key, epoch: fetched.epoch, conversationId };
  }

  // 3) New conversation — establish once (deduped) and adopt the FWW winner.
  let inflight = establishing.get(convIdHex);
  if (!inflight) {
    inflight = establishAndAdopt(ctx, conversationId, convIdHex, recipient).finally(() =>
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

/** Decrypt a DM message for rendering (plaintext passes through; `waiting` until the key arrives). */
export async function decryptDmMessage(payload: number[] | Uint8Array | string): Promise<DmDisplay> {
  const bytes = toBytes(payload);
  if (!bytes) return { kind: 'error' };
  let decoded: RawDmPayload;
  try {
    decoded = decode(bytes) as RawDmPayload;
  } catch {
    return { kind: 'error' };
  }
  if (typeof decoded.content === 'string') return { kind: 'plain', text: decoded.content };
  // Legacy/MVP plaintext DMs use key_epoch 0 with UTF-8 bytes in `content`
  // (encrypted DMs are always epoch ≥ 1). Render them as plaintext rather than
  // mis-routing to decrypt → permanent "waiting".
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

  let key = convKeys.get(cacheKey(convIdHex, epoch));
  if (!key) {
    const ctx = await deviceCtx();
    if (!ctx) return { kind: 'waiting' };
    const fetched = await fetchConvKey(ctx, conversationId, convIdHex, epoch);
    if (fetched === 'missing') return { kind: 'waiting' };
    if (fetched === 'corrupt') return { kind: 'error' };
    key = fetched.key;
  }
  try {
    const pt = decryptDmContent(key, conversationId, epoch, decoded.content, decoded.nonce);
    return { kind: 'text', text: pt.text };
  } catch {
    return { kind: 'error' };
  }
}
