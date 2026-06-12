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
async function establishMyKey(
  ctx: DeviceCtx,
  conversationId: Uint8Array,
  convIdHex: string,
  recipient: string,
): Promise<{ key: Uint8Array; epoch: number }> {
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

  const convKey = randomConvKey();
  const epoch = 1;
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
  convKeys.set(cacheKey(convIdHex, epoch, ctx.wallet), convKey);
  return { key: convKey, epoch };
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
    resp = await getClient().getKeyEnvelope(convIdHex, ctx.deviceId, author, epoch);
  } catch {
    return 'missing';
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
    convKeys.set(cacheKey(convIdHex, ep, author), key);
    return { key, epoch: ep };
  } catch {
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
  if (cached) return { convKey: cached.key, epoch: cached.epoch, conversationId };

  const fetched = await fetchConvKey(ctx, conversationId, convIdHex, ctx.wallet);
  if (typeof fetched !== 'string') {
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
  } catch {
    return { kind: 'error' };
  }
}
