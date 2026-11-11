/**
 * Epoch drive orchestration (desktop 1.85.0). Run:
 *   node --conditions=browser --test src/lib/epochDriver.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EscalationGate } from '@ogmara/sdk';
import {
  runDrive, applyEpochResult, RekeyScheduler, resumeCandidates, decideCoverAction, gatedPlan, alignWait,
  type DriveDeps, type DrivePlan, type ApplyDeps, type ChannelKeyStatus,
} from './epochDriver.ts';
import type { EpochKeyResult, PendingEpochRecord } from './epochKeys.ts';

const key = (epoch: number): EpochKeyResult => ({
  kind: 'key', epoch, key: new Uint8Array(32).fill(1), keyTs: 1, keyCommitment: new Uint8Array(32).fill(2), role: 'established', uncovered: 0,
});
const plan = (epoch: number, floor = epoch): DrivePlan => ({ epoch, epochKnownToExist: false, mode: 'verify', floor });

function driveDeps(over: Partial<DriveDeps> & { pending?: PendingEpochRecord; results?: Map<number, EpochKeyResult> } = {}) {
  const log = { drives: [] as number[], applied: [] as number[], cleared: [] as number[], status: [] as (ChannelKeyStatus | null)[] };
  let pending = over.pending;
  const deps: DriveDeps = {
    fresh: () => true,
    network: async () => 'testnet',
    nodeArbitrates: async () => true,
    loadPending: () => pending,
    clearPending: (_n, e) => { log.cleared.push(e); pending = undefined; },
    drive: async (_n, p) => { log.drives.push(p.epoch); return over.results?.get(p.epoch) ?? key(p.epoch); },
    apply: (_n, p) => { log.applied.push(p.epoch); },
    setStatus: (s) => { log.status.push(s); },
    log: () => {},
    ...over,
  };
  return { deps, log };
}

test('W4: a persisted epoch BELOW the plan floor is dropped, the newer kick rotation runs', async () => {
  const { deps, log } = driveDeps({ pending: { epoch: 3, mode: 'verify' } });
  const r = await runDrive(deps, async () => plan(8, 8));
  assert.equal(r?.epoch, 8);
  assert.deepEqual(log.cleared, [3]);
  assert.deepEqual(log.drives, [8]);
});

test('a persisted epoch at/above the floor but below the plan is resumed FIRST; the plan runs only once it is final', async () => {
  const { deps, log } = driveDeps({ pending: { epoch: 5, mode: 'public' } });
  await runDrive(deps, async () => plan(7, 4));
  assert.deepEqual(log.drives, [5, 7]);
  assert.deepEqual(log.cleared, []);
  const stuck = new Map<number, EpochKeyResult>([[5, { kind: 'rekeying', epoch: 5, reason: 'not_final' }]]);
  const b = driveDeps({ pending: { epoch: 5, mode: 'verify' }, results: stuck });
  await runDrive(b.deps, async () => plan(7, 4));
  assert.deepEqual(b.log.drives, [5], 'not moved past an unfinished epoch');
});

test('a persisted epoch at/above the plan replaces it; no plan → resume only', async () => {
  const a = driveDeps({ pending: { epoch: 9, mode: 'verify' } });
  await runDrive(a.deps, async () => plan(7, 7));
  assert.deepEqual(a.log.drives, [9]);
  const b = driveDeps({ pending: { epoch: 2, mode: 'verify' } });
  await runDrive(b.deps, async () => null);
  assert.deepEqual(b.log.drives, [2]);
  const c = driveDeps();
  assert.equal(await runDrive(c.deps, async () => null), null);
  assert.deepEqual(c.log.drives, []);
  assert.equal(c.log.status.at(-1), null);
});

test('a node without arbitration: node_problem, nothing driven', async () => {
  const { deps, log } = driveDeps({ nodeArbitrates: async () => false });
  assert.equal(await runDrive(deps, async () => plan(1)), null);
  assert.deepEqual(log.drives, []);
  assert.deepEqual(log.status, ['node_problem']);
});

test('an account switch during the drive applies nothing and does not throw', async () => {
  let gen = 1;
  const { deps, log } = driveDeps({
    fresh: () => gen === 1,
    drive: async (_n, p) => { gen++; return key(p.epoch); },
  });
  assert.equal(await runDrive(deps, async () => plan(3)), null);
  assert.deepEqual(log.applied, []);
});

function applyDeps(over: Partial<ApplyDeps> = {}) {
  const log = { cached: [] as number[], status: [] as (ChannelKeyStatus | null)[], retries: [] as DrivePlan[], rebinds: 0 };
  const deps: ApplyDeps = {
    fresh: () => true,
    cacheFinal: (e) => { log.cached.push(e); },
    setStatus: (s) => { log.status.push(s); },
    retry: (p) => { log.retries.push(p); return true; },
    resetRetries: () => {},
    rebind: () => { log.rebinds++; },
    log: () => {},
    ...over,
  };
  return { deps, log };
}

test('applyEpochResult: a stale result changes NOTHING', () => {
  const { deps, log } = applyDeps({ fresh: () => false });
  applyEpochResult(deps, plan(3), key(3));
  applyEpochResult(deps, plan(3), { kind: 'rekeying', epoch: 3, reason: 'x' });
  assert.deepEqual(log, { cached: [], status: [], retries: [], rebinds: 0 });
});

test('applyEpochResult: key caches + clears status; uncovered resumes the same epoch', () => {
  const { deps, log } = applyDeps();
  applyEpochResult(deps, plan(3), { ...key(3), uncovered: 2 } as EpochKeyResult);
  assert.deepEqual(log.cached, [3]);
  assert.deepEqual(log.status, [null]);
  assert.deepEqual(log.retries.map((p) => [p.epoch, p.epochKnownToExist]), [[3, true]]);
});

test('W3: a spent retry budget surfaces node_problem instead of leaving "re-keying" forever', () => {
  const a = applyDeps();
  applyEpochResult(a.deps, plan(3), { kind: 'rekeying', epoch: 3, reason: 'not_final' });
  assert.deepEqual(a.log.status, ['rekeying']);
  const b = applyDeps({ retry: () => false });
  applyEpochResult(b.deps, plan(3), { kind: 'rekeying', epoch: 3, reason: 'not_final' });
  assert.deepEqual(b.log.status, ['node_problem']);
  const c = applyDeps({ retry: () => false });
  applyEpochResult(c.deps, plan(3), { kind: 'rebind', epoch: 3 });
  assert.deepEqual([c.log.status, c.log.rebinds], [['node_problem'], 1]);
});

test('applyEpochResult: the retry keeps the plan flag at the same epoch, a moved-to epoch is new', () => {
  const { deps, log } = applyDeps();
  applyEpochResult(deps, { ...plan(3), epochKnownToExist: true }, { kind: 'rekeying', epoch: 3, reason: 'x' });
  applyEpochResult(deps, { ...plan(3), epochKnownToExist: true }, { kind: 'rekeying', epoch: 4, reason: 'x' });
  assert.deepEqual(log.retries.map((p) => [p.epoch, p.epochKnownToExist]), [[3, true], [4, false]]);
  applyEpochResult(deps, plan(3), { kind: 'blocked', epoch: 3, reason: 'epoch_too_high' });
  assert.equal(log.status.at(-1), 'node_problem');
});

test('RekeyScheduler: one timer per channel, at most `max` per channel, reset / clear', () => {
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const s = new RekeyScheduler((fn) => { timers.push(fn); return timers.length; }, (h) => cleared.push(h), 3, 1000);
  let runs = 0;
  assert.equal(s.schedule(1, () => runs++), true);
  assert.equal(s.schedule(1, () => runs++), true, 'already pending');
  assert.equal(timers.length, 1);
  timers[0]!();
  assert.equal(s.schedule(1, () => runs++), true);
  timers[1]!();
  assert.equal(s.schedule(1, () => runs++), true);
  timers[2]!();
  assert.equal(s.schedule(1, () => runs++), false, 'budget spent');
  assert.equal(runs, 3);
  assert.equal(s.schedule(1, () => runs++), false, 'stays spent (a retry never re-opens it)');
  s.reset(1);
  assert.equal(s.schedule(1, () => runs++), true, 'a fully covered key starts it over');
  s.reset(2);
  s.schedule(2, () => {});
  s.clear();
  assert.equal(cleared.length, 2);
  assert.equal(s.pending(1), false);
});

test('resume candidates: only joined channels, capped', () => {
  const m = new Map<number, PendingEpochRecord>([[1, { epoch: 1, mode: 'verify' }], [2, { epoch: 1, mode: 'verify' }], [3, { epoch: 1, mode: 'verify' }]]);
  assert.deepEqual(resumeCandidates(m, (id) => id !== 2), [1, 3]);
  assert.deepEqual(resumeCandidates(m, () => true, 2), [1, 2]);
});

test('cover decision: verified pair → publish; legacy → new epoch; mismatch → heal; unknown → skip', () => {
  const m = { keyTs: 1, keyCommitment: new Uint8Array(32).fill(1) };
  assert.equal(decideCoverAction(m), 'publish');
  assert.equal(decideCoverAction('legacy'), 'new_epoch');
  assert.equal(decideCoverAction('mismatch'), 'heal');
  assert.equal(decideCoverAction('none'), 'skip');
});

test('W3 (probe P4): repeated `key` results with uncovered targets stay within the retry budget', () => {
  const fire: Array<() => void> = [];
  const sched = new RekeyScheduler((fn) => { fire.push(fn); return fire.length; }, () => {}, 10, 1000);
  let scheduled = 0;
  const deps: ApplyDeps = {
    fresh: () => true, cacheFinal: () => {}, setStatus: () => {}, rebind: () => {}, log: () => {},
    retry: () => sched.schedule(1, () => {}),
    resetRetries: () => sched.reset(1),
  };
  for (let i = 0; i < 50; i++) {
    const before = fire.length;
    applyEpochResult(deps, plan(3), { ...key(3), uncovered: 1 } as EpochKeyResult);
    if (fire.length > before) scheduled++;
    fire.at(-1)?.(); // the retry runs and ends `key` with uncovered again
  }
  assert.ok(scheduled <= 10, `scheduled ${scheduled} retries for a budget of 10`);
  // A fully covered key resets the budget.
  applyEpochResult(deps, plan(3), key(3));
  assert.equal(sched.schedule(1, () => {}), true);
});

test('M7: a persisted epoch exactly AT the plan floor is resumed, not dropped', async () => {
  const { deps, log } = driveDeps({ pending: { epoch: 5, mode: 'verify' } });
  await runDrive(deps, async () => plan(7, 5));
  assert.deepEqual(log.cleared, []);
  assert.deepEqual(log.drives, [5, 7]);
});

test('gatedPlan: the gate token is taken only when the plan really starts', async () => {
  let t = 0;
  const gate = new EscalationGate(() => t);
  assert.equal(await gatedPlan(gate, 4, () => true, async () => plan(2)), null);
  assert.equal(gate.remainingMs(4), 0, 'already done: no token consumed');
  assert.deepEqual(await gatedPlan(gate, 4, () => false, async () => plan(2)), plan(2));
  assert.equal(await gatedPlan(gate, 4, () => false, async () => plan(2)), null, 'gated');
  t += 10 * 60_000;
  assert.deepEqual(await gatedPlan(gate, 4, () => false, async () => plan(2)), plan(2));
});

test('alignWait: a send matches the banner after a blocked drive', () => {
  assert.equal(alignWait('rekeying', 'node_problem'), 'node_problem');
  assert.equal(alignWait('rekeying', 'rekeying'), 'rekeying');
  assert.equal(alignWait('rekeying', null), 'rekeying');
  assert.equal(alignWait('waiting', 'node_problem'), 'waiting');
});
