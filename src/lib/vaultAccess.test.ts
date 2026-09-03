/**
 * Read/write path tests. Run: node --test src/lib/vaultAccess.test.ts
 *
 * The rule under test is that `readKeyFor` inverts every write path, in every
 * partially-completed state a crash can leave behind. A gap here is not a bug
 * that shows a wrong screen — it is a wallet the user cannot open.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SS } from './vaultAccounts.ts';
import { readKeyFor, writeKeyFor, hasSlot, type UnlockedKeys } from './vaultAccess.ts';
import { mintDek, importDek, type StoreLike } from './vaultDek.ts';
import { deriveKeyFromPin, encryptWithKey } from './aesGcm.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

/** Stand-in for address derivation — a fixed, invertible mapping. */
const deriveAddress = async (hex: string) => {
  if (hex === KEY_A) return A;
  if (hex === KEY_B) return B;
  return 'klv1' + 'z'.repeat(58);
};

const map = new Map<string, string>();
let swallowWrites = 0;
const store: StoreLike = {
  getItemAsync: async (k) => map.get(k) ?? null,
  setItemAsync: async (k, v) => { if (swallowWrites > 0) { swallowWrites--; return; } map.set(k, v); },
  deleteItemAsync: async (k) => { map.delete(k); },
};

const NO_KEYS: UnlockedKeys = { pinKey: null, dek: null };
const salt = new Uint8Array(16).fill(3);

beforeEach(() => { map.clear(); swallowWrites = 0; });

async function withDek(): Promise<UnlockedKeys> {
  return { pinKey: await deriveKeyFromPin('123456', salt), dek: await importDek(mintDek()) };
}

// --- round trips ----------------------------------------------------------

test('raw mode: write then read returns the same key', async () => {
  await writeKeyFor(A, KEY_A, store, NO_KEYS, deriveAddress);
  assert.deepEqual(await readKeyFor(A, store, NO_KEYS, deriveAddress), { status: 'ok', hex: KEY_A });
});

test('PIN mode: write then read returns the same key, and no plaintext remains', async () => {
  const keys = await withDek();
  await writeKeyFor(A, KEY_A, store, keys, deriveAddress);
  assert.deepEqual(await readKeyFor(A, store, keys, deriveAddress), { status: 'ok', hex: KEY_A });
  assert.equal(map.get(SS.rawFor(A)), undefined, 'plaintext must not survive in PIN mode');
  assert.ok(map.get(SS.encFor(A)), 'ciphertext slot must exist');
  // And the key must not be sitting in the store in the clear anywhere.
  for (const v of map.values()) assert.notEqual(v, KEY_A);
});

test('accounts are independent — one key never opens another slot', async () => {
  const keys = await withDek();
  await writeKeyFor(A, KEY_A, store, keys, deriveAddress);
  await writeKeyFor(B, KEY_B, store, keys, deriveAddress);
  const a = await readKeyFor(A, store, keys, deriveAddress);
  const b = await readKeyFor(B, store, keys, deriveAddress);
  assert.equal(a.status === 'ok' && a.hex, KEY_A);
  assert.equal(b.status === 'ok' && b.hex, KEY_B);
});

// --- the locked/absent distinction ---------------------------------------

test('an encrypted slot with no DEK reports needs-pin, NEVER absent', async () => {
  // Reporting absent would make a locked account look removed to the account
  // list, and a caller could overwrite it.
  const keys = await withDek();
  await writeKeyFor(A, KEY_A, store, keys, deriveAddress);
  assert.deepEqual(await readKeyFor(A, store, NO_KEYS, deriveAddress), { status: 'needs-pin' });
});

test('an encrypted slot that will not open under the DEK we hold is needs-pin', async () => {
  const keys = await withDek();
  await writeKeyFor(A, KEY_A, store, keys, deriveAddress);
  const otherDek = { pinKey: keys.pinKey, dek: await importDek(mintDek()) };
  assert.deepEqual(await readKeyFor(A, store, otherDek, deriveAddress), { status: 'needs-pin' });
});

test('an address with nothing stored is absent', async () => {
  assert.deepEqual(await readKeyFor(A, store, NO_KEYS, deriveAddress), { status: 'absent' });
  assert.equal(await hasSlot(A, store), false);
});

// --- crash states ---------------------------------------------------------

test('a PIN encrypt that crashed before deleting plaintext still opens', async () => {
  // Step 1 of the read path exists exactly for this.
  const keys = await withDek();
  map.set(SS.rawFor(A), KEY_A);
  map.set(SS.encFor(A), await encryptWithKey(keys.dek!, KEY_A));
  map.set(SS.modeFor(A), 'encrypted');
  assert.deepEqual(await readKeyFor(A, store, keys, deriveAddress), { status: 'ok', hex: KEY_A });
});

test('a half-finished migration still opens through the legacy raw anchor', async () => {
  map.set(SS.legacyRaw, KEY_A);
  assert.deepEqual(await readKeyFor(A, store, NO_KEYS, deriveAddress), { status: 'ok', hex: KEY_A });
});

test('a pre-migration PIN vault opens through the legacy anchor under the PIN key', async () => {
  // The backstop. Even with no DEK, no per-account slot and no index, the
  // original account must still be recoverable.
  const pinKey = await deriveKeyFromPin('123456', salt);
  map.set(SS.legacyEnc, await encryptWithKey(pinKey, KEY_A));
  assert.deepEqual(
    await readKeyFor(A, store, { pinKey, dek: null }, deriveAddress),
    { status: 'ok', hex: KEY_A },
  );
});

test('the legacy encrypted anchor without a PIN key is needs-pin, not absent', async () => {
  const pinKey = await deriveKeyFromPin('123456', salt);
  map.set(SS.legacyEnc, await encryptWithKey(pinKey, KEY_A));
  assert.deepEqual(await readKeyFor(A, store, NO_KEYS, deriveAddress), { status: 'needs-pin' });
});

// --- the address-mismatch guard ------------------------------------------

test('a key that decrypts but derives to a DIFFERENT address is rejected', async () => {
  // Handing one account another's key would have settings-sync seal one
  // account's data under the other's key — unrecoverable on every device.
  const keys = await withDek();
  map.set(SS.encFor(A), await encryptWithKey(keys.dek!, KEY_B));
  const got = await readKeyFor(A, store, keys, deriveAddress);
  assert.notEqual(got.status, 'ok');
});

test('the legacy anchor is only adopted when it derives to the asked-for address', async () => {
  map.set(SS.legacyRaw, KEY_B);
  assert.deepEqual(await readKeyFor(A, store, NO_KEYS, deriveAddress), { status: 'absent' });
});

test('writeKeyFor refuses a key that does not derive to the target address', async () => {
  await assert.rejects(
    () => writeKeyFor(A, KEY_B, store, NO_KEYS, deriveAddress),
    /does not derive/,
  );
  assert.equal(map.get(SS.rawFor(A)), undefined, 'nothing may be written on rejection');
});

test('writeKeyFor rejects a malformed key outright', async () => {
  await assert.rejects(() => writeKeyFor(A, 'nothex', store, NO_KEYS, deriveAddress), /invalid private key/);
});

// --- storage failure ------------------------------------------------------

test('a silently-dropped write is caught, not reported as success', async () => {
  // A poisoned store fails every save with no error visible here. Returning
  // success would let the caller destroy the only remaining copy.
  swallowWrites = 5;
  await assert.rejects(
    () => writeKeyFor(A, KEY_A, store, NO_KEYS, deriveAddress),
    /did not survive a round-trip/,
  );
});
