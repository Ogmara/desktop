/**
 * Per-channel epoch DRIVE logic (desktop 1.85.0) — the orchestration around
 * `runEpochKey` (epochKeys.ts), pure with injected I/O so it is tested by
 * behaviour (epochDriver.test.ts); `channelCrypto.ts` wires it to the live
 * client, the key store and the UI status signal.
 */
import { StaleAccountError } from './privateCover.ts';
import type { EpochKeyResult, CoverModeHint, KeyMeta, PendingEpochRecord } from './epochKeys.ts';
import type { UnconfirmedEpochKey, EscalationGate } from '@ogmara/sdk';

/** One planned establish / adopt / rotation. */
export interface DrivePlan {
  epoch: number;
  epochKnownToExist: boolean;
  mode: CoverModeHint;
  /**
   * The lowest epoch this plan accepts (a kick's floor; equals `epoch` for a
   * send / resume). A persisted epoch BELOW it is dead and is dropped
   * instead of being resumed first.
   */
  floor: number;
  onEarly?: (k: UnconfirmedEpochKey) => void;
}

/** Per-channel key state shown in the chat view. */
export type ChannelKeyStatus = 'rekeying' | 'node_problem';

export interface DriveDeps {
  /** True while the captured account is still active. */
  fresh(): boolean;
  network(): Promise<string>;
  nodeArbitrates(): Promise<boolean>;
  loadPending(network: string): PendingEpochRecord | undefined;
  clearPending(network: string, epoch: number): void;
  drive(network: string, plan: DrivePlan): Promise<EpochKeyResult>;
  apply(network: string, plan: DrivePlan, res: EpochKeyResult): void;
  setStatus(s: ChannelKeyStatus | null): void;
  log(step: string, data?: Record<string, unknown>): void;
}

/**
 * One drive of one channel: resume a persisted (unfinished) epoch first —
 * SDK caller contract — unless it lies below the plan's floor (a newer kick
 * rotation must not be held back by a stuck older epoch: it is dropped),
 * then the plan. Returns null when nothing ran (stale, no plan, node lacks
 * arbitration). Never throws; a `StaleAccountError` ends it silently.
 */
export async function runDrive(
  deps: DriveDeps, makePlan: (network: string) => Promise<DrivePlan | null>,
): Promise<EpochKeyResult | null> {
  const guard = () => {
    if (!deps.fresh()) throw new StaleAccountError();
  };
  try {
    const network = await deps.network();
    guard();
    if (!(await deps.nodeArbitrates())) {
      guard();
      deps.log('channel epoch: node lacks key_commitment_v1 — no key establishment here');
      deps.setStatus('node_problem');
      return null;
    }
    guard();
    deps.setStatus('rekeying');
    const plan = await makePlan(network);
    guard();
    let persisted = deps.loadPending(network);
    if (persisted && plan && persisted.epoch < plan.floor) {
      deps.log('channel epoch: persisted epoch below the plan floor — dropped', { epoch: persisted.epoch, floor: plan.floor });
      deps.clearPending(network, persisted.epoch);
      persisted = undefined;
    }
    if (persisted) {
      const resumePlan: DrivePlan = plan && plan.epoch === persisted.epoch
        ? plan
        : { epoch: persisted.epoch, epochKnownToExist: false, mode: persisted.mode, floor: persisted.epoch };
      const r = await deps.drive(network, resumePlan);
      guard();
      deps.apply(network, resumePlan, r);
      // Move on to a HIGHER plan only once the resumed epoch is final.
      if (!plan || plan.epoch <= persisted.epoch || r.kind !== 'key' || r.epoch >= plan.epoch) return r;
    }
    if (!plan) {
      deps.setStatus(null);
      return null;
    }
    const res = await deps.drive(network, plan);
    guard();
    deps.apply(network, plan, res);
    return res;
  } catch (e) {
    if (!(e instanceof StaleAccountError)) {
      deps.log('channel epoch: drive failed', { err: (e as Error)?.message });
      if (deps.fresh()) deps.setStatus(null);
    }
    return null;
  }
}

export interface ApplyDeps {
  fresh(): boolean;
  /** Cache the FINAL key with its verified pair (and persist the pair). */
  cacheFinal(epoch: number, key: Uint8Array, meta: KeyMeta): void;
  setStatus(s: ChannelKeyStatus | null): void;
  /** Schedule a bounded retry; false when the retry budget is spent. */
  retry(plan: DrivePlan): boolean;
  /** A fully covered final key: the channel's retry budget starts over. */
  resetRetries(): void;
  rebind(): void;
  log(step: string, data?: Record<string, unknown>): void;
}

/**
 * Apply a drive result — ONLY while the captured account is still active (a
 * stale result must not cache a key, touch the status or schedule anything
 * for the account that replaced it).
 */
