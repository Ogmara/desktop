/**
 * ChatView — channel messaging with real-time updates, emoji picker,
 * profile resolution, and optimistic message display.
 */

import { Component, createResource, createSignal, createEffect, createMemo, For, Show, onCleanup, untrack } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { authStatus, getSigner, walletAddress, isRegistered } from '../lib/auth';
// Desktop tracks `wsConnected` so we can pause polling while the WS is alive
// (avoids the duplicate-messages bug fixed in v1.15.1).
import { onWsEvent, wsSubscribeChannels, wsUnsubscribeChannels, wsConnected } from '../lib/ws';
import { canPost, CHANNEL_TYPE_READ_PUBLIC } from '@ogmara/sdk';
import { MentionPopover } from '../components/MentionPopover';
import { navigate } from '../lib/router';
import { setSetting } from '../lib/settings';
import { FormattedText } from '../components/FormattedText';
import { EmojiPicker } from '../components/EmojiPicker';
import { MediaUpload, type MediaAttachment } from '../components/MediaUpload';
import { getPayloadContent, getPayloadAttachments, getPayloadMentions, decodePayload } from '../lib/payload';
import { resolveProfile, type CachedProfile } from '../lib/profile';
import { showMobileList } from '../lib/mobile-nav';
import { isModernStyle } from '../lib/theme';
import { buildChatShareUrl, copyToClipboard } from '../lib/share';
import { queryParam, route } from '../lib/router';

/** Convert a msg_id (hex string, byte array, or Uint8Array) to a consistent hex string. */
function msgIdToHex(msgId: unknown): string {
  if (typeof msgId === 'string') return msgId;
  if (msgId instanceof Uint8Array) {
    return Array.from(msgId).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (Array.isArray(msgId)) {
    return msgId.map((b: number) => b.toString(16).padStart(2, '0')).join('');
  }
  return String(msgId);
}

/** Extract the reply_to msg_id from a message's payload as a hex string, or null. */
function getReplyToHex(msg: any): string | null {
  if (msg.reply_to_preview?.msg_id) return msgIdToHex(msg.reply_to_preview.msg_id);
  try {
    const decoded = decodePayload(msg.payload);
    if (decoded.reply_to) return msgIdToHex(decoded.reply_to);
  } catch { /* ignore */ }
  return null;
}

/** Normalize timestamps — handles ISO strings, numeric strings, and unix seconds/ms. */
function normalizeTs(timestamp: string | number): number {
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    if (!isNaN(parsed)) return parsed;
    const num = Number(timestamp);
    if (!isNaN(num)) return num < 1e12 ? num * 1000 : num;
    return 0;
  }
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

/** Format message time in user's local timezone. */
function formatMessageTime(timestamp: string | number): string {
  return new Date(normalizeTs(timestamp)).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });
}

