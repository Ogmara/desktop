/**
 * Desktop wiring over the SHARED SDK keyring (desktop 1.85.0, `@ogmara/sdk`
 * 0.68.0 `ChannelKeyring`). The keyring's own rules (rank, caps, vault names,
 * never-lose) are tested in sdk-js; these tests pin what the DESKTOP adapter
 * adds — the generation guard, the bounded evidence / send rule, the restart
 * re-verification flow — and the adoption guarantees (old vaults lose
 * nothing, real seal / open round trips). Run:
 *   node --conditions=browser --test src/lib/channelKeyStore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelKeyringError,
  computeChannelScope,
  computeKeyCommitment,
  openKeyVault,
  sealKeyVault,
} from '@ogmara/sdk';
import { ChannelKeys, maxEpochFor } from './channelKeyStore.ts';

const CID = 2 ** 32 + 5;
const SCOPE = computeChannelScope(CID);
const S = Buffer.from(SCOPE).toString('hex');
const k = (b: number) => new Uint8Array(32).fill(b);
const meta = (epoch: number, key: Uint8Array, keyTs = 7) => ({ keyTs, keyCommitment: computeKeyCommitment(SCOPE, epoch, keyTs, key) });
const BACKUP_KEY = new Uint8Array(32).fill(0x42);
const mk = (gen: () => number = () => 1, onChange: () => void = () => {}) => new ChannelKeys(gen, onChange);
/** Our own final key / a verified own-slot wrap, as channelCrypto caches them. */
const putFinal = (st: ChannelKeys, e: number, key: Uint8Array, source: 'establish' | 'wrap' = 'establish') =>
  st.put(S, e, key, 1, { source, meta: meta(e, key), verified: true, final: true });
/** A published backup: prepare, then commit (as keyVault.ts does after the node accepted it). */
const exp = (st: ChannelKeys): Record<string, Uint8Array> => {
  const p = st.prepareExport(1);
  st.commitExport(p.token, 1);
  return p.chan;
};
const restart = (st: ChannelKeys) => {
  const next = mk();
  next.importFromVault(exp(st), 1);
  return next;
};

test('a write after an account switch is dropped (generation guard); a current one lands and notifies', () => {
  let gen = 1;
  let changes = 0;
  const st = mk(() => gen, () => { changes++; });
  gen = 2; // switch while the old account's fetch was in flight
  assert.equal(st.put(S, 1, k(1), 1, { source: 'wrap', meta: meta(1, k(1)), verified: true }), 'stale');
  assert.equal(st.holds(S, 1), false);
  assert.equal(changes, 0);
  assert.equal(st.put(S, 1, k(1), 2, { source: 'wrap', meta: meta(1, k(1)), verified: true }), 'stored');
  assert.equal(changes, 1);
  assert.equal(st.markFinal(S, 1, k(1), meta(1, k(1)), 1), 'stale', 'markFinal is guarded too');
  assert.throws(() => st.prepareExport(1), (e: unknown) => e instanceof ChannelKeyringError && e.code === 'stale');
  assert.throws(() => st.importFromVault({}, 1), (e: unknown) => e instanceof ChannelKeyringError && e.code === 'stale');
});

test('the keyring returns COPIES: mutating a returned key or the caller buffer never changes it (byte comparison needed)', () => {
  const st = mk();
  const mine = k(5);
  putFinal(st, 1, mine);
  mine.fill(0); // e.g. the SDK zeroing its result after we cached it
  const a = st.keysAt(S, 1)[0]!;
  assert.deepEqual(a, k(5));
  a.fill(9);
  assert.deepEqual(st.keysAt(S, 1)[0], k(5));
  const e = st.entriesAt(S, 1)[0]!;
  assert.notEqual(e.key, st.entriesAt(S, 1)[0]!.key, 'never the same reference twice');
});

