/**
 * ChatView — channel messaging with real-time updates, emoji picker,
 * profile resolution, and optimistic message display.
 */

import { Component, createResource, createSignal, createEffect, createMemo, For, Show, onCleanup } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { authStatus, getSigner, walletAddress, isRegistered } from '../lib/auth';
import { onWsEvent, wsSubscribeChannels, wsUnsubscribeChannels } from '../lib/ws';
import { navigate } from '../lib/router';
import { setSetting } from '../lib/settings';
import { FormattedText } from '../components/FormattedText';
import { EmojiPicker } from '../components/EmojiPicker';
import { MediaUpload, type MediaAttachment } from '../components/MediaUpload';
import { getPayloadContent, getPayloadAttachments, decodePayload } from '../lib/payload';
import { resolveProfile, type CachedProfile } from '../lib/profile';

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

/** Format message time in user's local timezone. */
function formatMessageTime(timestamp: string | number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });
}

/** Get a date label for message grouping. */
function getDateLabel(timestamp: string | number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = today.getTime() - msgDay.getTime();
  if (diff === 0) return 'Today';
  if (diff === 86400000) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

interface ChatViewProps {
  channelId: number | null;
}

export const ChatView: Component<ChatViewProps> = (props) => {
  const [messageInput, setMessageInput] = createSignal('');
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
  const EDIT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
  const GROUP_WINDOW_MS = 2 * 60 * 1000; // 2 minutes — combine consecutive messages
  let inputRef: HTMLTextAreaElement | undefined;
  let messagesRef: HTMLDivElement | undefined;

  // Close user context menu on any click
  if (typeof document !== 'undefined') {
    const closeUserMenu = () => setUserMenu(null);
    document.addEventListener('click', closeUserMenu);
    onCleanup(() => document.removeEventListener('click', closeUserMenu));
  }

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

  /** Scroll chat to the bottom. */
  const scrollToBottom = () => {
    if (messagesRef) messagesRef.scrollTop = messagesRef.scrollHeight;
  };

  let lastChannelId: number | null = null;
  let prevMsgCount = 0;
  let initialLoad = true;
  const [lastReadTs, setLastReadTs] = createSignal<number | null>(null);
  const [messages] = createResource(
    () => props.channelId,
    async (channelId) => {
      if (!channelId) return [];
      // Always clear local messages when fetching — prevents duplicates
      // when navigating away and back to the same channel
      setLocalMessages([]);
      lastChannelId = channelId;
      prevMsgCount = 0;
      initialLoad = true;
      setLastReadTs(null);
      try {
        const client = getClient();
        const resp = await client.getChannelMessages(channelId, 200);
        if (resp.last_read_ts !== undefined) setLastReadTs(resp.last_read_ts);
        return resp.messages;
      } catch {
        return [];
      }
    },
  );

  const [pinnedMessages] = createResource(
    () => props.channelId,
    async (channelId) => {
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

  // Fetch current user's channel role for permission gating
  createEffect(() => {
    const id = props.channelId;
    const me = walletAddress();
    if (!id || !me) { setMyRole('member'); return; }
    getClient().getChannelMembers(id, { limit: 200 }).then((resp) => {
      const member = resp.members.find((m) => m.address === me);
      setMyRole(member?.role as any ?? 'member');
    }).catch(() => setMyRole('member'));
  });

  const isMod = () => myRole() === 'moderator' || myRole() === 'creator';

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
              Math.abs(new Date(m.timestamp).getTime() - new Date(msg.timestamp).getTime()) < 10000);
          });
          // Skip if already present (WS can re-deliver)
          if (filtered.some((m) => msgIdToHex(m.msg_id) === msgIdToHex(msg.msg_id))) return filtered;
          const next = [...filtered, msg];
          return next.length > MAX_LOCAL_MESSAGES ? next.slice(-MAX_LOCAL_MESSAGES) : next;
        });
        // Mark channel as read while viewing so unread badge doesn't appear
        if (authStatus() === 'ready') {
          getClient().markChannelRead(props.channelId!).catch(() => {});
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
      // Mark channel as read when entering
      if (authStatus() === 'ready') {
        try { getClient().markChannelRead(parseInt(id, 10)).catch(() => {}); }
        catch { /* SDK method may not exist on older builds */ }
      }
      setTimeout(() => inputRef?.focus(), 50);
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
        Math.abs(new Date(am.timestamp).getTime() - new Date(lm.timestamp).getTime()) < 10000,
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
    deduped.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return deduped;
  });

  // Resolve profiles for all unique authors
  createEffect(() => {
    const msgs = allMessages();
    const authors = new Set(msgs.map((m) => m.author));
    authors.forEach((addr) => {
      if (!profiles().has(addr)) {
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
      const resp = await client.getChannelMessages(channelId, 200, undefined, latestMsgId);
      if (resp.messages && resp.messages.length > 0) {
        setLocalMessages((prev) => {
          // Dedup: only add messages not already in localMessages
          const existingIds = new Set(prev.map((m) => msgIdToHex(m.msg_id)));
          const newMsgs = resp.messages.filter((m: any) => !existingIds.has(msgIdToHex(m.msg_id)));
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
    const msgs = allMessages();
    const count = msgs.length;
    if (count > 0 && count !== prevMsgCount) {
      const wasMore = count > prevMsgCount;
      const isFirst = initialLoad;
      prevMsgCount = count;
      initialLoad = false;
      if (!wasMore && !isFirst) return; // only scroll on new messages, not removals
      if (isFirst) {
        // Initial load: wait for SolidJS to render all <For> items into the DOM
        // Wait for DOM to render all messages before scrolling.
        // Use two rAF frames + setTimeout for reliable rendering in Tauri/webkit2gtk.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(() => {
              if (!messagesRef) return;
              const divider = messagesRef.querySelector('.unread-divider');
              if (divider) {
                divider.scrollIntoView({ block: 'start' });
              } else {
                scrollToBottom();
              }
            }, 50);
          });
        });
      } else {
        // Subsequent messages: quick RAF is sufficient since DOM is already populated
        requestAnimationFrame(() => {
          if (!messagesRef) return;
          const { scrollTop, scrollHeight, clientHeight } = messagesRef;
          const isNearBottom = scrollHeight - scrollTop - clientHeight < 150;
          if (isNearBottom) scrollToBottom();
        });
      }
    } else {
      prevMsgCount = count;
    }
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
      // Extract @mentions (klv1 addresses) from the message text
      const mentionMatches = text.match(/@(klv1[a-z0-9]{58})/g);
      if (mentionMatches) {
        options.mentions = [...new Set(mentionMatches.map((m: string) => m.slice(1)))];
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
    } catch (err: any) {
      console.error('sendMessage failed:', err);
      const msg = err?.message || String(err);
      setSendError(msg);
      // Auto-clear error after 6 seconds
      setTimeout(() => setSendError(null), 6000);
    } finally {
      setSending(false);
      // Focus after sending is cleared (textarea is no longer disabled)
      setTimeout(() => inputRef?.focus(), 0);
    }
  };

  const handleReply = (msg: any) => {
    const content = getPayloadContent(msg.payload);
    const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
    setReplyTo({ msgId: msgIdToHex(msg.msg_id), author: msg.author, preview });
    inputRef?.focus();
  };

  const insertEmoji = (emoji: string) => {
    if (!inputRef) return;
    const start = inputRef.selectionStart ?? messageInput().length;
    const end = inputRef.selectionEnd ?? start;
    const current = messageInput();
    setMessageInput(current.slice(0, start) + emoji + current.slice(end));
    // Restore cursor after emoji
    setTimeout(() => {
      inputRef?.focus();
      const pos = start + emoji.length;
      inputRef?.setSelectionRange(pos, pos);
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
    (Date.now() - new Date(msg.timestamp).getTime()) < EDIT_WINDOW_MS;

  const canDelete = (msg: any) =>
    isRegistered() && msg.author === walletAddress() && !msg.deleted;

  const startEdit = (msg: any) => {
    setEditingMsg({ msgId: msgIdToHex(msg.msg_id), content: getPayloadContent(msg.payload) });
    setMessageInput(getPayloadContent(msg.payload));
    inputRef?.focus();
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
    } catch (e) {
      console.warn('Edit message failed:', e);
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
        <div class="channel-bar">
          <Show when={pinnedMessages() && pinnedMessages()!.length > 0}>
            <span class="pinned-info">
              <span class="pinned-icon">📌</span>
              <span class="pinned-count">{pinnedMessages()!.length} {t('channel_pins')}</span>
            </span>
          </Show>
          <button
            class="channel-settings-btn"
            onClick={() => navigate(`/chat/${props.channelId}/settings`)}
            title={t('channel_settings')}
          >
            ⚙
          </button>
        </div>

        <div class="chat-messages" ref={messagesRef}>
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
                // Group consecutive messages from the same author within 2 minutes
                const isContinuation = !showDateSep && !reply && prevMsg
                  && prevMsg.author === msg.author
                  && !prevMsg.deleted && !msg.deleted
                  && (Math.abs(new Date(msg.timestamp).getTime() - new Date(prevMsg.timestamp).getTime()) < GROUP_WINDOW_MS);

                // Show unread divider before the first message after last_read_ts
                const readTs = lastReadTs();
                const msgTs = new Date(msg.timestamp).getTime();
                const prevMsgTs = prevMsg ? new Date(prevMsg.timestamp).getTime() : 0;
                const showUnreadDivider = readTs !== null
                  && msgTs > readTs
                  && (prevMsgTs <= readTs || !prevMsg)
                  && msg.author !== walletAddress();

                return (
                  <>
                    <Show when={showUnreadDivider}>
                      <div class="unread-divider">
                        <span class="unread-divider-label">{t('chat_new_messages')}</span>
                      </div>
                    </Show>
                    <Show when={showDateSep}>
                      <div class="date-separator">
                        <span class="date-separator-label">{currentDate}</span>
                      </div>
                    </Show>
                    <div
                      class={`message ${msg.author === walletAddress() ? 'own' : ''} ${msg.deleted ? 'deleted' : ''} ${msg.muted ? 'muted' : ''} ${isContinuation ? 'continuation' : ''}`}
                      data-msg-id={msgIdToHex(msg.msg_id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setUserMenu({ x: e.clientX, y: e.clientY, address: msg.author, msgId: msgIdToHex(msg.msg_id) });
                      }}
                    >
                      <Show when={reply && !msg.deleted}>
                        <div class="reply-preview" onClick={() => scrollToMessage(reply!.msgId)}>
                          <span class="reply-preview-author">{displayName(reply!.author)}</span>
                          <span class="reply-preview-text">{reply!.content}</span>
                        </div>
                      </Show>
                      <Show when={!isContinuation}>
                        <div class="message-header">
                          <Show when={prof()?.avatar_cid}>
                            <img
                              class="msg-avatar"
                              src={getClient().getMediaUrl(prof()!.avatar_cid!)}
                              alt=""
                            />
                          </Show>
                          <Show when={!prof()?.avatar_cid}>
                            <span class="msg-avatar-placeholder">
                              {(prof()?.display_name || msg.author).slice(0, 2).toUpperCase()}
                            </span>
                          </Show>
                          <span
                            class="message-author"
                            onClick={() => navigate(`/user/${msg.author}`)}
                          >
                            {displayName(msg.author)}
                          </span>
                          <Show when={prof()?.verified}>
                            <span class="msg-verified">✓</span>
                          </Show>
                          <span class="message-time">
                            {formatMessageTime(msg.timestamp)}
                            <Show when={msg.edited}>
                              <span class="edited-indicator" title={msg.last_edited_at ? new Date(msg.last_edited_at).toLocaleString() : ''}> ({t('message_edited')})</span>
                            </Show>
                          </span>
                        </div>
                      </Show>
                      <Show
                        when={!msg.deleted}
                        fallback={<div class="message-body message-deleted-text">{t('message_deleted')}</div>}
                      >
                        <Show
                          when={!msg.muted || expandedMuted().has(msgIdToHex(msg.msg_id))}
                          fallback={
                            <div class="message-body message-muted-text" onClick={() => setExpandedMuted(prev => { const next = new Set(prev); next.add(msgIdToHex(msg.msg_id)); return next; })}>
                              {t('message_muted_show')}
                            </div>
                          }
                        >
                          <div class="message-body"><FormattedText content={getPayloadContent(msg.payload)} attachments={getPayloadAttachments(msg.payload)} /></div>
                        </Show>
                      </Show>
                      {/* Floating emoji bar on hover */}
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

        {/* Edit mode indicator */}
        <Show when={editingMsg()}>
          <div class="edit-indicator">
            <span class="edit-indicator-label">✏ {t('chat_edit_mode')}</span>
            <button class="edit-cancel" onClick={cancelEdit}>{t('chat_edit_cancel')}</button>
          </div>
        </Show>

        {/* Reply indicator */}
        <Show when={replyTo() && !editingMsg()}>
          <div class="reply-indicator">
            <div class="reply-indicator-content">
              <span class="reply-indicator-author">{displayName(replyTo()!.author)}</span>
              <span class="reply-indicator-text">{replyTo()!.preview}</span>
            </div>
            <button class="reply-cancel" onClick={cancelReply}>✕</button>
          </div>
        </Show>

        {/* Media attachments */}
        <Show when={walletAddress() && !editingMsg()}>
          <div class="chat-media-bar">
            <MediaUpload
              attachments={attachments()}
              onAttach={(a) => setAttachments((prev) => [...prev, a])}
              onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
              disabled={sending()}
            />
          </div>
        </Show>

        {/* Input area */}
        <div class="chat-input-area">
          <div class="chat-input">
            <textarea
              ref={inputRef}
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
                const items = e.clipboardData?.items;
                if (!items || !walletAddress()) return;
                const imageItem = Array.from(items).find((i) => i.type.startsWith('image/'));
                if (!imageItem) return;
                // Must preventDefault synchronously before browser inserts text
                e.preventDefault();
                const file = imageItem.getAsFile();
                if (!file) return;
                // Upload asynchronously after preventing default
                getClient().uploadMedia(file, `paste-${Date.now()}.${file.type.split('/')[1] || 'png'}`)
                  .then((result) => {
                    setAttachments((prev) => [...prev, {
                      cid: result.cid,
                      mime_type: file.type,
                      size_bytes: file.size,
                      filename: `paste-${Date.now()}.${file.type.split('/')[1] || 'png'}`,
                      thumbnail_cid: result.thumbnail_cid,
                    }]);
                  }).catch(() => { /* upload failed */ });
              }}
              disabled={sending() || !walletAddress()}
            />
            <div class="chat-input-actions">
              <div class="emoji-container">
                <button
                  class="emoji-toggle"
                  onClick={() => walletAddress() && setShowEmoji(!showEmoji())}
                  title="Emoji"
                  disabled={!walletAddress()}
                >
                  😊
                </button>
                <Show when={showEmoji()}>
                  <EmojiPicker
                    onSelect={insertEmoji}
                    onClose={() => setShowEmoji(false)}
                  />
                </Show>
              </div>
              <button
                class="send-btn"
                onClick={handleSend}
                disabled={sending() || (!messageInput().trim() && attachments().length === 0) || !walletAddress()}
              >
                {t('chat_send')}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* User context menu for moderation */}
      <Show when={userMenu()}>
        <div
          class="user-context-menu"
          style={{ left: `${userMenu()!.x}px`, top: `${userMenu()!.y}px` }}
        >
          {/* Message actions — always available */}
          <button class="ctx-item" onClick={() => handleUserAction('reply')}>
            ↩ {t('chat_reply')}
          </button>
          <Show when={(() => { const m = msgById().get(userMenu()!.msgId); return m && canEdit(m); })()}>
            <button class="ctx-item" onClick={() => handleUserAction('edit')}>
              ✏ {t('chat_edit')}
            </button>
          </Show>
          <Show when={(() => { const m = msgById().get(userMenu()!.msgId); return m && canDelete(m); })()}>
            <button class="ctx-item ctx-danger" onClick={() => handleUserAction('delete')}>
              🗑 {t('chat_delete')}
            </button>
          </Show>
          <div class="ctx-divider" />
          {/* User actions */}
          <button class="ctx-item" onClick={() => handleUserAction('profile')}>
            👤 {t('channel_view_profile')}
          </button>
          <Show when={isMod()}>
            <button class="ctx-item" onClick={() => handleUserAction('pin')}>
              📌 {t('channel_pin_message')}
            </button>
          </Show>
          <Show when={walletAddress() && userMenu()!.address !== walletAddress()}>
            <button class="ctx-item" onClick={() => handleUserAction('report')}>
              🚩 {t('report_title')}
            </button>
          </Show>
          <Show when={isMod() && userMenu()!.address !== walletAddress()}>
            <div class="ctx-divider" />
            <button class="ctx-item ctx-warn" onClick={() => handleUserAction('mute')}>
              🔇 {t('channel_mute')}
            </button>
            <button class="ctx-item ctx-warn" onClick={() => handleUserAction('kick')}>
              ⚡ {t('channel_kick')}
            </button>
            <button class="ctx-item ctx-danger" onClick={() => handleUserAction('ban')}>
              ⛔ {t('channel_ban')}
            </button>
          </Show>
        </div>
      </Show>

      <style>{`
        .chat-view { display: flex; flex-direction: column; height: 100%; height: 100dvh; max-height: -webkit-fill-available; }
        .chat-messages { flex: 1; overflow-y: auto; overflow-x: hidden; padding: var(--spacing-md); display: flex; flex-direction: column; }
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
        }
        .message {
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-lg);
          max-width: 85%;
          align-self: flex-start;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          overflow-wrap: break-word;
          word-break: break-word;
          min-width: 0;
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
