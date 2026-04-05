/**
 * Sidebar — main navigation with collapsible channels.
 *
 * Structure: News, Channels (collapsible, default collapsed),
 * Messages, Bookmarks, Search, Settings.
 */

import { Component, createResource, createSignal, createEffect, createMemo, For, Show, onCleanup } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { authStatus, walletAddress } from '../lib/auth';
import { navigate, route } from '../lib/router';
import { getSetting, setSetting } from '../lib/settings';
import { resolveProfile, type CachedProfile } from '../lib/profile';

/** Default channel slug shown to all users (even unauthenticated). */
const DEFAULT_CHANNEL_SLUG = 'ogmara';

// --- Reactive joined-channel tracking ---
// SolidJS signal backed by localStorage so the sidebar memo reacts to changes.

function loadJoinedFromStorage(): Set<number> {
  try {
    const raw = localStorage.getItem('ogmara_joined_channels');
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
  } catch { /* ignore */ }
  return new Set();
}

function storageInitialized(): boolean {
  return localStorage.getItem('ogmara_joined_channels') !== null;
}

const [joinedSignal, setJoinedSignal] = createSignal<Set<number>>(loadJoinedFromStorage());

function persistJoined(ids: Set<number>): void {
  localStorage.setItem('ogmara_joined_channels', JSON.stringify([...ids]));
  setJoinedSignal(new Set(ids));
}

export function addJoinedChannel(channelId: number): void {
  const ids = new Set(joinedSignal());
  ids.add(channelId);
  persistJoined(ids);
}

export function removeJoinedChannel(channelId: number): void {
  const ids = new Set(joinedSignal());
  ids.delete(channelId);
  persistJoined(ids);
}

/**
 * Sync the joined set with the API channel list.
 * - Private channels in the list → user IS a member (L2 node pre-filters) → auto-add
 * - First-time migration: seed with all visible channels
 */
function syncJoinedWithApi(apiChannels: { channel_id: number; channel_type: number; slug: string }[]): void {
  const current = new Set(joinedSignal());
  let changed = false;

  if (!storageInitialized() && apiChannels.length > 0) {
    // First-time migration: seed with all visible channels
    for (const ch of apiChannels) {
      current.add(ch.channel_id);
    }
    changed = true;
  } else {
    // Auto-add private channels the API returns (user must be a member)
    for (const ch of apiChannels) {
      if (ch.channel_type === 2 && !current.has(ch.channel_id)) {
        current.add(ch.channel_id);
        changed = true;
      }
    }
  }

  if (changed) persistJoined(current);
}

