/**
 * NotificationsView — user notifications (mentions, replies, follows, DMs).
 */

import { Component, createResource, createSignal, For, Show, onCleanup } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { authStatus } from '../lib/auth';
import { navigate } from '../lib/router';
import type { Notification } from '@ogmara/sdk';

const NOTIFICATION_ICONS: Record<string, string> = {
  mention: '@',
  reply: '↩',
  follow: '👤',
  dm: '💬',
};

export const NotificationsView: Component = () => {
  const [since, setSince] = createSignal<number | undefined>(undefined);

  const [notifications, { refetch }] = createResource(
    () => authStatus() === 'ready',
    async (isReady) => {
      if (!isReady) return [];
      try {
        const client = getClient();
        const resp = await client.getNotifications(since(), 50);
        // Update since cursor to avoid re-fetching all notifications
        if (resp.notifications.length > 0) {
          const latest = Math.max(...resp.notifications.map((n) => n.timestamp));
          setSince(latest);
        }
        return resp.notifications;
      } catch {
        return [];
      }
    },
  );

  // Poll every 30s
  const pollTimer = setInterval(() => {
    if (authStatus() === 'ready') refetch();
  }, 30000);
  onCleanup(() => clearInterval(pollTimer));

  const handleClick = (notif: Notification) => {
    switch (notif.type) {
      case 'mention':
      case 'reply':
        if (notif.channel_id) navigate(`/chat/${notif.channel_id}`);
        else if (notif.msg_id) navigate(`/news/${notif.msg_id}`);
        break;
      case 'follow':
        navigate(`/user/${notif.from}`);
        break;
      case 'dm':
        navigate(`/dm/${notif.from}`);
        break;
    }
  };

  const truncateAddress = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-4)}`;

  return (
    <div class="notifications-view">
      <h2>{t('notifications_title')}</h2>

      <Show when={authStatus() !== 'ready'}>
        <div class="notif-auth-prompt">
          <button onClick={() => navigate('/wallet')}>{t('auth_connect_prompt')}</button>
        </div>
      </Show>

      <Show when={authStatus() === 'ready'}>
        <Show
          when={notifications() && notifications()!.length > 0}
          fallback={<div class="notif-empty">{t('notifications_empty')}</div>}
        >
          <div class="notif-list">
            <For each={notifications()}>
              {(notif) => (
                <div class="notif-item" onClick={() => handleClick(notif)}>
                  <span class="notif-icon">{NOTIFICATION_ICONS[notif.type] || '•'}</span>
                  <div class="notif-content">
                    <span class="notif-from">{truncateAddress(notif.from)}</span>
                    <span class="notif-type">
                      {t(`notifications_${notif.type}` as any)}
                    </span>
                    <Show when={notif.preview}>
                      <span class="notif-preview">{notif.preview}</span>
                    </Show>
                  </div>
                  <span class="notif-time">
                    {new Date(notif.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <style>{`
        .notifications-view { padding: var(--spacing-lg); overflow-y: auto; height: 100%; max-width: 600px; }
        .notifications-view h2 { font-size: var(--font-size-xl); margin-bottom: var(--spacing-lg); }
        .notif-auth-prompt { text-align: center; padding: var(--spacing-xl); color: var(--color-text-secondary); }
        .notif-auth-prompt button { color: var(--color-accent-primary); font-weight: 600; cursor: pointer; }
        .notif-empty { text-align: center; color: var(--color-text-secondary); padding: var(--spacing-xl); }
        .notif-list { display: flex; flex-direction: column; gap: var(--spacing-xs); }
        .notif-item {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm) var(--spacing-md);
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          cursor: pointer;
          transition: background 0.15s;
        }
        .notif-item:hover { background: var(--color-bg-tertiary); }
        .notif-icon {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--color-bg-tertiary);
          border-radius: var(--radius-full);
          font-size: var(--font-size-sm);
          flex-shrink: 0;
        }
        .notif-content {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .notif-from { font-weight: 600; font-size: var(--font-size-sm); color: var(--color-accent-primary); }
        .notif-type { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .notif-preview {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .notif-time { font-size: var(--font-size-xs); color: var(--color-text-secondary); flex-shrink: 0; }
      `}</style>
    </div>
  );
};
