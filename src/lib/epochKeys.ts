/**
 * Channel key epochs on node-arbitrated nodes (desktop 1.85.0, l2-node
 * 0.143.0 `key_commitment_v1`, `@ogmara/sdk` 0.67.0 `establishEpochKey`).
 *
 * The SDK owns the protocol (one winner per `(channel, epoch)`, verified
 * adoption, escalation, split detection). This module is the desktop's
 * WIRING around it, kept free of Solid/Tauri so it runs under `node --test`
 * (epochKeys.test.ts); `channelCrypto.ts` injects the live client, signer,
 * storage and account guard.
 *
 * Rules implemented here:
 *  - **Per-account state** ({@link EpochAccount}): one `PendingEpochKeyStore`,
 *    `EscalationGate` and `TokenBucket` per (wallet, switch generation),
 *    cleared (pending keys zeroed) on every account switch / sign-out.
 *  - **Resume**: the EPOCH NUMBER being established (never the key) is
 *    persisted per (wallet, network, channel) until a terminal outcome, so a
 *    restart resumes that epoch before moving on (SDK caller contract).
 *  - **Key metadata**: every channel key the client uses to COVER a member at
 *    an existing epoch needs the epoch's `(keyTs, keyCommitment)` pair (strict
 *    policy). It is persisted per (wallet, network) ONLY by verified paths
 *    (verified wrap, own confirmed establish) and re-verified against the key
 *    (`H(scope, epoch, keyTs, key) == C`) before use. A key without it
 *    (vault-restored) gets it only from our own slot's VERIFIED wrap — never
 *    from a pair the node reports.
 *  - **Id-floor rule** ({@link rotationAllowed}): node-event and heal-driven
 *    rotation only for channels in the private id range or with a creator pin
 *    of this account; public-range channels use an effective floor of 0.
 *  - **Outcome mapping** ({@link runEpochKey}): `legacy` / `epochTooLow` /
 *    `escalate` / `split` / `node_lagging` move to the next epoch (bounded
 *    hops, every move gated: the SDK's gate already gated the last three, the
 *    first two take the same per-account gate here), `epochTooHigh` and
 *    `unrecoverableHere` are surfaced, `waiting` / retryable failures keep
 *    the persisted epoch for a later resume.
 *  - **Re-bind backoff** and **revocation filter** for this device's enc key
 *    ({@link rebindAllowed}, {@link revocableEncRows}).
 *
 * Every await is followed by an account re-check (`StaleAccountError`); a
 * switch mid-call publishes nothing further and persists nothing.
 */
import {
  establishEpochKey,
  PendingEpochKeyStore,
  EscalationGate,
  TokenBucket,
  computeChannelScope,
  computeKeyCommitment,
  keyCommitmentFromHex,
  keyCommitmentToHex,
  keyCommitmentsEqual,
  type EstablishEpochKeyDeps,
  type EstablishEpochKeyOutcome,
  type KeyCommitmentInfo,
  type VerifiedChannelKeyWrap,
  type EpochKeyTarget,
  type PublishChannelKeyResult,
  type UnconfirmedEpochKey,
} from '@ogmara/sdk';
import { StaleAccountError, type WalletStore } from './privateCover.ts';
import { isPublicRangeChannelId } from './channelEncryption.ts';

type Log = (step: string, data?: Record<string, unknown>) => void;

// --- Id-floor rule ------------------------------------------------------------------

/**
 * May this client ROTATE the channel's key on a node event (kick floor) or on
 * the heal trigger? Only for a private-range id (`>= 2^32`, never public
 * whatever the node says) or a channel this account holds a creator pin for.
 * A public-range channel is node-classified: a hostile node could otherwise
 * make every member rotate a public encrypted channel at will.
 */
export function rotationAllowed(channelId: number, hasPin: boolean): boolean {
  return !isPublicRangeChannelId(channelId) || hasPin;
}

/** The rotation floor this client honours: the node's floor where rotation is allowed, else 0. */
export function effectiveFloor(channelId: number, floor: number, hasPin: boolean): number {
  if (!rotationAllowed(channelId, hasPin)) return 0;
  return Number.isSafeInteger(floor) && floor > 0 ? floor : 0;
}

// --- Per-account state -------------------------------------------------------------

