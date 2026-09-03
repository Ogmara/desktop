/**
 * Secure Store — persistent local key storage via Tauri commands.
 *
 * API-compatible with `expo-secure-store` so vault/appLock code can be shared
 * with mobile.
 *
 * WHERE THE DATA ACTUALLY LIVES: a JSON file (`.secure-store.json`, 0600) in
 * the app data directory — NOT the OS keyring. This is deliberate: on Linux
 * gnome-keyring/kwallet is frequently session-scoped and does not survive a
 * reboot or run without the secret service, which would lose the user's
 * wallet. The file is always available and survives restarts. When a PIN is
 * set the private key is AES-256-GCM encrypted inside it; without a PIN the
 * file is only as protected as its filesystem permissions.
 *
 * (This header previously claimed Keychain / Credential Manager / Secret
 * Service. It never used them — see the rationale in `src-tauri/src/lib.rs`.)
 *
 * The Rust side enforces two things the webview cannot bypass: keys must start
 * with `ogmara.vault.` or `ogmara.app_lock.`, and deleting the LAST wallet-key
 * slot requires a native confirmation dialog.
 */

import { invoke } from '@tauri-apps/api/core';

/** Read a value from the OS credential store. Returns null if not found. */
export async function getItemAsync(key: string): Promise<string | null> {
  return invoke<string | null>('secure_store_get', { key });
}

/** Write a value to the OS credential store. */
export async function setItemAsync(key: string, value: string): Promise<void> {
  await invoke('secure_store_set', { key, value });
}

/** Delete a value from the OS credential store. */
export async function deleteItemAsync(key: string): Promise<void> {
  await invoke('secure_store_delete', { key });
}

/**
 * Delete several keys as ONE guarded operation.
 *
 * Removing an account touches four keys and a total wipe touches four per
 * account. Deleting them one at a time evaluates the native last-key guard N
 * times and can raise N dialogs, which users learn to click through — so
 * anything removing more than one key at once must come through here.
 */
export async function deleteManyAsync(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await invoke('secure_store_delete_many', { keys });
}

/**
 * Addresses that have a wallet-key slot on this device.
 *
 * The highest-provenance source for the account index: its presence PROVES a
 * slot exists, where the stored index only records that one did. Unlike
 * mobile's store, this one is enumerable, so a lost or corrupted index cannot
 * strand an account.
 */
export async function listVaultAccounts(): Promise<string[]> {
  try {
    return await invoke<string[]>('secure_store_list_vault_accounts');
  } catch {
    // An older shell without the command, or a poisoned store. The other index
    // sources still resolve; never let this throw into the boot path.
    return [];
  }
}

/**
 * Whether the store has gone read-only after a corrupt load.
 *
 * A poisoned store fails EVERY write, invisibly from here. With several
 * accounts that means index writes silently vanish while the UI looks healthy,
 * which is how an account gets lost — so the app surfaces this rather than
 * letting it fail quietly.
 */
export async function isStorePoisoned(): Promise<boolean> {
  try {
    return await invoke<boolean>('secure_store_health');
  } catch {
    return false;
  }
}
