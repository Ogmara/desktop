/**
 * Encrypted channels (P2 OECK). A channel has a single random 32-byte
 * `channel_key` per epoch, delivered to every member device via
 * `ChannelKeyEnvelope` (0x61, channel scope) and used to XChaCha20-Poly1305-encrypt
 * each message's TEXT (mentions/reply_to/content_rating stay plaintext, spec §3.3).
 *
 * Mirrors `dmCrypto.ts` but the key is a GROUP key (shared by all members, fetched
 * author-agnostically) instead of a per-sender DM key.
 *
 * Epochs are NODE-ARBITRATED (l2-node 0.143.0 `key_commitment_v1`): the node
 * keeps one winner per `(channel, epoch)`; every epoch is established or adopted
 * through the SDK's `establishEpochKey` (wired in `epochKeys.ts`), never by a
 * protocol of this client's own. A rotation (kick floor, heal) waits until the
 * epoch is FINAL (~2 min) and the UI shows "re-keying…"; only the creator's
 * FIRST key of a brand-new channel (no other member yet) is used immediately.
 * Covering a new member at an existing epoch publishes the epoch's own
 * `(keyTs, keyCommitment)` pair, persisted with the key by verified paths only.
 *
 * This file is WIRING: the rules live in pure, behaviour-tested modules —
 * `channelKeyStore.ts` (adapter over the SDK's shared `ChannelKeyring`:
 * generation guard, bounded evidence / send rule),
 * `epochKeys.ts` (SDK runner, persistence, id-floor rule, cover loop),
 * `epochDriver.ts` (drive / resume / retry / result application),
 * `epochPeers.ts` (peer sources and the unified peer rule).
 */
import { createSignal } from 'solid-js';
import {
  OgmaraClient,
  computeChannelScope,
  unwrapConvKey,
  randomConvKey,
  decryptDmContent,
  buildChannelEpochKeyEnvelope,
  buildEncryptedChannelMessage,
  MemberProofCache,
  filterVerifiedMembers,
  legacyJoinActivationMs,
  verifyEncKeyBinding,
  encPublicKeyHex,
  verifyChannelKeyWrap,
  makeOwnWrapFetcher,
  discoverNodesViaSc,
  KeyCommitmentConflictError,
  KeyEnvelopeRateLimitedError,
  KeyEnvelopeRejectedError,
  FEATURE_KEY_COMMITMENT_V1,
  acceptFetchedEnvelope,
  type ChannelKeyHeld,
  type ChannelKeyExportToken,
  type WrappedKey,
  type MediaDescriptor,
  type KeyCommitmentInfo,
  type EpochKeyTarget,
  type UnconfirmedEpochKey,
} from '@ogmara/sdk';
import { decode } from '@msgpack/msgpack';
import { getClient, getKnownNodes, getCurrentNodeUrl } from './api';
import { e2elog, withRetry } from './e2eDebug';
import {
  deviceCtx, toHex, fromHex, toBytes,
  notifyKeyringChanged, requestVaultRestore, ctxStillFresh,
  type DeviceCtx, type DmDisplay,
} from './dmCrypto';
import {
  currentSwitchGeneration, registerWalletSwitchReset, scopedGetFor, scopedSetFor, scopedRemoveFor,
} from './walletScope';
import {
  StaleAccountError, assertFresh, resolveCoverTargets, selectVerifiedWallets,
  createSerialQueue, CoverThrottle, PerAccountCache, coverTargetKey, coverMode, loadPin,
  type WalletStore, type CoverTarget, type TargetsResult,
} from './privateCover';
import {
  EpochAccountHolder, runEpochKey, planRotation, planNextEpoch, rotationAllowed, effectiveFloor, healApplies,
  coverTargetsAtEpoch, saveKeyMeta, loadPendingEpochs, clearPendingEpoch, commitmentState,
  type EpochAccount, type EpochKeyResult, type CoverModeHint, type KeyMeta,
} from './epochKeys';
import { ChannelKeys, type PruneLevel, type PrunePlan } from './channelKeyStore';
import { ownSlotWrapOpts, putLegacyKey, markFinalFromCommitment } from './channelKeyFlows';
import {
  runDrive, applyEpochResult, RekeyScheduler, resumeCandidates, decideCoverAction, gatedPlan, alignWait,
  type DrivePlan, type ChannelKeyStatus,
} from './epochDriver';
import { queryPeerCommitments, selectPeerCandidates, probePeers, markNoRedirect } from './epochPeers';
import { ensureDeviceEncBinding } from './deviceEnc';
import { isPublicRangeChannelId } from './channelEncryption';

export type { ChannelKeyStatus } from './epochDriver';

/**
 * Channel group-key cache: the SDK's shared `ChannelKeyring` behind the
 * desktop adapter (`channelKeyStore.ts`). Every write is stamped with the
 * switch generation the caller captured before its network round trip
 * (cross-account key leak, 2026-09-04). The keyring stores and returns
 * COPIES: keys are compared by bytes, never by reference.
 */
const keys = new ChannelKeys(currentSwitchGeneration, notifyKeyringChanged);

/** Persisted pins / removals / key metadata / pending epochs, always addressed by the CAPTURED wallet. */
const proofStore: WalletStore = { get: scopedGetFor, set: scopedSetFor, remove: scopedRemoveFor };

/**
 * Step 1 of the TWO-STEP vault export: the `chan` record (unchanged
 * cross-client format) for the account `generation` the caller captured, and
 * a token. Side-effect free; pass the token to {@link commitChannelExport}
 * ONLY after the sealed vault was published, so a failed publish leaves every
 * key exactly as it was.
 * @throws ChannelKeyringError `vault_too_large` / `opaque_overflow` / `stale`:
 *   the backup is refused, never shrunk — keyVault.ts surfaces it as "backup paused".
 */
export function prepareChannelExport(generation: number): { chan: Record<string, Uint8Array>; token: ChannelKeyExportToken } {
  return keys.prepareExport(generation);
}
/** Step 2: the export behind `token` was published (a stale / cleared one is skipped and logged). */
export function commitChannelExport(token: ChannelKeyExportToken, generation: number): void {
  try {
    keys.commitExport(token, generation);
  } catch (e) {
    e2elog('keyvault: channel export commit skipped', { err: (e as Error)?.message });
  }
}
/** No channel key and no kept unknown vault entry (cheap; no export is built). */
export function channelKeyringEmpty(): boolean {
  return keys.empty;
}
/**
 * Merge vault-restored channel keys in (NOT author-verified; never clobbers a
 * held key — a different one is kept as an alternate; keys the user pruned
 * this session are skipped). The record spans every channel, so no per-channel
 * epoch ceiling is applied (SDK limitation).
 * @throws ChannelKeyringError `stale` when `generation` is no longer current.
 */
export function importChannelKeysFromVault(rec: Record<string, Uint8Array>, generation: number): number {
  return keys.importFromVault(rec, generation);
}

/**
 * The next USER-CONFIRMED prune step for a backup paused as too large (dry
 * run, nothing changes), least risky first from `from` on: node-served keys →
 * the most-flooded channel's member wraps → restored alternates (may include
 * the user's own outranked keys) → restored primary-name keys (last resort).
 * @throws ChannelKeyringError `stale` when `generation` is no longer current.
 */
export function planChannelKeyPrune(generation: number, from?: PruneLevel): PrunePlan | null {
  return keys.nextPrunePlan(generation, from);
}
/**
 * Apply a plan whose dry run the user confirmed; returns how many keys were
 * removed, or `'changed'` (nothing removed) when a fresh dry run would remove
 * more than the confirmation showed.
 */
export function applyChannelKeyPrune(plan: PrunePlan, generation: number): number | 'changed' {
  if (keys.pruneGrew(plan, generation)) return 'changed';
  return keys.applyPrune(plan, generation).removedCount;
}

/** How a verified key reached us (see {@link cacheVerified}). */
type VerifiedHow =
  /** Our own establish / an adopted winner the SDK confirmed FINAL with the node (`confirmMode: 'final'`). */
  | { source: 'establish'; final: true }
  /**
   * A wrap `verifyChannelKeyWrap` verified, from our own slot, with its
   * verified `author` wallet (`ownSlot` exactly when that is ours — see
   * `ownSlotWrapOpts`); `nodeHighest` bounds a wrap another member authored.
   */
  | { source: 'wrap'; author: string; nodeHighest: number };

