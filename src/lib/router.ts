/**
 * Hash-based URL router for the Ogmara desktop app.
 *
 * Uses hash fragments (#/path) — works identically in Tauri's webview.
 *
 * Routes:
 *   #/chat                  — Channel list (default)
 *   #/chat/:channelId       — Channel messages
 *   #/news                  — News feed
 *   #/news/:msgId           — News post detail
 *   #/dm                    — DM conversations list
 *   #/dm/:address           — DM conversation
 *   #/user/:address         — User profile
 *   #/search                — Search
 *   #/search?q=term         — Search with query
 *   #/bookmarks             — Bookmarks
 *   #/settings              — Settings
 *   #/wallet                — Wallet management
 *   #/wallet/tokens         — Token portfolio (balances + send)
 */

import { createSignal } from 'solid-js';
import { getSetting } from './settings';
import { registerWalletSwitchReset, getWalletScope } from './walletScope';
import { routeAfterAccountChange } from './routeCarryover';

export type ViewName =
  | 'chat'
  | 'news'
  | 'news-detail'
  | 'dm'
  | 'dm-conversation'
  | 'user'
  | 'search'
  | 'bookmarks'
  | 'settings'
  | 'wallet'
  | 'accounts'
  | 'accounts-add'
  | 'topics-settings'
  | 'token-portfolio'
  | 'compose'
  | 'channel-create'
  | 'channel-settings'
  | 'channel-join'
  | 'notifications'
  | 'follow-list';

export interface Route {
  view: ViewName;
  params: Record<string, string>;
  query: Record<string, string>;
}

