/**
 * App — root component with hash-based routing, lock screen, and auth context.
 *
 * Desktop-specific: includes vault/PIN lock overlay before the main app,
 * uses Tauri window dragging on the toolbar, and listens for the
 * `app-restored` system-tray event to refresh data after the window is
 * brought back from the tray.
 *
 * Modern design (data-style="modern"): the toolbar is hidden in favor of
 * the Modern Sidebar's built-in tabs; the body uses `mobile-nav.ts` for
 * the one-pane sidebar↔detail flip on narrow windows.
 */

import { Component, createSignal, createEffect, Show, Switch, Match, onMount, onCleanup } from 'solid-js';
import { t } from './i18n/init';
import { LockScreen } from './LockScreen';
import { PinSetup } from './PinSetup';
import { vaultMigrationsReady, verifyVaultIntegrity } from './lib/vaultMigration';
import { storeHealth as secureStoreHealth } from './lib/secureStore';
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
  hasPinSetup,
  getLockTimeout,
  startIdleMonitor,
  stopIdleMonitor,
} from './lib/appLock';
import { initAuth, authStatus, walletJustCreated } from './lib/auth';
import { initWs, wsConnected } from './lib/ws';
import { listen } from '@tauri-apps/api/event';
import { mobileListOpen, showMobileList, showMobileDetail, isMobileViewport } from './lib/mobile-nav';
import { isLoading, slowLoading } from './lib/network-activity';
import { isModernStyle } from './lib/theme';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { TxConfirmModal } from './components/TxConfirmModal';
import { WindowControls } from './components/WindowControls';
import { ChatView } from './pages/ChatView';
import { NewsView } from './pages/NewsView';
import { BookmarksView } from './pages/BookmarksView';
import { SettingsView } from './pages/SettingsView';
import { WalletView } from './pages/WalletView';
import { AccountsView } from './pages/AccountsView';
import { AddAccountView } from './pages/AddAccountView';
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
import { NoNodeLandingPage } from './components/NoNodeLandingPage';
import { activeNodeUrl } from './lib/api';
import { ImageLightbox } from './components/ImageLightbox';
import { DialogHost } from './components/Dialogs';
import { route, navigate, goBack } from './lib/router';

type AppState = 'loading' | 'locked' | 'unlocked';

