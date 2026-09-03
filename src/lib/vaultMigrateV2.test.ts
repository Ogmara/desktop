/**
 * v1 → v2 migration tests. Run: node --test src/lib/vaultMigrateV2.test.ts
 *
 * The property under test, asserted after EVERY injected crash:
 *   the user's key is still retrievable, and the vault still works.
 *
 * Crashes are injected by failing the Nth store write, which is how a real
 * interruption presents (process death, or a poisoned store that silently
 * refuses every save).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SS } from './vaultAccounts.ts';
import { migrateV1toV2, completeDeferredV2, readVersion, type MigrationEnv } from './vaultMigrateV2.ts';
import { readKeyFor, type UnlockedKeys } from './vaultAccess.ts';
import { loadDek, importDek, type StoreLike } from './vaultDek.ts';
import { deriveKeyFromPin, encryptWithKey } from './aesGcm.ts';
import type { LocalLike } from './vaultIndex.ts';

const A = 'klv1' + 'a'.repeat(58);
const KEY_A = 'a'.repeat(64);
const deriveAddress = async (hex: string) => (hex === KEY_A ? A : 'klv1' + 'z'.repeat(58));

const secure = new Map<string, string>();
const localMap = new Map<string, string>();
/** Throw on the Nth write (1-based). 0 = never. */
let failWriteAt = 0;
let writeCount = 0;

const store: StoreLike = {
  getItemAsync: async (k) => secure.get(k) ?? null,
  setItemAsync: async (k, v) => {
    writeCount++;
    if (failWriteAt && writeCount === failWriteAt) throw new Error('injected crash');
    secure.set(k, v);
  },
  deleteItemAsync: async (k) => { secure.delete(k); },
};
const local: LocalLike = {
  getItem: (k) => localMap.get(k) ?? null,
  setItem: (k, v) => { localMap.set(k, v); },
  keys: () => [...localMap.keys()],
};
const env: MigrationEnv = { store, local, listKeystore: async () => [], deriveAddress };
const salt = new Uint8Array(16).fill(5);
const NO_KEYS: UnlockedKeys = { pinKey: null, dek: null };

beforeEach(() => { secure.clear(); localMap.clear(); failWriteAt = 0; writeCount = 0; });

/** The invariant every crash test asserts. */
async function keyStillRecoverable(keys: UnlockedKeys) {
  const got = await readKeyFor(A, store, keys, deriveAddress);
  assert.equal(got.status, 'ok', 'the key must still be retrievable');
  assert.equal(got.status === 'ok' && got.hex, KEY_A);
}

// --- the raw path ---------------------------------------------------------

test('a raw v1 vault migrates, and the legacy anchor is RETAINED', async () => {
  secure.set(SS.legacyRaw, KEY_A);
  const out = await migrateV1toV2(env);
  assert.deepEqual(out, { result: 'migrated', address: A });
  assert.equal(await readVersion(store), 2);
  assert.equal(secure.get(SS.rawFor(A)), KEY_A, 'per-account slot written');
  assert.equal(secure.get(SS.legacyRaw), KEY_A, 'legacy anchor must NOT be deleted');
  assert.equal(await readActiveRaw(), A);
  await keyStillRecoverable(NO_KEYS);
});

test('migration is idempotent across launches', async () => {
  secure.set(SS.legacyRaw, KEY_A);
  await migrateV1toV2(env);
  const second = await migrateV1toV2(env);
  assert.equal(second.result, 'noop');
  await keyStillRecoverable(NO_KEYS);
});

test('an empty vault is tagged v2 without inventing an account', async () => {
  const out = await migrateV1toV2(env);
  assert.deepEqual(out, { result: 'noop', version: 2 });
  assert.equal(await readVersion(store), 2);
  assert.equal(localMap.size, 0);
});

test('a malformed anchor is left completely untouched and UNVERSIONED', async () => {
  // Tagging a version over data we could not parse would hide the original
  // state from a later build or a support session.
  secure.set(SS.legacyRaw, 'not-a-key');
  const out = await migrateV1toV2(env);
  assert.equal(out.result, 'noop');
  assert.equal(await readVersion(store), 0, 'must not claim a version');
  assert.equal(secure.get(SS.legacyRaw), 'not-a-key');
});

// --- crash injection, raw path -------------------------------------------