/**
 * Cache a key from an AUTHOR-VERIFIED path (a wrap `verifyChannelKeyWrap`
 * verified, or our own final establish / adopt) with its pair, and persist
 * the pair. A DIFFERENT key already held at that epoch is never overwritten
 * (the keyring keeps both): the conflict is logged and fires the gated heal.
 */
function cacheVerified(
  ctx: DeviceCtx, channelId: number, network: string, epoch: number, key: Uint8Array, meta: KeyMeta, how: VerifiedHow,
): void {
  const scopeHex = toHex(computeChannelScope(channelId));
  const before = keys.entriesAt(scopeHex, epoch)[0];
  const r = how.source === 'establish'
    ? keys.put(scopeHex, epoch, key, ctx.generation, { source: 'establish', meta, verified: true, final: true })
    : keys.put(scopeHex, epoch, key, ctx.generation, ownSlotWrapOpts(how.author, ctx.wallet, meta, how.nodeHighest));
  if (r === 'invalid') {
    e2elog('channel key: pair does not hash to the key — not cached', { channelId, epoch });
    return;
  }
  if (r === 'refused') {
    e2elog('channel key: wrap refused by the keyring (above the node\'s reach or member cap)', { channelId, epoch });
    return;
  }
  if (r === 'stale') return;
  const primary = keys.entriesAt(scopeHex, epoch)[0];
  if ((r === 'stored' || r === 'promoted') && primary && sameBytes(primary.key, key) && ctxStillFresh(ctx)) {
    saveKeyMeta(proofStore, ctx.wallet, network, channelId, epoch, meta);
  }
  // A split: another TRUSTED key is held at this epoch. `conflict` means the
  // primary is trusted (a trusted key outranks any vault / legacy /
  // provisional one); a promotion over an untrusted key is just re-verification.
  const split = r === 'conflict' || (r === 'promoted' && !!before?.trusted && !sameBytes(before.key, key));
  if (split) {
    e2elog('channel key: a different key is also held at this epoch — both kept', { channelId, epoch, result: r });
    void maybeHeal(ctx, channelId, epoch);
  }
}

// --- Per-account epoch state -------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** PendingEpochKeyStore + EscalationGate + TokenBucket, per (wallet, switch generation). */
const epochAccounts = new EpochAccountHolder(Date.now, sleep);
const acctFor = (ctx: DeviceCtx): EpochAccount => epochAccounts.get(ctx.wallet, ctx.generation, ctxStillFresh(ctx));

/** One establish/rotation drive per channel at a time (send + rotate + cover + resume share it). */
const establishing = new Map<number, Promise<EpochKeyResult | null>>();
/** Which `(target, device)` we've wrapped the key to, per `${scopeHex}:${epoch}`. */
const wrappedToDevices = new Map<string, Set<string>>();
/** Cover throttle: 10 s public, 60 s private, 5 s floor for member-change events. */
const coverThrottle = new CoverThrottle();
/** Channels with one delayed retry pending after an `incomplete` verification. */
const coverRetryTimers = new Map<number, ReturnType<typeof setTimeout>>();
/** Delay of that single retry. */
const COVER_RETRY_MS = 30_000;
/** Re-keying retries: one per minute, at most 10 per channel per session. */
const rekeys = new RekeyScheduler((fn, ms) => setTimeout(fn, ms), (h) => clearTimeout(h as ReturnType<typeof setTimeout>));
/** How long a send waits for the creator's first key of a brand-new channel. */
const EARLY_KEY_WAIT_MS = 20_000;
/**
 * Trust probes made (`${scopeHex}:${epoch}:${kind}` → ms): re-verifying our own
 * slot's wrap / asking the node for finality, at most once per minute each.
 */
const trustProbes = new Map<string, number>();
const TRUST_PROBE_MS = 60_000;
/** Max remembered probes (oldest dropped): a memory bound, not a correctness one. */
const MAX_TRUST_PROBES = 1024;

/**
 * The home node's view of a channel, per account session: its highest epoch
 * (bounds every evidence / send query and every put of a key that is not ours
 * to highest + 256). `known`: the node answered (an unknown highest counts as
 * the last known value, else 0 — fail closed).
 */
interface NodeView {
  highest: number;
  known: boolean;
  at: number;
}
const nodeViews = new Map<string, NodeView>();

/**
 * Decrypt-miss fetches per `${scopeHex}:${epoch}`: at most
 * {@link MISS_FETCHES_PER_MIN} per minute (every rendered message of a missing
 * epoch would otherwise fetch on its own). Bounded map, reset on switch.
 */
const missFetches = new Map<string, { start: number; n: number }>();
const MISS_FETCHES_PER_MIN = 3;
function takeMissFetch(k: string): boolean {
  const now = Date.now();
  const cur = missFetches.get(k);
  if (cur && now - cur.start < 60_000) {
    if (cur.n >= MISS_FETCHES_PER_MIN) return false;
    cur.n++;
    return true;
  }
  missFetches.delete(k);
  if (missFetches.size >= 2048) missFetches.delete(missFetches.keys().next().value as string);
  missFetches.set(k, { start: now, n: 1 });
  return true;
}
const NODE_VIEW_TTL_MS = 30_000;

/**
 * Positive member-proof verdicts (SDK `MemberProofCache`) — per account and
 * per switch generation, never shared; dropped on every switch.
 */
const proofCaches = new PerAccountCache(() => new MemberProofCache());
/** All member-proofs requests run one at a time (the node allows one build per wallet). */
const proofQueue = createSerialQueue();

// --- Re-keying UI state ---------------------------------------------------------------

const [keyStatus, setKeyStatus] = createSignal<Record<number, ChannelKeyStatus>>({});
/** Reactive: the channel's key state for the active account, or null. */
export function channelKeyStatus(channelId: number): ChannelKeyStatus | null {
  return keyStatus()[channelId] ?? null;
}
function setStatus(ctx: DeviceCtx, channelId: number, s: ChannelKeyStatus | null): void {
  if (!ctxStillFresh(ctx)) return;
  setKeyStatus((prev) => {
    if ((prev[channelId] ?? null) === s) return prev;
    const next = { ...prev };
    if (s) next[channelId] = s;
    else delete next[channelId];
    return next;
  });
}

function resetCoverState(): void {
  wrappedToDevices.clear();
  coverThrottle.clear();
  for (const t of coverRetryTimers.values()) clearTimeout(t);
  coverRetryTimers.clear();
  rekeys.clear();
  establishing.clear();
  trustProbes.clear();
  nodeViews.clear();
  missFetches.clear();
  proofCaches.reset();
  epochAccounts.reset(); // zeroes every pending (unconfirmed) epoch key
  peerCache = null;
  setKeyStatus({});
}
registerWalletSwitchReset(resetCoverState);

export function clearChannelKeyCache(): void {
  keys.clear();
  resetCoverState();
}

const asBytes = (v: unknown): Uint8Array | null =>
  v instanceof Uint8Array ? v : Array.isArray(v) ? Uint8Array.from(v as number[]) : null;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// --- Node capability + peers -----------------------------------------------------------

/** `/health` feature check per node (5 min): establishEpochKey needs `key_commitment_v1`. */
let featureCache: { url: string; at: number; ok: boolean } | null = null;
async function nodeArbitrates(): Promise<boolean> {
  const url = getCurrentNodeUrl();
  if (featureCache && featureCache.url === url && Date.now() - featureCache.at < 5 * 60_000) return featureCache.ok;
  try {
    const h = await getClient().health();
    const ok = Array.isArray(h.features) && h.features.includes(FEATURE_KEY_COMMITMENT_V1);
    featureCache = { url, at: Date.now(), ok };
    return ok;
  } catch {
    return false; // not cached: retried on the next call
  }
}

/**
 * The home node's {@link NodeView} of `channelId` (cached 30 s per account
 * session). An unreadable highest keeps the last known value (0 and
 * `known: false` when none: fail closed — keys above 256 are then neither
 * evidence / send keys nor accepted from others). Never caches a view across
 * an account switch.
 */