export const App: Component = () => {
  const [appState, setAppState] = createSignal<AppState>('loading');
  const [hasWallet, setHasWallet] = createSignal(false);
  const [lockEnabled, setLockEnabled] = createSignal(false);
  const [showPinSetup, setShowPinSetup] = createSignal(false);
  const [showPinPrompt, setShowPinPrompt] = createSignal(false);

  onMount(async () => {
    await initializeVault();

    // Listen for app restore from tray — reconnect WS + refresh data
    const unlistenPromise = listen('app-restored', () => {
      if (appState() !== 'unlocked') return;
      if (!wsConnected()) {
        startWebSocket();
      }
      window.dispatchEvent(new CustomEvent('ogmara:app-restored'));
    });
    onCleanup(() => { unlistenPromise.then((fn) => fn()); });
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

  /** Set when the secure store has gone read-only; see the banner below. */
  const [storePoisoned, setStorePoisoned] = createSignal(false);

  async function initializeVault() {
    try {
      // The per-account scope must be pointed BEFORE any per-account read,
      // and the adoption migration must run exactly once while no account is
      // active — see `walletScope.runWalletScopeMigrationOnce`. `initAuth`
      // does both; this only has to not race it.
      //
      // Memoized: `initAuth` awaits the same promise, and the two start
      // independently. Running the vault migration twice concurrently against
      // the same key material is not something to leave to timing.
      await vaultMigrationsReady();

      // Checked once at boot. A store that went read-only on load stays that
      // way for the session — restarting is the fix, and the banner says so.
      void secureStoreHealth()
        .then((h) => setStorePoisoned(h.poisoned))
        .catch(() => {});

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

      // `||`, not `&&`. Either flag alone means key material may be sealed:
      // `enablePinLock()` is a separate write after the encryption returns, so
      // a failure between them leaves an encrypted vault with the lock
      // unarmed — which under `&&` booted straight past the lock screen. The
      // lock screen is recoverable (a wrong PIN just fails); walking past an
      // encrypted vault is not obviously so.
      // `lockOn` alone is not enough: with no stored credentials `verifyPin`
      // returns null for EVERY PIN, and the lock screen has no reset — so an
      // armed-but-credential-less flag renders a screen nobody can pass, over
      // a vault that is otherwise fine. An encrypted vault still locks
      // regardless, because booting past sealed key material is the worse
      // failure of the two.
      const pinUsable = await hasPinSetup();
      if (encrypted || (lockOn && pinUsable)) {
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

  // Body class for the mobile one-pane layout. On non-mobile this is just
  // `app-body`; on narrow windows it adds `mobile-list-open` or
  // `mobile-detail-open` so global.css can flip which pane is visible.
  const bodyClass = () => {
    if (!isMobileViewport()) return 'app-body';
    return mobileListOpen() ? 'app-body mobile-list-open' : 'app-body mobile-detail-open';
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
          {/* Modern hides the toolbar in favor of the Modern Sidebar's
              built-in tab bar. Classic + Glassmorphism keep the toolbar. */}
          <Show when={!isModernStyle()}>
            <Toolbar
              onToggleSidebar={() => {
                if (isMobileViewport()) {
                  if (mobileListOpen()) showMobileDetail(); else showMobileList();
                }
              }}
            />
          </Show>

          {/* Modern hides the OS title bar (decorations: false), so we
              render our own slim title-bar strip at the very top of the
              app layout. It owns the drag region and the window
              controls; every view's own header sits below it at the
              same y-offset, giving cross-view consistency without
              padding-right hacks. */}
          <Show when={isModernStyle()}>
            <div class="title-bar" data-tauri-drag-region="">
              <WindowControls />
            </div>
          </Show>
          <style>{`
            /* Global title bar — only rendered on Modern. Spans the full
               window width above the sidebar and main content. Height
               is locked so view headers below always land at the same
               y-offset across routes. */
            .title-bar {
              display: flex;
              align-items: center;
              justify-content: flex-end;
              height: 36px;
              flex-shrink: 0;
              background: var(--color-bg-primary);
              border-bottom: 1px solid var(--color-border);
              -webkit-app-region: drag;
              padding: 0 4px;
            }
            /* On very narrow viewports the Tauri Android/iOS WebView
               doesn't have a real window to control — hide the strip
               and recover the vertical space. */
            @media (max-width: 768px) {
              .title-bar { display: none; }
            }

            .window-controls { display: flex; gap: 0; }
            .window-controls .window-ctrl {
              width: 36px;
              height: 28px;
              display: flex;
              align-items: center;
              justify-content: center;
              color: var(--color-text-secondary);
              border-radius: var(--radius-sm);
              transition: background 0.15s, color 0.15s;
              -webkit-app-region: no-drag;
            }
            .window-controls .window-ctrl:hover {
              background: var(--color-bg-tertiary);
              color: var(--color-text-primary);
            }
            .window-controls .window-ctrl-close:hover {
              background: var(--color-error);
              color: white;
            }
          `}</style>

          {/* A poisoned secure store fails EVERY write, invisibly from the
              webview's point of view: settings appear to save, an added
              account appears in the list, and none of it is on disk. With
              several accounts that is how one gets lost, so it is surfaced
              persistently rather than left to fail quietly. */}
          <Show when={storePoisoned()}>
            <div class="store-warning" role="alert">
              {t('store_poisoned_warning')}
            </div>
          </Show>

          {/* Network activity indicator — animates when API calls are in flight,
              shows a "connecting…" label after 1.2s of slow loading. */}
          <div
            class={`net-bar ${isLoading() ? 'active' : ''} ${slowLoading() ? 'slow' : ''}`}
            role="status"
            aria-live="polite"
          >
            <div class="net-bar-track">
              <div class="net-bar-fill" />
            </div>
            <Show when={slowLoading()}>
              <span class="net-bar-label">{t('status_connecting') || 'Connecting to node…'}</span>
            </Show>
          </div>

          <Show when={activeNodeUrl()} fallback={<NoNodeLandingPage />}>
          <div class={bodyClass()}>
            <Sidebar onNavigate={() => { if (isMobileViewport()) showMobileDetail(); }} />
            <main class="main-content">
              {/* Global mobile back button — Modern style on narrow viewport
                  for views that don't have their own header/back button. */}
              <Show when={isModernStyle() && isMobileViewport() && !mobileListOpen()
                && ['news', 'bookmarks', 'search', 'settings', 'wallet', 'accounts', 'accounts-add', 'token-portfolio', 'notifications', 'compose', 'user', 'follow-list'].includes(route().view)}>
                <div style="display:flex; align-items:center; padding:8px 12px; background:var(--color-bg-secondary); border-bottom:1px solid var(--color-border)">
                  <button style="width:38px; height:38px; border-radius:50%; color:var(--color-text-secondary); display:flex; align-items:center; justify-content:center; cursor:pointer"
                    onClick={() => goBack('/chat')}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
                  </button>
                </div>
              </Show>

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
                <Match when={route().view === 'accounts'}>
                  <AccountsView />
                </Match>
                <Match when={route().view === 'accounts-add'}>
                  <AddAccountView />
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
          </Show>
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

      {/* Global image lightbox */}
      <ImageLightbox />

      {/* Global confirm/prompt modal — replaces window.confirm/window.prompt,
          which are unreliable in the Tauri webview (see components/Dialogs.tsx). */}
      <DialogHost />

      {/* PIN re-prompt for outgoing transactions — shown only when app-lock
          is enabled. Mounted at root so it overlays any route. */}
      <TxConfirmModal />
    </>
  );
};
