/**
 * Vault Migration — versioned storage format for safe app updates.
 *
 * Every vault storage format is versioned. When the app starts, the
 * migration system checks the stored version and migrates forward if
 * needed. Old versions are NEVER deleted until migration succeeds.
 *
 * CRITICAL RULES (never break these):
 * 1. NEVER rename SecureStore keys — always migrate to new ones
 * 2. NEVER change encryption parameters without incrementing VAULT_VERSION
 * 3. NEVER delete old-format data until new-format data is verified
 * 4. Always write the new format FIRST, verify it, THEN delete old
 * 5. Every format version must have a migration path to the next
 *
 * Storage format history:
 *   v1 (0.1.0–1.64.0): raw hex in 'ogmara.vault.private_key' or
 *       AES-256-GCM encrypted in 'ogmara.vault.encrypted_key'
 *       PBKDF2 iterations: 600,000. IV: 12 bytes. Format: "ivHex:ctHex"
 *   v2 (1.65.0+): per-account slots '<anchor>.<address>', an account index,
 *       and — in PIN mode — a DEK wrapping every slot. The v1 anchors are
 *       RETAINED, not replaced: they remain the recovery backstop and keep an
 *       older build working. See `vaultMigrateV2.ts`.
 *
 * Desktop version: uses Tauri keyring commands instead of expo-secure-store.
 * Per spec 05-clients.md section 5.5.2 (Update Safety & Vault Migration).
 */

import * as SecureStore from './secureStore';
import { WalletSigner } from '@ogmara/sdk';
import { migrateV1toV2, readVersion, type MigrationEnv } from './vaultMigrateV2';
import { browserLocal } from './vaultIndex';
import type { StoreLike } from './vaultDek';

const secureStoreAdapter: StoreLike = SecureStore;

function migrationEnv(): MigrationEnv {
  return {
    store: secureStoreAdapter,
    local: browserLocal,
    listKeystore: () => SecureStore.listVaultAccounts(),
    deriveAddress: async (hex: string) => (await WalletSigner.fromHex(hex)).address,
  };
}

/** Current vault storage format version. */
export const VAULT_VERSION = 2;

const VERSION_KEY = 'ogmara.vault.version';

// --- All known SecureStore keys across all versions ---
// v1 keys
const V1_KEYS = {
  rawKey: 'ogmara.vault.private_key',
  encryptedKey: 'ogmara.vault.encrypted_key',
  mode: 'ogmara.vault.mode',
  salt: 'ogmara.app_lock.salt',
  pinVerify: 'ogmara.app_lock.pin_verify',
  lockEnabled: 'ogmara.app_lock.enabled',
  lockTimeout: 'ogmara.app_lock.timeout_seconds',
  failedAttempts: 'ogmara.app_lock.failed_attempts',
  cooldownUntil: 'ogmara.app_lock.cooldown_until',
} as const;

/** Encryption parameters for each version (for documentation and migration). */
export const VAULT_PARAMS = {
  1: {
    kdf: 'PBKDF2-SHA256',
    kdfIterations: 600_000,
    cipher: 'AES-256-GCM',
    ivBytes: 12,
    saltBytes: 16,
    format: 'ivHex:ciphertextHex',
  },
} as const;

/**
 * Run vault migrations on app startup.
 *
 * This is safe to call on every launch. It checks the stored version
 * and only migrates if needed. Returns the current version after migration.
 */
export async function runVaultMigrations(): Promise<number> {
  const storedVersion = await getStoredVersion();

  let entryVersion = storedVersion;
  if (storedVersion === 0) {
    // First launch or pre-versioning install
    if (await hasV1VaultData()) {
      // Tag existing data as v1, then FALL THROUGH to the loop below. Returning
      // here would leave a pre-versioning install one launch behind — and for a
      // PIN'd vault it would not even record the deferred marker until the
      // second start.
      await SecureStore.setItemAsync(VERSION_KEY, '1');
      entryVersion = 1;
    } else {
      // No existing data — tag current so a wallet created from here starts
      // clean with no migration ever pending.
      await SecureStore.setItemAsync(VERSION_KEY, VAULT_VERSION.toString());
      return VAULT_VERSION;
    }
  }

  // Retire a PIN-operation journal whose work is already finished, before the
  // integrity check reads it. Without a reader it marked the vault unhealthy
  // forever after a single failed attempt.
  try {
    const { reconcilePinJournal } = await import('./vault');
    await reconcilePinJournal();
  } catch {
    /* never block startup on a diagnostic */
  }

  // A LOOP, not a chain of ifs: a device several versions behind must walk
  // every step, and each step is responsible for its own commit point.
  let version = entryVersion;
  for (let guard = 0; guard < 8 && version < VAULT_VERSION; guard++) {
    const before = version;
    if (version === 1) {
      const out = await migrateV1toV2(migrationEnv());
      if (out.result === 'deferred') {
        // PIN'd: the address is not derivable before unlock. Stays at v1 on
        // purpose; `vaultUnlockWithPin` completes it.
        return 1;
      }
    }
    version = await readVersion(secureStoreAdapter);
    if (version === before) break; // no progress — do not spin
  }
  return version;
}

