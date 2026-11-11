/**
 * Desktop adapter over the SHARED channel keyring (`ChannelKeyring`,
 * `@ogmara/sdk` 0.68.0) — desktop 1.85.0.
 *
 * The keyring itself (slots, alternates, rank / promotion, caps, vault
 * `chan` names, never-lose rules) lives in the SDK and is tested there
 * (`channelKeyring.test.ts` + the seeded property test). This file only adds
 * what is desktop wiring, kept pure so it is tested by behaviour
 * (`channelKeyStore.test.ts`):
 *  - the account-switch generation is passed on every write (a write after a
 *    switch is dropped — cross-account key leak, 2026-09-04) and the vault
 *    change listener fires after every held write;
 *  - the client's `KeyMeta` (`keyTs`, `keyCommitment`) maps to the SDK pair;
 *  - every evidence / send query AND every put of a key that is not ours is
 *    BOUNDED by the home node's highest epoch + 256 (`NODE_EPOCH_MAX_AHEAD`):
 *    a malicious member or node must not set our rotation base or send key,
 *    or flood epochs above anything a node accepts;
 *  - the SEND rule (user decision): only a trusted FINAL key, except the
 *    creator's provisional first key of a brand-new channel (epoch 1, made
 *    only by the SDK early-use path while every target is one of our own
 *    devices). NEVER an unverified key: a legacy (pre-arbitration) epoch is
 *    moved to an arbitrated one instead (gated) — the client has nothing the
 *    node cannot forge to call an epoch pre-arbitration, so the SDK's
 *    `allowUnverified` / `bestForSendLegacy` are deliberately not used;
 *  - the vault export is TWO-STEP (`prepareExport` → publish →
 *    `commitExport` only after the node accepted it);
 *  - the user-confirmed prune ladder (least risky class first).
 *
 * Terms (see the SDK module comment): `verified` = pair-consistent only;
 * TRUSTED = author-verified (`establish` / `wrap`) + pair-consistent + not
 * provisional; `final` = the node's final winner. After a restart every key
 * is a `vault` key (the vault records no provenance): nothing is trusted
 * until the own-slot wrap is re-verified and re-put as `wrap` + `ownSlot`
 * ({@link ChannelKeys.trustProbe} names the epoch to do that for).
 */
import {
  ChannelKeyring,
  type ChannelKeyringOptions,
  type ChannelKeyExportToken,
  type ChannelKeyHeld,
  type ChannelKeyInfo,
  type ChannelKeyMarkResult,
  type ChannelKeyPruneResult,
  type ChannelKeyPutResult,
  type ChannelKeySource,
} from '@ogmara/sdk';
import { NODE_EPOCH_MAX_AHEAD, type KeyMeta } from './epochKeys.ts';

/** Options of {@link ChannelKeys.put}. */
export interface KeyPutOpts {
  /** `establish` / `wrap` ONLY after our own establish or a `verifyChannelKeyWrap` that verified. */
  source: ChannelKeySource;
  /** The key's pair (never with `legacy`). */
  meta?: KeyMeta;
  /** The pair re-hashes to the key (the keyring re-checks it; `'invalid'` otherwise). */
  verified?: boolean;
  /** The node reported THIS pair as the epoch's FINAL winner. Requires `verified`. */
  final?: boolean;
  /** Our own not-yet-final first key (`establish` only). */
  provisional?: boolean;
  /** With `wrap`: taken from OUR OWN enc-key slot and authored by OUR OWN wallet (never member-capped). */
  ownSlot?: boolean;
  /**
   * The home node's highest epoch: keys that are not ours (node-served, other
   * members' wraps) above highest + 256 are refused. REQUIRED for those.
   */
  nodeHighest?: number;
}

/** What {@link ChannelKeys.trustProbe} asks the caller to check. */
export interface TrustProbe {
  epoch: number;
  /** `verify`: re-verify our own slot's wrap and re-put it as `wrap`; `final`: ask the node whether our pair is the final winner. */
  kind: 'verify' | 'final';
}