async function nodeView(ctx: DeviceCtx, channelId: number): Promise<NodeView> {
  const cur = nodeViews.get(viewKey(channelId));
  if (cur && Date.now() - cur.at < NODE_VIEW_TTL_MS) return cur;
  let v: NodeView;
  try {
    const info = await getClient().getKeyCommitment(channelId);
    assertFresh(() => ctxStillFresh(ctx));
    v = viewFromInfo(info);
  } catch (e) {
    if (e instanceof StaleAccountError) throw e;
    // Cached for the TTL too (a pre-0.143 node 404s every time: one request
    // per 30 s, not one per rendered message); keeps the last known highest.
    v = { highest: cur?.highest ?? 0, known: cur?.known ?? false, at: Date.now() };
    if (!ctxStillFresh(ctx)) throw new StaleAccountError();
  }
  noteNodeView(ctx, channelId, v);
  return v;
}

/** A {@link NodeView} from the node's answer for its HIGHEST epoch (`getKeyCommitment(channelId)`). */
function viewFromInfo(info: KeyCommitmentInfo): NodeView {
  const highest = Number.isSafeInteger(info.epoch) && info.epoch >= 0 ? info.epoch : 0;
  return { highest, known: true, at: Date.now() };
}

/** Views are per home node: switching node never carries another node's highest over. */
const viewKey = (channelId: number): string => `${getCurrentNodeUrl()}#${channelId}`;

/** Remember a fresh view (only for the still-active account). */
function noteNodeView(ctx: DeviceCtx, channelId: number, v: NodeView): void {
  if (!ctxStillFresh(ctx)) return;
  if (nodeViews.size >= 1024 && !nodeViews.has(viewKey(channelId))) nodeViews.delete(nodeViews.keys().next().value as string);
  nodeViews.set(viewKey(channelId), v);
}

/** A FINAL key at `epoch` came from this node: its highest is at least `epoch`. */
function noteFinalEpoch(ctx: DeviceCtx, channelId: number, epoch: number): void {
  const cur = nodeViews.get(viewKey(channelId));
  if (cur && cur.highest < epoch) noteNodeView(ctx, channelId, { ...cur, highest: epoch });
}

/** Peer nodes per account + home node, 10 min. */
let peerCache: { wallet: string; generation: number; home: string; at: number; urls: string[] } | null = null;
const PEER_TTL_MS = 10 * 60_000;
const PEER_TIMEOUT_MS = 8_000;
const SC_MAX_ANCHOR_AGE_SECS = 7 * 24 * 60 * 60;

/**
 * Peer nodes (`epochPeers.ts`): the user's known nodes plus the on-chain
 * registry — never hosts the home node lists — kept only when their
 * `/health` answers on the SAME network with `key_commitment_v1`. Peer
 * requests never follow redirects (`markNoRedirect`, honoured by the fetch
 * wrapper in index.tsx).
 */
async function peerNodes(ctx: DeviceCtx, network: string): Promise<string[]> {
  const home = getCurrentNodeUrl();
  if (peerCache && peerCache.wallet === ctx.wallet && peerCache.generation === ctx.generation
      && peerCache.home === home && Date.now() - peerCache.at < PEER_TTL_MS) {
    return peerCache.urls;
  }
  let registry: string[] = [];
  if (network === 'mainnet' || network === 'testnet') {
    const nowSecs = Math.floor(Date.now() / 1000);
    registry = (await discoverNodesViaSc(network).catch(() => []))
      .filter((n) => !!n.endpoint && (!n.lastAnchorAt || nowSecs - n.lastAnchorAt <= SC_MAX_ANCHOR_AGE_SECS))
      .map((n) => n.endpoint as string);
    assertFresh(() => ctxStillFresh(ctx));
  }
  // Fail closed: a peer whose redirects cannot be turned off is not used.
  const cands = selectPeerCandidates({ known: getKnownNodes(), registry, home }).filter((u) => markNoRedirect(u));
  const urls = await probePeers(
    cands, (u) => new OgmaraClient({ nodeUrl: u, timeout: PEER_TIMEOUT_MS }).health(), network, FEATURE_KEY_COMMITMENT_V1,
  );
  assertFresh(() => ctxStillFresh(ctx));
  peerCache = { wallet: ctx.wallet, generation: ctx.generation, home, at: Date.now(), urls };
  e2elog('channel epoch: peer nodes for split detection', { candidates: cands.length, count: urls.length });
  return urls;
}

// --- Targets + membership ---------------------------------------------------------------

/**
 * The devices a channel key may be wrapped to — `resolveCoverTargets`
 * (privateCover.ts) wired to the live client. PRIVATE (verify-before-cover,
 * protocol §3.9.2): members are verified with the SDK's `filterVerifiedMembers`
 * (serialized, per-account proof cache) before anything is wrapped, only
 * wallet-BOUND enc keys are used, the caller's own wallet is always included.
 * A private-range channel id, or a channel this account holds a creator pin
 * for, is always verified whatever `hint` says; an unknown type below the
 * floor defers (throws `CoverDeferredError`). Every await is followed by an
 * account re-check (`StaleAccountError`).
 */
function getChannelTargets(
  ctx: DeviceCtx, channelId: number, hint: boolean | undefined, covered?: ReadonlySet<string>,
): Promise<TargetsResult> {
  const client = getClient();
  return resolveCoverTargets(
    {
      getMembers: async (id, page, limit) =>
        (await withRetry(() => client.getChannelMembers(id, { page, limit }), 'fetch channel members')).members,
      getNetwork: () => client.getNetwork(),
      getEncKeys: async (wallet) => (await withRetry(() => client.getEncKeys(wallet), 'fetch enc keys')).keys,
      verifyMembers: (wallets, opts) =>
        proofQueue(() => {
          // Queued behind another pass: the account may have changed meanwhile.
          assertFresh(() => ctxStillFresh(ctx));
          return filterVerifiedMembers(
            client, channelId, wallets,
            proofCaches.get(ctx.wallet, ctx.generation, ctxStillFresh(ctx)),
            opts,
          );
        }),
      verifyBinding: verifyEncKeyBinding,
      activationMs: legacyJoinActivationMs,
      store: proofStore,
      fresh: () => ctxStillFresh(ctx),
      log: e2elog,
    },
    { self: ctx.wallet, channelId, hint, covered },
  );
}

/**
 * Is `wallet` a member whose wrap we may accept? Our own wallet always. In a
 * verify-mode channel (private range, pinned, or a private hint) only a
 * member whose signed membership evidence verifies (same serialized,
 * per-account pipeline as cover). In a positively public / not-yet-typed
 * public-range channel the node's membership is taken as is — anyone may join
 * a public channel and obtain its key, so the node is no confidentiality
 * adversary there.
 */
function memberCheck(
  ctx: DeviceCtx, channelId: number, network: string, mode: 'verify' | 'public' | 'defer',
): (wallet: string) => Promise<boolean> {
  return async (wallet) => {
    if (wallet === ctx.wallet) return true;
    if (mode !== 'verify') return true;
    try {
      const sel = await selectVerifiedWallets(
        {
          verify: (ws, opts) => proofQueue(() => {
            assertFresh(() => ctxStillFresh(ctx));
            return filterVerifiedMembers(
              getClient(), channelId, ws, proofCaches.get(ctx.wallet, ctx.generation, ctxStillFresh(ctx)), opts,
            );
          }),
          store: proofStore,
          fresh: () => ctxStillFresh(ctx),
          log: e2elog,
        },
        { self: ctx.wallet, network, channelId, members: [wallet], activationMs: legacyJoinActivationMs(network) },
      );
      return sel.wallets.includes(wallet);
    } catch {
      return false; // stale / failed: fail closed
    }
  };
}

function modeFor(ctx: DeviceCtx, channelId: number, network: string, hint: boolean | undefined): 'verify' | 'public' | 'defer' {
  return coverMode(channelId, hint, loadPin(proofStore, ctx.wallet, network, channelId) !== undefined);
}

const toEpochTarget = (t: CoverTarget): EpochKeyTarget | null =>
  /^[0-9a-fA-F]{64}$/.test(t.encPub) && typeof t.deviceId === 'string' && t.deviceId.length > 0
    ? { target: t.target, deviceId: t.deviceId.toLowerCase(), encPub: fromHex(t.encPub) }
    : null;