function parseHash(hash: string): Route {
  // Remove leading # and /
  const raw = hash.replace(/^#\/?/, '');
  // Split query string
  const [path, queryStr] = raw.split('?');
  const segments = path.split('/').filter(Boolean);

  // Parse query params
  const query: Record<string, string> = {};
  if (queryStr) {
    for (const pair of queryStr.split('&')) {
      const [k, v] = pair.split('=');
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }

  // Default first segment honors the user's preferred landing view (Settings).
  // News is the default for new users; users who pick Chat get their last
  // channel restored automatically by the `case 'chat'` block below.
  const first = segments[0] || (getSetting('defaultLandingView') === 'chat' ? 'chat' : 'news');
  const second = segments[1] || '';
  const third = segments[2] || '';

  switch (first) {
    case 'chat':
      if (second && third === 'settings') {
        return { view: 'channel-settings', params: { channelId: second }, query };
      }
      if (second) {
        return { view: 'chat', params: { channelId: second }, query };
      }
      // No channelId in URL — restore the last-visited channel if available.
      // This is what makes the Chat tab "remember" where the user left off,
      // and pairs with the default-landing setting in Settings.
      {
        const last = getSetting('lastChannel');
        if (last) {
          return { view: 'chat', params: { channelId: String(last) }, query };
        }
      }
      return { view: 'chat', params: {}, query };

    case 'news':
      if (second) {
        return { view: 'news-detail', params: { msgId: second }, query };
      }
      return { view: 'news', params: {}, query };

    case 'dm':
      if (second) {
        return { view: 'dm-conversation', params: { address: second }, query };
      }
      return { view: 'dm', params: {}, query };

    case 'user':
      if (third === 'followers') {
        return { view: 'follow-list', params: { address: second, tab: 'followers' }, query };
      }
      if (third === 'following') {
        return { view: 'follow-list', params: { address: second, tab: 'following' }, query };
      }
      return { view: 'user', params: { address: second }, query };

    case 'search':
      return { view: 'search', params: {}, query };

    case 'bookmarks':
      return { view: 'bookmarks', params: {}, query };

    case 'notifications':
      return { view: 'notifications', params: {}, query };

    case 'settings':
      // `/settings/topics` is its own view rather than an inline sidebar
      // panel — see `TopicsSettingsView` — so managing topics can be linked
      // to and backed out of like everything else.
      if (second === 'topics') return { view: 'topics-settings', params: {}, query };
      return { view: 'settings', params: {}, query };

    case 'accounts':
      // `/accounts/add` is its own view rather than a modal so it can be
      // linked to and backed out of like everything else.
      if (second === 'add') return { view: 'accounts-add', params: {}, query };
      return { view: 'accounts', params: {}, query };

    case 'wallet':
      if (second === 'tokens') {
        return { view: 'token-portfolio', params: {}, query };
      }
      return { view: 'wallet', params: { sub: second }, query };

    case 'compose':
      return { view: 'compose', params: {}, query };

    case 'channel':
      if (second === 'create') {
        return { view: 'channel-create', params: {}, query };
      }
      return { view: 'chat', params: {}, query };

    case 'join':
      return { view: 'channel-join', params: { channelId: second }, query };

    default:
      return { view: 'chat', params: {}, query };
  }
}

const [route, setRoute] = createSignal<Route>(parseHash(window.location.hash));

// Listen for hash changes
window.addEventListener('hashchange', () => {
  setRoute(parseHash(window.location.hash));
});

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

// A bare `#/chat` resolves to the ACTIVE account's `lastChannel` (a per-account
// setting) at parse time. Without a re-parse on switch, the route signal kept
// the PREVIOUS account's last channel until the next hashchange, rendering —
// and acting on — a channel that belongs to the other account. Only replace the
// route when it actually differs, so an unchanged route does not re-run every
// route-keyed effect in the app.
//
// Deferred to a microtask: this reset fires from inside `setWalletScope()`,
// BEFORE `switchAccountInner` has attached the new signer and flipped
// `walletAddress()`. Re-rendering views synchronously there would run their
// effects against a half-switched session. The microtask runs after that
// synchronous block, and re-reads the hash and scope at run time, so a second
// switch in between still lands on the right account's route.
//
// On an in-place switch between two accounts (not the first login — deep
// links opened before signing in must survive), a per-account DETAIL route
// (`/chat/:id`, `/chat/:id/settings`, `/dm/:peer`) belongs to the previous
// account and is replaced by its neutral list route — see routeCarryover.ts.
// `replaceState` rather than `navigate`: no history entry, no `hashchange`,
// so this cannot feed back into itself.
let lastActiveWallet: string | null = null;
registerWalletSwitchReset(() => {
  if (typeof window === 'undefined') return;
  queueMicrotask(() => {
    const scope = getWalletScope();
    const prevActive = lastActiveWallet;
    if (scope) lastActiveWallet = scope;
    const cur = route();
    const neutral = routeAfterAccountChange(cur.view, cur.params, prevActive, scope);
    if (neutral) {
      try { window.history.replaceState(window.history.state, '', `#${neutral}`); } catch { /* fall through to setRoute */ }
      setRoute(parseHash(`#${neutral}`));
      return;
    }
    const next = parseHash(window.location.hash);
    if (next.view !== cur.view || !sameRecord(next.params, cur.params) || !sameRecord(next.query, cur.query)) {
      setRoute(next);
    }
  });
});

export { route };

// Counts in-app navigations since this page load, so goBack() can tell a real
// "came from elsewhere in the app" case apart from a fresh deep link (where
// window.history has entries, but none of them are ours to return to).
let navCount = 0;

/** Navigate to a new route. */
export function navigate(path: string): void {
  navCount++;
  window.location.hash = path.startsWith('/') ? path : `/${path}`;
}

/**
 * Navigate back to wherever the user actually came from within the app.
 * Falls back to `fallback` when there's no in-app history to return to
 * (e.g. the view was opened via a deep link / page reload).
 */
export function goBack(fallback: string = '/chat'): void {
  if (navCount > 0) {
    navCount--;
    window.history.back();
  } else {
    navigate(fallback);
  }
}

/** Get a route parameter. */
export function routeParam(key: string): string | undefined {
  return route().params[key];
}

/** Get a query parameter. */
export function queryParam(key: string): string | undefined {
  return route().query[key];
}
