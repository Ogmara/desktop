/**
 * Secure Store — persistent local key storage via Tauri commands.
 *
 * API-compatible with `expo-secure-store` so vault/appLock code can be shared
 * with mobile.
 *
 * WHERE THE DATA ACTUALLY LIVES: an AES-256-GCM encrypted file
 * (`.secure-store.json`, 0600) in the app data directory — NOT the OS keyring.
 * The keyring is avoided deliberately: on Linux gnome-keyring/kwallet is
 * frequently session-scoped and does not survive a reboot or run without the
 * secret service, and a keyring entry that vanishes would make every wallet on
 * the device permanently unopenable.
 *
 * The file key is MACHINE-BOUND, so a copy of the file — in a backup, a synced
 * folder, or a stolen disk image — is useless elsewhere. This is NOT equivalent
 * to the PIN and must not be described as one: the app opens this file
 * unattended at startup, so code running as the same user can too. When a PIN
 * is set the private key is encrypted a SECOND time under a key derived from
 * it, and that is the only layer that protects key material from a local
 * attacker.
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
 * Store health: read-only state, and whether at-rest encryption is bound to
 * a stable machine identifier.
 *
 * A poisoned store fails EVERY write, invisibly from here. With several
 * accounts that means index writes silently vanish while the UI looks healthy,
 * which is how an account gets lost — so the app surfaces this rather than
 * letting it fail quietly.
 */
export async function storeHealth(): Promise<{ poisoned: boolean; machineBound: boolean }> {
  try {
    const h = await invoke<{ poisoned: boolean; machine_bound: boolean }>('secure_store_health');
    return { poisoned: !!h?.poisoned, machineBound: !!h?.machine_bound };
  } catch {
    // An older shell without the command. Assume healthy rather than alarming
    // the user — but assume machine-bound too, since claiming a downgrade we
    // cannot confirm would be its own kind of wrong.
    return { poisoned: false, machineBound: true };
  }
}
