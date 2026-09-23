/**
 * DmListView — list of DM conversations.
 */

import { Component, createEffect, createResource, createSignal, untrack, For, Show, onMount, onCleanup } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { authStatus } from '../lib/auth';
import { navigate } from '../lib/router';
import { resolveProfile, type CachedProfile } from '../lib/profile';
import type { DmConversation } from '@ogmara/sdk';

export const DmListView: Component = () => {
  const [newDmAddress, setNewDmAddress] = createSignal('');

  const [conversations, { refetch: refetchConversations }] = createResource(
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

  // This view never resolved peer display names at all (always showed the
  // raw address) — same bug class as Sidebar.tsx's DM list. Guarded on "no
  // display_name yet" rather than "key not yet in the map" so a transient/
  // empty lookup retries the next time this effect runs instead of
  // sticking forever.
  //
  // `memberProfiles()` is read via `untrack` DELIBERATELY (re-audit
  // finding on the Sidebar.tsx twin of this code — same fix applies here):
  // reading it directly inside the effect made the effect subscribe to its
  // own write. `setMemberProfiles` always produces a new Map reference, so
  // for any peer that resolves to "still no display_name" (a never-
  // registered wallet, or a transient fetch failure — both common) that
  // was a synchronous, self-retriggering loop that hard-froze the app
  // (measured on the Sidebar.tsx twin at ~2.3M calls/sec with the render
  // thread never yielding, not even to `setTimeout`). `untrack` makes this
  // effect re-run only when `conversations()` itself changes (on refetch),
  // which still retries stale lookups periodically without the loop.
  const [memberProfiles, setMemberProfiles] = createSignal<Map<string, CachedProfile>>(new Map());
  createEffect(() => {
    for (const conv of conversations() ?? []) {
      if (!untrack(() => memberProfiles().get(conv.peer)?.display_name)) {
        resolveProfile(conv.peer).then((p) => {
          setMemberProfiles((prev) => { const next = new Map(prev); next.set(conv.peer, p); return next; });
        });
      }
    }
  });

  // The list otherwise loads once (on auth) and never refreshes, so new
  // conversations and updated previews/unread don't appear. Poll periodically.
  let listPollTimer: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    listPollTimer = setInterval(() => {
      if (authStatus() === 'ready') refetchConversations();
    }, 12000);
  });
  onCleanup(() => { if (listPollTimer) clearInterval(listPollTimer); });

  const handleNewDm = () => {
    const addr = newDmAddress().trim();
    if (addr.startsWith('klv1') && addr.length > 20) {
      navigate(`/dm/${addr}`);
      setNewDmAddress('');
    }
  };

  const truncateAddress = (addr: string) =>
    `${addr.slice(0, 8)}...${addr.slice(-4)}`;
  const peerLabel = (addr: string) => memberProfiles().get(addr)?.display_name || truncateAddress(addr);

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
                    <span class="dm-peer">{peerLabel(conv.peer)}</span>
                    <Show when={conv.last_message_preview || conv.last_message_at}>
                      <span class="dm-preview">{conv.last_message_preview || `🔒 ${t('dm_encrypted_preview')}`}</span>
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
