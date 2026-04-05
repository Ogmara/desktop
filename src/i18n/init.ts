/**
 * i18n initialization with i18next.
 *
 * 7 languages (spec 06-frontend.md 2.1).
 * Auto-detects browser language, falls back to English.
 */

import i18next from 'i18next';
import { createSignal } from 'solid-js';

import en from './locales/en.json';
import de from './locales/de.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import ja from './locales/ja.json';
import zh from './locales/zh.json';
import ru from './locales/ru.json';

export const SUPPORTED_LANGUAGES = ['en', 'de', 'es', 'pt', 'ja', 'zh', 'ru'] as const;
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

// Reactive signal that increments on language change, forcing SolidJS re-renders.
const [langVersion, setLangVersion] = createSignal(0);

export function initI18n(): void {
  const saved = localStorage.getItem('ogmara.lang');
  const detected = saved && saved !== 'auto'
    ? saved
    : navigator.language.split('-')[0];

  i18next.init({
    lng: SUPPORTED_LANGUAGES.includes(detected as SupportedLanguage) ? detected : 'en',
    fallbackLng: 'en',
    resources: {
      en: { translation: en },
      de: { translation: de },
      es: { translation: es },
      pt: { translation: pt },
      ja: { translation: ja },
      zh: { translation: zh },
      ru: { translation: ru },
    },
    interpolation: {
      escapeValue: false,
    },
  });
}

/**
 * Get a translated string. Reads the reactive langVersion signal so
 * SolidJS components re-render when the language changes.
 */
export function t(key: string, options?: Record<string, unknown>): string {
  langVersion(); // subscribe to language changes
  return i18next.t(key, options) as string;
}

/** Change the current language. */
export function setLanguage(lang: SupportedLanguage): void {
  i18next.changeLanguage(lang);
  localStorage.setItem('ogmara.lang', lang);
  setLangVersion((v) => v + 1); // trigger reactive update
}

/** Get the current language. */
export function currentLanguage(): string {
  langVersion(); // subscribe to language changes
  return i18next.language;
}
