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
import { validateCurrency } from './sanitize';

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
  pushGatewayUrl: '',
  defaultLandingView: 'news',
  currency: 'usd',
  defaultFeed: 'global',
};

/** Load a setting from localStorage with fallback to default. */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  const stored = localStorage.getItem(`ogmara.${key}`);
  if (stored === null) return defaults[key];
  try {
    return JSON.parse(stored);
  } catch {
    return stored as unknown as Settings[K];
  }
}

/** Save a setting to localStorage. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  localStorage.setItem(`ogmara.${key}`, JSON.stringify(value));
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
