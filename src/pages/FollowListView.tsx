/**
 * FollowListView — followers/following list with profile resolution and unfollow.
 */

import { Component, createResource, createSignal, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { walletAddress } from '../lib/auth';
import { navigate } from '../lib/router';
import { resolveProfile, type CachedProfile } from '../lib/profile';

interface FollowListProps {
  address: string;
  tab: 'followers' | 'following';
}

export const FollowListView: Component<FollowListProps> = (props) => {
  const [profiles, setProfiles] = createSignal<Map<string, CachedProfile>>(new Map());
  const [myFollowing, setMyFollowing] = createSignal<Set<string>>(new Set());

  const [list, { refetch }] = createResource(
    () => ({ address: props.address, tab: props.tab }),
    async ({ address, tab }) => {
      if (!address) return [];
      try {
        const client = getClient();
        const resp = tab === 'followers'
          ? await client.getFollowers(address, { limit: 200 })
          : await client.getFollowing(address, { limit: 200 });
        const addresses: string[] = resp.followers ?? resp.following ?? [];
        // Resolve profiles
        for (const addr of addresses) {
          if (!profiles().has(addr)) {
            resolveProfile(addr).then((p) => {
              setProfiles((prev) => { const next = new Map(prev); next.set(addr, p); return next; });
            });
          }
        }
        return addresses;
      } catch {
        return [];
      }
    },
  );

  // Load current user's following list to show follow/unfollow buttons
  createResource(
    () => walletAddress(),
    async (me) => {
      if (!me) return;
      try {
        const resp = await getClient().getFollowing(me, { limit: 200 });
        setMyFollowing(new Set(resp.following ?? []));
      } catch { /* ignore */ }
    },
  );

  const displayName = (addr: string) => {
    const p = profiles().get(addr);
    return p?.display_name || `${addr.slice(0, 10)}...${addr.slice(-4)}`;
  };

  const handleToggleFollow = async (addr: string) => {
    try {
      const client = getClient();
      if (myFollowing().has(addr)) {
        await client.unfollow(addr);
        setMyFollowing((prev) => { const next = new Set(prev); next.delete(addr); return next; });
      } else {
        await client.follow(addr);
        setMyFollowing((prev) => { const next = new Set(prev); next.add(addr); return next; });
      }
    } catch (e) {
      console.warn('Follow toggle failed:', e);
    }
  };

  return (
    <div class="follow-list-view">
      <div class="follow-list-header">
        <button class="follow-back-btn" onClick={() => navigate(`/user/${props.address}`)}>
          &larr;
        </button>
        <div class="follow-tabs">
          <button
            class={`follow-tab ${props.tab === 'followers' ? 'active' : ''}`}
            onClick={() => navigate(`/user/${props.address}/followers`)}
          >
            {t('profile_followers')}
          </button>
          <button
            class={`follow-tab ${props.tab === 'following' ? 'active' : ''}`}
            onClick={() => navigate(`/user/${props.address}/following`)}
          >
            {t('profile_following')}
          </button>
        </div>
      </div>

      <Show
        when={list() && list()!.length > 0}
        fallback={<div class="follow-empty">{props.tab === 'followers' ? t('profile_no_followers') : t('profile_no_following')}</div>}
      >
        <div class="follow-entries">
          <For each={list()}>
            {(addr) => (
              <div class="follow-entry">
                <Show when={profiles().get(addr)?.avatar_cid}>
                  <img
                    class="follow-avatar"
                    src={getClient().getMediaUrl(profiles().get(addr)!.avatar_cid!)}
                    alt=""
                  />
                </Show>
                <Show when={!profiles().get(addr)?.avatar_cid}>
                  <span class="follow-avatar-placeholder">
                    {(profiles().get(addr)?.display_name || addr).slice(0, 2).toUpperCase()}
                  </span>
                </Show>
                <div class="follow-info" onClick={() => navigate(`/user/${addr}`)}>
                  <span class="follow-name">{displayName(addr)}</span>
                  <span class="follow-addr">{addr.slice(0, 12)}...{addr.slice(-4)}</span>
                </div>
                <Show when={walletAddress() && addr !== walletAddress()}>
                  <button
                    class={`follow-action-btn ${myFollowing().has(addr) ? 'following' : ''}`}
                    onClick={() => handleToggleFollow(addr)}
                  >
                    {myFollowing().has(addr) ? t('profile_unfollow') : t('profile_follow')}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <style>{`
        .follow-list-view { padding: var(--spacing-lg); overflow-y: auto; height: 100%; max-width: 600px; }
        .follow-list-header { display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-lg); }
        .follow-back-btn { font-size: var(--font-size-lg); padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--radius-md); }
        .follow-back-btn:hover { background: var(--color-bg-tertiary); }
        .follow-tabs { display: flex; gap: var(--spacing-xs); }
        .follow-tab {
          padding: var(--spacing-xs) var(--spacing-md);
          border-radius: var(--radius-md);
          font-size: var(--font-size-sm);
          font-weight: 500;
        }
        .follow-tab:hover { background: var(--color-bg-tertiary); }
        .follow-tab.active { background: var(--color-accent-primary); color: var(--color-text-inverse); }
        .follow-empty { text-align: center; color: var(--color-text-secondary); padding: var(--spacing-xl); }
        .follow-entries { display: flex; flex-direction: column; gap: var(--spacing-xs); }
        .follow-entry {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-md);
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
        }
        .follow-avatar { width: 36px; height: 36px; border-radius: var(--radius-full); object-fit: cover; flex-shrink: 0; }
        .follow-avatar-placeholder {
          width: 36px; height: 36px; border-radius: var(--radius-full);
          background: var(--color-accent-secondary); color: var(--color-text-inverse);
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; font-weight: 700; flex-shrink: 0;
        }
        .follow-info { flex: 1; min-width: 0; cursor: pointer; }
        .follow-info:hover .follow-name { text-decoration: underline; }
        .follow-name { font-weight: 600; font-size: var(--font-size-sm); display: block; }
        .follow-addr { font-size: var(--font-size-xs); color: var(--color-text-secondary); display: block; }
        .follow-action-btn {
          padding: var(--spacing-xs) var(--spacing-md);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-xs);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          flex-shrink: 0;
        }
        .follow-action-btn.following {
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          border: 1px solid var(--color-border);
        }
        .follow-action-btn:hover { opacity: 0.9; }
      `}</style>
    </div>
  );
};
