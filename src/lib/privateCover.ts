/**
 * Private-channel "verify before cover" (desktop 1.85.0; protocol §3.9.2,
 * spec 05 §8.4 item 5). Epoch-key establishment is the SDK's
 * `establishEpochKey` (node-arbitrated epochs), wired in `epochKeys.ts`.
 *
 * Before this client wraps a PRIVATE channel's epoch key to the other members
 * it no longer trusts its node's member list: every member is run through the
 * SDK's `filterVerifiedMembers` (raw signed membership evidence re-verified
 * locally) and only the verified ones are covered; every enc key must carry a
 * verified wallet binding. Everything here fails CLOSED — an unverifiable
 * member / key is simply not covered and stays in the existing "waiting for
 * key" state until a later pass verifies it. There is never a fallback to the
 * unverified list.
 *
 * This module holds no SDK import and no module-level state so the rules —
 * including the whole target pipeline ({@link resolveCoverTargets}) — are tested by
 * behaviour under `node --test` (privateCover.test.ts); `channelCrypto.ts`
 * injects the client, the SDK verifiers, storage and the freshness check.
 *
 * Account-switch invariants (see project memory: desktop cross-account key
 * leak, 2026-09-04). The caller captures its `DeviceCtx` (wallet + switch
 * generation + signer) FIRST; `fresh()` re-checks it. Every await here is
 * followed by a re-check that throws {@link StaleAccountError}; persisted
 * state is only written under the CAPTURED wallet's own key and only while
 * still fresh. A switch mid-verification therefore persists nothing and lets
 * the caller sign / publish nothing.
 */
import { isPublicRangeChannelId } from './channelEncryption.ts';

/** Thrown when the account changed while a cover/establish was in flight. */
export class StaleAccountError extends Error {
  constructor() {
    super('account changed during the operation');
    this.name = 'StaleAccountError';
  }
}

/** Thrown when the channel type is not known yet: cover is deferred, not guessed. */
export class CoverDeferredError extends Error {
  constructor() {
    super('channel type unknown: cover deferred');
    this.name = 'CoverDeferredError';
  }
}

/** Throw {@link StaleAccountError} unless the captured account is still active. */
export function assertFresh(fresh: () => boolean): void {
  if (!fresh()) throw new StaleAccountError();
}

type Log = (step: string, data?: Record<string, unknown>) => void;

// --- Per-wallet persisted state -------------------------------------------------

/**
 * Wallet-addressed key/value store. The wallet is ALWAYS explicit (the
 * captured one) — never the active scope, which can already have flipped to
 * the next account while a verification was still running for the previous.
 * Production: `walletScope.ts`'s `scopedGetFor`/`scopedSetFor`/
 * `scopedRemoveFor`, i.e. `<base>::<wallet>` keys, which `wipeWalletScope()`
 * also removes on disconnect. Namespaced per account — one account's pin or
 * removals are never applied under another.
 */
export interface WalletStore {
  get(wallet: string, base: string): string | null;
  set(wallet: string, base: string, value: string): void;
  remove(wallet: string, base: string): void;
}

/** Storage base for the pinned creator of one channel (per wallet). */
export function pinBase(network: string, channelId: number): string {
  return `ogmara.pchanPin.${network}.${channelId}`;
}

/** Storage base for the seen-removals map of one channel (per wallet). */
export function removalsBase(network: string, channelId: number): string {
  return `ogmara.pchanRemovals.${network}.${channelId}`;
}

/** Storage base for the LRU list of channels holding seen removals (per wallet, network). */
export function removalsLruBase(network: string): string {
  return `ogmara.pchanRemovalsLru.${network}`;
}

/** Max seen removals kept per channel (newest win). */
export const MAX_SEEN_REMOVALS_PER_CHANNEL = 256;
/** Max serialized bytes of one channel's seen removals. */
export const MAX_SEEN_REMOVALS_BYTES = 24 * 1024;
/** Max channels per (wallet, network) holding seen removals; least recently updated evicted. */
export const MAX_SEEN_REMOVALS_CHANNELS = 200;