/** Our own slot's wrap at `epoch`, VERIFIED (author, membership, binding, commitment); null when absent / unverifiable. */
function ownWrapFetcher(ctx: DeviceCtx, channelId: number, network: string, mode: 'verify' | 'public' | 'defer') {
  return makeOwnWrapFetcher(
    getClient(),
    {
      self: ctx.wallet, deviceId: ctx.deviceId, network, channelId, encPriv: ctx.encPriv,
      isVerifiedMember: memberCheck(ctx, channelId, network, mode),
    },
    (reason) => e2elog('channel epoch: own wrap rejected', { channelId, reason }),
  );
}

// --- Fetch (decrypt path) ------------------------------------------------------------------

/**
 * Fetch + unwrap MY wrapped channel key for `epoch` (latest if omitted). Author
 * is the canonical empty string — channel keys are a group key, stored
 * author-agnostically. Asks for the signed envelope (`proof=1`): a wrap that
 * carries a commitment is accepted only when `verifyChannelKeyWrap` verifies
 * its author (a member — verified evidence in private channels), its binding
 * to us and `H(scope, epoch, keyTs, key) == commitment`; it is cached as
 * `wrap` (author-verified) with its pair. A commitment-less (pre-arbitration)
 * wrap is unwrapped as before and cached as `legacy` (decrypt only; never
 * evidence, never a pair, never a send key) — only when its epoch is the one
 * asked for (SDK `acceptFetchedEnvelope`: a node must not label a key with an
 * arbitrary epoch), and never when the keyring refuses it (caps on
 * node-served keys; no fallback). The key itself stays in the keyring: the
 * result only names the epoch.
 */
type FetchResult = { epoch: number } | 'missing' | 'corrupt';
async function fetchChannelKey(
  ctx: DeviceCtx, channelId: number, scope: Uint8Array, scopeHex: string, epoch?: number,
  hint?: boolean,
): Promise<FetchResult> {
  const fresh = () => ctxStillFresh(ctx);
  // The node's highest bounds every key that is not ours (+256): read it first.
  let nv: NodeView;
  try {
    nv = await nodeView(ctx, channelId);
  } catch {
    return 'missing'; // stale account
  }
  let resp;
  try {
    resp = await withRetry(
      () => getClient().getKeyEnvelope(scopeHex, ctx.deviceId, '', epoch, { proof: true }),
      'fetch channel key',
    );
  } catch (e) {
    e2elog('channel fetchKey: network → missing', { channelId, epoch, err: (e as Error)?.message });
    return 'missing';
  }
  if (!fresh()) return 'missing';
  if (!resp.envelope) return 'missing';
  const env = resp.envelope;
  if (env.key_commitment != null && typeof env.signed_envelope === 'string') {
    let network: string;
    try {
      network = await getClient().getNetwork();
    } catch {
      return 'missing';
    }
    if (!fresh()) return 'missing';
    const v = await verifyChannelKeyWrap(env, {
      self: ctx.wallet, deviceId: ctx.deviceId, network, channelId, encPriv: ctx.encPriv,
      epoch: epoch ?? env.epoch,
      isVerifiedMember: memberCheck(ctx, channelId, network, modeFor(ctx, channelId, network, hint)),
    });
    if (!fresh()) {
      if (v.ok) v.wrap.key.fill(0);
      return 'missing';
    }
    if (!v.ok) {
      e2elog('channel fetchKey: wrap did not verify', { channelId, epoch, reason: v.reason });
      // Membership evidence may simply not be available yet: retry later.
      return v.reason === 'author_not_verified_member' ? 'missing' : 'corrupt';
    }
    const w = v.wrap;
    // Our own slot always; `ownSlot` only when the wrap's verified author is our own wallet.
    cacheVerified(ctx, channelId, network, w.epoch, w.key, { keyTs: w.keyTs, keyCommitment: w.keyCommitment }, {
      source: 'wrap', author: w.wallet, nodeHighest: nv.highest,
    });
    w.key.fill(0); // the keyring holds its own copy
    return keys.holds(scopeHex, w.epoch) ? { epoch: w.epoch } : 'missing';
  }
  // Epoch binding: a node-served envelope only for the epoch we asked for (or,
  // asking for the latest, the epoch the response itself names).
  const requested = epoch ?? resp.epoch ?? env.epoch;
  if (!acceptFetchedEnvelope(requested, env.epoch)) {
    e2elog('channel fetchKey: envelope epoch is not the requested one → corrupt', { channelId, epoch });
    return 'corrupt';
  }
  let key: Uint8Array | undefined;
  try {
    const wrapped: WrappedKey = { ephPub: fromHex(env.eph_pub), nonce: fromHex(env.nonce), wrapped: fromHex(env.wrapped) };
    key = unwrapConvKey(wrapped, ctx.encPriv, scope); // salt = channel scope (matches wrap)
    if (!fresh()) return 'missing';
    // The keyring never overwrites a held key (same key: merged; a different
    // one is kept as an alternate or refused) — a legacy fetch can never demote it.
    // Not held (switch / refused, nothing else there) is `missing`, never an
    // error of the message: the key may still come from the vault restore.
    if (putLegacyKey(keys, scopeHex, env.epoch, key, ctx.generation, nv.highest) === 'missing') {
      e2elog('channel fetchKey: legacy key not held by the keyring', { channelId, epoch: env.epoch });
      return 'missing';
    }
    return { epoch: env.epoch };
  } catch (e) {
    e2elog('channel fetchKey: unwrap FAILED → corrupt', { channelId, epoch, err: (e as Error)?.message });
    return 'corrupt';
  } finally {
    key?.fill(0); // the keyring holds its own copy
  }
}

/** Take the probe token for `k` (once per {@link TRUST_PROBE_MS}); false while it is spent. */
function takeProbe(k: string): boolean {
  const now = Date.now();
  const last = trustProbes.get(k);
  if (last !== undefined && now - last < TRUST_PROBE_MS) return false;
  trustProbes.delete(k);
  if (trustProbes.size >= MAX_TRUST_PROBES) trustProbes.delete(trustProbes.keys().next().value as string);
  trustProbes.set(k, now);
  return true;
}

/**
 * Ask the node whether the pair WE verified for a held, author-verified key
 * at `epoch` is the epoch's FINAL winner, and record it (`markFinal`). The
 * node's answer is used only to compare against our own verified pair, never
 * as a pair source (a hostile node can compute a pair for any key it served).
 */
async function confirmFinal(ctx: DeviceCtx, channelId: number, scopeHex: string, epoch: number): Promise<boolean> {
  const info = await getClient().getKeyCommitment(channelId, epoch);
  assertFresh(() => ctxStillFresh(ctx));
  return markFinalFromCommitment(keys, scopeHex, epoch, info, ctx.generation);
}

/**
 * Re-establish trust in the highest held key within reach of the node
 * (`ChannelKeys.trustProbe`), at most once per minute per epoch and kind:
 * after a restart every key is a `vault` key (nothing trusted), so our own
 * slot's wrap is fetched and VERIFIED and re-put as `wrap`; a trusted key
 * that is not final yet is checked for finality. Network errors are left
 * for the next probe (never a reason to trust anything).
 */
async function refreshTrust(
  ctx: DeviceCtx, channelId: number, scope: Uint8Array, scopeHex: string, nv: NodeView, hint: boolean | undefined,
): Promise<void> {
  let p = keys.trustProbe(scopeHex, nv.highest);
  if (p?.kind === 'verify' && takeProbe(`${scopeHex}:${p.epoch}:verify`)) {
    await fetchChannelKey(ctx, channelId, scope, scopeHex, p.epoch, hint);
    assertFresh(() => ctxStillFresh(ctx));
    p = keys.trustProbe(scopeHex, nv.highest);
  }
  if (p?.kind === 'final' && takeProbe(`${scopeHex}:${p.epoch}:final`)) {
    await confirmFinal(ctx, channelId, scopeHex, p.epoch).catch((e) => {
      if (e instanceof StaleAccountError) throw e;
      e2elog('channel key: finality check failed (retried later)', { channelId, epoch: p?.epoch, err: (e as Error)?.message });
      return false;
    });
  }
}

/**
 * The key to send / cover under (`ChannelKeys.sendKey`: a trusted FINAL key
 * within reach of the node; the creator's provisional first key at epoch 1;
 * an unverified key only in a channel the node reports as pre-arbitration).
 * With no key at all the latest is fetched; a higher untrusted / not-final
 * held key is re-verified first ({@link refreshTrust}), so sends do not stay
 * on a stale epoch — and after a restart nothing is sent under a key that
 * was not re-verified.
 */