export function applyEpochResult(deps: ApplyDeps, plan: DrivePlan, res: EpochKeyResult): void {
  if (!deps.fresh()) return;
  // Same epoch: keep the plan's flag (a failure before our own publish must
  // not turn "rotate into a new epoch" into "known to exist", which reads as
  // node_lagging); an epoch we moved to is new.
  const again = (epochKnownToExist: boolean): DrivePlan => ({
    epoch: res.epoch, epochKnownToExist, mode: plan.mode, floor: res.epoch,
  });
  switch (res.kind) {
    case 'key':
      deps.cacheFinal(res.epoch, res.key, { keyTs: res.keyTs, keyCommitment: res.keyCommitment });
      deps.log('channel epoch: key final', { epoch: res.epoch, role: res.role, uncovered: res.uncovered });
      deps.setStatus(null);
      // Members the home node did not take yet: resume the SAME epoch later —
      // within the SAME budget (resetting it here would make these retries
      // unbounded: every resume ends `key` with uncovered targets again).
      if (res.uncovered > 0) deps.retry(again(true));
      else deps.resetRetries();
      return;
    case 'rekeying':
      deps.log('channel epoch: still re-keying', { epoch: res.epoch, reason: res.reason });
      if (deps.retry(again(res.epoch === plan.epoch ? plan.epochKnownToExist : false))) deps.setStatus('rekeying');
      else deps.setStatus('node_problem');
      return;
    case 'rebind':
      deps.log('channel epoch: own enc key not wallet-bound → re-bind');
      deps.rebind();
      if (deps.retry(again(res.epoch === plan.epoch ? plan.epochKnownToExist : false))) deps.setStatus('rekeying');
      else deps.setStatus('node_problem');
      return;
    case 'blocked':
      deps.log('channel epoch: blocked on this node', { epoch: res.epoch, reason: res.reason, detail: res.detail });
      deps.setStatus('node_problem');
      return;
  }
}

/**
 * Bounded per-channel retries (re-keying not done yet): one pending timer
 * per channel, at most `max` per channel per account session. When the
 * budget is spent, `schedule` returns false and KEEPS returning false — the
 * caller surfaces it (the status must not stay "re-keying" forever). Only a
 * fully covered final key ({@link reset}) or an account switch
 * ({@link clear}) starts the budget over; a retry that ends the same way
 * never re-opens it.
 */
export class RekeyScheduler {
  private readonly timers = new Map<number, unknown>();
  private readonly attempts = new Map<number, number>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  readonly max: number;
  readonly delayMs: number;

  constructor(setTimer: (fn: () => void, ms: number) => unknown, clearTimer: (h: unknown) => void, max = 10, delayMs = 60_000) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.max = max;
    this.delayMs = delayMs;
  }

  /** Schedule `run`; true when scheduled or already pending, false when the budget is spent. */
  schedule(channelId: number, run: () => void): boolean {
    if (this.timers.has(channelId)) return true;
    const n = (this.attempts.get(channelId) ?? 0) + 1;
    if (n > this.max) return false;
    this.attempts.set(channelId, n);
    this.timers.set(channelId, this.setTimer(() => {
      this.timers.delete(channelId);
      run();
    }, this.delayMs));
    return true;
  }

  /** A final key: the channel's budget starts over. */
  reset(channelId: number): void {
    this.attempts.delete(channelId);
  }

  /** Account switch / sign-out. */
  clear(): void {
    for (const h of this.timers.values()) this.clearTimer(h);
    this.timers.clear();
    this.attempts.clear();
  }

  pending(channelId: number): boolean {
    return this.timers.has(channelId);
  }
}

/** Channels to resume at account start: still joined, at most `cap`. */
export function resumeCandidates(pending: ReadonlyMap<number, PendingEpochRecord>, isJoined: (id: number) => boolean, cap = 16): number[] {
  const out: number[] = [];
  for (const id of pending.keys()) {
    // Skipped, not cleared: the joined set may not have reloaded yet right
    // after a switch; an entry of a left channel is evicted by the cap.
    if (!isJoined(id)) continue;
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/** What a cover pass does with the current key, given its pair resolution. */
export type CoverAction = 'publish' | 'new_epoch' | 'heal' | 'skip';

/**
 * - a verified pair → publish (covers reuse the SAME pair);
 * - `legacy` (no pair can exist) → move the channel to a new arbitrated epoch
 *   (its plan is {@link gatedPlan}: at most once per channel per 10 min);
 * - `mismatch` (our own slot's verified wrap is ANOTHER key: ours is not the
 *   epoch's key) → the heal path (itself gated);
 * - unknown → skip this pass.
 */
export function decideCoverAction(meta: KeyMeta | 'legacy' | 'mismatch' | 'none'): CoverAction {
  if (typeof meta === 'object') return 'publish';
  if (meta === 'legacy') return 'new_epoch';
  if (meta === 'mismatch') return 'heal';
  return 'skip';
}

/**
 * A plan that takes the per-account escalation gate token ONLY when it really
 * starts: not when the work is already done (`done()`), and never for a call
 * that joined an in-flight drive (that drive's own plan runs instead, so this
 * function is never called). Returns null when done or gated.
 */
export async function gatedPlan(
  gate: EscalationGate, channelId: number, done: () => boolean, plan: () => Promise<DrivePlan | null>,
): Promise<DrivePlan | null> {
  if (done()) return null;
  if (!gate.tryEscalate(channelId)) return null;
  return plan();
}

/**
 * The reason a send reports while no key is usable: a channel whose last
 * drive ended `node_problem` reports that (matching the banner), not
 * "re-keying".
 */
export function alignWait(w: 'waiting' | 'rekeying' | 'node_problem', status: ChannelKeyStatus | null): 'waiting' | 'rekeying' | 'node_problem' {
  return w === 'rekeying' && status === 'node_problem' ? 'node_problem' : w;
}