const isWallet = (v: unknown): v is string =>
  typeof v === 'string' && /^klv1[0-9a-z]{6,124}$/.test(v);

/** The persisted creator pin, or undefined (absent or unreadable). */
export function loadPin(store: WalletStore, wallet: string, network: string, channelId: number): string | undefined {
  const raw = store.get(wallet, pinBase(network, channelId));
  return isWallet(raw) ? raw : undefined;
}

/**
 * Pin `creator` for the channel unless a pin already exists (first success
 * wins; an existing pin is never overwritten — it always wins over anything a
 * node serves). Returns whether it wrote.
 */
export function savePinIfAbsent(
  store: WalletStore, wallet: string, network: string, channelId: number, creator: string,
): boolean {
  if (!isWallet(creator)) return false;
  if (loadPin(store, wallet, network, channelId) !== undefined) return false;
  store.set(wallet, pinBase(network, channelId), creator);
  return true;
}

/** The persisted seen-removals map (`wallet → newest verified removal ts`). */
export function loadSeenRemovals(
  store: WalletStore, wallet: string, network: string, channelId: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const raw = store.get(wallet, removalsBase(network, channelId));
  if (!raw || raw.length > MAX_SEEN_REMOVALS_BYTES * 2) return out;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const [w, ts] of Object.entries(obj as Record<string, unknown>)) {
      if (isWallet(w) && typeof ts === 'number' && Number.isSafeInteger(ts) && ts >= 0) out.set(w, ts);
    }
  } catch {
    /* corrupt entry: start empty (the next verified removal re-populates it) */
  }
  return out;
}

function touchRemovalsLru(store: WalletStore, wallet: string, network: string, channelId: number): void {
  let list: number[] = [];
  try {
    const raw = store.get(wallet, removalsLruBase(network));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) list = parsed.filter((x): x is number => Number.isSafeInteger(x) && x > 0);
  } catch {
    list = [];
  }
  list = [channelId, ...list.filter((c) => c !== channelId)];
  while (list.length > MAX_SEEN_REMOVALS_CHANNELS) {
    const evicted = list.pop()!;
    store.remove(wallet, removalsBase(network, evicted));
  }
  store.set(wallet, removalsLruBase(network), JSON.stringify(list));
}

/**
 * Merge `seen` INTO what is persisted (max per wallet) — never write a
 * partial in-memory view back over the stored map. Bounded per channel
 * ({@link MAX_SEEN_REMOVALS_PER_CHANNEL} newest, {@link MAX_SEEN_REMOVALS_BYTES})
 * and per wallet ({@link MAX_SEEN_REMOVALS_CHANNELS} channels, LRU).
 */
export function saveSeenRemovals(
  store: WalletStore, wallet: string, network: string, channelId: number, seen: ReadonlyMap<string, number>,
): void {
  const merged = loadSeenRemovals(store, wallet, network, channelId);
  let changed = false;
  for (const [w, ts] of seen) {
    if (!isWallet(w) || typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts < 0) continue;
    const prev = merged.get(w);
    if (prev === undefined || ts > prev) {
      merged.set(w, ts);
      changed = true;
    }
  }
  if (!changed) return;
  const entries = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEN_REMOVALS_PER_CHANNEL);
  let json = JSON.stringify(Object.fromEntries(entries));
  while (json.length > MAX_SEEN_REMOVALS_BYTES && entries.length > 0) {
    entries.pop();
    json = JSON.stringify(Object.fromEntries(entries));
  }
  store.set(wallet, removalsBase(network, channelId), json);
  touchRemovalsLru(store, wallet, network, channelId);
}

// --- Member verification ------------------------------------------------------

/** The subset of the SDK's `FilterVerifiedMembersOptions` this client passes. */
export interface VerifyOptions {
  network: string;
  pinnedCreator?: string;
  allowUnderivedCreator: boolean;
  activationMs: number;
  seenRemovals: Map<string, number>;
}

