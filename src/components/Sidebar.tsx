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
import { isMobileViewport, showMobileDetail, showMobileList, mobileListOpen } from '../lib/mobile-nav';
import { isModernStyle } from '../lib/theme';
import { getTheme, setTheme } from '../lib/theme';
import { disconnectWallet } from '../lib/auth';
// Desktop-only: tray icon badge — reflects total unread count on the OS tray.
import { updateTrayBadge } from '../lib/trayBadge';

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
 * - First-time migration: seed with ALL visible channels
 *
 * Why seed with everything on first init: the joined-set is purely a
 * client-side sidebar visibility filter — there is no on-chain or server-side
 * "joined" state for public channels. After a fresh device / cleared local
 * storage the filter starts empty, so without seeding the sidebar shows
 * nothing even though the API returned a full catalog. Users could only
 * see channels by manually visiting `/chat/<id>` or finding them via Search.
 * The old behaviour of only seeding the `ogmara` default channel left
 * networks without that channel with a permanently empty sidebar after a
 * fresh setup. Seeding with the full visible set restores the expected
 * "I can see what I have access to" UX; the user can still explicitly
 * leave channels afterwards.
 */
function syncJoinedWithApi(apiChannels: { channel_id: number; channel_type: number; slug: string }[]): void {
  const current = new Set(joinedSignal());
  let changed = false;

  if (!storageInitialized() && apiChannels.length > 0) {
    // First-time migration on this device — seed with everything the API
    // returns (private channels are already pre-filtered to members; public
    // channels form the platform's visible catalog).
    for (const ch of apiChannels) {
      if (!current.has(ch.channel_id)) {
        current.add(ch.channel_id);
        changed = true;
      }
    }
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

// Sidebar minimum is set so the Modern header (burger + search input + bell)
// always has room to render legibly with visual breathing room around each
// control. Earlier values (200, 280, 320) all left the bell button flush
// against the sidebar's right edge — and because the 1px border between
// sidebar and right pane is barely distinguishable from the surrounding
// dark-blue surfaces, users perceived the bell as "spilling" into the main
// pane. 360px gives the bell ~28px of clear space from the divider, which
// reads as proper separation.
const SIDEBAR_MIN_W = 360;
const SIDEBAR_MAX_W = 600;
const SIDEBAR_DEFAULT_W = 320;

export const Sidebar: Component<{ onNavigate?: () => void }> = (props) => {
  const [channelsOpen, setChannelsOpen] = createSignal(getSetting('channelsExpanded'));
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; channelId: number; creator?: string } | null>(null);

  const savedW = parseInt(localStorage.getItem('ogmara.sidebarWidth') || '', 10);
  const [sidebarWidth, setSidebarWidth] = createSignal(
    Number.isFinite(savedW) ? Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, savedW)) : SIDEBAR_DEFAULT_W,
  );
  let dragging = false;
  const onResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    dragging = true;
    const onMove = (ev: MouseEvent) => {
      if (!dragging) return;
      setSidebarWidth(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, ev.clientX)));
    };
    const onUp = () => {
      dragging = false;
      localStorage.setItem('ogmara.sidebarWidth', String(sidebarWidth()));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Member profiles — shared between classic sidebar and modern sidebar
  const [memberProfiles, setMemberProfiles] = createSignal<Map<string, CachedProfile>>(new Map());

  // --- Modern style: burger menu + tabbed sidebar ---
  type SidebarTab = 'chats' | 'feed' | 'dms';
  const [activeTab, setActiveTab] = createSignal<SidebarTab>('chats');
  const [searchQuery, setSearchQuery] = createSignal('');
  const [burgerOpen, setBurgerOpen] = createSignal(false);
  const [currentTheme, setCurrentTheme] = createSignal(getTheme());
  const [burgerProfile, setBurgerProfile] = createSignal<CachedProfile>({});

  if (typeof document !== 'undefined') {
    const closeBurger = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.sidebar-burger-wrap')) setBurgerOpen(false);
    };
    document.addEventListener('click', closeBurger);
    onCleanup(() => document.removeEventListener('click', closeBurger));
  }

  createEffect(() => {
    const addr = walletAddress();
    if (addr) resolveProfile(addr).then(setBurgerProfile);
  });

  const modernNavTo = (path: string) => {
    setBurgerOpen(false);
    navigate(path);
    if (isMobileViewport()) showMobileDetail();
  };

  const toggleTheme = () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setCurrentTheme(next);
  };

  const handleLogout = async () => {
    setBurgerOpen(false);
    await disconnectWallet();
    navigate('/news');
  };

  // Remember last route per tab so switching tabs restores the previous view
  let lastChatRoute = `/chat/${getSetting('lastChannel') || ''}`;
  let lastFeedRoute = `/news?feed=${
    getSetting('defaultFeed') === 'following' ? 'following' : 'global'
  }`;
  let lastDmRoute = '/dm';

  // Track current route changes to update last-per-tab.
  // Only stick on the LIST views (`/news`, `/dm`) — clicking the tab should
  // always return to the feed/list, not to a previously-open detail or
  // compose screen. (For chat we do stick on the channel because each
  // channel is its own context the user wants to resume.)
  createEffect(() => {
    const r = route();
    if (r.view === 'chat' && r.params.channelId) lastChatRoute = `/chat/${r.params.channelId}`;
    if (r.view === 'news') {
      // Preserve the active feed mode so clicking the News tab from
      // Chat/DMs lands back on the same Global/Following view the user
      // was reading. Falls back to the saved default when no query is
      // present, mirroring `resolveFeedMode()` in NewsView.
      const q = r.query.feed;
      const mode = q === 'following' || q === 'global'
        ? q
        : (getSetting('defaultFeed') === 'following' ? 'following' : 'global');
      lastFeedRoute = `/news?feed=${mode}`;
    }
    if (r.view === 'dm-conversation' && r.params.address) lastDmRoute = `/dm/${r.params.address}`;
  });

  // DM conversations for modern sidebar
  const [dmConversations] = createResource(
    () => activeTab() === 'dms' && authStatus() === 'ready',
    async (shouldFetch) => {
      if (!shouldFetch) return [];
      try {
        const resp = await getClient().getDmConversations({ limit: 50 });
        for (const conv of resp.conversations) {
          if (!memberProfiles().has(conv.peer)) {
            resolveProfile(conv.peer).then((p) => {
              setMemberProfiles((prev) => { const next = new Map(prev); next.set(conv.peer, p); return next; });
            });
          }
        }
        return resp.conversations;
      } catch { return []; }
    },
  );

  const channelInitial = (ch: { display_name?: string; slug: string }) =>
    (ch.display_name || ch.slug || '#').slice(0, 1).toUpperCase();

  const filteredChannels = () => {
    const all = channels() ?? [];
    const q = searchQuery().trim().toLowerCase();
    if (!q) return all;
    return all.filter((ch) =>
      (ch.display_name || '').toLowerCase().includes(q) || ch.slug.toLowerCase().includes(q),
    );
  };

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
  // Per-channel count of unread messages that @-mention the viewer. Used to
  // show an `@` indicator next to the unread badge so users see *where* they
  // were pinged at a glance. Older nodes don't return this — treat as empty.
  const [mentionCounts, setMentionCounts] = createSignal<Record<string, number>>({});
  const [dmUnreadTotal, setDmUnreadTotal] = createSignal(0);
  const [notifUnread, setNotifUnread] = createSignal(0);

  // --- Private channel member list (collapsible per channel) ---
  const [expandedMembers, setExpandedMembers] = createSignal<Set<number>>(new Set());
  const [channelMembers, setChannelMembers] = createSignal<Record<number, { address: string; role: string }[]>>({});

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
    const onChannelsChanged = () => setChannelVersion(v => v + 1);
    window.addEventListener('ogmara:channels-changed', onChannelsChanged);
    onCleanup(() => window.removeEventListener('ogmara:channels-changed', onChannelsChanged));
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
        // Refresh channel list
        refetchChannels(),
      ]);
      setUnreadCounts(unread.unread ?? {});
      setMentionCounts(unread.mentions ?? {});
      const dmCounts = dmUnread.unread ?? {};
      const dmTotal = Object.values(dmCounts).reduce((a: number, b: number) => a + b, 0);
      setDmUnreadTotal(dmTotal);
      const notifCount = (notifResp as any).notifications?.length ?? 0;
      setNotifUnread(notifCount);

      // Desktop tray badge — sum of channel + DM + notification unreads.
      const channelTotal = Object.values(unread.unread ?? {}).reduce(
        (a: number, b: number) => a + b, 0,
      );
      updateTrayBadge(channelTotal + dmTotal + notifCount);
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

  // --- Modern sidebar render ---
  const modernSidebar = () => (
    <aside
      class={`sidebar ${isMobileViewport() ? 'mobile-open' : ''}`}
      style={isMobileViewport()
        ? { display: 'flex', 'flex-direction': 'column', width: '100%', height: '100%', position: 'relative' }
        : { width: `${sidebarWidth()}px`, 'min-width': `${sidebarWidth()}px`, position: 'relative' }
      }
    >
      <div class="sidebar-header" style="display:flex; align-items:center; gap:8px; padding:8px 16px 8px 12px; border-bottom:1px solid var(--color-border)">
        <div class="sidebar-burger-wrap" style="position:relative; flex-shrink:0">
          <Show
            when={isMobileViewport() && !mobileListOpen()}
            fallback={
              <button style="width:38px; height:38px; border-radius:50%; color:var(--color-text-secondary); display:flex; align-items:center; justify-content:center"
                onClick={(e) => { e.stopPropagation(); setBurgerOpen(!burgerOpen()); }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
                </svg>
              </button>
            }
          >
            <button style="width:38px; height:38px; border-radius:50%; color:var(--color-text-secondary); display:flex; align-items:center; justify-content:center"
              onClick={() => showMobileList()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/>
              </svg>
            </button>
          </Show>
          <Show when={burgerOpen()}>
            <div style="position:absolute; top:42px; left:0; background:var(--color-bg-secondary); border:1px solid var(--color-border); border-radius:var(--radius-md); box-shadow:0 4px 16px rgba(0,0,0,0.35); z-index:10000; padding:4px; min-width:220px" role="menu">
              <Show when={authStatus() === 'ready' && walletAddress()}>
                <button style="display:flex; align-items:center; gap:8px; padding:8px 12px; width:100%; text-align:left; border-radius:var(--radius-sm); cursor:pointer"
                  onClick={() => modernNavTo(`/user/${walletAddress()}`)}>
                  <span style="width:36px; height:36px; border-radius:50%; background:var(--color-accent-bg); color:var(--color-accent-primary); display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; flex-shrink:0">
                    {(burgerProfile().display_name || walletAddress() || '').slice(0, 2).toUpperCase()}
                  </span>
                  <div style="overflow:hidden">
                    <div style="font-weight:600; font-size:var(--font-size-sm); color:var(--color-text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis">
                      {burgerProfile().display_name || `${walletAddress()?.slice(0, 8)}...${walletAddress()?.slice(-4)}`}
                    </div>
                    <div style="font-size:11px; color:var(--color-text-secondary)">{walletAddress()?.slice(0, 12)}…{walletAddress()?.slice(-6)}</div>
                  </div>
                </button>
                <div style="height:1px; background:var(--color-border); margin:4px 0" />
              </Show>
              <Show when={authStatus() === 'ready'}>
                <button class="modern-menu-item" onClick={() => modernNavTo(`/user/${walletAddress()}`)}>{t('menu_my_profile')}</button>
                <button class="modern-menu-item" onClick={() => modernNavTo('/wallet/tokens')}>{t('menu_wallet')}</button>
                <button class="modern-menu-item" onClick={() => modernNavTo('/wallet')}>{t('menu_account_security')}</button>
                <div style="height:1px; background:var(--color-border); margin:4px 0" />
                <button class="modern-menu-item" onClick={() => modernNavTo('/channel/create')}>{t('menu_new_channel')}</button>
                <div style="height:1px; background:var(--color-border); margin:4px 0" />
                <button class="modern-menu-item" onClick={() => { localStorage.setItem('ogmara.lastSeenNotifTs', Date.now().toString()); modernNavTo('/notifications'); }}>{t('menu_notifications')}</button>
              </Show>
              <button class="modern-menu-item" onClick={() => modernNavTo('/search')}>{t('menu_search')}</button>
              <button class="modern-menu-item" onClick={() => modernNavTo('/bookmarks')}>{t('menu_bookmarks')}</button>
              <button class="modern-menu-item" onClick={() => modernNavTo('/settings')}>{t('menu_settings')}</button>
              <button class="modern-menu-item" onClick={(e) => { e.stopPropagation(); toggleTheme(); }}>
                {currentTheme() === 'dark' ? t('menu_theme_dark') : t('menu_theme_light')}
              </button>
              <Show when={authStatus() === 'ready'}>
                <div style="height:1px; background:var(--color-border); margin:4px 0" />
                <button class="modern-menu-item" style="color:#f44" onClick={handleLogout}>{t('menu_disconnect')}</button>
              </Show>
              <Show when={authStatus() !== 'ready'}>
                <div style="height:1px; background:var(--color-border); margin:4px 0" />
                <button class="modern-menu-item" onClick={() => modernNavTo('/wallet')}>{t('wallet_connect')}</button>
              </Show>
            </div>
          </Show>
        </div>
        <div style="flex:1; display:flex; align-items:center; gap:6px; background:var(--color-bg-tertiary); border-radius:var(--radius-md); padding:6px 10px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" placeholder={t('nav_search')} value={searchQuery()} onInput={(e) => setSearchQuery(e.currentTarget.value)}
            style="flex:1; background:none; border:none; outline:none; color:var(--color-text-primary); font-size:var(--font-size-sm); font-family:inherit" />
          <Show when={searchQuery()}>
            <button onClick={() => setSearchQuery('')} style="color:var(--color-text-secondary); font-size:14px; cursor:pointer">✕</button>
          </Show>
        </div>
        <Show when={authStatus() === 'ready'}>
          <button style="position:relative; width:38px; height:38px; border-radius:50%; color:var(--color-text-secondary); display:flex; align-items:center; justify-content:center; flex-shrink:0"
            onClick={() => { localStorage.setItem('ogmara.lastSeenNotifTs', Date.now().toString()); setNotifUnread(0); go('/notifications'); }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            <Show when={notifUnread() > 0}>
              <span style="position:absolute; top:4px; right:4px; min-width:16px; height:16px; border-radius:9999px; background:var(--color-accent-primary); color:var(--color-text-inverse); font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; padding:0 4px">{notifUnread()}</span>
            </Show>
          </button>
        </Show>
      </div>

      {/* Tab bar — pill buttons with accent-bg tint on active */}
      <div style="display:flex; gap:4px; padding:8px 12px; border-bottom:1px solid var(--color-border)">
        <button style={`flex:1; padding:8px 10px; font-size:var(--font-size-sm); font-weight:600; border-radius:9999px; transition:background 0.15s, color 0.15s; text-align:center; ${activeTab() === 'chats' ? 'background:var(--color-accent-bg); color:var(--color-accent-primary)' : 'background:transparent; color:var(--color-text-secondary)'}`}
          onClick={() => { setActiveTab('chats'); if (lastChatRoute && lastChatRoute !== '/chat/') go(lastChatRoute); }}>{t('nav_chat')}</button>
        <button style={`flex:1; padding:8px 10px; font-size:var(--font-size-sm); font-weight:600; border-radius:9999px; transition:background 0.15s, color 0.15s; text-align:center; ${activeTab() === 'feed' ? 'background:var(--color-accent-bg); color:var(--color-accent-primary)' : 'background:transparent; color:var(--color-text-secondary)'}`}
          onClick={() => { setActiveTab('feed'); go(lastFeedRoute); }}>{t('nav_news')}</button>
        <button style={`flex:1; padding:8px 10px; font-size:var(--font-size-sm); font-weight:600; border-radius:9999px; transition:background 0.15s, color 0.15s; text-align:center; ${activeTab() === 'dms' ? 'background:var(--color-accent-bg); color:var(--color-accent-primary)' : 'background:transparent; color:var(--color-text-secondary)'}`}
          onClick={() => { setActiveTab('dms'); if (lastDmRoute !== '/dm') go(lastDmRoute); }}>{t('nav_dms')}</button>
      </div>

      {/* Tab content */}
      <div style="flex:1; overflow-y:auto">
        <Show when={activeTab() === 'chats'}>
          <For each={filteredChannels()}>
            {(channel) => {
              const unread = () => unreadCounts()[String(channel.channel_id)] ?? 0;
              const mentioned = () => (mentionCounts()[String(channel.channel_id)] ?? 0) > 0;
              const isActive = () => currentChannelId() === channel.channel_id;
              return (
                <button
                  style={`display:flex; align-items:center; gap:10px; padding:10px 12px; width:100%; text-align:left; cursor:pointer; transition:background 0.1s; background:${isActive() ? 'var(--color-chat-active-bg)' : 'transparent'}`}
                  onClick={() => go(`/chat/${channel.channel_id}`)}
                  onContextMenu={(e) => handleContextMenu(e, channel.channel_id, channel.creator)}
                >
                  <div style="width:48px; height:48px; border-radius:50%; background:linear-gradient(135deg, var(--color-accent-primary), var(--color-accent-secondary)); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:20px; flex-shrink:0; overflow:hidden">
                    <Show when={channel.logo_cid} fallback={<span>{channelInitial(channel)}</span>}>
                      <img src={getClient().getMediaUrl(channel.logo_cid!)} alt="" style="width:48px; height:48px; border-radius:50%; object-fit:cover" />
                    </Show>
                  </div>
                  <div style="flex:1; overflow:hidden">
                    <div style="display:flex; justify-content:space-between; align-items:center">
                      <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--color-text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis">
                        <Show when={channel.channel_type === 2}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:4px; vertical-align:-1px">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                          </svg>
                        </Show>
                        <Show when={channel.channel_type === 1}>
                          <span style="margin-right:4px; vertical-align:-1px" title={t('sidebar_broadcast_channel')}>📢</span>
                        </Show>
                        {channel.display_name || channel.slug}
                      </span>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px">
                      <span style="font-size:var(--font-size-xs); color:var(--color-text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis">
                        {channel.description || (channel.channel_type === 2
                          ? t('sidebar_private_channel')
                          : channel.channel_type === 1
                            ? t('sidebar_broadcast_channel')
                            : t('sidebar_public_channel'))}
                      </span>
                      <Show when={mentioned()}>
                        <span class="mention-badge" title={t('sidebar_mentioned_here')}
                          style="min-width:20px; height:20px; border-radius:9999px; background:var(--color-warning, #f59e0b); color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; padding:0 5px; flex-shrink:0; margin-left:4px">
                          @
                        </span>
                      </Show>
                      <Show when={unread() > 0}>
                        <span style="min-width:20px; height:20px; border-radius:9999px; background:var(--color-accent-primary); color:var(--color-text-inverse); font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; padding:0 5px; flex-shrink:0; margin-left:4px">
                          {unread()}
                        </span>
                      </Show>
                    </div>
                  </div>
                </button>
              );
            }}
          </For>
        </Show>

        <Show when={activeTab() === 'feed'}>
          {/* Feed-mode picker. The two entries map 1:1 to NewsView's
              fetch source (`client.listNews()` vs `client.getFeed()`).
              Active highlight follows the live URL query so opening a
              detail then coming back keeps the right pill lit. The
              clicked mode is also persisted as the default feed via
              NewsView's createEffect, so a power user who always wants
              'Following' on launch gets that by simply ever using it. */}
          {(() => {
            const currentFeedMode = (): 'global' | 'following' => {
              const q = route().query.feed;
              if (q === 'following' || q === 'global') return q;
              return getSetting('defaultFeed') === 'following' ? 'following' : 'global';
            };
            const pillStyle = (active: boolean, disabled: boolean) =>
              `display:flex; align-items:center; gap:10px; padding:10px 12px; width:100%; text-align:left; cursor:pointer; transition:background 0.1s; background:${active ? 'var(--color-chat-active-bg)' : 'transparent'}; ${disabled ? 'opacity:0.55' : ''}`;
            const iconStyle =
              'width:32px; height:32px; border-radius:50%; background:var(--color-bg-tertiary); display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0';
            const labelStyle = (active: boolean) =>
              `font-weight:600; font-size:var(--font-size-sm); color:${active ? 'var(--color-accent-primary)' : 'var(--color-text-primary)'}`;
            const subStyle =
              'font-size:var(--font-size-xs); color:var(--color-text-secondary); margin-top:2px';
            return (
              <>
                <button
                  style={pillStyle(currentFeedMode() === 'global', false)}
                  onClick={() => go('/news?feed=global')}
                  title={t('news_feed_global_desc')}
                >
                  <div style={iconStyle}>🌐</div>
                  <div style="flex:1; overflow:hidden">
                    <div style={labelStyle(currentFeedMode() === 'global')}>
                      {t('news_feed_global')}
                    </div>
                    <div style={subStyle}>{t('news_feed_global_desc')}</div>
                  </div>
                </button>
                <button
                  style={pillStyle(
                    currentFeedMode() === 'following',
                    authStatus() !== 'ready',
                  )}
                  onClick={() => go('/news?feed=following')}
                  title={
                    authStatus() !== 'ready'
                      ? t('news_feed_following_locked_hint')
                      : t('news_feed_following_desc')
                  }
                >
                  <div style={iconStyle}>👥</div>
                  <div style="flex:1; overflow:hidden">
                    <div style={labelStyle(currentFeedMode() === 'following')}>
                      {t('news_feed_following')}
                      <Show when={authStatus() !== 'ready'}>
                        <span style="margin-left:6px; font-size:11px">🔒</span>
                      </Show>
                    </div>
                    <div style={subStyle}>
                      {authStatus() !== 'ready'
                        ? t('news_feed_following_locked_hint')
                        : t('news_feed_following_desc')}
                    </div>
                  </div>
                </button>
              </>
            );
          })()}
        </Show>

        <Show when={activeTab() === 'dms'}>
          <Show when={authStatus() === 'ready'} fallback={
            <div style="padding:40px 20px; text-align:center; color:var(--color-text-secondary)">
              <div style="font-size:28px; margin-bottom:8px">✉️</div>
              <p>{t('auth_connect_prompt')}</p>
            </div>
          }>
            <Show when={dmConversations() && dmConversations()!.length > 0} fallback={
              <div style="padding:40px 20px; text-align:center; color:var(--color-text-secondary)">
                <div style="font-size:28px; margin-bottom:8px">✉️</div>
                <p>{t('dm_empty')}</p>
              </div>
            }>
              <For each={dmConversations()}>
                {(conv) => {
                  const isActive = () => route().view === 'dm-conversation' && route().params.address === conv.peer;
                  const dmProf = () => memberProfiles?.().get(conv.peer);
                  const dmName = () => dmProf()?.display_name || `${conv.peer.slice(0, 8)}...${conv.peer.slice(-4)}`;
                  return (
                    <button
                      style={`display:flex; align-items:center; gap:10px; padding:10px 12px; width:100%; text-align:left; cursor:pointer; background:${isActive() ? 'var(--color-accent-bg)' : 'transparent'}`}
                      onClick={() => go(`/dm/${conv.peer}`)}
                    >
                      <div style="width:42px; height:42px; border-radius:50%; background:var(--color-dm); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:var(--font-size-md); flex-shrink:0; overflow:hidden">
                        <Show when={dmProf()?.avatar_cid} fallback={<span>{dmName().slice(0, 1).toUpperCase()}</span>}>
                          <img src={getClient().getMediaUrl(dmProf()!.avatar_cid!)} alt="" style="width:42px; height:42px; border-radius:50%; object-fit:cover" />
                        </Show>
                      </div>
                      <div style="flex:1; overflow:hidden">
                        <div style="display:flex; justify-content:space-between; align-items:center">
                          <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--color-text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis">{dmName()}</span>
                          <Show when={conv.last_message_at}>
                            <span style="font-size:11px; color:var(--color-text-secondary); flex-shrink:0; margin-left:8px">{new Date(conv.last_message_at < 1e12 ? conv.last_message_at * 1000 : conv.last_message_at).toLocaleDateString()}</span>
                          </Show>
                        </div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px">
                          <span style="font-size:var(--font-size-xs); color:var(--color-text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis">{conv.last_message_preview || '...'}</span>
                          <Show when={conv.unread_count > 0}>
                            <span style="min-width:20px; height:20px; border-radius:9999px; background:var(--color-accent-primary); color:var(--color-text-inverse); font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; padding:0 5px; flex-shrink:0; margin-left:4px">{conv.unread_count}</span>
                          </Show>
                        </div>
                      </div>
                    </button>
                  );
                }}
              </For>
            </Show>
          </Show>
        </Show>
      </div>

      <Show when={authStatus() !== 'ready'}>
        <div style="padding:12px; border-top:1px solid var(--color-border)">
          <button style="width:100%; padding:10px; background:var(--color-accent-primary); color:var(--color-text-inverse); border-radius:var(--radius-md); font-weight:600; cursor:pointer"
            onClick={() => go('/wallet')}>{t('wallet_connect')}</button>
        </div>
      </Show>

      <style>{`
        .modern-menu-item {
          display:block; width:100%; text-align:left; padding:8px 12px;
          font-size:var(--font-size-sm); border-radius:var(--radius-sm); cursor:pointer;
          color:var(--color-text-primary);
        }
        .modern-menu-item:hover { background:var(--color-bg-tertiary); }
      `}</style>
      <Show when={!isMobileViewport()}>
        <div class="sidebar-resize-handle" onMouseDown={onResizeStart} />
      </Show>
    </aside>
  );

  // Channel & member context menus shared between Modern and Classic styles.
  // Previously these lived inside the classic-fallback aside, so Modern users
  // got the right-click event handler but no menu UI ever mounted — meaning
  // no way to leave/delete a channel, no way to kick/ban a member, etc.
  //
  // The inline <style> block here is critical: the `.channel-context-menu`
  // rules used to live inside the classic aside's <style>, which never
  // renders in Modern. Without `position: fixed` and `display: block` on
  // items, the menu becomes a flex child of `.app-body` and consumes layout
  // space, breaking the main window. Co-locating the CSS with the menus
  // ensures it applies in any style.
  const sharedContextMenus = () => (
    <>
      <style>{`
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
      `}</style>
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
    </>
  );

  return (
    <>
    <Show when={isModernStyle()} fallback={
    <aside
      class={`sidebar ${isMobileViewport() ? 'mobile-open' : ''}`}
      style={isMobileViewport() ? undefined : { width: `${sidebarWidth()}px`, 'min-width': `${sidebarWidth()}px` }}
    >
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
                    <span class="channel-hash">{channel.channel_type === 2 ? '🔒' : channel.channel_type === 1 ? '📢' : '#'}</span>
                    <span class="channel-name">{channel.display_name || channel.slug}</span>
                    <Show when={(mentionCounts()[String(channel.channel_id)] ?? 0) > 0}>
                      <span class="mention-badge" title={t('sidebar_mentioned_here')}>@</span>
                    </Show>
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

      {/* Context menus are rendered at top-level (see end of return) so they
          appear in both Modern and Classic styles. */}


      <style>{`
        .sidebar {
          position: relative;
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
        .mention-badge {
          margin-left: auto;
          background: var(--color-warning, #f59e0b);
          color: #fff;
          font-size: 10px;
          font-weight: 700;
          padding: 1px 6px;
          border-radius: var(--radius-full);
          min-width: 18px;
          text-align: center;
        }
        /* When both badges are present, the second sits next to the first. */
        .mention-badge + .unread-badge { margin-left: var(--spacing-xs); }
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
        .sidebar-resize-handle {
          position: absolute; top: 0; right: -3px; width: 6px; height: 100%;
          cursor: col-resize; z-index: 20; background: transparent; transition: background 0.15s;
        }
        .sidebar-resize-handle:hover, .sidebar-resize-handle:active { background: var(--color-accent-primary); }
      `}</style>
      <Show when={!isMobileViewport()}>
        <div class="sidebar-resize-handle" onMouseDown={onResizeStart} />
      </Show>
    </aside>
    }>
      {modernSidebar()}
    </Show>
    {sharedContextMenus()}
    </>
  );
};
