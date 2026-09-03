/**
 * DEK tests. Run with: node --test src/lib/vaultDek.test.ts
 *
 * These cover the failure modes that would brick EVERY account at once, so
 * each corresponds to a way the user could lose access to all wallets rather
 * than just one. The store is an in-memory stand-in injected through
 * `StoreLike`, which lets the crash cases — a write that silently vanishes, a
 * destroyed or corrupt copy — actually be exercised. The crypto is the real
 * AES-GCM from `appLock`, because the point is that the DEK round-trips
 * through the SAME primitives the app uses.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SS } from './vaultAccounts.ts';
import {
  mintDek, importDek, wrapDek, unwrapDek,
  writeDekVerified, loadDek, hasDek, deleteDek,
  type StoreLike,
} from './vaultDek.ts';
import { deriveKeyFromPin, encryptWithKey, decryptWithKey } from './aesGcm.ts';

const map = new Map<string, string>();
/** Set to make the next N writes silently vanish, as a poisoned store does. */
let swallowWrites = 0;

const store: StoreLike = {
  getItemAsync: async (k) => map.get(k) ?? null,
  setItemAsync: async (k, v) => { if (swallowWrites > 0) { swallowWrites--; return; } map.set(k, v); },
  deleteItemAsync: async (k) => { map.delete(k); },
};

const salt = new Uint8Array(16).fill(7);
const pinKey = (pin = '123456') => deriveKeyFromPin(pin, salt);

beforeEach(() => { map.clear(); swallowWrites = 0; });

test('a minted DEK is 32 bytes and differs each time', () => {
  const a = mintDek(), b = mintDek();
  assert.equal(a.length, 32);
  assert.notDeepEqual(Array.from(a), Array.from(b));
});

test('wrap then unwrap round-trips under the same PIN', async () => {
  const k = await pinKey();
  const dek = mintDek();
  assert.deepEqual(Array.from(await unwrapDek(k, await wrapDek(k, dek))), Array.from(dek));
});

test('a wrong PIN cannot unwrap the DEK', async () => {
  const dek = mintDek();
  const blob = await wrapDek(await pinKey('111111'), dek);
  const wrong = await pinKey('222222');
  await assert.rejects(() => unwrapDek(wrong, blob));
});

test('the DEK actually encrypts account data through the app primitives', async () => {
  // The DEK is only useful if a slot sealed under it opens again.
  const dekKey = await importDek(mintDek());
  const secret = 'a'.repeat(64);
  assert.equal(await decryptWithKey(dekKey, await encryptWithKey(dekKey, secret)), secret);
});

test('writeDekVerified persists BOTH copies', async () => {
  const k = await pinKey();
  await writeDekVerified(k, mintDek(), store);
  assert.ok(map.get(SS.dek), 'primary');
  assert.ok(map.get(SS.dekMirror), 'mirror');
});

test('a silently-dropped DEK write is caught, not assumed to have worked', async () => {
  // A poisoned store fails every save with no error visible from here. Writing
  // account slots under a DEK that was never persisted would make all of them
  // permanently unreadable, so this must throw rather than proceed.
  const k = await pinKey();
  swallowWrites = 2;
  await assert.rejects(() => writeDekVerified(k, mintDek(), store), /did not persist/);
});

test('loadDek recovers from the mirror when the primary is destroyed', async () => {
  // The entire reason the mirror exists.
  const k = await pinKey();
  const dek = mintDek();
  await writeDekVerified(k, dek, store);
  map.delete(SS.dek);
  assert.deepEqual(Array.from((await loadDek(k, store))!), Array.from(dek));
});

test('loadDek recovers from the primary when the mirror is destroyed', async () => {
  const k = await pinKey();
  const dek = mintDek();
  await writeDekVerified(k, dek, store);
  map.delete(SS.dekMirror);
  assert.deepEqual(Array.from((await loadDek(k, store))!), Array.from(dek));
});

test('loadDek survives a corrupt primary by falling through to the mirror', async () => {
  // A half-written primary must not take the vault down while a good mirror
  // sits next to it.
  const k = await pinKey();
  const dek = mintDek();
  await writeDekVerified(k, dek, store);
  map.set(SS.dek, 'garbage:notdecryptable');
  assert.deepEqual(Array.from((await loadDek(k, store))!), Array.from(dek));
});

test('no DEK returns null, but an unusable DEK THROWS', async () => {
  // Different situations: "no PIN set" vs "wrong PIN / corrupt". Conflating
  // them would report a wrong-PIN unlock as an unencrypted vault and could
  // lead a caller to overwrite real key material.
  const k = await pinKey();
  assert.equal(await loadDek(k, store), null);
  await writeDekVerified(k, mintDek(), store);
  const wrong = await pinKey('999999');
  await assert.rejects(() => loadDek(wrong, store), /could not be unwrapped/);
});

test('hasDek reports presence from either copy alone', async () => {
  const k = await pinKey();
  assert.equal(await hasDek(store), false);
  await writeDekVerified(k, mintDek(), store);
  map.delete(SS.dek);
  assert.equal(await hasDek(store), true, 'mirror alone still counts as PIN mode');
});

test('deleteDek removes both copies', async () => {
  const k = await pinKey();
  await writeDekVerified(k, mintDek(), store);
  await deleteDek(store);
  assert.equal(await hasDek(store), false);
});

test('changing the PIN rewrites only the DEK, leaving slots openable', async () => {
  // The payoff of the whole design: a PIN change must not touch account slots.
  const oldK = await pinKey('111111');
  const newK = await pinKey('222222');
  const dek = mintDek();
  await writeDekVerified(oldK, dek, store);

  const dekKey = await importDek(dek);
  const slot = await encryptWithKey(dekKey, 'b'.repeat(64));

  await writeDekVerified(newK, dek, store); // rewrap under the new PIN only

  const recovered = await loadDek(newK, store);
  assert.deepEqual(Array.from(recovered!), Array.from(dek));
  assert.equal(await decryptWithKey(await importDek(recovered!), slot), 'b'.repeat(64));
  await assert.rejects(() => loadDek(oldK, store), /could not be unwrapped/);
});
