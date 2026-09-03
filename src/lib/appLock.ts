/**
 * App Lock — PIN code authentication for desktop.
 *
 * PIN-derived key (PBKDF2-SHA256, 600k iterations) encrypts the private
 * key via AES-256-GCM before storing in OS credential store.
 *
 * Desktop version: no biometric support (platform-dependent and unreliable
 * on Linux). Auto-lock triggers on configurable idle timeout.
 * Per spec 05-clients.md sections 5.6.1 and 5.6.3.
 */

import * as SecureStore from './secureStore';
// Re-exported rather than reimplemented: `vaultDek` needs these primitives
// without this module's storage dependency, and two copies of the ciphertext
// format that drifted would make stored keys unreadable.
import {
  deriveKeyFromPin,
  encryptWithKey,
  decryptWithKey,
  bytesToHex,
  hexToBytes,
} from './aesGcm';
export { deriveKeyFromPin, encryptWithKey, decryptWithKey };

const SALT_KEY = 'ogmara.app_lock.salt';
const PIN_VERIFY_KEY = 'ogmara.app_lock.pin_verify';
const LOCK_ENABLED_KEY = 'ogmara.app_lock.enabled';
const LOCK_TIMEOUT_KEY = 'ogmara.app_lock.timeout_seconds';
const FAILED_ATTEMPTS_KEY = 'ogmara.app_lock.failed_attempts';
const COOLDOWN_UNTIL_KEY = 'ogmara.app_lock.cooldown_until';


// --- Crypto helpers using SubtleCrypto ---

/** Generate a random salt (16 bytes). */
function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}





// --- PIN Management ---

/** Check if app lock (PIN) is enabled. */
export async function isLockEnabled(): Promise<boolean> {
  const val = await SecureStore.getItemAsync(LOCK_ENABLED_KEY).catch(() => null);
  return val === 'true';
}

/** Check if a PIN has been set up. */
export async function hasPinSetup(): Promise<boolean> {
  const verify = await SecureStore.getItemAsync(PIN_VERIFY_KEY).catch(() => null);
  return !!verify;
}

/**
 * Set up a new PIN. Stores a verification token and the salt.
 * Returns the derived CryptoKey for encrypting the private key.
 */
export async function setupPin(pin: string): Promise<CryptoKey> {
  const prepared = await derivePinForSetup(pin);
  await commitPinSetup(prepared);
  return prepared.key;
}

/** A derived-but-uncommitted PIN. Nothing is stored until {@link commitPinSetup}. */
export interface PreparedPin {
  key: CryptoKey;
  saltHex: string;
  verifyToken: string;
}

/**
 * Derive the PIN key for setup, REUSING existing credentials when present.
 *
 * Reuse is the important part. A PIN setup that failed part-way has already
 * encrypted some accounts under a DEK wrapped with the key derived from the
 * stored salt. Minting a fresh salt on retry would derive a different key, so
 * that DEK could never be unwrapped again and those accounts would be lost
 * with the correct PIN in hand. If credentials exist, the entered PIN must
 * match them and the same key comes back.
 */
export async function derivePinForSetup(pin: string): Promise<PreparedPin> {
  if (!/^\d{6,}$/.test(pin)) throw new Error('PIN must be at least 6 digits');

  const existingSalt = await SecureStore.getItemAsync(SALT_KEY).catch(() => null);
  const existingVerify = await SecureStore.getItemAsync(PIN_VERIFY_KEY).catch(() => null);
  if (existingSalt && existingVerify) {
    const key = await deriveKeyFromPin(pin, hexToBytes(existingSalt));
    try {
      if ((await decryptWithKey(key, existingVerify)) === 'ogmara-pin-ok') {
        return { key, saltHex: existingSalt, verifyToken: existingVerify };
      }
    } catch {
      /* falls through to the mismatch error below */
    }
    throw new Error(
      'A PIN is already partly set up on this device. Enter that PIN to finish, or remove it first.',
    );
  }

  const salt = generateSalt();
  const key = await deriveKeyFromPin(pin, salt);
  // Encrypt a known token to verify PIN on unlock
  const verifyToken = await encryptWithKey(key, 'ogmara-pin-ok');
  return { key, saltHex: bytesToHex(salt), verifyToken };
}

/**
 * Persist the salt and verification token. NOT the commit point.
 *
 * Must run BEFORE the vault is encrypted. The salt is not a secret — it is
 * what lets the PIN key be re-derived — and `vaultEncryptAllWithPin` deletes
 * each account's plaintext as it seals it. Writing the salt afterwards meant a
 * failure mid-loop left accounts encrypted under a key whose salt was never
 * stored: unrecoverable even with the correct PIN. Storing it first costs
 * nothing, because the lock is not armed until {@link enablePinLock}.
 */
export async function persistPinCredentials(prepared: PreparedPin): Promise<void> {
  await SecureStore.setItemAsync(SALT_KEY, prepared.saltHex);
  await SecureStore.setItemAsync(PIN_VERIFY_KEY, prepared.verifyToken);
}