async function bestChannelKey(
  ctx: DeviceCtx, channelId: number, scope: Uint8Array, scopeHex: string, hint?: boolean,
): Promise<ChannelKeyHeld | null> {
  const nv = await nodeView(ctx, channelId);
  if (!keys.latestBounded(scopeHex, nv.highest)) {
    await fetchChannelKey(ctx, channelId, scope, scopeHex, undefined, hint);
    assertFresh(() => ctxStillFresh(ctx));
  }
  await refreshTrust(ctx, channelId, scope, scopeHex, nv, hint);
  return keys.sendKey(scopeHex, nv.highest);
}

// --- Epoch establishment (SDK establishEpochKey) --------------------------------------------

/**
 * Run the SDK protocol for one plan with every dependency wired to the live
 * client and the captured account. The account guard runs after every await
 * inside the SDK; a switch throws `StaleAccountError` and nothing further is
 * signed, published, cached or persisted.
 */
async function driveEpoch(ctx: DeviceCtx, channelId: number, network: string, plan: DrivePlan): Promise<EpochKeyResult> {
  const fresh = () => ctxStillFresh(ctx);
  const acct = acctFor(ctx);
  const scopeHex = toHex(computeChannelScope(channelId));
  const hint = plan.mode === 'verify';
  const mode = modeFor(ctx, channelId, network, hint);
  const myEncPub = encPublicKeyHex(ctx.encPriv).toLowerCase();
  const ownWrap = ownWrapFetcher(ctx, channelId, network, mode);
  // Evidence is bounded by the node's highest + 256 (a malicious member's
  // verified wrap far above it must not raise the SDK's `highestEpochSeen`).
  const nv = await nodeView(ctx, channelId);
  return runEpochKey(
    {
      channelId,
      network,
      self: {
        wallet: ctx.wallet,
        deviceId: ctx.deviceId.toLowerCase(),
        signingAddress: ctx.signer!.signingAddress,
        encPub: fromHex(myEncPub),
      },
      fresh,
      getCommitment: (e) => getClient().getKeyCommitment(channelId, e),
      fetchOwnWrap: async (e) => {
        const w = await ownWrap(e);
        if (!fresh()) {
          w?.key.fill(0);
          throw new StaleAccountError();
        }
        return w;
      },
      isSelfBound: async () => {
        const { keys: rows } = await getClient().getEncKeys(ctx.wallet);
        assertFresh(fresh);
        const row = rows.find((k) => (k.device_id ?? '').toLowerCase() === ctx.deviceId.toLowerCase()
          && (k.enc_pub ?? '').toLowerCase() === myEncPub);
        if (!row) return false;
        return (await verifyEncKeyBinding(row, ctx.wallet, network)).status === 'bound';
      },
      listTargets: async () => {
        const r = await getChannelTargets(ctx, channelId, hint);
        const targets = r.targets.flatMap((t) => {
          const et = toEpochTarget(t);
          return et ? [et] : [];
        });
        // Carried out for the early-use rule: unverifiable members and dropped
        // targets mean "maybe not only us".
        return { targets, incomplete: r.incomplete, rejected: r.targets.length - targets.length };
      },
      publish: async (t, key, keyTs, e) => {
        assertFresh(fresh);
        // Signed fresh on every call (a new envelope timestamp → new msg_id).
        const bytes = await buildChannelEpochKeyEnvelope(ctx.signer!, {
          channelId, epoch: e, key, keyTs, target: t.target, deviceId: t.deviceId, encPub: t.encPub,
        });
        // The shared client may already carry the next account's signer.
        assertFresh(fresh);
        return getClient().publishChannelKeyEnvelope(bytes);
      },
      peerCommitments: async (e) => {
        const peers = await peerNodes(ctx, network);
        return queryPeerCommitments(peers, (u) =>
          new OgmaraClient({ nodeUrl: u, timeout: PEER_TIMEOUT_MS }).withSigner(ctx.signer!).getKeyCommitment(channelId, e));
      },
      newKey: randomConvKey,
      now: Date.now,
      sleep,
      highestEpochSeen: () => keys.evidence(scopeHex, nv.highest),
      holdsKeyAt: (e) => keys.holds(scopeHex, e),
      log: e2elog,
    },
    acct,
    proofStore,
    { epoch: plan.epoch, epochKnownToExist: plan.epochKnownToExist, mode: plan.mode, onEarly: plan.onEarly },
  );
}

/** Apply a drive's result (`applyEpochResult`): only for the still-active account. */
function applyResult(ctx: DeviceCtx, channelId: number, network: string, plan: DrivePlan, res: EpochKeyResult): void {
  applyEpochResult(
    {
      fresh: () => ctxStillFresh(ctx),
      // The SDK confirmed this pair FINAL (`confirmMode: 'final'`) for our own
      // establish or an adopted winner from an author-verified wrap.
      cacheFinal: (epoch, key, meta) => {
        cacheVerified(ctx, channelId, network, epoch, key, meta, { source: 'establish', final: true });
        noteFinalEpoch(ctx, channelId, epoch);
      },
      resetRetries: () => rekeys.reset(channelId),
      setStatus: (s) => setStatus(ctx, channelId, s),
      retry: (p) => rekeys.schedule(channelId, () => {
        if (ctxStillFresh(ctx)) void startDrive(ctx, channelId, async () => p);
      }),
      rebind: () => { void ensureDeviceEncBinding().catch(() => undefined); },
      log: (s, d) => e2elog(s, { channelId, ...d }),
    },
    plan,
    res,
  );
}

/**
 * Start (or join) the channel's single in-flight drive (`runDrive`): a
 * persisted unfinished epoch is resumed first unless it lies below the
 * plan's floor (then it is dropped).
 */
function startDrive(
  ctx: DeviceCtx, channelId: number, makePlan: (network: string) => Promise<DrivePlan | null>,
): Promise<EpochKeyResult | null> {
  const inflight = establishing.get(channelId);
  if (inflight) return inflight;
  const started: Promise<EpochKeyResult | null> = runDrive(
    {
      fresh: () => ctxStillFresh(ctx),
      network: () => getClient().getNetwork(),
      nodeArbitrates,
      loadPending: (network) => loadPendingEpochs(proofStore, ctx.wallet, network).get(channelId),
      clearPending: (network, epoch) => clearPendingEpoch(proofStore, ctx.wallet, network, channelId, epoch),
      drive: (network, plan) => driveEpoch(ctx, channelId, network, plan),
      apply: (network, plan, res) => applyResult(ctx, channelId, network, plan, res),
      setStatus: (s) => setStatus(ctx, channelId, s),
      log: (s, d) => e2elog(s, { channelId, ...d }),
    },
    makePlan,
  ).finally(() => {
    // Only clear OUR OWN entry — a switch mid-drive can leave a later caller's promise registered.
    if (establishing.get(channelId) === started) establishing.delete(channelId);
  });
  establishing.set(channelId, started);
  return started;
}

/** Plan a rotation to `floor` from the node's highest epoch and our own evidence. */
function rotationPlan(ctx: DeviceCtx, channelId: number, floor: number, mode: CoverModeHint) {
  return async (): Promise<DrivePlan | null> => {
    const scopeHex = toHex(computeChannelScope(channelId));
    const info: KeyCommitmentInfo = await getClient().getKeyCommitment(channelId);
    assertFresh(() => ctxStillFresh(ctx));
    const v = viewFromInfo(info);
    noteNodeView(ctx, channelId, v);
    if (alreadyAt(scopeHex, floor, v.highest)) return null;
    const p = planRotation(floor, info, keys.evidence(scopeHex, v.highest));
    return { ...p, mode, floor };
  };
}

/**
 * The legacy move (a legacy key cannot cover new members): past our
 * AUTHENTICATED evidence and the node's highest epoch — never past the raw
 * cached epoch of an unverified key (`planNextEpoch`). Gated (once per
 * channel per 10 min), the token taken only when the plan really starts.
 */
