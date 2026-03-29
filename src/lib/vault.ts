/**
 * Vault — secure key isolation layer ("firewall" for private keys).
 *
 * The private key NEVER leaves this module. When PIN lock is enabled,
 * the key is AES-256-GCM encrypted with a PBKDF2-derived key before
 * storage. The raw key is only in memory after successful PIN entry.
 *
 * Architecture:
 *   App -> Vault API (sign, getAddress) -> OS credential store
 *         ^ key never exposed outward  ^
 *         When PIN enabled: stored key is encrypted with PIN-derived AES key
 *
 * Desktop version: uses Tauri keyring commands instead of expo-secure-store.
 * Per spec 05-clients.md sections 5.5.1 (Vault Isolation Layer).
 */

import * as SecureStore from './secureStore';
import { WalletSigner } from '@ogmara/sdk';
import { encryptWithKey, decryptWithKey } from './appLock';

const VAULT_RAW_KEY = 'ogmara.vault.private_key';
const VAULT_ENCRYPTED_KEY = 'ogmara.vault.encrypted_key';
const VAULT_MODE_KEY = 'ogmara.vault.mode'; // 'raw' | 'encrypted'

/** Internal signer — never exported directly. */
let cachedSigner: WalletSigner | null = null;

/**
 * Initialize the vault WITHOUT PIN (for apps without PIN lock).
 * Returns the public address if a wallet exists, null otherwise.
 */
export async function vaultInit(): Promise<string | null> {
  const mode = await SecureStore.getItemAsync(VAULT_MODE_KEY).catch(() => null);

  if (mode === 'encrypted') {
    // Key is encrypted — cannot load without PIN. Return null.
    // Caller must use vaultUnlockWithPin().
    return null;
  }

  // Raw (unencrypted) mode — load directly
  try {
    const hex = await SecureStore.getItemAsync(VAULT_RAW_KEY);
    if (hex) {
      cachedSigner = await WalletSigner.fromHex(hex);
      return cachedSigner.address;
    }
  } catch {
    cachedSigner = null;
  }
  return null;
}

/**
 * Check if the vault has a stored wallet (encrypted or raw).
 */
export async function vaultHasWallet(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  const enc = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY).catch(() => null);
  return !!(raw || enc);
}

/**
 * Check if the vault is in encrypted (PIN-locked) mode.
 */
export async function vaultIsEncrypted(): Promise<boolean> {
  const mode = await SecureStore.getItemAsync(VAULT_MODE_KEY).catch(() => null);
  return mode === 'encrypted';
}

/**
 * Unlock the vault with a PIN-derived CryptoKey.
 * Decrypts the stored private key and loads it into memory.
 * Returns the public address on success, null on failure.
 */
export async function vaultUnlockWithPin(pinKey: CryptoKey): Promise<string | null> {
  try {
    const encrypted = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY);
    if (!encrypted) return null;

    const hex = await decryptWithKey(pinKey, encrypted);
    cachedSigner = await WalletSigner.fromHex(hex);
    return cachedSigner.address;
  } catch {
    return null; // wrong PIN or corrupted data
  }
}

/**
 * Store a new private key in the vault (raw mode, no PIN encryption).
 * Returns the derived public address.
 */
export async function vaultStore(privateKeyHex: string): Promise<string> {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error('Invalid private key format');
  }

  const signer = await WalletSigner.fromHex(privateKeyHex);

  await SecureStore.setItemAsync(VAULT_RAW_KEY, privateKeyHex);
  await SecureStore.setItemAsync(VAULT_MODE_KEY, 'raw');
  // Clean up any encrypted version
  await SecureStore.deleteItemAsync(VAULT_ENCRYPTED_KEY).catch(() => {});

  cachedSigner = signer;
  return signer.address;
}

/**
 * Encrypt the vault with a PIN-derived key.
 * Migrates from raw -> encrypted storage. Call after PIN setup.
 * The raw key is deleted after successful encryption.
 */
export async function vaultEncryptWithPin(pinKey: CryptoKey): Promise<void> {
  const hex = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  if (!hex) throw new Error('No wallet to encrypt');

  const encrypted = await encryptWithKey(pinKey, hex);
  await SecureStore.setItemAsync(VAULT_ENCRYPTED_KEY, encrypted);

  // Verify encrypted data is recoverable before deleting raw key
  const readBack = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY);
  if (!readBack) throw new Error('Encryption verification failed: could not read back');
  const testDecrypt = await decryptWithKey(pinKey, readBack);
  if (testDecrypt !== hex) throw new Error('Encryption verification failed: decryption mismatch');

  await SecureStore.setItemAsync(VAULT_MODE_KEY, 'encrypted');

  // Safe to delete raw key — encrypted data verified
  await SecureStore.deleteItemAsync(VAULT_RAW_KEY);
}

/**
 * Decrypt vault and switch back to raw storage (when PIN is removed).
 * Requires the PIN-derived key to decrypt first.
 */
export async function vaultDecryptToRaw(pinKey: CryptoKey): Promise<void> {
  const encrypted = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY);
  if (!encrypted) return;

  const hex = await decryptWithKey(pinKey, encrypted);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Decrypted key has invalid format');
  }

  await SecureStore.setItemAsync(VAULT_RAW_KEY, hex);

  // Verify raw key was written before deleting encrypted
  const readBack = await SecureStore.getItemAsync(VAULT_RAW_KEY);
  if (readBack !== hex) throw new Error('Raw key verification failed');

  await SecureStore.setItemAsync(VAULT_MODE_KEY, 'raw');
  await SecureStore.deleteItemAsync(VAULT_ENCRYPTED_KEY);
}

/**
 * Generate a new random wallet in the vault (raw mode).
 * Returns the derived public address.
 */
export async function vaultGenerate(): Promise<string> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return vaultStore(hex);
}

/** Get the WalletSigner (only available after init or PIN unlock). */
export function vaultGetSigner(): WalletSigner | null {
  return cachedSigner;
}

/** Get the wallet address without exposing the signer. */
export function vaultGetAddress(): string | null {
  return cachedSigner?.address ?? null;
}

/** Check if the vault is unlocked (signer loaded in memory). */
export function vaultIsUnlocked(): boolean {
  return cachedSigner !== null;
}

/** Lock the vault — clear signer from memory without wiping storage. */
export function vaultLock(): void {
  cachedSigner = null;
}

/** Wipe the wallet from memory and all storage. */
export async function vaultWipe(): Promise<void> {
  cachedSigner = null;
  await SecureStore.deleteItemAsync(VAULT_RAW_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(VAULT_ENCRYPTED_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(VAULT_MODE_KEY).catch(() => {});
}

/** Sign an auth request through the vault. */
export async function vaultSignRequest(
  method: string,
  path: string,
): Promise<{ [key: string]: string } | null> {
  if (!cachedSigner) return null;
  const headers = await cachedSigner.signRequest(method, path);
  return { ...headers };
}