/** One account's epoch state: never shared across accounts or switch generations. */
export class EpochAccount {
  readonly pending = new PendingEpochKeyStore();
  readonly gate: EscalationGate;
  readonly bucket: TokenBucket;
  readonly wallet: string;
  readonly generation: number;
  constructor(wallet: string, generation: number, now: () => number, sleep: (ms: number) => Promise<void>) {
    this.wallet = wallet;
    this.generation = generation;
    this.gate = new EscalationGate(now);
    this.bucket = new TokenBucket(now, sleep);
  }

  /** Zero every pending key (in-flight ones on release). */
  clear(): void {
    this.pending.clear();
  }
}

/**
 * Holder for the active account's {@link EpochAccount}. A caller whose
 * account is no longer fresh gets a throwaway instance that is never stored
 * (it can publish nothing anyway: its guard throws).
 */
export class EpochAccountHolder {
  private cur: EpochAccount | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(now: () => number, sleep: (ms: number) => Promise<void>) {
    this.now = now;
    this.sleep = sleep;
  }

  get(wallet: string, generation: number, fresh: boolean): EpochAccount {
    if (!fresh) return new EpochAccount(wallet, generation, this.now, this.sleep);
    if (!this.cur || this.cur.wallet !== wallet || this.cur.generation !== generation) {
      this.cur?.clear();
      this.cur = new EpochAccount(wallet, generation, this.now, this.sleep);
    }
    return this.cur;
  }

  /** Account switch / sign-out: zero the pending keys and drop the state. */
  reset(): void {
    this.cur?.clear();
    this.cur = null;
  }
}

// --- Persisted: epoch being established (never the key) ---------------------------

/** How the persisted epoch's targets are resolved on resume. */
export type CoverModeHint = 'verify' | 'public';

export interface PendingEpochRecord {
  epoch: number;
  mode: CoverModeHint;
}

/** Storage base for the epochs being established (per wallet, network). */
export function pendingEpochBase(network: string): string {
  return `ogmara.pchanEpochPending.${network}`;
}

/** Max channels with a persisted pending epoch per (wallet, network); oldest evicted. */
export const MAX_PENDING_EPOCHS = 64;

const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** The persisted pending epochs (`channelId → record`), insertion-ordered (oldest first). */
export function loadPendingEpochs(store: WalletStore, wallet: string, network: string): Map<number, PendingEpochRecord> {
  const out = new Map<number, PendingEpochRecord>();
  const raw = store.get(wallet, pendingEpochBase(network));
  if (!raw || raw.length > 16 * 1024) return out;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return out;
    for (const e of arr) {
      if (!Array.isArray(e) || e.length !== 3) continue;
      const [cid, epoch, mode] = e as unknown[];
      if (isPosInt(cid) && isPosInt(epoch) && (mode === 'verify' || mode === 'public')) {
        out.delete(cid);
        out.set(cid, { epoch, mode });
      }
      if (out.size > MAX_PENDING_EPOCHS) out.delete(out.keys().next().value as number);
    }
  } catch {
    /* corrupt: start empty (a later establish re-records its epoch) */
  }
  return out;
}

function savePendingEpochs(store: WalletStore, wallet: string, network: string, m: Map<number, PendingEpochRecord>): void {
  const arr = [...m.entries()].slice(-MAX_PENDING_EPOCHS).map(([cid, r]) => [cid, r.epoch, r.mode]);
  if (arr.length === 0) store.remove(wallet, pendingEpochBase(network));
  else store.set(wallet, pendingEpochBase(network), JSON.stringify(arr));
}

/** Record (merge INTO the stored map) the epoch now being established for a channel. */
export function setPendingEpoch(
  store: WalletStore, wallet: string, network: string, channelId: number, rec: PendingEpochRecord,
): void {
  const m = loadPendingEpochs(store, wallet, network);
  const prev = m.get(channelId);
  if (prev && prev.epoch === rec.epoch && prev.mode === rec.mode) return;
  m.delete(channelId);
  m.set(channelId, rec);
  while (m.size > MAX_PENDING_EPOCHS) m.delete(m.keys().next().value as number);
  savePendingEpochs(store, wallet, network, m);
}

/** Clear the channel's pending epoch — only when it is still `epoch` (a newer one is kept). */
export function clearPendingEpoch(store: WalletStore, wallet: string, network: string, channelId: number, epoch: number): void {
  const m = loadPendingEpochs(store, wallet, network);
  const prev = m.get(channelId);
  if (!prev || prev.epoch !== epoch) return;
  m.delete(channelId);
  savePendingEpochs(store, wallet, network, m);
}

