/**
 * Node-arbitrated channel key epochs — desktop wiring around the SDK's
 * `establishEpochKey` (desktop 1.85.0). Run:
 *   node --conditions=browser --test src/lib/epochKeys.test.ts
 *
 * `runEpochKey` drives the REAL SDK protocol against a fake l2-node 0.143.0
 * arbitration model (lowest `(key_ts, commitment)` wins, 120 s finality,
 * write-once slots, 409 for a losing pair) on a virtual clock. The rest of
 * the wiring (id-floor rule, heal gate, persisted epoch, key metadata, cover
 * loop, re-bind backoff, revocation filter, peer queries) is tested by
 * behaviour with injected fakes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  computeChannelScope,
  computeKeyCommitment,
  keyCommitmentToHex,
  compareRank,
  sameCandidate,
  KeyCommitmentConflictError,
  KeyEnvelopeRateLimitedError,
  KeyEnvelopeRejectedError,
  EscalationGate,
  type KeyCommitmentInfo,
  type EpochKeyTarget,
  type PublishChannelKeyResult,
  type VerifiedChannelKeyWrap,
} from '@ogmara/sdk';
import { StaleAccountError, type WalletStore } from './privateCover.ts';
import {
  EpochAccount,
  EpochAccountHolder,
  runEpochKey,
  planRotation,
  planNextEpoch,
  epochWithinReach,
  rotationAllowed,
  effectiveFloor,
  healTrigger,
  coverTargetsAtEpoch,
  loadPendingEpochs,
  setPendingEpoch,
  clearPendingEpoch,
  loadKeyMeta,
  saveKeyMeta,
  keyMetaBase,
  commitmentState,
  metaMatchesKey,
  rebindAllowed,
  noteRebindAttempt,
  clearRebindBackoff,
  nodeKeepsBindings,
  revocableEncRows,
  MAX_PENDING_EPOCHS,
  REBIND_BACKOFF_MS,
  REBIND_429_BACKOFF_MS,
  type EpochIo,
  type EncRow,
} from './epochKeys.ts';
import { queryPeerCommitments } from './epochPeers.ts';
import { ChannelKeys } from './channelKeyStore.ts';

const w = (c: string) => 'klv1' + c.repeat(58);
const ME = w('a');
const M1 = w('c');
const NET = 'testnet';
const FLOOR = 2 ** 32;
const PRIV = FLOOR + 77;
const PUB = 77;
const FINALITY = 120_000;

function memStore(): WalletStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (wallet, base) => data.get(`${base}::${wallet}`) ?? null,
    set: (wallet, base, value) => { data.set(`${base}::${wallet}`, value); },
    remove: (wallet, base) => { data.delete(`${base}::${wallet}`); },
  };
}

// --- Virtual clock + fake arbitrating node ----------------------------------------------

class Clock {
  t = 1_800_000_000_000;
  now = () => this.t;
  sleep = async (ms: number) => {
    this.t += Math.max(1, ms);
    await new Promise<void>((r) => setImmediate(r));
  };
}

interface Slot { key: Uint8Array; keyTs: number; c: Uint8Array; author: string; signer: string }
interface Winner { keyTs: number; keyCommitment: Uint8Array; author: string; recordedAt: number }

/** l2-node 0.143.0 rule, minimal: one winner per epoch, supersede only by a better pair inside 120 s. */
class FakeNode {
  readonly winners = new Map<number, Winner>();
  readonly slots = new Map<string, Slot>(); // `${epoch}:${target}:${device}`
  publishes = 0;
  legacyEpochs = new Set<number>();
  readonly clock: Clock;
  readonly channelId: number;
  constructor(clock: Clock, channelId: number) {
    this.clock = clock;
    this.channelId = channelId;
  }

  info(epoch?: number): KeyCommitmentInfo {
    const e = epoch ?? Math.max(0, ...this.winners.keys(), ...this.legacyEpochs);
    const base = { channel_id: this.channelId, epoch: e, finality_ms: FINALITY };
    if (this.legacyEpochs.has(e)) return { ...base, state: 'legacy', final: true };
    const win = this.winners.get(e);
    if (!win) return { ...base, state: 'none', final: false };
    return {
      ...base, state: 'arbitrated', key_commitment: keyCommitmentToHex(win.keyCommitment), key_ts: win.keyTs,
      author: win.author, msg_id: 'ab'.repeat(32), recorded_at: win.recordedAt,
      final: this.clock.now() - win.recordedAt >= FINALITY,
    };
  }

  publish(author: string, t: EpochKeyTarget, key: Uint8Array, keyTs: number, epoch: number): PublishChannelKeyResult {
    this.publishes++;
    const c = computeKeyCommitment(computeChannelScope(this.channelId), epoch, keyTs, key);
    const pair = { keyTs, keyCommitment: c };
    const win = this.winners.get(epoch);
    if (!win) {
      this.winners.set(epoch, { ...pair, author, recordedAt: this.clock.now() });
    } else if (!sameCandidate(win, pair)) {
      const better = compareRank(pair, win) < 0;
      if (!better || this.clock.now() - win.recordedAt >= FINALITY) {
        throw new KeyCommitmentConflictError(
          { key_commitment: keyCommitmentToHex(win.keyCommitment), key_ts: win.keyTs, author: win.author, msg_id: 'ab'.repeat(32), final: this.clock.now() - win.recordedAt >= FINALITY },
          'arbitrated', epoch,
        );
      }
      // Supersede: the loser's wraps are deleted.
      for (const k of [...this.slots.keys()]) if (k.startsWith(`${epoch}:`)) this.slots.delete(k);
      this.winners.set(epoch, { ...pair, author, recordedAt: this.clock.now() });
    }
    const sk = `${epoch}:${t.target}:${t.deviceId}`;
    if (this.slots.has(sk)) return { status: 'already_present' };
    this.slots.set(sk, { key: key.slice(), keyTs, c, author, signer: author });
    return { status: 'stored' };
  }

