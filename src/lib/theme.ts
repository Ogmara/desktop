/**
 * Theme management — dark/light/system with custom color overrides and design styles.
 *
 * Applied before first paint to prevent flash (spec 06-frontend.md 3.3).
 * Desktop extends the web theme with user-customizable accent and background colors.
 *
 * Design styles control the visual language (shapes, shadows, effects) independently
 * from the color theme (light/dark). Available styles:
 * - classic: Original flat design
 * - glassmorphism: Frosted glass panels, gradient background, glow accents
 * - elevated: Layered shadows, bold radius, clear depth hierarchy
 * - minimal: Pill shapes, tight palette, content-first
 */

export type Theme = 'light' | 'dark' | 'system';
export type DesignStyle = 'classic' | 'glassmorphism' | 'elevated' | 'minimal';

export const DESIGN_STYLES: DesignStyle[] = ['glassmorphism', 'elevated', 'minimal', 'classic'];

const STORAGE_KEY = 'ogmara.theme';
const CUSTOM_THEME_KEY = 'ogmara.customTheme';
const STYLE_KEY = 'ogmara.designStyle';

/** Customizable color tokens — user can override these in Settings. */
export interface CustomTheme {
  /** Primary accent color (buttons, links, active states) */
  accent?: string;
  /** Secondary accent / hover variant */
  accentHover?: string;
  /** Main background color */
  bgPrimary?: string;
  /** Secondary background (sidebar, cards) */
  bgSecondary?: string;
  /** Tertiary background (inputs, hover states) */
  bgTertiary?: string;
  /** Primary text color */
  textPrimary?: string;
  /** Secondary/muted text color */
  textSecondary?: string;
}

/** CSS variable names mapped to CustomTheme keys. */
const TOKEN_MAP: Record<keyof CustomTheme, string> = {
  accent: '--color-accent',
  accentHover: '--color-accent-hover',
  bgPrimary: '--color-bg-primary',
  bgSecondary: '--color-bg-secondary',
  bgTertiary: '--color-bg-tertiary',
  textPrimary: '--color-text-primary',
  textSecondary: '--color-text-secondary',
};

/** Get the current design style (validated against known values). */
export function getDesignStyle(): DesignStyle {
  const stored = localStorage.getItem(STYLE_KEY);
  if (stored && DESIGN_STYLES.includes(stored as DesignStyle)) {
    return stored as DesignStyle;
  }
  return 'glassmorphism';
}

/** Set the design style and apply it. */
export function setDesignStyle(style: DesignStyle): void {
  localStorage.setItem(STYLE_KEY, style);
  applyDesignStyle(style);
}

/** Get the current theme preference. */
export function getTheme(): Theme {
  return (localStorage.getItem(STORAGE_KEY) as Theme) || 'system';
}

/** Set the theme preference and apply it. */
export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

/** Get the saved custom color overrides. */
export function getCustomTheme(): CustomTheme {
  try {
    const stored = localStorage.getItem(CUSTOM_THEME_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore corrupt data */ }
  return {};
}

/** Save and apply custom color overrides. */
export function setCustomTheme(custom: CustomTheme): void {
  localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(custom));
  applyCustomColors(custom);
}

/** Clear all custom colors (revert to theme defaults). */
export function clearCustomTheme(): void {
  localStorage.removeItem(CUSTOM_THEME_KEY);
  // Remove any inline overrides
  const root = document.documentElement;
  for (const varName of Object.values(TOKEN_MAP)) {
    root.style.removeProperty(varName);
  }
}

/** Apply the theme to the document (called before first paint). */
export function initTheme(): void {
  applyTheme(getTheme());
  applyCustomColors(getCustomTheme());
  applyDesignStyle(getDesignStyle());

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'system') {
      applyTheme('system');
    }
  });
}

function applyTheme(theme: Theme): void {
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

/** Apply the design style as a data attribute on <html>. */
function applyDesignStyle(style: DesignStyle): void {
  if (style === 'classic') {
    document.documentElement.removeAttribute('data-style');
  } else {
    document.documentElement.setAttribute('data-style', style);
  }
}

/** Apply custom color overrides as inline CSS variables on :root. */
function applyCustomColors(custom: CustomTheme): void {
  const root = document.documentElement;
  for (const [key, varName] of Object.entries(TOKEN_MAP)) {
    const value = custom[key as keyof CustomTheme];
    if (value) {
      root.style.setProperty(varName, value);
    } else {
      root.style.removeProperty(varName);
    }
  }
}
