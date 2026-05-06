/**
 * Settings sync — encrypt/decrypt user settings for cross-device sync via L2 node.
 *
 * Key derivation: HKDF from wallet signing key → AES-256-GCM.
 */

import { getSetting, setSetting } from './settings';
import { getClient } from './api';
import { DESIGN_STYLES, COLOR_SCHEMES, type DesignStyle, type ColorScheme } from './theme';

/** JSON-encoded settings keys synced across devices (read/write via getSetting/setSetting). */
const SYNC_KEYS = ['lang', 'notificationSound', 'compactLayout', 'fontSize'] as const;

/** Theme-style keys stored as raw strings in localStorage (read/write via lib/theme.ts).
 *  Kept on a separate path to avoid JSON-encoding breakage when the value is a
 *  bare string like "dark" or "modern". Default-landing-view is a JSON-encoded
 *  setting via getSetting/setSetting, so it stays in SYNC_KEYS. */
const RAW_SYNC_KEYS = ['theme', 'designStyle', 'colorScheme'] as const;

/** Derive an AES-256-GCM key from a hex private key using HKDF. */
async function deriveKey(hexKey: string): Promise<CryptoKey> {
  if (!hexKey || !/^[0-9a-fA-F]+$/.test(hexKey)) {
    throw new Error('Invalid key format');
  }
  const keyBytes = fromHex(hexKey);
  const baseKey = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveKey']);
  // Zero the intermediate key bytes
  keyBytes.fill(0);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // Include wallet-specific salt for domain separation (SEC-W4)
      salt: new TextEncoder().encode('ogmara-settings-sync'),
      info: new TextEncoder().encode('aes-256-gcm'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  if (!hex || hex.length === 0) return new Uint8Array(0);
  const matches = hex.match(/.{1,2}/g);
  if (!matches) return new Uint8Array(0);
  return new Uint8Array(matches.map((b) => parseInt(b, 16)));
}

/** Collect current settings and encrypt them. */
export async function encryptSettings(hexKey: string): Promise<{ encrypted_settings: Uint8Array; nonce: Uint8Array; key_epoch: number }> {
  const settings: Record<string, unknown> = {};
  for (const key of SYNC_KEYS) {
    settings[key] = getSetting(key);
  }
  // Theme-style keys are stored raw in localStorage (not JSON), so read them
  // directly here. They round-trip as string-typed entries in the synced blob.
  for (const key of RAW_SYNC_KEYS) {
    const raw = localStorage.getItem(`ogmara.${key}`);
    if (raw !== null) settings[key] = raw;
  }
  const plaintext = new TextEncoder().encode(JSON.stringify(settings));
  const key = await deriveKey(hexKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext);
  return {
    encrypted_settings: new Uint8Array(ciphertext),
    nonce,
    key_epoch: 0,
  };
}

/** Decrypt settings blob and apply to local storage. */
export async function decryptAndApplySettings(
  hexKey: string,
  encryptedSettings: Uint8Array,
  nonce: Uint8Array,
): Promise<void> {
  const key = await deriveKey(hexKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    encryptedSettings,
  );
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Failed to parse synced settings');
  }
  if (typeof settings !== 'object' || settings === null) {
    throw new Error('Invalid settings format');
  }
  for (const [k, v] of Object.entries(settings)) {
    // JSON-encoded keys: write via setSetting
    if (SYNC_KEYS.includes(k as any) && (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')) {
      setSetting(k as any, v as any);
    }
    // Raw-string theme keys: write directly to preserve theme.ts storage format.
    // theme.ts re-reads these values on its next access, so the change applies
    // on the next paint cycle without an explicit refresh.
    //
    // Validate the value against the current accepted set BEFORE writing —
    // a stale v1.15.x synced blob carrying `designStyle:"elevated"` would
    // otherwise pollute localStorage with a value `getDesignStyle()` then
    // ignores (silently migrating to `modern` on read), but which keeps
    // riding into every subsequent sync upload.
    if (RAW_SYNC_KEYS.includes(k as any) && typeof v === 'string' && isValidRawSyncValue(k, v)) {
      localStorage.setItem(`ogmara.${k}`, v);
    }
  }
}

/** Whether a synced raw-string value is in the current accepted set for `key`. */
function isValidRawSyncValue(key: string, value: string): boolean {
  if (key === 'theme') return value === 'light' || value === 'dark' || value === 'system';
  if (key === 'designStyle') return DESIGN_STYLES.includes(value as DesignStyle);
  if (key === 'colorScheme') return COLOR_SCHEMES.includes(value as ColorScheme);
  return false;
}

/** Upload current settings to L2 node. */
export async function uploadSettings(hexKey: string): Promise<void> {
  const data = await encryptSettings(hexKey);
  const client = getClient();
  await client.syncSettings(data);
}

/** Download and apply settings from L2 node. */
export async function downloadSettings(hexKey: string): Promise<boolean> {
  const client = getClient();
  const resp = await client.getSettings();
  if (!resp) return false;
  await decryptAndApplySettings(
    hexKey,
    new Uint8Array(resp.encrypted_settings),
    new Uint8Array(resp.nonce),
  );
  return true;
}