  own(target: string, device: string, epoch: number): VerifiedChannelKeyWrap | null {
    const s = this.slots.get(`${epoch}:${target}:${device}`);
    if (!s) return null;
    return { key: s.key.slice(), keyCommitment: s.c.slice(), keyTs: s.keyTs, epoch, wallet: s.author, signer: s.signer, msgId: 'cd'.repeat(32) };
  }
}

const dev = (wallet: string, d: string): EpochKeyTarget => ({ target: wallet, deviceId: d, encPub: new Uint8Array(32).fill(7) });

function io(node: FakeNode, wallet: string, device: string, targets: EpochKeyTarget[], over: Partial<EpochIo> = {}): EpochIo {
  return {
    channelId: node.channelId,
    network: NET,
    self: { wallet, deviceId: device, signingAddress: wallet, encPub: new Uint8Array(32).fill(7) },
    fresh: () => true,
    getCommitment: async (e) => { await node.clock.sleep(1); return node.info(e); },
    fetchOwnWrap: async (e) => { await node.clock.sleep(1); return node.own(wallet, device, e); },
    isSelfBound: async () => true,
    listTargets: async () => targets,
    publish: async (t, key, keyTs, e) => { await node.clock.sleep(5); return node.publish(wallet, t, key, keyTs, e); },
    newKey: () => webcrypto.getRandomValues(new Uint8Array(32)),
    now: node.clock.now,
    sleep: node.clock.sleep,
    highestEpochSeen: () => 0,
    log: () => {},
    ...over,
  };
}

const acct = (clock: Clock, wallet = ME) => new EpochAccount(wallet, 1, clock.now, clock.sleep);

// --- runEpochKey against the fake node (the real SDK protocol) -----------------------------

test('two devices establishing the same epoch concurrently end with ONE key, final, on every slot', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const all = [dev(ME, 'a1'), dev(M1, 'b1')];
  const sa = memStore();
  const sb = memStore();
  const [ra, rb] = await Promise.all([
    runEpochKey(io(node, ME, 'a1', all), acct(clock, ME), sa, { epoch: 3, epochKnownToExist: false, mode: 'verify' }),
    runEpochKey(io(node, M1, 'b1', all), acct(clock, M1), sb, { epoch: 3, epochKnownToExist: false, mode: 'verify' }),
  ]);
  assert.equal(ra.kind, 'key');
  assert.equal(rb.kind, 'key');
  if (ra.kind !== 'key' || rb.kind !== 'key') return;
  assert.deepEqual([...ra.key], [...rb.key], 'both members hold the same epoch key');
  assert.equal(ra.epoch, 3);
  const win = node.winners.get(3)!;
  assert.ok(sameCandidate(win, ra) && sameCandidate(win, rb));
  for (const s of [node.own(ME, 'a1', 3), node.own(M1, 'b1', 3)]) assert.deepEqual([...s!.key], [...ra.key]);
  assert.ok(clock.now() - win.recordedAt >= FINALITY, 'returned only once FINAL');
  assert.equal(loadPendingEpochs(sa, ME, NET).size, 0, 'terminal outcome clears the persisted epoch');
  assert.equal(loadPendingEpochs(sb, M1, NET).size, 0);
});

test('account switch mid-establish: StaleAccountError, NOTHING published, nothing persisted after it', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  let gen = 1;
  const store = memStore();
  const x = io(node, ME, 'a1', [dev(ME, 'a1'), dev(M1, 'b1')], {
    fresh: () => gen === 1,
    getCommitment: async (e) => { await clock.sleep(1); gen++; return node.info(e); }, // switch lands inside the first read
  });
  await assert.rejects(runEpochKey(x, acct(clock), store, { epoch: 2, epochKnownToExist: false, mode: 'verify' }), StaleAccountError);
  assert.equal(node.publishes, 0);
  assert.equal(node.winners.size, 0);
});

test('negative control: the same flow without the switch DOES publish (the switch test is not vacuous)', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1'), dev(M1, 'b1')]), acct(clock), memStore(), { epoch: 2, epochKnownToExist: false, mode: 'verify' });
  assert.equal(r.kind, 'key');
  assert.ok(node.publishes >= 2);
});

