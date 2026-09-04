/**
 * Local settings storage — persists user preferences to localStorage.
 *
 * Keys and defaults from spec 06-frontend.md section 4.1.
 *
 * Most settings are read via the plain `getSetting`/`setSetting` pair
 * (one-shot reads, applied on next mount). Settings whose changes need
 * to propagate live across already-mounted components — currently just
 * `currency` for the wallet's fiat column — expose an additional
 * `current*` accessor backed by a Solid signal; see `currentCurrency`.
 */

import { createSignal } from 'solid-js';
import { validateCurrency } from './sanitize.ts';
import { scopedKey } from './walletScope.ts';

export interface Settings {
  lang: string;
  theme: string;
  notificationSound: boolean;
  pushEnabled: boolean;
  notificationPreview: boolean;
  compactLayout: boolean;
  mediaAutoload: string;
  lastChannel: number | null;
  sidebarCollapsed: boolean;
  fontSize: string;
  walletAddress: string | null;
  pinnedChannels: number[];
  mutedChannels: number[];
  mutedUsers: string[];
  walletSource: string;
  nodeUrl: string;
  channelsExpanded: boolean;
  /** Cached device registration status: "wallet:device" key to avoid re-registration. */
  deviceRegistered: string;
  /** Stable per-install device id (32-byte hex) used in the enc-key binding (§2.4). */
  deviceId: string;
  /** Cached enc-key binding marker "wallet:enc_pub" to avoid re-publishing. */
  encKeyBound: string;
  /** Push gateway URL. Empty = auto-derive from nodeUrl (same host, port 41722). */
  pushGatewayUrl: string;
  /** Which view the app opens to after vault unlock — `news` or `chat`. */
  defaultLandingView: 'chat' | 'news';
  /** Fiat currency used to display token values in the wallet. ISO-4217 lowercase. */
  currency: string;
  /**
   * Which feed mode the news view defaults to when opened without an
   * explicit `?feed=` query param. Auto-saved every time the user
   * switches via the sidebar pills, so their last choice IS the
   * default on next launch. `following` is only meaningful when a
   * wallet is connected — the news view falls back to global with
   * a value-prop card when the user isn't authenticated.
   */
  defaultFeed: 'global' | 'following';
  /**
   * News Feed resume-position state (v1.55.0+). The client persists the hex
   * `msg_id` of the topmost visible post per feed mode, plus a "last viewed"
   * wall-clock ms timestamp. On reopening the feed within 24h it restores that
   * post as the scroll anchor so the user scrolls up for what's new; idle > 24h
   * (or no saved id) opens at the newest post. Empty string / 0 = none.
   */
  newsLastReadGlobal: string;
  newsLastReadFollowing: string;
  newsLastViewedAt: number;
  /**
   * User-known L2 node URLs the picker should always remember.
   *
   * Auto-populated every time the user successfully `switchNode`s to
   * a new URL (whether via the picker's manual-add field or the
   * Settings text input). Persists across switches so that a user
   * who picks a new node and then opens the picker again still sees
   * their previous node in the list — even if the new node's
   * `/api/v1/network/nodes` doesn't advertise it back. The default
   * node URL is implicitly included by the picker; only manually-
   * added URLs end up in this array.
   */
  knownNodes: string[];
  /**
   * User-pinned "always connect here first" node URL (v1.23.0+).
   *
   * Empty string = no pin → boot picks the lowest-ping node from
   * `knownNodes ∪ DEFAULT_NODE_URL ∪ peers-of-current-node`.
   *
   * Set via the `★` toggle in the node picker. When set, the boot
   * sequence tries this URL first with a 3 s timeout; on failure it
   * silently falls back to best-ping and surfaces a one-time
   * "default unreachable" notice. Useful for private channels
   * hosted natively at a specific node — pinning it guarantees the
   * client always lands there first.
   */
  defaultNodeUrl: string;

