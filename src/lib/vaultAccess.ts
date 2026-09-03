/**
 * Per-account key access — the read path, and the writes it must invert.
 *
 * Kept separate from `vault.ts` so the rule that matters most here is
 * reviewable on its own: **every write path below has a matching branch in
 * `readKeyFor`.** An encrypt path without a decrypt path does not lock data
 * away, it destroys it — that is exactly what made mobile delete its PIN
 * support rather than ship it.
 *
 * Storage is injected (`StoreLike`) so the partial-failure states — a slot
 * written but the mode flag not yet set, a DEK that vanished, a decrypted key
 * that belongs to a different address — can be exercised in tests instead of
 * reasoned about.
 */

import { encryptWithKey, decryptWithKey } from './aesGcm.ts';
import { SS, isValidAddress } from './vaultAccounts.ts';
import type { StoreLike } from './vaultDek.ts';
import { importDek } from './vaultDek.ts';

/** Result of trying to read one account's key. */
export type KeyStatus =
  /** Key recovered. */
  | { status: 'ok'; hex: string }
  /**
   * The slot exists but is encrypted and no DEK/PIN key is loaded.
   *
   * MUST NOT be collapsed into `absent`. A locked account that reports
   * "absent" looks removed to `vaultListAccounts` and the account picker, and
   * a caller could then overwrite it.
   */
  | { status: 'needs-pin' }
  /** No key material for this address. */
  | { status: 'absent' };

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Keys currently held in memory for the session. */
export interface UnlockedKeys {
  /** The PIN-derived key, when a PIN is set and the vault is unlocked. */
  pinKey: CryptoKey | null;
  /** The DEK, unwrapped at unlock. Account slots are sealed under this. */
  dek: CryptoKey | null;
}

/**
 * Derive the address for a private key.
 *
 * Injected rather than imported so this module stays free of the SDK, and so
 * the address-mismatch check below can be exercised directly.
 */
export type DeriveAddress = (hex: string) => Promise<string>;

/**
 * Read `addr`'s private key, trying every state a write path can leave behind.
 *
 * The order is deliberate — each step is the inverse of a specific write:
 *
 *   1. plaintext slot — no-PIN writes, and a PIN encrypt that crashed before
 *      it destroyed the plaintext;
 *   2. ciphertext slot under the DEK — PIN-mode writes;
 *   3. the legacy raw anchor — a half-finished v1→v2 migration, and a
 *      downgrade to an older build;
 *   4. the legacy encrypted anchor, decrypted DIRECTLY under the PIN key (not
 *      the DEK — it predates it) — the pre-migration PIN'd vault. **This
 *      branch is never removed:** it is the backstop that keeps the original
 *      account recoverable even if the DEK and both indexes are destroyed.
 *
 * A decrypted key whose re-derived address does not match `addr` is REJECTED
 * rather than returned. Returning it would hand one account another's key,
 * and `settings-sync` would then seal one account's data under the other's
 * key — unrecoverable on every device.
 */
export async function readKeyFor(
  addr: string,
  store: StoreLike,
  keys: UnlockedKeys,
  deriveAddress: DeriveAddress,
): Promise<KeyStatus> {
  if (!isValidAddress(addr)) return { status: 'absent' };

  // 1. plaintext per-account slot
  const raw = await store.getItemAsync(SS.rawFor(addr)).catch(() => null);
  if (raw && HEX64.test(raw)) return { status: 'ok', hex: raw };

  // 2. ciphertext per-account slot, sealed under the DEK
  const enc = await store.getItemAsync(SS.encFor(addr)).catch(() => null);
  if (enc) {
    if (!keys.dek) return { status: 'needs-pin' };
    const hex = await tryDecrypt(keys.dek, enc);
    if (hex && (await matches(hex, addr, deriveAddress))) return { status: 'ok', hex };
    // Present but unopenable with the key we hold: still not "absent".
    return { status: 'needs-pin' };
  }

  // 3. legacy raw anchor
  const legacyRaw = await store.getItemAsync(SS.legacyRaw).catch(() => null);
  if (legacyRaw && HEX64.test(legacyRaw) && (await matches(legacyRaw, addr, deriveAddress))) {
    return { status: 'ok', hex: legacyRaw };
  }

  // 4. legacy encrypted anchor — under the PIN key, never the DEK
  const legacyEnc = await store.getItemAsync(SS.legacyEnc).catch(() => null);
  if (legacyEnc) {
    if (!keys.pinKey) return { status: 'needs-pin' };
    const hex = await tryDecrypt(keys.pinKey, legacyEnc);
    if (hex && (await matches(hex, addr, deriveAddress))) return { status: 'ok', hex };
  }

  return { status: 'absent' };
}

