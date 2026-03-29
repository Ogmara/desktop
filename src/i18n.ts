/** Minimal i18n — same keys as web app, inlined for desktop. */
import i18next from 'i18next';

const en = {
  nav_chat: 'Chat', nav_news: 'News', nav_settings: 'Settings',
  chat_no_channel: 'Select a channel to start chatting',
  news_no_posts: 'No posts yet',
  status_connected: 'Connected', status_disconnected: 'Disconnected',
};

const de = {
  nav_chat: 'Chat', nav_news: 'Neuigkeiten', nav_settings: 'Einstellungen',
  chat_no_channel: 'Wähle einen Kanal zum Chatten',
  news_no_posts: 'Noch keine Beiträge',
  status_connected: 'Verbunden', status_disconnected: 'Getrennt',
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
