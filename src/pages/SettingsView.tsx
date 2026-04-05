/**
 * SettingsView — desktop-adapted settings page.
 *
 * Differences from web:
 * - Native notifications toggle (Tauri) instead of Web Push
 * - PIN lock management section
 * - Theme customization with color pickers
 * - Wallet source always "Built-in" (no extension/K5)
 */

import { Component, createSignal, createResource, Show } from 'solid-js';
import { t, setLanguage, currentLanguage, SUPPORTED_LANGUAGES } from '../i18n/init';
import { getTheme, setTheme, getCustomTheme, setCustomTheme, clearCustomTheme, type Theme, type CustomTheme } from '../lib/theme';
import { getSetting, setSetting } from '../lib/settings';
import { authStatus, walletAddress } from '../lib/auth';
import { navigate } from '../lib/router';
import { getClient } from '../lib/api';
import { uploadSettings, downloadSettings } from '../lib/settings-sync';
import { vaultExportKey } from '../lib/vault';
import { isLockEnabled, hasPinSetup, removePin, getLockTimeout, setLockTimeout } from '../lib/appLock';
import { vaultDecryptToRaw, vaultIsEncrypted } from '../lib/vault';
import { enableNotifications, disableNotifications } from '../lib/push';
import { PinSetup } from '../PinSetup';

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  ja: '日本語',
  zh: '中文',
  ru: 'Русский',
};

/** Security section — PIN lock setup/removal and auto-lock timeout. */
const PinLockSection: Component = () => {
  const [pinEnabled, setPinEnabled] = createSignal(false);
  const [showSetup, setShowSetup] = createSignal(false);
  const [timeout, setTimeout_] = createSignal(300);
  const [status, setStatus] = createSignal('');

  // Check PIN status on mount
  const [_] = createResource(async () => {
    const enabled = await isLockEnabled();
    setPinEnabled(enabled);
    const t = await getLockTimeout();
    setTimeout_(t);
  });

  return (
    <>
      <div class="settings-row">
        <div>
          <span class="settings-label">{t('settings_app_lock')}</span>
          <p class="settings-desc">{t('settings_app_lock_desc') || 'Encrypt your private key with a PIN and lock the app after inactivity.'}</p>
        </div>
        <Show when={pinEnabled()} fallback={
          <button class="settings-wallet-btn" onClick={() => setShowSetup(true)}>
            {t('pin_prompt_setup') || 'Set Up PIN'}
          </button>
        }>
          <span class="badge-enabled">ON</span>
        </Show>
      </div>

      <Show when={pinEnabled()}>
        <div class="settings-row">
          <span class="settings-label">{t('settings_auto_lock') || 'Auto-lock timeout'}</span>
          <select
            value={timeout()}
            onChange={(e) => {
              const val = parseInt(e.currentTarget.value, 10);
              setTimeout_(val);
              setLockTimeout(val);
            }}
          >
            <option value="60">1 min</option>
            <option value="300">5 min</option>
            <option value="600">10 min</option>
            <option value="1800">30 min</option>
            <option value="3600">1 hour</option>
          </select>
        </div>
        <button
          class="settings-wallet-btn"
          style="color: var(--color-error)"
          onClick={async () => {
            const pin = prompt(t('pin_enter_current') || 'Enter current PIN to remove:');
            if (!pin) return;
            setStatus('');
            try {
              const key = await removePin(pin);
              if (key) {
                await vaultDecryptToRaw(key);
                setPinEnabled(false);
                setStatus(t('pin_removed') || 'PIN removed');
              } else {
                setStatus(t('lock_wrong_pin') || 'Wrong PIN');
              }
            } catch (e: any) {
              setStatus(e?.message || 'Failed');
            }
          }}
        >
          {t('pin_remove') || 'Remove PIN'}
        </button>
        <Show when={status()}>
          <div class="settings-status">{status()}</div>
        </Show>
      </Show>

      <Show when={!pinEnabled()}>
        <div class="settings-warning" style="margin-top: var(--spacing-sm)">
          {t('settings_wallet_warning') || 'Your private key is stored without PIN protection. Anyone with access to this computer can use your wallet.'}
        </div>
      </Show>

      <Show when={showSetup()}>
        <PinSetup
          onComplete={() => {
            setShowSetup(false);
            setPinEnabled(true);
          }}
          onCancel={() => setShowSetup(false)}
        />
      </Show>
    </>
  );
};