test('restart-resume: an abort after the own-device publish resumes the SAME key from the persisted epoch', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const store = memStore();
  const all = [dev(ME, 'a1'), dev(M1, 'b1')];
  let alive = true;
  const first = io(node, ME, 'a1', all, {
    fresh: () => alive,
    publish: async (t, key, keyTs, e) => {
      await clock.sleep(5);
      const r = node.publish(ME, t, key, keyTs, e);
      if (t.target === ME) alive = false; // "crash" right after the own-device publish
      return r;
    },
  });
  await assert.rejects(runEpochKey(first, acct(clock), store, { epoch: 5, epochKnownToExist: false, mode: 'verify' }), StaleAccountError);
  assert.equal(node.own(M1, 'b1', 5), null, 'the other member was not covered before the crash');
  const persisted = loadPendingEpochs(store, ME, NET).get(PRIV);
  assert.deepEqual(persisted, { epoch: 5, mode: 'verify' }, 'the epoch NUMBER survived');
  const keyHex = keyCommitmentToHex(node.own(ME, 'a1', 5)!.key); // hex of the KEY bytes
  assert.ok(![...store.data.values()].some((v) => v.includes(keyHex)), 'the key itself is never persisted');

  // A restarted client: empty memory, same storage.
  const r = await runEpochKey(io(node, ME, 'a1', all), acct(clock), store, { epoch: persisted!.epoch, epochKnownToExist: false, mode: persisted!.mode });
  assert.equal(r.kind, 'key');
  if (r.kind !== 'key') return;
  assert.equal(r.role, 'established', 'resumed, not merely adopted');
  assert.deepEqual([...node.own(M1, 'b1', 5)!.key], [...r.key], 'the other member now holds the same key');
  assert.equal(loadPendingEpochs(store, ME, NET).size, 0);
});

test('a legacy epoch moves to the next epoch; split / escalate hops are bounded', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  node.legacyEpochs.add(4);
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')]), acct(clock), memStore(), { epoch: 4, epochKnownToExist: true, mode: 'verify' });
  assert.equal(r.kind, 'key');
  assert.equal(r.epoch, 5);

  // A peer that always reports a different FINAL winner: split → hop, capped.
  const clock2 = new Clock();
  const node2 = new FakeNode(clock2, PRIV);
  const other = computeKeyCommitment(computeChannelScope(PRIV), 1, 1, new Uint8Array(32).fill(9));
  const peer = (e: number): KeyCommitmentInfo => ({
    channel_id: PRIV, epoch: e, state: 'arbitrated', key_commitment: keyCommitmentToHex(other), key_ts: 1,
    author: M1, msg_id: 'ab'.repeat(32), recorded_at: 0, final: true, finality_ms: FINALITY,
  });
  const a = acct(clock2);
  const r2 = await runEpochKey(io(node2, ME, 'a1', [dev(ME, 'a1')], { peerCommitments: async (e) => [peer(e)] }), a, memStore(), { epoch: 1, epochKnownToExist: false, mode: 'verify', maxHops: 3 });
  assert.notEqual(r2.kind, 'key', 'a key contradicted by a peer is never confirmed');
  assert.ok(node2.winners.size <= 2, 'at most one gated move (the gate allows one escalation per 10 min)');
});

test('early use only for the creator\'s first key of a brand-new channel (only own devices targeted)', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const early: number[] = [];
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1'), dev(ME, 'a2')]), acct(clock), memStore(), {
    epoch: 1, epochKnownToExist: false, mode: 'verify', onEarly: (u) => early.push(u.epoch),
  });
  assert.equal(r.kind, 'key');
  assert.deepEqual(early, [1], 'handed out before final');

  const clock2 = new Clock();
  const node2 = new FakeNode(clock2, PRIV);
  const early2: number[] = [];
  await runEpochKey(io(node2, ME, 'a1', [dev(ME, 'a1'), dev(M1, 'b1')]), acct(clock2), memStore(), {
    epoch: 1, epochKnownToExist: false, mode: 'verify', onEarly: (u) => early2.push(u.epoch),
  });
  assert.deepEqual(early2, [], 'another member is a target: no early use');

  const clock3 = new Clock();
  const node3 = new FakeNode(clock3, PRIV);
  const early3: number[] = [];
  await runEpochKey(io(node3, ME, 'a1', [dev(ME, 'a1')]), acct(clock3), memStore(), {
    epoch: 2, epochKnownToExist: false, mode: 'verify', onEarly: (u) => early3.push(u.epoch),
  });
  assert.deepEqual(early3, [], 'a rotation (epoch > 1) never uses a key early');
});

test('early use needs a KNOWN-complete own-only target list: incomplete, rejected-target and empty lists never use a key early', async () => {
  const run = async (listTargets: EpochIo['listTargets']) => {
    const clock = new Clock();
    const node = new FakeNode(clock, PRIV);
    const early: number[] = [];
    await runEpochKey(io(node, ME, 'a1', [], { listTargets }), acct(clock), memStore(), {
      epoch: 1, epochKnownToExist: false, mode: 'verify', onEarly: (u) => early.push(u.epoch),
    });
    return early;
  };
  const own = [dev(ME, 'a1'), dev(ME, 'a2')];
  assert.deepEqual(await run(async () => ({ targets: own })), [1], 'control: complete, own devices only');
  assert.deepEqual(await run(async () => ({ targets: own, incomplete: true })), [], 'unverifiable members may hide another member');
  assert.deepEqual(await run(async () => ({ targets: own, rejected: 1 })), [], 'a dropped target counts as not-self');
  assert.deepEqual(await run(async () => []), [], 'an empty list proves nothing');
});

