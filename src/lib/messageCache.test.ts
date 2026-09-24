/**
 * Behavioral regression tests for the channel/DM message-history cache.
 * Run: node --test src/lib/messageCache.test.ts
 *
 * Covers the four `mergeMessages` branches from the design doc in
 * `messageCache.ts` (empty cache, full-overlap update, partial overlap,
 * disconnected-island discard), the optimistic/local-id filter, wallet AND
 * node scoping (cross-account/cross-node leakage), the quota-exceeded
 * eviction path, and the corrupt-cache fallthrough.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class MemStorage {
  private m = new Map<string, string>();
  private quotaLimit: number | null = null;
  setQuotaLimit(n: number | null): void { this.quotaLimit = n; }
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void {
    if (this.quotaLimit !== null) {
      let total = v.length;
      for (const [key, val] of this.m) if (key !== k) total += val.length;
      if (total > this.quotaLimit) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
    }
    this.m.set(k, v);
  }
  removeItem(k: string): void { this.m.delete(k); }
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
}

// `walletScope.ts` is a self-contained leaf module (no localStorage read at
// its own top level), so a static import would normally be fine here — but
// dynamic `import()` is used for consistency with the sibling scoping
// tests in this repo (`deviceIdScope.test.ts`) and so this file keeps
// working unchanged if `messageCache.ts` ever grows a heavier dependency.
let storage = new MemStorage();
(globalThis as unknown as { localStorage: Storage }).localStorage = storage as unknown as Storage;
const {
  readCachedMessages, writeCachedMessages, clearCachedMessages, mergeMessages, isAccessRevokedError, MAX_ROWS_PER_CONV,
} = await import('./messageCache.ts');
const { setWalletScope } = await import('./walletScope.ts');

const WALLET_A = 'klv1' + 'a'.repeat(58);
const WALLET_B = 'klv1' + 'b'.repeat(58);
const NODE = 'https://node-a.example';
const NODE_2 = 'https://node-b.example';

function msg(id: string, ts: number, extra: Record<string, unknown> = {}) {
  return {
    msg_id: id,
    author: 'klv1author',
    timestamp: ts,
    lamport_ts: ts,
    version: 2,
    msg_type: 1,
    channel_id: 42,
    payload: [1, 2, 3, 4],
    signature: new Array(64).fill(9),
    relay_path: ['peer1', 'peer2'],
    ...extra,
  };
}

beforeEach(() => {
  storage = new MemStorage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage as unknown as Storage;
  // `messageCache.ts`'s in-memory `warm` layer is module-level state that
  // outlives any one test. Routing through `null` first guarantees the
  // wallet actually CHANGES (transitioning through no-active-wallet), which
  // fires `registerWalletSwitchReset`'s callbacks and clears `warm` — a
  // bare `setWalletScope(WALLET_A)` would be a no-op reset whenever the
  // previous test also ended on WALLET_A, leaking that test's warm entries
  // into this one.
  setWalletScope(null);
  setWalletScope(WALLET_A);
});

// --- mergeMessages: the four branches ---

test('mergeMessages: empty cache + fresh page -> fresh becomes the result', () => {
  const fresh = [msg('m1', 100), msg('m2', 200)];
  const result = mergeMessages([], fresh, 50);
  assert.deepEqual(result.map((m) => m.msg_id), ['m1', 'm2']);
});

test('mergeMessages: full overlap -> fresh row wins wholesale (edit/delete surfaces)', () => {
  const cached = [msg('m1', 100, { edited: false, payload: [1, 1, 1] })];
  const fresh = [msg('m1', 100, { edited: true, payload: [9, 9, 9] })];
  const result = mergeMessages(cached, fresh, 50);
  assert.equal(result.length, 1);
  assert.equal(result[0].edited, true, 'the fresh (validated) row must win, not the stale cached one');
  assert.deepEqual(result[0].payload, [9, 9, 9]);
});

test('mergeMessages: fresh row with deleted:true overrides a cached row with real content — no field-level merge', () => {
  const cached = [msg('m1', 100, { payload: [1, 2, 3], deleted: false })];
  const fresh = [msg('m1', 100, { payload: null, deleted: true })];
  const result = mergeMessages(cached, fresh, 50);
  assert.equal(result[0].deleted, true);
  assert.equal(result[0].payload, null, 'a field-level merge would have resurrected the cached payload — must not happen');
});

test('mergeMessages: partial overlap -> union of both, fresh wins on the shared id', () => {
  const cached = [msg('m1', 100), msg('m2', 200, { edited: false })];
  const fresh = [msg('m2', 200, { edited: true }), msg('m3', 300)];
  const result = mergeMessages(cached, fresh, 50);
  assert.deepEqual(result.map((m) => m.msg_id), ['m1', 'm2', 'm3']);
  assert.equal(result.find((m) => m.msg_id === 'm2')?.edited, true);
});

test('mergeMessages: disconnected island (no overlap, full page) -> cache DISCARDED entirely', () => {
  const cached = [msg('old1', 10), msg('old2', 20)];
  const fresh = Array.from({ length: 50 }, (_, i) => msg(`new${i}`, 1000 + i));
  const result = mergeMessages(cached, fresh, 50);
  assert.equal(result.some((m) => m.msg_id === 'old1' || m.msg_id === 'old2'), false,
    'unvalidated cached rows with zero overlap and a full fresh page must never render — their edit/delete state cannot be verified');
  assert.equal(result.length, 50);
});

test('mergeMessages: no overlap but a SHORT fresh page -> union kept, not discarded (not enough total messages to tell "disconnected" from "that\'s just everything")', () => {
  const cached = [msg('old1', 10)];
  const fresh = [msg('new1', 20)];
  const result = mergeMessages(cached, fresh, 50);
  assert.deepEqual(result.map((m) => m.msg_id).sort(), ['new1', 'old1']);
});

test('mergeMessages: empty fresh page is a no-op union (keeps cache, does not discard)', () => {
  const cached = [msg('m1', 100), msg('m2', 200)];
  const result = mergeMessages(cached, [], 50);
  assert.deepEqual(result.map((m) => m.msg_id), ['m1', 'm2']);
});

test('mergeMessages: result is capped at MAX_ROWS_PER_CONV, keeping the newest', () => {
  const cached = Array.from({ length: MAX_ROWS_PER_CONV + 20 }, (_, i) => msg(`c${i}`, i));
  const result = mergeMessages(cached, [], 50);
  assert.equal(result.length, MAX_ROWS_PER_CONV);
  assert.equal(result[result.length - 1].msg_id, `c${MAX_ROWS_PER_CONV + 19}`, 'must keep the NEWEST rows, not the oldest');
});

// --- write/read round-trip ---

test('writeCachedMessages + readCachedMessages: round-trips payload correctly (number[] in, Uint8Array out)', () => {
  writeCachedMessages('ch', 42, [msg('m1', 100, { payload: [10, 20, 30, 255] })], NODE);
  const rows = readCachedMessages('ch', 42, NODE);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].payload instanceof Uint8Array);
  assert.deepEqual(Array.from(rows[0].payload as Uint8Array), [10, 20, 30, 255]);
});

test('writeCachedMessages: drops signature and relay_path (storage amplification), keeps other enrichment fields', () => {
  writeCachedMessages('ch', 42, [msg('m1', 100, { reactions: { '👍': 3 }, deleted: true })], NODE);
  const key = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  const raw = storage.getItem(key);
  assert.ok(raw, 'expected a value at the wallet-scoped key');
  assert.equal(raw!.includes('signature'), false);
  assert.equal(raw!.includes('relay_path'), false);
  const rows = readCachedMessages('ch', 42, NODE);
  assert.deepEqual(rows[0].reactions, { '👍': 3 });
  assert.equal(rows[0].deleted, true);
});

test('writeCachedMessages: filters out optimistic and local- id rows', () => {
  writeCachedMessages('ch', 42, [
    msg('m1', 100),
    { ...msg('local-abc', 200), _optimistic: true },
    msg('local-xyz', 300),
  ], NODE);
  const rows = readCachedMessages('ch', 42, NODE);
  assert.deepEqual(rows.map((r) => r.msg_id), ['m1']);
});

test('writeCachedMessages: caps at MAX_ROWS_PER_CONV, keeping newest', () => {
  const many = Array.from({ length: MAX_ROWS_PER_CONV + 30 }, (_, i) => msg(`m${i}`, i));
  writeCachedMessages('ch', 42, many, NODE);
  const rows = readCachedMessages('ch', 42, NODE);
  assert.equal(rows.length, MAX_ROWS_PER_CONV);
  assert.equal(rows[0].msg_id, 'm30', 'oldest 30 must have been trimmed');
});

test('readCachedMessages: cold cache (never written) returns empty array, not an error', () => {
  assert.deepEqual(readCachedMessages('ch', 999, NODE), []);
  assert.deepEqual(readCachedMessages('dm', 'klv1nobody', NODE), []);
});

test('readCachedMessages: corrupt/hand-edited JSON falls through to empty (cold-cache treatment), does not throw', () => {
  const key = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  storage.setItem(key, '{not valid json');
  assert.deepEqual(readCachedMessages('ch', 42, NODE), []);
});

test('readCachedMessages: schema-version mismatch falls through to empty', () => {
  const key = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  storage.setItem(key, JSON.stringify({ v: 999, rows: [{ msg_id: 'm1', timestamp: 1, payload: '' }] }));
  assert.deepEqual(readCachedMessages('ch', 42, NODE), []);
});

// --- wallet scoping: the cross-account leakage class of bug ---

test('cache is wallet-scoped: switching accounts never sees the previous account\'s cached messages', () => {
  setWalletScope(WALLET_A);
  writeCachedMessages('ch', 42, [msg('secret-a', 100)], NODE);

  setWalletScope(WALLET_B);
  assert.deepEqual(readCachedMessages('ch', 42, NODE), [], 'a different wallet must not see wallet A\'s cached channel 42 history');
  writeCachedMessages('ch', 42, [msg('for-b', 200)], NODE);

  setWalletScope(WALLET_A);
  const rowsA = readCachedMessages('ch', 42, NODE);
  assert.deepEqual(rowsA.map((r) => r.msg_id), ['secret-a'], 'switching back must restore only THIS account\'s cache');
});

test('cache keys are address-suffixed and the bare (pre-scoping) key never holds a live value', () => {
  setWalletScope(WALLET_A);
  writeCachedMessages('ch', 42, [msg('m1', 100)], NODE);
  const scopedKeyStr = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  assert.ok(storage.getItem(scopedKeyStr));
  assert.equal(storage.getItem(`ogmara.msgCache.${NODE}.ch.42`), null);
});

// --- node scoping: switching nodes must not serve the wrong node's history ---

test('cache is node-scoped: switching nodes never sees the previous node\'s cached messages for the "same" channel id', () => {
  writeCachedMessages('ch', 1, [msg('from-node-a', 100)], NODE);
  assert.deepEqual(readCachedMessages('ch', 1, NODE_2), [], 'a different node\'s channel 1 is a different conversation entirely');
  writeCachedMessages('ch', 1, [msg('from-node-b', 200)], NODE_2);
  assert.deepEqual(readCachedMessages('ch', 1, NODE).map((r) => r.msg_id), ['from-node-a']);
  assert.deepEqual(readCachedMessages('ch', 1, NODE_2).map((r) => r.msg_id), ['from-node-b']);
});

test('clearCachedMessages: removes a conversation\'s cache immediately', () => {
  writeCachedMessages('ch', 42, [msg('m1', 100)], NODE);
  assert.equal(readCachedMessages('ch', 42, NODE).length, 1);
  clearCachedMessages('ch', 42, NODE);
  assert.deepEqual(readCachedMessages('ch', 42, NODE), []);
});

// --- quota handling ---

// Both quota behaviors (eviction succeeds; then repeated unfixable
// failures are rate-limited) are in ONE sequential test rather than two —
// `lastEvictionAttemptAt`'s cooldown is process-lifetime module state with
// no test-reset hook (unlike `warm`, which `registerWalletSwitchReset`
// clears), so two separate `test()` blocks could interfere depending on
// execution order/timing. Testing the sequence in one test is also just a
// more accurate model of what actually happens at runtime.
test('writeCachedMessages: quota-exceeded evicts siblings and retries once (verified on DISK); further failures within the cooldown do not cascade', () => {
  // Fill several sizeable sibling conversations first so there's real
  // quota to reclaim by evicting them.
  for (let i = 0; i < 5; i++) {
    const rows = Array.from({ length: 10 }, (_, j) => msg(`sib${i}-${j}`, j, { payload: new Array(500).fill(1) }));
    writeCachedMessages('ch', i, rows, NODE);
  }
  const siblingBytes = storage.getItem(`ogmara.msgCache.${NODE}.ch.0::${WALLET_A}`)!.length;
  // Quota room for roughly the 5 siblings plus a bit, but NOT enough for
  // siblings + the new write too — freeing must come from eviction.
  storage.setQuotaLimit(siblingBytes * 5 + 200);

  const big = Array.from({ length: 10 }, (_, j) => msg(`big${j}`, j, { payload: new Array(500).fill(2) }));
  writeCachedMessages('ch', 99, big, NODE);

  // The critical assertion the original (broken) version of this test
  // missed: check DISK directly, not `readCachedMessages` (which
  // consults the in-memory `warm` layer FIRST and would report success
  // even if the disk write silently failed).
  const diskKey = `ogmara.msgCache.${NODE}.ch.99::${WALLET_A}`;
  const onDisk = storage.getItem(diskKey);
  assert.ok(onDisk !== null, 'the write must actually reach disk after eviction frees room, not just the in-memory warm cache');
  assert.ok(JSON.parse(onDisk!).rows.length > 0);

  const survivorsAfterFirst = [0, 1, 2, 3, 4].filter(
    (i) => storage.getItem(`ogmara.msgCache.${NODE}.ch.${i}::${WALLET_A}`) !== null,
  ).length;
  assert.ok(survivorsAfterFirst < 5, 'eviction must have actually removed at least one sibling conversation to free the room');

  // Now shrink the quota further so NOTHING can ever fit, even after
  // evicting every remaining sibling — eviction cannot fix this. Repeated
  // failing writes right after the one above (still inside the cooldown
  // window) must not trigger further eviction passes.
  storage.setQuotaLimit(10);
  writeCachedMessages('ch', 200, big, NODE);
  writeCachedMessages('ch', 201, big, NODE);
  const survivorsAfterMore = [0, 1, 2, 3, 4].filter(
    (i) => storage.getItem(`ogmara.msgCache.${NODE}.ch.${i}::${WALLET_A}`) !== null,
  ).length;
  assert.equal(survivorsAfterMore, survivorsAfterFirst,
    'once eviction has already been attempted once, further failing writes within the cooldown window must NOT trigger another eviction pass — otherwise a single unfixable write keeps destroying every other cached conversation');
});

// --- known-fixture check: the DM kind is a distinct key from the channel kind ---

test('channel and DM caches for the "same id" never collide', () => {
  writeCachedMessages('ch', 42, [msg('channel-msg', 100)], NODE);
  writeCachedMessages('dm', 42 as unknown as string, [msg('dm-msg', 100)], NODE);
  assert.deepEqual(readCachedMessages('ch', 42, NODE).map((r) => r.msg_id), ['channel-msg']);
  assert.deepEqual(readCachedMessages('dm', 42 as unknown as string, NODE).map((r) => r.msg_id), ['dm-msg']);
});

// --- TTL: a conversation not revisited in a long time is not trusted forever ---

test('readCachedMessages: a conversation past MAX_CACHE_AGE_MS is treated as cold, not stale-but-shown', () => {
  const key = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  storage.setItem(key, JSON.stringify({
    v: 2,
    cachedAt: eightDaysAgo,
    rows: [{ msg_id: 'm1', timestamp: 1, payload: '' }],
  }));
  assert.deepEqual(readCachedMessages('ch', 42, NODE), []);
});

test('readCachedMessages: a conversation well within MAX_CACHE_AGE_MS is still trusted', () => {
  const key = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  storage.setItem(key, JSON.stringify({
    v: 2,
    cachedAt: oneHourAgo,
    rows: [{ msg_id: 'm1', timestamp: 1, payload: '' }],
  }));
  assert.deepEqual(readCachedMessages('ch', 42, NODE).map((r) => r.msg_id), ['m1']);
});

test('readCachedMessages: a stale version-mismatched blob is removed from disk on read, not left stranded', () => {
  const key = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  storage.setItem(key, JSON.stringify({ v: 999, rows: [{ msg_id: 'm1', timestamp: 1, payload: '' }] }));
  assert.deepEqual(readCachedMessages('ch', 42, NODE), []);
  assert.equal(storage.getItem(key), null, 'a version-mismatched blob must be cleaned up, not stranded forever untracked by the LRU');
});

// --- round-2 re-audit fixes ---

test('readCachedMessages: a corrupt blob with a null/malformed row element is skipped, not thrown (would otherwise break the whole calling view for the session)', () => {
  const key = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  storage.setItem(key, JSON.stringify({
    v: 2,
    cachedAt: Date.now(),
    rows: [{ msg_id: 'good', timestamp: 1, payload: '' }, null, 'not-an-object', { msg_id: 'good2', timestamp: 2, payload: '' }],
  }));
  const rows = readCachedMessages('ch', 42, NODE);
  assert.deepEqual(rows.map((r) => r.msg_id), ['good', 'good2'], 'malformed elements are skipped; well-formed ones around them still come through');
});

test('writeCachedMessages: the in-memory warm layer matches what was ACTUALLY persisted to disk after a self-trim, not the pre-trim version', () => {
  const many = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, i, { payload: new Array(20000).fill(i % 256) }));
  writeCachedMessages('ch', 42, many, NODE);
  const key = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  const onDisk = JSON.parse(storage.getItem(key)!);
  // Read via the warm layer (no disk round-trip — same tab, same process).
  const viaWarm = readCachedMessages('ch', 42, NODE);
  assert.equal(viaWarm.length, onDisk.rows.length,
    'the warm (in-memory) row count must match what is actually on disk — they previously disagreed after a self-trim');
});

test('isAccessRevokedError: anchored to the START — a 500 whose response body happens to quote 404-shaped text is NOT treated as access-revoked', () => {
  assert.equal(isAccessRevokedError(new Error('API error (500): upstream said "API error (404): not found" while proxying')), false);
  assert.equal(isAccessRevokedError(new Error('API error (403): forbidden')), true);
});

// --- per-row / per-conversation byte bounds (hostile-content DoS) ---

test('writeCachedMessages: a row whose payload exceeds the protocol max chat-payload size is dropped, not cached', () => {
  const oversized = msg('m1', 100, { payload: new Array(65536 + 1).fill(1) });
  writeCachedMessages('ch', 42, [msg('m0', 50), oversized], NODE);
  const rows = readCachedMessages('ch', 42, NODE);
  assert.deepEqual(rows.map((r) => r.msg_id), ['m0'], 'the oversized row must be dropped; other rows in the same write are unaffected');
});

test('writeCachedMessages: a conversation whose rows would serialize past MAX_CONV_SERIALIZED_BYTES self-trims its OWN oldest rows, not siblings', () => {
  // Each row's payload is comfortably under the per-row cap but many of
  // them together exceed the per-conversation budget.
  const many = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, i, { payload: new Array(20000).fill(i % 256) }));
  writeCachedMessages('ch', 42, many, NODE);
  const key = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  const raw = storage.getItem(key);
  assert.ok(raw, 'the write must still land on disk (self-trimmed), not fail outright');
  assert.ok(raw!.length <= 512 * 1024 + 1024, 'serialized size must be trimmed to roughly the per-conversation budget');
  const rows = readCachedMessages('ch', 42, NODE);
  assert.ok(rows.length > 0);
  // Self-trim removes from the OLDEST end.
  const ids = rows.map((r) => r.msg_id);
  assert.equal(ids[ids.length - 1], 'm49', 'the newest row must survive the self-trim');
});

// --- projection correctness: strip client-only fields, reject malformed payloads ---

test('writeCachedMessages: strips ALL underscore-prefixed client-only fields, not just the ones currently known', () => {
  const row = msg('m1', 100, { _media: { key: 'plaintext-content-key-should-never-be-cached' }, _futureClientField: 'whatever' });
  writeCachedMessages('ch', 42, [row], NODE);
  const key = `ogmara.msgCache.${NODE}.ch.42::${WALLET_A}`;
  const raw = storage.getItem(key)!;
  assert.equal(raw.includes('plaintext-content-key'), false);
  assert.equal(raw.includes('_futureClientField'), false);
  const rows = readCachedMessages('ch', 42, NODE);
  assert.equal((rows[0] as any)._media, undefined);
});

test('writeCachedMessages: a non-array/Uint8Array payload (e.g. a string, from an optimistic-edit fallback path) drops the row rather than caching a corrupted one', () => {
  const bad = msg('real-id-123', 100, { payload: 'oops this is a string not bytes' });
  writeCachedMessages('ch', 42, [msg('m0', 50), bad], NODE);
  const rows = readCachedMessages('ch', 42, NODE);
  assert.deepEqual(rows.map((r) => r.msg_id), ['m0'], 'the malformed-payload row must be dropped entirely, never cached zero-filled under its real id');
});

test('writeCachedMessages/mergeMessages: a byte-array (non-string) msg_id round-trips via hex normalization instead of being silently dropped', () => {
  const withByteArrayId = { ...msg('placeholder', 100), msg_id: [0xde, 0xad, 0xbe, 0xef] };
  writeCachedMessages('ch', 42, [withByteArrayId], NODE);
  const rows = readCachedMessages('ch', 42, NODE);
  assert.deepEqual(rows.map((r) => r.msg_id), ['deadbeef']);

  const merged = mergeMessages([], [{ ...msg('x', 1), msg_id: new Uint8Array([0xab, 0xcd]) }], 50);
  assert.deepEqual(merged.map((m: any) => m.msg_id instanceof Uint8Array ? Array.from(m.msg_id) : m.msg_id), [[0xab, 0xcd]],
    'mergeMessages passes through whatever msg_id shape it was given (only its OWN internal id lookups normalize) — this asserts the row was not silently dropped from the result');
});

// --- mergeMessages must not mutate the resource's array in place ---

test('mergeMessages: the discard branch does not mutate or alias the `fresh` array (would otherwise mutate a live createResource value)', () => {
  const fresh = Array.from({ length: 50 }, (_, i) => msg(`new${i}`, 1000 - i)); // deliberately UNSORTED
  const freshCopyForComparison = [...fresh];
  const result = mergeMessages([msg('old', 1)], fresh, 50);
  assert.notEqual(result, fresh, 'result must not be the same array instance as fresh');
  assert.deepEqual(fresh, freshCopyForComparison, 'the original fresh array must be untouched (still unsorted) after mergeMessages sorted its OWN copy');
});

// --- id sanity bound ---

test('writeCachedMessages/readCachedMessages: a pathologically long id (e.g. a crafted DM route param) is rejected as a no-op, not stored', () => {
  const hugeId = 'klv1' + 'x'.repeat(500);
  writeCachedMessages('dm', hugeId, [msg('m1', 100)], NODE);
  assert.deepEqual(readCachedMessages('dm', hugeId, NODE), []);
});

// --- isAccessRevokedError ---

test('isAccessRevokedError: true for 403/404 SDK errors, false for other failures', () => {
  assert.equal(isAccessRevokedError(new Error('API error (403): forbidden')), true);
  assert.equal(isAccessRevokedError(new Error('API error (404): not found')), true);
  assert.equal(isAccessRevokedError(new Error('API error (500): server error')), false);
  assert.equal(isAccessRevokedError(new Error('Failed to fetch')), false);
  assert.equal(isAccessRevokedError(new TypeError('network error')), false);
  assert.equal(isAccessRevokedError('not even an Error object'), false);
});

// --- round-4 re-audit fixes: no-active-wallet guard, always-touch LRU tracking ---

test('writeCachedMessages/readCachedMessages: no-op with no active wallet, and do not repopulate `warm` for a later wallet to see', () => {
  setWalletScope(null);
  writeCachedMessages('ch', 42, [msg('should-not-persist', 100)], NODE);
  assert.deepEqual(readCachedMessages('ch', 42, NODE), [],
    'a write with no active wallet must be a total no-op, including the in-memory warm layer — not just skip the disk write');

  setWalletScope(WALLET_A);
  assert.deepEqual(readCachedMessages('ch', 42, NODE), [],
    'the very next wallet to become active must not see anything from the no-wallet write');
});

test('writeCachedMessages: a conversation is LRU-evictable even after a totally failed write, not stranded in `warm` forever', () => {
  // A quota sized to fail the conversation's own blob (measured ~177
  // bytes for one small row) while the shared LRU index's much smaller
  // increment (measured ~63 bytes for one entry) still fits — otherwise
  // BOTH writes fail identically and this test can't distinguish "fixed"
  // from "still broken" (an earlier version of this test used quota=1,
  // which failed everything including the index, and passed for the
  // wrong reason — it never actually got past `writeConvToDisk` failing,
  // let alone reached the `touch()` call this test exists to check).
  storage.setQuotaLimit(100);
  writeCachedMessages('ch', 999, [msg('never-persisted', 100)], NODE);
  storage.setQuotaLimit(null); // lift it — later, legitimate writes must succeed
  // It must still be readable from the in-memory warm layer (by design —
  // this tab's view stays populated even though disk never got it).
  assert.ok(readCachedMessages('ch', 999, NODE).length > 0, 'expected the failed write to still be readable from warm');

  // Now touch MAX_CACHED_CONVERSATIONS (30) + a few more DISTINCT
  // conversations with normal, successful writes. If conversation 999 was
  // properly recorded in the LRU index (this round's fix — `touch()` now
  // runs regardless of whether the write succeeded), it gets evicted like
  // any other cold entry. If it was stranded outside the index (the
  // round-4 bug — `touch()` used to run only on success), it survives
  // this churn forever regardless of how cold it gets.
  for (let i = 0; i < 40; i++) {
    writeCachedMessages('ch', 2000 + i, [msg(`m${i}`, i)], NODE);
  }
  assert.deepEqual(readCachedMessages('ch', 999, NODE), [],
    'a conversation from a totally-failed write must be evictable by the normal LRU churn, not permanently stranded in memory');
});

test('writeCachedMessages: `warm` stays hard-bounded at MAX_CACHED_CONVERSATIONS even when localStorage is ENTIRELY unwritable (the LRU index itself can never be recorded)', () => {
  // quota=0: every single write fails, including the LRU index's own
  // write inside touch()/evictOldestHalf — so the normal index-based
  // eviction path can never run at all (round-5 re-audit scenario:
  // private-mode "block all site data", or a quota already exhausted by
  // non-cache data).
  storage.setQuotaLimit(0);
  for (let i = 0; i < 200; i++) {
    writeCachedMessages('ch', i, [msg(`m${i}`, i)], NODE);
  }
  storage.setQuotaLimit(null);
  // Can't enumerate `warm` directly (private module state) — but if it
  // were unbounded, EVERY one of the 200 conversations written above
  // would still be readable from it. Assert that's false for at least a
  // meaningful fraction of the early ones (a hard cap evicts oldest-
  // first, so id 0 in particular must be gone).
  assert.deepEqual(readCachedMessages('ch', 0, NODE), [],
    'the very first conversation written must have been evicted from warm once the hard cap was exceeded, even though the disk-based LRU index was never once writable');
});
