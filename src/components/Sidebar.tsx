/**
 * Sidebar — main navigation with collapsible channels.
 *
 * Structure: News, Channels (collapsible, default collapsed),
 * Messages, Bookmarks, Search, Settings.
 */

import { Component, JSX, createResource, createSignal, createEffect, createMemo, For, Show, onCleanup } from 'solid-js';
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  createDraggable,
  createDroppable,
  closestCenter,
  type DragEvent,
} from '@thisbeyond/solid-dnd';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { onWsEvent } from '../lib/ws';
import { coverChannelMembers, rotateChannelKey } from '../lib/channelCrypto';
import { authStatus, walletAddress } from '../lib/auth';
import { navigate, route } from '../lib/router';
import { getSetting, setSetting } from '../lib/settings';
import { resolveProfile, type CachedProfile } from '../lib/profile';
import { ownAvatar } from '../lib/ownAvatar';
import { isMobileViewport, showMobileDetail, showMobileList, mobileListOpen } from '../lib/mobile-nav';
import { isModernStyle } from '../lib/theme';
import { getTheme, setTheme } from '../lib/theme';
import { disconnectWallet } from '../lib/auth';
// Desktop-only: tray icon badge — reflects total unread count on the OS tray.
import { updateTrayBadge } from '../lib/trayBadge';
import {
  joinedSignal,
  addJoinedChannel,
  removeJoinedChannel,
  syncJoinedWithApi,
} from '../lib/joined-channels';
import {
  channelOrg,
  resolveSidebarLayout,
  isGroupCollapsed,
  toggleGroupCollapsed,
  createGroup,
  renameGroup,
  deleteGroup,
  reorderGroups,
  setBucketOrder,
  assignChannel,
  clearPlacement,
  resetToAlphabetical,
  DEFAULT_CHANNEL_SLUG,
  type OrgChannel,
  type ResolvedGroup,
} from '../lib/channel-org';
import { downloadChannelOrg } from '../lib/settings-sync';
import { vaultExportKey } from '../lib/vault';

// Re-exported for existing importers (ChannelJoinView, ChannelCreateView) that
// historically imported these from the Sidebar; the implementation now lives in
// lib/joined-channels so non-UI code can auto-join without importing this file.
export { addJoinedChannel, removeJoinedChannel };

/** Sentinel droppable id for the ungrouped bucket (group ids are uuids). */
const UNGROUPED_BUCKET = '__ungrouped__';

/**
 * A channel row that is both draggable (by channel id) and a droppable target
 * (so other channels can be positioned relative to it). The actual row markup
 * is supplied by the caller as children, so each sidebar style keeps its own
 * look. The dragged original is dimmed; a DragOverlay renders the floating copy.
 */
const DraggableChannel: Component<{ id: number; children: JSX.Element }> = (props) => {
  const draggable = createDraggable(props.id);
  const droppable = createDroppable(props.id);
  return (
    <div
      ref={(el) => { draggable.ref(el); droppable.ref(el); }}
      {...draggable.dragActivators}
      class="org-channel-draggable"
      classList={{ 'org-drop-over': droppable.isActiveDroppable }}
      style={draggable.isActiveDraggable ? 'opacity:0.4; touch-action:none' : 'touch-action:none'}
    >
      {props.children}
    </div>
  );
};

