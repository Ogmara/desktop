/**
 * Index tests. Run: node --test src/lib/vaultIndex.test.ts
 *
 * Each test is a way an account could vanish from the picker while its key is
 * still on disk. The two invariants — read is a union, write merges into what
 * is persisted — are checked against sources that FAIL, because a source that
 * always works cannot demonstrate either.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AS, SS, MAX_ACCOUNTS, type AccountEntry } from './vaultAccounts.ts';
import {
  readIndex, readActive, writeActive,
  persistIndexAdding, persistIndexRemoving,
  type LocalLike,
} from './vaultIndex.ts';
import type { StoreLike } from './vaultDek.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);
const C = 'klv1' + 'c'.repeat(58);

const secure = new Map<string, string>();
const localMap = new Map<string, string>();
let secureReadsFail = false;
let localThrows = false;
let keystore: string[] = [];
let keystoreThrows = false;

const store: StoreLike = {
  getItemAsync: async (k) => { if (secureReadsFail) throw new Error('poisoned'); return secure.get(k) ?? null; },
  setItemAsync: async (k, v) => { secure.set(k, v); },
  deleteItemAsync: async (k) => { secure.delete(k); },
};
const local: LocalLike = {
  getItem: (k) => { if (localThrows) throw new Error('blocked'); return localMap.get(k) ?? null; },
  setItem: (k, v) => { if (localThrows) throw new Error('blocked'); localMap.set(k, v); },
  keys: () => { if (localThrows) throw new Error('blocked'); return [...localMap.keys()]; },
};
const listKeystore = async () => { if (keystoreThrows) throw new Error('no command'); return keystore; };

const entry = (a: string, added = 1): AccountEntry => ({ a, label: null, source: 'builtin', added });

beforeEach(() => {
  secure.clear(); localMap.clear();
  secureReadsFail = false; localThrows = false; keystoreThrows = false; keystore = [];
});

// --- invariant 1: a read is the union, and survives any source failing ----

test('an account known only to the keystore is still found', async () => {
  keystore = [A];
  assert.deepEqual((await readIndex(store, local, listKeystore)).map((e) => e.a), [A]);
});

test('an account survives a poisoned secure store', async () => {
  localMap.set(AS.primaryIndex, JSON.stringify([entry(A)]));
  secureReadsFail = true;
  assert.deepEqual((await readIndex(store, local, listKeystore)).map((e) => e.a), [A]);
});

test('an account survives localStorage being unavailable', async () => {
  secure.set(SS.mirror, JSON.stringify([A]));
  localThrows = true;
  assert.deepEqual((await readIndex(store, local, listKeystore)).map((e) => e.a), [A]);
});

test('an account survives an older shell with no keystore command', async () => {
  localMap.set(AS.primaryIndex, JSON.stringify([entry(A)]));
  keystoreThrows = true;
  assert.deepEqual((await readIndex(store, local, listKeystore)).map((e) => e.a), [A]);
});

test('all four sources union without duplicating', async () => {
  localMap.set(AS.primaryIndex, JSON.stringify([entry(A)]));
  secure.set(SS.mirror, JSON.stringify([B]));
  localMap.set(`ogmara.topicGroups::${C}`, '{}');
  keystore = [A, B, C];
  const got = (await readIndex(store, local, listKeystore)).map((e) => e.a).sort();
  assert.deepEqual(got, [A, B, C].sort());
});

// --- invariant 2: writes merge into what is persisted --------------------

test('adding an account does not drop the ones already persisted', async () => {
  await persistIndexAdding(entry(A), store, local, listKeystore);
  await persistIndexAdding(entry(B, 2), store, local, listKeystore);
  const got = (await readIndex(store, local, listKeystore)).map((e) => e.a).sort();
  assert.deepEqual(got, [A, B].sort());
});

test('an account unreadable at write time is NOT erased from the index', async () => {
  // The core loss scenario: writing a probed subset back over the index means
  // a transient failure permanently removes an account whose key still exists.
  await persistIndexAdding(entry(A), store, local, listKeystore);
  keystore = [B];               // B exists on disk but is in no index yet
  await persistIndexAdding(entry(C, 3), store, local, listKeystore);
  const got = (await readIndex(store, local, listKeystore)).map((e) => e.a).sort();
  assert.deepEqual(got, [A, B, C].sort(), 'B must survive a write that never mentioned it');
});

test('re-adding an existing account updates it rather than duplicating', async () => {
  await persistIndexAdding(entry(A), store, local, listKeystore);
  const merged = await persistIndexAdding({ ...entry(A, 9), label: 'work' }, store, local, listKeystore);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].label, 'work');
});

test('removal is the only shrinking path, and it removes only its target', async () => {
  await persistIndexAdding(entry(A), store, local, listKeystore);
  await persistIndexAdding(entry(B, 2), store, local, listKeystore);
  await persistIndexRemoving(A, store, local, listKeystore);
  const got = (await readIndex(store, local, listKeystore)).map((e) => e.a);
  assert.deepEqual(got, [B]);
});

test('a removed account does not come back through the recovery scan', async () => {
  // Leftover preference keys must not resurrect a deliberately removed
  // account — the caller wipes the scope, and this asserts the ordering holds.
  await persistIndexAdding(entry(A), store, local, listKeystore);
  localMap.set(`ogmara.topicGroups::${A}`, '{}');
  await persistIndexRemoving(A, store, local, listKeystore);
  localMap.delete(`ogmara.topicGroups::${A}`);   // scope wipe
  assert.deepEqual(await readIndex(store, local, listKeystore), []);
});

test('both index copies are written, so either alone reconstructs the list', async () => {
  await persistIndexAdding(entry(A), store, local, listKeystore);
  assert.ok(localMap.get(AS.primaryIndex), 'primary');
  assert.ok(secure.get(SS.mirror), 'mirror');
  localMap.delete(AS.primaryIndex);
  assert.deepEqual((await readIndex(store, local, listKeystore)).map((e) => e.a), [A]);
});

test('a write still reaches the mirror when localStorage refuses', async () => {
  localThrows = true;
  await persistIndexAdding(entry(A), store, local, listKeystore);
  localThrows = false;
  assert.ok(secure.get(SS.mirror), 'the mirror must not be skipped when the primary throws');
});

// --- the cap applies to the untrusted scan only ---------------------------

test('a flood of scanned preference keys cannot evict real accounts', async () => {
  const reals = [entry(A, 10), entry(B, 20)];
  localMap.set(AS.primaryIndex, JSON.stringify(reals));
  for (let i = 0; i < 40; i++) {
    localMap.set(`ogmara.topicGroups::klv1${String(i).padStart(58, 'd')}`, '{}');
  }
  const got = (await readIndex(store, local, listKeystore)).map((e) => e.a);
  assert.ok(got.includes(A) && got.includes(B), 'real accounts must survive the scan cap');
});

test('the keystore listing is never capped', async () => {
  keystore = Array.from({ length: MAX_ACCOUNTS + 4 }, (_, i) => 'klv1' + String(i).padStart(58, 'f'));
  const got = await readIndex(store, local, listKeystore);
  assert.equal(got.length, keystore.length, 'a proven slot must never be dropped');
});

// --- active pointer -------------------------------------------------------

test('the active pointer round-trips and rejects a malformed value', async () => {
  await writeActive(store, A);
  assert.equal(await readActive(store), A);
  secure.set(SS.active, 'not-an-address');
  assert.equal(await readActive(store), null);
  await assert.rejects(() => writeActive(store, 'bogus'), /invalid address/);
});

test('readActive tolerates a poisoned store', async () => {
  secureReadsFail = true;
  assert.equal(await readActive(store), null);
});
