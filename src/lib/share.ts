/**
 * Share link helpers — build canonical share URLs and copy them to clipboard.
 *
 * All share links resolve to the public PWA at https://ogmara.org/app so that
 * recipients always land on a working URL regardless of where the sharer runs
 * the client (web, desktop, self-hosted). The receiving app parses the hash
 * route and navigates to the target post / message.
 *
 * Desktop note: `window.location.origin` under Tauri resolves to a
 * `tauri://`-style URL that recipients cannot open. Hardcoding the PWA host
 * keeps share-out predictable from any client.
 */

/** Canonical public host for share URLs. */
const SHARE_BASE = 'https://ogmara.org/app';

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Reject anything that isn't a 64-char lowercase-or-uppercase hex string.
 *  Returns the normalized (lower-cased) hex on success, or null. */
function sanitizeMsgId(msgId: string): string | null {
  if (typeof msgId !== 'string') return null;
  return HEX64.test(msgId) ? msgId.toLowerCase() : null;
}

/** Reject anything that isn't a positive integer channel_id. Returns the
 *  string form on success, or null. */
function sanitizeChannelId(channelId: number | string): string | null {
  const s = String(channelId);
  return /^\d+$/.test(s) ? s : null;
}

/** Build a deep link to a news post detail page. Returns null if `msgIdHex`
 *  isn't a well-formed 64-char hex string. */
export function buildNewsShareUrl(msgIdHex: string): string | null {
  const id = sanitizeMsgId(msgIdHex);
  if (!id) return null;
  return `${SHARE_BASE}/#/news/${id}`;
}

/** Build a deep link to a specific chat message inside a channel. Returns
 *  null if `channelId` isn't a positive integer or `msgIdHex` isn't 64-char
 *  hex. */
export function buildChatShareUrl(channelId: number | string, msgIdHex: string): string | null {
  const ch = sanitizeChannelId(channelId);
  const id = sanitizeMsgId(msgIdHex);
  if (!ch || !id) return null;
  return `${SHARE_BASE}/#/chat/${ch}?msg=${id}`;
}

/**
 * Copy `text` to the clipboard. Returns true on success.
 *
 * Tauri's webview exposes the standard `navigator.clipboard` API, so we use
 * that as the primary path. Falls back to a hidden-textarea + execCommand
 * route for older environments / insecure HTTP contexts.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
