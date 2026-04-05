/**
 * Desktop notification manager — native OS notifications via Tauri.
 *
 * Replaces the web app's Web Push API with Tauri's notification plugin.
 * Notifications are triggered from WebSocket events (mentions, DMs, replies).
 */

import { getSetting, setSetting } from './settings';

/** Invoke a Tauri command (safe no-op when running in browser). */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    if ((window as any).__TAURI_INTERNALS__) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<T>(cmd, args);
    }
  } catch {}
  return null;
}

/** Enable native desktop notifications. */
export function enableNotifications(): void {
  setSetting('pushEnabled', true);
}

/** Disable native desktop notifications. */
export function disableNotifications(): void {
  setSetting('pushEnabled', false);
}

/** Check if notifications are enabled. */
export function areNotificationsEnabled(): boolean {
  return getSetting('pushEnabled');
}

/**
 * Send a native OS notification via Tauri.
 * Only sends if notifications are enabled in settings.
 */
export async function sendNativeNotification(title: string, body: string): Promise<void> {
  if (!areNotificationsEnabled()) return;

  await invoke('send_notification', { title, body });
}