/** Get a date label for message grouping. */
function getDateLabel(timestamp: string | number): string {
  const date = new Date(normalizeTs(timestamp));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = today.getTime() - msgDay.getTime();
  if (diff === 0) return t('today') || 'Today';
  if (diff === 86400000) return t('yesterday') || 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Per-channel role cache. Avoids refetching 200 members on every switch.
 * TTL is long enough for fast back-and-forth navigation, short enough that
 * a freshly-promoted moderator picks up their elevated role within ~minutes.
 * `ROLE_CACHE_MAX` caps the map so a long-running session that visits many
 * channels doesn't accumulate entries indefinitely (oldest evicted on insert). */
const ROLE_CACHE_TTL = 30_000;
const ROLE_CACHE_MAX = 200;
type RoleEntry = { role: 'creator' | 'moderator' | 'member'; expires: number };
const roleCache = new Map<string, RoleEntry>();
function roleCacheKey(channelId: number, address: string): string {
  return `${channelId}:${address}`;
}
function roleCacheGet(channelId: number, address: string): RoleEntry['role'] | null {
  const k = roleCacheKey(channelId, address);
  const e = roleCache.get(k);
  if (!e) return null;
  if (e.expires < Date.now()) { roleCache.delete(k); return null; }
  // Promote on read so LRU eviction prefers truly stale entries.
  roleCache.delete(k);
  roleCache.set(k, e);
  return e.role;
}
function roleCacheSet(channelId: number, address: string, role: RoleEntry['role']): void {
  const k = roleCacheKey(channelId, address);
  roleCache.delete(k);
  roleCache.set(k, { role, expires: Date.now() + ROLE_CACHE_TTL });
  // Evict oldest insertion until under cap. `Map` iterates insertion order.
  while (roleCache.size > ROLE_CACHE_MAX) {
    const oldest = roleCache.keys().next().value;
    if (oldest === undefined) break;
    roleCache.delete(oldest);
  }
}

interface ChatViewProps {
  channelId: number | null;
}

export const ChatView: Component<ChatViewProps> = (props) => {
  const [messageInput, setMessageInput] = createSignal('');
  // Resolved klever addresses chosen via the @-mention popover. Merged with
  // any raw @klv1... addresses pasted into the text on send.
  const [pendingMentions, setPendingMentions] = createSignal<string[]>([]);
  const [replyTo, setReplyTo] = createSignal<{ msgId: string; author: string; preview: string } | null>(null);
  const [localMessages, setLocalMessages] = createSignal<any[]>([]);
  const [sending, setSending] = createSignal(false);
  const [showEmoji, setShowEmoji] = createSignal(false);
  const [profiles, setProfiles] = createSignal<Map<string, CachedProfile>>(new Map());
  const [userMenu, setUserMenu] = createSignal<{ x: number; y: number; address: string; msgId: string } | null>(null);
  const [myRole, setMyRole] = createSignal<'creator' | 'moderator' | 'member'>('member');
  const [expandedMuted, setExpandedMuted] = createSignal<Set<string>>(new Set());
  const [editingMsg, setEditingMsg] = createSignal<{ msgId: string; content: string } | null>(null);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [attachments, setAttachments] = createSignal<MediaAttachment[]>([]);
  const EDIT_WINDOW_MS = 30 * 60 * 1000;
  const GROUP_WINDOW_MS = 2 * 60 * 1000;
  const SCROLL_NEAR_BOTTOM_PX = 150;
  // Signal-backed ref so the MentionPopover's effect re-runs once the
  // textarea is mounted (refs assigned to plain `let` variables aren't
  // reactive). Setter is called from `ref={(el) => setInputRef(el)}`.
  const [inputRef, setInputRef] = createSignal<HTMLTextAreaElement>();
  let messagesRef: HTMLDivElement | undefined;
  const [showScrollBtn, setShowScrollBtn] = createSignal(false);
  const [newMsgCount, setNewMsgCount] = createSignal(0);
  const [floatingDate, setFloatingDate] = createSignal<string | null>(null);
  let floatingDateTimer: ReturnType<typeof setTimeout> | null = null;
  const [ctxEmojiExpanded, setCtxEmojiExpanded] = createSignal(false);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  // Viewport clamping for context menu
  const MENU_ESTIMATED_WIDTH = 200;
  const MENU_ESTIMATED_HEIGHT = 360;
  const MENU_EDGE_MARGIN = 8;
  const openUserMenu = (clientX: number, clientY: number, address: string, msgId: string) => {
    const maxX = window.innerWidth - MENU_ESTIMATED_WIDTH - MENU_EDGE_MARGIN;
    const maxY = window.innerHeight - MENU_ESTIMATED_HEIGHT - MENU_EDGE_MARGIN;
    setCtxEmojiExpanded(false);
    setUserMenu({
      x: Math.max(MENU_EDGE_MARGIN, Math.min(clientX, maxX)),
      y: Math.max(MENU_EDGE_MARGIN, Math.min(clientY, maxY)),
      address, msgId,
    });
  };

  // Long-press for mobile context menu
  const handleTouchStart = (e: TouchEvent, msg: any) => {
    if (longPressTimer) clearTimeout(longPressTimer);
    const touch = e.touches[0];
    const msgHex = msgIdToHex(msg.msg_id);
    longPressTimer = setTimeout(() => {
      openUserMenu(touch.clientX, touch.clientY, msg.author, msgHex);
    }, 500);
  };
  const cancelLongPress = () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } };

  // Close user context menu on click outside
  let ctxMenuRef: HTMLDivElement | undefined;
  if (typeof document !== 'undefined') {
    const closeUserMenu = (e: MouseEvent) => {
      if (ctxMenuRef && ctxMenuRef.contains(e.target as Node)) return;
      setUserMenu(null);
    };
    document.addEventListener('click', closeUserMenu);
    onCleanup(() => document.removeEventListener('click', closeUserMenu));
  }

  /** Brief toast shown when a share-link copy succeeds/fails. */
  const [shareToast, setShareToast] = createSignal<string | null>(null);
  let shareToastTimer: ReturnType<typeof setTimeout> | null = null;
  const flashShareToast = (msg: string) => {
    setShareToast(msg);
    if (shareToastTimer) clearTimeout(shareToastTimer);
    shareToastTimer = setTimeout(() => setShareToast(null), 2000);
  };
  onCleanup(() => { if (shareToastTimer) clearTimeout(shareToastTimer); });

  const handleUserAction = async (action: string) => {
    const ctx = userMenu();
    if (!ctx || !props.channelId) return;
    setUserMenu(null);

    const client = getClient();
    const targetMsg = msgById().get(ctx.msgId);
    try {
      switch (action) {
        case 'profile':
          navigate(`/user/${ctx.address}`);
          break;
        case 'copy-link': {
          const url = buildChatShareUrl(props.channelId, ctx.msgId);
          if (!url) { flashShareToast(t('share_link_failed')); break; }
          const ok = await copyToClipboard(url);
          flashShareToast(ok ? t('share_link_copied') : t('share_link_failed'));
          break;
        }
        case 'reply':
          if (targetMsg) handleReply(targetMsg);
          break;
        case 'edit':
          if (targetMsg) startEdit(targetMsg);
          break;
        case 'delete':
          if (targetMsg) await handleDelete(targetMsg);
          break;
        case 'kick':
          if (window.confirm(`Kick ${ctx.address.slice(0, 12)}...?`))
            await client.kickUser(props.channelId, ctx.address);
          break;
        case 'ban': {
          const reason = window.prompt(t('channel_ban_reason'));
          if (reason !== null)
            await client.banUser(props.channelId, ctx.address, reason || undefined);
          break;
        }
        case 'mute':
          await client.muteUser({ channelId: props.channelId, targetUser: ctx.address, durationSecs: 3600 });
          break;
        case 'pin':
          await client.pinMessage(props.channelId, ctx.msgId);
          break;
        case 'report': {
          const reason = window.prompt(t('report_reason'));
          if (reason !== null) {
            await client.reportMessage(ctx.msgId, (reason || 'No reason provided').slice(0, 500), 'other');
          }
          break;
        }
      }
    } catch { /* ignore */ }
  };

  const scrollToBottom = () => {
    if (messagesRef) messagesRef.scrollTo({ top: messagesRef.scrollHeight, behavior: 'smooth' });
  };

  const handleScroll = () => {
    if (!messagesRef) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesRef;
    const distFromBottom = scrollHeight - scrollTop - clientHeight;
    setShowScrollBtn(distFromBottom >= SCROLL_NEAR_BOTTOM_PX);
    if (distFromBottom < SCROLL_NEAR_BOTTOM_PX) setNewMsgCount(0);
    // Lazy-load older messages when user scrolls near the top.
    if (scrollTop < SCROLL_LOAD_OLDER_PX && hasMoreOlder() && !loadingOlder()) {
      loadOlderMessages();
    }
    const rows = messagesRef.querySelectorAll('[data-msg-id]');
    let topDate: string | null = null;
    for (const row of rows) {
      const rect = (row as HTMLElement).getBoundingClientRect();
      if (rect.bottom > messagesRef.getBoundingClientRect().top) {
        const msgId = (row as HTMLElement).dataset.msgId;
        if (msgId) { const msg = msgById().get(msgId); if (msg) topDate = getDateLabel(msg.timestamp); }
        break;
      }
    }
    setFloatingDate(topDate);
    if (floatingDateTimer) clearTimeout(floatingDateTimer);
    floatingDateTimer = setTimeout(() => setFloatingDate(null), 2000);
  };

  let lastChannelId: number | null = null;
  let prevMsgCount = 0;
  let initialLoad = true;
  const [lastReadTs, setLastReadTs] = createSignal<number | null>(null);
  // Dynamic page sizing: 50 by default, grow to fit unread + 20 lines of context.
  // Capped at 200 to keep first-paint fast; user can scroll up for more.
  const INITIAL_PAGE = 50;
  const OLDER_PAGE = 50;
  const MAX_INITIAL = 200;
  // Hard ceiling on `localMessages` to prevent unbounded growth in a long
  // session of repeated scroll-ups. Higher than `MAX_LOCAL_MESSAGES` (which
  // governs WS receive) because user-initiated scroll-up is intentional and
  // shouldn't drop messages they just brought in.
  const MAX_TOTAL_MESSAGES = 1000;
  const SCROLL_LOAD_OLDER_PX = 80;
  const [hasMoreOlder, setHasMoreOlder] = createSignal(true);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  // AbortController for the in-flight initial fetch, so a fast channel-switch
  // cancels the previous request instead of letting it pile up on the main
  // thread and clobber state out of order.
  let initFetchAbort: AbortController | null = null;
  const [messages] = createResource(
    () => ({ channelId: props.channelId, auth: authStatus() }),
    async ({ channelId }) => {
      if (!channelId) return [];
      // Only clear local messages on channel switch
      if (channelId !== lastChannelId) {
        setLocalMessages([]);
        lastChannelId = channelId;
        prevMsgCount = 0;
        initialLoad = true;
        setLastReadTs(null);
        setHasMoreOlder(true);
        // Reset loading flag so the new channel's first scroll-to-top can
        // load older messages even if the previous channel had a fetch in
        // flight when we switched away.
        setLoadingOlder(false);
      }
      // Mark prior in-flight fetch as stale. The SDK doesn't accept an
      // AbortSignal yet — the underlying fetch still runs to completion,
      // but we discard its result via `myToken.aborted` so state doesn't
      // get clobbered out of order on rapid channel switches.
      if (initFetchAbort) initFetchAbort.abort();
      initFetchAbort = new AbortController();
      const myAbort = initFetchAbort;
      try {
        const client = getClient();
        // Probe channel unread count so we can size the initial page so that
        // the first unread message is visible *with* some older context, not
        // pushed off the top. Only meaningful for signed-in users.
        let limit = INITIAL_PAGE;
        if (authStatus() === 'ready') {
          try {
            const unreadResp = await client.getUnreadCounts();
            if (myAbort.signal.aborted) return [];
            const n = unreadResp?.unread?.[String(channelId)] ?? 0;
            if (n > 0) limit = Math.min(MAX_INITIAL, Math.max(INITIAL_PAGE, n + 20));
          } catch { /* fall back to default page size */ }
        }
        const resp = await client.getChannelMessages(channelId, limit);
        if (myAbort.signal.aborted) return [];
        if (resp.last_read_ts !== undefined) setLastReadTs(resp.last_read_ts);
        // Defensive: hard-cap the response at the requested limit. Protects
        // against a malicious or buggy node returning more rows than asked,
        // which would otherwise blow up render and the profile-resolver fan-out.
        const capped = (resp.messages || []).slice(0, limit);
        // If we got fewer messages than asked for, there's nothing older.
        if (capped.length < limit) setHasMoreOlder(false);
        return capped;
      } catch {
        return [];
      }
    },
  );

  /** Load an older page and prepend it without flicker. */
  const loadOlderMessages = async () => {
    const channelId = props.channelId;
    if (!channelId || loadingOlder() || !hasMoreOlder()) return;
    const all = allMessages();
    if (all.length === 0) return;
    // Find the oldest non-optimistic msg to use as the `before` cursor
    let oldestId: string | null = null;
    for (const m of all) {
      const id = msgIdToHex(m.msg_id);
      if (id && !id.startsWith('local-')) { oldestId = id; break; }
    }
    if (!oldestId) return;
    setLoadingOlder(true);
    // Capture scroll metrics so we can preserve viewport position after prepend
    const el = messagesRef;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    const prevScrollTop = el?.scrollTop ?? 0;
    try {
      const client = getClient();
      const resp = await client.getChannelMessages(channelId, OLDER_PAGE, oldestId);
      // Channel-switch race guard: if the user navigated to a different
      // channel while we were waiting for the response, drop the result —
      // otherwise we'd prepend channel A's history into channel B's state.
      if (props.channelId !== channelId) return;
      // Defensive: hard-cap response at the requested limit (server can be
      // malicious or buggy and return more than asked).
      const older = (resp.messages || []).slice(0, OLDER_PAGE);
      if (older.length < OLDER_PAGE) setHasMoreOlder(false);
      if (older.length === 0) return;
      setLocalMessages((prev) => {
        const seen = new Set(prev.map((m) => msgIdToHex(m.msg_id)));
        const fresh = older.filter((m: any) => !seen.has(msgIdToHex(m.msg_id)));
        const merged = [...fresh, ...prev];
        // Cap total. Trim the *newest* end (which is API-resourced and will
        // be re-fetched on a future channel revisit) rather than the just-
        // loaded older page the user explicitly requested.
        return merged.length > MAX_TOTAL_MESSAGES
          ? merged.slice(0, MAX_TOTAL_MESSAGES)
          : merged;
      });
      // Restore scroll position so the user stays anchored on the same row
      requestAnimationFrame(() => {
        if (!el) return;
        const delta = el.scrollHeight - prevScrollHeight;
        el.scrollTop = prevScrollTop + delta;
      });
    } catch {
      /* leave hasMoreOlder true so user can retry by scrolling */
    } finally {
      setLoadingOlder(false);
    }
  };

  const [pinnedMessages] = createResource(
    () => ({ channelId: props.channelId, auth: authStatus() }),
    async ({ channelId }) => {
      if (!channelId) return [];
      try {
        const client = getClient();
        const resp = await client.getChannelPins(channelId);
        return resp.pinned_messages;
      } catch {
        return [];
      }
    },
  );

  const [channelInfo] = createResource(
    () => ({ channelId: props.channelId, auth: authStatus() }),
    async ({ channelId }) => {
      if (!channelId) return null;
      try { return await getClient().getChannel(channelId); }
      catch { return null; }
    },
  );

  // Fetch current user's channel role for permission gating.
  // Cache hits avoid a 200-member fetch on every channel switch — role rarely
  // changes mid-session, and refetching adds latency and pressure on the node.
  createEffect(() => {
    const id = props.channelId;
    const me = walletAddress();
    if (!id || !me) { setMyRole('member'); return; }
    const cached = roleCacheGet(id, me);
    if (cached) { setMyRole(cached); return; }
    getClient().getChannelMembers(id, { limit: 200 }).then((resp) => {
      const member = resp.members.find((m) => m.address === me);
      const role = (member?.role as any) ?? 'member';
      roleCacheSet(id, me, role);
      setMyRole(role);
    }).catch(() => setMyRole('member'));
  });

  const isMod = () => myRole() === 'moderator' || myRole() === 'creator';

  // Whether the current viewer may post in this channel under the runtime
  // posting policy (protocol spec §3.6). False in `ReadPublic` (broadcast)
  // channels for non-creator/non-mod members. Reactions stay enabled
  // independently — they're rendered per-message, not in the composer.
  const canPostHere = () => {
    const ch = channelInfo()?.channel;
    const me = walletAddress();
    if (!ch || !me) return true; // before-load: don't flash the banner
    return canPost(
      { channel_type: ch.channel_type, creator: ch.creator },
      me,
      isMod(),
    );
  };
  const isBroadcastChannel = () =>
    (channelInfo()?.channel?.channel_type ?? 0) === CHANNEL_TYPE_READ_PUBLIC;

  const MAX_LOCAL_MESSAGES = 200;

  // Subscribe to channel WebSocket events
  const wsCleanup = onWsEvent((event) => {
    if (event.type === 'message' && props.channelId) {
      const msg = event.envelope;
      if (msg.channel_id === props.channelId || msg.channel_id === String(props.channelId)) {
        // Handle edit/delete events by updating existing messages
        if (msg.msg_type === 'ChatEdit' || msg.msg_type === 'ChatDelete') {
          const targetId = msg.target_msg_id || msg.msg_id;
          if (targetId) {
            setLocalMessages((prev) => prev.map((m) => {
              if (msgIdToHex(m.msg_id) === msgIdToHex(targetId)) {
                if (msg.msg_type === 'ChatDelete') return { ...m, deleted: true };
                if (msg.msg_type === 'ChatEdit') return { ...m, payload: msg.payload, edited: true, last_edited_at: msg.timestamp };
              }
              return m;
            }));
            return;
          }
        }
        setLocalMessages((prev) => {
          // Remove optimistic messages that match this real message
          // (same author, timestamp within 10s)
          const filtered = prev.filter((m) => {
            if (!m._optimistic) return true;
            return !(m.author === msg.author &&
              Math.abs(normalizeTs(m.timestamp) - normalizeTs(msg.timestamp)) < 10000);
          });
          // Skip if already present (WS can re-deliver)
          if (filtered.some((m) => msgIdToHex(m.msg_id) === msgIdToHex(msg.msg_id))) return filtered;
          const next = [...filtered, msg];
          return next.length > MAX_LOCAL_MESSAGES ? next.slice(-MAX_LOCAL_MESSAGES) : next;
        });
        // Increment new-message badge if user is scrolled away
        if (messagesRef && msg.author !== walletAddress()) {
          const { scrollTop, scrollHeight, clientHeight } = messagesRef;
          if (scrollHeight - scrollTop - clientHeight >= SCROLL_NEAR_BOTTOM_PX) {
            setNewMsgCount((c) => c + 1);
          }
        }
        // Mark channel as read while viewing so unread badge doesn't appear.
        // Deferred to a microtask so the network request doesn't share the
        // current frame with the WS handler's reactive updates. Re-check
        // `authStatus()` inside the microtask so a logout-in-flight doesn't
        // sign the read-marker with a stale signer.
        if (authStatus() === 'ready') {
          const cid = props.channelId!;
          queueMicrotask(() => {
            if (authStatus() !== 'ready') return;
            getClient().markChannelRead(cid).catch(() => {});
          });
        }
      }
    }
  });
  onCleanup(wsCleanup);

  // Reactive channel subscription
  let prevChannelId: string | null = null;
  createEffect(() => {
    const id = props.channelId ? String(props.channelId) : null;
    if (prevChannelId) wsUnsubscribeChannels([prevChannelId]);
    if (id) {
      wsSubscribeChannels([id]);
      // Remember last opened channel for the Chat nav link
      setSetting('lastChannel', parseInt(id, 10));
      // Defer side effects so the channel-switch click doesn't share a frame
      // with the network request + reactive cascade. Keeps fast channel
      // hopping responsive. The auth re-check inside the microtask guards
      // against a logout-in-flight signing the read-marker with a stale
      // signer for the wrong wallet.
      queueMicrotask(() => {
        if (authStatus() !== 'ready') return;
        try { getClient().markChannelRead(parseInt(id, 10)).catch(() => {}); }
        catch { /* SDK method may not exist on older builds */ }
      });
      setTimeout(() => inputRef()?.focus(), 50);
    }
    prevChannelId = id;
  });
  onCleanup(() => {
    if (prevChannelId) wsUnsubscribeChannels([prevChannelId]);
  });

  // Deduplicate and sort messages
  const allMessages = createMemo(() => {
    const seen = new Set<string>();
    const apiMsgs = messages() || [];
    const local = localMessages();
    // Remove optimistic messages that now have a real counterpart from the API
    // (same author, similar timestamp, optimistic flag)
    const filteredLocal = local.filter((lm) => {
      if (!lm._optimistic) return true;
      return !apiMsgs.some((am) =>
        am.author === lm.author &&
        Math.abs(normalizeTs(am.timestamp) - normalizeTs(lm.timestamp)) < 10000,
      );
    });
    // localMessages first so optimistic updates (delete, edit, react) take priority in dedup
    const combined = [...filteredLocal, ...apiMsgs];
    const deduped = combined.filter((msg) => {
      const id = msgIdToHex(msg.msg_id);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    deduped.sort((a, b) => normalizeTs(a.timestamp) - normalizeTs(b.timestamp));
    return deduped;
  });

  // Resolve profiles for all unique authors
  createEffect(() => {
    const msgs = allMessages();
    const authors = new Set(msgs.map((m) => m.author));
    // Read `profiles()` via `untrack` so the effect only re-runs when the
    // message list changes — not on every individual setProfiles() resolve.
    // Without this, resolving N authors would re-iterate the full list N
    // times, an O(N²) feedback loop on every channel switch.
    untrack(() => {
      const have = profiles();
      authors.forEach((addr) => {
        if (!have.has(addr)) {
          resolveProfile(addr).then((p) => {
            setProfiles((prev) => {
              const next = new Map(prev);
              next.set(addr, p);
              return next;
            });
          });
        }
      });
    });
  });

  const getProfile = (addr: string) => profiles().get(addr);

  const displayName = (addr: string) => {
    const p = getProfile(addr);
    return p?.display_name || `${addr.slice(0, 8)}...${addr.slice(-4)}`;
  };

  /** Lookup map: hex msg_id -> message object. */
  const msgById = createMemo(() => {
    const map = new Map<string, any>();
    for (const msg of allMessages()) map.set(msgIdToHex(msg.msg_id), msg);
    return map;
  });

  /** Resolve a reply reference. */
  const resolveReply = (msg: any): { author: string; content: string; msgId: string } | null => {
    if (msg.reply_to_preview?.author) {
      return {
        author: msg.reply_to_preview.author,
        content: msg.reply_to_preview.content_preview || '...',
        msgId: msgIdToHex(msg.reply_to_preview.msg_id),
      };
    }
    const replyHex = getReplyToHex(msg);
    if (!replyHex) return null;
    const original = msgById().get(replyHex);
    if (original) {
      const content = getPayloadContent(original.payload);
      return {
        author: original.author,
        content: content.length > 100 ? content.slice(0, 100) + '...' : content,
        msgId: replyHex,
      };
    }
    return { author: '...', content: '(original message not loaded)', msgId: replyHex };
  };

  // Incremental poll fallback every 15s — fetch only new messages since the latest known msg_id
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const pollNewMessages = async () => {
    const channelId = props.channelId;
    if (!channelId) return;
    // Skip poll when WebSocket is connected — WS delivers messages in real
    // time, so polling would just produce duplicates (v1.15.1 fix).
    if (wsConnected()) return;
    const msgs = allMessages();
    if (msgs.length === 0) return;
    // Find the latest REAL message (skip optimistic ones with 'local-' ids)
    let latestMsgId: string | null = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const id = msgIdToHex(msgs[i].msg_id);
      if (id && !id.startsWith('local-')) { latestMsgId = id; break; }
    }
    if (!latestMsgId) return;
    try {
      const client = getClient();
      const resp = await client.getChannelMessages(channelId, 50, undefined, latestMsgId);
      // Channel-switch race guard: drop poll results if the user moved on
      // mid-fetch, otherwise we'd land them in the wrong channel's state.
      if (props.channelId !== channelId) return;
      // Defensive: hard-cap at 50 in case the server returns more than asked.
      const incoming = (resp.messages || []).slice(0, 50);
      if (incoming.length > 0) {
        setLocalMessages((prev) => {
          // Dedup: only add messages not already in localMessages
          const existingIds = new Set(prev.map((m) => msgIdToHex(m.msg_id)));
          const newMsgs = incoming.filter((m: any) => !existingIds.has(msgIdToHex(m.msg_id)));
          if (newMsgs.length === 0) return prev;
          const next = [...prev, ...newMsgs];
          return next.length > MAX_LOCAL_MESSAGES ? next.slice(-MAX_LOCAL_MESSAGES) : next;
        });
      }
    } catch { /* poll failure is non-critical */ }
  };
  createEffect(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (props.channelId) pollTimer = setInterval(pollNewMessages, 15000);
  });
  onCleanup(() => { if (pollTimer) clearInterval(pollTimer); });

  // Auto-scroll only when new messages arrive and user is near bottom
  createEffect(() => {
    if (messages.loading) return;
    const msgs = allMessages();
    const count = msgs.length;
    if (count === 0 || count === prevMsgCount) { prevMsgCount = count; return; }
    const wasMore = count > prevMsgCount;
    const isFirst = initialLoad;
    prevMsgCount = count;
    initialLoad = false;
    if (!wasMore && !isFirst) return;

    if (isFirst) {
      const scrollToEnd = () => {
        if (!messagesRef) return;
        const divider = messagesRef.querySelector('.unread-divider') as HTMLElement | null;
        if (divider) {
          messagesRef.scrollTop = Math.max(0, divider.offsetTop - 8);
        } else {
          messagesRef.scrollTop = messagesRef.scrollHeight;
        }
      };
      setTimeout(() => {
        scrollToEnd();
        if (messagesRef) {
          const imgs = messagesRef.querySelectorAll('img');
          let pending = 0;
          imgs.forEach((img) => {
            if (!img.complete) {
              pending++;
              img.addEventListener('load', () => { pending--; if (pending <= 0) scrollToEnd(); }, { once: true });
              img.addEventListener('error', () => { pending--; if (pending <= 0) scrollToEnd(); }, { once: true });
            }
          });
          setTimeout(scrollToEnd, 300);
        }
      }, 0);
    } else {
      setTimeout(() => {
        if (!messagesRef) return;
        const { scrollTop, scrollHeight, clientHeight } = messagesRef;
        if (scrollHeight - scrollTop - clientHeight < SCROLL_NEAR_BOTTOM_PX) {
          messagesRef.scrollTo({ top: messagesRef.scrollHeight, behavior: 'smooth' });
        }
      }, 0);
    }
  });

  // Deep-link consumer: when the URL carries `?msg=<hex>`, scroll to that
  // message once it's loaded. If it's older than the initial page, paginate
  // backwards up to a small limit before giving up.
  //
  // State is keyed by (channelId, target) so switching channels and returning
  // to the same `?msg=` value re-tries the lookup instead of silently no-oping.
  let deepLinkAttempts = 0;
  let deepLinkSatisfiedKey: string | null = null;
  const MAX_DEEPLINK_PAGINATES = 3;
  createEffect(() => {
    route();
    const targetRaw = queryParam('msg');
    const channelAtEntry = props.channelId;
    const target = targetRaw && /^[0-9a-fA-F]{64}$/.test(targetRaw) ? targetRaw : null;
    if (!target) { deepLinkSatisfiedKey = null; deepLinkAttempts = 0; return; }
    const key = `${channelAtEntry}:${target}`;
    if (deepLinkSatisfiedKey === key) return;
    if (messages.loading) return;
    setTimeout(() => {
      if (props.channelId !== channelAtEntry) return;
      const el = document.querySelector(`[data-msg-id="${CSS.escape(target)}"]`) as HTMLElement | null;
      if (el) {
        scrollToMessage(target);
        deepLinkSatisfiedKey = key;
        deepLinkAttempts = 0;
      } else if (hasMoreOlder() && deepLinkAttempts < MAX_DEEPLINK_PAGINATES && !loadingOlder()) {
        deepLinkAttempts++;
        loadOlderMessages();
      } else {
        deepLinkSatisfiedKey = key;
        deepLinkAttempts = 0;
        flashShareToast(t('share_link_unavailable'));
      }
    }, 100);
  });

  const handleSend = async () => {
    // Route to edit handler when in edit mode
    if (editingMsg()) { await handleEdit(); return; }

    const text = messageInput().trim();
    const atts = attachments();
    if ((!text && atts.length === 0) || !props.channelId) return;
    if (!getSigner() || !walletAddress()) { navigate('/wallet'); return; }

    setSending(true);
    setSendError(null);
    try {
      const client = getClient();
      const options: any = {};
      if (replyTo()) options.replyTo = replyTo()!.msgId;
      if (atts.length > 0) options.attachments = atts;
      // Merge mentions from two sources:
      //  1. raw @klv1... addresses present in the text (paste / power user)
      //  2. addresses chosen via the @-mention popover (display name resolved)
      const raw = text.match(/@(klv1[a-z0-9]{58})/g) ?? [];
      const merged = new Set([...pendingMentions(), ...raw.map((m) => m.slice(1))]);
      if (merged.size > 0) {
        options.mentions = Array.from(merged);
      }
      await client.sendMessage(props.channelId, text, options);

      // Optimistic: add message locally for instant display
      const addr = walletAddress() || '';
      setLocalMessages((prev) => [...prev, {
        msg_id: `local-${Date.now()}`,
        author: addr,
        timestamp: Date.now(),
        payload: text, // string payloads are handled by getPayloadContent
        _optimistic: true,
      }]);

      setMessageInput('');
      setReplyTo(null);
      setShowEmoji(false);
      setAttachments([]);
      setPendingMentions([]);
    } catch (err: any) {
      console.error('sendMessage failed:', err);
      const msg = err?.message || String(err);
      setSendError(msg);
      // Auto-clear error after 6 seconds
      setTimeout(() => setSendError(null), 6000);
    } finally {
      setSending(false);
      // Focus after sending is cleared (textarea is no longer disabled)
      setTimeout(() => inputRef()?.focus(), 0);
    }
  };

  const handleReply = (msg: any) => {
    const content = getPayloadContent(msg.payload);
    const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
    setReplyTo({ msgId: msgIdToHex(msg.msg_id), author: msg.author, preview });
    inputRef()?.focus();
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef();
    if (!el) return;
    const start = el.selectionStart ?? messageInput().length;
    const end = el.selectionEnd ?? start;
    const current = messageInput();
    setMessageInput(current.slice(0, start) + emoji + current.slice(end));
    // Restore cursor after emoji
    setTimeout(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  };

  const scrollToMessage = (msgId: string) => {
    const el = document.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('message-highlight');
      setTimeout(() => el.classList.remove('message-highlight'), 1500);
    }
  };

  const cancelReply = () => setReplyTo(null);

  const canEdit = (msg: any) =>
    isRegistered() &&
    msg.author === walletAddress() &&
    !msg.deleted &&
    (Date.now() - normalizeTs(msg.timestamp)) < EDIT_WINDOW_MS;

  const canDelete = (msg: any) =>
    isRegistered() && msg.author === walletAddress() && !msg.deleted;

  const startEdit = (msg: any) => {
    setEditingMsg({ msgId: msgIdToHex(msg.msg_id), content: getPayloadContent(msg.payload) });
    setMessageInput(getPayloadContent(msg.payload));
    inputRef()?.focus();
  };

  const cancelEdit = () => {
    setEditingMsg(null);
    setMessageInput('');
  };

  const handleEdit = async () => {
    const edit = editingMsg();
    const newContent = messageInput().trim();
    if (!edit || !newContent || !props.channelId) return;
    setSending(true);
    setSendError(null);
    try {
      const client = getClient();
      await client.editMessage(props.channelId, edit.msgId, newContent);
      // Optimistic update — add/update in localMessages so it wins in dedup
      setLocalMessages((prev) => {
        const updates = { payload: newContent, edited: true, last_edited_at: Date.now() };
        const exists = prev.some((m) => msgIdToHex(m.msg_id) === edit.msgId);
        if (exists) return prev.map((m) => msgIdToHex(m.msg_id) === edit.msgId ? { ...m, ...updates } : m);
        // Find original message in allMessages to clone
        const original = allMessages().find((m) => msgIdToHex(m.msg_id) === edit.msgId);
        return original ? [...prev, { ...original, ...updates }] : prev;
      });
      setEditingMsg(null);
      setMessageInput('');
    } catch (err: any) {
      // Surface the failure in the existing send-error banner so the user
      // gets feedback instead of a silent no-op. Previously this only
      // logged to console.warn, which is why edit failures in Modern
      // (where the only edit affordance is the right-click menu) felt
      // like the click did nothing at all.
      console.error('editMessage failed:', err);
      setSendError(err?.message || 'Edit failed');
      setTimeout(() => setSendError(null), 6000);
    } finally { setSending(false); }
  };

  const handleDelete = async (msg: any) => {
    if (!props.channelId) return;
    if (!window.confirm(t('chat_delete_confirm'))) return;
    try {
      const client = getClient();
      await client.deleteMessage(props.channelId, msgIdToHex(msg.msg_id));
      // Optimistic update — add/update in localMessages so it wins in dedup
      setLocalMessages((prev) => {
        const id = msgIdToHex(msg.msg_id);
        const exists = prev.some((m) => msgIdToHex(m.msg_id) === id);
        if (exists) return prev.map((m) => msgIdToHex(m.msg_id) === id ? { ...m, deleted: true } : m);
        return [...prev, { ...msg, deleted: true }];
      });
    } catch (e) {
      console.warn('Delete message failed:', e);
    }
  };

  // Track own reactions for highlighting
  const [ownReactions, setOwnReactions] = createSignal<Map<string, Set<string>>>(new Map());
  const hasOwnReaction = (msgId: string, emoji: string): boolean => {
    return ownReactions().get(msgId)?.has(emoji) ?? false;
  };

  const handleReact = async (msg: any, emoji: string) => {
    if (!props.channelId || !walletAddress()) return;
    try {
      const client = getClient();
      await client.reactToMessage(props.channelId, msgIdToHex(msg.msg_id), emoji);
      // Optimistic update — increment reaction count locally
      const id = msgIdToHex(msg.msg_id);
      const updateReactions = (m: any) => {
        const reactions = { ...(m.reactions || {}) };
        reactions[emoji] = (reactions[emoji] || 0) + 1;
        return { ...m, reactions };
      };
      setLocalMessages((prev) => {
        const exists = prev.some((m) => msgIdToHex(m.msg_id) === id);
        if (exists) return prev.map((m) => msgIdToHex(m.msg_id) === id ? updateReactions(m) : m);
        return [...prev, updateReactions(msg)];
      });
      // Track own reaction for badge highlighting
      setOwnReactions((prev) => {
        const next = new Map(prev);
        const set = new Set(next.get(id) || []);
        set.add(emoji);
        next.set(id, set);
        return next;
      });
    } catch (e) {
      console.warn('React to message failed:', e);
    }
  };

  return (
    <div class="chat-view">
      <Show
        when={props.channelId}
        fallback={<div class="chat-empty"><p>{t('chat_no_channel')}</p></div>}
      >
        {/* Channel header bar */}
        <Show when={isModernStyle()} fallback={
          <div class="channel-bar">
            <Show when={pinnedMessages() && pinnedMessages()!.length > 0}>
              <span class="pinned-info">
                <span class="pinned-icon">📌</span>
                <span class="pinned-count">{pinnedMessages()!.length} {t('channel_pins')}</span>
              </span>
            </Show>
            <button class="channel-settings-btn" onClick={() => navigate(`/chat/${props.channelId}/settings`)} title={t('channel_settings')}>⚙</button>
          </div>
        }>
          <div class="channel-bar">
            <button class="channel-back-btn content-back-btn" onClick={() => showMobileList()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
            </button>
            <div class="channel-bar-info" onClick={() => navigate(`/chat/${props.channelId}/settings`)}>
              <div class="channel-bar-avatar">
                <Show
                  when={channelInfo()?.channel?.logo_cid}
                  fallback={<span>{(channelInfo()?.channel?.display_name || 'C').slice(0, 1).toUpperCase()}</span>}
                >
                  <img class="channel-bar-avatar-img" src={getClient().getMediaUrl(channelInfo()!.channel!.logo_cid!)} alt="" />
                </Show>
              </div>
              <div class="channel-bar-text">
                <div class="channel-bar-title">{channelInfo()?.channel?.display_name || channelInfo()?.channel?.slug || `Channel #${props.channelId}`}</div>
                <div class="channel-bar-meta">
                  <span class="channel-bar-members">{t('chat_member_count', { count: channelInfo()?.member_count || '?' })}</span>
                </div>
              </div>
            </div>
            <div class="channel-bar-actions">
              <button class="channel-action-btn" title={t('nav_search')}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
              <button class="channel-action-btn" onClick={() => navigate(`/chat/${props.channelId}/settings`)} title={t('channel_settings')}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
              </button>
            </div>
          </div>
        </Show>

        <div class="chat-messages-wrap" style="position:relative; flex:1; display:flex; flex-direction:column; overflow:hidden">
          <Show when={floatingDate()}>
            <div class="chat-date-float">
              <span class="date-separator-label">{floatingDate()}</span>
            </div>
          </Show>
        <div class="chat-messages" ref={messagesRef} onScroll={handleScroll}>
          <Show
            when={allMessages().length > 0}
            fallback={<div class="chat-empty"><p>{t('chat_no_messages')}</p></div>}
          >
            <For each={allMessages()}>
              {(msg, index) => {
                const msgs = allMessages();
                const prevMsg = index() > 0 ? msgs[index() - 1] : null;
                const currentDate = getDateLabel(msg.timestamp);
                const prevDate = prevMsg ? getDateLabel(prevMsg.timestamp) : null;
                const showDateSep = currentDate !== prevDate;
                const reply = resolveReply(msg);
                const prof = () => getProfile(msg.author);
                const isOwn = msg.author === walletAddress();
                const isContinuation = !showDateSep && !reply && prevMsg
                  && prevMsg.author === msg.author
                  && !prevMsg.deleted && !msg.deleted
                  && (Math.abs(normalizeTs(msg.timestamp) - normalizeTs(prevMsg.timestamp)) < GROUP_WINDOW_MS);

                const readTs = lastReadTs();
                const msgTs = normalizeTs(msg.timestamp);
                const prevMsgTs = prevMsg ? normalizeTs(prevMsg.timestamp) : 0;
                const showUnreadDivider = readTs !== null && msgTs > readTs && (prevMsgTs <= readTs || !prevMsg) && !isOwn;
                const msgHex = msgIdToHex(msg.msg_id);
                // Highlight bubbles where the viewer (wallet address) is @-mentioned
                // — but skip own messages so self-mentions don't light up.
                const viewerAddr = walletAddress();
                const mentionedHere = !isOwn && !msg.deleted && !msg.muted && !!viewerAddr
                  && getPayloadMentions(msg.payload).includes(viewerAddr);

                return (
                  <>
                    <Show when={showUnreadDivider}>
                      <div class="unread-divider"><span class="unread-divider-label">{t('chat_new_messages')}</span></div>
                    </Show>
                    <Show when={showDateSep}>
                      <div class="date-separator"><span class="date-separator-label">{currentDate}</span></div>
                    </Show>
                    <Show when={isModernStyle()} fallback={
                      /* ---------- CLASSIC / OTHER STYLES ---------- */
                      <div
                        class={`message ${isOwn ? 'own' : ''} ${msg.deleted ? 'deleted' : ''} ${msg.muted ? 'muted' : ''} ${isContinuation ? 'continuation' : ''} ${mentionedHere ? 'mentioned' : ''}`}
                        data-msg-id={msgHex}
                        title={mentionedHere ? t('chat_mention_you') : undefined}
                        onContextMenu={(e) => { e.preventDefault(); openUserMenu(e.clientX, e.clientY, msg.author, msgHex); }}
                        onTouchStart={(e) => handleTouchStart(e, msg)} onTouchEnd={cancelLongPress} onTouchMove={cancelLongPress}
                      >
                        <Show when={reply && !msg.deleted}>
                          <div class="reply-preview" onClick={() => scrollToMessage(reply!.msgId)}>
                            <span class="reply-preview-author">{displayName(reply!.author)}</span>
                            <span class="reply-preview-text">{reply!.content}</span>
                          </div>
                        </Show>
                        <Show when={!isContinuation}>
                          <div class="message-header">
                            <Show when={prof()?.avatar_cid} fallback={
                              <span class="msg-avatar-placeholder">{(prof()?.display_name || msg.author).slice(0, 2).toUpperCase()}</span>
                            }>
                              <img class="msg-avatar" src={getClient().getMediaUrl(prof()!.avatar_cid!)} alt="" />
                            </Show>
                            <span class="message-author" onClick={() => navigate(`/user/${msg.author}`)}>{displayName(msg.author)}</span>
                            <Show when={prof()?.verified}><span class="msg-verified">✓</span></Show>
                            <span class="message-time">{formatMessageTime(msg.timestamp)}<Show when={msg.edited}><span class="edited-indicator"> ({t('message_edited')})</span></Show></span>
                          </div>
                        </Show>
                        <Show when={!msg.deleted} fallback={<div class="message-body message-deleted-text">{t('message_deleted')}</div>}>
                          <Show when={!msg.muted || expandedMuted().has(msgHex)} fallback={
                            <div class="message-body message-muted-text" onClick={() => setExpandedMuted(prev => { const next = new Set(prev); next.add(msgHex); return next; })}>{t('message_muted_show')}</div>
                          }>
                            <div class="message-body"><FormattedText content={getPayloadContent(msg.payload)} attachments={getPayloadAttachments(msg.payload)} /></div>
                          </Show>
                        </Show>
                        <Show when={walletAddress() && !msg.deleted}>
                          <div class="msg-react-hover">
                            {['👍', '👎', '❤️', '🔥', '😂', '😮'].map((emoji) => (
                              <button class="react-hover-btn" onClick={() => handleReact(msg, emoji)}>{emoji}</button>
                            ))}
                          </div>
                        </Show>
                        <Show when={msg.reactions && Object.keys(msg.reactions).length > 0}>
                          <div class="message-reactions">
                            {Object.entries(msg.reactions as Record<string, number>).map(([emoji, count]) => (
                              <span class="reaction-badge">{emoji} {count}</span>
                            ))}
                          </div>
                        </Show>
                      </div>
                    }>
                      {/* ---------- MODERN STYLE ---------- */}
                      <div
                        class={`message-row ${isOwn ? 'own' : ''} ${msg.deleted ? 'deleted' : ''} ${msg.muted ? 'muted' : ''} ${isContinuation ? 'continuation' : ''}`}
                        data-msg-id={msgHex}
                        onContextMenu={(e) => { e.preventDefault(); openUserMenu(e.clientX, e.clientY, msg.author, msgHex); }}
                        onTouchStart={(e) => handleTouchStart(e, msg)} onTouchEnd={cancelLongPress} onTouchMove={cancelLongPress}
                      >
                        <Show when={!isOwn}>
                          <div class="message-avatar-col">
                            <Show when={!isContinuation}>
                              <Show when={prof()?.avatar_cid} fallback={
                                <div class="msg-avatar-placeholder" onClick={() => navigate(`/user/${msg.author}`)}>{(prof()?.display_name || msg.author).slice(0, 2).toUpperCase()}</div>
                              }>
                                <img class="msg-avatar" src={getClient().getMediaUrl(prof()!.avatar_cid!)} alt="" onClick={() => navigate(`/user/${msg.author}`)} />
                              </Show>
                            </Show>
                          </div>
                        </Show>
                        <div
                          class={`message-bubble ${isOwn ? 'own' : ''} ${msg.deleted ? 'deleted' : ''} ${mentionedHere ? 'mentioned' : ''}`}
                          title={mentionedHere ? t('chat_mention_you') : undefined}
                        >
                          <Show when={reply && !msg.deleted}>
                            <div class="reply-preview" onClick={() => scrollToMessage(reply!.msgId)}>
                              <span class="reply-preview-author">{displayName(reply!.author)}</span>
                              <span class="reply-preview-text">{reply!.content}</span>
                            </div>
                          </Show>
                          <Show when={!isContinuation && !isOwn}>
                            <div class="message-header">
                              <span class="message-author" onClick={() => navigate(`/user/${msg.author}`)}>{displayName(msg.author)}</span>
                              <Show when={prof()?.verified}><span class="msg-verified">✓</span></Show>
                            </div>
                          </Show>
                          <Show when={!msg.deleted} fallback={<div class="message-body message-deleted-text">{t('message_deleted')}</div>}>
                            <Show when={!msg.muted || expandedMuted().has(msgHex)} fallback={
                              <div class="message-body message-muted-text" onClick={() => setExpandedMuted(prev => { const next = new Set(prev); next.add(msgHex); return next; })}>{t('message_muted_show')}</div>
                            }>
                              <div class="message-body">
                                <FormattedText content={getPayloadContent(msg.payload)} attachments={getPayloadAttachments(msg.payload)} />
                                <span class="message-meta-inline">
                                  <Show when={msg.edited}><span class="edited-indicator">{t('message_edited')}</span></Show>
                                  <span class="message-time">{formatMessageTime(msg.timestamp)}</span>
                                </span>
                              </div>
                            </Show>
                          </Show>
                          <Show when={msg.reactions && Object.keys(msg.reactions).length > 0}>
                            <div class="message-reactions">
                              {Object.entries(msg.reactions as Record<string, number>).map(([emoji, count]) => (
                                <button class={`reaction-badge ${hasOwnReaction(msgHex, emoji) ? 'reaction-own' : ''}`}
                                  onClick={() => walletAddress() && handleReact(msg, emoji)} disabled={!walletAddress()}>
                                  <span class="reaction-emoji">{emoji}</span><span class="reaction-count">{count}</span>
                                </button>
                              ))}
                            </div>
                          </Show>
                        </div>
                      </div>
                    </Show>
                  </>
                );
              }}
            </For>
          </Show>
        </div>

        {/* Send error banner */}
        <Show when={sendError()}>
          <div class="send-error-banner" onClick={() => setSendError(null)}>
            {sendError()}
          </div>
        </Show>

        {/* Broadcast (read-only) channel banner — shown to non-creator/non-mod
            members when channel_type is ReadPublic. Replaces the composer
            stack. Reactions on existing messages remain functional. */}
        <Show when={!canPostHere() && isBroadcastChannel()}>
          <div class="broadcast-banner" role="status" aria-live="polite">
            <span class="broadcast-banner-icon" aria-hidden="true">📢</span>
            <span class="broadcast-banner-text">{t('chat_broadcast_only')}</span>
          </div>
        </Show>

        {/* Edit mode indicator */}
        <Show when={canPostHere() && editingMsg()}>
          <div class="edit-indicator">
            <span class="edit-indicator-label">✏ {t('chat_edit_mode')}</span>
            <button class="edit-cancel" onClick={cancelEdit}>{t('chat_edit_cancel')}</button>
          </div>
        </Show>

        {/* Reply indicator */}
        <Show when={canPostHere() && replyTo() && !editingMsg()}>
          <div class="reply-indicator">
            <div class="reply-indicator-content">
              <span class="reply-indicator-author">{displayName(replyTo()!.author)}</span>
              <span class="reply-indicator-text">{replyTo()!.preview}</span>
            </div>
            <button class="reply-cancel" onClick={cancelReply}>✕</button>
          </div>
        </Show>

        {/* Media attachments */}
        <Show when={canPostHere() && walletAddress() && !editingMsg()}>
          <div class="chat-media-bar">
            <MediaUpload
              attachments={attachments()}
              onAttach={(a) => setAttachments((prev) => [...prev, a])}
              onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
              disabled={sending()}
            />
          </div>
        </Show>
          <Show when={showScrollBtn()}>
            <button class="scroll-to-bottom-btn" onClick={() => { scrollToBottom(); setNewMsgCount(0); setShowScrollBtn(false); }}>
              <Show when={newMsgCount() > 0}><span class="scroll-badge">{newMsgCount()}</span></Show>
              <span class="scroll-arrow">↓</span>
            </button>
          </Show>
        </div>

        {/* Input area — hidden in broadcast (ReadPublic) channels for non-mod members */}
        <Show when={canPostHere()}>
        {/* @-mention autocomplete popover — anchored to whichever textarea
            is currently bound to inputRef (Modern or Legacy). Inserts
            `@<DisplayName>` into the visible content while pushing the
            resolved klv1... address into pendingMentions, which the send
            handler merges with raw @klv1 mentions in the text. */}
        <MentionPopover
          textareaRef={inputRef}
          onSelect={(hit, range) => {
            const el = inputRef();
            if (!el) return;
            const insert = `@${hit.display_name && hit.display_name.trim() ? hit.display_name : hit.address.slice(0, 12)}`;
            const v = messageInput();
            const next = `${v.slice(0, range.start)}${insert} ${v.slice(range.end)}`;
            setMessageInput(next);
            setPendingMentions((prev) => Array.from(new Set([...prev, hit.address])));
            const newCursor = range.start + insert.length + 1;
            queueMicrotask(() => {
              el.focus();
              el.setSelectionRange(newCursor, newCursor);
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 160) + 'px';
            });
          }}
        />
        <Show when={isModernStyle()} fallback={
          <div class="chat-input-area">
            <div class="chat-input">
              <textarea
                ref={(el) => setInputRef(el)}
                class="chat-textarea"
                rows={3}
                placeholder={authStatus() === 'ready' ? t('chat_placeholder') : t('auth_connect_prompt')}
                value={messageInput()}
                onInput={(e) => setMessageInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && (messageInput().trim() || attachments().length > 0)) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                onPaste={(e) => {
                  if (!walletAddress()) return;
                  // Try web API first (clipboardData.items / .files)
                  let file: File | null = null;
                  const items = e.clipboardData?.items;
                  if (items) {
                    const imageItem = Array.from(items).find((i) => i.type.startsWith('image/'));
                    if (imageItem) file = imageItem.getAsFile();
                  }
                  if (!file && e.clipboardData?.files) {
                    file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/')) ?? null;
                  }
                  if (file) {
                    e.preventDefault();
                    const filename = `paste-${Date.now()}.${file.type.split('/')[1] || 'png'}`;
                    getClient().uploadMedia(file, filename)
                      .then((result) => {
                        setAttachments((prev) => [...prev, {
                          cid: result.cid,
                          mime_type: file!.type,
                          size_bytes: file!.size,
                          filename,
                          thumbnail_cid: result.thumbnail_cid,
                        }]);
                      }).catch((err: any) => {
                        setSendError(err?.message || 'Upload failed');
                        setTimeout(() => setSendError(null), 6000);
                      });
                    return;
                  }
                  // Tauri clipboard plugin fallback for webkit2gtk (Linux).
                  // The web API doesn't expose clipboard images on webkit2gtk;
                  // Tauri's plugin-clipboard-manager bridges to GTK directly.
                  const textBefore = messageInput();
                  (async () => {
                    try {
                      const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
                      const img = await readImage();
                      const { width, height } = await img.size();
                      if (width > 4096 || height > 4096) {
                        setSendError('Image too large (max 4096x4096)');
                        setTimeout(() => setSendError(null), 4000);
                        return;
                      }
                      // Image found — revert any text the default handler pasted.
                      setMessageInput(textBefore);
                      const rgba = await img.rgba();
                      const canvas = document.createElement('canvas');
                      canvas.width = width;
                      canvas.height = height;
                      const ctx = canvas.getContext('2d')!;
                      const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
                      ctx.putImageData(imageData, 0, 0);
                      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
                      if (!blob) return;
                      const pasteFile = new File([blob], `paste-${Date.now()}.png`, { type: 'image/png' });
                      const result = await getClient().uploadMedia(pasteFile, pasteFile.name);
                      setAttachments((prev) => [...prev, {
                        cid: result.cid,
                        mime_type: 'image/png',
                        size_bytes: pasteFile.size,
                        filename: pasteFile.name,
                        thumbnail_cid: result.thumbnail_cid,
                      }]);
                    } catch {
                      // No image in clipboard — text paste already happened.
                    }
                  })();
                }}
                disabled={sending() || !walletAddress()}
              />
              <div class="chat-input-actions">
                <div class="emoji-container">
                  <button class="emoji-toggle" onClick={() => walletAddress() && setShowEmoji(!showEmoji())} title="Emoji" disabled={!walletAddress()}>😊</button>
                  <Show when={showEmoji()}><EmojiPicker onSelect={insertEmoji} onClose={() => setShowEmoji(false)} /></Show>
                </div>
                <button class="send-btn" onClick={handleSend} disabled={sending() || (!messageInput().trim() && attachments().length === 0) || !walletAddress()}>{t('chat_send')}</button>
              </div>
            </div>
          </div>
        }>
          {/* Modern input: [emoji] [attach] [textarea] [send] */}
          <div class="chat-input-area">
            <div class="chat-input">
              <div class="emoji-container">
                <button class="input-icon-btn" onClick={() => walletAddress() && setShowEmoji(!showEmoji())} disabled={!walletAddress()}>😊</button>
                <Show when={showEmoji()}><EmojiPicker onSelect={insertEmoji} onClose={() => setShowEmoji(false)} /></Show>
              </div>
              <button class="input-icon-btn" onClick={() => walletAddress() && document.querySelector<HTMLInputElement>('.modern-attach-input')?.click()} disabled={!walletAddress()}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
              </button>
              <input type="file" class="modern-attach-input" style="display:none" onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (file && walletAddress()) {
                  getClient().uploadMedia(file, file.name).then((result) => {
                    setAttachments((p) => [...p, { cid: result.cid, mime_type: file.type || 'application/octet-stream', size_bytes: file.size, filename: file.name, thumbnail_cid: result.thumbnail_cid }]);
                  }).catch(() => {});
                }
                e.currentTarget.value = '';
              }} />
              <textarea
                ref={(el) => setInputRef(el)}
                class="chat-textarea"
                rows={1}
                placeholder={authStatus() === 'ready' ? t('chat_placeholder') : t('auth_connect_prompt')}
                value={messageInput()}
                onInput={(e) => { setMessageInput(e.currentTarget.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 160) + 'px'; }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && (messageInput().trim() || attachments().length > 0)) { e.preventDefault(); handleSend(); }
                }}
                onPaste={(e) => {
                  if (!walletAddress()) return;
                  // Try web API first (clipboardData.items / .files)
                  let file: File | null = null;
                  const items = e.clipboardData?.items;
                  if (items) {
                    const imageItem = Array.from(items).find((i) => i.type.startsWith('image/'));
                    if (imageItem) file = imageItem.getAsFile();
                  }
                  if (!file && e.clipboardData?.files) {
                    file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/')) ?? null;
                  }
                  if (file) {
                    e.preventDefault();
                    const filename = `paste-${Date.now()}.${file.type.split('/')[1] || 'png'}`;
                    getClient().uploadMedia(file, filename)
                      .then((r) => {
                        setAttachments((p) => [...p, {
                          cid: r.cid,
                          mime_type: file!.type,
                          size_bytes: file!.size,
                          filename,
                          thumbnail_cid: r.thumbnail_cid,
                        }]);
                      }).catch((err: any) => {
                        setSendError(err?.message || 'Upload failed');
                        setTimeout(() => setSendError(null), 6000);
                      });
                    return;
                  }
                  // Tauri clipboard plugin fallback for webkit2gtk (Linux).
                  const textBefore = messageInput();
                  (async () => {
                    try {
                      const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
                      const img = await readImage();
                      const { width, height } = await img.size();
                      if (width > 4096 || height > 4096) {
                        setSendError('Image too large (max 4096x4096)');
                        setTimeout(() => setSendError(null), 4000);
                        return;
                      }
                      setMessageInput(textBefore);
                      const rgba = await img.rgba();
                      const canvas = document.createElement('canvas');
                      canvas.width = width;
                      canvas.height = height;
                      const ctx = canvas.getContext('2d')!;
                      const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
                      ctx.putImageData(imageData, 0, 0);
                      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
                      if (!blob) return;
                      const pasteFile = new File([blob], `paste-${Date.now()}.png`, { type: 'image/png' });
                      const result = await getClient().uploadMedia(pasteFile, pasteFile.name);
                      setAttachments((p) => [...p, {
                        cid: result.cid,
                        mime_type: 'image/png',
                        size_bytes: pasteFile.size,
                        filename: pasteFile.name,
                        thumbnail_cid: result.thumbnail_cid,
                      }]);
                    } catch {
                      // No image in clipboard — text paste already happened.
                    }
                  })();
                }}
                disabled={sending() || !walletAddress()}
              />
              <button
                class="send-btn"
                onClick={handleSend}
                disabled={sending() || (!messageInput().trim() && attachments().length === 0) || !walletAddress()}
                title={t('chat_send')}
              >
                <svg class="send-btn-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
              </button>
            </div>
          </div>
        </Show>
        </Show>
      </Show>

      {/* User context menu */}
      <Show when={userMenu()}>
        <div
          class="user-context-menu"
          style={{ left: `${userMenu()!.x}px`, top: `${userMenu()!.y}px` }}
          ref={(el) => {
            ctxMenuRef = el;
            // Re-measure once mounted: the openUserMenu() pre-clamp uses an
            // estimated size; if the menu is taller (e.g. all moderator
            // actions visible), nudge it back into the viewport.
            if (!el) return;
            requestAnimationFrame(() => {
              const rect = el.getBoundingClientRect();
              if (rect.bottom > window.innerHeight - MENU_EDGE_MARGIN) {
                el.style.top = `${Math.max(MENU_EDGE_MARGIN, window.innerHeight - rect.height - MENU_EDGE_MARGIN)}px`;
              }
              if (rect.right > window.innerWidth - MENU_EDGE_MARGIN) {
                el.style.left = `${Math.max(MENU_EDGE_MARGIN, window.innerWidth - rect.width - MENU_EDGE_MARGIN)}px`;
              }
            });
          }}
        >
          {/* Emoji reactions — modern style shows expandable grid */}
          <Show when={isModernStyle() && walletAddress() && !msgById().get(userMenu()!.msgId)?.deleted}>
            {(() => {
              const quickEmojis = ['❤️', '😂', '👍', '🙏', '🔥', '👎'];
              const extraEmojis = ['😊','😍','🤔','😢','😤','🤯','🥳','👏','🤝','✌️','💪','👋','🧡','💛','💚','💙','💜','⭐','✨','💎','🎉','🎊'];
              const reactTo = (emoji: string) => {
                const m = msgById().get(userMenu()!.msgId);
                if (m) handleReact(m, emoji);
                setUserMenu(null);
              };
              return (
                <div style="border-bottom:1px solid var(--color-border); margin-bottom:4px">
                  <div style="display:flex; align-items:center; gap:2px; padding:4px 6px">
                    {quickEmojis.map((emoji) => (
                      <button style="font-size:20px; padding:4px 5px; border-radius:var(--radius-sm); cursor:pointer; line-height:1; transition:transform 0.1s" onClick={() => reactTo(emoji)}>{emoji}</button>
                    ))}
                    <button style="display:flex; align-items:center; justify-content:center; color:var(--color-text-secondary); margin-left:2px; padding:4px 5px; cursor:pointer"
                      onClick={(e) => { e.stopPropagation(); setCtxEmojiExpanded(!ctxEmojiExpanded()); }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d={ctxEmojiExpanded() ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} />
                      </svg>
                    </button>
                  </div>
                  <Show when={ctxEmojiExpanded()}>
                    <div style="display:flex; flex-wrap:wrap; gap:2px; padding:4px 6px; max-width:240px">
                      {extraEmojis.map((emoji) => (
                        <button style="font-size:20px; padding:4px 5px; border-radius:var(--radius-sm); cursor:pointer; line-height:1; transition:transform 0.1s" onClick={() => reactTo(emoji)}>{emoji}</button>
                      ))}
                    </div>
                  </Show>
                </div>
              );
            })()}
          </Show>
          <button class="ctx-item" onClick={() => handleUserAction('reply')}>↩ {t('chat_reply')}</button>
          <Show when={(() => { const m = msgById().get(userMenu()!.msgId); return m && canEdit(m); })()}>
            <button class="ctx-item" onClick={() => handleUserAction('edit')}>✏ {t('chat_edit')}</button>
          </Show>
          <Show when={(() => { const m = msgById().get(userMenu()!.msgId); return m && canDelete(m); })()}>
            <button class="ctx-item ctx-danger" onClick={() => handleUserAction('delete')}>🗑 {t('chat_delete')}</button>
          </Show>
          <div class="ctx-divider" />
          <button class="ctx-item" onClick={() => handleUserAction('profile')}>👤 {t('channel_view_profile')}</button>
          <button class="ctx-item" onClick={() => handleUserAction('copy-link')}>🔗 {t('share_message_link')}</button>
          <Show when={isMod()}>
            <button class="ctx-item" onClick={() => handleUserAction('pin')}>📌 {t('channel_pin_message')}</button>
          </Show>
          <Show when={walletAddress() && userMenu()!.address !== walletAddress()}>
            <button class="ctx-item" onClick={() => handleUserAction('report')}>🚩 {t('report_title')}</button>
          </Show>
          <Show when={isMod() && userMenu()!.address !== walletAddress()}>
            <div class="ctx-divider" />
            <button class="ctx-item ctx-warn" onClick={() => handleUserAction('mute')}>🔇 {t('channel_mute')}</button>
            <button class="ctx-item ctx-warn" onClick={() => handleUserAction('kick')}>⚡ {t('channel_kick')}</button>
            <button class="ctx-item ctx-danger" onClick={() => handleUserAction('ban')}>⛔ {t('channel_ban')}</button>
          </Show>
        </div>
      </Show>

      <Show when={shareToast()}>
        <div class="share-toast">{shareToast()}</div>
      </Show>

      <style>{`
        .chat-view { display: flex; flex-direction: column; height: 100%; height: 100dvh; max-height: -webkit-fill-available; }
        .chat-messages { flex: 1; overflow-y: auto; padding: var(--spacing-md); display: flex; flex-direction: column; }
        .chat-messages > * + * { margin-top: var(--spacing-sm); }
        .chat-messages > .message.continuation { margin-top: 0; }
        .chat-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--color-text-secondary); }
        .unread-divider {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm) 0;
        }
        .unread-divider::before, .unread-divider::after {
          content: '';
          flex: 1;
          border-top: 2px solid var(--color-accent-primary);
        }
        .unread-divider-label {
          font-size: var(--font-size-xs);
          color: var(--color-accent-primary);
          white-space: nowrap;
          font-weight: 700;
        }
        .date-separator {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm) 0;
        }
        .date-separator::before, .date-separator::after {
          content: '';
          flex: 1;
          border-top: 1px solid var(--color-border);
        }
        .date-separator-label {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          white-space: nowrap;
          font-weight: 600;
          background: var(--color-bg-tertiary);
          padding: 3px 10px;
          border-radius: var(--radius-full);
          border: 1px solid var(--color-border);
        }
        .chat-date-float {
          position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
          z-index: 5; pointer-events: none;
        }
        .chat-date-float .date-separator-label { pointer-events: auto; }
        .scroll-to-bottom-btn {
          position: absolute; bottom: var(--spacing-md); right: var(--spacing-md);
          width: 44px; height: 44px; border-radius: var(--radius-full);
          background: var(--color-bg-secondary); border: 1px solid var(--color-border);
          color: var(--color-text-primary); display: flex; align-items: center; justify-content: center;
          cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.25); z-index: 5;
        }
        .scroll-to-bottom-btn:hover { background: var(--color-bg-tertiary); }
        .scroll-arrow { font-size: 18px; }
        .scroll-badge {
          position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px;
          border-radius: var(--radius-full); background: var(--color-accent-primary);
          color: var(--color-text-inverse); font-size: 11px; font-weight: 700;
          display: flex; align-items: center; justify-content: center; padding: 0 5px;
        }
        .message {
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-lg);
          max-width: 85%;
          align-self: flex-start;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
        }
        .message.continuation {
          border-top-left-radius: var(--radius-sm);
          border-top-right-radius: var(--radius-sm);
          padding-top: 2px;
          border-top-color: transparent;
        }
        .message.own.continuation {
          border-top-right-radius: var(--radius-sm);
          border-top-left-radius: var(--radius-sm);
        }
        .msg-react-hover {
          display: none;
          position: absolute;
          top: -14px;
          right: var(--spacing-sm);
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-full);
          padding: 1px 4px;
          gap: 2px;
          box-shadow: 0 1px 4px rgba(0,0,0,0.2);
          z-index: 10;
        }
        .message { position: relative; }
        .message:has(.message-reactions) { min-width: 120px; }
        .message:hover .msg-react-hover { display: flex; }
        .message.own .msg-react-hover { right: auto; left: var(--spacing-sm); }
        .react-hover-btn {
          font-size: 14px;
          padding: 1px 3px;
          border-radius: var(--radius-sm);
          cursor: pointer;
          line-height: 1;
        }
        .react-hover-btn:hover { background: var(--color-bg-tertiary); transform: scale(1.2); }
        .message.own {
          align-self: flex-end;
          background: color-mix(in srgb, var(--color-accent-primary) 15%, var(--color-bg-secondary));
          color: var(--color-text-primary);
          border-color: color-mix(in srgb, var(--color-accent-primary) 40%, var(--color-border));
        }
        .message.own .message-author { color: var(--color-accent-primary); }
        .message.own .message-time { color: var(--color-text-secondary); }
        .message.own .reply-preview { background: rgba(0,0,0,0.15); border-left-color: var(--color-accent-primary); }
        .message-header { display: flex; gap: var(--spacing-sm); align-items: center; }
        .msg-avatar {
          width: 22px;
          height: 22px;
          border-radius: var(--radius-full);
          object-fit: cover;
          flex-shrink: 0;
        }
        .msg-avatar-placeholder {
          width: 22px;
          height: 22px;
          border-radius: var(--radius-full);
          background: var(--color-accent-secondary);
          color: var(--color-text-inverse);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 9px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .message-author {
          font-weight: 600;
          font-size: var(--font-size-sm);
          color: var(--color-accent-primary);
          cursor: pointer;
        }
        .message-author:hover { text-decoration: underline; }
        .msg-verified {
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
          flex-shrink: 0;
        }
        .message-time { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .message-body { margin-top: var(--spacing-xs); font-size: var(--font-size-md); line-height: 1.5; }
        .message.deleted .message-header { opacity: 0.5; }
        .message-deleted-text { font-style: italic; color: var(--color-text-secondary); opacity: 0.6; }
        .message.muted { opacity: 0.4; }
        .message-muted-text { font-style: italic; color: var(--color-text-secondary); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .message-muted-text:hover { opacity: 0.8; }
        .edited-indicator { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .message-reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: var(--spacing-xs); }
        .reaction-badge {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          padding: 2px 6px;
          font-size: var(--font-size-xs);
          background: var(--color-bg-tertiary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-full);
        }
        .inline-react-picker {
          display: flex;
          gap: 4px;
          padding: var(--spacing-xs) 0;
        }
        .inline-react-btn {
          font-size: var(--font-size-md);
          padding: 2px 4px;
          border-radius: var(--radius-sm);
          cursor: pointer;
        }
        .inline-react-btn:hover { background: var(--color-bg-tertiary); }
        .send-error-banner {
          padding: var(--spacing-xs) var(--spacing-md);
          background: var(--color-error);
          color: white;
          font-size: var(--font-size-sm);
          cursor: pointer;
          text-align: center;
        }
        .edit-indicator {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--spacing-xs) var(--spacing-md);
          background: var(--color-bg-tertiary);
          border-top: 1px solid var(--color-accent-primary);
          font-size: var(--font-size-sm);
        }
        .edit-indicator-label { color: var(--color-accent-primary); font-weight: 600; }
        .edit-cancel {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          cursor: pointer;
          padding: var(--spacing-xs) var(--spacing-sm);
          border-radius: var(--radius-sm);
        }
        .edit-cancel:hover { background: var(--color-bg-secondary); color: var(--color-text-primary); }

        .reply-preview {
          display: flex;
          flex-direction: column;
          border-left: 3px solid var(--color-accent-primary);
          background: var(--color-bg-tertiary);
          border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
          padding: var(--spacing-xs) var(--spacing-sm);
          margin-bottom: var(--spacing-xs);
          cursor: pointer;
          transition: background 0.15s;
          max-width: 400px;
        }
        .reply-preview:hover { background: var(--color-bg-secondary); }
        .reply-preview-author {
          font-size: var(--font-size-xs);
          font-weight: 700;
          color: var(--color-accent-primary);
          line-height: 1.3;
        }
        .reply-preview-text {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          line-height: 1.3;
        }

        .message-highlight { animation: msg-flash 1.5s ease-out; }
        @keyframes msg-flash {
          0% { background: var(--color-accent-primary); border-radius: var(--radius-sm); }
          100% { background: transparent; }
        }

        /* @-mention highlight: when a message @-mentions the viewer, render
           the bubble with a clearly different fill, an accent stripe on the
           left, and a soft outer glow so it's obvious at a glance. Uses
           existing theme accent tokens so it works in both light and dark. */
        .message.mentioned {
          background: color-mix(in srgb, var(--color-accent-primary) 16%, transparent);
          border-left: 3px solid var(--color-accent-primary);
          padding-left: calc(var(--spacing-md) - 3px);
          border-radius: var(--radius-sm);
        }
        .message-bubble.mentioned {
          /* Stronger tint than non-mention bubbles, plus a thicker accent
             border. The pseudo-element below paints a left stripe so the
             highlight is unmistakable even when the bubble sits flush with
             the avatar column. */
          position: relative;
          background: color-mix(in srgb, var(--color-accent-primary) 28%, var(--color-bg-secondary));
          border: 1px solid color-mix(in srgb, var(--color-accent-primary) 65%, transparent);
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent-primary) 35%, transparent),
                      0 2px 12px color-mix(in srgb, var(--color-accent-primary) 18%, transparent);
        }
        .message-bubble.mentioned::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 3px;
          background: var(--color-accent-primary);
          border-top-left-radius: inherit;
          border-bottom-left-radius: inherit;
        }
        .message-bubble.mentioned.own {
          background: color-mix(in srgb, var(--color-accent-primary) 35%, var(--color-accent-secondary, var(--color-accent-primary)));
        }

        /* Transient bottom-of-screen toast for share-link copy feedback. */
        .share-toast {
          position: fixed;
          left: 50%;
          bottom: 80px;
          transform: translateX(-50%);
          background: var(--color-bg-secondary);
          color: var(--color-text-primary);
          border: 1px solid var(--color-border);
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-md);
          box-shadow: 0 4px 16px rgba(0,0,0,0.3);
          z-index: 200;
          font-size: var(--font-size-sm);
          pointer-events: none;
          animation: share-toast-in 0.2s ease-out;
        }
        @keyframes share-toast-in {
          from { opacity: 0; transform: translate(-50%, 10px); }
          to   { opacity: 1; transform: translate(-50%, 0); }
        }

        .reply-indicator {
          display: flex;
          align-items: stretch;
          gap: var(--spacing-sm);
          padding: var(--spacing-xs) var(--spacing-md);
          background: var(--color-bg-tertiary);
          border-top: 1px solid var(--color-border);
        }
        .reply-indicator-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          border-left: 3px solid var(--color-accent-primary);
          padding-left: var(--spacing-sm);
          min-width: 0;
        }
        .reply-indicator-author { font-size: var(--font-size-xs); font-weight: 700; color: var(--color-accent-primary); }
        .reply-indicator-text {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .reply-cancel {
          cursor: pointer;
          color: var(--color-text-secondary);
          font-size: var(--font-size-md);
          align-self: center;
          padding: var(--spacing-xs);
        }
        .reply-cancel:hover { color: var(--color-text-primary); }

        .channel-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--spacing-xs) var(--spacing-md);
          border-bottom: 1px solid var(--color-border);
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
        }
        .pinned-info { display: flex; align-items: center; gap: var(--spacing-xs); }
        .pinned-icon { font-size: var(--font-size-md); }
        .pinned-count { color: var(--color-accent-primary); font-weight: 600; }
        .channel-settings-btn {
          font-size: var(--font-size-md);
          color: var(--color-text-secondary);
          cursor: pointer;
          padding: var(--spacing-xs);
          border-radius: var(--radius-sm);
        }
        .channel-settings-btn:hover { background: var(--color-bg-tertiary); color: var(--color-text-primary); }
        .user-context-menu {
          position: fixed;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          box-shadow: 0 2px 12px rgba(0,0,0,0.3);
          z-index: 100;
          padding: 4px;
          min-width: 170px;
        }
        .ctx-item {
          display: block;
          width: 100%;
          text-align: left;
          padding: var(--spacing-sm) var(--spacing-md);
          font-size: var(--font-size-sm);
          border-radius: var(--radius-sm);
          cursor: pointer;
          color: var(--color-text-primary);
        }
        .ctx-item:hover { background: var(--color-bg-tertiary); }
        .ctx-warn { color: var(--color-text-secondary); }
        .ctx-danger { color: #f44; }
        .ctx-danger:hover { background: rgba(255,68,68,0.1); }
        .ctx-divider { height: 1px; background: var(--color-border); margin: 4px 0; }

        .chat-media-bar {
          padding: var(--spacing-xs) var(--spacing-md);
          border-top: 1px solid var(--color-border);
        }
        .chat-input-area {
          border-top: 1px solid var(--color-border);
          padding: var(--spacing-sm) var(--spacing-md);
        }
        .chat-input {
          display: flex;
          gap: var(--spacing-sm);
          align-items: flex-end;
        }
        .chat-textarea {
          flex: 1;
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-family: inherit;
          font-size: var(--font-size-md);
          resize: none;
          line-height: 1.4;
        }
        .chat-textarea:focus { outline: none; border-color: var(--color-accent-primary); }
        .chat-textarea:disabled { opacity: 0.6; }
        .chat-input-actions {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-xs);
          align-items: center;
        }
        .emoji-container { position: relative; }
        .emoji-toggle {
          font-size: var(--font-size-lg);
          padding: var(--spacing-xs);
          border-radius: var(--radius-sm);
          cursor: pointer;
        }
        .emoji-toggle:hover { background: var(--color-bg-tertiary); }
        .send-btn {
          padding: var(--spacing-sm) var(--spacing-lg);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-sm);
          white-space: nowrap;
        }
        .send-btn:hover { opacity: 0.9; }
        .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
    </div>
  );
};
