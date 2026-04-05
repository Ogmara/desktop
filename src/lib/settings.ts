/**
 * Local settings storage — persists user preferences to localStorage.
 *
 * Keys and defaults from spec 06-frontend.md section 4.1.
 */

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
