/**
 * PIN setup/removal crash tests. Run: node --test src/lib/vaultPinOps.test.ts
 *
 * These paths DELETE plaintext key material, so the property asserted after
 * every injected crash is the one that matters: **every account is still
 * recoverable with the correct PIN.**
 *
 * This file exists because the audit found a key-loss bug here that no test
 * covered — the PIN salt was persisted only after the encryption loop, so a
 * failure part-way left accounts sealed under a key whose salt was never
 * stored. Every crash-injection test at the time targeted the migration.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SS } from './vaultAccounts.ts';
import { encryptAllWithPin, decryptAllToRaw, type PinOpsDeps } from './vaultPinOps.ts';
import { readKeyFor, type UnlockedKeys } from './vaultAccess.ts';
import { loadDek, importDek, type StoreLike } from './vaultDek.ts';
import { deriveKeyFromPin } from './aesGcm.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);
const C = 'klv1' + 'c'.repeat(58);
const KEYS: Record<string, string> = { [A]: 'a'.repeat(64), [B]: 'b'.repeat(64), [C]: 'c'.repeat(64) };
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

const salt = new Uint8Array(16).fill(9);
const pinKeyFor = (pin = '123456') => deriveKeyFromPin(pin, salt);

function deps(keys: UnlockedKeys, accounts: string[]): PinOpsDeps {
  return {
    store, keys, deriveAddress,
    listAccounts: async () => accounts,
    listKeystore: async () => accounts.filter((a) => map.has(SS.rawFor(a)) || map.has(SS.encFor(a))),
  };
}

function seedRaw(accounts: string[]) {
  for (const a of accounts) map.set(SS.rawFor(a), KEYS[a]);
}

/** The invariant: every account opens with the correct PIN. */
async function allRecoverable(pinKey: CryptoKey, accounts: string[]) {
  const dekBytes = await loadDek(pinKey, store).catch(() => null);
  const k: UnlockedKeys = { pinKey, dek: dekBytes ? await importDek(dekBytes) : null };
  for (const a of accounts) {
    const got = await readKeyFor(a, store, k, deriveAddress);
    assert.equal(got.status, 'ok', `account ${a.slice(0, 8)} must still be recoverable`);
    assert.equal(got.status === 'ok' && got.hex, KEYS[a]);
  }
}

beforeEach(() => { map.clear(); failWriteAt = 0; writeCount = 0; });

test('PIN setup encrypts every account and leaves no plaintext', async () => {
  const accounts = [A, B, C];
  seedRaw(accounts);
  const pinKey = await pinKeyFor();
  const keys: UnlockedKeys = { pinKey: null, dek: null };
  await encryptAllWithPin(pinKey, deps(keys, accounts));

  for (const a of accounts) {
    assert.ok(map.get(SS.encFor(a)), `${a.slice(0, 8)} sealed`);
    assert.equal(map.get(SS.rawFor(a)), undefined, `${a.slice(0, 8)} plaintext gone`);
  }
  for (const v of map.values()) assert.ok(!Object.values(KEYS).includes(v), 'no key in the clear');
  await allRecoverable(pinKey, accounts);
});

test('the vault mode flag is set even with NO legacy anchor', async () => {
  // It used to be written only inside `if (legacyRaw)`, so a vault whose
  // accounts all came from "Add account" finished setup with mode unset —
  // and `App.tsx` gates the lock screen on it, so the next launch skipped the
  // lock screen entirely.
  seedRaw([A]);
  await encryptAllWithPin(await pinKeyFor(), deps({ pinKey: null, dek: null }, [A]));
  assert.equal(map.get(SS.legacyMode), 'encrypted');
});