export const Sidebar: Component<{ onNavigate?: () => void }> = (props) => {
  const [channelsOpen, setChannelsOpen] = createSignal(getSetting('channelsExpanded'));
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; channelId: number; creator?: string } | null>(null);

  const handleContextMenu = (e: MouseEvent, channelId: number, creator?: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, channelId, creator });
  };

  const handleMarkRead = async () => {
    const ctx = contextMenu();
    if (!ctx) return;
    setContextMenu(null);
    try {
      await getClient().markChannelRead(ctx.channelId);
      setUnreadCounts((prev) => {
        const next = { ...prev };
        delete next[String(ctx.channelId)];
        return next;
      });
    } catch { /* ignore */ }
  };

  // Close context menu on any click
  const closeContextMenu = () => setContextMenu(null);
  if (typeof document !== 'undefined') {
    document.addEventListener('click', closeContextMenu);
    onCleanup(() => document.removeEventListener('click', closeContextMenu));
  }
  const [unreadCounts, setUnreadCounts] = createSignal<Record<string, number>>({});
  const [dmUnreadTotal, setDmUnreadTotal] = createSignal(0);
  const [notifUnread, setNotifUnread] = createSignal(0);

  // --- Private channel member list (collapsible per channel) ---
  const [expandedMembers, setExpandedMembers] = createSignal<Set<number>>(new Set());
  const [channelMembers, setChannelMembers] = createSignal<Record<number, { address: string; role: string }[]>>({});
  const [memberProfiles, setMemberProfiles] = createSignal<Map<string, CachedProfile>>(new Map());

  const toggleMembers = async (channelId: number) => {
    const expanded = new Set(expandedMembers());
    if (expanded.has(channelId)) {
      expanded.delete(channelId);
      setExpandedMembers(expanded);
      return;
    }
    expanded.add(channelId);
    setExpandedMembers(expanded);
    // Fetch members if not already loaded
    if (!channelMembers()[channelId]) {
      try {
        const resp = await getClient().getChannelMembers(channelId, { limit: 100 });
        // Resolve profiles first, then sort
        const members = resp.members;
        for (const m of members) {
          if (!memberProfiles().has(m.address)) {
            resolveProfile(m.address).then((p) => {
              setMemberProfiles((prev) => { const next = new Map(prev); next.set(m.address, p); return next; });
              // Re-sort after profile resolves
              sortAndStoreMembers(channelId, members);
            });
          }
        }
        sortAndStoreMembers(channelId, members);
      } catch { /* ignore */ }
    }
  };

  /** Sort members: creator > moderator > named users > wallets, alphabetically within each. */
  const sortAndStoreMembers = (channelId: number, members: { address: string; role: string }[]) => {
    const roleOrder = (role: string) => role === 'creator' ? 0 : role === 'moderator' ? 1 : 2;
    const sorted = [...members].sort((a, b) => {
      const ra = roleOrder(a.role), rb = roleOrder(b.role);
      if (ra !== rb) return ra - rb;
      const nameA = memberProfiles().get(a.address)?.display_name || '';
      const nameB = memberProfiles().get(b.address)?.display_name || '';
      // Named users before wallets
      if (nameA && !nameB) return -1;
      if (!nameA && nameB) return 1;
      // Alphabetical within group
      const labelA = (nameA || a.address).toLowerCase();
      const labelB = (nameB || b.address).toLowerCase();
      return labelA.localeCompare(labelB);
    });
    setChannelMembers((prev) => ({ ...prev, [channelId]: sorted }));
  };

  const memberDisplayName = (addr: string) => {
    const p = memberProfiles().get(addr);
    return p?.display_name || `${addr.slice(0, 8)}...${addr.slice(-4)}`;
  };

  // --- Member context menu (right-click on member in sidebar) ---
  const [memberMenu, setMemberMenu] = createSignal<{
    x: number; y: number; channelId: number; address: string; role: string; creator?: string;
  } | null>(null);

  const closeMemberMenu = () => setMemberMenu(null);
  if (typeof document !== 'undefined') {
    document.addEventListener('click', closeMemberMenu);
    onCleanup(() => document.removeEventListener('click', closeMemberMenu));
  }

  /** Get the current user's role in a channel from the cached member list. */
  const myRoleIn = (channelId: number): string => {
    const members = channelMembers()[channelId];
    if (!members) return 'member';
    const me = walletAddress();
    const entry = members.find((m) => m.address === me);
    return entry?.role || 'member';
  };

  const isModOrOwner = (channelId: number) => {
    const role = myRoleIn(channelId);
    return role === 'creator' || role === 'moderator';
  };

  const isOwner = (channelId: number) => myRoleIn(channelId) === 'creator';

  /** Refresh member list for a channel after moderation action. */
  const refreshMembers = async (channelId: number) => {
    try {
      const resp = await getClient().getChannelMembers(channelId, { limit: 100 });
      setChannelMembers((prev) => ({ ...prev, [channelId]: resp.members }));
      for (const m of resp.members) {
        if (!memberProfiles().has(m.address)) {
          resolveProfile(m.address).then((p) => {
            setMemberProfiles((prev) => { const next = new Map(prev); next.set(m.address, p); return next; });
          });
        }
      }
    } catch { /* ignore */ }
  };

  const handleMemberAction = async (action: string) => {
    const ctx = memberMenu();
    if (!ctx) return;
    setMemberMenu(null);
    const client = getClient();
    try {
      switch (action) {
        case 'profile':
          go(`/user/${ctx.address}`);
          break;
        case 'kick':
          if (window.confirm(`Kick ${memberDisplayName(ctx.address)}?`))  {
            await client.kickUser(ctx.channelId, ctx.address);
            await refreshMembers(ctx.channelId);
          }
          break;
        case 'ban': {
          const reason = window.prompt(t('channel_ban_reason'));
          if (reason !== null) {
            await client.banUser(ctx.channelId, ctx.address, reason || undefined);
            await refreshMembers(ctx.channelId);
          }
          break;
        }
        case 'promote': {
          await client.addModerator(ctx.channelId, ctx.address);
          await refreshMembers(ctx.channelId);
          break;
        }
        case 'demote': {
          await client.removeModerator(ctx.channelId, ctx.address);
          await refreshMembers(ctx.channelId);
          break;
        }
      }
    } catch (e: any) {
      alert(e?.message || 'Action failed');
    }
  };

  /** Navigate and auto-close sidebar on mobile. */
  const go = (path: string) => {
    navigate(path);
    props.onNavigate?.();
  };

  const [channelVersion, setChannelVersion] = createSignal(0);
  const [hasLoadedOnce, setHasLoadedOnce] = createSignal(false);
  const [allChannels, { refetch: refetchChannels }] = createResource(
    () => channelVersion(),
    async () => {
      try {
        const client = getClient();
        const resp = await client.listChannels(1, 50);
        return resp.channels;
      } catch {
        return [];
      } finally {
        setHasLoadedOnce(true);
      }
    },
  );

  // Sync joined set with API data whenever the channel list refreshes.
  // Handles first-time migration and auto-adds private channels.
  createEffect(() => {
    const all = allChannels();
    if (authStatus() === 'ready' && all && all.length > 0) {
      syncJoinedWithApi(all);
    }
  });

  // Filter: show only joined channels + default "ogmara" channel.
  // Unauthenticated users see only the default channel.
  const channels = createMemo(() => {
    const all = allChannels() || [];
    if (authStatus() !== 'ready') {
      return all.filter((ch) => ch.slug === DEFAULT_CHANNEL_SLUG);
    }
    const joined = joinedSignal(); // reactive — memo re-runs when join/leave changes it
    return all.filter((ch) =>
      ch.slug === DEFAULT_CHANNEL_SLUG || joined.has(ch.channel_id),
    );
  });

  // Listen for channel list changes (create/leave/delete)
  if (typeof window !== 'undefined') {
    window.addEventListener('ogmara:channels-changed', () => setChannelVersion(v => v + 1));
  }

  // Poll unread counts + refresh channel list every 30 seconds when authenticated
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const pollData = async () => {
    if (authStatus() !== 'ready') return;
    try {
      const client = getClient();
      const lastSeenNotif = parseInt(localStorage.getItem('ogmara.lastSeenNotifTs') || '0', 10);
      const [unread, dmUnread, notifResp] = await Promise.all([
        client.getUnreadCounts().catch(() => ({ unread: {} })),
        client.getDmUnread().catch(() => ({ unread: {} })),
        client.getNotifications(lastSeenNotif || undefined, 50).catch(() => ({ notifications: [] })),
        // Refresh channel list to sync cross-device changes (leave/delete/create)
        refetchChannels(),
      ]);
      setUnreadCounts(unread.unread ?? {});
      const dmCounts = dmUnread.unread ?? {};
      setDmUnreadTotal(Object.values(dmCounts).reduce((a: number, b: number) => a + b, 0));
      setNotifUnread((notifResp as any).notifications?.length ?? 0);
    } catch { /* ignore */ }
  };
  createEffect(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (authStatus() === 'ready') {
      pollData();
      pollTimer = setInterval(pollData, 30000);
    }
  });
  onCleanup(() => { if (pollTimer) clearInterval(pollTimer); });

  const currentChannelId = () => {
    const r = route();
    if (r.view === 'chat' && r.params.channelId) {
      return parseInt(r.params.channelId, 10);
    }
    return null;
  };

  const isView = (view: string) => {
    const r = route();
    if (view === 'news') return r.view === 'news' || r.view === 'news-detail' || r.view === 'compose';
    if (view === 'dm') return r.view === 'dm' || r.view === 'dm-conversation';
    if (view === 'bookmarks') return r.view === 'bookmarks';
    if (view === 'search') return r.view === 'search';
    if (view === 'settings') return r.view === 'settings';
    return false;
  };

  return (
    <aside class={`sidebar ${window.innerWidth <= 768 ? 'mobile-open' : ''}`}>
      {/* News */}
      <div class="sidebar-section">
        <button
          class={`sidebar-nav-item ${isView('news') ? 'active' : ''}`}
          onClick={() => go('/news')}
        >
          📰 {t('nav_news')}
        </button>
      </div>

      {/* Channels (collapsible) */}
      <div class="sidebar-section">
        <div class="sidebar-heading-row">
          <button
            class="sidebar-collapse-btn"
            onClick={() => { const next = !channelsOpen(); setChannelsOpen(next); setSetting('channelsExpanded', next); }}
          >
            <span class={`collapse-arrow ${channelsOpen() ? 'open' : ''}`}>▸</span>
            <h3 class="sidebar-heading">{t('sidebar_channels')}</h3>
            <Show when={!channelsOpen() && Object.values(unreadCounts()).reduce((a, b) => a + b, 0) > 0}>
              <span class="unread-badge">
                {Object.values(unreadCounts()).reduce((a, b) => a + b, 0)}
              </span>
            </Show>
          </button>
          <Show when={authStatus() === 'ready'}>
            <button
              class="sidebar-add-btn"
              onClick={() => go('/channel/create')}
              title={t('channel_create')}
            >
              +
            </button>
          </Show>
        </div>
        <Show when={channelsOpen()}>
          <Show when={hasLoadedOnce() || !allChannels.loading} fallback={<div class="sidebar-loading">{t('loading')}</div>}>
            <For each={channels()}>
              {(channel) => (
                <div class="channel-group">
                  <button
                    class={`sidebar-item ${currentChannelId() === channel.channel_id ? 'active' : ''}`}
                    onClick={() => go(`/chat/${channel.channel_id}`)}
                    onContextMenu={(e) => handleContextMenu(e, channel.channel_id, channel.creator)}
                  >
                    <span class="channel-hash">{channel.channel_type === 2 ? '🔒' : '#'}</span>
                    <span class="channel-name">{channel.display_name || channel.slug}</span>
                    <Show when={(unreadCounts()[String(channel.channel_id)] ?? 0) > 0}>
                      <span class="unread-badge">{unreadCounts()[String(channel.channel_id)]}</span>
                    </Show>
                  </button>
                  <Show when={channel.channel_type === 2}>
                    <button
                      class="sidebar-members-toggle"
                      onClick={() => toggleMembers(channel.channel_id)}
                    >
                      <span class={`collapse-arrow ${expandedMembers().has(channel.channel_id) ? 'open' : ''}`}>▸</span>
                      <span>{t('channel_members')}</span>
                    </button>
                    <Show when={expandedMembers().has(channel.channel_id)}>
                      <div class="sidebar-member-list">
                        <For each={channelMembers()[channel.channel_id] ?? []}>
                          {(member) => (
                            <button
                              class="sidebar-member-item"
                              onClick={() => go(`/user/${member.address}`)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setMemberMenu({ x: e.clientX, y: e.clientY, channelId: channel.channel_id, address: member.address, role: member.role, creator: channel.creator });
                              }}
                              title={member.address}
                            >
                              <span class="member-dot" classList={{ 'member-mod': member.role === 'moderator', 'member-owner': member.role === 'creator' }} />
                              <span class="member-name">{memberDisplayName(member.address)}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>

      {/* Messages */}
      <div class="sidebar-section">
        <button
          class={`sidebar-nav-item ${isView('dm') ? 'active' : ''}`}
          onClick={() => go('/dm')}
        >
          💬 {t('nav_dms')}
          <Show when={dmUnreadTotal() > 0}>
            <span class="unread-badge">{dmUnreadTotal()}</span>
          </Show>
        </button>
      </div>

      {/* Notifications */}
      <Show when={authStatus() === 'ready'}>
        <div class="sidebar-section">
          <button
            class={`sidebar-nav-item ${route().view === 'notifications' ? 'active' : ''}`}
            onClick={() => {
              // Mark notifications as seen (store current timestamp)
              localStorage.setItem('ogmara.lastSeenNotifTs', Date.now().toString());
              setNotifUnread(0);
              go('/notifications');
            }}
          >
            🔔 {t('nav_notifications')}
            <Show when={notifUnread() > 0}>
              <span class="unread-badge">{notifUnread()}</span>
            </Show>
          </button>
        </div>
      </Show>

      {/* Divider */}
      <div class="sidebar-divider" />

      {/* Bookmarks */}
      <div class="sidebar-section">
        <button
          class={`sidebar-nav-item ${isView('bookmarks') ? 'active' : ''}`}
          onClick={() => go('/bookmarks')}
        >
          ★ {t('bookmarks_title')}
        </button>
      </div>

      {/* Search */}
      <div class="sidebar-section">
        <button
          class={`sidebar-nav-item ${isView('search') ? 'active' : ''}`}
          onClick={() => go('/search')}
        >
          🔍 {t('nav_search')}
        </button>
      </div>

      {/* Settings */}
      <div class="sidebar-section">
        <button
          class={`sidebar-nav-item ${isView('settings') ? 'active' : ''}`}
          onClick={() => go('/settings')}
        >
          ⚙ {t('nav_settings')}
        </button>
      </div>

      {/* Connect wallet prompt */}
      <Show when={authStatus() !== 'ready'}>
        <div class="sidebar-section">
          <button class="sidebar-connect-btn" onClick={() => go('/wallet')}>
            {t('wallet_connect')}
          </button>
        </div>
      </Show>

      {/* Channel context menu */}
      <Show when={contextMenu()}>
        <div
          class="channel-context-menu"
          style={{ left: `${contextMenu()!.x}px`, top: `${contextMenu()!.y}px` }}
        >
          <button class="context-menu-item" onClick={handleMarkRead}>
            ✓ {t('channel_mark_read')}
          </button>
          <button class="context-menu-item" onClick={() => {
            const ctx = contextMenu();
            setContextMenu(null);
            if (ctx) navigate(`/chat/${ctx.channelId}/settings`);
          }}>
            ⚙ {t('channel_settings')}
          </button>
          <button class="context-menu-item context-menu-danger" onClick={async () => {
            const ctx = contextMenu();
            setContextMenu(null);
            if (!ctx) return;
            if (!window.confirm(t('channel_leave_confirm'))) return;
            try {
              await getClient().leaveChannel(ctx.channelId);
              removeJoinedChannel(ctx.channelId);
              window.dispatchEvent(new Event('ogmara:channels-changed'));
              navigate('/news');
            } catch (e: any) {
              alert(e?.message || 'Failed to leave channel');
            }
          }}>
            ✕ {t('channel_leave')}
          </button>
          <Show when={contextMenu()?.creator === walletAddress()}>
            <button class="context-menu-item context-menu-danger" onClick={async () => {
              const ctx = contextMenu();
              setContextMenu(null);
              if (!ctx) return;
              if (!window.confirm(t('channel_delete_confirm'))) return;
              try {
                await getClient().deleteChannel(ctx.channelId);
                removeJoinedChannel(ctx.channelId);
                window.dispatchEvent(new Event('ogmara:channels-changed'));
                navigate('/news');
              } catch (e: any) {
                alert(e?.message || 'Failed to delete channel');
              }
            }}>
              🗑 {t('channel_delete')}
            </button>
          </Show>
        </div>
      </Show>

      {/* Member context menu (right-click on member in sidebar) */}
      <Show when={memberMenu()}>
        <div
          class="channel-context-menu"
          style={{ left: `${memberMenu()!.x}px`, top: `${memberMenu()!.y}px` }}
        >
          <button class="context-menu-item" onClick={() => handleMemberAction('profile')}>
            👤 {t('channel_view_profile')}
          </button>
          {/* Kick/ban: visible to mods and owner, but not on yourself or the owner */}
          <Show when={
            isModOrOwner(memberMenu()!.channelId) &&
            memberMenu()!.address !== walletAddress() &&
            memberMenu()!.role !== 'creator'
          }>
            <div class="ctx-divider" />
            <button class="context-menu-item context-menu-warn" onClick={() => handleMemberAction('kick')}>
              ⚡ {t('channel_kick')}
            </button>
            <button class="context-menu-item context-menu-danger" onClick={() => handleMemberAction('ban')}>
              ⛔ {t('channel_ban')}
            </button>
          </Show>
          {/* Promote/demote: owner only, not on yourself */}
          <Show when={
            isOwner(memberMenu()!.channelId) &&
            memberMenu()!.address !== walletAddress()
          }>
            <div class="ctx-divider" />
            <Show when={memberMenu()!.role !== 'moderator'}>
              <button class="context-menu-item" onClick={() => handleMemberAction('promote')}>
                ⬆ {t('channel_promote_mod')}
              </button>
            </Show>
            <Show when={memberMenu()!.role === 'moderator'}>
              <button class="context-menu-item context-menu-warn" onClick={() => handleMemberAction('demote')}>
                ⬇ {t('channel_demote_mod')}
              </button>
            </Show>
          </Show>
        </div>
      </Show>

      <style>{`
        .sidebar {
          width: 240px;
          min-width: 240px;
          background: var(--color-bg-secondary);
          border-right: 1px solid var(--color-border);
          display: flex;
          flex-direction: column;
          overflow-y: auto;
        }
        .sidebar-section { padding: var(--spacing-xs) var(--spacing-sm); }
        .sidebar-divider {
          height: 1px;
          background: var(--color-border);
          margin: var(--spacing-xs) var(--spacing-md);
        }
        .sidebar-heading-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 var(--spacing-xs);
        }
        .sidebar-collapse-btn {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: var(--spacing-xs);
          border-radius: var(--radius-sm);
        }
        .sidebar-collapse-btn:hover { background: var(--color-bg-tertiary); }
        .collapse-arrow {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          transition: transform 0.15s;
          display: inline-block;
        }
        .collapse-arrow.open { transform: rotate(90deg); }
        .sidebar-heading {
          font-size: var(--font-size-xs);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--color-text-secondary);
          font-weight: 600;
        }
        .sidebar-add-btn {
          width: 20px;
          height: 20px;
          border-radius: var(--radius-sm);
          font-size: var(--font-size-sm);
          font-weight: 700;
          color: var(--color-text-secondary);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .sidebar-add-btn:hover { background: var(--color-bg-tertiary); color: var(--color-text-primary); }
        .sidebar-nav-item {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm);
          border-radius: var(--radius-md);
          width: 100%;
          text-align: left;
          font-size: var(--font-size-sm);
          font-weight: 500;
        }
        .sidebar-nav-item:hover { background: var(--color-bg-tertiary); }
        .sidebar-nav-item.active {
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
        }
        .sidebar-item {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: var(--spacing-xs) var(--spacing-sm);
          padding-left: var(--spacing-lg);
          border-radius: var(--radius-md);
          width: 100%;
          text-align: left;
          font-size: var(--font-size-sm);
        }
        .sidebar-item:hover { background: var(--color-bg-tertiary); }
        .sidebar-item.active { background: var(--color-accent-primary); color: var(--color-text-inverse); }
        .channel-hash { opacity: 0.5; font-weight: 700; }
        .unread-badge {
          margin-left: auto;
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          font-size: 10px;
          font-weight: 700;
          padding: 1px 6px;
          border-radius: var(--radius-full);
          min-width: 18px;
          text-align: center;
        }
        .sidebar-loading {
          padding: var(--spacing-sm) var(--spacing-lg);
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
        }
        .sidebar-connect-btn {
          color: var(--color-accent-primary);
          font-size: var(--font-size-sm);
          font-weight: 600;
          padding: var(--spacing-sm);
          border-radius: var(--radius-md);
          width: 100%;
          text-align: left;
        }
        .sidebar-connect-btn:hover { background: var(--color-bg-tertiary); }
        .channel-context-menu {
          position: fixed;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          z-index: 100;
          padding: 4px;
          min-width: 160px;
        }
        .context-menu-item {
          display: block;
          width: 100%;
          text-align: left;
          padding: var(--spacing-sm) var(--spacing-md);
          font-size: var(--font-size-sm);
          border-radius: var(--radius-sm);
          cursor: pointer;
          color: var(--color-text-primary);
        }
        .context-menu-item:hover { background: var(--color-bg-tertiary); }
        .context-menu-warn { color: var(--color-text-secondary); }
        .context-menu-danger { color: #f44; }
        .context-menu-danger:hover { background: rgba(255,68,68,0.1); }
        .ctx-divider { height: 1px; background: var(--color-border); margin: 4px 0; }
        .channel-group { display: flex; flex-direction: column; }
        .sidebar-members-toggle {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: 2px var(--spacing-sm);
          padding-left: calc(var(--spacing-lg) + var(--spacing-sm));
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          width: 100%;
          text-align: left;
        }
        .sidebar-members-toggle:hover { color: var(--color-text-primary); }
        .sidebar-member-list {
          display: flex;
          flex-direction: column;
        }
        .sidebar-member-item {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: 2px var(--spacing-sm);
          padding-left: calc(var(--spacing-lg) + var(--spacing-lg));
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          width: 100%;
          text-align: left;
        }
        .sidebar-member-item:hover { background: var(--color-bg-tertiary); color: var(--color-text-primary); }
        .member-dot {
          width: 6px;
          height: 6px;
          border-radius: var(--radius-full);
          background: var(--color-text-secondary);
          flex-shrink: 0;
        }
        .member-dot.member-mod { background: var(--color-accent-primary); }
        .member-dot.member-owner { background: var(--color-success); }
        .member-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      `}</style>
    </aside>
  );
};