test('epoch too far / unrecoverable lagging node are surfaced, not retried', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const tooFar = io(node, ME, 'a1', [dev(ME, 'a1')], {
    publish: async () => { throw new KeyEnvelopeRejectedError(400, 'key_epoch_too_far'); },
  });
  const r = await runEpochKey(tooFar, acct(clock), memStore(), { epoch: 200, epochKnownToExist: false, mode: 'verify' });
  assert.deepEqual([r.kind, r.kind === 'blocked' ? r.reason : ''], ['blocked', 'epoch_too_high']);

  const lag = io(node, ME, 'a1', [dev(ME, 'a1')], { highestEpochSeen: () => 5000 });
  const r2 = await runEpochKey(lag, acct(clock), memStore(), { epoch: 10, epochKnownToExist: true, mode: 'verify' });
  assert.deepEqual([r2.kind, r2.kind === 'blocked' ? r2.reason : ''], ['blocked', 'node_unrecoverable']);
  assert.equal(node.publishes, 0, 'no key is created on a lagging node');
});

test('needs_binding maps to rebind (no publish)', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')], { isSelfBound: async () => false }), acct(clock), memStore(), { epoch: 1, epochKnownToExist: false, mode: 'verify' });
  assert.equal(r.kind, 'rebind');
  assert.equal(node.publishes, 0);
});

test('EpochAccountHolder: per (wallet, generation); reset/switch zeroes pending keys', () => {
  const clock = new Clock();
  const h = new EpochAccountHolder(clock.now, clock.sleep);
  const a = h.get(ME, 1, true);
  assert.equal(h.get(ME, 1, true), a);
  const key = new Uint8Array(32).fill(5);
  a.pending.set(PRIV, 1, { key, keyTs: 1, keyCommitment: new Uint8Array(32).fill(1), covered: new Set() });
  const b = h.get(ME, 2, true);
  assert.notEqual(b, a);
  assert.ok(key.every((x) => x === 0), 'previous generation\'s pending key zeroed');
  assert.notEqual(h.get(ME, 2, false), b, 'a stale caller gets a throwaway');
  h.reset();
  assert.notEqual(h.get(ME, 2, true), b);
});

// --- Id-floor rule + rotation planning ---------------------------------------------------

test('id-floor rule: rotation only for private-range ids or a creator pin; public floor is 0', () => {
  assert.equal(rotationAllowed(PRIV, false), true);
  assert.equal(rotationAllowed(PUB, false), false);
  assert.equal(rotationAllowed(PUB, true), true);
  assert.equal(effectiveFloor(PUB, 9, false), 0);
  assert.equal(effectiveFloor(PUB, 9, true), 9);
  assert.equal(effectiveFloor(PRIV, 9, false), 9);
  assert.equal(effectiveFloor(PRIV, -1, false), 0);
});

test('planRotation: adopt an epoch at/above the floor the node already has; else the next one past everything', () => {
  const info = (epoch: number, state: KeyCommitmentInfo['state']): KeyCommitmentInfo => ({ channel_id: PRIV, epoch, state, final: false, finality_ms: FINALITY });
  assert.deepEqual(planRotation(4, info(4, 'arbitrated'), 3), { epoch: 4, epochKnownToExist: true });
  assert.deepEqual(planRotation(4, info(6, 'arbitrated'), 3), { epoch: 6, epochKnownToExist: true });
  assert.deepEqual(planRotation(4, info(2, 'arbitrated'), 3), { epoch: 4, epochKnownToExist: false });
  assert.deepEqual(planRotation(4, info(3, 'arbitrated'), 7), { epoch: 8, epochKnownToExist: false });
  assert.deepEqual(planRotation(1, info(0, 'none'), 0), { epoch: 1, epochKnownToExist: false });
});

// --- Heal trigger ----------------------------------------------------------------------

test('heal trigger: only at MY confirmed epoch, only where rotation is allowed, gated once per 10 min', () => {
  let t = 0;
  const gate = new EscalationGate(() => t);
  const base = { channelId: PRIV, messageEpoch: 4, myConfirmedEpoch: 4, rotationAllowed: true, gate };
  assert.equal(healTrigger({ ...base, rotationAllowed: false }), false);
  assert.equal(healTrigger({ ...base, messageEpoch: 3 }), false, 'an old epoch is not a split signal');
  assert.equal(healTrigger({ ...base, myConfirmedEpoch: 0 }), false);
  assert.equal(healTrigger(base), true);
  assert.equal(healTrigger(base), false, 'garbage ciphertext cannot loop rotations');
  t += 9 * 60_000;
  assert.equal(healTrigger(base), false);
  t += 61_000;
  assert.equal(healTrigger(base), true);
});

// --- Persisted pending epoch -------------------------------------------------------------

test('pending epoch: merged per channel, cleared only for the same epoch, bounded, corrupt reads empty', () => {
  const s = memStore();
  setPendingEpoch(s, ME, NET, 1, { epoch: 3, mode: 'verify' });
  setPendingEpoch(s, ME, NET, 2, { epoch: 1, mode: 'public' });
  setPendingEpoch(s, ME, NET, 1, { epoch: 4, mode: 'verify' });
  clearPendingEpoch(s, ME, NET, 1, 3); // stale clear: kept
  assert.deepEqual(loadPendingEpochs(s, ME, NET).get(1), { epoch: 4, mode: 'verify' });
  clearPendingEpoch(s, ME, NET, 1, 4);
  assert.equal(loadPendingEpochs(s, ME, NET).has(1), false);
  assert.equal(loadPendingEpochs(s, M1, NET).size, 0, 'per wallet');
  for (let i = 10; i < 10 + MAX_PENDING_EPOCHS + 5; i++) setPendingEpoch(s, ME, NET, i, { epoch: 1, mode: 'verify' });
  const m = loadPendingEpochs(s, ME, NET);
  assert.equal(m.size, MAX_PENDING_EPOCHS);
  assert.ok(m.has(10 + MAX_PENDING_EPOCHS + 4), 'newest kept');
  s.data.set(`ogmara.pchanEpochPending.${NET}::${ME}`, '{nope');
  assert.equal(loadPendingEpochs(s, ME, NET).size, 0);
});

