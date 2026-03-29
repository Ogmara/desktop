import { Component, createSignal, Show, onMount, onCleanup } from 'solid-js';
import { t } from './i18n';
import { LockScreen } from './LockScreen';
import { PinSetup } from './PinSetup';
import { runVaultMigrations, verifyVaultIntegrity } from './lib/vaultMigration';
import {
  vaultInit,
  vaultHasWallet,
  vaultIsEncrypted,
  vaultGetAddress,
  vaultIsUnlocked,
  vaultLock,
} from './lib/vault';
import {
  isLockEnabled,
  getLockTimeout,
  startIdleMonitor,
  stopIdleMonitor,
} from './lib/appLock';

/** Invoke a Tauri command (safe no-op when running in browser). */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    if ((window as any).__TAURI_INTERNALS__) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<T>(cmd, args);
    }
  } catch {}
  return null;
}

type View = 'chat' | 'news' | 'settings';
type AppState = 'loading' | 'locked' | 'unlocked' | 'pin_setup';

export const App: Component = () => {
  const [view, setView] = createSignal<View>('chat');
  const [version, setVersion] = createSignal('0.2.0');
  const [platform, setPlatform] = createSignal('');
  const [appState, setAppState] = createSignal<AppState>('loading');
  const [walletAddress, setWalletAddress] = createSignal<string | null>(null);
  const [hasWallet, setHasWallet] = createSignal(false);
  const [lockEnabled, setLockEnabled] = createSignal(false);
  const [showPinSetup, setShowPinSetup] = createSignal(false);

  onMount(async () => {
    // Fetch app info
    const v = await invoke<string>('get_version');
    if (v) setVersion(v);
    const p = await invoke<string>('get_platform');
    if (p) setPlatform(p);

    // Initialize vault
    await initializeVault();
  });

  onCleanup(() => {
    stopIdleMonitor();
  });

  async function initializeVault() {
    try {
      // Run migrations first (safe on every launch)
      await runVaultMigrations();

      // Verify integrity
      const integrity = await verifyVaultIntegrity();
      if (integrity.hasWallet && !integrity.healthy) {
        console.warn('Vault integrity check failed:', integrity);
      }

      const wallet = await vaultHasWallet();
      setHasWallet(wallet);

      if (!wallet) {
        // No wallet — go straight to app (unlocked, no vault to protect)
        setAppState('unlocked');
        return;
      }

      const encrypted = await vaultIsEncrypted();
      const lockOn = await isLockEnabled();
      setLockEnabled(lockOn);

      if (encrypted && lockOn) {
        // Vault is encrypted — show lock screen
        setAppState('locked');
        return;
      }

      // Vault is in raw mode — initialize directly
      const address = await vaultInit();
      if (address) {
        setWalletAddress(address);
        await setupAutoLock();
      }
      setAppState('unlocked');
    } catch (e) {
      console.error('Vault initialization failed:', e);
      setAppState('unlocked');
    }
  }

  async function setupAutoLock() {
    const lockOn = await isLockEnabled();
    if (!lockOn) return;

    const timeout = await getLockTimeout();
    startIdleMonitor(timeout, () => {
      vaultLock();
      setWalletAddress(null);
      setAppState('locked');
    });
  }

  async function handleUnlock() {
    setWalletAddress(vaultGetAddress());
    setAppState('unlocked');
    await setupAutoLock();
  }

  async function handlePinSetupComplete() {
    setShowPinSetup(false);
    setLockEnabled(true);
    await setupAutoLock();
  }

  return (
    <>
      <Show when={appState() === 'loading'}>
        <div class="lock-screen">
          <div class="lock-card">
            <svg class="lock-logo spin" viewBox="0 0 512 512">
              <defs>
                <linearGradient id="sbg" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#0f0f1a" />
                  <stop offset="100%" stop-color="#1a0f2e" />
                </linearGradient>
                <linearGradient id="sg" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#a855f7" />
                  <stop offset="50%" stop-color="#6366f1" />
                  <stop offset="100%" stop-color="#3b82f6" />
                </linearGradient>
              </defs>
              <rect width="512" height="512" rx="96" fill="url(#sbg)" />
              <circle cx="256" cy="256" r="120" fill="none" stroke="url(#sg)" stroke-width="36" stroke-linecap="round" stroke-dasharray="300 50 200 50" transform="rotate(-30 256 256)" />
            </svg>
          </div>
        </div>
      </Show>

      <Show when={appState() === 'locked'}>
        <LockScreen onUnlock={handleUnlock} />
      </Show>

      <Show when={appState() === 'unlocked'}>
        <div class="app">
          <header class="toolbar">
            <div class="toolbar-brand">
              <svg class="logo-svg" viewBox="0 0 512 512"><defs><linearGradient id="bg3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0f0f1a"/><stop offset="100%" stop-color="#1a0f2e"/></linearGradient><linearGradient id="g3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#a855f7"/><stop offset="50%" stop-color="#6366f1"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient></defs><rect width="512" height="512" rx="96" fill="url(#bg3)"/><circle cx="256" cy="256" r="120" fill="none" stroke="url(#g3)" stroke-width="36" stroke-linecap="round" stroke-dasharray="300 50 200 50" transform="rotate(-30 256 256)"/><rect x="236" y="236" width="40" height="40" rx="4" fill="url(#g3)" transform="rotate(45 256 256)"/></svg>
              <span>Ogmara</span>
            </div>
            <nav class="toolbar-nav">
              <button class={view() === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>{t('nav_chat')}</button>
              <button class={view() === 'news' ? 'active' : ''} onClick={() => setView('news')}>{t('nav_news')}</button>
              <button class={view() === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>{t('nav_settings')}</button>
            </nav>
          </header>

          <main class="content">
            <Show when={view() === 'chat'}>
              <div class="placeholder">
                <h2>{t('nav_chat')}</h2>
                <p>{t('chat_no_channel')}</p>
              </div>
            </Show>
            <Show when={view() === 'news'}>
              <div class="placeholder">
                <h2>{t('nav_news')}</h2>
                <p>{t('news_no_posts')}</p>
              </div>
            </Show>
            <Show when={view() === 'settings'}>
              <div class="settings-view">
                <h2>{t('nav_settings')}</h2>
                <div class="settings-section">
                  <h3>{t('settings_wallet')}</h3>
                  <Show when={hasWallet()} fallback={
                    <p class="settings-info">{t('settings_no_wallet')}</p>
                  }>
                    <div class="settings-row">
                      <span class="settings-label">{t('settings_wallet_address')}</span>
                      <code class="settings-value">{walletAddress() ?? '(locked)'}</code>
                    </div>
                    <Show when={hasWallet() && !lockEnabled()}>
                      <p class="settings-warning">{t('settings_wallet_warning')}</p>
                    </Show>
                  </Show>
                </div>

                <Show when={hasWallet()}>
                  <div class="settings-section">
                    <h3>{t('settings_security')}</h3>
                    <div class="settings-row">
                      <div>
                        <span class="settings-label">{t('settings_app_lock')}</span>
                        <p class="settings-desc">{t('settings_app_lock_desc')}</p>
                      </div>
                      <Show when={lockEnabled()} fallback={
                        <button class="btn-secondary" onClick={() => setShowPinSetup(true)}>
                          {t('pin_setup_save')}
                        </button>
                      }>
                        <span class="badge-enabled">ON</span>
                      </Show>
                    </div>
                  </div>
                </Show>

                <div class="settings-section">
                  <p class="settings-info">v{version()} {platform() ? `(${platform()})` : ''}</p>
                </div>
              </div>
            </Show>
          </main>

          <footer class="status-bar">
            <span class="status-dot connected" />
            <span>{t('status_connected')}</span>
            <Show when={walletAddress()}>
              <span class="wallet-badge" title={walletAddress()!}>
                {walletAddress()!.slice(0, 10)}...
              </span>
            </Show>
            <span class="version">v{version()}</span>
          </footer>
        </div>

        <Show when={showPinSetup()}>
          <PinSetup
            onComplete={handlePinSetupComplete}
            onCancel={() => setShowPinSetup(false)}
          />
        </Show>
      </Show>
    </>
  );
};