// --- Persisted: key metadata (keyTs + commitment, never the key) ------------------

/** Storage base for channel key metadata (per wallet, network). */
export function keyMetaBase(network: string): string {
  return `ogmara.pchanKeyMeta.${network}`;
}

/** Max persisted `(channel, epoch)` metadata entries per (wallet, network); least recently written evicted. */
export const MAX_KEY_META = 512;

/** The epoch's arbitration pair for a key we hold. */
export interface KeyMeta {
  keyTs: number;
  keyCommitment: Uint8Array;
}

const metaKey = (channelId: number, epoch: number) => `${channelId}:${epoch}`;

function loadMetaMap(store: WalletStore, wallet: string, network: string): Map<string, [number, string]> {
  const out = new Map<string, [number, string]>();
  const raw = store.get(wallet, keyMetaBase(network));
  if (!raw || raw.length > 128 * 1024) return out;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return out;
    for (const e of arr) {
      if (!Array.isArray(e) || e.length !== 3) continue;
      const [k, ts, c] = e as unknown[];
      if (typeof k === 'string' && /^\d{1,16}:\d{1,16}$/.test(k) && isPosInt(ts) && typeof c === 'string' && /^[0-9a-f]{64}$/.test(c)) {
        out.delete(k);
        out.set(k, [ts, c]);
      }
    }
  } catch {
    /* corrupt: start empty (metadata is re-derivable from the node) */
  }
  return out;
}

/**
 * The persisted pair for `(channel, epoch)`, returned ONLY when it hashes to
 * `key` (`H(scope, epoch, keyTs, key) == C`): tampered or stale storage can
 * never make the client publish a commitment that is not its key's.
 */
export function loadKeyMeta(
  store: WalletStore, wallet: string, network: string, channelId: number, epoch: number, key: Uint8Array,
): KeyMeta | undefined {
  const e = loadMetaMap(store, wallet, network).get(metaKey(channelId, epoch));
  if (!e) return undefined;
  const c = keyCommitmentFromHex(e[1]);
  if (!c) return undefined;
  return metaMatchesKey(channelId, epoch, key, { keyTs: e[0], keyCommitment: c }) ? { keyTs: e[0], keyCommitment: c } : undefined;
}

/** Persist the pair for `(channel, epoch)` (merged INTO the stored map; bounded). */
export function saveKeyMeta(
  store: WalletStore, wallet: string, network: string, channelId: number, epoch: number, meta: KeyMeta,
): void {
  const m = loadMetaMap(store, wallet, network);
  const k = metaKey(channelId, epoch);
  const hex = keyCommitmentToHex(meta.keyCommitment);
  const prev = m.get(k);
  if (prev && prev[0] === meta.keyTs && prev[1] === hex) return;
  m.delete(k);
  m.set(k, [meta.keyTs, hex]);
  while (m.size > MAX_KEY_META) m.delete(m.keys().next().value as string);
  store.set(wallet, keyMetaBase(network), JSON.stringify([...m.entries()].map(([kk, [ts, c]]) => [kk, ts, c])));
}

/** `H(scope, epoch, keyTs, key) == keyCommitment` (and the key is a real 32-byte, non-zero key). */
export function metaMatchesKey(channelId: number, epoch: number, key: Uint8Array, meta: KeyMeta): boolean {
  if (!(key instanceof Uint8Array) || key.length !== 32 || key.every((b) => b === 0)) return false;
  try {
    return keyCommitmentsEqual(computeKeyCommitment(computeChannelScope(channelId), epoch, meta.keyTs, key), meta.keyCommitment);
  } catch {
    return false;
  }
}

/**
 * The node's state for an epoch, for CLASSIFYING a key we hold — never a
 * source of its pair: a hostile node can compute `H(scope, epoch, keyTs, K)`
 * for any key `K` it served us as a commitment-less wrap, so a pair the node
 * reports is never trusted for a key whose pair we have not verified
 * ourselves (own slot's verified wrap / a pair persisted by a verified path).
 * `legacy` = the epoch predates arbitration (no pair exists; covering there
 * is impossible under the strict policy).
 */