export const SettingsView: Component = () => {
  const [theme, setThemeState] = createSignal(getTheme());
  const [lang, setLang] = createSignal(currentLanguage());
  const [nodeUrl, setNodeUrl] = createSignal(getSetting('nodeUrl'));
  const [compact, setCompact] = createSignal(getSetting('compactLayout'));
  const [mediaAutoload, setMediaAutoload] = createSignal(getSetting('mediaAutoload') || 'always');
  const [sounds, setSounds] = createSignal(getSetting('notificationSound'));
  const [notifyEnabled, setNotifyEnabled] = createSignal(getSetting('pushEnabled'));
  const [syncStatus, setSyncStatus] = createSignal('');
  const [exportStatus, setExportStatus] = createSignal('');
  const [customTheme, setCustomThemeState] = createSignal<CustomTheme>(getCustomTheme());

  const handleThemeChange = (value: Theme) => {
    setThemeState(value);
    setTheme(value);
  };

  const handleLangChange = (value: string) => {
    setLang(value);
    setLanguage(value as any);
  };

  const handleColorChange = (key: keyof CustomTheme, value: string) => {
    const updated = { ...customTheme(), [key]: value || undefined };
    setCustomThemeState(updated);
    setCustomTheme(updated);
  };

  return (
    <div class="settings-view">
      <h2>{t('settings_title')}</h2>

      <section class="settings-section">
        <h3>{t('settings_language')}</h3>
        <select
          value={lang()}
          onChange={(e) => handleLangChange(e.currentTarget.value)}
        >
          {SUPPORTED_LANGUAGES.map((code) => (
            <option value={code}>{LANGUAGE_NAMES[code]}</option>
          ))}
        </select>
      </section>

      <section class="settings-section">
        <h3>{t('settings_theme')}</h3>
        <div class="settings-radio-group">
          {(['light', 'dark', 'system'] as Theme[]).map((value) => (
            <label class="settings-radio">
              <input
                type="radio"
                name="theme"
                value={value}
                checked={theme() === value}
                onChange={() => handleThemeChange(value)}
              />
              {t(`settings_theme_${value}`)}
            </label>
          ))}
        </div>
        <label class="settings-toggle">
          <input
            type="checkbox"
            checked={compact()}
            onChange={(e) => {
              setCompact(e.currentTarget.checked);
              setSetting('compactLayout', e.currentTarget.checked);
              document.documentElement.classList.toggle('compact', e.currentTarget.checked);
            }}
          />
          {t('settings_compact')}
        </label>

        {/* Custom colors */}
        <h3 style="margin-top: var(--spacing-md)">{t('settings_custom_colors') || 'Custom Colors'}</h3>
        <div class="settings-color-grid">
          <div class="settings-color-row">
            <label>{t('settings_color_accent') || 'Accent'}</label>
            <input type="color" value={customTheme().accent || '#a29bfe'} onInput={(e) => handleColorChange('accent', e.currentTarget.value)} />
          </div>
          <div class="settings-color-row">
            <label>{t('settings_color_bg') || 'Background'}</label>
            <input type="color" value={customTheme().bgPrimary || '#1a1a2e'} onInput={(e) => handleColorChange('bgPrimary', e.currentTarget.value)} />
          </div>
          <div class="settings-color-row">
            <label>{t('settings_color_bg2') || 'Sidebar'}</label>
            <input type="color" value={customTheme().bgSecondary || '#16213e'} onInput={(e) => handleColorChange('bgSecondary', e.currentTarget.value)} />
          </div>
          <div class="settings-color-row">
            <label>{t('settings_color_text') || 'Text'}</label>
            <input type="color" value={customTheme().textPrimary || '#e0e0e0'} onInput={(e) => handleColorChange('textPrimary', e.currentTarget.value)} />
          </div>
        </div>
        <button class="settings-wallet-btn" style="margin-top: var(--spacing-sm)" onClick={() => { clearCustomTheme(); setCustomThemeState({}); }}>
          {t('settings_reset_colors') || 'Reset to Default'}
        </button>

        <h3 style="margin-top: var(--spacing-md)">{t('settings_media')}</h3>
        <div class="settings-radio-group">
          {(['always', 'never'] as const).map((value) => (
            <label class="settings-radio">
              <input
                type="radio"
                name="mediaAutoload"
                value={value}
                checked={mediaAutoload() === value}
                onChange={() => { setMediaAutoload(value); setSetting('mediaAutoload', value); }}
              />
              {t(`settings_media_${value}`)}
            </label>
          ))}
        </div>
      </section>

      <section class="settings-section">
        <h3>{t('settings_notifications')}</h3>
        <label class="settings-toggle">
          <input
            type="checkbox"
            checked={sounds()}
            onChange={(e) => {
              setSounds(e.currentTarget.checked);
              setSetting('notificationSound', e.currentTarget.checked);
            }}
          />
          {t('settings_sounds')}
        </label>
        <label class="settings-toggle">
          <input
            type="checkbox"
            checked={notifyEnabled()}
            onChange={(e) => {
              const checked = e.currentTarget.checked;
              setNotifyEnabled(checked);
              if (checked) {
                enableNotifications();
              } else {
                disableNotifications();
              }
            }}
          />
          {t('settings_native_notifications')}
        </label>
      </section>

      <Show when={authStatus() === 'ready'}>
        <section class="settings-section">
          <h3>{t('settings_security')}</h3>
          <PinLockSection />
        </section>
      </Show>

      <section class="settings-section">
        <h3>{t('settings_wallet')}</h3>
        <Show
          when={authStatus() === 'ready'}
          fallback={
            <button class="settings-wallet-btn" onClick={() => navigate('/wallet')}>
              {t('wallet_connect')}
            </button>
          }
        >
          <div class="settings-wallet-info">
            <span class="settings-wallet-addr">{walletAddress()?.slice(0, 12)}...{walletAddress()?.slice(-6)}</span>
            <span class="settings-wallet-source">{t('wallet_builtin')}</span>
          </div>
          <div class="settings-wallet-actions">
            <button class="settings-wallet-btn" onClick={() => navigate(`/user/${walletAddress()!}`)}>
              {t('settings_my_profile')}
            </button>
            <button class="settings-wallet-btn" onClick={() => navigate('/wallet')}>
              {t('settings_wallet_settings')}
            </button>
          </div>
        </Show>
      </section>

      <Show when={authStatus() === 'ready'}>
        <section class="settings-section">
          <h3>{t('settings_sync_title')}</h3>
          <div class="settings-sync-row">
            <button
              class="settings-wallet-btn"
              onClick={async () => {
                setSyncStatus('');
                try {
                  const key = await vaultExportKey();
                  if (!key) { setSyncStatus('No key available'); return; }
                  await uploadSettings(key);
                  setSyncStatus(t('settings_sync_success'));
                } catch (e: any) {
                  setSyncStatus(e?.message || 'Sync failed');
                }
              }}
            >
              {t('settings_sync_upload')}
            </button>
            <button
              class="settings-wallet-btn"
              onClick={async () => {
                setSyncStatus('');
                try {
                  const key = await vaultExportKey();
                  if (!key) { setSyncStatus('No key available'); return; }
                  const ok = await downloadSettings(key);
                  if (ok) {
                    setSyncStatus(t('settings_sync_success'));
                    setThemeState(getTheme());
                    setLang(currentLanguage());
                    setCompact(getSetting('compactLayout'));
                    setSounds(getSetting('notificationSound'));
                  } else {
                    setSyncStatus('No synced settings found');
                  }
                } catch (e: any) {
                  setSyncStatus(e?.message || 'Sync failed');
                }
              }}
            >
              {t('settings_sync_download')}
            </button>
          </div>
          <Show when={syncStatus()}>
            <div class="settings-status">{syncStatus()}</div>
          </Show>
        </section>
      </Show>

      <Show when={authStatus() === 'ready'}>
        <section class="settings-section">
          <h3>{t('settings_export_title')}</h3>
          <button
            class="settings-wallet-btn"
            onClick={async () => {
              setExportStatus(t('settings_export_downloading'));
              try {
                const client = getClient();
                const nodeUrl = (client as any).nodeUrl;
                const signer = (client as any).signer;
                const authHeaders = await signer.signRequest('GET', '/api/v1/account/export');
                setExportStatus('Fetching...');
                const { invoke } = await import('@tauri-apps/api/core');
                // Fetch via Rust — Tauri's HTTP plugin can't read large response bodies
                const json = await invoke('fetch_and_save', {
                  url: `${nodeUrl}/api/v1/account/export`,
                  headers: authHeaders,
                }) as string;
                setExportStatus('Saving file...');
                const filename = `ogmara-export-${walletAddress()?.slice(0, 8)}.json`;
                const saved = await invoke('save_export_file', { filename, content: json });
                setExportStatus(saved ? t('settings_export_success') || 'Export saved!' : '');
              } catch (e: any) {
                const url = (client as any)?.nodeUrl || '?';
                setExportStatus(`Error: ${e?.message || e}\nURL: ${url}/api/v1/account/export\nStack: ${e?.stack?.slice(0, 200) || 'none'}`);
              }
            }}
          >
            {t('settings_export_button')}
          </button>
          <Show when={exportStatus()}>
            <div class="settings-status">{exportStatus()}</div>
          </Show>
        </section>
      </Show>

      <section class="settings-section">
        <h3>{t('settings_node_url')}</h3>
        <input
          type="text"
          class="settings-input"
          value={nodeUrl()}
          placeholder="http://localhost:41721"
          onInput={(e) => setNodeUrl(e.currentTarget.value)}
          onBlur={() => setSetting('nodeUrl', nodeUrl())}
        />
      </section>

      <style>{`
        .settings-view { padding: var(--spacing-lg); overflow-y: auto; height: 100%; max-width: 600px; }
        .settings-view h2 { font-size: var(--font-size-xl); margin-bottom: var(--spacing-lg); }
        .settings-section {
          margin-bottom: var(--spacing-lg);
          padding-bottom: var(--spacing-lg);
          border-bottom: 1px solid var(--color-border);
        }
        .settings-section h3 { font-size: var(--font-size-sm); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--spacing-sm); }
        .settings-section select, .settings-input {
          width: 100%;
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-family: inherit;
          -webkit-appearance: none;
          appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%238b8b8b' stroke-width='1.5'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 12px center;
          font-size: var(--font-size-md);
        }
        .settings-radio-group { display: flex; gap: var(--spacing-lg); }
        .settings-radio { display: flex; align-items: center; gap: var(--spacing-xs); font-size: var(--font-size-sm); cursor: pointer; }
        .settings-toggle { display: flex; align-items: center; gap: var(--spacing-sm); font-size: var(--font-size-sm); cursor: pointer; margin-bottom: var(--spacing-sm); }
        .settings-wallet-info { display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm); }
        .settings-wallet-addr { font-family: monospace; font-size: var(--font-size-sm); color: var(--color-accent-primary); }
        .settings-wallet-source { font-size: var(--font-size-xs); color: var(--color-text-secondary); background: var(--color-bg-tertiary); padding: 2px 6px; border-radius: var(--radius-sm); }
        .settings-wallet-actions { display: flex; gap: var(--spacing-sm); }
        .settings-wallet-btn { padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-md); font-weight: 600; font-size: var(--font-size-sm); background: var(--color-bg-tertiary); color: var(--color-text-primary); }
        .settings-wallet-btn:hover { background: var(--color-accent-primary); color: var(--color-text-inverse); }
        .settings-sync-row { display: flex; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm); }
        .settings-status { font-size: var(--font-size-sm); color: var(--color-text-secondary); margin-top: var(--spacing-xs); white-space: pre-wrap; word-break: break-all; }
        .settings-color-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--spacing-sm); }
        .settings-color-row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); }
        .settings-color-row label { font-size: var(--font-size-sm); color: var(--color-text-primary); }
        .settings-color-row input[type="color"] { width: 36px; height: 28px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: none; cursor: pointer; }
      `}</style>
    </div>
  );
};
