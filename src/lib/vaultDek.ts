/**
 * Data-encryption key (DEK) for PIN-at-rest, multi-account edition.
 *
 * # Why a DEK rather than encrypting each slot under the PIN key
 *
 * With N accounts, encrypting every slot directly under a PIN-derived key
 * makes `changePin` an N-slot re-encryption: it needs staging slots, a staging
 * fallback in the read path, and a resume for a crash in the middle. That is a
 * strictly larger and less reviewable surface than one wrapped key.
 *
 * Instead: a random 32-byte DEK encrypts every account slot, and the DEK
 * itself is encrypted under the PIN-derived key. Then
 *
 *   - `changePin` rewrites ONE blob and touches no account slot at all,
 *   - an account can be added while a PIN is set with no PIN re-prompt and
 *     without a plaintext slot ever being written,
 *   - PBKDF2 runs once per unlock rather than once per account.
 *
 * It reuses `encryptWithKey`/`decryptWithKey` from `appLock.ts` verbatim, so
 * there is no new crypto here — only new key management.
 *
 * # The cost, stated plainly
 *
 * The DEK is a single point of failure for every account: lose it and every
 * ciphertext slot is unreadable. That is why it is written to TWO keys with a
 * read-back verification, why the read path tries both, and why the legacy
 * anchor `ogmara.vault.encrypted_key` — encrypted directly under the PIN key,
 * never under the DEK — is retained forever as the backstop for the
 * pre-migration account.
 */

import { encryptWithKey, decryptWithKey } from './aesGcm.ts';
import { SS } from './vaultAccounts.ts';

/**
 * The subset of the secure store this module needs.
 *
 * Taken as a parameter rather than imported so this module has NO storage
 * dependency: that keeps one implementation of the ciphertext format, and it
 * lets the storage-failure cases be injected in tests — 
a write that silently
 * vanishes on a poisoned store, a destroyed or corrupt copy. Those are exactly
 * the cases that would brick every account at once.
 */
export interface StoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Hex helpers, local so this module has no dependency on appLock's private ones. */
function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(h: string): Uint8Array {
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Mint a fresh random DEK. */
export function mintDek(): Uint8Array {
  const dek = new Uint8Array(32);
  crypto.getRandomValues(dek);
  return dek;
}

/** Import raw DEK bytes as an AES-GCM key usable with `encryptWithKey`. */
export async function importDek(dek: Uint8Array): Promise<CryptoKey> {
  if (dek.length !== 32) throw new Error('DEK must be 32 bytes');
  return crypto.subtle.importKey(
    'raw',
    // `.slice()` for a clean ArrayBuffer — webkit2gtk's SubtleCrypto rejects
    // offset views, the same reason appLock does this.
    dek.buffer.slice(dek.byteOffset, dek.byteOffset + dek.byteLength) as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wrap the DEK under the PIN-derived key, as `ivHex:ctHex`. */
export async function wrapDek(pinKey: CryptoKey, dek: Uint8Array): Promise<string> {
  return encryptWithKey(pinKey, bytesToHex(dek));
}

/** Unwrap a DEK blob. Throws on a wrong PIN or a corrupt blob. */
export async function unwrapDek(pinKey: CryptoKey, blob: string): Promise<Uint8Array> {
  const hex = await decryptWithKey(pinKey, blob);
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) throw new Error('unwrapped DEK has wrong length');
  return bytes;
}

/**
 * Persist the DEK under the PIN key, to BOTH copies, verifying each.
 *
 * Mirror first, primary second: if the process dies between them the mirror
 * already holds the new value, and `loadDek` tries the primary then the mirror,
 * so either ordering of survivors resolves. Verification is a real unwrap, not
 * a read-back string compare — a value that round-trips as text but does not
 * decrypt would brick every slot.
 */
export async function writeDekVerified(
  pinKey: CryptoKey,
  dek: Uint8Array,
  store: StoreLike,
): Promise<void> {
  const blob = await wrapDek(pinKey, dek);
  const check = await unwrapDek(pinKey, blob);
  if (bytesToHex(check) !== bytesToHex(dek)) {
    throw new Error('DEK wrap failed verification');
  }
  await store.setItemAsync(SS.dekMirror, blob);
  await store.setItemAsync(SS.dek, blob);
  // Read both back and unwrap, so a store that silently dropped the write
  // (a poisoned file store fails every save) is caught HERE, before anything
  // is encrypted under a DEK that was never persisted.
  for (const key of [SS.dek, SS.dekMirror]) {
    const stored = await store.getItemAsync(key).catch(() => null);
    if (!stored) throw new Error(`DEK write did not persist (${key})`);
    const back = await unwrapDek(pinKey, stored);
    if (bytesToHex(back) !== bytesToHex(dek)) {
      throw new Error(`DEK did not survive a round-trip (${key})`);
    }
  }
}

/**
 * Load the DEK, trying the primary then the mirror.
 *
 * Returns `null` when neither copy exists (a vault with no PIN), and THROWS
 * when copies exist but none unwraps — those are different situations and
 * conflating them would report "no PIN set" for a wrong-PIN unlock.
 */
export async function loadDek(
  pinKey: CryptoKey,
  store: StoreLike,
): Promise<Uint8Array | null> {
  const primary = await store.getItemAsync(SS.dek).catch(() => null);
  const mirror = await store.getItemAsync(SS.dekMirror).catch(() => null);
  if (!primary && !mirror) return null;
  let lastErr: unknown = null;
  for (const blob of [primary, mirror]) {
    if (!blob) continue;
    try {
      return await unwrapDek(pinKey, blob);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `DEK present but could not be unwrapped: ${lastErr instanceof Error ? lastErr.message : 'unknown'}`,
  );
}

/** Whether a DEK exists at all (i.e. the vault is in PIN mode). */
export async function hasDek(store: StoreLike): Promise<boolean> {
  const primary = await store.getItemAsync(SS.dek).catch(() => null);
  if (primary) return true;
  return !!(await store.getItemAsync(SS.dekMirror).catch(() => null));
}

/** Remove both DEK copies. Only after every slot is back in raw mode. */
export async function deleteDek(store: StoreLike): Promise<void> {
  await store.deleteItemAsync(SS.dek).catch(() => {});
  await store.deleteItemAsync(SS.dekMirror).catch(() => {});
}