/** The subset of the SDK's `FilterVerifiedMembersResult` this client reads. */
export interface VerifyResult {
  verified: string[];
  rejected: { wallet: string; reason: string }[];
  creator?: string;
  creatorSource?: string;
  incomplete: boolean;
}

export interface SelectDeps {
  /** `filterVerifiedMembers(client, channelId, wallets, cache, opts)`, partially applied. */
  verify(wallets: string[], opts: VerifyOptions): Promise<VerifyResult>;
  store: WalletStore;
  /** True while the captured account (wallet + switch generation + signer) is still active. */
  fresh(): boolean;
  /** Diagnostic sink (`e2elog`) — counts and reasons only, never addresses. */
  log: Log;
}

export interface SelectArgs {
  /** The CAPTURED wallet (the caller's own account). Always covered. */
  self: string;
  network: string;
  channelId: number;
  /** Wallets to verify (UNTRUSTED node member list, or a subset of it). */
  members: readonly string[];
  /** Legacy-join activation for `network` (SDK `legacyJoinActivationMs`). */
  activationMs: number;
}

/** Reason histogram — the exportable e2e trace never carries member addresses. */
function reasonCounts(rejected: readonly { reason: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rejected) {
    const k = String(r.reason).slice(0, 64);
    if (Object.keys(out).length >= 16 && !(k in out)) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * The wallets this client may wrap a private channel's key to: the caller's
 * own wallet (always — its other devices need the key, and it needs no proof
 * to itself) plus every OTHER listed member that `verify` accepts.
 *
 * - The persisted creator pin is passed as `pinnedCreator`; ONLY when no pin
 *   was passed is the returned `creator` pinned (whatever its source). A
 *   result naming a different creator than an existing pin is ignored.
 * - `allowUnderivedCreator` is always false: this client does not keep its own
 *   `ChannelCreate` envelopes, so it can never prove it knew a channel before
 *   l2-node 0.139 (spec 05 §8.4 item 5 — "never because a node served one").
 * - `seenRemovals` is loaded, updated in place by the verifier, and merged
 *   back into the persisted map.
 * - A thrown verifier fails closed: self only, `incomplete`.
 * - Throws {@link StaleAccountError} if the account changed during the
 *   verification; nothing is persisted in that case.
 */
export async function selectVerifiedWallets(
  deps: SelectDeps, args: SelectArgs,
): Promise<{ wallets: string[]; incomplete: boolean }> {
  const { self, network, channelId } = args;
  assertFresh(deps.fresh);
  const others: string[] = [];
  const seen = new Set<string>([self]);
  for (const m of args.members) {
    if (typeof m !== 'string' || seen.has(m)) continue;
    seen.add(m);
    others.push(m);
  }
  if (others.length === 0) return { wallets: [self], incomplete: false };

  const pinnedCreator = loadPin(deps.store, self, network, channelId);
  const seenRemovals = loadSeenRemovals(deps.store, self, network, channelId);
  let res: VerifyResult;
  try {
    res = await deps.verify(others, {
      network,
      pinnedCreator,
      allowUnderivedCreator: false,
      activationMs: args.activationMs,
      seenRemovals,
    });
  } catch (e) {
    assertFresh(deps.fresh);
    deps.log('channel verify: verifier threw → fail closed (self only)', {
      channelId, err: (e as Error)?.message,
    });
    return { wallets: [self], incomplete: true };
  }
  // The verification awaited network round trips: re-check BEFORE persisting
  // anything or handing back a member set the caller would wrap/sign for.
  assertFresh(deps.fresh);

  if (pinnedCreator === undefined) {
    if (res.creator !== undefined && savePinIfAbsent(deps.store, self, network, channelId, res.creator)) {
      deps.log('channel verify: pinned creator', { channelId, source: res.creatorSource });
    }
  } else if (res.creator !== undefined && res.creator !== pinnedCreator) {
    deps.log('channel verify: result creator differs from the pin — pin kept', { channelId });
  }
  saveSeenRemovals(deps.store, self, network, channelId, seenRemovals);

  const verified = new Set(Array.isArray(res.verified) ? res.verified : []);
  // Only wallets we actually ASKED about can come back verified.
  const accepted = others.filter((w) => verified.has(w));
  const rejected = others.length - accepted.length;
  if (rejected > 0 || res.incomplete) {
    deps.log('channel verify: members NOT covered (fail closed, waiting for key)', {
      channelId,
      verified: accepted.length,
      rejected,
      incomplete: res.incomplete,
      reasons: reasonCounts(res.rejected ?? []),
    });
  } else {
    deps.log('channel verify: all members verified', { channelId, verified: accepted.length });
  }
  return { wallets: [self, ...accepted], incomplete: res.incomplete === true };
}

// --- Enc-key binding ------------------------------------------------------------

/** A device enc-key row as served by `GET /users/{address}/enc-keys`. */
export interface EncKeyRow {
  device_id: string;
  enc_pub: string;
  created_at: number;
  ts?: number;
  revoked?: boolean;
  bound?: boolean;
  wallet_signature?: string;
}

export type BindingVerdict = { status: 'bound' } | { status: 'unbound' } | { status: 'invalid'; reason: string };
export type BindingVerifier = (row: EncKeyRow, wallet: string, network: string) => Promise<BindingVerdict>;

/**
 * Keep ONLY the enc keys whose wallet binding verified (`bound`). `unbound`
 * rows (no signature — a node can mint one for any wallet, including the
 * caller's own) and `invalid` rows are refused for private channels; a thrown
 * verifier drops the key (fail closed). Logs counts only.
 */
export async function filterBoundEncKeys(
  keys: readonly EncKeyRow[],
  wallet: string,
  network: string,
  verify: BindingVerifier,
): Promise<{ bound: EncKeyRow[]; unbound: number; invalid: number }> {
  const bound: EncKeyRow[] = [];
  let unbound = 0;
  let invalid = 0;
  for (const k of keys) {
    let v: BindingVerdict;
    try {
      v = await verify(k, wallet, network);
    } catch {
      v = { status: 'invalid', reason: 'verifier_threw' };
    }
    if (v.status === 'bound') bound.push(k);
    else if (v.status === 'unbound') unbound++;
    else invalid++;
  }
  return { bound, unbound, invalid };
}

// --- Target pipeline ------------------------------------------------------------

/** One device a channel key is wrapped to. */
export interface CoverTarget {
  target: string;
  deviceId: string;
  encPub: string;
  /** Dedupe order: the SIGNED binding `ts` for verified rows, node `created_at` for public rows. */
  createdAt: number;
}

export const coverTargetKey = (t: { target: string; deviceId: string }): string => `${t.target}:${t.deviceId}`;

/**
 * How a channel is covered:
 *  - `verify` — private-range id (always), a channel this account holds a
 *    creator pin for (sticky: a node can't switch verification off by
 *    reporting it public), or a hint of `true`;
 *  - `public` — public-range id with a positive `false` hint;
 *  - `defer`  — public-range id whose type is not known yet.
 */
export function coverMode(channelId: number, hint: boolean | undefined, hasPin: boolean): 'verify' | 'public' | 'defer' {
  if (!isPublicRangeChannelId(channelId)) return 'verify';
  if (hasPin || hint === true) return 'verify';
  if (hint === false) return 'public';
  return 'defer';
}

export interface TargetDeps {
  /** One page of the node's member list (UNTRUSTED). */
  getMembers(channelId: number, page: number, limit: number): Promise<{ address: string }[]>;
  getNetwork(): Promise<string>;
  getEncKeys(wallet: string): Promise<EncKeyRow[]>;
  /** Serialized `filterVerifiedMembers` with the per-account proof cache. */
  verifyMembers(wallets: string[], opts: VerifyOptions): Promise<VerifyResult>;
  verifyBinding: BindingVerifier;
  activationMs(network: string): number;
  store: WalletStore;
  fresh(): boolean;
  log: Log;
}

export interface TargetArgs {
  /** The CAPTURED wallet. */
  self: string;
  channelId: number;
  /** `true` private, `false` positively public, `undefined` unknown (see {@link coverMode}). */
  hint: boolean | undefined;
  /** Devices already wrapped to at the current epoch: their wallets need no re-verification. */
  covered?: ReadonlySet<string>;
}

export interface TargetsResult {
  targets: CoverTarget[];
  mode: 'verify' | 'public';
  /** Some wallets could not be verified / fetched right now — worth one later retry. */
  incomplete: boolean;
}

const MEMBER_PAGE = 200;
const MEMBER_PAGE_CAP = 50;

/**
 * The devices a channel key may be wrapped to, one per `(member, device)`.
 *
 * `verify` mode: members (any page) + the caller's own wallet → enc keys →
 * the wallets with at least one device NOT yet in `covered` are verified with
 * {@link selectVerifiedWallets} (self needs no proof) → only `bound` keys of
 * verified wallets are kept → per device the newest SIGNED `ts` wins. Nothing
 * reaches a wrap before verification. `public` mode is unchanged (node list,
 * newest `created_at`). `defer` throws {@link CoverDeferredError}.
 *
 * Re-checks `fresh()` after every await (throws {@link StaleAccountError}).
 */
export async function resolveCoverTargets(deps: TargetDeps, args: TargetArgs): Promise<TargetsResult> {
  const { self, channelId } = args;
  const fresh = deps.fresh;
  assertFresh(fresh);
  const network = await deps.getNetwork();
  assertFresh(fresh);
  const hasPin = loadPin(deps.store, self, network, channelId) !== undefined;
  const mode = coverMode(channelId, args.hint, hasPin);
  if (mode === 'defer') {
    deps.log('channel targets: type unknown — cover deferred', { channelId });
    throw new CoverDeferredError();
  }
  if (mode === 'verify' && args.hint !== true) {
    deps.log('channel targets: verifying despite a non-private hint (id range / pin)', { channelId, hasPin });
  }

  // Page through the full member set — a member we miss never gets the key.
  const listed: string[] = [];
  for (let page = 1; page <= MEMBER_PAGE_CAP; page++) {
    const members = await deps.getMembers(channelId, page, MEMBER_PAGE);
    assertFresh(fresh);
    for (const m of members) if (typeof m?.address === 'string') listed.push(m.address);
    if (members.length < MEMBER_PAGE) break;
    if (page === MEMBER_PAGE_CAP) deps.log('channel targets: member pagination cap hit (>10k)', { channelId });
  }

  const wallets = [...new Set(mode === 'verify' ? [self, ...listed] : listed)];
  const rowsByWallet = new Map<string, EncKeyRow[]>();
  let incomplete = false;
  for (const w of wallets) {
    let rows: EncKeyRow[];
    try {
      rows = await deps.getEncKeys(w);
    } catch {
      assertFresh(fresh);
      incomplete = true; // covered on a later pass
      continue;
    }
    assertFresh(fresh);
    rowsByWallet.set(w, Array.isArray(rows) ? rows.filter((r) => r && r.revoked !== true) : []);
  }

  if (mode === 'public') {
    const byDevice = new Map<string, CoverTarget>();
    for (const [w, rows] of rowsByWallet) {
      for (const k of rows) {
        const t = { target: w, deviceId: k.device_id, encPub: k.enc_pub, createdAt: k.created_at ?? 0 };
        const prev = byDevice.get(coverTargetKey(t));
        if (!prev || t.createdAt > prev.createdAt) byDevice.set(coverTargetKey(t), t);
      }
    }
    return { targets: [...byDevice.values()], mode, incomplete };
  }

  // Only wallets with an uncovered device need (re-)verification this pass.
  const covered = args.covered ?? new Set<string>();
  const needVerify = [...rowsByWallet.keys()].filter(
    (w) => w !== self && (rowsByWallet.get(w) ?? []).some((k) => !covered.has(coverTargetKey({ target: w, deviceId: k.device_id }))),
  );
  const sel = await selectVerifiedWallets(
    { verify: deps.verifyMembers, store: deps.store, fresh, log: deps.log },
    { self, network, channelId, members: needVerify, activationMs: deps.activationMs(network) },
  );
  incomplete ||= sel.incomplete;

  const byDevice = new Map<string, CoverTarget>();
  let unbound = 0;
  let invalid = 0;
  for (const w of sel.wallets) {
    const rows = rowsByWallet.get(w);
    if (!rows || rows.length === 0) continue;
    const r = await filterBoundEncKeys(rows, w, network, deps.verifyBinding);
    assertFresh(fresh);
    unbound += r.unbound;
    invalid += r.invalid;
    for (const k of r.bound) {
      // Bound rows always carry the signed `ts`; the node-supplied
      // `created_at` must never decide which key of a device wins.
      const ts = typeof k.ts === 'number' && Number.isSafeInteger(k.ts) ? k.ts : -1;
      const t = { target: w, deviceId: k.device_id, encPub: k.enc_pub, createdAt: ts };
      const prev = byDevice.get(coverTargetKey(t));
      if (!prev || t.createdAt > prev.createdAt) byDevice.set(coverTargetKey(t), t);
    }
  }
  if (unbound > 0 || invalid > 0) {
    deps.log('channel cover: enc keys refused (not wallet-bound / invalid binding)', { channelId, unbound, invalid });
  }
  return { targets: [...byDevice.values()], mode, incomplete };
}

// --- Scheduling helpers -----------------------------------------------------------

/**
 * Run async jobs strictly one at a time (member-proofs: the node allows one
 * build per wallet in flight, so parallel covers would just 429 each other).
 */
export function createSerialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Cover throttles (ms). */
export const PUBLIC_COVER_THROTTLE_MS = 10_000;
export const PRIVATE_COVER_THROTTLE_MS = 60_000;
/** Minimum spacing even for an immediate (member-change event) pass. */
export const IMMEDIATE_COVER_MIN_MS = 5_000;

/** Per-channel cover throttle (one instance per account; reset on switch). */
export class CoverThrottle {
  private readonly last = new Map<number, number>();

  /** Claim a pass now if allowed. */
  tryStart(channelId: number, now: number, opts: { privateMode: boolean; immediate: boolean }): boolean {
    const prev = this.last.get(channelId) ?? 0;
    const gap = opts.immediate ? IMMEDIATE_COVER_MIN_MS : opts.privateMode ? PRIVATE_COVER_THROTTLE_MS : PUBLIC_COVER_THROTTLE_MS;
    if (now - prev < gap) return false;
    this.last.set(channelId, now);
    return true;
  }

  /**
   * A pass failed. Only a failure of the STILL-ACTIVE account re-opens the
   * throttle; a stale (previous-account) pass must not reset the new
   * account's state.
   */
  failed(channelId: number, stillFresh: boolean): void {
    if (stillFresh) this.last.set(channelId, 0);
  }

  clear(): void {
    this.last.clear();
  }
}

/**
 * Per-account, per-switch-generation cache holder (the SDK
 * `MemberProofCache`): never shared across accounts or generations; a stale
 * caller gets a throwaway instance that is never stored.
 */
export class PerAccountCache<C> {
  private cur: { wallet: string; generation: number; cache: C } | null = null;
  private readonly make: () => C;

  constructor(make: () => C) {
    this.make = make;
  }

  get(wallet: string, generation: number, fresh: boolean): C {
    if (!fresh) return this.make();
    if (!this.cur || this.cur.wallet !== wallet || this.cur.generation !== generation) {
      this.cur = { wallet, generation, cache: this.make() };
    }
    return this.cur.cache;
  }

  reset(): void {
    this.cur = null;
  }
}