/** A bucket container (a group body or the ungrouped list) that accepts drops. */
const DroppableBucket: Component<{ id: string; children: JSX.Element }> = (props) => {
  const droppable = createDroppable(props.id);
  return (
    <div
      ref={droppable.ref}
      class="org-bucket"
      classList={{ 'org-drop-over': droppable.isActiveDroppable }}
    >
      {props.children}
    </div>
  );
};

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
  const [dmContextMenu, setDmContextMenu] = createSignal<{ x: number; y: number; address: string; unread: number } | null>(null);

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

  // Avatar shown in the burger menu (the OWN user). Prefer the locally-cached
  // own avatar (renders on any node, even IPFS-less ones); else the node's
  // media URL if the profile carries an avatar_cid; else null → initials.
  const burgerAvatarSrc = (): string | null => {
    const cached = ownAvatar();
    if (cached) return cached.dataUrl;
    const cid = burgerProfile().avatar_cid;
    return cid ? getClient().getMediaUrl(cid) : null;
  };

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

  // Shared across both the Modern tabbed sidebar and the Classic/
  // Glassmorphism nav-item sidebar — keeps the "which pill is lit"
  // logic identical between design styles. The URL query wins when
  // present (set by the pill click handlers via `?feed=`), otherwise
  // we fall back to the saved default. Re-evaluated reactively because
  // it calls `route()`.
  const currentFeedMode = (): 'global' | 'following' => {
    const q = route().query.feed;
    if (q === 'following' || q === 'global') return q;
    return getSetting('defaultFeed') === 'following' ? 'following' : 'global';
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
  const [dmConversations, { refetch: refetchDmConvs }] = createResource(
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

  // Right-click "mark as read" for a DM conversation (mirrors the channel menu).
  const handleDmContextMenu = (e: MouseEvent, address: string, unread: number) => {
    e.preventDefault();
    setDmContextMenu({ x: e.clientX, y: e.clientY, address, unread });
  };

  const handleDmMarkRead = async () => {
    const ctx = dmContextMenu();
    if (!ctx) return;
    setDmContextMenu(null);
    try {
      await getClient().markDmRead(ctx.address);
      setDmUnreadTotal((t) => Math.max(0, t - (ctx.unread || 0)));
      refetchDmConvs();
    } catch { /* ignore */ }
  };

  // Close context menus on any click
  const closeContextMenu = () => { setContextMenu(null); setDmContextMenu(null); };
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

  // --- Channel organization (groups + custom ordering) ---
  // Resolved, ordered sidebar layout. Reacts to both the channel list and the
  // synced organization. The search box still filters within the resolved list.
  const layout = createMemo(() => resolveSidebarLayout(channels() as OrgChannel[], channelOrg()));

  // Apply a free-text filter to a list of channels (Modern search box).
  const filterList = (list: OrgChannel[]): OrgChannel[] => {
    const q = searchQuery().trim().toLowerCase();
    if (!q) return list;
    return list.filter((ch) =>
      (ch.display_name || '').toLowerCase().includes(q) || ch.slug.toLowerCase().includes(q),
    );
  };

  // Auto-pull the synced organization once when the wallet becomes ready, so a
  // fresh device shows the user's groups + ordering. Best-effort, LWW-guarded.
  let orgPulled = false;
  createEffect(() => {
    if (authStatus() === 'ready' && !orgPulled) {
      orgPulled = true;
      vaultExportKey().then((key) => { if (key) downloadChannelOrg(key).catch(() => {}); }).catch(() => {});
    }
  });

  // --- Group editing UI state ---
  const [groupMenu, setGroupMenu] = createSignal<{ x: number; y: number; groupId: string } | null>(null);
  const [renamingGroup, setRenamingGroup] = createSignal<string | null>(null);
  // Close on any click OUTSIDE the trigger button or the menu itself. We cannot
  // rely on stopPropagation here: SolidJS delegates onClick to the document, so
  // the opening click reaches this sibling document listener regardless — a
  // target check is the robust pattern (same as the burger menu).
  const closeGroupMenu = (e: MouseEvent) => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest('.org-group-menu-btn') || tgt.closest('.sidebar-context-menu')) return;
    setGroupMenu(null);
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('click', closeGroupMenu);
    onCleanup(() => document.removeEventListener('click', closeGroupMenu));
  }

  const handleNewGroup = () => {
    const id = createGroup(t('sidebar_new_group_default'));
    if (id) setRenamingGroup(id);
  };

  const commitRename = (id: string, value: string) => {
    const v = value.trim();
    if (v) renameGroup(id, v);
    setRenamingGroup(null);
  };

  const handleDeleteGroup = (id: string) => {
    setGroupMenu(null);
    if (window.confirm(t('sidebar_delete_group_confirm'))) deleteGroup(id);
  };

  const moveGroup = (id: string, dir: -1 | 1) => {
    setGroupMenu(null);
    const ids = layout().groups.map((rg) => rg.group.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorderGroups(ids);
  };

  // Aggregate unread for a collapsed group header.
  const groupUnread = (g: ResolvedGroup): number =>
    g.channels.reduce((sum, ch) => sum + (unreadCounts()[String(ch.channel_id)] ?? 0), 0);

  // --- Channel drag-and-drop (reorder within / move across groups) ---
  // Droppable ids are bucket ids (group uuid or UNGROUPED_BUCKET, both strings);
  // draggable ids are channel ids (numbers). That type split lets us tell a drop
  // onto a container apart from a drop onto another channel.
  const [draggedChannel, setDraggedChannel] = createSignal<OrgChannel | null>(null);

  /** The ordered channel ids currently shown in a bucket. */
  const bucketIds = (bucket: string): number[] => {
    const l = layout();
    if (bucket === UNGROUPED_BUCKET) return l.ungrouped.map((c) => c.channel_id);
    const g = l.groups.find((rg) => rg.group.id === bucket);
    return g ? g.channels.map((c) => c.channel_id) : [];
  };

  /** Which bucket a channel currently lives in. */
  const bucketOfChannel = (channelId: number): string => {
    const l = layout();
    for (const g of l.groups) {
      if (g.channels.some((c) => c.channel_id === channelId)) return g.group.id;
    }
    return UNGROUPED_BUCKET;
  };

  const onDragStart = ({ draggable }: DragEvent) => {
    const id = Number(draggable.id);
    const ch = (channels() as OrgChannel[]).find((c) => c.channel_id === id) ?? null;
    setDraggedChannel(ch);
  };

  const onDragEnd = ({ draggable, droppable }: DragEvent) => {
    setDraggedChannel(null);
    if (!draggable || !droppable) return;
    const draggedId = Number(draggable.id);
    const overId = droppable.id;
    let targetBucket: string;
    let index: number;
    if (typeof overId === 'number') {
      targetBucket = bucketOfChannel(overId);
      const ids = bucketIds(targetBucket);
      index = ids.indexOf(overId);
    } else {
      targetBucket = String(overId);
      index = bucketIds(targetBucket).length; // dropped on the container → append
    }
    if (index < 0) index = bucketIds(targetBucket).length;

    const ids = bucketIds(targetBucket).filter((id) => id !== draggedId);
    ids.splice(Math.min(index, ids.length), 0, draggedId);
    const groupId = targetBucket === UNGROUPED_BUCKET ? null : targetBucket;
    setBucketOrder(groupId, ids);
  };

  // --- Shared grouped-list rendering (used by both Modern and Classic) ---

  /** A group section header: collapse toggle, name / inline rename, kebab menu. */
  const groupHeader = (rg: ResolvedGroup) => {
    const g = rg.group;
    return (
      <div class="org-group-header">
        <Show
          when={renamingGroup() === g.id}
          fallback={
            <button class="org-group-toggle" onClick={() => toggleGroupCollapsed(g.id)} title={g.name}>
              <span class={`collapse-arrow ${!isGroupCollapsed(g.id) ? 'open' : ''}`}>▸</span>
              <span class="org-group-name">{g.name}</span>
              <Show when={isGroupCollapsed(g.id) && groupUnread(rg) > 0}>
                <span class="unread-badge">{groupUnread(rg)}</span>
              </Show>
            </button>
          }
        >
          {/* Rename input is a SIBLING of the toggle button, never nested inside
              it (an <input> in a <button> is invalid and not editable). */}
          <input
            class="org-group-rename"
            value={g.name}
            ref={(el) => setTimeout(() => el.focus(), 0)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(g.id, e.currentTarget.value);
              else if (e.key === 'Escape') setRenamingGroup(null);
            }}
            onBlur={(e) => commitRename(g.id, e.currentTarget.value)}
          />
        </Show>
        <Show when={renamingGroup() !== g.id}>
          <button
            class="org-group-menu-btn"
            title={t('sidebar_group_options')}
            onClick={(e) => { e.stopPropagation(); setGroupMenu({ x: e.clientX, y: e.clientY, groupId: g.id }); }}
          >⋯</button>
        </Show>
      </div>
    );
  };

  /** The floating group context menu (rename / delete / move up-down). */
  const groupMenuEl = () => (
    <Show when={groupMenu()}>
      {(menu) => (
        <div class="sidebar-context-menu" style={`left:${menu().x}px; top:${menu().y}px`} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setRenamingGroup(menu().groupId); setGroupMenu(null); }}>{t('sidebar_rename_group')}</button>
          <button onClick={() => moveGroup(menu().groupId, -1)}>{t('sidebar_move_up')}</button>
          <button onClick={() => moveGroup(menu().groupId, 1)}>{t('sidebar_move_down')}</button>
          <button class="danger" onClick={() => handleDeleteGroup(menu().groupId)}>{t('sidebar_delete_group')}</button>
        </div>
      )}
    </Show>
  );

  /**
   * Render the full grouped + drag-and-drop channel list. `renderRow` supplies
   * each style's own channel-row markup; the default channel is pinned first and
   * is never draggable.
   */
  const renderGroupedChannels = (renderRow: (ch: OrgChannel) => JSX.Element) => {
    const l = layout();
    return (
      <DragDropProvider collisionDetector={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <DragDropSensors />
        <Show when={l.defaultChannel}>{renderRow(l.defaultChannel!)}</Show>
        <For each={l.groups}>
          {(rg) => (
            <div class="org-group">
              {groupHeader(rg)}
              <Show when={!isGroupCollapsed(rg.group.id)}>
                <DroppableBucket id={rg.group.id}>
                  <For each={filterList(rg.channels)}>
                    {(ch) => <DraggableChannel id={ch.channel_id}>{renderRow(ch)}</DraggableChannel>}
                  </For>
                  <Show when={rg.channels.length === 0}>
                    <div class="org-group-empty">{t('sidebar_group_empty')}</div>
                  </Show>
                </DroppableBucket>
              </Show>
            </div>
          )}
        </For>
        {/* Divider before the ungrouped channels, but only when there is at
            least one group above them — keeps the un-customized list clean. */}
        <Show when={l.groups.length > 0 && filterList(l.ungrouped).length > 0}>
          <div class="org-ungrouped-header">{t('sidebar_ungrouped')}</div>
        </Show>
        <DroppableBucket id={UNGROUPED_BUCKET}>
          <For each={filterList(l.ungrouped)}>
            {(ch) => <DraggableChannel id={ch.channel_id}>{renderRow(ch)}</DraggableChannel>}
          </For>
        </DroppableBucket>
        <DragOverlay>
          <Show when={draggedChannel()}>
            <div class="org-drag-overlay">
              {(draggedChannel()!.display_name || draggedChannel()!.slug)}
            </div>
          </Show>
        </DragOverlay>
      </DragDropProvider>
    );
  };

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
        // audit 2026-06-07 B4.1: fallback must include `mentions` so the union keeps the field
        client.getUnreadCounts().catch(() => ({ unread: {}, mentions: {} })),
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
      // Keep the DM conversation list fresh while sitting on the DMs tab — the
      // resource otherwise only refetches on tab change / mark-read, so a brand-new
      // incoming conversation wouldn't appear until you navigated away and back.
      if (activeTab() === 'dms') refetchDmConvs();
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
      pollTimer = setInterval(pollData, 12000);
    }
  });
  onCleanup(() => { if (pollTimer) clearInterval(pollTimer); });

  // Live: a new incoming DM should surface a brand-new conversation in the list
  // immediately (not only after the 12s poll or a tab switch).
  const dmWsCleanup = onWsEvent((event) => {
    if (event.type === 'dm') {
      refetchDmConvs();
      void pollData();
    }
  });
  onCleanup(dmWsCleanup);

  const currentChannelId = () => {
    const r = route();
    if (r.view === 'chat' && r.params.channelId) {
      return parseInt(r.params.channelId, 10);
    }
    return null;
  };

  // Live private-channel membership changes (member-targeted push from our node):
  //  - someone joined a channel I'm in → wrap the channel epoch key to them so they
  //    can read (E2E: only a member's client holds the key — no node custody). This
  //    is the reliable key-delivery path; it no longer depends on me actively viewing
  //    the channel when a new member joins.
  //  - I got kicked/banned → drop the channel locally + bounce out of its view.
  const memberWsCleanup = onWsEvent((event) => {
    if (event.type !== 'channel_members_changed') return;
    const ev = event as { channel_id: number; action: string; member: string; key_epoch_floor?: number };
    const me = walletAddress();
    const isMe = !!me && !!ev.member && ev.member.toLowerCase() === me.toLowerCase();
    if (isMe && (ev.action === 'kick' || ev.action === 'ban')) {
      removeJoinedChannel(ev.channel_id);
      window.dispatchEvent(new Event('ogmara:channels-changed'));
      if (currentChannelId() === ev.channel_id) navigate('/news');
      return;
    }
    if (ev.action === 'join' && !isMe && joinedSignal().has(ev.channel_id)) {
      void coverChannelMembers(ev.channel_id);
    }
    // P2d: a removal raised the channel's key-epoch floor — re-key to it (wrapping
    // a fresh key to the remaining members only) so the removed member can't read
    // future messages. Any remaining member may rotate; FWW converges. Runs app-wide
    // (even if I'm not viewing the channel) so rotation isn't deferred to a mod's view.
    if ((ev.action === 'kick' || ev.action === 'ban' || ev.action === 'leave')
        && !isMe && ev.key_epoch_floor && joinedSignal().has(ev.channel_id)) {
      void rotateChannelKey(ev.channel_id, ev.key_epoch_floor);
    }
  });
  onCleanup(memberWsCleanup);

  // Channel deleted by its creator: drop it locally + bounce out of its view,
  // same as the kick/ban handling above. Reaches every member's node (host or
  // federated) via the node's channel_deleted broadcast — without this the
  // channel just sits in the sidebar forever since "joined channels" is a
  // client-local list, not something that resyncs from the server on its own.
  const channelDeletedWsCleanup = onWsEvent((event) => {
    if (event.type !== 'channel_deleted') return;
    const ev = event as { channel_id: number };
    removeJoinedChannel(ev.channel_id);
    window.dispatchEvent(new Event('ogmara:channels-changed'));
    if (currentChannelId() === ev.channel_id) navigate('/news');
  });
  onCleanup(channelDeletedWsCleanup);

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
                  <Show
                    when={burgerAvatarSrc()}
                    fallback={
                      <span style="width:36px; height:36px; border-radius:50%; background:var(--color-accent-bg); color:var(--color-accent-primary); display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; flex-shrink:0">
                        {(burgerProfile().display_name || walletAddress() || '').slice(0, 2).toUpperCase()}
                      </span>
                    }
                  >
                    <img src={burgerAvatarSrc()!} alt="" style="width:36px; height:36px; border-radius:50%; object-fit:cover; flex-shrink:0" />
                  </Show>
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
          {/* Organize bar: create a new group / reset to alphabetical */}
          <Show when={authStatus() === 'ready'}>
            <div class="org-toolbar">
              <button class="org-toolbar-btn" onClick={handleNewGroup} title={t('sidebar_new_group')}>
                <span style="font-size:14px">🗂</span> {t('sidebar_new_group')}
              </button>
              <button class="org-toolbar-btn" onClick={resetToAlphabetical} title={t('sidebar_sort_az')}>A→Z</button>
            </div>
          </Show>
          {renderGroupedChannels((channel) => {
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
          })}
          {groupMenuEl()}
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
            // `currentFeedMode` is now hoisted to the component scope so the
            // Classic/Glassmorphism sidebar below shares the same logic. Kept
            // as a function call (not memoised here) because the surrounding
            // JSX is already inside a `<Show when={...}>` reactive block.
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
                      onContextMenu={(e) => handleDmContextMenu(e, conv.peer, conv.unread_count)}
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
                          <span style="font-size:var(--font-size-xs); color:var(--color-text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis">{conv.last_message_preview || (conv.last_message_at ? `🔒 ${t('dm_encrypted_preview')}` : '...')}</span>
                          <Show when={conv.unread_count > 0 && !isActive()}>
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
          {/* Move-to-group submenu — keyboard/touch-accessible alternative to drag */}
          <Show when={contextMenu()?.channelId !== undefined}>
            <div class="context-menu-label">{t('sidebar_move_to_group')}</div>
            <button class="context-menu-item" onClick={() => {
              const ctx = contextMenu(); setContextMenu(null);
              if (ctx) assignChannel(ctx.channelId, null);
            }}># {t('sidebar_ungrouped')}</button>
            <For each={layout().groups}>
              {(rg) => (
                <button class="context-menu-item" onClick={() => {
                  const ctx = contextMenu(); setContextMenu(null);
                  if (ctx) assignChannel(ctx.channelId, rg.group.id);
                }}>🗂 {rg.group.name}</button>
              )}
            </For>
            <button class="context-menu-item" onClick={() => {
              const ctx = contextMenu(); setContextMenu(null);
              if (!ctx) return;
              const id = createGroup(t('sidebar_new_group_default'));
              if (id) { assignChannel(ctx.channelId, id); setRenamingGroup(id); }
            }}>＋ {t('sidebar_new_group')}</button>
          </Show>
          <button class="context-menu-item context-menu-danger" onClick={async () => {
            const ctx = contextMenu();
            setContextMenu(null);
            if (!ctx) return;
            if (!window.confirm(t('channel_leave_confirm'))) return;
            try {
              await getClient().leaveChannel(ctx.channelId);
              removeJoinedChannel(ctx.channelId);
              clearPlacement(ctx.channelId); // drop its group placement (syncs)
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
                clearPlacement(ctx.channelId); // drop its group placement (syncs)
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

      {/* DM right-click menu — mark as read */}
      <Show when={dmContextMenu()}>
        <div
          class="channel-context-menu"
          style={{ left: `${dmContextMenu()!.x}px`, top: `${dmContextMenu()!.y}px` }}
        >
          <button class="context-menu-item" onClick={handleDmMarkRead}>
            ✓ {t('channel_mark_read')}
          </button>
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
      {/* News — split into Global / Following feed picker for parity with
          the Modern sidebar's pill UI. We keep the visual language of this
          design style (sidebar-nav-item rows, no descriptive sub-line) but
          mirror the same routing/active rules: each button writes a
          ?feed=... URL query and NewsView's createEffect auto-saves the
          choice as the user's default. The Following row is muted +
          padlocked when the user has no wallet — clicking it still
          navigates so the user lands on the value-prop card in NewsView
          (deliberate teaching moment, not a dead-end). */}
      <div class="sidebar-section">
        <button
          class={`sidebar-nav-item ${isView('news') && currentFeedMode() === 'global' ? 'active' : ''}`}
          onClick={() => go('/news?feed=global')}
          title={t('news_feed_global_desc')}
        >
          🌐 {t('news_feed_global')}
        </button>
        <button
          class={`sidebar-nav-item ${isView('news') && currentFeedMode() === 'following' ? 'active' : ''}`}
          onClick={() => go('/news?feed=following')}
          title={
            authStatus() !== 'ready'
              ? t('news_feed_following_locked_hint')
              : t('news_feed_following_desc')
          }
          style={authStatus() !== 'ready' ? 'opacity:0.65' : ''}
        >
          👥 {t('news_feed_following')}
          <Show when={authStatus() !== 'ready'}>
            <span style="margin-left:6px; font-size:11px">🔒</span>
          </Show>
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
              onClick={handleNewGroup}
              title={t('sidebar_new_group')}
            >
              🗂
            </button>
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
            {renderGroupedChannels((channel) => (
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
            ))}
            {groupMenuEl()}
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
