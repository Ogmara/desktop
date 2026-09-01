/**
 * Open an external http(s) URL in the system default browser.
 *
 * On Linux/webkit2gtk a plain `<a target="_blank">` and the Tauri shell plugin
 * both silently do nothing, so every "open in browser" path has to go through
 * the custom `open_url` Rust command (xdg-open / open / explorer). This is the
 * one shared wrapper — call it from an `onClick` that `preventDefault()`s.
 */
import { invoke } from '@tauri-apps/api/core';

export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  invoke('open_url', { url }).catch((err) => {
    console.error('[openExternal] open_url failed:', err);
  });
}