/**
 * Resolve once per session, shared by every caller.
 *
 * `App.tsx` and `initAuth` both need migrations finished before they touch the
 * vault, and they start independently. Without memoizing, the migration could
 * run twice concurrently against the same key material.
 */
let migrationsPromise: Promise<number> | null = null;

export function vaultMigrationsReady(): Promise<number> {
  if (!migrationsPromise) migrationsPromise = runVaultMigrations();
  return migrationsPromise;
}

/** Get the stored vault version (0 = not set / first install). */
async function getStoredVersion(): Promise<number> {
  const val = await SecureStore.getItemAsync(VERSION_KEY).catch(() => null);
  if (!val) return 0;
  return parseInt(val, 10) || 0;
}

/** Check if v1 vault data exists in the credential store. */
async function hasV1VaultData(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(V1_KEYS.rawKey).catch(() => null);
  const enc = await SecureStore.getItemAsync(V1_KEYS.encryptedKey).catch(() => null);
  return !!(raw || enc);
}

/**
 * Verify vault integrity — check that the stored data can be loaded.
 *
 * Call after migration or on app startup to detect corruption early.
 * Returns true if the vault data is readable (doesn't verify PIN decryption,
 * only that the storage keys exist and have valid format).
 */
export async function verifyVaultIntegrity(): Promise<{
  hasWallet: boolean;
  mode: 'raw' | 'encrypted' | 'none';
  version: number;
  accounts: number;
  healthy: boolean;
}> {
  const version = await getStoredVersion();
  const mode = await SecureStore.getItemAsync(V1_KEYS.mode).catch(() => null);
  const raw = await SecureStore.getItemAsync(V1_KEYS.rawKey).catch(() => null);
  const enc = await SecureStore.getItemAsync(V1_KEYS.encryptedKey).catch(() => null);

  // Per-account slots count as a wallet. Checking only the legacy anchors
  // would report `hasWallet: false` for a fully-migrated vault — and the
  // caller acts on that by offering to create a new wallet.
  const accounts = await SecureStore.listVaultAccounts().catch(() => [] as string[]);

  const hasWallet = !!(raw || enc) || accounts.length > 0;
  let healthy = true;

  if (mode === 'raw' && !raw) healthy = false; // claims raw but no key
  if (mode === 'encrypted' && !enc) healthy = false; // claims encrypted but no key
  if (raw && !/^[0-9a-fA-F]{64}$/.test(raw)) healthy = false; // corrupt raw key
  if (enc && !enc.includes(':')) healthy = false; // corrupt encrypted format
  // A v2 vault with an outstanding deferred migration is expected, not broken;
  // an unfinished PIN journal is not.
  const journal = await SecureStore.getItemAsync('ogmara.vault.pin_migration').catch(() => null);
  if (journal) healthy = false;

  return {
    hasWallet,
    mode: (mode as 'raw' | 'encrypted') || 'none',
    version,
    accounts: accounts.length,
    healthy,
  };
}

/**
 * Vault diagnostics — reports key existence for debugging/support.
 * Does NOT return key values (that would defeat the vault).
 */
export async function getVaultDiagnostics(): Promise<Record<string, boolean | number | string>> {
  const result: Record<string, boolean | number | string> = {};
  for (const [name, key] of Object.entries(V1_KEYS)) {
    result[name] = !!(await SecureStore.getItemAsync(key).catch(() => null));
  }
  result['version'] = await getStoredVersion();

  // Multi-account state. Reported as counts and flags only — never values,
  // which would defeat the vault.
  const keystore = await SecureStore.listVaultAccounts().catch(() => [] as string[]);
  result['keystoreAccounts'] = keystore.length;
  try {
    const primary = JSON.parse(localStorage.getItem('ogmara.vault.accounts.index') || '[]');
    result['indexedAccounts'] = Array.isArray(primary) ? primary.length : 0;
  } catch {
    result['indexedAccounts'] = 0;
  }
  const mirror = await SecureStore.getItemAsync('ogmara.vault.accounts').catch(() => null);
  try {
    const parsed = mirror ? JSON.parse(mirror) : [];
    result['mirroredAccounts'] = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    result['mirroredAccounts'] = 0;
  }
  // Disagreement between the three is the signal worth surfacing: it means one
  // source is stale, and the union is carrying the difference.
  result['indexSourcesAgree'] =
    result['keystoreAccounts'] === result['indexedAccounts'] &&
    result['indexedAccounts'] === result['mirroredAccounts'];

  result['activeRecorded'] = !!(await SecureStore.getItemAsync('ogmara.vault.active').catch(() => null));
  result['dek'] = !!(await SecureStore.getItemAsync('ogmara.vault.dek').catch(() => null));
  result['dekMirror'] = !!(await SecureStore.getItemAsync('ogmara.vault.dek.mirror').catch(() => null));
  result['deferredMigrationPending'] =
    !!(await SecureStore.getItemAsync('ogmara.vault.v2_pending').catch(() => null));
  result['pinMigrationJournal'] =
    !!(await SecureStore.getItemAsync('ogmara.vault.pin_migration').catch(() => null));

  const health = await SecureStore.storeHealth();
  result['storePoisoned'] = health.poisoned;
  result['storeMachineBound'] = health.machineBound;
  return result;
}