test('send rule: only a trusted FINAL key; a trusted not-final one waits; markFinal makes it sendable', () => {
  const st = mk();
  assert.equal(st.put(S, 3, k(3), 1, { source: 'wrap', meta: meta(3, k(3)), verified: true }), 'stored');
  assert.equal(st.sendKey(S, 3), null, 'not final yet: rotations wait for FINAL');
  assert.deepEqual(st.trustProbe(S, 3), { epoch: 3, kind: 'final' });
  assert.equal(st.evidence(S, 3), 3, 'a trusted key is evidence before it is final');
  assert.equal(st.markFinal(S, 3, k(3), meta(3, k(3)), 1), 'verified');
  assert.equal(st.sendKey(S, 3)!.epoch, 3);
  assert.equal(st.trustProbe(S, 3), null);
});

test('the creator\'s provisional first key: sendable at epoch 1 only, never evidence, never backed up until final', () => {
  const st = mk();
  assert.equal(st.put(S, 1, k(1), 1, { source: 'establish', provisional: true, verified: true, meta: meta(1, k(1)) }), 'stored');
  assert.equal(st.sendKey(S, 0)!.provisional, true);
  assert.equal(st.evidence(S, 0), 0);
  assert.deepEqual(exp(st), {}, 'never backed up while provisional');
  assert.equal(st.trustProbe(S, 0), null, 'the drive finalises it, no probe');
  // A provisional key at any other epoch is never a send key.
  const st2 = mk();
  st2.put(S, 2, k(2), 1, { source: 'establish', provisional: true, verified: true, meta: meta(2, k(2)) });
  assert.equal(st2.sendKey(S, 2), null);
  // The drive's FINAL key (same bytes) finalises it: exported, evidence.
  putFinal(st, 1, k(1));
  assert.equal(st.evidence(S, 1), 1);
  assert.deepEqual(Object.keys(exp(st)).filter((n) => !n.includes('#')), [`${S}:1`]);
});

test('restart: every key comes back as `vault` — nothing trusted / sendable until the own-slot wrap is re-put as `wrap`', () => {
  const st = mk();
  putFinal(st, 2, k(2));
  putFinal(st, 3, k(3));
  const st2 = restart(st);
  assert.equal(st2.evidence(S, 3), 0, 'vault keys are not evidence');
  assert.equal(st2.sendKey(S, 3), null, 'never sent under an unverified vault key');
  assert.equal(st2.healEligible(S, 3, 3), false);
  assert.deepEqual(st2.trustProbe(S, 3), { epoch: 3, kind: 'verify' });
  // channelCrypto: verifyChannelKeyWrap → cacheVerified(source 'wrap').
  assert.equal(st2.put(S, 3, k(3), 1, { source: 'wrap', meta: meta(3, k(3)), verified: true }), 'stored', 'same bytes merge');
  assert.equal(st2.evidence(S, 3), 3);
  assert.deepEqual(st2.trustProbe(S, 3), { epoch: 3, kind: 'final' });
  st2.markFinal(S, 3, k(3), meta(3, k(3)), 1);
  assert.equal(st2.sendKey(S, 3)!.epoch, 3);
  assert.equal(st2.healEligible(S, 3, 3), true);
  assert.equal(st2.healEligible(S, 2, 3), false, 'an older epoch is no split signal');
});

test('a vault key cannot be trusted by a persisted pair alone (markFinal needs author proof)', () => {
  const st = restart((() => { const s = mk(); putFinal(s, 4, k(4)); return s; })());
  assert.equal(st.markFinal(S, 4, k(4), meta(4, k(4)), 1), 'needs_author_proof');
  assert.equal(st.evidence(S, 4), 0);
});

