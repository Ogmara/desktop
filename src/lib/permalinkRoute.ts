/**
 * Inbound share links ("permalinks", spec 06 §6.5) → in-app hash routes.
 *
 * Every inbound link — the page's own hash on load / hashchange, and an
 * Ogmara link clicked inside a message — goes through the SDK's
 * `parsePermalink` before the app acts on its ids. Anything it rejects is not
 * a permalink: the router still routes the path (e.g. to the channel), but
 * the `msg` / `c` / `node` / `inv` targets are ignored, silently and without
 * echoing the input (plan §9, "Malformed / hostile link").
 *
 * Kept free of DOM / router imports so it runs under `node --test`.
 */

import { buildPermalink, parsePermalink, PERMALINK_BASE, type PermalinkTarget } from '@ogmara/sdk';
import { SHARE_PARSE_OPTIONS } from './share.ts';

/**
 * Parse a raw hash route (the part after `#/`, e.g. `chat/7?msg=<hex>`) as a
 * permalink. Returns null for anything that is not a well-formed chat / news
 * / join permalink — including a bare channel route without `?msg=`.
 *
 * Legacy compat: some older invite links double-encoded `?node=`
 * (`https%253A%252F%252F…`). If the strict parse fails, the `node` value is
 * decoded once more and the parse retried; the retry only ever yields a
 * `join` target and goes through the same strict parser.
 */
export function permalinkFromHashRoute(raw: string): PermalinkTarget | null {
  if (typeof raw !== 'string') return null;
  const route = raw.replace(/^#?\/?/, '');
  const parse = (r: string) => parsePermalink(`${PERMALINK_BASE}/#/${r}`, { allowNative: false });
  const direct = parse(route);
  if (direct) return direct;
  if (!route.startsWith('join/')) return null;
  let changed = false;
  const legacy = route.replace(/([?&]node=)([^&]*)/, (whole, key: string, val: string) => {
    try {
      const once = decodeURIComponent(val);
      if (once === val) return whole;
      changed = true;
      return key + once;
    } catch {
      return whole;
    }
  });
  if (!changed) return null;
  const retry = parse(legacy);
  return retry && retry.kind === 'join' ? retry : null;
}

/**
 * Parse a link found in message text. Accepts the canonical base, the patched
 * `SHARE_BASE` and — when given — this app's own base (`appBase`, e.g.
 * `https://chat.example.org/app` for a self-hosted PWA), so a link copied from
 * the address bar of the same deployment resolves in-app too. Never derive
 * `appBase` from the link itself. Native `ogmara://` links are not
 * auto-linked in text, so they are not accepted here.
 */
export function permalinkFromUrl(url: string, appBase?: string): PermalinkTarget | null {
  const extraBases = [...(SHARE_PARSE_OPTIONS.extraBases ?? [])];
  if (appBase) extraBases.push(appBase);
  try {
    return parsePermalink(url, { extraBases, allowNative: false });
  } catch {
    // An unusable `appBase` (e.g. a non-http origin) — fall back to the
    // canonical bases only.
    return parsePermalink(url, { ...SHARE_PARSE_OPTIONS, allowNative: false });
  }
}

/**
 * The in-app hash path for a target (`/chat/7?msg=<hex>`), built by the SDK so
 * it is canonical (lower-case ids, `node` re-encoded). Null for an invalid
 * target.
 */
export function routeForPermalink(target: PermalinkTarget): string | null {
  const native = buildPermalink(target, { native: true });
  return native ? `/${native.slice('ogmara://'.length)}` : null;
}