function legacyMovePlan(ctx: DeviceCtx, channelId: number, mode: CoverModeHint) {
  return (): Promise<DrivePlan | null> => gatedPlan(acctFor(ctx).gate, channelId, () => false, async () => {
    const scopeHex = toHex(computeChannelScope(channelId));
    const info: KeyCommitmentInfo = await getClient().getKeyCommitment(channelId);
    assertFresh(() => ctxStillFresh(ctx));
    const v = viewFromInfo(info);
    noteNodeView(ctx, channelId, v);
    const p = planNextEpoch(info, keys.evidence(scopeHex, v.highest));
    return { ...p, mode, floor: p.epoch };
  });
}

/** We already hold a TRUSTED key at or above `floor`, within reach of the node (`nodeHighest` + 256). */
function alreadyAt(scopeHex: string, floor: number, nodeHighest: number): boolean {
  return keys.alreadyAt(scopeHex, floor, nodeHighest);
}

/**
 * P2d rotation: establish (or adopt) a fresh epoch ≥ `floor`, wrapped to the
 * CURRENT, VERIFIED members only (a removed member is no longer in the member
 * set). Waits until the epoch is FINAL (~2 min; the chat shows "re-keying…").
 *
 * NO-OP unless the channel id is in the private range or this account holds a
 * creator pin for it (id-floor rule): a public-range channel's type is
 * node-served, so a hostile node could otherwise make every member rotate a
 * public encrypted channel at will. Public channels use an effective floor of 0.
 */
export async function rotateChannelKey(channelId: number, floor: number): Promise<void> {
  if (!Number.isSafeInteger(floor) || floor <= 0) return;
  const ctx = await deviceCtx();
  if (!ctx) return;
  try {
    const network = await getClient().getNetwork();
    assertFresh(() => ctxStillFresh(ctx));
    const hasPin = loadPin(proofStore, ctx.wallet, network, channelId) !== undefined;
    if (!rotationAllowed(channelId, hasPin)) {
      e2elog('channel rotate: public-range channel without a pin — ignored (id-floor rule)', { channelId });
      return;
    }
    // After a restart nothing is trusted until our own slot's wrap is re-verified.
    const scope = computeChannelScope(channelId);
    const scopeHex = toHex(scope);
    const nv = await nodeView(ctx, channelId);
    await refreshTrust(ctx, channelId, scope, scopeHex, nv, true);
    if (alreadyAt(scopeHex, floor, nv.highest)) return; // already rotated
    await startDrive(ctx, channelId, rotationPlan(ctx, channelId, floor, 'verify'));
  } catch (e) {
    if (!(e instanceof StaleAccountError)) e2elog('channel rotate failed', { channelId, err: (e as Error)?.message });
  }
}

/**
 * Resume epochs an earlier session left unfinished (persisted epoch number,
 * never the key) for channels the account is still in. Call once the account
 * is ready.
 */
export async function resumePendingEpochKeys(isJoined: (channelId: number) => boolean): Promise<void> {
  const ctx = await deviceCtx();
  if (!ctx) return;
  try {
    const network = await getClient().getNetwork();
    assertFresh(() => ctxStillFresh(ctx));
    for (const channelId of resumeCandidates(loadPendingEpochs(proofStore, ctx.wallet, network), isJoined)) {
      void startDrive(ctx, channelId, async () => null);
    }
  } catch (e) {
    if (!(e instanceof StaleAccountError)) e2elog('channel epoch: resume skipped', { err: (e as Error)?.message });
  }
}

// --- Heal trigger ---------------------------------------------------------------------------

/**
 * A message at MY confirmed epoch my key cannot decrypt: another member
 * confirmed a different key for it (a split the peer check could not see) →
 * rotate past it, at most once per channel per 10 min (per-account gate),
 * only where rotation is allowed (id-floor rule), only for a key whose pair
 * is verified.
 */
async function maybeHeal(ctx: DeviceCtx, channelId: number, epoch: number): Promise<void> {
  try {
    const network = await getClient().getNetwork();
    assertFresh(() => ctxStillFresh(ctx));
    const scope = computeChannelScope(channelId);
    const scopeHex = toHex(scope);
    const hasPin = loadPin(proofStore, ctx.wallet, network, channelId) !== undefined;
    if (!rotationAllowed(channelId, hasPin)) return; // id-floor rule: no probe either
    // After a restart nothing is trusted until our own slot's wrap is re-verified.
    const nv = await nodeView(ctx, channelId);
    await refreshTrust(ctx, channelId, scope, scopeHex, nv, true);
    if (!keys.healEligible(scopeHex, epoch, nv.highest)) return;
    if (!healApplies({
      messageEpoch: epoch, myConfirmedEpoch: keys.finalEvidence(scopeHex, nv.highest), rotationAllowed: rotationAllowed(channelId, hasPin),
    })) return;
    e2elog('channel epoch: undecryptable message at my confirmed epoch → heal rotation', { channelId, epoch });
    // The gate token is taken only when this plan really starts (not when the
    // rotation is already done, not when an in-flight drive is joined).
    const gate = acctFor(ctx).gate;
    await startDrive(ctx, channelId, () => gatedPlan(
      gate, channelId, () => alreadyAt(scopeHex, epoch + 1, nv.highest), rotationPlan(ctx, channelId, epoch + 1, 'verify'),
    ));
  } catch (e) {
    if (!(e instanceof StaleAccountError)) e2elog('channel heal skipped', { channelId, err: (e as Error)?.message });
  }
}

// --- Cover --------------------------------------------------------------------------------

/** Record devices as covered at `${scopeHex}:${epoch}` (merge into the current set). */
function markCovered(scopeHex: string, epoch: number, targets: readonly CoverTarget[]): void {
  const k = `${scopeHex}:${epoch}`;
  const cur = wrappedToDevices.get(k) ?? new Set<string>();
  for (const t of targets) cur.add(coverTargetKey(t));
  wrappedToDevices.set(k, cur);
}

/**
 * The epoch's `(keyTs, keyCommitment)` for a key we hold, VERIFIED: the pair
 * of this very key when it is TRUSTED in the keyring (author-verified +
 * pair-consistent; compared by BYTES — the keyring returns copies) → our own
 * slot's VERIFIED wrap holding this very key (re-put as `wrap`). A vault key's
 * persisted pair is NOT enough any more (the vault records no provenance, so
 * the SDK keyring refuses to trust it without author proof), and a pair the
 * node merely reports is never used (a hostile node can compute one for any
 * key it served us). `legacy`: the node says the epoch predates arbitration;
 * `mismatch`: our verified slot holds ANOTHER key.
 */
async function resolveKeyMeta(
  ctx: DeviceCtx, channelId: number, network: string, epoch: number, key: Uint8Array, hint: boolean | undefined,
): Promise<KeyMeta | 'legacy' | 'mismatch' | 'none'> {
  const scopeHex = toHex(computeChannelScope(channelId));
  const e = keys.entriesAt(scopeHex, epoch).find((x) => sameBytes(x.key, key));
  if (e?.trusted && e.pair) return { keyTs: e.pair.keyTs, keyCommitment: e.pair.commitment };
  const nv = await nodeView(ctx, channelId);
  const w = await ownWrapFetcher(ctx, channelId, network, modeFor(ctx, channelId, network, hint))(epoch);
  if (!ctxStillFresh(ctx)) w?.key.fill(0);
  assertFresh(() => ctxStillFresh(ctx));
  if (w) {
    if (!sameBytes(w.key, key)) {
      w.key.fill(0);
      return 'mismatch';
    }
    const meta = { keyTs: w.keyTs, keyCommitment: w.keyCommitment };
    cacheVerified(ctx, channelId, network, epoch, w.key, meta, { source: 'wrap', author: w.wallet, nodeHighest: nv.highest });
    w.key.fill(0); // the keyring holds its own copy
    return meta;
  }
  const info = await getClient().getKeyCommitment(channelId, epoch);
  assertFresh(() => ctxStillFresh(ctx));
  return commitmentState(info, epoch) === 'legacy' ? 'legacy' : 'none';
}