/** One step of the user-confirmed prune ladder, least risky first. */
export type PruneLevel = 'nodeServed' | 'memberWraps' | 'restoredAlternates' | 'restoredPrimaries';
export const PRUNE_LEVELS: readonly PruneLevel[] = ['nodeServed', 'memberWraps', 'restoredAlternates', 'restoredPrimaries'];

/** A dry-run prune at one level (what the confirm shows), ready to apply. */
export interface PrunePlan {
  level: PruneLevel;
  /** `memberWraps`: only the one channel a member flooded most (`[]`: none). Always set for that level. */
  scopes?: string[];
  result: ChannelKeyPruneResult;
}

/** The highest epoch any evidence / send query or foreign put may reach for a node whose highest epoch is `nodeHighest`. */
export function maxEpochFor(nodeHighest: number): number {
  const nh = Number.isSafeInteger(nodeHighest) && nodeHighest >= 0 ? nodeHighest : 0;
  return nh + NODE_EPOCH_MAX_AHEAD;
}

const pairOf = (m: KeyMeta | undefined) => (m ? { keyTs: m.keyTs, commitment: m.keyCommitment } : undefined);
const SCOPE_IN_NAME = /^([0-9A-Za-z]{1,128}):\d/;

/** The desktop channel key cache: a thin adapter over the SDK {@link ChannelKeyring}. */
export class ChannelKeys {
  private readonly ring: ChannelKeyring;
  private readonly onChange: () => void;
  /** Scopes ever held this session (the SDK has no scope listing; used by the member-flood prune step). */
  private readonly scopeSet = new Set<string>();

  /**
   * @param generation the account-switch generation now (`currentSwitchGeneration`).
   * @param onChange called after every write that holds a key (schedules the vault backup).
   */
  constructor(generation: () => number, onChange: () => void, opts: Omit<ChannelKeyringOptions, 'generation'> = {}) {
    this.ring = new ChannelKeyring({ ...opts, generation });
    this.onChange = onChange;
  }

  /**
   * Hold a key. `forGeneration` is the switch generation the caller captured
   * BEFORE its network round trip. The key is COPIED (the caller's buffer is
   * neither kept nor zeroed). Never overwrites a held key: a different key at
   * a held epoch is kept as an alternate (`'conflict'`) or becomes the
   * primary over a lower-ranked one (`'promoted'`). A key that is not ours
   * is `'refused'` above `nodeHighest` + 256 and beyond the member caps.
   */
  put(scopeHex: string, epoch: number, key: Uint8Array, forGeneration: number, o: KeyPutOpts): ChannelKeyPutResult {
    const r = this.ring.put(scopeHex, epoch, key, {
      source: o.source, pair: pairOf(o.meta), verified: o.verified, final: o.final,
      provisional: o.provisional, ownSlot: o.ownSlot, generation: forGeneration,
      maxEpoch: o.nodeHighest === undefined ? undefined : maxEpochFor(o.nodeHighest),
    });
    if (r === 'stored' || r === 'promoted' || r === 'conflict') {
      this.scopeSet.add(scopeHex);
      this.onChange();
    }
    return r;
  }

  /**
   * Record that the node reports `meta` as the FINAL winner for a held,
   * author-verified key (`needs_author_proof` for vault / node-served keys).
   */
  markFinal(scopeHex: string, epoch: number, key: Uint8Array, meta: KeyMeta, forGeneration: number): ChannelKeyMarkResult {
    const r = this.ring.markVerified(scopeHex, epoch, key, pairOf(meta)!, { final: true, generation: forGeneration });
    if (r === 'verified' || r === 'promoted') this.onChange();
    return r;
  }

  /** Every key held at the epoch for DECRYPTION, primary first (copies). */
  keysAt(scopeHex: string, epoch: number): Uint8Array[] {
    return this.ring.keysAt(scopeHex, epoch);
  }

  /** Every key held at the epoch with its metadata, primary first (copies). */
  entriesAt(scopeHex: string, epoch: number): ChannelKeyInfo[] {
    return this.ring.entriesAt(scopeHex, epoch);
  }

  /** Any key held at `epoch` (makes THAT epoch known to exist; never global evidence). */
  holds(scopeHex: string, epoch: number): boolean {
    return this.ring.holds(scopeHex, epoch);
  }

