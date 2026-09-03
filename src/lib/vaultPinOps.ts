/**
 * PIN setup and removal, as testable sequences.
 *
 * These two functions delete plaintext key material, so their ORDERING is the
 * whole safety argument — and until now they lived in `vault.ts`, which has no
 * tests, while every crash-injection test targeted the migration. The audit
 * found a key-loss bug in exactly this gap: the PIN salt was persisted only
 * after the encryption loop, so a failure part-way left accounts sealed under
 * a key whose salt was never stored, unrecoverable with the correct PIN.
 *
 * Storage and the account list are injected so an interruption at any step can
 * be exercised rather than argued about.
 */

import { SS } from './vaultAccounts.ts';
import type { StoreLike } from './vaultDek.ts';
import { mintDek, importDek, writeDekVerified, loadDek, deleteDek } from './vaultDek.ts';
import { readKeyFor, writeKeyFor, type DeriveAddress, type UnlockedKeys } from './vaultAccess.ts';
import { encryptWithKey, decryptWithKey } from './aesGcm.ts';

const HEX64 = /^[0-9a-fA-F]{64}$/;

export interface PinOpsDeps {
  store: StoreLike;
  /** Mutated in place — the caller's session keys. */
  keys: UnlockedKeys;
  deriveAddress: DeriveAddress;
  /** Addresses to operate on: the caller's account index union. */
  listAccounts: () => Promise<string[]>;
  /** Addresses proven to have a slot, for the completeness check on removal. */
  listKeystore: () => Promise<string[]>;
}

/**
 * Encrypt every account's slot under `pinKey`.
 *
 * A. Read every account FIRST. If any cannot be read, abort before writing
 *    anything — encrypting a subset leaves accounts the PIN does not protect
 *    while the UI claims it does.
 * B. Establish the DEK, verified in both copies, before anything depends on it.
 * C. Seal each slot, verify by decrypting, and only then destroy plaintext.
 *
 * The caller MUST have persisted the PIN salt before calling, and MUST arm the
 * lock only after this returns.
 */
export async function encryptAllWithPin(pinKey: CryptoKey, d: PinOpsDeps): Promise<void> {
  const { store, keys, deriveAddress } = d;

  // The PIN key first, so the read below can open the legacy anchor and — via
  // an existing DEK — anything a previous partial attempt already sealed.
  keys.pinKey = pinKey;
  try {
    const existing = await loadDek(pinKey, store);
    if (existing) keys.dek = await importDek(existing);
  } catch {
    keys.dek = null; // stale or foreign; step A decides whether it matters
  }

  // A
  const plain = new Map<string, string>();
  for (const addr of await d.listAccounts()) {
    const got = await readKeyFor(addr, store, keys, deriveAddress);
    if (got.status !== 'ok') {
      throw new Error(
        `Cannot read the key for ${addr.slice(0, 12)}… — refusing to encrypt only some accounts`,
      );
    }
    plain.set(addr, got.hex);
  }
  const legacyRaw = await store.getItemAsync(SS.legacyRaw).catch(() => null);

  // The keystore is authoritative about which accounts EXIST. `listAccounts`
  // comes from the index union, which degrades to empty when the native
  // listing throws and localStorage was cleared — so an account could be
  // absent from every source, be skipped here, and then sit in plaintext while
  // the UI reports the vault as PIN-protected. `decryptAllToRaw` already
  // defends this case; the mirror image needs it too.
  // Same reasoning as the removal guard: an empty listing would let this
  // "did we miss an account?" check pass without checking anything.
  for (const a of await d.listKeystore()) {
    if (plain.has(a)) continue;
    if (await store.getItemAsync(SS.rawFor(a)).catch(() => null)) {
      throw new Error(
        `Account ${a.slice(0, 12)}… holds an unencrypted key but is missing from the account list — refusing to encrypt only some accounts`,
      );
    }
  }

  await store.setItemAsync(SS.pinMigration, JSON.stringify({ op: 'encrypt', at: Date.now() }));

  // B — reaching here means every account read successfully, so nothing
  // depends on a DEK we could not unwrap: a stale one is safe to replace.
  if (!keys.dek) {
    await deleteDek(store).catch(() => {});
    await writeDekVerified(pinKey, mintDek(), store);
    const minted = await loadDek(pinKey, store);
    if (!minted) throw new Error('DEK missing immediately after it was written');
    keys.dek = await importDek(minted);
  }

  // C
  for (const [addr, hex] of plain) {
    await writeKeyFor(addr, hex, store, keys, deriveAddress);
  }

  // Vault-level mode, UNCONDITIONALLY — not only when a legacy anchor exists.
  // `vaultIsEncrypted()` reads this and the lock screen is gated on it, so a
  // vault with no anchor would otherwise boot straight past the lock screen.
  // BEFORE the anchor conversion, not after.
  //
  // Moving it later was a mistake: the window it was meant to close is not
  // real (the legacy anchor is plaintext on disk whether or not this flag says
  // `encrypted`, so `readKeyFor` branch 3 opens it either way), while the
  // window it CREATED is — a crash between sealing the slots and writing this
  // leaves both `mode` and `lock_enabled` unset over encrypted key material,
  // so the app boots signed out with no lock screen and no prompt.
  //
  // Set early, the failure mode is a lock screen for a vault that is not fully
  // encrypted yet: passable with the same PIN, and self-healing on retry.
  await store.setItemAsync(SS.legacyMode, 'encrypted');

  if (legacyRaw && HEX64.test(legacyRaw)) {
    const blob = await encryptWithKey(pinKey, legacyRaw);
    await store.setItemAsync(SS.legacyEnc, blob);
    if ((await decryptWithKey(pinKey, blob)) !== legacyRaw) {
      throw new Error('legacy anchor failed encryption verification');
    }
    await store.deleteItemAsync(SS.legacyRaw).catch(() => {});
  }

  await store.deleteItemAsync(SS.pinMigration).catch(() => {});
}