export function commitmentState(info: KeyCommitmentInfo, epoch: number): 'legacy' | 'arbitrated' | 'none' {
  if (info.epoch !== epoch) return 'none';
  return info.state === 'legacy' ? 'legacy' : info.state === 'arbitrated' ? 'arbitrated' : 'none';
}

// --- Establish runner ------------------------------------------------------------------

/** Everything {@link runEpochKey} touches, injected (one channel, one captured account). */
export interface EpochIo {
  channelId: number;
  network: string;
  self: EstablishEpochKeyDeps['self'];
  /** True while the captured account (wallet + generation + signer) is still active (`step`: diagnostics). */
  fresh(step?: string): boolean;
  getCommitment(epoch?: number): Promise<KeyCommitmentInfo>;
  fetchOwnWrap(epoch: number): Promise<VerifiedChannelKeyWrap | null>;
  isSelfBound(): Promise<boolean>;
  /**
   * The devices to wrap to. The object form tells the early-use rule what was
   * NOT listed: `incomplete` (members that could not be verified / fetched
   * now) and `rejected` (targets dropped as unusable) — either means "maybe
   * not only us". A plain array is a complete list.
   */
  listTargets(): Promise<EpochKeyTarget[] | { targets: EpochKeyTarget[]; incomplete?: boolean; rejected?: number }>;
  publish(t: EpochKeyTarget, key: Uint8Array, keyTs: number, epoch: number, opts?: { fresh?: boolean }): Promise<PublishChannelKeyResult>;
  /** Other nodes' commitment for the epoch (see {@link queryPeerCommitments}). */
  peerCommitments?(epoch: number): Promise<KeyCommitmentInfo[]>;
  newKey(): Uint8Array;
  /** Local `Date.now` (the clock the envelope builder stamps with). */
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * AUTHENTICATED evidence only: the highest epoch for which this account
   * holds a key from a verified wrap, its own establish, or its own sealed
   * vault — never a raw `key_epoch` from a message.
   */
  highestEpochSeen(): number;
  /**
   * Do we hold ANY key at `epoch` (verified or not)? Makes THAT epoch "known
   * to exist" (a lagging / fresh node cannot make us create a conflicting key
   * there) — a bounded effect, unlike global evidence.
   */
  holdsKeyAt?(epoch: number): boolean;
  log: Log;
  /** SDK tunables override (tests). */
  options?: EstablishEpochKeyDeps['options'];
}

export interface EpochRequest {
  epoch: number;
  /** The epoch is known to exist already (adopting, resuming); false for a rotation into a new one. */
  epochKnownToExist: boolean;
  /** How targets are resolved (persisted with the epoch for a resume). */
  mode: CoverModeHint;
  /**
   * The brand-new-channel early-use path: when set, the FIRST key of epoch 1
   * may be handed out before it is final — only while every target is one of
   * our own devices (the creator is the only member). Never for rotations or
   * for joins by other members.
   */
  onEarly?: (k: UnconfirmedEpochKey) => void;
  /** Max epoch moves (legacy / too-low / escalate / split / lagging) per call (default 3). */
  maxHops?: number;
}

export type EpochKeyResult =
  /** A FINAL key for `epoch` (ours or a verified adopted one). `uncovered`: resume later for the rest. */
  | {
      kind: 'key';
      epoch: number;
      key: Uint8Array;
      keyTs: number;
      keyCommitment: Uint8Array;
      role: 'established' | 'adopted';
      uncovered: number;
    }
  /** Still re-keying (not final / gated / in flight / retryable): the epoch stays persisted for a resume. */
  | { kind: 'rekeying'; epoch: number; reason: string }
  /** Our own enc key is not wallet-bound: re-bind first. */
  | { kind: 'rebind'; epoch: number }
  /** Cannot proceed on this node: surface it (no automatic retry). */
  | { kind: 'blocked'; epoch: number; reason: 'epoch_too_high' | 'node_unrecoverable' | 'unconfirmed_exhausted' | 'failed'; detail?: string };

/**
 * Run the SDK protocol for one channel, following the outcomes that move to
 * another epoch (bounded by `maxHops`). Persists the epoch being established
 * before each call and clears it on a terminal outcome. Throws
 * {@link StaleAccountError} when the account changed (nothing persisted after
 * that point; the SDK publishes nothing further).
 */