test('hostile commitment-less key at epoch 100000 + restart: never evidence, never a send key, never probed', () => {
  const st = mk();
  putFinal(st, 3, k(3));
  assert.equal(st.put(S, 100000, k(0xee), 1, { source: 'legacy' }), 'stored');
  assert.equal(st.evidence(S, 3), 3);
  assert.equal(st.sendKey(S, 3)!.epoch, 3, 'the legacy key does not outrank the verified one');
  assert.equal(st.trustProbe(S, 3), null, 'out of reach of the node (highest + 256): never probed');
  const st2 = restart(st);
  for (const nh of [0, 3, 99_999]) {
    assert.equal(st2.evidence(S, nh), 0);
    assert.notEqual(st2.sendKey(S, nh)?.epoch, 100000);
  }
  // Even once our own epoch 3 is re-verified, 100000 stays out.
  st2.put(S, 3, k(3), 1, { source: 'wrap', meta: meta(3, k(3)), verified: true, final: true });
  assert.equal(st2.evidence(S, 3), 3);
  assert.equal(st2.sendKey(S, 3)!.epoch, 3);
});

test('evidence and send keys are BOUNDED by the node\'s highest + 256 (a malicious member\'s far wrap)', () => {
  const st = mk();
  putFinal(st, 3, k(3));
  putFinal(st, 10_000, k(0x77), 'wrap'); // author-verified by a (malicious) member, called final
  assert.equal(maxEpochFor(3), 259);
  assert.equal(st.evidence(S, 3), 3);
  assert.equal(st.sendKey(S, 3)!.epoch, 3);
  assert.equal(st.alreadyAt(S, 10_000, 3), false);
  assert.equal(st.evidence(S, 9_800), 10_000, 'within reach once the node really is there');
  assert.equal(maxEpochFor(Number.NaN), 256, 'an unreadable highest counts as 0');
});

test('verified-over-legacy: a verified wrap promotes over a node-served legacy key at the same epoch (both kept)', () => {
  const st = mk();
  st.put(S, 5, k(0x50), 1, { source: 'legacy' });
  assert.equal(st.put(S, 5, k(5), 1, { source: 'wrap', meta: meta(5, k(5)), verified: true, final: true }), 'promoted');
  assert.deepEqual(st.keysAt(S, 5).map((x) => x[0]), [5, 0x50], 'the legacy key stays for decryption');
  assert.equal(st.sendKey(S, 5)!.key[0], 5);
});

test('alternates + conflict: a different trusted key at a held epoch is kept, reported as conflict, and backed up', () => {
  const st = mk();
  putFinal(st, 6, k(6));
  assert.equal(st.put(S, 6, k(0x66), 1, { source: 'wrap', meta: meta(6, k(0x66)), verified: true }), 'conflict');
  assert.deepEqual(st.keysAt(S, 6).map((x) => x[0]), [6, 0x66], 'primary first, then the alternate');
  const out = exp(st);
  assert.deepEqual(out[`${S}:6`], k(6));
  assert.equal(Object.values(out).filter((v) => v[0] === 0x66).length, 1, 'the alternate is in the backup');
  const back = mk();
  back.importFromVault(out, 1);
  assert.deepEqual(back.keysAt(S, 6).map((x) => x[0]).sort((a, b) => a - b), [6, 0x66]);
});

test('importing an OLD desktop/mobile/web vault loses nothing (S:E, #alt1..#alt4, legacy ~n, unknown names)', () => {
  const fixture: Record<string, Uint8Array> = {
    [`${S}:3`]: k(30), [`${S}:3#alt1`]: k(31), [`${S}:3#alt2`]: k(32), [`${S}:3#alt3`]: k(33), [`${S}:3#alt4`]: k(34),
    [`${S}:4~1`]: k(41), [`${S}:5#alt1`]: k(51), 'zzz-unknown': k(99), 'odd-key:3': k(98),
  };
  const st = mk();
  assert.equal(st.importFromVault(fixture, 1), Object.keys(fixture).length);
  assert.deepEqual(st.keysAt(S, 3).map((x) => x[0]), [30, 31, 32, 33, 34]);
  assert.deepEqual(st.keysAt(S, 4).map((x) => x[0]), [41]);
  const out = exp(st);
  const values = (r: Record<string, Uint8Array>) => Object.values(r).map((v) => v[0]).sort((a, b) => a - b);
  for (const v of Object.values(fixture)) assert.ok(values(out).includes(v[0]!), `value ${v[0]} kept`);
  assert.deepEqual(out['zzz-unknown'], k(99), 'unknown entries re-exported byte-identical');
  assert.deepEqual(out[`${S}:3`], k(30), 'the primary keeps its name');
  // Stable from then on.
  const st2 = mk();
  st2.importFromVault(out, 1);
  assert.deepEqual(exp(st2), out);
});

