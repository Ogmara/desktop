/**
 * Sidebar account-ownership rules (desktop 1.82.0). Run:
 *   node --conditions=browser --test src/lib/sidebarState.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canUseLiveChannelList, createOwnedMemory } from './sidebarState.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);

test('live channel list: only a settled, live list fetched for THIS wallet may drive writes', () => {
  const ok = { loading: false, liveOwner: A, wallet: A, authReady: true };
  assert.equal(canUseLiveChannelList(ok), true);
  assert.equal(canUseLiveChannelList({ ...ok, loading: true }), false, 'still loading (Solid shows previous value)');
  assert.equal(canUseLiveChannelList({ ...ok, liveOwner: null }), false, 'cached fallback');
  assert.equal(canUseLiveChannelList({ ...ok, wallet: B }), false, 'list fetched for the previous account');
  assert.equal(canUseLiveChannelList({ ...ok, authReady: false }), false);
  assert.equal(canUseLiveChannelList({ ...ok, wallet: null, liveOwner: null }), false, 'null === null is not ownership');
});

test('tab memory: a different wallet never reads the previous one\'s route', () => {
  const mem = createOwnedMemory(() => ({ dm: '/dm' }), A);
  mem.write(A, { dm: '/dm/klv1peerOfA' });
  assert.equal(mem.read(A).dm, '/dm/klv1peerOfA');
  // Switch without the eager reset having run (a click racing the effect):
  assert.equal(mem.read(B).dm, '/dm');
  assert.equal(mem.owner(), B);
  // And A's route does not come back when switching back.
  assert.equal(mem.read(A).dm, '/dm');
});

test('tab memory: a write under another wallet resets before merging', () => {
  const mem = createOwnedMemory(() => ({ dm: '/dm', feed: '/news?feed=global' }), A);
  mem.write(A, { feed: '/news?feed=following' });
  mem.write(B, { dm: '/dm/klv1peerOfB' });
  assert.deepEqual(mem.read(B), { dm: '/dm/klv1peerOfB', feed: '/news?feed=global' });
});

test('tab memory: reset() hands ownership over with defaults', () => {
  const mem = createOwnedMemory(() => ({ dm: '/dm' }), A);
  mem.write(A, { dm: '/dm/x' });
  mem.reset(B);
  assert.equal(mem.owner(), B);
  assert.equal(mem.read(B).dm, '/dm');
});

test('negative control: an UNOWNED memory (the old closure-variable shape) leaks', () => {
  // What the pre-1.82.0 Sidebar did: one variable, no owner.
  let lastDmRoute = '/dm';
  lastDmRoute = '/dm/klv1peerOfA'; // recorded under A
  const readAsB = lastDmRoute;     // read after switching to B
  assert.notEqual(readAsB, '/dm', 'the shape the owned memory exists to prevent');
});

// --- Source probes: wiring that a pure test cannot reach -------------------

const sidebarSrc = readFileSync(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8');

test('Sidebar: both storage-writing effects are gated by canUseLiveChannelList', () => {
  const syncIdx = sidebarSrc.indexOf('syncJoinedWithApi(all)');
  const baseIdx = sidebarSrc.indexOf('isUnreadBaselinePending(me)');
  assert.ok(syncIdx > 0 && baseIdx > 0);
  for (const idx of [syncIdx, baseIdx]) {
    const effectStart = sidebarSrc.lastIndexOf('createEffect(', idx);
    const body = sidebarSrc.slice(effectStart, idx);
    assert.match(body, /canUseLiveChannelList\(/, 'gate must precede the write in the same effect');
  }
});

test('Sidebar: liveListOwner is cleared at fetch start and set only after the live success path', () => {
  const fetchStart = sidebarSrc.indexOf('liveListOwner = null;');
  const setIdx = sidebarSrc.indexOf('liveListOwner = wallet;');
  const cacheWrite = sidebarSrc.indexOf('setCachedChannels(resp.channels);');
  assert.ok(fetchStart > 0 && setIdx > fetchStart && setIdx > cacheWrite);
  // Never set in the catch (cached fallback) path.
  const catchIdx = sidebarSrc.indexOf('} catch {', setIdx);
  const finallyIdx = sidebarSrc.indexOf('} finally {', catchIdx);
  assert.doesNotMatch(sidebarSrc.slice(catchIdx, finallyIdx), /liveListOwner\s*=/);
});

test('Sidebar: no un-owned tab route memory remains', () => {
  assert.doesNotMatch(sidebarSrc, /let\s+last(Chat|Dm|Feed)Route\b/);
  assert.match(sidebarSrc, /createOwnedMemory\(/);
});
