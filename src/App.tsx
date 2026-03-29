import { Component, createSignal, Show, onMount } from 'solid-js';
import { t } from './i18n';

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

export const App: Component = () => {
  const [view, setView] = createSignal<View>('chat');
  const [version, setVersion] = createSignal('0.1.0');
  const [platform, setPlatform] = createSignal('');

  onMount(async () => {
    const v = await invoke<string>('get_version');
    if (v) setVersion(v);
    const p = await invoke<string>('get_platform');
    if (p) setPlatform(p);
  });

  return (
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
          <div class="placeholder">
            <h2>{t('nav_settings')}</h2>
            <p>v{version()} {platform() ? `(${platform()})` : ''}</p>
          </div>
        </Show>
      </main>

      <footer class="status-bar">
        <span class="status-dot connected" />
        <span>{t('status_connected')}</span>
        <span class="version">v{version()}</span>
      </footer>
    </div>
  );
};