test('vault round trip through the REAL sealKeyVault / openKeyVault (keyVault.ts snapshot shape)', () => {
  const st = mk();
  putFinal(st, 1, k(1));
  st.put(S, 1, k(0x11), 1, { source: 'wrap', meta: meta(1, k(0x11)), verified: true });
  st.put(S, 2, k(0x22), 1, { source: 'legacy' });
  st.importFromVault({ 'other-client-entry': k(0x99) }, 1);
  const sealed = sealKeyVault(BACKUP_KEY, { conv: {}, chan: exp(st) });
  const opened = openKeyVault(BACKUP_KEY, sealed);
  const fresh = mk();
  fresh.importFromVault(opened.chan, 1);
  assert.deepEqual(fresh.keysAt(S, 1).map((x) => x[0]), [1, 0x11]);
  assert.deepEqual(fresh.keysAt(S, 2).map((x) => x[0]), [0x22]);
  assert.deepEqual(exp(fresh)['other-client-entry'], k(0x99));
});

test('a key cached BEFORE the restore survives the restore and is in the next backup', () => {
  const st = mk();
  putFinal(st, 9, k(9)); // cached in this session before the vault was pulled
  const remote = sealKeyVault(BACKUP_KEY, { conv: {}, chan: { [`${S}:8`]: k(8), [`${S}:9`]: k(0x90) } });
  st.importFromVault(openKeyVault(BACKUP_KEY, remote).chan, 1);
  const out = exp(st);
  assert.deepEqual(out[`${S}:9`], k(9), 'our key keeps the primary name');
  assert.ok(Object.values(out).some((v) => v[0] === 0x90), 'the other device\'s key at the same epoch is kept');
  assert.deepEqual(out[`${S}:8`], k(8));
  assert.equal(st.evidence(S, 9), 9, 'trust of the cached key is not lowered by the restore');
});

test('vault_too_large is THROWN (surfaced as "backup paused"), never a silently shrunk backup', () => {
  const st = new ChannelKeys(() => 1, () => {}, { maxVaultBytes: 400 });
  for (let e = 1; e <= 10; e++) putFinal(st, e, k(e));
  assert.throws(() => st.prepareExport(1), (e: unknown) => e instanceof ChannelKeyringError && e.code === 'vault_too_large');
});

test('clear() empties the keyring (account switch / sign-out)', () => {
  const st = mk();
  putFinal(st, 1, k(1));
  st.clear();
  assert.equal(st.size, 0);
  assert.equal(st.holds(S, 1), false);
});