// --- Key metadata (strict policy: covers reuse the SAME pair) -----------------------------

test('key meta: persisted pair is used only when it hashes to the key; the node state only classifies', () => {
  const s = memStore();
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  const keyTs = 1_790_000_000_000;
  const c = computeKeyCommitment(computeChannelScope(PRIV), 3, keyTs, key);
  saveKeyMeta(s, ME, NET, PRIV, 3, { keyTs, keyCommitment: c });
  const got = loadKeyMeta(s, ME, NET, PRIV, 3, key);
  assert.ok(got && got.keyTs === keyTs && metaMatchesKey(PRIV, 3, key, got));
  assert.equal(loadKeyMeta(s, ME, NET, PRIV, 3, new Uint8Array(32).fill(1)), undefined, 'another key never gets this pair');
  assert.equal(loadKeyMeta(s, M1, NET, PRIV, 3, key), undefined, 'per wallet');
  // Tampered storage (a different key_ts for the same commitment) is refused.
  s.data.set(`${keyMetaBase(NET)}::${ME}`, JSON.stringify([[`${PRIV}:3`, keyTs - 1, keyCommitmentToHex(c)]]));
  assert.equal(loadKeyMeta(s, ME, NET, PRIV, 3, key), undefined);

  // The node's state only CLASSIFIES an epoch; it never yields a pair.
  const info = (state: KeyCommitmentInfo['state'], e = 3): KeyCommitmentInfo => ({ channel_id: PRIV, epoch: e, state, final: true, finality_ms: FINALITY });
  assert.equal(commitmentState(info('legacy'), 3), 'legacy');
  assert.equal(commitmentState(info('arbitrated'), 3), 'arbitrated');
  assert.equal(commitmentState(info('none'), 3), 'none');
  assert.equal(commitmentState(info('legacy', 4), 3), 'none', 'an answer for another epoch is no answer');
});

test('key meta: bounded store keeps the newest writes', () => {
  const s = memStore();
  const key = new Uint8Array(32).fill(4);
  for (let e = 1; e <= 600; e++) {
    saveKeyMeta(s, ME, NET, PRIV, e, { keyTs: e, keyCommitment: computeKeyCommitment(computeChannelScope(PRIV), e, e, key) });
  }
  assert.equal(loadKeyMeta(s, ME, NET, PRIV, 1, key), undefined);
  assert.ok(loadKeyMeta(s, ME, NET, PRIV, 600, key));
});

// --- Cover at an existing epoch ------------------------------------------------------------

test('cover publishes with the epoch pair; conflict/stale stop, rejected skips, 429 stops for later', async () => {
  const published: string[] = [];
  const classify = (e: unknown) => e instanceof KeyCommitmentConflictError ? 'conflict' as const
    : e instanceof KeyEnvelopeRateLimitedError ? 'rate_limited' as const
      : e instanceof KeyEnvelopeRejectedError ? (e.code === 'key_ts_stale' ? 'stale' as const : 'rejected' as const) : 'transient' as const;
  const fails = new Map<string, unknown>([
    ['b', new KeyEnvelopeRejectedError(400, 'key_scope_full')],
    ['d', new KeyEnvelopeRateLimitedError(1000, true)],
  ]);
  const r = await coverTargetsAtEpoch(['a', 'b', 'c', 'd', 'e'], {
    fresh: () => true, take: async () => {}, classify, log: () => {},
    publish: async (t) => { const f = fails.get(t); if (f) throw f; published.push(t); return { status: 'stored' }; },
  });
  assert.deepEqual(r.covered, ['a', 'c']);
  assert.equal(r.stop, 'rate_limited');
  assert.deepEqual(published, ['a', 'c']);

  const r2 = await coverTargetsAtEpoch(['a', 'b'], {
    fresh: () => true, take: async () => {}, classify, log: () => {},
    publish: async (t) => { if (t === 'a') throw new KeyCommitmentConflictError(null, 'arbitrated', 3); return { status: 'stored' }; },
  });
  assert.deepEqual([r2.covered, r2.stop], [[], 'conflict']);
});

test('cover: an account switch stops BEFORE the next publish', async () => {
  let gen = 1;
  const published: string[] = [];
  await assert.rejects(coverTargetsAtEpoch(['a', 'b', 'c'], {
    fresh: () => gen === 1, take: async () => {}, classify: () => 'transient', log: () => {},
    publish: async (t) => { published.push(t); if (t === 'a') gen++; return { status: 'stored' }; },
  }), StaleAccountError);
  assert.deepEqual(published, ['a']);
});

// --- Own-device re-bind backoff --------------------------------------------------------------

