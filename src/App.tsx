/**
 * App — root component with hash-based routing, lock screen, and auth context.
 *
 * Desktop-specific: includes vault/PIN lock overlay before the main app,
 * and uses Tauri window dragging on the toolbar.
 */

import { Component, createSignal, createEffect, Show, Switch, Match, onMount, onCleanup } from 'solid-js';
import { t } from './i18n/init';
import { LockScreen } from './LockScreen';
import { PinSetup } from './PinSetup';
import { runVaultMigrations, verifyVaultIntegrity } from './lib/vaultMigration';
import {
  vaultHasWallet,
  vaultIsEncrypted,
  vaultGetAddress,
  vaultIsUnlocked,
  vaultLock,
  vaultInit,
  vaultGetSigner,
} from './lib/vault';
import {
  isLockEnabled,
  getLockTimeout,
  startIdleMonitor,
  stopIdleMonitor,
} from './lib/appLock';
import { initAuth, authStatus, walletJustCreated } from './lib/auth';
import { initWs } from './lib/ws';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { ChatView } from './pages/ChatView';
import { NewsView } from './pages/NewsView';
import { BookmarksView } from './pages/BookmarksView';
import { SettingsView } from './pages/SettingsView';
import { WalletView } from './pages/WalletView';
import { TokenPortfolioView } from './pages/TokenPortfolioView';
import { ComposeView } from './pages/ComposeView';
import { DmListView } from './pages/DmListView';
import { DmConversationView } from './pages/DmConversationView';
import { UserProfileView } from './pages/UserProfileView';
import { SearchView } from './pages/SearchView';
import { NewsDetailView } from './pages/NewsDetailView';
import { ChannelCreateView } from './pages/ChannelCreateView';
import { ChannelSettingsView } from './pages/ChannelSettingsView';
import { ChannelJoinView } from './pages/ChannelJoinView';
import { NotificationsView } from './pages/NotificationsView';
import { FollowListView } from './pages/FollowListView';
import { StatusBar } from './components/StatusBar';
import { route, navigate } from './lib/router';

const isMobile = () => window.innerWidth <= 768;

type AppState = 'loading' | 'locked' | 'unlocked';