export async function runEpochKey(
  io: EpochIo, acct: EpochAccount, store: WalletStore, req: EpochRequest,
): Promise<EpochKeyResult> {
  const { channelId, network } = io;
  const wallet = io.self.wallet;
  const guard = (step: string) => {
    if (!io.fresh(step)) {
      io.log('channel epoch: account changed → abort', { channelId, step });
      throw new StaleAccountError();
    }
  };
  let epoch = req.epoch;
  let known = req.epochKnownToExist;
  const maxHops = req.maxHops ?? 3;
  for (let hop = 0; ; hop++) {
    guard('start');
    // UNIFIED CLIENT GUARD (web / desktop / mobile): never plan an epoch more
    // than NODE_EPOCH_MAX_AHEAD above the node's highest known epoch, whatever
    // the home node would accept. A node-served floor, a hostile wrap's epoch
    // or a recovery epoch that far ahead is refused locally — nothing is
    // published, nothing persisted — so it can never be laundered into
    // verified evidence that every honest node then refuses (key_epoch_too_far).
    let nodeHighest: number;
    try {
      nodeHighest = (await io.getCommitment(undefined)).epoch;
    } catch {
      guard('highest');
      return { kind: 'rekeying', epoch, reason: 'commitment_unavailable' };
    }
    guard('highest');
    if (!epochWithinReach(epoch, nodeHighest)) {
      io.log('channel epoch: plan beyond the node\'s highest + 256 — refused locally', { channelId, epoch, nodeHighest });
      clearPendingEpoch(store, wallet, network, channelId, epoch); // never resumed again
      return { kind: 'blocked', epoch, reason: 'epoch_too_high', detail: 'local_guard' };
    }
    setPendingEpoch(store, wallet, network, channelId, { epoch, mode: req.mode });
    let onlySelf = false; // set by listTargets (called before any key is published)
    const out: EstablishEpochKeyOutcome = await establishEpochKey({
      channelId,
      epoch,
      self: io.self,
      getCommitment: (e) => io.getCommitment(e),
      fetchOwnWrap: (e) => io.fetchOwnWrap(e),
      isSelfBound: () => io.isSelfBound(),
      listTargets: async () => {
        const r = await io.listTargets();
        const ts = Array.isArray(r) ? r : r.targets;
        const unknown = !Array.isArray(r) && (r.incomplete === true || (r.rejected ?? 0) > 0);
        // Early use only when we KNOW every target is ours: an incomplete or
        // empty list, or a dropped target, may hide another member.
        onlySelf = !unknown && ts.length > 0 && ts.every((t) => t.target === wallet);
        return ts;
      },
      publish: (t, key, keyTs, e, opts) => io.publish(t, key, keyTs, e, opts),
      pending: acct.pending,
      newKey: () => io.newKey(),
      now: () => io.now(),
      sleep: (ms) => io.sleep(ms),
      bucket: acct.bucket,
      guard,
      isFatalError: (e) => e instanceof StaleAccountError,
      epochKnownToExist: known || (io.holdsKeyAt?.(epoch) ?? false),
      highestEpochSeen: io.highestEpochSeen(),
      peerCommitments: io.peerCommitments ? (e) => io.peerCommitments!(e) : undefined,
      escalationGate: acct.gate,
      log: io.log,
      // Early use only for the creator's FIRST key of a brand-new channel.
      onUnconfirmed: req.onEarly
        ? (u) => {
            if (u.role === 'established' && u.epoch === 1 && onlySelf && io.fresh()) req.onEarly!(u);
            else u.key.fill(0);
          }
        : undefined,
      options: { confirmMode: 'final', ...(io.options ?? {}) },
    });
    guard('outcome');
    const done = () => clearPendingEpoch(store, wallet, network, channelId, epoch);
    /** Move to `to`; `gate`: take the per-account gate first (moves the SDK did not gate itself). */
    let gated = false;
    const next = (to: number, why: string, gate = false): boolean => {
      if (hop + 1 >= maxHops || !Number.isSafeInteger(to) || to <= epoch) {
        done();
        io.log('channel epoch: hop cap reached', { channelId, epoch, why });
        return false;
      }
      if (gate && !acct.gate.tryEscalate(channelId)) {
        // Keep the epoch persisted: a later drive retries it once the gate opens.
        io.log('channel epoch: move gated', { channelId, epoch, why });
        gated = true;
        return false;
      }
      done();
      io.log('channel epoch: moving to another epoch', { channelId, from: epoch, to, why });
      epoch = to;
      known = false;
      return true;
    };
    switch (out.kind) {
      case 'established':
      case 'adopted': {
        if (!out.confirmed) return { kind: 'rekeying', epoch, reason: 'not_final' };
        const uncovered = out.kind === 'established' ? out.uncovered.length : 0;
        // Uncovered targets: keep the epoch persisted so a later pass resumes them.
        if (uncovered === 0) done();
        return {
          kind: 'key', epoch, key: out.key, keyTs: out.keyTs, keyCommitment: out.keyCommitment,
          role: out.kind, uncovered,
        };
      }
      case 'legacy':
        if (next(epoch + 1, 'legacy', true)) continue;
        return { kind: 'rekeying', epoch, reason: gated ? 'escalation_gated' : 'hop_cap' };
      case 'needs_binding':
        return { kind: 'rebind', epoch };
      case 'escalate':
        if (next(epoch + 1, 'escalate')) continue;
        return { kind: 'rekeying', epoch, reason: 'hop_cap' };
      case 'split':
        if (next(epoch + 1, 'split')) continue;
        return { kind: 'rekeying', epoch, reason: 'hop_cap' };
      case 'node_lagging':
        if (out.unrecoverableHere) {
          done();
          return { kind: 'blocked', epoch, reason: 'node_unrecoverable' };
        }
        if (next(out.recoveryEpoch, 'node_lagging')) continue;
        return { kind: 'rekeying', epoch, reason: 'hop_cap' };
      case 'unconfirmed_exhausted':
        done();
        return { kind: 'blocked', epoch, reason: 'unconfirmed_exhausted', detail: out.lastReason };
      case 'waiting':
        return { kind: 'rekeying', epoch, reason: out.reason };
      case 'failed':
        if (out.epochTooHigh) {
          done();
          return { kind: 'blocked', epoch, reason: 'epoch_too_high' };
        }
        if (out.epochTooLow) {
          if (next(epoch + 1, 'epoch_too_low', true)) continue;
          return { kind: 'rekeying', epoch, reason: gated ? 'escalation_gated' : 'hop_cap' };
        }
        if (out.retryable) return { kind: 'rekeying', epoch, reason: out.reason };
        done();
        return { kind: 'blocked', epoch, reason: 'failed', detail: out.reason };
    }
  }
}