test('a crash at ANY step of PIN setup leaves every account recoverable', async () => {
  const accounts = [A, B, C];
  for (let n = 1; n <= 16; n++) {
    map.clear(); writeCount = 0;
    seedRaw(accounts);
    const pinKey = await pinKeyFor();
    failWriteAt = n;
    try {
      await encryptAllWithPin(pinKey, deps({ pinKey: null, dek: null }, accounts));
    } catch { /* injected */ }
    failWriteAt = 0;

    // The property that the audit found violated.
    await allRecoverable(pinKey, accounts);

    // And a retry with the SAME PIN must complete.
    await encryptAllWithPin(pinKey, deps({ pinKey: null, dek: null }, accounts));
    await allRecoverable(pinKey, accounts);
  }
});

test('a stale DEK from an abandoned attempt does not latch setup off forever', async () => {
  // `hasDek()` alone used to skip minting, and the following `loadDek` threw,
  // so PIN setup failed identically forever.
  seedRaw([A]);
  const oldPin = await pinKeyFor('111111');
  await encryptAllWithPin(oldPin, deps({ pinKey: null, dek: null }, [A]));

  // Simulate a removal whose deleteDek failed: slots back to raw, DEK left.
  map.delete(SS.encFor(A));
  map.set(SS.rawFor(A), KEYS[A]);

  const newPin = await pinKeyFor('222222');
  await encryptAllWithPin(newPin, deps({ pinKey: null, dek: null }, [A]));
  await allRecoverable(newPin, [A]);
});

test('setup refuses when any account cannot be read, before writing anything', async () => {
  // Encrypting a subset leaves accounts the PIN does not protect while the UI
  // reports the vault as protected.
  seedRaw([A, B]);
  const accounts = [A, B, C]; // C has no slot at all
  const before = new Map(map);
  await assert.rejects(
    () => encryptAllWithPin(await_pin(), deps({ pinKey: null, dek: null }, accounts)),
    /refusing to encrypt only some accounts/,
  );
  assert.deepEqual([...map.keys()].sort(), [...before.keys()].sort(), 'nothing written');
});
async function await_pin() { return pinKeyFor(); }

test('PIN removal restores plaintext for every account', async () => {
  const accounts = [A, B];
  seedRaw(accounts);
  const pinKey = await pinKeyFor();
  const keys: UnlockedKeys = { pinKey: null, dek: null };
  await encryptAllWithPin(pinKey, deps(keys, accounts));
  await decryptAllToRaw(pinKey, deps(keys, accounts));

  for (const a of accounts) {
    assert.equal(map.get(SS.rawFor(a)), KEYS[a]);
    assert.equal(map.get(SS.encFor(a)), undefined);
  }
  assert.equal(map.get(SS.dek), undefined, 'DEK destroyed only after every slot is raw');
  assert.equal(map.get(SS.legacyMode), 'raw');
});

test('removal refuses to destroy the DEK while any slot is still sealed', async () => {
  // An account missing from a degraded index would otherwise be skipped
  // silently and sealed forever under a key about to be deleted.
  const accounts = [A, B];
  seedRaw(accounts);
  const pinKey = await pinKeyFor();
  const keys: UnlockedKeys = { pinKey: null, dek: null };
  await encryptAllWithPin(pinKey, deps(keys, accounts));

  // The index only knows about A; B is invisible to it but still on disk.
  const blind: PinOpsDeps = {
    ...deps(keys, [A]),
    listKeystore: async () => accounts,
  };
  await assert.rejects(() => decryptAllToRaw(pinKey, blind), /still encrypted/);
  assert.ok(map.get(SS.dek) || map.get(SS.dekMirror), 'the DEK must survive the refusal');
  await allRecoverable(pinKey, accounts);
});

test('a crash at ANY step of PIN removal leaves every account recoverable', async () => {
  const accounts = [A, B];
  for (let n = 1; n <= 12; n++) {
    map.clear(); writeCount = 0;
    seedRaw(accounts);
    const pinKey = await pinKeyFor();
    const keys: UnlockedKeys = { pinKey: null, dek: null };
    await encryptAllWithPin(pinKey, deps(keys, accounts));

    writeCount = 0; failWriteAt = n;
    try { await decryptAllToRaw(pinKey, deps(keys, accounts)); } catch { /* injected */ }
    failWriteAt = 0;

    await allRecoverable(pinKey, accounts);
  }
});
