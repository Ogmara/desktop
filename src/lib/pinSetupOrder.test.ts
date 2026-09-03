/**
 * PIN setup ORDERING. Run: node --test src/lib/pinSetupOrder.test.ts
 *
 * `vaultPinOps.test.ts` cannot catch the bug that motivated it. Its crash
 * tests derive the PIN key from a module-local salt constant and hand that same
 * object to the recovery check — so "the PIN key can still be re-derived after
 * a crash" is supplied by the harness rather than proven from the store. That
 * is the same failure `vaultIndex.test.ts` had: a test that upholds the
 * invariant on the caller's behalf proves nothing. Swapping the two lines in
 * `PinSetup.tsx` back to the broken order still passed all 95 tests.
 *
 * These tests model the REAL sequence and re-derive the key from whatever the
 * store actually holds, so the ordering is what is under test.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SS } from './vaultAccounts.ts';
import { encryptAllWithPin, type PinOpsDeps } from './vaultPinOps.ts';
import { readKeyFor, type UnlockedKeys } from './vaultAccess.ts';
import { loadDek, importDek, type StoreLike } from './vaultDek.ts';
import { deriveKeyFromPin } from './aesGcm.ts';

const SALT_KEY = 'ogmara.app_lock.salt';
const PIN_VERIFY_KEY = 'ogmara.app_lock.pin_verify';
const LOCK_ENABLED_KEY = 'ogmara.app_lock.enabled';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);
const KEYS: Record<string, string> = { [A]: 'a'.repeat(64), [B]: 'b'.repeat(64) };
const byKey = Object.fromEntries(Object.entries(KEYS).map(([a, k]) => [k, a]));
const deriveAddress = async (hex: string) => byKey[hex] ?? 'klv1' + 'z'.repeat(58);

const map = new Map<string, string>();
let failWriteAt = 0;
let writeCount = 0;
const store: StoreLike = {
  getItemAsync: async (k) => map.get(k) ?? null,
  setItemAsync: async (k, v) => {
    writeCount++;
    if (failWriteAt && writeCount === failWriteAt) throw new Error('injected crash');
    map.set(k, v);
  },
  deleteItemAsync: async (k) => { map.delete(k); },
};

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const deps = (keys: UnlockedKeys, accounts: string[]): PinOpsDeps => ({
  store, keys, deriveAddress,
  listAccounts: async () => accounts,
  listKeystore: async () => accounts,
});

/**
 * The real `PinSetup.tsx` sequence, with the salt persisted BEFORE encryption
 * and the lock armed after.
 */
async function runSetupInOrder(pin: string, accounts: string[]) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await deriveKeyFromPin(pin, salt);
  const { encryptWithKey } = await import('./aesGcm.ts');
  const verify = await encryptWithKey(key, 'ogmara-pin-ok');

  await store.setItemAsync(SALT_KEY, bytesToHex(salt));       // step 2
  await store.setItemAsync(PIN_VERIFY_KEY, verify);
  await encryptAllWithPin(key, deps({ pinKey: null, dek: null }, accounts)); // step 3
  await store.setItemAsync(LOCK_ENABLED_KEY, 'true');          // step 4 — commit
}

/** The 1.68.0 order: encrypt first, persist the salt afterwards. */
async function runSetupBrokenOrder(pin: string, accounts: string[]) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await deriveKeyFromPin(pin, salt);
  const { encryptWithKey } = await import('./aesGcm.ts');
  const verify = await encryptWithKey(key, 'ogmara-pin-ok');

  await encryptAllWithPin(key, deps({ pinKey: null, dek: null }, accounts));
  await store.setItemAsync(SALT_KEY, bytesToHex(salt));
  await store.setItemAsync(PIN_VERIFY_KEY, verify);
  await store.setItemAsync(LOCK_ENABLED_KEY, 'true');
}

/**
 * Recover using ONLY what the store holds — the salt is read back, not
 * remembered. This is what makes the ordering observable.
 */
async function recoverableFromStoreAlone(pin: string, accounts: string[]): Promise<boolean> {
  const saltHex = map.get(SALT_KEY);
  if (!saltHex) {
    // No salt stored. That is FINE as long as nothing was encrypted — the
    // accounts are still plaintext and open with no key at all. It is only a
    // loss if plaintext was destroyed in favour of ciphertext whose key can
    // never be re-derived, which is exactly the bug under test.
    const keys: UnlockedKeys = { pinKey: null, dek: null };
    for (const a of accounts) {
      const got = await readKeyFor(a, store, keys, deriveAddress);
      if (got.status !== 'ok' || got.hex !== KEYS[a]) return false;
    }
    return true;
  }
  const key = await deriveKeyFromPin(pin, hexToBytes(saltHex));
  const dekBytes = await loadDek(key, store).catch(() => null);
  const keys: UnlockedKeys = { pinKey: key, dek: dekBytes ? await importDek(dekBytes) : null };
  for (const a of accounts) {
    const got = await readKeyFor(a, store, keys, deriveAddress);
    if (got.status !== 'ok' || got.hex !== KEYS[a]) return false;
  }
  return true;
}

beforeEach(() => { map.clear(); failWriteAt = 0; writeCount = 0; });

test('the correct order survives a crash at every step', async () => {
  const accounts = [A, B];
  for (let n = 1; n <= 14; n++) {
    map.clear(); writeCount = 0;
    for (const a of accounts) map.set(SS.rawFor(a), KEYS[a]);
    failWriteAt = n;
    try { await runSetupInOrder('123456', accounts); } catch { /* injected */ }
    failWriteAt = 0;
    assert.ok(
      await recoverableFromStoreAlone('123456', accounts),
      `crash at write ${n}: accounts must be recoverable from the store alone`,
    );
  }
});

test('the BROKEN order loses accounts — proving this test can see the bug', async () => {
  // A guard on the test itself. If this ever stops failing, the test has
  // stopped observing the ordering and is worthless, exactly like the one it
  // was written to replace.
  const accounts = [A, B];
  let sawUnrecoverable = false;
  for (let n = 1; n <= 14 && !sawUnrecoverable; n++) {
    map.clear(); writeCount = 0;
    for (const a of accounts) map.set(SS.rawFor(a), KEYS[a]);
    failWriteAt = n;
    try { await runSetupBrokenOrder('123456', accounts); } catch { /* injected */ }
    failWriteAt = 0;
    // Plaintext destroyed but the salt never stored → unrecoverable.
    const sealed = accounts.some((a) => map.has(SS.encFor(a)));
    if (sealed && !map.has(SALT_KEY)) sawUnrecoverable = true;
  }
  assert.ok(
    sawUnrecoverable,
    'the broken order must be observably unrecoverable, or this test proves nothing',
  );
});

test('the lock is armed only after every account is encrypted', async () => {
  const accounts = [A, B];
  for (const a of accounts) map.set(SS.rawFor(a), KEYS[a]);
  // Fail inside the encryption loop.
  failWriteAt = 6;
  try { await runSetupInOrder('123456', accounts); } catch { /* injected */ }
  failWriteAt = 0;
  assert.notEqual(
    map.get(LOCK_ENABLED_KEY), 'true',
    'the app must not demand a PIN for a setup that did not finish',
  );
  assert.ok(await recoverableFromStoreAlone('123456', accounts));
});