test('prune ladder: default level is node-served only; member flood → restored alternates (at-risk warning) → primaries last', () => {
  // A restored vault: own history under PRIMARY names, an older client's alternates.
  const rec: Record<string, Uint8Array> = {};
  for (let e = 1; e <= 40; e++) rec[`${S}:${e}`] = k(e);
  for (let e = 1; e <= 5; e++) rec[`${S}:${e}#alt1`] = k(100 + e);
  const st = new ChannelKeys(() => 1, () => {}, { maxVaultBytes: 3000 });
  st.importFromVault(rec, 1);
  for (let e = 41; e <= 45; e++) st.put(S, e, k(150 + e), 1, { source: 'legacy', nodeHighest: 50 }); // node-served
  assert.throws(() => st.prepareExport(1), (e: unknown) => e instanceof ChannelKeyringError && e.code === 'vault_too_large');
  // Level order: node-served first (zero risk), primaries never before the last step.
  const first = st.nextPrunePlan(1);
  assert.ok(first);
  assert.equal(first!.level === 'nodeServed' || first!.level === 'restoredAlternates', true);
  assert.equal(first!.result.byClass.restoredPrimaries.count, 0, 'own history is never in an earlier step');
  const alts = st.planPrune('restoredAlternates', 1);
  assert.equal(alts.result.byClass.restoredAlternates.count, 5);
  assert.equal(alts.result.byClass.ownAlternatesAtRisk.count, 5, 'the confirm warns: they MAY be the user\'s own');
  assert.equal(st.holds(S, 1), true, 'a dry run changes nothing');
  assert.equal(st.applyPrune(alts, 1).removedCount, 5);
  assert.deepEqual(st.keysAt(S, 1).map((x) => x[0]), [1], 'the primary-name key stays');
  const prim = st.planPrune('restoredPrimaries', 1);
  assert.ok(prim.result.byClass.restoredPrimaries.count > 0, 'last resort exists');
  assert.equal(st.holds(S, 1), true);
  // After pruning, re-merging the same remote does NOT bring pruned keys back (SDK remembers them).
  st.importFromVault(rec, 1);
  assert.deepEqual(st.keysAt(S, 1).map((x) => x[0]), [1]);
  assert.throws(() => st.planPrune('nodeServed', 2), (e: unknown) => e instanceof ChannelKeyringError && e.code === 'stale');
});

test('member flood: other members\' wraps beyond the cap are REFUSED (never evicting ours); ownSlot re-puts always land', () => {
  const st = new ChannelKeys(() => 1, () => {}, { maxMemberEpochsPerScope: 3 });
  putFinal(st, 1, k(1));
  const memberWrap = (e: number) => st.put(S, e, k(e), 1, { source: 'wrap', meta: meta(e, k(e)), verified: true, nodeHighest: 100 });
  assert.deepEqual([2, 3, 4].map(memberWrap), ['stored', 'stored', 'stored']);
  assert.equal(memberWrap(5), 'refused', 'negative control: a 4th member epoch above the final floor is refused');
  // Our own slot's wrap (authored by our wallet) is never member-capped.
  assert.equal(st.put(S, 6, k(6), 1, { source: 'wrap', meta: meta(6, k(6)), verified: true, ownSlot: true, nodeHighest: 100 }), 'stored');
  // Later own epochs push the member wraps out of the 16 newest (kept) epochs;
  // the planner then targets that one channel's member wraps.
  for (let e = 7; e <= 30; e++) putFinal(st, e, k(e));
  const plan = st.planPrune('memberWraps', 1);
  assert.deepEqual(plan.scopes, [S]);
  assert.equal(plan.result.byClass.memberWraps.count, 3);
  assert.deepEqual(st.keysAt(S, 1)[0], k(1));
});

test('flood above the node\'s reach is refused for keys that are not ours (node-served and member wraps)', () => {
  const st = mk();
  assert.equal(st.put(S, 257, k(1), 1, { source: 'legacy', nodeHighest: 0 }), 'refused');
  assert.equal(st.put(S, 300, k(2), 1, { source: 'wrap', meta: meta(300, k(2)), verified: true, nodeHighest: 0 }), 'refused');
  assert.equal(st.put(S, 256, k(3), 1, { source: 'legacy', nodeHighest: 0 }), 'stored', 'control: within reach');
  // Our own keys are never bounded (own establish / ownSlot wrap).
  assert.equal(st.put(S, 300, k(4), 1, { source: 'wrap', meta: meta(300, k(4)), verified: true, ownSlot: true, nodeHighest: 0 }), 'stored');
});