  /**
   * Last-known Klever network ('mainnet' | 'testnet'), persisted from a
   * node's `networkStats.network`. Read at cold boot so on-chain SC node
   * discovery targets the right registry BEFORE any node is reached.
   * Defaults to mainnet (the production registry).
   */
  kleverNetwork: 'mainnet' | 'testnet';
}

const defaults: Settings = {
  lang: 'auto',
  theme: 'system',
  notificationSound: true,
  pushEnabled: false,
  notificationPreview: true,
  compactLayout: false,
  mediaAutoload: 'wifi',
  lastChannel: null,
  sidebarCollapsed: false,
  fontSize: 'medium',
  walletAddress: null,
  pinnedChannels: [],
  mutedChannels: [],
  mutedUsers: [],
  channelsExpanded: false,
  walletSource: '',
  nodeUrl: '',
  deviceRegistered: '',
  deviceId: '',
  encKeyBound: '',
  pushGatewayUrl: '',
  defaultLandingView: 'news',
  currency: 'usd',
  defaultFeed: 'global',
  newsLastReadGlobal: '',
  newsLastReadFollowing: '',
  newsLastViewedAt: 0,
  knownNodes: [],
  defaultNodeUrl: '',
  kleverNetwork: 'mainnet',
};

/**
 * Settings that belong to the ACCOUNT, not the install.
 *
 * These are namespaced per account (see `walletScope.ts`). Everything else —
 * language, theme, node URL, font size, currency, window/sidebar layout, push
 * — belongs to the install and stays global, so switching accounts does not
 * reset the user's app preferences.
 *
 * `walletAddress` and `walletSource` are deliberately NOT here. They are the
 * pointer that BOOTSTRAPS the scope: namespacing them to the account they
 * identify is self-referential and unbootstrappable. This looks like an
 * omission, so it is stated explicitly.
 */
const PER_ACCOUNT: ReadonlySet<keyof Settings> = new Set([
  'pinnedChannels',
  'mutedChannels',
  'mutedUsers',
  'lastChannel',
  'newsLastReadGlobal',
  'newsLastReadFollowing',
  'newsLastViewedAt',
  // Registration and E2E binding state are per account: `deviceRegistered`
  // records a wallet-to-device mapping, and a shared `deviceId` would publish
  // ONE identifier for several accounts, publicly linking them (protocol §2.4).
  'deviceRegistered',
  'encKeyBound',
  'deviceId',
] as (keyof Settings)[]);

/** Whether a key is account-scoped rather than install-scoped. */
export function isPerAccountSetting(key: keyof Settings): boolean {
  return PER_ACCOUNT.has(key);
}

/**
 * Resolve a key to its actual storage location.
 *
 * Per-account keys resolve to `<base>::<address>`; with no account active they
 * fall back to the bare key, which after the one-time adoption migration holds
 * nothing.
 */
function storageKey(key: keyof Settings): string {
  const base = `ogmara.${key}`;
  if (!PER_ACCOUNT.has(key)) return base;
  return scopedKey(base) ?? base;
}

/** Load a setting from localStorage with fallback to default. */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  const stored = localStorage.getItem(storageKey(key));
  if (stored === null) return defaults[key];
  try {
    return JSON.parse(stored);
  } catch {
    return stored as unknown as Settings[K];
  }
}

/** Save a setting to localStorage. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  localStorage.setItem(storageKey(key), JSON.stringify(value));
}

// --- Reactive accessors ---
//
// `currentCurrency()` reads a Solid signal that's kept in sync with
// localStorage by `setCurrentCurrency()`. Components reading via this
// accessor re-render when the user changes the display currency in
// Settings, without needing a route remount.
//
// Initial value is whitelist-checked so a hand-edited localStorage
// entry can't slip an unknown ISO code into `Intl.NumberFormat` on
// app launch.
const [currencySignal, setCurrencySignal] = createSignal<string>(
  validateCurrency(getSetting('currency')),
);

export function currentCurrency(): string {
  return currencySignal();
}

export function setCurrentCurrency(value: string): void {
  const safe = validateCurrency(value);
  setSetting('currency', safe);
  setCurrencySignal(safe);
}