/** Whether any key material exists for `addr`, without needing to open it. */
export async function hasSlot(addr: string, store: StoreLike): Promise<boolean> {
  if (!isValidAddress(addr)) return false;
  if (await store.getItemAsync(SS.rawFor(addr)).catch(() => null)) return true;
  return !!(await store.getItemAsync(SS.encFor(addr)).catch(() => null));
}

/**
 * Write `hex` into `addr`'s slot, in whichever mode the vault is in.
 *
 * Verifies by reading back AND re-deriving the address before returning, so a
 * caller can safely destroy a previous copy on success. A store that silently
 * dropped the write (a poisoned file store fails every save) is caught here
 * rather than discovered when the key is next needed.
 */
export async function writeKeyFor(
  addr: string,
  hex: string,
  store: StoreLike,
  keys: UnlockedKeys,
  deriveAddress: DeriveAddress,
): Promise<void> {
  if (!isValidAddress(addr)) throw new Error('invalid address');
  if (!HEX64.test(hex)) throw new Error('invalid private key format');
  if (!(await matches(hex, addr, deriveAddress))) {
    throw new Error('refusing to write a key that does not derive to this address');
  }

  if (keys.dek) {
    const blob = await encryptWithKey(keys.dek, hex);
    await store.setItemAsync(SS.encFor(addr), blob);
    await store.setItemAsync(SS.modeFor(addr), 'encrypted');
    // Plaintext must not survive alongside the ciphertext in PIN mode, but it
    // is removed only AFTER the ciphertext is verified below.
  } else {
    await store.setItemAsync(SS.rawFor(addr), hex);
    await store.setItemAsync(SS.modeFor(addr), 'raw');
  }

  const back = await readKeyFor(addr, store, keys, deriveAddress);
  if (back.status !== 'ok' || back.hex !== hex) {
    throw new Error(`key did not survive a round-trip for ${addr.slice(0, 12)}…`);
  }
  if (keys.dek) {
    await store.deleteItemAsync(SS.rawFor(addr)).catch(() => {});
  }
}

/**
 * Every secure-store key belonging to one account.
 *
 * Returns names rather than deleting, so the caller can pass the whole set to
 * `secure_store_delete_many` — one lock, one guard evaluation, and ONE native
 * confirmation prompt. Deleting them individually would raise up to four
 * dialogs per account, which users learn to click through.
 */
export function keyArtefactsFor(addr: string): string[] {
  return [SS.rawFor(addr), SS.encFor(addr), SS.modeFor(addr), SS.encPrivFor(addr)];
}

async function tryDecrypt(key: CryptoKey, blob: string): Promise<string | null> {
  try {
    const hex = await decryptWithKey(key, blob);
    return HEX64.test(hex) ? hex : null;
  } catch {
    return null;
  }
}

async function matches(hex: string, addr: string, deriveAddress: DeriveAddress): Promise<boolean> {
  try {
    return (await deriveAddress(hex)) === addr;
  } catch {
    return false;
  }
}

/** Re-export so callers need only this module for the key path. */
export { importDek };
