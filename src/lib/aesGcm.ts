/**
 * AES-GCM and PBKDF2 primitives — dependency-free.
 *
 * Split out of `appLock.ts` so key-management code can use the SAME
 * implementation without dragging in the secure store (and through it the
 * Tauri bridge). That matters for more than tidiness: `vaultDek` seals every
 * account slot with these, so a second copy of the format that drifted would
 * make stored keys unreadable. One implementation, imported by both.
 *
 * Having no imports also makes this — and everything built on it — testable
 * under `node --test`, which cannot resolve the app's extensionless imports.
 *
 * The ciphertext format is `ivHex:ctHex` and MUST NOT change: existing vaults
 * are encoded this way.
 */

const PBKDF2_ITERATIONS = 600_000;

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
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
      // audit 2026-06-07 B4.1: cast to ArrayBuffer — TS5.9 types .slice() as ArrayBuffer|SharedArrayBuffer
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
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
    // audit 2026-06-07 B4.1: cast to ArrayBuffer — TS5.9 types .slice() as ArrayBuffer|SharedArrayBuffer
    { name: 'AES-GCM', iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
    key,
    ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer,
  );
  return new TextDecoder().decode(plaintext);
}