/**
 * Wrap the current channel key to any member device we haven't covered yet
 * (new joiners), with the epoch's own VERIFIED `(keyTs, keyCommitment)` pair.
 * A key without a pair (a pre-arbitration legacy epoch) cannot cover anyone
 * under the strict policy: the channel moves to a new (arbitrated) epoch
 * instead, at most once per channel per 10 min. A key that is not the
 * epoch's key is the heal case.
 *
 * @param hint channel type: `true` private (verify before cover), `false`
 *   positively public, `undefined` unknown (deferred below the private id
 *   floor; always verified above it). Pass `resolveIsPrivateForCover`.
 * @param opts.immediate a member-change event: bypasses the 10 s / 60 s
 *   throttle, but never runs more than once per 5 s per channel.
 */
export async function coverChannelMembers(
  channelId: number, hint: boolean | undefined, opts: { immediate?: boolean; retry?: boolean } = {},
): Promise<void> {
  const ctx = await deviceCtx();
  if (!ctx) return;
  const privateMode = hint !== false || !isPublicRangeChannelId(channelId);
  if (!coverThrottle.tryStart(channelId, Date.now(), { privateMode, immediate: !!opts.immediate || !!opts.retry })) return;
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);
  const fresh = () => ctxStillFresh(ctx);
  try {
    // The same choice as a send (fetch / re-verify / finality included). With
    // no sendable key, the highest held key within reach is still CLASSIFIED
    // (a legacy epoch moves the channel; a key that is not the epoch's key
    // heals) — but never wrapped to anyone.
    const send = await bestChannelKey(ctx, channelId, scope, scopeHex, hint);
    assertFresh(fresh);
    const held = send ?? keys.latestBounded(scopeHex, (await nodeView(ctx, channelId)).highest);
    assertFresh(fresh);
    if (!held) return; // I don't have the key myself yet
    const entry = { key: held.key, epoch: held.epoch };
    // Only a trusted FINAL key is wrapped to new members (rotations wait for final).
    const wrappable = held.trusted && held.final;
    const done = wrappedToDevices.get(`${scopeHex}:${entry.epoch}`) ?? new Set<string>();
    const res = await getChannelTargets(ctx, channelId, hint, done);
    let retryLater = res.incomplete;
    const missing = res.targets.filter((t) => !done.has(coverTargetKey(t)));
    if (missing.length > 0) {
      const network = await getClient().getNetwork();
      assertFresh(fresh);
      // A failed read (pre-0.143 node, network) is "unknown", not a pass
      // failure: it must not re-open the throttle and hammer the node.
      const meta = await resolveKeyMeta(ctx, channelId, network, entry.epoch, entry.key, hint).catch((e) => {
        if (e instanceof StaleAccountError) throw e;
        return 'none' as const;
      });
      const action = decideCoverAction(meta);
      if (action === 'publish' && !wrappable) {
        // A not-yet-final / provisional / pre-arbitration key: covered once it is final.
        e2elog('channel cover: key not final yet — cover deferred', { channelId, epoch: entry.epoch });
        retryLater = true;
      } else if (action === 'publish' && typeof meta === 'object') {
        const { key, epoch } = entry;
        const acct = acctFor(ctx);
        const out = await coverTargetsAtEpoch(missing, {
          fresh,
          take: () => acct.bucket.take(),
          publish: async (tg) => {
            const et = toEpochTarget(tg);
            if (!et) throw new KeyEnvelopeRejectedError(0, 'bad_target');
            const bytes = await buildChannelEpochKeyEnvelope(ctx.signer!, {
              channelId, epoch, key, keyTs: meta.keyTs, target: et.target, deviceId: et.deviceId, encPub: et.encPub,
            });
            assertFresh(fresh);
            return getClient().publishChannelKeyEnvelope(bytes);
          },
          classify: (e) => e instanceof KeyCommitmentConflictError ? 'conflict'
            : e instanceof KeyEnvelopeRateLimitedError ? 'rate_limited'
              : e instanceof KeyEnvelopeRejectedError ? (e.code === 'key_ts_stale' ? 'stale' : 'rejected')
                : 'transient',
          log: (s, d) => e2elog(s, { channelId, ...d }),
        });
        markCovered(scopeHex, epoch, out.covered);
        e2elog('channel cover: wrapped to new devices', { channelId, count: out.covered.length });
        if (out.stop === 'conflict' || out.stop === 'stale') void maybeHeal(ctx, channelId, epoch);
        if (out.stop === 'rate_limited') retryLater = true; // one delayed retry, never an immediate re-run
      } else if (action === 'new_epoch') {
        e2elog('channel cover: legacy epoch cannot cover new members → new epoch', { channelId, epoch: entry.epoch });
        const mode: CoverModeHint = modeFor(ctx, channelId, network, hint) === 'public' ? 'public' : 'verify';
        void startDrive(ctx, channelId, legacyMovePlan(ctx, channelId, mode));
      } else if (action === 'heal') {
        e2elog('channel cover: our key is not this epoch\'s key', { channelId, epoch: entry.epoch });
        void maybeHeal(ctx, channelId, entry.epoch);
      }
    }
    // One bounded, delayed retry for members that could not be verified /
    // fetched right now (429 / 503 / network) — never a tight loop: the
    // retry itself never schedules another.
    if (retryLater && !opts.retry && !coverRetryTimers.has(channelId)) {
      coverRetryTimers.set(channelId, setTimeout(() => {
        coverRetryTimers.delete(channelId);
        void coverChannelMembers(channelId, hint, { retry: true });
      }, COVER_RETRY_MS));
    }
  } catch (e) {
    // Only the still-active account's failure (or a deferral — the type may be
    // known on the next call) re-opens its throttle; a stale (previous-account)
    // pass must not touch the new account's state.
    coverThrottle.failed(channelId, ctxStillFresh(ctx));
    e2elog('channel cover skipped', { channelId, err: (e as Error)?.message });
  }
}

// --- Send ---------------------------------------------------------------------------------

/** Why a send has no key right now. */
export type ChannelKeyWait = 'waiting' | 'rekeying' | 'node_problem';

/**
 * Ensure a channel key for sending. Returns the key, a {@link ChannelKeyWait}
 * (`waiting`: no key yet and this client may not establish — a non-mod member
 * waits for a mod to seed/cover it; `rekeying`: a rotation / first key is in
 * progress, ~2 min until it is final; `node_problem`: this node cannot
 * establish keys), or `null` if the device isn't ready.
 *
 * Never blocks a send for the ~2 min a rotation takes to become final: the
 * drive runs in the background and the send reports `rekeying`. Only the
 * creator's FIRST key of a brand-new channel (no other member yet) is used
 * as soon as the node takes it (SDK early-use path), within a short wait.
 *
 * Enforces the rotation floor (P2d) where rotation is allowed (id-floor rule):
 * we never send under an epoch below it (a removed member still holds those
 * keys).
 *
 * Returns `ctx.signer` alongside the key — never re-fetch it with
 * `getSigner()`, which could by then belong to a different account. A stale
 * `ctx` at any return point yields `'waiting'`.
 */