test('re-bind: never against nodes that keep no bindings; 1 h → 4 h → 24 h; 1 h after a 429', () => {
  assert.equal(nodeKeepsBindings({ version: '0.141.9' }), false);
  assert.equal(nodeKeepsBindings({ version: '0.142.0' }), true);
  assert.equal(nodeKeepsBindings({ version: '0.143.1', features: [] }), true);
  assert.equal(nodeKeepsBindings({ features: ['key_commitment_v1'] }), true);
  assert.equal(nodeKeepsBindings({ version: 'garbage' }), false);
  assert.equal(nodeKeepsBindings(null), false);

  const s = memStore();
  const t0 = 1_000_000;
  assert.equal(rebindAllowed(s, ME, 'd1', 'e1', t0, false), false, 'old node: never');
  assert.equal(rebindAllowed(s, ME, 'd1', 'e1', t0, true), true);
  noteRebindAttempt(s, ME, 'd1', 'e1', t0, false);
  assert.equal(rebindAllowed(s, ME, 'd1', 'e1', t0 + REBIND_BACKOFF_MS[0] - 1, true), false);
  assert.equal(rebindAllowed(s, ME, 'd1', 'e1', t0 + REBIND_BACKOFF_MS[0], true), true);
  const t1 = t0 + REBIND_BACKOFF_MS[0];
  noteRebindAttempt(s, ME, 'd1', 'e1', t1, false);
  assert.equal(rebindAllowed(s, ME, 'd1', 'e1', t1 + REBIND_BACKOFF_MS[1] - 1, true), false);
  const t2 = t1 + REBIND_BACKOFF_MS[1];
  noteRebindAttempt(s, ME, 'd1', 'e1', t2, false);
  assert.equal(rebindAllowed(s, ME, 'd1', 'e1', t2 + REBIND_BACKOFF_MS[2] - 1, true), false);
  noteRebindAttempt(s, ME, 'd1', 'e1', t2 + REBIND_BACKOFF_MS[2], false);
  assert.equal(rebindAllowed(s, ME, 'd1', 'e1', t2 + 2 * REBIND_BACKOFF_MS[2] - 1, true), false, 'stays at 24 h');
  assert.equal(rebindAllowed(s, ME, 'd1', 'e2', t2, true), true, 'per enc_pub');
  assert.equal(rebindAllowed(s, M1, 'd1', 'e1', t2, true), true, 'per wallet');

  const s2 = memStore();
  noteRebindAttempt(s2, ME, 'd1', 'e1', t0, false);
  noteRebindAttempt(s2, ME, 'd1', 'e1', t0, true);
  assert.equal(rebindAllowed(s2, ME, 'd1', 'e1', t0 + REBIND_429_BACKOFF_MS - 1, true), false);
  assert.equal(rebindAllowed(s2, ME, 'd1', 'e1', t0 + REBIND_429_BACKOFF_MS, true), true);
  noteRebindAttempt(s2, ME, 'd1', 'e1', t0 + REBIND_429_BACKOFF_MS, false);
  assert.equal(rebindAllowed(s2, ME, 'd1', 'e1', t0 + REBIND_429_BACKOFF_MS + REBIND_BACKOFF_MS[1] - 1, true), false, 'a 429 is not an extra attempt (2nd attempt → 4 h)');
  clearRebindBackoff(s2, ME);
  assert.equal(rebindAllowed(s2, ME, 'd1', 'e1', t0, true), true);
});

// --- Stale enc-key revocation ----------------------------------------------------------------

test('revoke only rows of OUR device id whose binding verifies; never the current key or unverifiable rows', async () => {
  const rows: EncRow[] = [
    { device_id: 'D1', enc_pub: 'cur' },
    { device_id: 'd1', enc_pub: 'old-bound' },
    { device_id: 'd1', enc_pub: 'old-unbound' },
    { device_id: 'd1', enc_pub: 'old-forged' },
    { device_id: 'd2', enc_pub: 'other-device' },
    { device_id: 'd1', enc_pub: 'old-revoked', revoked: true },
  ];
  const verdict: Record<string, string> = { 'old-bound': 'bound', 'old-unbound': 'unbound', 'old-forged': 'invalid', 'other-device': 'bound', cur: 'bound' };
  const out = await revocableEncRows(rows, ME, 'd1', 'CUR', NET, async (r) => {
    if (r.enc_pub === 'old-forged') throw new Error('boom');
    return { status: verdict[r.enc_pub] ?? 'invalid' };
  });
  assert.deepEqual(out.map((r) => r.enc_pub), ['old-bound']);
});

// --- Round-2 audit: gated moves, hop cap, waiting, outcome guard, evidence rule --------------

test('W2: a legacy move is gated (once per channel per 10 min); a gated move keeps the epoch persisted', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  node.legacyEpochs.add(4);
  const a = acct(clock);
  a.gate.tryEscalate(PRIV); // the gate was used moments ago (e.g. a heal)
  const store = memStore();
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')]), a, store, { epoch: 4, epochKnownToExist: true, mode: 'verify' });
  assert.deepEqual([r.kind, r.kind === 'rekeying' ? r.reason : ''], ['rekeying', 'escalation_gated']);
  assert.equal(node.publishes, 0);
  assert.deepEqual(loadPendingEpochs(store, ME, NET).get(PRIV), { epoch: 4, mode: 'verify' }, 'retried later at the same epoch');
  clock.t += 10 * 60_000 + 1;
  const r2 = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')]), a, store, { epoch: 4, epochKnownToExist: true, mode: 'verify' });
  assert.deepEqual([r2.kind, r2.epoch], ['key', 5]);
});

