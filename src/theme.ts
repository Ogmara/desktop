/** Theme management — dark default, matches web app. */
export type Theme = 'light' | 'dark' | 'system';
const KEY = 'ogmara.theme';

export function getTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme) || 'dark';
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

export function initTheme(): void {
  applyTheme(getTheme());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'system') applyTheme('system');
  });
}

function applyTheme(theme: Theme): void {
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}