  /** The highest held epoch within reach of the node (any key; its primary), or null. Not evidence. */
  latestBounded(scopeHex: string, nodeHighest: number): ChannelKeyHeld | null {
    return this.ring.latestBounded(scopeHex, maxEpochFor(nodeHighest));
  }

  /** The SDK's `highestEpochSeen` / rotation base: the highest TRUSTED epoch within reach (0 when none). */
  evidence(scopeHex: string, nodeHighest: number): number {
    return this.ring.latestVerified(scopeHex, { maxEpoch: maxEpochFor(nodeHighest) })?.epoch ?? 0;
  }

  /**
   * The highest trusted FINAL epoch within reach (0 when none) — the
   * "confirmed" base (web `rotationBase(confirmedOnly: true)`): a rotation is
   * done, or a heal applies, only against a key the node confirmed final.
   */
  finalEvidence(scopeHex: string, nodeHighest: number): number {
    return this.ring.latestVerified(scopeHex, { finalOnly: true, maxEpoch: maxEpochFor(nodeHighest) })?.epoch ?? 0;
  }

  /** Heal trigger eligibility: `epoch` is our latest trusted FINAL epoch (within reach). */
  healEligible(scopeHex: string, epoch: number, nodeHighest: number): boolean {
    return epoch > 0 && this.finalEvidence(scopeHex, nodeHighest) === epoch;
  }

  /** We already hold a trusted FINAL key at or above `floor` (within reach): a rotation to `floor` is done. */
  alreadyAt(scopeHex: string, floor: number, nodeHighest: number): boolean {
    const e = this.finalEvidence(scopeHex, nodeHighest);
    return e > 0 && e >= floor;
  }

  /**
   * The key to SEND / cover under: the highest trusted FINAL key within reach;
   * else the creator's provisional first key at epoch 1. Null otherwise —
   * never an unverified key: the caller re-verifies, waits for final, or
   * moves a legacy epoch to an arbitrated one.
   */
  sendKey(scopeHex: string, nodeHighest: number): ChannelKeyHeld | null {
    const maxEpoch = maxEpochFor(nodeHighest);
    const fin = this.ring.bestForSend(scopeHex, { finalOnly: true, maxEpoch });
    if (fin) return fin;
    const early = this.ring.bestForSend(scopeHex, { maxEpoch });
    return early && early.provisional && early.epoch === 1 ? early : null;
  }

  /**
   * The ONE check worth a network round trip so sends / covers do not stay on
   * a stale epoch: the highest held epoch within reach, when its primary is
   * not trusted (`verify`: a vault / legacy key — re-verify our own slot's
   * wrap) or trusted but not final yet (`final`: ask the node). Null when the
   * highest held key is trusted + final, or our provisional first key.
   */
  trustProbe(scopeHex: string, nodeHighest: number): TrustProbe | null {
    const l = this.latestBounded(scopeHex, nodeHighest);
    if (!l || l.provisional) return null;
    if (!l.trusted) return { epoch: l.epoch, kind: 'verify' };
    return l.final ? null : { epoch: l.epoch, kind: 'final' };
  }

  /**
   * Step 1 of the TWO-STEP vault export: the `chan` record (unchanged
   * cross-client format) and a token. Side-effect free: nothing is marked
   * persisted until {@link commitExport} — call that ONLY after the sealed
   * vault was published.
   * @throws ChannelKeyringError `vault_too_large` / `opaque_overflow` / `stale` — surface it, never treat it as backed up.
   */
  prepareExport(forGeneration: number): { chan: Record<string, Uint8Array>; token: ChannelKeyExportToken } {
    const p = this.ring.prepareExport(forGeneration);
    return { chan: p.chan, token: p.commitToken };
  }

  /**
   * Step 2: the export behind `token` was published — its keys are persisted
   * (protected from eviction, names kept).
   * @throws ChannelKeyringError `stale` when the account changed meanwhile.
   */
  commitExport(token: ChannelKeyExportToken, forGeneration: number): number {
    return this.ring.commitExport(token, forGeneration);
  }