/**
 * Arm the lock. THE COMMIT POINT.
 *
 * `LOCK_ENABLED_KEY` is what makes the app demand a PIN at startup, so it is
 * written last — only once every account is actually encrypted.
 */
export async function enablePinLock(): Promise<void> {
  await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, '0');
  await SecureStore.setItemAsync(LOCK_ENABLED_KEY, 'true');
}

/** Back-compat wrapper: persist credentials and arm the lock in one step. */
export async function commitPinSetup(prepared: PreparedPin): Promise<void> {
  await persistPinCredentials(prepared);
  await enablePinLock();
}

/**
 * Verify the entered PIN. Returns the derived CryptoKey on success,
 * null on failure. The key can be used to decrypt the private key.
 */
export async function verifyPin(pin: string): Promise<CryptoKey | null> {
  const saltHex = await SecureStore.getItemAsync(SALT_KEY);
  const verifyToken = await SecureStore.getItemAsync(PIN_VERIFY_KEY);
  if (!saltHex || !verifyToken) return null;

  const salt = hexToBytes(saltHex);
  const key = await deriveKeyFromPin(pin, salt);

  try {
    const decrypted = await decryptWithKey(key, verifyToken);
    if (decrypted === 'ogmara-pin-ok') {
      await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, '0');
      return key;
    }
  } catch {
    // Decryption failed = wrong PIN
  }

  await incrementFailedAttempts();
  return null;
}

/** Remove PIN and disable app lock. */
export async function removePin(currentPin: string): Promise<boolean> {
  const key = await verifyPin(currentPin);
  if (!key) return false;

  await SecureStore.deleteItemAsync(SALT_KEY);
  await SecureStore.deleteItemAsync(PIN_VERIFY_KEY);
  await SecureStore.setItemAsync(LOCK_ENABLED_KEY, 'false');
  await SecureStore.deleteItemAsync(FAILED_ATTEMPTS_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(COOLDOWN_UNTIL_KEY).catch(() => {});
  return true;
}

// --- Failed Attempts & Cooldown ---

/** Get the number of consecutive failed PIN attempts. */
export async function getFailedAttempts(): Promise<number> {
  const val = await SecureStore.getItemAsync(FAILED_ATTEMPTS_KEY).catch(() => null);
  return val ? parseInt(val, 10) || 0 : 0;
}

async function incrementFailedAttempts(): Promise<void> {
  const current = await getFailedAttempts();
  const next = current + 1;
  await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, next.toString());

  // Set cooldown timestamp after 5 failures
  const cd = getCooldownSeconds(next);
  if (cd > 0) {
    const until = Date.now() + cd * 1000;
    await SecureStore.setItemAsync(COOLDOWN_UNTIL_KEY, until.toString());
  }
}

/** Get cooldown seconds based on failed attempts (5+ failures trigger cooldown). */
export function getCooldownSeconds(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  const cooldowns = [30, 60, 120, 300, 600];
  const idx = Math.min(failedAttempts - 5, cooldowns.length - 1);
  return cooldowns[idx];
}

/** Get remaining cooldown seconds (0 if no cooldown active). */
export async function getRemainingCooldown(): Promise<number> {
  const until = await SecureStore.getItemAsync(COOLDOWN_UNTIL_KEY).catch(() => null);
  if (!until) return 0;
  const remaining = Math.ceil((parseInt(until, 10) - Date.now()) / 1000);
  return Math.max(0, remaining);
}

// --- Auto-Lock ---

/** Get the auto-lock timeout in seconds (default: 300 = 5 minutes). */
export async function getLockTimeout(): Promise<number> {
  const val = await SecureStore.getItemAsync(LOCK_TIMEOUT_KEY).catch(() => null);
  return val ? parseInt(val, 10) || 300 : 300;
}

/** Set the auto-lock timeout in seconds. */
export async function setLockTimeout(seconds: number): Promise<void> {
  await SecureStore.setItemAsync(LOCK_TIMEOUT_KEY, seconds.toString());
}

// --- Idle Timer ---

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let onLockCallback: (() => void) | null = null;
let registeredListeners: { event: string; handler: () => void }[] = [];

/** Start monitoring idle activity. Calls onLock when timeout elapses. */
export function startIdleMonitor(timeoutSeconds: number, onLock: () => void): void {
  stopIdleMonitor();
  onLockCallback = onLock;

  const resetTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (onLockCallback) onLockCallback();
    }, timeoutSeconds * 1000);
  };

  // Reset on any user interaction
  const events = ['mousemove', 'keydown', 'mousedown', 'scroll', 'touchstart'];
  events.forEach((ev) => {
    window.addEventListener(ev, resetTimer, { passive: true });
    registeredListeners.push({ event: ev, handler: resetTimer });
  });

  // Start initial timer
  resetTimer();
}

/** Stop the idle monitor and remove all event listeners. */
export function stopIdleMonitor(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  registeredListeners.forEach(({ event, handler }) => {
    window.removeEventListener(event, handler);
  });
  registeredListeners = [];
  onLockCallback = null;
}
