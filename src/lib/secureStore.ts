/**
 * Secure Store — OS credential store access via Tauri commands.
 *
 * Wraps the Rust-side keyring integration (macOS Keychain,
 * Windows Credential Manager, Linux Secret Service) with an API
 * matching expo-secure-store so vault/appLock code can be shared.
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