  /**
   * Merge a vault `chan` record (keys NOT author-verified; every 32-byte entry
   * kept). Keys the user pruned this session are skipped by the keyring.
   * `nodeHighest` (one channel's record only): restored keys above its reach
   * are classed as member wraps for the prune ladder. A multi-channel record
   * has no single ceiling: pass none.
   * @throws ChannelKeyringError `stale` for an outdated generation.
   */
  importFromVault(rec: Record<string, Uint8Array>, forGeneration: number, nodeHighest?: number): number {
    const n = this.ring.importFromVault(rec, forGeneration, nodeHighest === undefined ? {} : { maxEpoch: maxEpochFor(nodeHighest) });
    for (const name of Object.keys(rec)) {
      const m = SCOPE_IN_NAME.exec(name);
      if (m) this.scopeSet.add(m[1]!);
    }
    return n;
  }

  /** No channel key and no kept unknown vault entry (cheap: no export is built). */
  get empty(): boolean {
    return this.ring.heldEpochCount === 0 && this.ring.opaqueCount === 0;
  }

  /** Dry run of one ladder level; `memberWraps` targets the single most-flooded channel. */
  planPrune(level: PruneLevel, forGeneration: number): PrunePlan {
    if (level !== 'memberWraps') {
      return { level, result: this.ring.pruneUnverified({ dryRun: true, classes: [level], generation: forGeneration }) };
    }
    let best: PrunePlan | null = null;
    for (const scope of this.scopeSet) {
      const result = this.ring.pruneUnverified({ dryRun: true, classes: ['memberWraps'], scopes: [scope], generation: forGeneration });
      if (result.removedCount > 0 && (!best || result.removedCount > best.result.removedCount)) best = { level, scopes: [scope], result };
    }
    // Nothing to remove anywhere: an EMPTY scope list (never "all channels").
    return best ?? { level, scopes: [], result: this.ring.pruneUnverified({ dryRun: true, classes: ['memberWraps'], scopes: [], generation: forGeneration }) };
  }

  /** The first ladder level from `from` on that would remove something (dry run), or null. */
  nextPrunePlan(forGeneration: number, from: PruneLevel = 'nodeServed'): PrunePlan | null {
    for (const level of PRUNE_LEVELS.slice(PRUNE_LEVELS.indexOf(from))) {
      const plan = this.planPrune(level, forGeneration);
      if (plan.result.removedCount > 0) return plan;
    }
    return null;
  }

  /**
   * True when a fresh dry run of `plan` (same level and scopes) would remove
   * MORE than the confirmed one showed (keys arrived while the dialog was
   * open): the user must see the new counts first.
   */
  pruneGrew(plan: PrunePlan, forGeneration: number): boolean {
    const now = this.ring.pruneUnverified({ dryRun: true, classes: [plan.level], scopes: plan.scopes, generation: forGeneration });
    const was = plan.result.byClass;
    const is = now.byClass;
    return now.removedCount > plan.result.removedCount || now.removedBytes > plan.result.removedBytes
      || is.ownAlternatesAtRisk.count > was.ownAlternatesAtRisk.count;
  }

  /**
   * Apply a USER-CONFIRMED plan (its dry run was shown). The keyring remembers
   * pruned keys for the session, so re-merging the remote vault does not
   * bring them back. Notifies the vault listener when keys were removed.
   * @throws ChannelKeyringError `stale` for an outdated generation.
   */
  applyPrune(plan: PrunePlan, forGeneration: number): ChannelKeyPruneResult {
    // A member-wrap plan is ALWAYS scoped (to the flooded channel, or to none).
    if (plan.level === 'memberWraps' && !plan.scopes) throw new Error('memberWraps prune plan without scopes');
    const r = this.ring.pruneUnverified({ classes: [plan.level], scopes: plan.scopes, generation: forGeneration });
    if (r.removedCount > 0) this.onChange();
    return r;
  }

  /** Zero the keyring's own copies and drop everything (sign-out / account switch). */
  clear(): void {
    this.ring.clear();
    this.scopeSet.clear();
  }

  /** Number of held epochs over all scopes. */
  get size(): number {
    return this.ring.size;
  }
}