test('W2: an epochTooLow move is gated too', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const a = acct(clock);
  a.gate.tryEscalate(PRIV);
  const low = io(node, ME, 'a1', [dev(ME, 'a1')], {
    publish: async () => { throw new KeyEnvelopeRejectedError(400, 'key_epoch_below_floor'); },
  });
  const r = await runEpochKey(low, a, memStore(), { epoch: 2, epochKnownToExist: false, mode: 'verify' });
  assert.deepEqual([r.kind, r.kind === 'rekeying' ? r.reason : ''], ['rekeying', 'escalation_gated']);
});

test('hop cap: with maxHops 1 a legacy epoch does not move; the persisted epoch is cleared', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  node.legacyEpochs.add(4);
  const store = memStore();
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')]), acct(clock), store, { epoch: 4, epochKnownToExist: true, mode: 'verify', maxHops: 1 });
  assert.deepEqual([r.kind, r.kind === 'rekeying' ? r.reason : ''], ['rekeying', 'hop_cap']);
  assert.equal(node.publishes, 0);
  assert.equal(loadPendingEpochs(store, ME, NET).size, 0);
});

test('a waiting outcome (in_flight) keeps the persisted epoch', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const a = acct(clock);
  const store = memStore();
  const x = io(node, ME, 'a1', [dev(ME, 'a1')]);
  const first = runEpochKey(x, a, store, { epoch: 2, epochKnownToExist: false, mode: 'verify' });
  await new Promise<void>((r) => setImmediate(r));
  const second = await runEpochKey(x, a, store, { epoch: 2, epochKnownToExist: false, mode: 'verify' });
  assert.deepEqual([second.kind, second.kind === 'rekeying' ? second.reason : ''], ['rekeying', 'in_flight']);
  assert.deepEqual(loadPendingEpochs(store, ME, NET).get(PRIV), { epoch: 2, mode: 'verify' });
  assert.equal((await first).kind, 'key');
});

test('guard after the outcome: a switch right as the SDK returns ends the call (StaleAccountError)', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const steps: string[] = [];
  const x = io(node, ME, 'a1', [dev(ME, 'a1')], {
    isSelfBound: async () => false,
    // The account is gone exactly at the check that follows the SDK's return.
    fresh: (step?: string) => { steps.push(step ?? ''); return step !== 'outcome'; },
  });
  await assert.rejects(runEpochKey(x, acct(clock), memStore(), { epoch: 1, epochKnownToExist: false, mode: 'verify' }), StaleAccountError);
  assert.equal(steps.at(-1), 'outcome');
});

test('B2(a): holding ANY key at epoch E makes E known to exist — a fresh node never gets a new key at E', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV); // knows nothing (fresh / lagging)
  const r = await runEpochKey(
    io(node, ME, 'a1', [dev(ME, 'a1')], { holdsKeyAt: (e) => e === 6 }),
    acct(clock), memStore(), { epoch: 6, epochKnownToExist: false, mode: 'verify', maxHops: 1 },
  );
  assert.notEqual(r.kind, 'key');
  assert.equal(node.winners.has(6), false, 'no conflicting key created at the held epoch');
  // Control: without the held key the same call creates epoch 6.
  const r2 = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')]), acct(clock), memStore(), { epoch: 6, epochKnownToExist: false, mode: 'verify', maxHops: 1 });
  assert.deepEqual([r2.kind, r2.epoch], ['key', 6]);
});

test('B2 regression: a hostile commitment-less wrap at epoch 100000 + restart never becomes evidence', async () => {
  const gen = 1;
  const s1 = new ChannelKeys(() => gen, () => {});
  const scope = keyCommitmentToHex(computeChannelScope(PRIV)); // hex of the scope bytes
  const k3 = webcrypto.getRandomValues(new Uint8Array(32));
  const meta3 = { keyTs: 5, keyCommitment: computeKeyCommitment(computeChannelScope(PRIV), 3, 5, k3) };
  s1.put(scope, 3, k3, 1, { source: 'establish', meta: meta3, verified: true, final: true });
  s1.put(scope, 100000, webcrypto.getRandomValues(new Uint8Array(32)), 1, { source: 'legacy' });
  assert.equal(s1.evidence(scope, 3), 3);
  // Restart: everything comes back from the vault (provenance lost).
  const s2 = new ChannelKeys(() => gen, () => {});
  s2.importFromVault(s1.prepareExport(gen).chan, gen);
  assert.equal(s2.evidence(scope, 100000), 0, 'vault keys are not evidence, whatever the node claims');
  assert.equal(s2.healEligible(scope, 100000, 100000), false);
  // A rotation on an honest node still works (not node_lagging / unrecoverable).
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const r = await runEpochKey(
    io(node, ME, 'a1', [dev(ME, 'a1')], { highestEpochSeen: () => s2.evidence(scope, 0), holdsKeyAt: (e) => s2.holds(scope, e) }),
    acct(clock), memStore(), { epoch: 4, epochKnownToExist: false, mode: 'verify' },
  );
  assert.deepEqual([r.kind, r.epoch], ['key', 4]);
  // Control: had the hostile epoch counted as evidence, the same call is bricked.
  const r2 = await runEpochKey(
    io(node, ME, 'a1', [dev(ME, 'a1')], { highestEpochSeen: () => 100000 }),
    acct(clock), memStore(), { epoch: 5, epochKnownToExist: false, mode: 'verify' },
  );
  assert.deepEqual([r2.kind, r2.kind === 'blocked' ? r2.reason : ''], ['blocked', 'node_unrecoverable']);
});

// --- Unified peer rule, end to end with the SDK ------------------------------------------------

const http = (status: number) => new Error(`API error (${status}): x`);

