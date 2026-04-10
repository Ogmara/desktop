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

const SALT_KEY = 'ogmara.app_lock.salt';
const PIN_VERIFY_KEY = 'ogmara.app_lock.pin_verify';
const LOCK_ENABLED_KEY = 'ogmara.app_lock.enabled';
const LOCK_TIMEOUT_KEY = 'ogmara.app_lock.timeout_seconds';
const FAILED_ATTEMPTS_KEY = 'ogmara.app_lock.failed_attempts';
const COOLDOWN_UNTIL_KEY = 'ogmara.app_lock.cooldown_until';

const PBKDF2_ITERATIONS = 600_000;

// --- Crypto helpers using SubtleCrypto ---

/** Generate a random salt (16 bytes). */
function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Derive an AES-256-GCM key from a PIN using PBKDF2-SHA256.
 * 600,000 iterations per OWASP recommendation.
 */
export async function deriveKeyFromPin(
  pin: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const pinBytes = encoder.encode(pin);
  // Use .slice() to guarantee a clean ArrayBuffer (webkit2gtk SubtleCrypto
  // rejects ArrayBufferLike / offset views from Uint8Array.buffer)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    pinBytes.buffer.slice(pinBytes.byteOffset, pinBytes.byteOffset + pinBytes.byteLength),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt data with AES-256-GCM. Returns iv + ciphertext as hex. */
export async function encryptWithKey(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) },
    key,
    plaintextBytes.buffer.slice(plaintextBytes.byteOffset, plaintextBytes.byteOffset + plaintextBytes.byteLength),
  );
  // Format: ivHex:ciphertextHex
  return bytesToHex(iv) + ':' + bytesToHex(new Uint8Array(ciphertext));
}

/** Decrypt AES-256-GCM data. Input format: ivHex:ciphertextHex. */
export async function decryptWithKey(
  key: CryptoKey,
  encrypted: string,
): Promise<string> {
  const parts = encrypted.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Invalid encrypted data format');
  }
  const [ivHex, ctHex] = parts;
  if (ivHex.length !== 24) { // 12 bytes = 24 hex chars
    throw new Error('Invalid IV length');
  }
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(ctHex);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) },
    key,
    ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength),
  );
  return new TextDecoder().decode(plaintext);
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
  if (!/^\d{6,}$/.test(pin)) throw new Error('PIN must be at least 6 digits');

  const salt = generateSalt();
  const key = await deriveKeyFromPin(pin, salt);

  // Encrypt a known token to verify PIN on unlock
  const verifyToken = await encryptWithKey(key, 'ogmara-pin-ok');

  await SecureStore.setItemAsync(SALT_KEY, bytesToHex(salt));
  await SecureStore.setItemAsync(PIN_VERIFY_KEY, verifyToken);
  await SecureStore.setItemAsync(LOCK_ENABLED_KEY, 'true');
  await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, '0');

  return key;
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
