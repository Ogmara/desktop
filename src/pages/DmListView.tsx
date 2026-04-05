/**
 * DmListView — list of DM conversations.
 */

import { Component, createResource, createSignal, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { authStatus } from '../lib/auth';
import { navigate } from '../lib/router';
import type { DmConversation } from '@ogmara/sdk';

export const DmListView: Component = () => {
  const [newDmAddress, setNewDmAddress] = createSignal('');

  const [conversations] = createResource(
    () => authStatus() === 'ready',
    async (isReady) => {
      if (!isReady) return [];
      try {
        const client = getClient();
        const resp = await client.getDmConversations();
        return resp.conversations;
      } catch {
        return [];
      }
    },
  );

  const handleNewDm = () => {
    const addr = newDmAddress().trim();
    if (addr.startsWith('klv1') && addr.length > 20) {
      navigate(`/dm/${addr}`);
      setNewDmAddress('');
    }
  };

  const truncateAddress = (addr: string) =>
    `${addr.slice(0, 8)}...${addr.slice(-4)}`;

  return (
    <div class="dm-list-view">
      <div class="dm-header">
        <h2>{t('dm_title')}</h2>
      </div>

      <Show when={authStatus() !== 'ready'}>
        <div class="dm-auth-prompt">{t('auth_connect_prompt')}</div>
      </Show>

      <Show when={authStatus() === 'ready'}>
        <div class="dm-new">
          <input
            type="text"
            class="dm-new-input"
            placeholder={t('dm_placeholder')}
            value={newDmAddress()}
            onInput={(e) => setNewDmAddress(e.currentTarget.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleNewDm()}
          />
          <button class="dm-new-btn" onClick={handleNewDm}>
            {t('dm_compose')}
          </button>
        </div>

        <div class="dm-list">
          <Show
            when={conversations() && conversations()!.length > 0}
            fallback={<div class="dm-empty">{t('dm_empty')}</div>}
          >
            <For each={conversations()}>
              {(conv: DmConversation) => (
                <button
                  class="dm-item"
                  onClick={() => navigate(`/dm/${conv.peer}`)}
                >
                  <div class="dm-item-main">
                    <span class="dm-peer">{truncateAddress(conv.peer)}</span>
                    <Show when={conv.last_message_preview}>
                      <span class="dm-preview">{conv.last_message_preview}</span>
                    </Show>
                  </div>
                  <div class="dm-item-meta">
                    <Show when={conv.last_message_at}>
                      <span class="dm-time">
                        {new Date(conv.last_message_at).toLocaleDateString()}
                      </span>
                    </Show>
                    <Show when={conv.unread_count > 0}>
                      <span class="dm-unread">{conv.unread_count}</span>
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <style>{`
        .dm-list-view { padding: var(--spacing-md); overflow-y: auto; height: 100%; }
        .dm-header { margin-bottom: var(--spacing-lg); }
        .dm-header h2 { font-size: var(--font-size-xl); }
        .dm-auth-prompt {
          padding: var(--spacing-lg);
          text-align: center;
          color: var(--color-text-secondary);
          background: var(--color-bg-secondary);
          border-radius: var(--radius-lg);
        }
        .dm-new {
          display: flex;
          gap: var(--spacing-sm);
          margin-bottom: var(--spacing-lg);
        }
        .dm-new-input {
          flex: 1;
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-family: monospace;
          font-size: var(--font-size-sm);
        }
        .dm-new-input:focus { outline: none; border-color: var(--color-accent-primary); }
        .dm-new-btn {
          padding: var(--spacing-sm) var(--spacing-lg);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-sm);
          white-space: nowrap;
        }
        .dm-list { display: flex; flex-direction: column; }
        .dm-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--spacing-md);
          border-bottom: 1px solid var(--color-border);
          width: 100%;
          text-align: left;
        }
        .dm-item:hover { background: var(--color-bg-secondary); }
        .dm-item-main { display: flex; flex-direction: column; gap: var(--spacing-xs); }
        .dm-peer { font-weight: 600; color: var(--color-accent-primary); font-size: var(--font-size-sm); }
        .dm-preview { font-size: var(--font-size-sm); color: var(--color-text-secondary); }
        .dm-item-meta { display: flex; flex-direction: column; align-items: flex-end; gap: var(--spacing-xs); }
        .dm-time { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .dm-unread {
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          font-size: var(--font-size-xs);
          font-weight: 600;
          padding: 2px 6px;
          border-radius: var(--radius-full);
          min-width: 18px;
          text-align: center;
        }
        .dm-empty {
          text-align: center;
          color: var(--color-text-secondary);
          padding: var(--spacing-xl);
        }
      `}</style>
    </div>
  );
};
