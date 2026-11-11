/**
 * Verify-before-cover (desktop 1.85.0, protocol §3.9.2). Run:
 *   node --conditions=browser --test src/lib/privateCover.test.ts
 *
 * The real pipeline (`resolveCoverTargets`, throttle, per-account cache,
 * queue) lives in privateCover.ts with every dependency injected, so it is
 * exercised here by BEHAVIOUR against a fake node. Epoch establishment is
 * the SDK's `establishEpochKey` (tests: epochKeys.test.ts). Only the thin
 * wiring in channelCrypto.ts / components (which import the SDK and Tauri and
 * cannot load under `node --test`) is pinned by source probes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  StaleAccountError,
  CoverDeferredError,
  selectVerifiedWallets,
  savePinIfAbsent,
  filterBoundEncKeys,
  loadPin,
  loadSeenRemovals,
  saveSeenRemovals,
  pinBase,
  removalsBase,
  removalsLruBase,
  coverMode,
  resolveCoverTargets,
  createSerialQueue,
  CoverThrottle,
  PerAccountCache,
  coverTargetKey,
  MAX_SEEN_REMOVALS_PER_CHANNEL,
  MAX_SEEN_REMOVALS_CHANNELS,
  MAX_SEEN_REMOVALS_BYTES,
  PRIVATE_COVER_THROTTLE_MS,
  PUBLIC_COVER_THROTTLE_MS,
  IMMEDIATE_COVER_MIN_MS,
  type SelectDeps,
  type VerifyOptions,
  type VerifyResult,
  type WalletStore,
  type EncKeyRow,
  type TargetDeps,
  type CoverTarget,
  type BindingVerdict,
} from './privateCover.ts';
import { resolveIsPrivateForCover, isPublicRangeChannelId } from './channelEncryption.ts';

const w = (c: string) => 'klv1' + c.repeat(58);
const ME = w('a');
const OTHER_ACCOUNT = w('b');
const M1 = w('c');
const M2 = w('d');
const M3 = w('e');
const CREATOR = w('f');
const NET = 'testnet';
const FLOOR = 2 ** 32;
const PRIV = FLOOR + 4242; // a private-range channel id
const PUB = 4242; // a public-range channel id

function memStore(): WalletStore & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  const s = {
    data,
    writes: 0,
    get: (wallet: string, base: string) => data.get(`${base}::${wallet}`) ?? null,
    set: (wallet: string, base: string, value: string) => {
      s.writes++;
      data.set(`${base}::${wallet}`, value);
    },
    remove: (wallet: string, base: string) => {
      s.writes++;
      data.delete(`${base}::${wallet}`);
    },
  };
  return s;
}

function selDeps(
  verify: (ws: string[], o: VerifyOptions) => Promise<VerifyResult>,
  store = memStore(),
  fresh: () => boolean = () => true,
): SelectDeps & { store: ReturnType<typeof memStore>; logs: { step: string; data?: Record<string, unknown> }[] } {
  const logs: { step: string; data?: Record<string, unknown> }[] = [];
  return { verify, store, fresh, log: (step, data) => logs.push({ step, data }), logs };
}

const selArgs = (members: string[], channelId = PRIV) =>
  ({ self: ME, network: NET, channelId, members, activationMs: 1793491200000 });

// --- selectVerifiedWallets ----------------------------------------------------

test('self always covered, only verified others added, self never sent for verification', async () => {
  let asked: string[] = [];
  const d = selDeps(async (ws) => {
    asked = ws;
    return { verified: [M1], rejected: [{ wallet: M2, reason: 'no_join' }], incomplete: false, creator: CREATOR, creatorSource: 'derived' };
  });
  const out = await selectVerifiedWallets(d, selArgs([M1, ME, M2, M1]));
  assert.deepEqual(asked, [M1, M2], 'self excluded, deduped');
  assert.deepEqual(out.wallets, [ME, M1]);
});

test('fail closed: failed fetch / throwing verifier → self only, incomplete', async () => {
  const a = await selectVerifiedWallets(selDeps(async (ws) => ({
    verified: [], rejected: ws.map((x) => ({ wallet: x, reason: 'fetch_failed:404' })), incomplete: true,
  })), selArgs([M1, M2]));
  assert.deepEqual(a, { wallets: [ME], incomplete: true });
  const b = await selectVerifiedWallets(selDeps(async () => { throw new Error('boom'); }), selArgs([M1]));
  assert.deepEqual(b, { wallets: [ME], incomplete: true });
});

test('a verifier can never add a wallet that was not asked about', async () => {
  const out = await selectVerifiedWallets(selDeps(async () => ({ verified: [M1, M3], rejected: [], incomplete: false })), selArgs([M1, M2]));
  assert.deepEqual(out.wallets, [ME, M1]);
});

test('the exportable trace carries counts/reasons only, never member addresses (N4)', async () => {
  const d = selDeps(async () => ({ verified: [], rejected: [{ wallet: M1, reason: 'no_join' }, { wallet: M2, reason: 'no_join' }], incomplete: false, creator: CREATOR, creatorSource: 'derived' }));
  await selectVerifiedWallets(d, selArgs([M1, M2]));
  const dump = JSON.stringify(d.logs);
  for (const addr of [M1, M2, CREATOR]) assert.ok(!dump.includes(addr), 'address leaked into trace');
  assert.ok(dump.includes('"no_join":2'));
});

test('creator pin: saved on first success, passed afterwards, a differing result is ignored (M5/M17)', async () => {
  const store = memStore();
  const seenOpts: VerifyOptions[] = [];
  let creator = CREATOR;
  const d = selDeps(async (_ws, o) => {
    seenOpts.push({ ...o });
    return { verified: [], rejected: [], incomplete: false, creator, creatorSource: o.pinnedCreator ? 'pinned' : 'derived' };
  }, store);
  await selectVerifiedWallets(d, selArgs([M1]));
  assert.equal(seenOpts[0]!.pinnedCreator, undefined);
  assert.equal(loadPin(store, ME, NET, PRIV), CREATOR);
  creator = M3; // a later (hostile) result can never replace the pin
  await selectVerifiedWallets(d, selArgs([M1]));
  assert.equal(seenOpts[1]!.pinnedCreator, CREATOR);
  assert.equal(loadPin(store, ME, NET, PRIV), CREATOR);
  assert.ok(d.logs.some((l) => l.step.includes('differs from the pin')), 'anomaly path taken only when a pin was passed');
  assert.equal(loadPin(store, OTHER_ACCOUNT, NET, PRIV), undefined);
  assert.equal(loadPin(store, ME, 'mainnet', PRIV), undefined);
  assert.equal(loadPin(store, ME, NET, PRIV + 1), undefined);
});

test('savePinIfAbsent never overwrites an existing pin (M5)', () => {
  const store = memStore();
  assert.equal(savePinIfAbsent(store, ME, NET, PRIV, CREATOR), true);
  assert.equal(savePinIfAbsent(store, ME, NET, PRIV, M3), false);
  assert.equal(loadPin(store, ME, NET, PRIV), CREATOR);
  assert.equal(savePinIfAbsent(store, ME, NET, PRIV + 1, 'not-a-wallet'), false);
});

test('allowUnderivedCreator is never set; network and activation passed through', async () => {
  const opts: VerifyOptions[] = [];
  await selectVerifiedWallets(selDeps(async (_ws, o) => {
    opts.push(o);
    return { verified: [], rejected: [], incomplete: false };
  }), selArgs([M1]));
  assert.equal(opts[0]!.allowUnderivedCreator, false);
  assert.equal(opts[0]!.network, NET);
  assert.equal(opts[0]!.activationMs, 1793491200000);
});

test('seen removals: loaded into the verifier, merged INTO the persisted map (max), never overwritten', async () => {
  const store = memStore();
  store.set(ME, removalsBase(NET, PRIV), JSON.stringify({ [M1]: 500, [M2]: 900 }));
  await selectVerifiedWallets(selDeps(async (_ws, o) => {
    assert.equal(o.seenRemovals.get(M1), 500);
    o.seenRemovals.set(M1, 700);
    o.seenRemovals.set(M3, 100);
    store.set(ME, removalsBase(NET, PRIV), JSON.stringify({ [M1]: 500, [M2]: 1000 }));
    return { verified: [], rejected: [], incomplete: false };
  }, store), selArgs([M1]));
  const after = loadSeenRemovals(store, ME, NET, PRIV);
  assert.equal(after.get(M1), 700);
  assert.equal(after.get(M2), 1000);
  assert.equal(after.get(M3), 100);
});

test('seen removals: corrupt storage reads as empty; bad entries dropped', () => {
  const store = memStore();
  store.set(ME, removalsBase(NET, PRIV), '{not json');
  assert.equal(loadSeenRemovals(store, ME, NET, PRIV).size, 0);
  store.set(ME, removalsBase(NET, PRIV), JSON.stringify({ evil: 1, [M1]: -1, [M2]: 'x', [M3]: 5 }));
  assert.deepEqual([...loadSeenRemovals(store, ME, NET, PRIV)], [[M3, 5]]);
});

test('seen removals bounds (N3): 256 newest per channel, byte cap, 200 channels LRU', () => {
  const store = memStore();
  const seen = new Map<string, number>();
  for (let i = 0; i < MAX_SEEN_REMOVALS_PER_CHANNEL + 50; i++) seen.set('klv1' + String(i).padStart(58, 'q'), i);
  saveSeenRemovals(store, ME, NET, PRIV, seen);
  const after = loadSeenRemovals(store, ME, NET, PRIV);
  assert.ok(after.size <= MAX_SEEN_REMOVALS_PER_CHANNEL);
  assert.ok(Math.min(...after.values()) >= 50, 'oldest dropped first');
  assert.ok(store.get(ME, removalsBase(NET, PRIV))!.length <= MAX_SEEN_REMOVALS_BYTES);
  for (let c = 1; c <= MAX_SEEN_REMOVALS_CHANNELS + 3; c++) saveSeenRemovals(store, ME, NET, FLOOR + c, new Map([[M1, c]]));
  assert.equal(loadSeenRemovals(store, ME, NET, PRIV).size, 0, 'least recently updated channel evicted');
  assert.equal(loadSeenRemovals(store, ME, NET, FLOOR + 1).size, 0);
  assert.equal(loadSeenRemovals(store, ME, NET, FLOOR + MAX_SEEN_REMOVALS_CHANNELS + 3).get(M1), MAX_SEEN_REMOVALS_CHANNELS + 3);
  assert.equal(JSON.parse(store.get(ME, removalsLruBase(NET))!).length, MAX_SEEN_REMOVALS_CHANNELS);
});

test('switch DURING verification: StaleAccountError, nothing persisted; stale before start: no request', async () => {
  let gen = 1;
  const store = memStore();
  await assert.rejects(selectVerifiedWallets(selDeps(async () => {
    gen++;
    return { verified: [M1], rejected: [], incomplete: false, creator: CREATOR, creatorSource: 'derived' };
  }, store, () => gen === 1), selArgs([M1])), StaleAccountError);
  assert.equal(store.writes, 0);
  let called = false;
  await assert.rejects(selectVerifiedWallets(selDeps(async () => {
    called = true;
    return { verified: [], rejected: [], incomplete: false };
  }, memStore(), () => false), selArgs([M1])), StaleAccountError);
  assert.equal(called, false);
  let g2 = 1;
  await assert.rejects(selectVerifiedWallets(selDeps(async () => { g2++; throw new Error('x'); }, memStore(), () => g2 === 1), selArgs([M1])), StaleAccountError);
});

// --- Enc-key binding ----------------------------------------------------------

test('enc keys: only bound kept — unbound (B2), invalid and throwing refused', async () => {
  const row = (id: string): EncKeyRow => ({ device_id: id, enc_pub: id, created_at: 1 });
  const out = await filterBoundEncKeys([row('bound'), row('unbound'), row('invalid'), row('throws')], M1, NET, async (r) => {
    if (r.device_id === 'bound') return { status: 'bound' };
    if (r.device_id === 'unbound') return { status: 'unbound' };
    if (r.device_id === 'invalid') return { status: 'invalid', reason: 'bad_signature' };
    throw new Error('x');
  });
  assert.deepEqual(out.bound.map((k) => k.device_id), ['bound']);
  assert.equal(out.unbound, 1);
  assert.equal(out.invalid, 2);
});

// --- Channel type / id floor (B1, N1) ------------------------------------------

test('id floor: private-range ids are always private; public-range needs a resolved record', () => {
  assert.equal(isPublicRangeChannelId(PUB), true);
  for (const id of [FLOOR, PRIV, 0, -1, 1.5, NaN, null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isPublicRangeChannelId(id), false, String(id));
  }
  const P = 2;
  assert.equal(resolveIsPrivateForCover('ready', { channel_type: 0, encryption_enabled: false }, P, PRIV), true, 'node says public for a private id');
  assert.equal(resolveIsPrivateForCover('pending', undefined, P, PRIV), true);
  assert.equal(resolveIsPrivateForCover('pending', undefined, P, PUB), undefined);
  assert.equal(resolveIsPrivateForCover('errored', { channel_type: 0 }, P, PUB), undefined);
  assert.equal(resolveIsPrivateForCover('ready', {}, P, PUB), undefined);
  assert.equal(resolveIsPrivateForCover('ready', { channel_type: 2 }, P, PUB), true, 'legacy pre-floor private row');
  assert.equal(resolveIsPrivateForCover('ready', { channel_type: 0, encryption_enabled: true }, P, PUB), false);
  assert.equal(resolveIsPrivateForCover('ready', { channel_type: 1 }, P, PUB), false);
});

test('coverMode: private range always verifies, pin is sticky, unknown public-range defers', () => {
  assert.equal(coverMode(PRIV, false, false), 'verify');
  assert.equal(coverMode(PRIV, undefined, false), 'verify');
  assert.equal(coverMode(PUB, false, true), 'verify');
  assert.equal(coverMode(PUB, true, false), 'verify');
  assert.equal(coverMode(PUB, false, false), 'public');
  assert.equal(coverMode(PUB, undefined, false), 'defer');
});

// --- resolveCoverTargets (the real target pipeline) -----------------------------

interface FakeNet {
  members: string[];
  keys: Map<string, EncKeyRow[]>;
  verified: Set<string>;
  binding: Map<string, BindingVerdict['status']>; // by device_id; default bound
  calls: { verify: string[][]; members: number; encKeys: string[] };
}

function fakeNet(over: Partial<FakeNet> = {}): FakeNet {
  return {
    members: [ME, M1, M2],
    keys: new Map([
      [ME, [{ device_id: 'me1', enc_pub: 'e-me1', created_at: 1, ts: 1 }]],
      [M1, [{ device_id: 'm1a', enc_pub: 'e-m1a', created_at: 1, ts: 1 }]],
      [M2, [{ device_id: 'm2a', enc_pub: 'e-m2a', created_at: 1, ts: 1 }]],
    ]),
    verified: new Set([M1]),
    binding: new Map(),
    calls: { verify: [], members: 0, encKeys: [] },
    ...over,
  };
}

function targetDeps(net: FakeNet, store = memStore(), fresh: () => boolean = () => true, onVerify?: () => void): TargetDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    getMembers: async (_id, page, limit) => {
      net.calls.members++;
      return net.members.slice((page - 1) * limit, page * limit).map((address) => ({ address }));
    },
    getNetwork: async () => NET,
    getEncKeys: async (wallet) => {
      net.calls.encKeys.push(wallet);
      return net.keys.get(wallet) ?? [];
    },
    verifyMembers: async (wallets) => {
      net.calls.verify.push([...wallets]);
      onVerify?.();
      return {
        verified: wallets.filter((x) => net.verified.has(x)),
        rejected: wallets.filter((x) => !net.verified.has(x)).map((x) => ({ wallet: x, reason: 'no_join' })),
        incomplete: false,
        creator: CREATOR,
        creatorSource: 'derived',
      };
    },
    verifyBinding: async (row) => {
      const s = net.binding.get(row.device_id) ?? 'bound';
      return s === 'invalid' ? { status: 'invalid', reason: 'bad' } : { status: s };
    },
    activationMs: () => 1793491200000,
    store,
    fresh,
    log: (s) => logs.push(s),
    logs,
  };
}

const keysOf = (ts: CoverTarget[]) => ts.map(coverTargetKey).sort();
const tick = () => new Promise<void>((r) => setImmediate(r));

test('B1: a private-range id is verified even when the node calls it public', async () => {
  const net = fakeNet();
  const r = await resolveCoverTargets(targetDeps(net), { self: ME, channelId: PRIV, hint: false });
  assert.equal(r.mode, 'verify');
  assert.deepEqual(net.calls.verify, [[M1, M2]]);
  assert.deepEqual(keysOf(r.targets), [`${ME}:me1`, `${M1}:m1a`], 'unverified M2 never targeted');
});

test('M8 sticky: a pinned public-range channel reported public is still verified', async () => {
  const net = fakeNet();
  const store = memStore();
  savePinIfAbsent(store, ME, NET, PUB, CREATOR);
  const r = await resolveCoverTargets(targetDeps(net, store), { self: ME, channelId: PUB, hint: false });
  assert.equal(r.mode, 'verify');
  assert.equal(net.calls.verify.length, 1);
  assert.ok(!keysOf(r.targets).includes(`${M2}:m2a`));
});

test('public mode (positively public, below floor, no pin): node list, no proofs, unchanged', async () => {
  const net = fakeNet({ binding: new Map([['m2a', 'unbound']]) });
  const r = await resolveCoverTargets(targetDeps(net), { self: ME, channelId: PUB, hint: false });
  assert.equal(r.mode, 'public');
  assert.equal(net.calls.verify.length, 0);
  assert.deepEqual(keysOf(r.targets), [`${ME}:me1`, `${M1}:m1a`, `${M2}:m2a`]);
});

test('N1: unknown type below the floor defers — no member list, no member-proofs', async () => {
  const net = fakeNet();
  await assert.rejects(resolveCoverTargets(targetDeps(net), { self: ME, channelId: PUB, hint: undefined }), CoverDeferredError);
  assert.equal(net.calls.members, 0);
  assert.equal(net.calls.verify.length, 0);
});

test('self is covered even when the node omits it; no proofs requested for self', async () => {
  const net = fakeNet({ members: [M1] });
  const r = await resolveCoverTargets(targetDeps(net), { self: ME, channelId: PRIV, hint: true });
  assert.deepEqual(net.calls.verify, [[M1]]);
  assert.deepEqual(keysOf(r.targets), [`${ME}:me1`, `${M1}:m1a`]);
});

test('B2/M12: unbound and invalid keys are never targeted in private channels — including my own', async () => {
  const net = fakeNet({
    keys: new Map([
      [ME, [{ device_id: 'me1', enc_pub: 'e-me1', created_at: 1, ts: 1 }, { device_id: 'meX', enc_pub: 'e-meX', created_at: 9 }]],
      [M1, [{ device_id: 'm1a', enc_pub: 'e-m1a', created_at: 1, ts: 1 }, { device_id: 'm1b', enc_pub: 'e-m1b', created_at: 1, ts: 1 }]],
    ]),
    binding: new Map([['meX', 'unbound'], ['m1b', 'invalid']]),
  });
  const r = await resolveCoverTargets(targetDeps(net), { self: ME, channelId: PRIV, hint: true });
  assert.deepEqual(keysOf(r.targets), [`${ME}:me1`, `${M1}:m1a`]);
});

test('B2: an unbound row with a newer node created_at never shadows the bound row of the same device', async () => {
  const net = fakeNet({
    keys: new Map([[M1, [
      { device_id: 'm1a', enc_pub: 'e-bound', created_at: 1, ts: 5 },
      { device_id: 'm1a', enc_pub: 'e-node-minted', created_at: 999 },
    ]]]),
    binding: new Map(),
  });
  const deps = targetDeps(net);
  deps.verifyBinding = async (row) => (row.enc_pub === 'e-bound' ? { status: 'bound' } : { status: 'unbound' });
  const r = await resolveCoverTargets(deps, { self: ME, channelId: PRIV, hint: true });
  assert.equal(r.targets.find((t) => t.target === M1)!.encPub, 'e-bound');
});

test('bound rows of one device: the newest SIGNED ts wins, not node created_at', async () => {
  const net = fakeNet({ keys: new Map([[M1, [
    { device_id: 'm1a', enc_pub: 'old', created_at: 999, ts: 1 },
    { device_id: 'm1a', enc_pub: 'new', created_at: 1, ts: 7 },
  ]]]) });
  const r = await resolveCoverTargets(targetDeps(net), { self: ME, channelId: PRIV, hint: true });
  assert.equal(r.targets.find((t) => t.target === M1)!.encPub, 'new');
});

test('W3: wallets whose devices are all covered at this epoch are not re-verified', async () => {
  const net = fakeNet({ verified: new Set([M1, M2]) });
  const covered = new Set([`${M1}:m1a`]);
  await resolveCoverTargets(targetDeps(net), { self: ME, channelId: PRIV, hint: true, covered });
  assert.deepEqual(net.calls.verify, [[M2]]);
});

test('W3 (.some): a wallet with ONE covered and ONE uncovered device IS re-verified', async () => {
  // Kills the `.some` → `.every` mutant of `needVerify`: with `.every` a
  // member whose new (second) device is not covered yet would skip
  // verification and so never be covered at all.
  const net = fakeNet({
    verified: new Set([M1, M2]),
    keys: new Map([
      [ME, [{ device_id: 'me1', enc_pub: 'e-me1', created_at: 1, ts: 1 }]],
      [M1, [{ device_id: 'm1a', enc_pub: 'e-m1a', created_at: 1, ts: 1 }, { device_id: 'm1b', enc_pub: 'e-m1b', created_at: 2, ts: 2 }]],
      [M2, [{ device_id: 'm2a', enc_pub: 'e-m2a', created_at: 1, ts: 1 }]],
    ]),
  });
  const covered = new Set([`${M1}:m1a`, `${M2}:m2a`]);
  const r = await resolveCoverTargets(targetDeps(net), { self: ME, channelId: PRIV, hint: true, covered });
  assert.deepEqual(net.calls.verify, [[M1]]);
  assert.ok(r.targets.some((t) => t.target === M1 && t.deviceId === 'm1b'), 'the new device is targeted');
});

test('switch during verification of the real pipeline: StaleAccountError, nothing persisted', async () => {
  let gen = 1;
  const store = memStore();
  const net = fakeNet();
  await assert.rejects(
    resolveCoverTargets(targetDeps(net, store, () => gen === 1, () => { gen++; }), { self: ME, channelId: PRIV, hint: true }),
    StaleAccountError,
  );
  assert.equal(loadPin(store, ME, NET, PRIV), undefined);
});

// --- Scheduling helpers -------------------------------------------------------

test('W3 throttle: private 60 s, public 10 s, events bounded at 5 s; stale failure never resets (M10)', () => {
  const th = new CoverThrottle();
  assert.equal(th.tryStart(1, 1_000_000, { privateMode: true, immediate: false }), true);
  assert.equal(th.tryStart(1, 1_000_000 + PRIVATE_COVER_THROTTLE_MS - 1, { privateMode: true, immediate: false }), false);
  assert.equal(th.tryStart(1, 1_000_000 + IMMEDIATE_COVER_MIN_MS - 1, { privateMode: true, immediate: true }), false);
  assert.equal(th.tryStart(1, 1_000_000 + IMMEDIATE_COVER_MIN_MS, { privateMode: true, immediate: true }), true);
  assert.equal(th.tryStart(2, 1_000_000, { privateMode: false, immediate: false }), true);
  assert.equal(th.tryStart(2, 1_000_000 + PUBLIC_COVER_THROTTLE_MS, { privateMode: false, immediate: false }), true);
  th.failed(3, true);
  assert.equal(th.tryStart(4, 5_000_000, { privateMode: true, immediate: false }), true);
  th.failed(4, false); // stale pass: must not re-open the NEW account's throttle
  assert.equal(th.tryStart(4, 5_000_001, { privateMode: true, immediate: false }), false);
  th.failed(4, true);
  assert.equal(th.tryStart(4, 5_000_002, { privateMode: true, immediate: false }), true);
});

test('M18: proof cache is per account AND per switch generation; stale callers get a throwaway', () => {
  let n = 0;
  const pc = new PerAccountCache(() => ({ id: ++n }));
  const a1 = pc.get(ME, 1, true);
  assert.equal(pc.get(ME, 1, true), a1);
  assert.notEqual(pc.get(OTHER_ACCOUNT, 1, true), a1);
  const a2 = pc.get(ME, 2, true);
  assert.notEqual(a2, a1);
  const stale = pc.get(ME, 2, false);
  assert.notEqual(stale, a2);
  assert.equal(pc.get(ME, 2, true), a2, 'a stale caller never replaced the stored cache');
  pc.reset();
  assert.notEqual(pc.get(ME, 2, true), a2);
});

test('W3: member-proofs queue runs jobs strictly one at a time; a failure does not block it', async () => {
  const q = createSerialQueue();
  let running = 0;
  let max = 0;
  const job = (fail: boolean) => async () => {
    running++;
    max = Math.max(max, running);
    await tick();
    await tick();
    running--;
    if (fail) throw new Error('x');
    return 1;
  };
  const rs = await Promise.allSettled([q(job(false)), q(job(true)), q(job(false))]);
  assert.equal(max, 1);
  assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});

// --- Wallet-scope storage -----------------------------------------------------

test('scopedSetFor/scopedRemoveFor address the CAPTURED wallet; wipeWalletScope removes pins/removals', async () => {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    get length() { return mem.size; },
    key: (i: number) => [...mem.keys()][i] ?? null,
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  };
  const ws = await import('./walletScope.ts');
  ws.setWalletScope(OTHER_ACCOUNT);
  ws.scopedSetFor(ME, pinBase(NET, PRIV), CREATOR);
  assert.equal(mem.get(`${pinBase(NET, PRIV)}::${ME}`), CREATOR);
  assert.equal(ws.scopedGet(pinBase(NET, PRIV)), null);
  ws.scopedSetFor(ME, removalsBase(NET, PRIV), '{}');
  ws.scopedRemoveFor(ME, removalsBase(NET, PRIV));
  assert.equal(mem.has(`${removalsBase(NET, PRIV)}::${ME}`), false);
  ws.wipeWalletScope(ME);
  assert.equal(mem.size, 0);
});

// --- Wiring probes (modules that cannot load under node --test) ---------------------

const cc = readFileSync(new URL('./channelCrypto.ts', import.meta.url), 'utf8');

function fnBody(src: string, sig: string): string {
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `${sig} not found`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

test('channelCrypto wires the real pipeline: queued, per-account proofs, re-check in queue', () => {
  const t = fnBody(cc, 'function getChannelTargets(');
  assert.match(t, /return resolveCoverTargets\(/);
  assert.match(t, /proofQueue\(\(\) => \{\s*\/\/[^\n]*\n\s*assertFresh\(\(\) => ctxStillFresh\(ctx\)\);/);
  assert.match(t, /proofCaches\.get\(ctx\.wallet, ctx\.generation, ctxStillFresh\(ctx\)\)/);
  assert.match(t, /verifyBinding: verifyEncKeyBinding/);
  assert.match(t, /self: ctx\.wallet/);
});

test('channelCrypto: every channel key publish goes through buildChannelEpochKeyEnvelope + publishChannelKeyEnvelope', () => {
  // Strict policy (l2-node 0.143.0): no commitment-less channel envelope, no generic publish.
  assert.doesNotMatch(cc, /buildChannelKeyEnvelope\(/);
  assert.doesNotMatch(cc, /publishKeyEnvelope\(/);
  assert.equal((cc.match(/buildChannelEpochKeyEnvelope\(ctx\.signer!/g) ?? []).length, 2);
  assert.equal((cc.match(/assertFresh\(fresh\);\s*return getClient\(\)\.publishChannelKeyEnvelope\(bytes\);/g) ?? []).length, 2);
  // The cover path publishes the epoch's OWN pair (persisted / recovered meta).
  const cover = fnBody(cc, 'export async function coverChannelMembers(');
  assert.match(cover, /keyTs: meta\.keyTs/);
  assert.match(cover, /coverThrottle\.failed\(channelId, ctxStillFresh\(ctx\)\)/);
  assert.match(cover, /let retryLater = res\.incomplete;/);
  assert.match(cover, /retryLater && !opts\.retry && !coverRetryTimers\.has\(channelId\)/);
  assert.doesNotMatch(cover, /rate_limited'\) coverThrottle\.failed/);
});

test('channelCrypto: SDK deps are wired to the behaviour-tested modules', () => {
  // The rules themselves are tested by behaviour (channelKeyStore / epochKeys /
  // epochDriver / epochPeers tests); this only pins that the wiring USES them.
  const d = fnBody(cc, 'async function driveEpoch(');
  assert.match(d, /return runEpochKey\(/);
  assert.match(d, /fresh,\n/);
  assert.match(d, /highestEpochSeen: \(\) => keys\.evidence\(scopeHex, nv\.highest\),/);
  assert.match(d, /holdsKeyAt: \(e\) => keys\.holds\(scopeHex, e\),/);
  assert.match(d, /return queryPeerCommitments\(peers,/);
  assert.match(d, /now: Date\.now/);
  assert.match(d, /const ownWrap = ownWrapFetcher\(/);
  assert.match(cc, /const keys = new ChannelKeys\(currentSwitchGeneration, notifyKeyringChanged\);/);
  assert.match(cc, /return keys\.prepareExport\(generation\);/);
  assert.match(cc, /keys\.commitExport\(token, generation\);/);
  // Legacy channels (decision for all clients): never send under a node-chosen key.
  const store = readFileSync(new URL('./channelKeyStore.ts', import.meta.url), 'utf8');
  for (const src of [cc, store]) {
    assert.doesNotMatch(src, /bestForSendLegacy\(|allowUnverified:/);
  }
  // Every wrap from our own slot says whether WE authored it; foreign keys are bounded.
  // (The decisions themselves are behaviour-tested in channelKeyFlows.test.ts; this pins the wiring.)
  assert.equal((cc.match(/source: 'wrap', author: w\.wallet, nodeHighest: nv\.highest/g) ?? []).length, 2);
  assert.match(cc, /ownSlotWrapOpts\(how\.author, ctx\.wallet, meta, how\.nodeHighest\)/);
  assert.match(cc, /putLegacyKey\(keys, scopeHex, env\.epoch, key, ctx\.generation, nv\.highest\) === 'missing'/);
  assert.match(cc, /return markFinalFromCommitment\(keys, scopeHex, epoch, info, ctx\.generation\);/);
  assert.match(cc, /return \{ targets, incomplete: r\.incomplete, rejected: r\.targets\.length - targets\.length \};/);
  assert.doesNotMatch(cc, /keys\.put\([^)]*currentSwitchGeneration\(\)/, 'flows put with the CAPTURED generation');
  const dec = fnBody(cc, 'export async function decryptChannelMessage(');
  assert.match(dec, /if \(!nv\.known\) return \{ kind: 'waiting' \};/);
  assert.match(cc, /return keys\.importFromVault\(rec, generation\);/);
  // SDK keyring adoption: copies → byte comparisons only; node-served envelopes epoch-bound;
  // trust only from author-verified paths; sends / covers only under trusted FINAL keys.
  assert.doesNotMatch(cc, /\.key === |=== key\b/);
  assert.doesNotMatch(cc, /allowUnverified|markVerified|loadKeyMeta/);
  const fetchFn = fnBody(cc, 'async function fetchChannelKey(');
  assert.match(fetchFn, /if \(!acceptFetchedEnvelope\(requested, env\.epoch\)\) \{/);
  const best = fnBody(cc, 'async function bestChannelKey(');
  assert.match(best, /await refreshTrust\(ctx, channelId, scope, scopeHex, nv, hint\);/);
  assert.match(best, /return keys\.sendKey\(scopeHex, nv\.highest\);/);
  const coverFn = fnBody(cc, 'export async function coverChannelMembers(');
  assert.match(coverFn, /const wrappable = held\.trusted && held\.final;/);
  assert.match(coverFn, /if \(action === 'publish' && !wrappable\) \{/);
  const ensure = fnBody(cc, 'export async function ensureChannelKeyForSend(');
  assert.match(ensure, /source: 'establish', provisional: true, verified: true/);
  // Peers only from the user's known nodes + the on-chain registry (never the home node's list).
  const peers = fnBody(cc, 'async function peerNodes(');
  assert.match(peers, /selectPeerCandidates\(\{ known: getKnownNodes\(\), registry, home \}\)/);
  assert.doesNotMatch(peers, /listNodes/);
  assert.match(peers, /markNoRedirect\(u\)/);
  // Only verified paths persist a pair; a pair the node reports is never used.
  assert.doesNotMatch(cc, /metaFromCommitment|saveKeyMeta\(proofStore, ctx\.wallet, network, channelId, epoch, m\)/);
  assert.match(cc, /registerWalletSwitchReset\(resetCoverState\)/);
  const reset = fnBody(cc, 'function resetCoverState(');
  assert.match(reset, /epochAccounts\.reset\(\)/);
  assert.match(reset, /establishing\.clear\(\)/);
});

test('channelCrypto: rotation obeys the id-floor rule; the send path never waits for a rotation', () => {
  const rot = fnBody(cc, 'export async function rotateChannelKey(');
  assert.match(rot, /if \(!rotationAllowed\(channelId, hasPin\)\) \{/);
  assert.doesNotMatch(rot, /isPrivate|hint/);
  const send = fnBody(cc, 'export async function ensureChannelKeyForSend(');
  assert.match(send, /const effFloor = effectiveFloor\(channelId, floor, hasPin\);/);
  assert.match(send, /void rotateChannelKey\(channelId, floor\);\s*return alignWait\('rekeying', channelKeyStatus\(channelId\)\);/);
  assert.doesNotMatch(send, /return 'rekeying';/, 'every re-keying answer is aligned with the banner state');
  assert.doesNotMatch(send, /await rotateChannelKey/);
  assert.match(send, /if \(mode === 'defer'\) return 'waiting';/);
  const heal = fnBody(cc, 'async function maybeHeal(');
  assert.match(heal, /healApplies\(\{/);
  assert.match(heal, /gatedPlan\(\s*gate, channelId, \(\) => alreadyAt\(scopeHex, epoch \+ 1, nv\.highest\)/);
  const heal2 = fnBody(cc, 'async function maybeHeal(');
  assert.match(heal2, /await refreshTrust\(ctx, channelId, scope, scopeHex, nv, true\);\s*if \(!keys\.healEligible\(scopeHex, epoch, nv\.highest\)\) return;/);
});

test('callers pass the channel-type hint (id-floor aware) and never a hint to rotation', () => {
  const chat = readFileSync(new URL('../pages/ChatView.tsx', import.meta.url), 'utf8');
  const side = readFileSync(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8');
  assert.match(chat, /resolveIsPrivateForCover\(channelInfo\.state, channelInfo\(\)\?\.channel, CHANNEL_TYPE_PRIVATE, props\.channelId\)/);
  assert.match(chat, /resolveIsEncrypted\(channelInfo\.state, channelInfo\(\)\?\.channel, CHANNEL_TYPE_PRIVATE, props\.channelId\)/);
  assert.match(chat, /rotateChannelKey\(props\.channelId, floor\);/);
  assert.match(chat, /coverChannelMembers\(props\.channelId, untrack\(coverHint\)\)/);
  assert.equal((chat.match(/encFloor\(\), coverHint\(\)\)/g) ?? []).length, 2);
  assert.equal((chat.match(/if \(typeof built === 'string'\) \{/g) ?? []).length, 2);
  assert.match(side, /coverChannelMembers\(ev\.channel_id, coverHint\(\), \{ immediate: true \}\)/);
  assert.match(side, /rotateChannelKey\(ev\.channel_id, ev\.key_epoch_floor\);/);
  assert.match(side, /void resumePendingEpochKeys\(/);
});

test('W1: pin-on-create only for a private-range id, re-checked after the await', () => {
  const src = readFileSync(new URL('../pages/ChannelCreateView.tsx', import.meta.url), 'utf8');
  assert.match(src, /if \(isPrivate && me && Number\.isSafeInteger\(resp\.channel_id\) && !isPublicRangeChannelId\(resp\.channel_id\)\) \{/);
  assert.match(src, /client\.getNetwork\(\)\.then\(\(network\) => \{\s*if \(!sameAccount\(\)\) return;\s*savePinIfAbsent\(/);
});

test('B2: own device re-binds when its enc key is not wallet-bound', () => {
  const src = readFileSync(new URL('./deviceEnc.ts', import.meta.url), 'utf8');
  assert.match(src, /registryBound = \(await verifyEncKeyBinding\(exact, wallet, network\)\)\.status === 'bound';/);
  assert.match(src, /registryOk = registryOk && registryBound;/);
  assert.match(src, /if \(registryOk && getSetting\('encKeyBound'\) === marker\) return;/);
  // Re-bind bounded: never on nodes that keep no bindings, backoff per (wallet, device, enc_pub).
  assert.match(src, /if \(!nodeKeepsBindings\(health\)\) \{/);
  assert.match(src, /if \(!rebindAllowed\(walletStore, wallet, deviceId, kp\.publicKeyHex, Date\.now\(\), true\)\) \{/);
  assert.match(src, /if \(rebinding && isRateLimit\(e\)\) noteRebindAttempt\(/);
  // Revocation only of rows whose binding verifies for OUR device id.
  assert.match(src, /const stale = await revocableEncRows\(keys, wallet, deviceId, currentEncPub, network, verifyEncKeyBinding\);/);
});