/**
 * Decrypt every account back to plaintext, for PIN removal.
 *
 * Mirror image with the OPPOSITE commit point: everything is written in the
 * clear and verified BEFORE the caller removes the PIN record, so a crash
 * before that leaves the PIN still required and all ciphertext intact.
 */
export async function decryptAllToRaw(pinKey: CryptoKey, d: PinOpsDeps): Promise<void> {
  const { store, keys, deriveAddress } = d;

  keys.pinKey = pinKey;
  if (!keys.dek) {
    const dekBytes = await loadDek(pinKey, store).catch(() => null);
    if (dekBytes) keys.dek = await importDek(dekBytes);
  }

  const plain = new Map<string, string>();
  for (const addr of await d.listAccounts()) {
    const got = await readKeyFor(addr, store, keys, deriveAddress);
    if (got.status !== 'ok') {
      throw new Error(
        `Cannot read the key for ${addr.slice(0, 12)}… — refusing to remove the PIN with an account left encrypted`,
      );
    }
    plain.set(addr, got.hex);
  }

  await store.setItemAsync(SS.pinMigration, JSON.stringify({ op: 'decrypt', at: Date.now() }));

  const dekHeld = keys.dek;
  keys.dek = null; // so `writeKeyFor` takes the raw branch
  const pinHeld = keys.pinKey;
  keys.pinKey = null; // …and its "PIN in force" guard does not fire
  try {
    for (const [addr, hex] of plain) {
      await writeKeyFor(addr, hex, store, keys, deriveAddress);
      await store.deleteItemAsync(SS.encFor(addr)).catch(() => {});
    }
    const legacyEnc = await store.getItemAsync(SS.legacyEnc).catch(() => null);
    if (legacyEnc) {
      const hex = await decryptWithKey(pinKey, legacyEnc);
      await store.setItemAsync(SS.legacyRaw, hex);
      await store.deleteItemAsync(SS.legacyEnc).catch(() => {});
    }
    // Prove NO ciphertext survives before destroying the key that opens it —
    // and BEFORE flipping the vault-level mode flag. Writing `raw` first meant
    // the refusal below left `lock_enabled` true over a vault reporting itself
    // unencrypted, so the next launch skipped the lock screen: the safe path
    // produced the unsafe state.
    // The loop only covers accounts the index returned; on a degraded index an
    // account can be missing from every source, and would be sealed forever
    // under a DEK whose salt the caller is about to delete.
    // NOT `.catch(() => [])`. An empty list here makes the loop vacuous and
    // the guard passes, and `deleteDek` runs immediately after — so a failed
    // listing would authorise the exact destruction this check exists to
    // refuse. Let it throw; the caller's rollback restores the session keys.
    const stillSealed: string[] = [];
    for (const a of await d.listKeystore()) {
      if (await store.getItemAsync(SS.encFor(a)).catch(() => null)) stillSealed.push(a);
    }
    if (stillSealed.length > 0) {
      throw new Error(
        `Refusing to remove the PIN: ${stillSealed.length} account(s) are still encrypted and would become unrecoverable.`,
      );
    }
    await store.setItemAsync(SS.legacyMode, 'raw');
    await deleteDek(store);
  } catch (e) {
    keys.dek = dekHeld; // restore so the session keeps working
    keys.pinKey = pinHeld;
    throw e;
  }
  await store.deleteItemAsync(SS.pinMigration).catch(() => {});
}
