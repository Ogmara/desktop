/**
 * Toolbar — custom title bar with window controls for frameless window.
 *
 * Replaces OS window decorations. Draggable for window movement.
 * Contains: hamburger menu, brand, profile/connect, window controls.
 */

import { Component, createEffect, createSignal, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t } from '../i18n/init';
import { navigate, route } from '../lib/router';
import { authStatus, walletAddress } from '../lib/auth';
import { getClient } from '../lib/api';
import { getSetting } from '../lib/settings';
import { resolveProfile, type CachedProfile } from '../lib/profile';

const appWindow = getCurrentWindow();

function windowMinimize() { appWindow.minimize(); }
function windowToggleMaximize() { appWindow.toggleMaximize(); }
function windowClose() { appWindow.close(); }
function windowStartDrag(e: MouseEvent) {
  e.preventDefault();
  appWindow.startDragging();
}

interface ToolbarProps {
  onToggleSidebar: () => void;
}

export const Toolbar: Component<ToolbarProps> = (props) => {
  const [profile, setProfile] = createSignal<CachedProfile>({});

  createEffect(() => {
    const addr = walletAddress();
    if (addr) resolveProfile(addr).then(setProfile);
  });

  const displayName = () => {
    const p = profile();
    const addr = walletAddress();
    if (p.display_name) return p.display_name;
    if (addr) return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
    return '';
  };

  return (
    <header class="toolbar">
      <div class="toolbar-left">
        <button
          class="toolbar-btn"
          onClick={props.onToggleSidebar}
          aria-label={t('sidebar_collapse')}
        >
          ☰
        </button>
        <span class="toolbar-brand" onClick={() => navigate('/news')}>
          <svg class="toolbar-logo" viewBox="0 0 512 512">
            <defs>
              <linearGradient id="tbg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#0f0f1a" />
                <stop offset="100%" stop-color="#1a0f2e" />
              </linearGradient>
              <linearGradient id="tg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#a855f7" />
                <stop offset="50%" stop-color="#6366f1" />
                <stop offset="100%" stop-color="#3b82f6" />
              </linearGradient>
            </defs>
            <rect width="512" height="512" rx="96" fill="url(#tbg)" />
            <circle cx="256" cy="256" r="120" fill="none" stroke="url(#tg)" stroke-width="36" stroke-linecap="round" stroke-dasharray="300 50 200 50" transform="rotate(-30 256 256)" />
            <rect x="236" y="236" width="40" height="40" rx="4" fill="url(#tg)" transform="rotate(45 256 256)" />
          </svg>
          {t('app_name')}
        </span>
      </div>

      {/* Drag handle — fills the entire center area */}
      <div class="toolbar-drag" onMouseDown={windowStartDrag} />

      <div class="toolbar-right">
        <Show
          when={authStatus() === 'ready' && walletAddress()}
          fallback={
            <button class="toolbar-connect" onClick={() => navigate('/wallet')}>
              {t('wallet_connect')}
            </button>
          }
        >
          <button
            class="toolbar-profile"
            onClick={() => navigate(`/user/${walletAddress()}`)}
          >
            <Show when={profile().avatar_cid}>
              <img
                class="toolbar-avatar"
                src={getClient().getMediaUrl(profile().avatar_cid!)}
                alt=""
              />
            </Show>
            <Show when={!profile().avatar_cid}>
              <span class="toolbar-avatar-placeholder">
                {(profile().display_name || walletAddress() || '').slice(0, 2).toUpperCase()}
              </span>
            </Show>
            <span class="toolbar-username">{displayName()}</span>
            <Show when={profile().verified}>
              <span class="toolbar-verified">✓</span>
            </Show>
          </button>
        </Show>

        {/* Window controls */}
        <div class="window-controls">
          <button class="window-ctrl" onClick={windowMinimize} title="Minimize">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect y="9" width="12" height="1.5" rx="0.75" fill="currentColor"/></svg>
          </button>
          <button class="window-ctrl" onClick={windowToggleMaximize} title="Maximize">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
          </button>
          <button class="window-ctrl window-ctrl-close" onClick={windowClose} title="Close">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>

      <style>{`
        .toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 0 0 var(--spacing-md);
          background: var(--color-bg-secondary);
          border-bottom: 1px solid var(--color-border);
          height: 40px;
          flex-shrink: 0;
          user-select: none;
        }
        .toolbar-left { display: flex; align-items: center; gap: var(--spacing-sm); }
        .toolbar-right { display: flex; align-items: center; gap: var(--spacing-xs); }
        .toolbar-drag {
          flex: 1;
          height: 100%;
          cursor: grab;
        }
        .toolbar-drag:active {
          cursor: grabbing;
        }
        .toolbar-brand {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 700;
          font-size: var(--font-size-md);
          color: var(--color-accent-primary);
          cursor: pointer;
        }
        .toolbar-logo {
          width: 22px;
          height: 22px;
          border-radius: 4px;
        }
        .toolbar-btn {
          padding: var(--spacing-xs) var(--spacing-sm);
          border-radius: var(--radius-sm);
          font-size: var(--font-size-sm);
        }
        .toolbar-btn:hover { background: var(--color-bg-tertiary); }
        .toolbar-connect {
          color: var(--color-accent-primary);
          font-weight: 600;
          font-size: var(--font-size-xs);
          padding: var(--spacing-xs) var(--spacing-sm);
          border-radius: var(--radius-sm);
        }
        .toolbar-connect:hover { background: var(--color-bg-tertiary); }
        .toolbar-profile {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: 2px var(--spacing-sm);
          border-radius: var(--radius-sm);
        }
        .toolbar-profile:hover { background: var(--color-bg-tertiary); }
        .toolbar-avatar {
          width: 24px;
          height: 24px;
          border-radius: var(--radius-full);
          object-fit: cover;
        }
        .toolbar-avatar-placeholder {
          width: 24px;
          height: 24px;
          border-radius: var(--radius-full);
          background: var(--color-accent-secondary);
          color: var(--color-text-inverse);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          font-weight: 700;
        }
        .toolbar-username {
          font-size: var(--font-size-xs);
          font-weight: 500;
          max-width: 100px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .toolbar-verified {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          border-radius: var(--radius-full);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          font-size: 9px;
          font-weight: 700;
        }

        /* Window controls */
        .window-controls {
          display: flex;
          align-items: stretch;
          height: 40px;
          margin-left: var(--spacing-sm);
        }
        .window-ctrl {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 46px;
          height: 100%;
          color: var(--color-text-secondary);
          border-radius: 0;
          transition: background 100ms, color 100ms;
        }
        .window-ctrl:hover {
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
        }
        .window-ctrl-close:hover {
          background: #e81123;
          color: white;
        }

        @media (max-width: 768px) {
          .toolbar-brand { font-size: var(--font-size-sm); }
          .toolbar-username { display: none; }
          .window-ctrl { width: 36px; }
        }
      `}</style>
    </header>
  );
};