/** Mirror of the SDK's `NODE_EPOCH_MAX_AHEAD`: a node accepts a new epoch at most this far above its highest. */
export const NODE_EPOCH_MAX_AHEAD = 256;

/** The unified client guard: `epoch <= nodeHighest + 256` (an unreadable highest counts as 0). */
export function epochWithinReach(epoch: number, nodeHighest: number): boolean {
  const nh = Number.isSafeInteger(nodeHighest) && nodeHighest >= 0 ? nodeHighest : 0;
  return Number.isSafeInteger(epoch) && epoch >= 1 && epoch <= nh + NODE_EPOCH_MAX_AHEAD;
}

/**
 * The epoch a LEGACY move goes to (a legacy key cannot cover new members):
 * past everything AUTHENTICATED (`evidence`) and the node's highest epoch —
 * never past a raw / unverified cached epoch (a hostile node's
 * commitment-less wrap at epoch 100000 must not set the next epoch).
 */
export function planNextEpoch(nodeHighest: KeyCommitmentInfo, evidence: number): { epoch: number; epochKnownToExist: boolean } {
  const nh = Number.isSafeInteger(nodeHighest.epoch) && nodeHighest.epoch >= 0 ? nodeHighest.epoch : 0;
  const ev = Number.isSafeInteger(evidence) && evidence >= 0 ? evidence : 0;
  return { epoch: Math.max(nh, ev) + 1, epochKnownToExist: false };
}

/**
 * Which epoch a rotation to `floor` should establish (or adopt): the node's
 * highest epoch when it is already at/above the floor and has state (someone
 * rotated — adopt it), else the next epoch past everything known.
 */
