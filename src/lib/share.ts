/**
 * Share link helpers — build canonical share URLs and copy them to clipboard.
 *
 * All share links resolve to the public PWA at https://ogmara.org/app so that
 * recipients always land on a working URL regardless of where the sharer runs
 * the client (web, desktop, self-hosted). The receiving app parses the hash
 * route and navigates to the target post / message.
 *
 * Thin wrappers over the SDK's `buildPermalink` (sdk-js 0.71.0, spec 06 §6.5)
 * so every client emits byte-identical links; inbound links go through
 * `parsePermalink` (see `lib/permalinkRoute.ts`).
 *
 * Desktop note: `window.location.origin` under Tauri resolves to a
 * `tauri://`-style URL that recipients cannot open. Hardcoding the PWA host
 * keeps share-out predictable from any client.
 */

import {
  buildPermalink,
  isPermalinkNodeUrl,
  PERMALINK_BASE,
  type ParsePermalinkOptions,
  type PermalinkTarget,
} from '@ogmara/sdk';

/** Canonical public host for share URLs. Hardcoded so desktop / self-hosted
 *  clients don't accidentally emit `tauri://` or local IP URLs that recipients
 *  can't open. Self-hosters who want share-out to point at their own host
 *  patch this one constant (spec 06 §6.5); the parse side accepts it too
 *  (see `SHARE_PARSE_OPTIONS`). */
const SHARE_BASE: string = 'https://ogmara.org/app';

/** `parsePermalink` options matching what this client emits: the canonical
 *  base is always accepted, plus `SHARE_BASE` if a self-hoster patched it. */
export const SHARE_PARSE_OPTIONS: ParsePermalinkOptions =
  SHARE_BASE === PERMALINK_BASE ? {} : { extraBases: [SHARE_BASE] };

/** Positive safe-integer channel id from a number or canonical decimal
 *  string, else null (the SDK builder takes numbers only). */
function toChannelId(channelId: number | string): number | null {
  const n = typeof channelId === 'number' ? channelId : /^[1-9][0-9]{0,15}$/.test(channelId) ? Number(channelId) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Build a deep link to a news post detail page — or, with `commentIdHex`,
 *  to one comment under it (`?c=`). Returns null if an id isn't 64-char hex. */
export function buildNewsShareUrl(msgIdHex: string, commentIdHex?: string): string | null {
  const target: PermalinkTarget = commentIdHex === undefined
    ? { kind: 'news', msgId: msgIdHex }
    : { kind: 'news', msgId: msgIdHex, commentId: commentIdHex };
  return buildPermalink(target, { base: SHARE_BASE });
}

/** Build a deep link to a specific chat message inside a channel. Returns
 *  null if `channelId` isn't a positive integer or `msgIdHex` isn't 64-char
 *  hex. */
export function buildChatShareUrl(channelId: number | string, msgIdHex: string): string | null {
  const ch = toChannelId(channelId);
  if (ch === null) return null;
  return buildPermalink({ kind: 'chat', channelId: ch, msgId: msgIdHex }, { base: SHARE_BASE });
}

/**
 * Build a bare channel join deep link — Public / ReadPublic channels only.
 * A Private channel has no bare link (it never granted access, and with the
 * l2-node 0.140.0+ invite gate it cannot): its only link is the PERSONAL one
 * from the SDK's `buildPrivateChannelInviteUrl`, made when inviting a specific
 * address (spec 06 §6.5). `hostNodeUrl` is an optional `?node=` hint, unused by
 * current callers; a host URL the shared parser would reject is dropped (the
 * link still works without the hint). Returns null if `channelId` isn't a
 * positive integer.
 */
export function buildChannelInviteUrl(
  channelId: number | string,
  hostNodeUrl?: string,
): string | null {
  const ch = toChannelId(channelId);
  if (ch === null) return null;
  const node = hostNodeUrl && isPermalinkNodeUrl(hostNodeUrl) ? hostNodeUrl : undefined;
  return buildPermalink(node ? { kind: 'join', channelId: ch, node } : { kind: 'join', channelId: ch }, { base: SHARE_BASE });
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