test('a crash at ANY step of the raw migration leaves a working v1', async () => {
  for (let n = 1; n <= 8; n++) {
    secure.clear(); localMap.clear(); writeCount = 0; failWriteAt = n;
    secure.set(SS.legacyRaw, KEY_A);
    try { await migrateV1toV2(env); } catch { /* the injected crash */ }
    failWriteAt = 0;

    // Whatever happened, the key is still there and still openable.
    await keyStillRecoverable(NO_KEYS);
    const v = await readVersion(store);
    assert.ok(v === 0 || v === 2, `version must be 0 or 2, got ${v} (crash at write ${n})`);
    if (v === 0) {
      // Not committed → a retry must complete cleanly.
      const retry = await migrateV1toV2(env);
      assert.equal(retry.result, 'migrated', `retry after crash ${n}`);
    }
    await keyStillRecoverable(NO_KEYS);
  }
});

// --- the PIN'd path (deferred) -------------------------------------------

async function seedPinnedV1(pin = '123456') {
  const pinKey = await deriveKeyFromPin(pin, salt);
  secure.set(SS.legacyEnc, await encryptWithKey(pinKey, KEY_A));
  secure.set(SS.legacyMode, 'encrypted');
  return pinKey;
}

test('a PIN vault defers, stays at v1, and records a marker', async () => {
  await seedPinnedV1();
  const out = await migrateV1toV2(env);
  assert.deepEqual(out, { result: 'deferred' });
  assert.equal(await readVersion(store), 0, 'must NOT claim v2 before the key is moved');
  assert.equal(secure.get(SS.pending), 'encrypted');
});

test('the deferred marker is actually READ and completes on unlock', async () => {
  // Mobile shipped this marker with no reader and stranded every PIN user.
  const pinKey = await seedPinnedV1();
  await migrateV1toV2(env);
  const out = await completeDeferredV2(pinKey, env);
  assert.deepEqual(out, { result: 'migrated', address: A });
  assert.equal(await readVersion(store), 2);
  assert.equal(secure.get(SS.pending), undefined, 'marker cleared');
  assert.ok(secure.get(SS.encFor(A)), 'per-account ciphertext slot written');
  assert.equal(secure.get(SS.rawFor(A)), undefined, 'no plaintext in PIN mode');
  assert.equal(secure.get(SS.legacyEnc) !== undefined, true, 'legacy anchor retained');

  const dek = await loadDek(pinKey, store);
  await keyStillRecoverable({ pinKey, dek: await importDek(dek!) });
});

test('the WRONG PIN cannot complete the migration', async () => {
  await seedPinnedV1('111111');
  await migrateV1toV2(env);
  const wrong = await deriveKeyFromPin('222222', salt);
  const out = await completeDeferredV2(wrong, env);
  assert.equal(out.result, 'noop');
  assert.equal(await readVersion(store), 0, 'a wrong PIN must not commit');
  assert.equal(secure.get(SS.pending), 'encrypted', 'still pending');
});

test('a crash at ANY step of the deferred migration leaves the old PIN working', async () => {
  for (let n = 1; n <= 10; n++) {
    secure.clear(); localMap.clear(); writeCount = 0;
    const pinKey = await seedPinnedV1();
    await migrateV1toV2(env);
    writeCount = 0; failWriteAt = n;
    try { await completeDeferredV2(pinKey, env); } catch { /* injected */ }
    failWriteAt = 0;

    // The backstop: the legacy anchor still opens under the PIN key alone,
    // with no DEK and no per-account slot.
    await keyStillRecoverable({ pinKey, dek: null });
    const v = await readVersion(store);
    assert.ok(v === 0 || v === 2, `version must be 0 or 2, got ${v} (crash at write ${n})`);
    if (v === 0) {
      const retry = await completeDeferredV2(pinKey, env);
      assert.equal(retry.result, 'migrated', `retry after crash ${n}`);
    }
    const dek = await loadDek(pinKey, store);
    await keyStillRecoverable({ pinKey, dek: dek ? await importDek(dek) : null });
  }
});

test('a slot is never written under a DEK that failed to persist', async () => {
  // The one ordering that would brick the account: ciphertext sealed under a
  // key that was never stored.
  const pinKey = await seedPinnedV1();
  await migrateV1toV2(env);
  const before = writeCount;
  failWriteAt = before + 1;          // fail the first DEK write
  try { await completeDeferredV2(pinKey, env); } catch { /* injected */ }
  failWriteAt = 0;
  assert.equal(secure.get(SS.encFor(A)), undefined, 'no slot without a persisted DEK');
  await keyStillRecoverable({ pinKey, dek: null });
});

async function readActiveRaw() {
  return secure.get(SS.active) ?? null;
}