export const App: Component = () => {
  const [appState, setAppState] = createSignal<AppState>('loading');
  const [hasWallet, setHasWallet] = createSignal(false);
  const [lockEnabled, setLockEnabled] = createSignal(false);
  const [showPinSetup, setShowPinSetup] = createSignal(false);
  const [showPinPrompt, setShowPinPrompt] = createSignal(false);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(isMobile());

  onMount(async () => {
    await initializeVault();
  });

  onCleanup(() => {
    stopIdleMonitor();
  });

  // Watch for new wallet creation — prompt user to set up PIN
  // Only show after auth is fully ready (wallet stored + signer loaded)
  createEffect(() => {
    if (walletJustCreated() && authStatus() === 'ready' && !lockEnabled()) {
      // Small delay to let the UI settle after wallet creation
      setTimeout(() => setShowPinPrompt(true), 500);
    }
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
        // No wallet — start WebSocket (unauthenticated) and go to app
        startWebSocket();
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

      // Vault is in raw mode — initialize auth + WebSocket
      await initAuth();
      startWebSocket();
      await setupAutoLock();
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
      setAppState('locked');
    });
  }

  async function handleUnlock() {
    await initAuth();
    startWebSocket();
    setAppState('unlocked');
    await setupAutoLock();
  }

  function startWebSocket() {
    const signer = vaultGetSigner();
    initWs(signer ?? undefined);
  }

  async function handlePinSetupComplete() {
    setShowPinSetup(false);
    setShowPinPrompt(false);
    setLockEnabled(true);
    setHasWallet(true);
    await setupAutoLock();
    // If wallet was just created, navigate to the news feed
    if (walletJustCreated()) {
      navigate('/news');
    }
  }

  const channelId = () => {
    const r = route();
    if (r.view === 'chat' && r.params.channelId) {
      const parsed = parseInt(r.params.channelId, 10);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  };

  return (
    <>
      {/* Loading screen */}
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

      {/* Lock screen */}
      <Show when={appState() === 'locked'}>
        <LockScreen onUnlock={handleUnlock} />
      </Show>

      {/* Main app */}
      <Show when={appState() === 'unlocked'}>
        <div class="app-layout">
          <Toolbar
            onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed())}
          />
          <div class="app-body">
            <Show when={!sidebarCollapsed()}>
              <Sidebar onNavigate={() => { if (isMobile()) setSidebarCollapsed(true); }} />
            </Show>
            <main class="main-content">
              <Switch>
                <Match when={route().view === 'chat'}>
                  <ChatView channelId={channelId()} />
                </Match>
                <Match when={route().view === 'news'}>
                  <NewsView />
                </Match>
                <Match when={route().view === 'news-detail'}>
                  <NewsDetailView />
                </Match>
                <Match when={route().view === 'compose'}>
                  <ComposeView />
                </Match>
                <Match when={route().view === 'bookmarks'}>
                  <BookmarksView />
                </Match>
                <Match when={route().view === 'settings'}>
                  <SettingsView />
                </Match>
                <Match when={route().view === 'wallet'}>
                  <WalletView />
                </Match>
                <Match when={route().view === 'token-portfolio'}>
                  <TokenPortfolioView />
                </Match>
                <Match when={route().view === 'dm'}>
                  <DmListView />
                </Match>
                <Match when={route().view === 'dm-conversation'}>
                  <DmConversationView peerAddress={route().params.address} />
                </Match>
                <Match when={route().view === 'user'}>
                  <UserProfileView address={route().params.address} />
                </Match>
                <Match when={route().view === 'follow-list'}>
                  <FollowListView address={route().params.address} tab={route().params.tab as 'followers' | 'following'} />
                </Match>
                <Match when={route().view === 'search'}>
                  <SearchView />
                </Match>
                <Match when={route().view === 'channel-create'}>
                  <ChannelCreateView />
                </Match>
                <Match when={route().view === 'channel-settings'}>
                  <ChannelSettingsView channelId={route().params.channelId} />
                </Match>
                <Match when={route().view === 'channel-join'}>
                  <ChannelJoinView channelId={route().params.channelId} />
                </Match>
                <Match when={route().view === 'notifications'}>
                  <NotificationsView />
                </Match>
                {/* Fallback — redirect unknown routes to news feed */}
                <Match when={true}>
                  <NewsView />
                </Match>
              </Switch>
            </main>
          </div>
          <StatusBar />
        </div>

        <Show when={showPinSetup()}>
          <PinSetup
            onComplete={handlePinSetupComplete}
            onCancel={() => setShowPinSetup(false)}
          />
        </Show>

        {/* PIN setup recommendation after wallet creation */}
        <Show when={showPinPrompt() && !showPinSetup()}>
          <div class="pin-prompt-overlay">
            <div class="pin-prompt-card">
              <svg class="pin-prompt-icon" viewBox="0 0 24 24" width="48" height="48">
                <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3-9H9V6c0-1.66 1.34-3 3-3s3 1.34 3 3v2z" fill="currentColor"/>
              </svg>
              <h2>{t('pin_prompt_title') || 'Secure Your Wallet'}</h2>
              <p class="pin-prompt-desc">
                {t('pin_prompt_desc') || 'Your private key is stored unprotected. Setting up a PIN encrypts your key with AES-256 and locks the app after inactivity.'}
              </p>
              <p class="pin-prompt-recommend">
                {t('pin_prompt_recommend') || 'We strongly recommend setting up a PIN now.'}
              </p>
              <div class="pin-prompt-actions">
                <button class="btn-primary" onClick={() => {
                  setShowPinPrompt(false);
                  setShowPinSetup(true);
                }}>
                  {t('pin_prompt_setup') || 'Set Up PIN'}
                </button>
                <button class="btn-secondary" onClick={() => {
                  setShowPinPrompt(false);
                  navigate('/news');
                }}>
                  {t('pin_prompt_later') || 'Maybe Later'}
                </button>
              </div>
            </div>
          </div>

          <style>{`
            .pin-prompt-overlay {
              position: fixed; inset: 0;
              background: rgba(0,0,0,0.7); backdrop-filter: blur(6px);
              display: flex; align-items: center; justify-content: center;
              z-index: 200;
            }
            .pin-prompt-card {
              background: var(--color-bg-secondary);
              border: 1px solid var(--color-border);
              border-radius: var(--radius-lg);
              padding: 40px; max-width: 420px; width: 90%;
              display: flex; flex-direction: column; align-items: center;
              gap: var(--spacing-md); text-align: center;
            }
            .pin-prompt-icon { color: var(--color-warning); }
            .pin-prompt-card h2 { font-size: var(--font-size-xl); color: var(--color-text-primary); }
            .pin-prompt-desc { font-size: var(--font-size-sm); color: var(--color-text-secondary); line-height: 1.6; }
            .pin-prompt-recommend { font-size: var(--font-size-sm); color: var(--color-warning); font-weight: 600; }
            .pin-prompt-actions { display: flex; gap: var(--spacing-md); margin-top: var(--spacing-sm); }
          `}</style>
        </Show>
      </Show>
    </>
  );
};