test('peers: every peer 404 → [] → the key confirms on the home node', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')], {
    peerCommitments: () => queryPeerCommitments(['p1', 'p2'], async () => { throw http(404); }),
  }), acct(clock), memStore(), { epoch: 1, epochKnownToExist: false, mode: 'verify' });
  assert.equal(r.kind, 'key');
});

test('peers: one 404 + one down → throw → the key stays unconfirmed', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')], {
    peerCommitments: () => queryPeerCommitments(['p1', 'p2'], async (p) => { throw p === 'p1' ? http(404) : new Error('timeout'); }),
    options: { maxTotalMs: 200_000 },
  }), acct(clock), memStore(), { epoch: 1, epochKnownToExist: false, mode: 'verify' });
  assert.notEqual(r.kind, 'key');
});

test('peers: one answer + one down → the answer counts → the key confirms', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')], {
    peerCommitments: (e) => queryPeerCommitments(['p1', 'p2'], async (p) => {
      if (p === 'p2') throw http(503);
      return node.info(e); // an honest peer that agrees with the home node
    }),
  }), acct(clock), memStore(), { epoch: 1, epochKnownToExist: false, mode: 'verify' });
  assert.equal(r.kind, 'key');
});

test('cover: key_ts_stale (our pair is not the winner here) stops the pass', async () => {
  const published: string[] = [];
  const r = await coverTargetsAtEpoch(['a', 'b'], {
    fresh: () => true, take: async () => {}, log: () => {},
    classify: (e) => (e instanceof KeyEnvelopeRejectedError && e.code === 'key_ts_stale' ? 'stale' : 'transient'),
    publish: async (t) => { if (t === 'a') throw new KeyEnvelopeRejectedError(400, 'key_ts_stale'); published.push(t); return { status: 'stored' }; },
  });
  assert.deepEqual([r.covered, r.stop, published], [[], 'stale', []]);
});

test('cover: a switch while waiting for a rate token stops before that publish', async () => {
  let gen = 1;
  const published: string[] = [];
  await assert.rejects(coverTargetsAtEpoch(['a'], {
    fresh: () => gen === 1, take: async () => { gen++; }, classify: () => 'transient', log: () => {},
    publish: async (t) => { published.push(t); return { status: 'stored' }; },
  }), StaleAccountError);
  assert.deepEqual(published, []);
});

// --- Round 3 B1: hostile epoch inflation is refused locally ---------------------------------

test('B1 (floor vector): a node-served floor of 100000 never gets a key established — blocked, nothing published', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  const store = memStore();
  const p = planRotation(100000, node.info(), 3); // the hostile floor drives the plan …
  assert.equal(p.epoch, 100000);
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')]), acct(clock), store, { epoch: p.epoch, epochKnownToExist: false, mode: 'verify' });
  assert.deepEqual([r.kind, r.kind === 'blocked' ? r.reason : '', r.kind === 'blocked' ? r.detail : ''], ['blocked', 'epoch_too_high', 'local_guard']);
  assert.equal(node.publishes, 0, '… but the local guard refuses it before anything is published');
  assert.equal(loadPendingEpochs(store, ME, NET).size, 0, 'and it is never resumed');
  assert.equal(epochWithinReach(256, 0), true);
  assert.equal(epochWithinReach(257, 0), false);
  assert.equal(epochWithinReach(300, 44), true);
});

test('B1 (legacy-wrap vector): a hostile commitment-less key at 100000 does not set the next epoch', async () => {
  const st = new ChannelKeys(() => 1, () => {});
  const scope = computeChannelScope(PRIV);
  const sh = keyCommitmentToHex(scope); // hex of the scope bytes
  const k3 = webcrypto.getRandomValues(new Uint8Array(32));
  st.put(sh, 3, k3, 1, { source: 'establish', meta: { keyTs: 5, keyCommitment: computeKeyCommitment(scope, 3, 5, k3) }, verified: true, final: true });
  st.put(sh, 100000, webcrypto.getRandomValues(new Uint8Array(32)), 1, { source: 'legacy' });
  assert.equal(st.sendKey(sh, 0, { preArbitration: false })!.epoch, 3, 'the legacy key does not outrank the verified one');
  const clock = new Clock();
  const node = new FakeNode(clock, PRIV);
  // The home node knows nothing yet (fresh): our evidence (3) sets the base.
  const next = planNextEpoch(node.info(), st.evidence(sh, node.info().epoch));
  assert.equal(next.epoch, 4, 'max(evidence, node highest) + 1 — never the raw cached 100000 + 1');
  const info = (e: number): KeyCommitmentInfo => ({ channel_id: PRIV, epoch: e, state: 'legacy', final: true, finality_ms: FINALITY });
  assert.equal(planNextEpoch(info(9), 3).epoch, 10, 'the node\'s highest when it is higher');
  assert.equal(planNextEpoch(info(0), 0).epoch, 1);
  const r = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')]), acct(clock), memStore(), { epoch: next.epoch, epochKnownToExist: false, mode: 'verify' });
  assert.deepEqual([r.kind, r.epoch], ['key', 4]);
  // Even a hostile plan of 100001 (the old behaviour) is refused locally.
  const r2 = await runEpochKey(io(node, ME, 'a1', [dev(ME, 'a1')]), acct(clock), memStore(), { epoch: 100001, epochKnownToExist: false, mode: 'verify' });
  assert.equal(r2.kind, 'blocked');
});
