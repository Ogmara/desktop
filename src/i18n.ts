/** Minimal i18n — same keys as web app, inlined for desktop. */
import i18next from 'i18next';

const en = {
  nav_chat: 'Chat', nav_news: 'News', nav_settings: 'Settings',
  chat_no_channel: 'Select a channel to start chatting',
  news_no_posts: 'No posts yet',
  status_connected: 'Connected', status_disconnected: 'Disconnected',
  // Lock screen
  lock_title: 'Ogmara is Locked',
  lock_enter_pin: 'Enter your PIN to unlock',
  lock_unlock: 'Unlock',
  lock_wrong_pin: 'Incorrect PIN',
  lock_cooldown: 'Too many attempts. Try again in {{seconds}}s',
  lock_forgot: 'Forgot PIN?',
  // PIN setup
  pin_setup_title: 'Set Up App Lock',
  pin_setup_desc: 'Create a 6-digit PIN to protect your wallet',
  pin_setup_enter: 'Enter PIN',
  pin_setup_confirm: 'Confirm PIN',
  pin_setup_mismatch: 'PINs do not match',
  pin_setup_save: 'Enable App Lock',
  pin_setup_cancel: 'Cancel',
  pin_setup_success: 'App lock enabled',
  // Settings security section
  settings_security: 'Security',
  settings_app_lock: 'App Lock (PIN)',
  settings_app_lock_desc: 'Protect your wallet with a PIN code',
  settings_auto_lock: 'Auto-lock timeout',
  settings_auto_lock_minutes: '{{minutes}} minutes',
  settings_remove_pin: 'Remove PIN',
  settings_remove_pin_confirm: 'Enter current PIN to disable app lock',
  settings_change_pin: 'Change PIN',
  // Wallet
  settings_wallet: 'Wallet',
  settings_no_wallet: 'No wallet configured',
  settings_wallet_address: 'Address',
  settings_wallet_warning: 'Your wallet is not protected. Anyone with access to this device can use your Ogmara account and funds.',
  // Engagement
  news_like: 'Like', news_dislike: 'Dislike', news_repost: 'Repost',
  news_reposted: 'Reposted', news_bookmark: 'Bookmark', news_bookmarked: 'Saved',
  news_reactions: 'Reactions', bookmarks_title: 'Bookmarks', bookmarks_empty: 'No saved posts',
  nav_bookmarks: 'Bookmarks',
  // Channel admin
  channel_members: 'Members', channel_pins: 'Pinned', channel_admin: 'Admin',
  channel_moderators: 'Moderators', channel_kick: 'Kick', channel_ban: 'Ban',
  channel_unban: 'Unban', channel_pin: 'Pin', channel_unpin: 'Unpin',
  channel_invite: 'Invite', channel_reply_to: 'Replying to',
  node_add_custom: 'Add custom node URL', node_selector: 'Node',
};

const de = {
  nav_chat: 'Chat', nav_news: 'Neuigkeiten', nav_settings: 'Einstellungen',
  chat_no_channel: 'Wähle einen Kanal zum Chatten',
  news_no_posts: 'Noch keine Beiträge',
  status_connected: 'Verbunden', status_disconnected: 'Getrennt',
  // Lock screen
  lock_title: 'Ogmara ist gesperrt',
  lock_enter_pin: 'PIN eingeben zum Entsperren',
  lock_unlock: 'Entsperren',
  lock_wrong_pin: 'Falscher PIN',
  lock_cooldown: 'Zu viele Versuche. Erneut versuchen in {{seconds}}s',
  lock_forgot: 'PIN vergessen?',
  // PIN setup
  pin_setup_title: 'App-Sperre einrichten',
  pin_setup_desc: 'Erstelle eine 6-stellige PIN zum Schutz deiner Wallet',
  pin_setup_enter: 'PIN eingeben',
  pin_setup_confirm: 'PIN bestätigen',
  pin_setup_mismatch: 'PINs stimmen nicht überein',
  pin_setup_save: 'App-Sperre aktivieren',
  pin_setup_cancel: 'Abbrechen',
  pin_setup_success: 'App-Sperre aktiviert',
  // Settings security section
  settings_security: 'Sicherheit',
  settings_app_lock: 'App-Sperre (PIN)',
  settings_app_lock_desc: 'Schütze deine Wallet mit einem PIN-Code',
  settings_auto_lock: 'Automatische Sperre',
  settings_auto_lock_minutes: '{{minutes}} Minuten',
  settings_remove_pin: 'PIN entfernen',
  settings_remove_pin_confirm: 'Aktuellen PIN eingeben um App-Sperre zu deaktivieren',
  settings_change_pin: 'PIN ändern',
  // Wallet
  settings_wallet: 'Wallet',
  settings_no_wallet: 'Keine Wallet konfiguriert',
  settings_wallet_address: 'Adresse',
  settings_wallet_warning: 'Deine Wallet ist nicht geschützt. Jeder mit Zugang zu diesem Gerät kann dein Ogmara-Konto und Guthaben verwenden.',
  // Engagement
  news_like: 'Gefällt mir', news_dislike: 'Gefällt mir nicht', news_repost: 'Teilen',
  news_reposted: 'Geteilt', news_bookmark: 'Lesezeichen', news_bookmarked: 'Gespeichert',
  news_reactions: 'Reaktionen', bookmarks_title: 'Lesezeichen', bookmarks_empty: 'Keine gespeicherten Beiträge',
  nav_bookmarks: 'Lesezeichen',
  // Channel admin
  channel_members: 'Mitglieder', channel_pins: 'Angepinnt', channel_admin: 'Admin',
  channel_moderators: 'Moderatoren', channel_kick: 'Rauswerfen', channel_ban: 'Sperren',
  channel_unban: 'Entsperren', channel_pin: 'Anpinnen', channel_unpin: 'Lösen',
  channel_invite: 'Einladen', channel_reply_to: 'Antwort auf',
  node_add_custom: 'Eigene Node-URL hinzufügen', node_selector: 'Node',
};

export function initI18n(): void {
  const lang = localStorage.getItem('ogmara.lang') || navigator.language.split('-')[0];
  i18next.init({
    lng: ['en', 'de'].includes(lang) ? lang : 'en',
    fallbackLng: 'en',
    resources: {
      en: { translation: en },
      de: { translation: de },
    },
  });
}

export function t(key: string): string {
  return i18next.t(key) as string;
}
