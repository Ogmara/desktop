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

  const first = segments[0] || 'news';
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
      return { view: 'settings', params: {}, query };

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

export { route };

/** Navigate to a new route. */
export function navigate(path: string): void {
  window.location.hash = path.startsWith('/') ? path : `/${path}`;
}

/** Navigate back in browser history. */
export function goBack(): void {
  window.history.back();
}

/** Get the current route view name. */
export function currentView(): ViewName {
  return route().view;
}

/** Get a route parameter. */
export function routeParam(key: string): string | undefined {
  return route().params[key];
}

/** Get a query parameter. */
export function queryParam(key: string): string | undefined {
  return route().query[key];
}
