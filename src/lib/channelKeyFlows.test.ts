/**
 * Behaviour tests of the channel key FLOW decisions (channelKeyFlows.ts)
 * against the REAL SDK keyring — desktop 1.85.0. Run:
 *   node --conditions=browser --test src/lib/channelKeyFlows.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChannelScope, computeKeyCommitment, keyCommitmentToHex, type KeyCommitmentInfo } from '@ogmara/sdk';
import { ChannelKeys } from './channelKeyStore.ts';
import { ownSlotWrapOpts, putLegacyKey, markFinalFromCommitment } from './channelKeyFlows.ts';

const CID = 2 ** 32 + 9;
const SCOPE = computeChannelScope(CID);
const S = Buffer.from(SCOPE).toString('hex');
const k = (b: number) => new Uint8Array(32).fill(b);
const meta = (epoch: number, key: Uint8Array, keyTs = 7) => ({ keyTs, keyCommitment: computeKeyCommitment(SCOPE, epoch, keyTs, key) });
const ME = 'klv1' + 'a'.repeat(58);
const OTHER = 'klv1' + 'c'.repeat(58);
const info = (epoch: number, key: Uint8Array, keyTs = 7, final = true): KeyCommitmentInfo => ({
  channel_id: CID, epoch, state: 'arbitrated', key_commitment: keyCommitmentToHex(computeKeyCommitment(SCOPE, epoch, keyTs, key)),
  key_ts: keyTs, final, finality_ms: 120_000,
});

test('ownSlot exactly when the wrap\'s verified author is OUR wallet: our wraps pass a full member cap, others are refused', () => {
  const keys = new ChannelKeys(() => 1, () => {}, { maxMemberEpochsPerScope: 2 });
  assert.equal(ownSlotWrapOpts(ME, ME, meta(1, k(1)), 10).ownSlot, true);
  assert.equal(ownSlotWrapOpts(OTHER, ME, meta(1, k(1)), 10).ownSlot, false);
  for (const e of [2, 3]) assert.equal(keys.put(S, e, k(e), 1, ownSlotWrapOpts(OTHER, ME, meta(e, k(e)), 10)), 'stored');
  // Member cap full: another member's next wrap is refused …
  assert.equal(keys.put(S, 4, k(4), 1, ownSlotWrapOpts(OTHER, ME, meta(4, k(4)), 10)), 'refused');
  // … our own (same call shape, our author) is never member-capped.
  assert.equal(keys.put(S, 5, k(5), 1, ownSlotWrapOpts(ME, ME, meta(5, k(5)), 10)), 'stored');
  assert.equal(keys.entriesAt(S, 5)[0]!.trusted, true);
});

test('a member wrap above the node\'s highest + 256 is refused; ours is not bounded', () => {
  const keys = new ChannelKeys(() => 1, () => {});
  assert.equal(keys.put(S, 300, k(3), 1, ownSlotWrapOpts(OTHER, ME, meta(300, k(3)), 0)), 'refused');
  assert.equal(keys.put(S, 300, k(4), 1, ownSlotWrapOpts(ME, ME, meta(300, k(4)), 0)), 'stored');
});

test('legacy key: held as `legacy` (never trusted, never a send key), bounded by the node\'s highest + 256', () => {
  const keys = new ChannelKeys(() => 1, () => {});
  assert.equal(putLegacyKey(keys, S, 5, k(5), 1, 10), 'held');
  const e = keys.entriesAt(S, 5)[0]!;
  assert.equal(e.source, 'legacy');
  assert.equal(e.trusted, false);
  assert.equal(keys.sendKey(S, 10), null);
  // Flood far above the node's reach: refused and NOT held → missing (vault restore, never "corrupt").
  assert.equal(putLegacyKey(keys, S, 100_000, k(9), 1, 10), 'missing');
  assert.equal(keys.holds(S, 100_000), false);
});

test('legacy key refused while another key IS held at the epoch → held (decrypt with what we have)', () => {
  const keys = new ChannelKeys(() => 1, () => {});
  assert.equal(putLegacyKey(keys, S, 6, k(6), 1, 10), 'held');
  // A commitment-less duplicate at an occupied epoch is refused by the keyring.
  assert.equal(putLegacyKey(keys, S, 6, k(0x66), 1, 10), 'held');
  assert.deepEqual(keys.keysAt(S, 6).map((x) => x[0]), [6]);
});

test('a flow put after an account switch uses the CAPTURED generation and is dropped', () => {
  let gen = 1;
  const keys = new ChannelKeys(() => gen, () => {});
  const captured = gen;
  gen = 2; // switch while the old account's fetch was in flight
  assert.equal(putLegacyKey(keys, S, 1, k(1), captured, 10), 'missing');
  assert.equal(keys.put(S, 1, k(1), captured, ownSlotWrapOpts(ME, ME, meta(1, k(1)), 10)), 'stale');
  assert.equal(keys.holds(S, 1), false);
});

test('finality: only the EXACT pair the node reports final is marked; a different winner / keyTs / non-final never is', () => {
  const keys = new ChannelKeys(() => 1, () => {});
  keys.put(S, 3, k(3), 1, ownSlotWrapOpts(OTHER, ME, meta(3, k(3)), 10));
  assert.equal(markFinalFromCommitment(keys, S, 3, info(3, k(0x33)), 1), false, 'the node\'s winner is another key');
  assert.equal(markFinalFromCommitment(keys, S, 3, info(3, k(3), 8), 1), false, 'same key, different keyTs');
  assert.equal(markFinalFromCommitment(keys, S, 3, info(3, k(3), 7, false), 1), false, 'not final yet');
  assert.equal(markFinalFromCommitment(keys, S, 3, { ...info(3, k(3)), epoch: 4 }, 1), false, 'another epoch');
  assert.equal(keys.sendKey(S, 10), null);
  assert.equal(markFinalFromCommitment(keys, S, 3, info(3, k(3)), 1), true);
  assert.equal(keys.sendKey(S, 10)!.epoch, 3);
});

test('finality is never granted to a key that is not author-verified (legacy / vault)', () => {
  const keys = new ChannelKeys(() => 1, () => {});
  putLegacyKey(keys, S, 2, k(2), 1, 10);
  assert.equal(markFinalFromCommitment(keys, S, 2, info(2, k(2)), 1), false);
  assert.equal(keys.sendKey(S, 10), null);
});