test('two-step export: an export that was never committed (failed publish) leaves keys unpersisted', () => {
  const st = mk();
  st.put(S, 2, k(2), 1, { source: 'legacy', nodeHighest: 10 });
  const p = st.prepareExport(1); // publish fails: no commit
  assert.equal(st.entriesAt(S, 2)[0]!.persisted, false);
  st.commitExport(p.token, 1);
  assert.equal(st.entriesAt(S, 2)[0]!.persisted, true, 'only a committed (published) export persists');
  assert.equal(mk().empty, true);
  assert.equal(st.empty, false);
});

test('heal / "rotation already done" count only trusted FINAL keys (web rotationBase(confirmedOnly)); evidence counts non-final', () => {
  const st = mk();
  st.put(S, 4, k(4), 1, { source: 'wrap', meta: meta(4, k(4)), verified: true }); // trusted, not final
  assert.equal(st.evidence(S, 4), 4, 'highestEpochSeen / plan base: any trusted key');
  assert.equal(st.finalEvidence(S, 4), 0);
  assert.equal(st.healEligible(S, 4, 4), false, 'no heal against a key the node has not confirmed');
  assert.equal(st.alreadyAt(S, 4, 4), false, 'a rotation to 4 is not done until final');
  st.markFinal(S, 4, k(4), meta(4, k(4)), 1);
  assert.equal(st.healEligible(S, 4, 4), true);
  assert.equal(st.alreadyAt(S, 4, 4), true);
});

test('sendKey early path requires a PROVISIONAL key (a trusted non-final epoch-1 key is not sent under)', () => {
  const st = mk();
  st.put(S, 1, k(1), 1, { source: 'wrap', meta: meta(1, k(1)), verified: true }); // trusted, not final, not provisional
  assert.equal(st.sendKey(S, 1), null);
  const st2 = mk();
  st2.put(S, 1, k(1), 1, { source: 'establish', provisional: true, verified: true, meta: meta(1, k(1)) });
  assert.equal(st2.sendKey(S, 1)!.provisional, true);
});

test('member-wrap prune is SCOPED to the flooded channel: applying never touches another channel; no flood → scopes []', () => {
  const S2 = Buffer.from(computeChannelScope(CID + 1)).toString('hex');
  const meta2 = (e: number, key: Uint8Array) => ({ keyTs: 7, keyCommitment: computeKeyCommitment(computeChannelScope(CID + 1), e, 7, key) });
  const st = mk();
  const none = st.planPrune('memberWraps', 1);
  assert.deepEqual(none.scopes, [], 'never an unscoped (all channels) plan');
  for (const [scope, m, n] of [[S, meta, 4], [S2, meta2, 2]] as const) {
    for (let e = 1; e <= n; e++) st.put(scope, e, k(e), 1, { source: 'wrap', meta: m(e, k(e)), verified: true, nodeHighest: 100 });
    for (let e = 50; e <= 70; e++) st.put(scope, e, k(e), 1, { source: 'establish', meta: m(e, k(e)), verified: true, final: true });
  }
  const plan = st.planPrune('memberWraps', 1);
  assert.deepEqual(plan.scopes, [S], 'the most-flooded channel');
  assert.equal(st.applyPrune(plan, 1).removedCount, 4);
  assert.equal(st.holds(S2, 1), true, 'the other channel\'s member wraps are untouched');
  assert.throws(() => st.applyPrune({ level: 'memberWraps', result: plan.result }, 1), /without scopes/);
});

test('pruneGrew: keys that arrived after the confirmation (more to remove) are detected; same counts are not', () => {
  const st = new ChannelKeys(() => 1, () => {});
  for (let e = 1; e <= 30; e++) st.put(S, e, k(e), 1, { source: 'legacy', nodeHighest: 100 });
  const plan = st.planPrune('nodeServed', 1);
  assert.ok(plan.result.removedCount > 0);
  assert.equal(st.pruneGrew(plan, 1), false);
  // A NEW epoch above makes an older one fall out of the 16 kept epochs: more to remove.
  st.put(S, 31, k(31), 1, { source: 'legacy', nodeHighest: 100 });
  assert.equal(st.pruneGrew(plan, 1), true);
});