export function planRotation(
  floor: number, nodeHighest: KeyCommitmentInfo, localHighest: number,
): { epoch: number; epochKnownToExist: boolean } {
  const nh = Number.isSafeInteger(nodeHighest.epoch) && nodeHighest.epoch >= 0 ? nodeHighest.epoch : 0;
  if (nh >= floor && nh >= 1 && nodeHighest.state !== 'none') return { epoch: nh, epochKnownToExist: true };
  return { epoch: Math.max(floor, nh + 1, localHighest + 1, 1), epochKnownToExist: false };
}

// --- Cover new members at an existing epoch -------------------------------------------

/** Why a cover pass stopped early. */
export type CoverStop = 'conflict' | 'stale' | 'rate_limited';

/**
 * Wrap the epoch's key to `targets` with the SAME `(keyTs, keyCommitment)`
 * pair the epoch was established with (`publish` builds it with
 * `buildChannelEpochKeyEnvelope`). Re-checks the account before every
 * publish (`StaleAccountError`), takes one shared token per publish.
 * `conflict` (409: the node's winner is another key) and `stale`
 * (`key_ts_stale`: our pair is not the winner on this node) stop the pass —
 * our key is not this epoch's key there; `rate_limited` stops it for a later
 * pass; any other rejection or transient failure skips that target (it is not
 * marked covered, so a later pass retries it).
 */
export async function coverTargetsAtEpoch<T>(
  targets: readonly T[],
  deps: {
    fresh(): boolean;
    take(): Promise<void>;
    publish(target: T): Promise<PublishChannelKeyResult>;
    classify(e: unknown): 'conflict' | 'stale' | 'rate_limited' | 'rejected' | 'transient';
    log: Log;
  },
): Promise<{ covered: T[]; stop?: CoverStop }> {
  const covered: T[] = [];
  for (const t of targets) {
    if (!deps.fresh()) throw new StaleAccountError();
    await deps.take();
    if (!deps.fresh()) throw new StaleAccountError();
    try {
      await deps.publish(t);
    } catch (e) {
      if (e instanceof StaleAccountError) throw e;
      if (!deps.fresh()) throw new StaleAccountError();
      const k = deps.classify(e);
      if (k === 'conflict' || k === 'stale' || k === 'rate_limited') {
        deps.log('channel cover: stopped', { reason: k, covered: covered.length });
        return { covered, stop: k };
      }
      deps.log('channel cover: target skipped', { reason: k });
      continue;
    }
    if (!deps.fresh()) throw new StaleAccountError();
    covered.push(t);
  }
  return { covered };
}

// --- Heal trigger --------------------------------------------------------------------

/**
 * The SDK heal trigger: a channel message at MY confirmed epoch that my key
 * cannot decrypt means another member confirmed a different key (a split the
 * peer check could not see) → rotate. Only where rotation is allowed (id-floor
 * rule) and only through the per-account gate (anyone can send garbage
 * ciphertext; the gate — once per channel per 10 min — is the rate limit).
 */
export function healTrigger(args: {
  channelId: number;
  messageEpoch: number;
  /** Highest epoch we hold an AUTHENTICATED key for. */
  myConfirmedEpoch: number;
  rotationAllowed: boolean;
  gate: EscalationGate;
}): boolean {
  if (!healApplies(args)) return false;
  return args.gate.tryEscalate(args.channelId);
}

/**
 * The heal conditions WITHOUT taking the gate (the caller takes the gate
 * token only once its plan really starts — see `gatedPlan`, epochDriver.ts).
 */
export function healApplies(args: { messageEpoch: number; myConfirmedEpoch: number; rotationAllowed: boolean }): boolean {
  if (!args.rotationAllowed) return false;
  return args.myConfirmedEpoch >= 1 && args.messageEpoch === args.myConfirmedEpoch;
}

// --- Own-device re-bind backoff --------------------------------------------------------

/** Storage base for this device's re-bind backoff (per wallet). */
export const REBIND_BACKOFF_BASE = 'ogmara.encRebindBackoff';
/** Backoff after the 1st, 2nd and 3rd+ re-bind attempt. */
export const REBIND_BACKOFF_MS = [3_600_000, 4 * 3_600_000, 24 * 3_600_000] as const;
/** Backoff after a 429 (the node's DeviceEnc limit is 10/h per wallet). */
export const REBIND_429_BACKOFF_MS = 3_600_000;

interface RebindState {
  id: string;
  attempts: number;
  nextAt: number;
}

const rebindId = (deviceId: string, encPub: string) => `${deviceId.toLowerCase()}:${encPub.toLowerCase()}`;