export async function ensureChannelKeyForSend(
  channelId: number, canEstablish: boolean, floor: number, hint: boolean | undefined,
): Promise<{ convKey: Uint8Array; epoch: number; signer: NonNullable<DeviceCtx['signer']> } | ChannelKeyWait | null> {
  const ctx = await deviceCtx();
  if (!ctx) return null;
  const fresh = () => ctxStillFresh(ctx);
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);
  let network: string;
  try {
    network = await getClient().getNetwork();
  } catch {
    return 'waiting';
  }
  if (!fresh()) return 'waiting';
  const hasPin = loadPin(proofStore, ctx.wallet, network, channelId) !== undefined;
  const effFloor = effectiveFloor(channelId, floor, hasPin);
  const mode = coverMode(channelId, hint, hasPin);

  let best: ChannelKeyHeld | null;
  try {
    best = await bestChannelKey(ctx, channelId, scope, scopeHex, hint);
  } catch (e) {
    if (e instanceof StaleAccountError) return 'waiting';
    throw e;
  }
  if (!fresh()) return 'waiting';
  if (best && best.epoch >= effFloor) {
    void coverChannelMembers(channelId, hint);
    return { convKey: best.key, epoch: best.epoch, signer: ctx.signer! };
  }
  if (best) {
    // Below the rotation floor (compromised after a removal): rotate in the
    // background — the user sees "re-keying…" instead of a blocked send.
    void rotateChannelKey(channelId, floor);
    return alignWait('rekeying', channelKeyStatus(channelId));
  }

  // No key at all → INITIAL seed (creator/mods in private channels).
  if (!canEstablish) return 'waiting';
  if (mode === 'defer') return 'waiting'; // channel type not known yet
  if (establishing.has(channelId)) return alignWait('rekeying', channelKeyStatus(channelId));
  if (!(await nodeArbitrates())) return 'node_problem';
  if (!fresh()) return 'waiting';
  let info: KeyCommitmentInfo;
  try {
    info = await getClient().getKeyCommitment(channelId);
  } catch {
    return 'waiting';
  }
  if (!fresh()) return 'waiting';
  const nodeHighest = viewFromInfo(info).highest;
  noteNodeView(ctx, channelId, viewFromInfo(info));
  const modeHint: CoverModeHint = mode === 'public' ? 'public' : 'verify';
  if (info.epoch >= 1 && info.state !== 'none') {
    // The channel already has a key on the node, just not for this device:
    // adopt it (the SDK waits for a verified wrap and escalates if it never comes).
    const ep = Math.max(info.epoch, effFloor, 1);
    void startDrive(ctx, channelId, async () => ({ epoch: ep, epochKnownToExist: info.epoch >= effFloor, mode: modeHint, floor: Math.max(effFloor, 1) }));
    return alignWait('rekeying', channelKeyStatus(channelId));
  }
  const epoch = Math.max(1, effFloor);
  if (epoch !== 1 || keys.evidence(scopeHex, nodeHighest) > 0) {
    void startDrive(ctx, channelId, async () => ({ epoch, epochKnownToExist: false, mode: modeHint, floor: epoch }));
    return alignWait('rekeying', channelKeyStatus(channelId));
  }
  // Brand-new channel: the creator's first key may be used before it is final,
  // but only while every target is one of our own devices (no other member).
  const st: { early: boolean; wake: () => void } = { early: false, wake: () => undefined };
  const earlyArrived = new Promise<void>((r) => { st.wake = r; });
  const drive = startDrive(ctx, channelId, async () => ({
    epoch: 1, epochKnownToExist: false, mode: modeHint, floor: 1,
    onEarly: (u) => {
      if (!ctxStillFresh(ctx)) return;
      // Our own not-yet-final first key: held as `provisional` (never evidence,
      // never backed up until final). Used only when it is the ONLY key at
      // epoch 1 — a different key already held there is never shadowed.
      const r = keys.put(scopeHex, 1, u.key, ctx.generation, {
        source: 'establish', provisional: true, verified: true, meta: { keyTs: u.keyTs, keyCommitment: u.keyCommitment },
      });
      if (r === 'stored' && keys.entriesAt(scopeHex, 1).length === 1) st.early = true;
      st.wake();
    },
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    earlyArrived,
    drive.then(() => undefined),
    new Promise<void>((r) => { timer = setTimeout(r, EARLY_KEY_WAIT_MS); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!fresh()) return 'waiting';
  // A trusted FINAL key (the drive finished), or the provisional first key the
  // early path put at epoch 1 as the only key there.
  const now = keys.sendKey(scopeHex, nodeHighest);
  if (now && now.epoch >= 1 && ((now.trusted && now.final) || (st.early && now.provisional))) {
    return { convKey: now.key, epoch: now.epoch, signer: ctx.signer! };
  }
  return alignWait('rekeying', channelKeyStatus(channelId));
}

/** Build a signed, encrypted ChatMessage for an encrypted channel. `floor` is the
 *  channel's `key_epoch_floor` (P2d) — the message is encrypted at ≥ the floor
 *  where rotation applies. `hint` is the channel type for any establish/cover
 *  this triggers (`resolveIsPrivateForCover`: true / false / undefined = unknown). */
export async function buildEncryptedChannelMsg(
  channelId: number, canEstablish: boolean, text: string,
  opts: {
    replyTo?: string; mentions?: string[];
    contentRating?: 'general' | 'teen' | 'mature' | 'explicit';
    attachments?: Array<{ cid: string; mime_type: string; size_bytes: number; filename?: string; thumbnail_cid?: string }>;
    /** P5: encrypted-media descriptors (file bytes sealed before upload). Preferred
     *  over `attachments` for encrypted channels — the file bytes are encrypted too. */
    media?: MediaDescriptor[];
    /**
     * Set when this message IS a button press (protocol §3.3). Forwarded
     * verbatim to the SDK, which stamps it into the PLAINTEXT outer payload
     * (never sealed) — feed-suppression rendering hints work identically to
     * a plaintext channel's messages.
     */
    viaButton?: boolean;
  },
  floor: number,
  hint: boolean | undefined,
): Promise<Uint8Array | ChannelKeyWait> {
  const established = await ensureChannelKeyForSend(channelId, canEstablish, floor, hint);
  if (established === 'waiting' || established === 'rekeying' || established === 'node_problem') return established;
  if (!established) throw new Error('device not ready for encrypted channels');
  return buildEncryptedChannelMessage(established.signer, {
    channelId, convKey: established.convKey, epoch: established.epoch,
    text, replyTo: opts?.replyTo, mentions: opts?.mentions,
    contentRating: opts?.contentRating, attachments: opts?.attachments,
    media: opts?.media && opts.media.length > 0 ? opts.media : undefined,
    viaButton: opts?.viaButton,
  });
}

/** The i18n key for a {@link ChannelKeyWait}. */
export function channelKeyWaitMessage(w: ChannelKeyWait): string {
  return w === 'rekeying' ? 'channel_rekeying' : w === 'node_problem' ? 'channel_key_node_problem' : 'channel_waiting_for_key';
}

// --- Decrypt --------------------------------------------------------------------------------

interface RawChannelPayload {
  content?: unknown;
  enc_content?: unknown;
  enc_nonce?: unknown;
  key_epoch?: number;
}

/**
 * Decrypt a channel message for rendering. v1 plaintext (`content` set, no
 * `enc_content`) returns as-is; v2 fetches the channel key for the message's
 * epoch. A message at MY confirmed epoch that my key (with a verified pair)
 * cannot decrypt fires the (gated) heal trigger.
 */
export async function decryptChannelMessage(
  payload: number[] | Uint8Array | string, channelId: number, hint?: boolean,
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
  if (!Number.isSafeInteger(epoch) || epoch < 0) return { kind: 'error' };

  const ctx = await deviceCtx();
  if (!ctx) return { kind: 'waiting' };
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);
  let held = keys.keysAt(scopeHex, epoch);
  if (held.length === 0) {
    // A fetched key that is not ours is bounded by the node's highest + 256:
    // without a readable highest nothing is fetched. After a restart our own
    // latest epoch is re-verified first (`ownSlot`, never member-capped), so a
    // member's wraps can never crowd it out.
    try {
      const nv = await nodeView(ctx, channelId);
      if (!nv.known) return { kind: 'waiting' };
      await refreshTrust(ctx, channelId, scope, scopeHex, nv, hint);
    } catch {
      return { kind: 'waiting' }; // stale account
    }
    if (!takeMissFetch(`${scopeHex}:${epoch}`)) {
      requestVaultRestore();
      return { kind: 'waiting' };
    }
    const fetched = await fetchChannelKey(ctx, channelId, scope, scopeHex, epoch, hint);
    if (fetched === 'missing') {
      // Pull the wallet-encrypted vault in the background (forward-only joiners
      // won't have old epoch keys on the node); next retry finds the restored key.
      requestVaultRestore();
      return { kind: 'waiting' };
    }
    if (fetched === 'corrupt') return { kind: 'error' };
    // Only what the keyring holds (a key it refused is never used on the side).
    held = keys.keysAt(scopeHex, epoch);
    if (held.length === 0) return { kind: 'waiting' };
  }
  // Primary first, then any alternate key held for this epoch (never-lose rule).
  // `keysAt` returns COPIES: zero them once tried.
  try {
    for (const key of held) {
      try {
        const pt = decryptDmContent(key, scope, epoch, enc, nonce);
        return { kind: 'text', text: pt.text, media: pt.media };
      } catch {
        /* try the next key */
      }
    }
  } finally {
    for (const key of held) key.fill(0);
  }
  // maybeHeal re-checks eligibility (trusted key at the latest trusted epoch).
  if (keys.entriesAt(scopeHex, epoch)[0]?.source !== 'legacy') void maybeHeal(ctx, channelId, epoch);
  return { kind: 'error' };
}