function loadRebind(store: WalletStore, wallet: string): RebindState | null {
  try {
    const v = JSON.parse(store.get(wallet, REBIND_BACKOFF_BASE) ?? 'null') as unknown;
    if (!v || typeof v !== 'object') return null;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== 'string' || !isPosInt(r.attempts) || typeof r.nextAt !== 'number' || !Number.isFinite(r.nextAt)) return null;
    return { id: r.id, attempts: r.attempts, nextAt: r.nextAt };
  } catch {
    return null;
  }
}

/** Parse `x.y.z` (leading digits of each part). */
function semver(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Does the node keep enc-key binding signatures (l2-node 0.142.0+)? Older
 * nodes serve every row `bound: false`, so re-binding there could never
 * succeed — it would only burn the DeviceEnc budget (10/h per wallet).
 * Unknown version → false (fail closed: no re-bind).
 */
export function nodeKeepsBindings(health: { version?: unknown; features?: unknown } | null | undefined): boolean {
  if (!health) return false;
  if (Array.isArray(health.features) && health.features.includes('key_commitment_v1')) return true;
  const v = semver(health.version);
  if (!v) return false;
  return v[0] > 0 || v[1] >= 142;
}

/**
 * May this device re-publish the binding of an enc key the node serves
 * `unbound` now? Never on a node that does not keep bindings; otherwise at
 * most once per backoff window per (wallet, device, enc_pub).
 */
export function rebindAllowed(
  store: WalletStore, wallet: string, deviceId: string, encPub: string, now: number, nodeKeeps: boolean,
): boolean {
  if (!nodeKeeps) return false;
  const st = loadRebind(store, wallet);
  if (!st || st.id !== rebindId(deviceId, encPub)) return true;
  return now >= st.nextAt;
}

/** Record a re-bind attempt (`rateLimited`: the node answered 429). */
export function noteRebindAttempt(
  store: WalletStore, wallet: string, deviceId: string, encPub: string, now: number, rateLimited: boolean,
): void {
  const id = rebindId(deviceId, encPub);
  const st = loadRebind(store, wallet);
  const prev = st && st.id === id ? st.attempts : 0;
  // A 429 is not another attempt (the attempt was already recorded): it only
  // pushes the next one out by an hour.
  const attempts = rateLimited ? Math.max(1, prev) : prev + 1;
  const wait = rateLimited ? REBIND_429_BACKOFF_MS : REBIND_BACKOFF_MS[Math.min(attempts, REBIND_BACKOFF_MS.length) - 1]!;
  store.set(wallet, REBIND_BACKOFF_BASE, JSON.stringify({ id, attempts, nextAt: now + wait }));
}

/** The binding verified: forget the backoff. */
export function clearRebindBackoff(store: WalletStore, wallet: string): void {
  store.remove(wallet, REBIND_BACKOFF_BASE);
}

// --- Stale enc-key revocation filter -------------------------------------------------------

/** An enc-key directory row (`GET /users/{address}/enc-keys`). */
export interface EncRow {
  device_id: string;
  enc_pub: string;
  revoked?: boolean;
  bound?: boolean;
  ts?: number;
  wallet_signature?: string;
  created_at?: number;
}

/**
 * The rows this device may revoke: same `device_id` as OURS, a different
 * `enc_pub`, and a wallet binding that VERIFIES for our device id (the
 * signed claim names the device). A node can serve any row it likes; an
 * unverifiable one is never revoked, so a hostile node cannot make us revoke
 * another device's key (or a row it minted).
 */
export async function revocableEncRows<R extends EncRow>(
  rows: readonly R[],
  wallet: string,
  deviceId: string,
  currentEncPub: string,
  network: string,
  verify: (row: R, wallet: string, network: string) => Promise<{ status: string }>,
): Promise<R[]> {
  const did = deviceId.toLowerCase();
  const cur = currentEncPub.toLowerCase();
  const out: R[] = [];
  for (const r of rows) {
    if (!r || r.revoked === true) continue;
    if ((r.device_id ?? '').toLowerCase() !== did || (r.enc_pub ?? '').toLowerCase() === cur) continue;
    let ok = false;
    try {
      ok = (await verify(r, wallet, network)).status === 'bound';
    } catch {
      ok = false;
    }
    if (ok) out.push(r);
  }
  return out;
}

