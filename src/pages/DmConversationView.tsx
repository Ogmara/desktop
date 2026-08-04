/**
 * DmConversationView — direct message conversation with a peer.
 */

import { Component, createResource, createSignal, createEffect, createMemo, For, Show, onCleanup, onMount, untrack } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { authStatus, walletAddress, getSigner, isRegistered } from '../lib/auth';
import { onWsEvent } from '../lib/ws';
import { navigate } from '../lib/router';
import { showMobileList } from '../lib/mobile-nav';
import { isModernStyle } from '../lib/theme';
import { FormattedText } from '../components/FormattedText';
import { MediaUpload, type MediaAttachment } from '../components/MediaUpload';
import { getPayloadAttachments, buildOptimisticChatPayload, safeAttachmentName } from '../lib/payload';
import { EmojiPicker } from '../components/EmojiPicker';
import { confirmDialog } from '../components/Dialogs';
import { buildEncryptedDm, buildEncryptedDmEditEnvelope, decryptDmMessage, coverPeerDevices, type DmDisplay } from '../lib/dmCrypto';
import { encryptAndUploadFile, revokePreviewUrls } from '../lib/mediaCrypto';
import { resolveProfile, type CachedProfile } from '../lib/profile';

interface DmConversationProps {
  peerAddress: string;
}

export const DmConversationView: Component<DmConversationProps> = (props) => {
  const [messageInput, setMessageInput] = createSignal('');
  const [localMessages, setLocalMessages] = createSignal<any[]>([]);
  const [sending, setSending] = createSignal(false);
  const [showEmoji, setShowEmoji] = createSignal(false);
  const [editingMsg, setEditingMsg] = createSignal<{ msgId: string; content: string } | null>(null);
  const [showReactPicker, setShowReactPicker] = createSignal<string | null>(null);
  const [attachments, setAttachments] = createSignal<MediaAttachment[]>([]);
  const [sendError, setSendError] = createSignal<string | null>(null);
  // Shown when an UNVERIFIED wallet tries an edit/delete: the node gates these
  // "trust features" behind on-chain registration (requires_verified_identity).
  // Rather than silently hiding the action, we prompt the user to verify — a
  // gentle nudge toward registering their wallet.
  const [showVerifyPrompt, setShowVerifyPrompt] = createSignal(false);

  // Right-click / long-press message context menu (parity with channel chat).
  const [dmMenu, setDmMenu] = createSignal<{ x: number; y: number; msg: any } | null>(null);
  let dmMenuRef: HTMLDivElement | undefined;
  let dmLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  const DM_MENU_W = 260, DM_MENU_H = 220, DM_MENU_MARGIN = 8;
  const openDmMenu = (clientX: number, clientY: number, msg: any) => {
    if (!walletAddress()) return; // nothing actionable when not connected
    const maxX = window.innerWidth - DM_MENU_W - DM_MENU_MARGIN;
    const maxY = window.innerHeight - DM_MENU_H - DM_MENU_MARGIN;
    setShowReactPicker(null);
    setDmMenu({
      x: Math.max(DM_MENU_MARGIN, Math.min(clientX, maxX)),
      y: Math.max(DM_MENU_MARGIN, Math.min(clientY, maxY)),
      msg,
    });
  };
  const handleDmTouchStart = (e: TouchEvent, msg: any) => {
    if (dmLongPressTimer) clearTimeout(dmLongPressTimer);
    const touch = e.touches[0];
    dmLongPressTimer = setTimeout(() => openDmMenu(touch.clientX, touch.clientY, msg), 500);
  };
  const cancelDmLongPress = () => { if (dmLongPressTimer) { clearTimeout(dmLongPressTimer); dmLongPressTimer = null; } };
  if (typeof document !== 'undefined') {
    const closeDmMenu = (e: MouseEvent) => {
      if (dmMenuRef && dmMenuRef.contains(e.target as Node)) return;
      setDmMenu(null);
    };
    document.addEventListener('click', closeDmMenu);
    onCleanup(() => document.removeEventListener('click', closeDmMenu));
  }

  // Peer profile for header
  const [peerProfile, setPeerProfile] = createSignal<CachedProfile>({});
  createEffect(() => {
    if (props.peerAddress) resolveProfile(props.peerAddress).then(setPeerProfile);
  });
  const peerName = () => peerProfile().display_name || `${props.peerAddress.slice(0, 8)}...${props.peerAddress.slice(-4)}`;
  const EDIT_WINDOW_MS = 30 * 60 * 1000;
  let inputRef: HTMLTextAreaElement | undefined;
  let messagesRef: HTMLDivElement | undefined;
  // A DOM-detached `document.createElement('input')` + synchronous `.click()`
  // (the old pattern here) is unreliable in WebKitGTK: nothing keeps the
  // element referenced once the click handler returns and the native file
  // dialog is async, so it can silently get GC'd before `onchange` ever
  // fires — no error, the attach just does nothing. A persistent, DOM-mounted
  // input (matching ChatView's modern-input pattern) doesn't have this problem.
  let modernDmAttachInputRef: HTMLInputElement | undefined;

  // Auto-scroll DM messages
  let prevDmCount = 0;
  let dmInitialLoad = true;
  createEffect(() => {
    const msgs = allMessages();
    const count = msgs.length;
    if (count === 0 || count === prevDmCount) { prevDmCount = count; return; }
    const isFirst = dmInitialLoad;
    prevDmCount = count;
    dmInitialLoad = false;
    setTimeout(() => {
      if (!messagesRef) return;
      if (isFirst) {
        messagesRef.scrollTop = messagesRef.scrollHeight;
      } else {
        const { scrollTop, scrollHeight, clientHeight } = messagesRef;
        if (scrollHeight - scrollTop - clientHeight < 150) {
          messagesRef.scrollTo({ top: messagesRef.scrollHeight, behavior: 'smooth' });
        }
      }
    }, 0);
  });

  // Gate the source on auth being ready: on a cold reload this resource would
  // otherwise fire before the signer is attached, the authenticated DM fetch
  // would 401 → [], and (since only `peerAddress` is a dependency) it would
  // never refetch until the 8 s poll — the conversation looks empty on reload.
  // Re-keying on `authStatus` makes it refetch the moment auth lands.
  const [messages, { refetch: refetchDmMessages }] = createResource(
    () => (authStatus() === 'ready' ? props.peerAddress : undefined),
    async (address) => {
      if (!address) return [];
      try {
        const client = getClient();
        const resp = await client.getDmMessages(address);
        return resp.messages;
      } catch {
        return [];
      }
    },
  );

  // The DM view component is reused across conversations (only the route param
  // changes), so clear per-conversation local state when the peer changes —
  // otherwise the previous peer's messages (including your own optimistic sends)
  // leak into the newly-opened conversation.
  createEffect(() => {
    props.peerAddress; // track
    setLocalMessages([]);
    // Reset the auto-scroll trackers so each opened conversation scrolls to its
    // newest message once (these are component-scoped and would otherwise stay
    // `dmInitialLoad=false` from the first conversation → the next one opens
    // scrolled to the oldest message).
    prevDmCount = 0;
    dmInitialLoad = true;
  });

  // Auto-refresh: the open conversation otherwise only loads once (on open), so a
  // DM that arrives while you're viewing only shows after leaving + returning. The
  // node can't push DM bodies over the shared WS broadcast (it would leak to every
  // client), so poll the recipient's own authenticated endpoint. The dedup below
  // drops the optimistic copy when the real one arrives, so there's no duplication.
  let dmPollTimer: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    dmPollTimer = setInterval(() => {
      if (props.peerAddress && authStatus() === 'ready') refetchDmMessages();
    }, 8000);
  });
  onCleanup(() => { if (dmPollTimer) clearInterval(dmPollTimer); });

  const MAX_LOCAL_MESSAGES = 200;

  // Real-time DM updates
  const cleanup = onWsEvent((event) => {
    if (event.type === 'dm') {
      const msg = event.envelope;
      // A DM edit/delete carries `target_msg_id` (vs a fresh message which doesn't).
      // It changes an EXISTING message in place, so pull the authoritative,
      // server-projected conversation rather than appending a phantom entry. Covers
      // both the peer's edits and our own (the node echoes to both participants).
      if (msg.target_msg_id) {
        if (props.peerAddress && authStatus() === 'ready') refetchDmMessages();
        return;
      }
      // Only incoming messages from THIS peer. Our own sends are shown
      // optimistically; matching `author === me` here would pull a DM we sent to a
      // DIFFERENT peer into whichever conversation happens to be open.
      if (msg.author === props.peerAddress) {
        setLocalMessages((prev) => {
          const next = [...prev, msg];
          return next.length > MAX_LOCAL_MESSAGES ? next.slice(-MAX_LOCAL_MESSAGES) : next;
        });
        // The peer is active → ensure my key is wrapped to all their current devices,
        // so a device that joined after I established my key can read my messages
        // without an app reload (throttled inside coverPeerDevices).
        void coverPeerDevices(props.peerAddress);
        // Mark as read while viewing so unread badge doesn't appear
        if (authStatus() === 'ready') {
          getClient().markDmRead(props.peerAddress).catch(() => {});
        }
      }
    }
  });
  onCleanup(cleanup);

  // Combine server + local messages. First drop optimistic (`local-`) sends once
  // the server has the real copy (matched by author + timestamp window) so a poll
  // refetch doesn't show the message twice; then dedup by msg_id.
  const normTs = (t: any) => { const n = Number(t) || 0; return n < 1e12 ? n * 1000 : n; };
  const allMessages = () => {
    const real = messages() || [];
    const local = localMessages().filter((lm) => {
      if (!String(lm.msg_id ?? '').startsWith('local-')) return true;
      return !real.some((rm) =>
        rm.author === lm.author &&
        Math.abs(normTs(rm.timestamp) - normTs(lm.timestamp)) < 15000);
    });
    const seen = new Set<string>();
    return [...real, ...local].filter((msg) => {
      if (!msg.msg_id || seen.has(msg.msg_id)) return false;
      seen.add(msg.msg_id);
      return true;
    });
  };

  // Per-message decrypted display, keyed by msg_id. Decryption is async (the
  // conv_key may need a node round-trip); `waiting` entries are retried on the next
  // poll/refetch (e.g. once a key envelope arrives for a freshly-joined device).
  const [dmDisplays, setDmDisplays] = createSignal<Record<string, DmDisplay>>({});
  // Non-reactive record of the edit stamp we last decrypted per msg_id. An edit
  // replaces the message's ciphertext (node-side projection), so a resolved bubble
  // must be re-decrypted when `last_edited_at` advances — otherwise an edited DM
  // (mine OR the peer's) keeps showing the pre-edit text until a full reload.
  const decodedEditStamp = new Map<string, number>();
  createEffect(() => {
    const msgs = allMessages(); // track
    const cur = untrack(() => dmDisplays());
    for (const msg of msgs) {
      const id = msg.msg_id;
      if (!id) continue;
      const stamp = Number(msg.last_edited_at ?? 0);
      const existing = cur[id];
      if (existing && existing.kind !== 'waiting' && decodedEditStamp.get(id) === stamp) continue;
      decodedEditStamp.set(id, stamp);
      decryptDmMessage(msg.payload, msg.author)
        .then((disp) => setDmDisplays((prev) => ({ ...prev, [id]: disp })))
        .catch(() => setDmDisplays((prev) => ({ ...prev, [id]: { kind: 'error' } })));
    }
  });

  /** Display text for a DM message bubble (decrypted, or a lock placeholder). */
  const dmText = (msg: any): string => {
    const d = dmDisplays()[msg.msg_id];
    if (!d) return '…'; // decrypting (resolves async) — avoids a blank bubble on load
    if (d.kind === 'text' || d.kind === 'plain') return d.text;
    if (d.kind === 'waiting') return `🔒 ${t('dm_waiting_for_key')}`;
    return `🔒 ${t('dm_cannot_decrypt')}`;
  };

  /** Decrypted media descriptors for a DM bubble (P5), or undefined. */
  const dmMedia = (msg: any) => {
    const d = dmDisplays()[msg.msg_id];
    return d && (d.kind === 'text' || d.kind === 'plain') ? d.media : undefined;
  };

  // Mark conversation as read on mount
  onMount(async () => {
    if (authStatus() === 'ready' && props.peerAddress) {
      try {
        const client = getClient();
        await client.markDmRead(props.peerAddress);
      } catch {
        // Non-critical — ignore
      }
    }
  });

  // Reaching the latest message marks the DM read (once per scroll-to-bottom).
  let dmWasAtBottom = true;
  const handleDmScroll = () => {
    if (!messagesRef) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesRef;
    const atBottom = scrollHeight - scrollTop - clientHeight < 150;
    if (atBottom && !dmWasAtBottom && authStatus() === 'ready' && props.peerAddress) {
      getClient().markDmRead(props.peerAddress).catch(() => {});
    }
    dmWasAtBottom = atBottom;
  };

  // Encrypt a picked/pasted file (P5) and append it to the composer. DMs are
  // always encrypted, so this is the single attach path for the inline buttons.
  const attachEncryptedFile = async (file: File) => {
    try {
      const desc = await encryptAndUploadFile(file);
      setAttachments((p) => [...p, {
        cid: desc.cid, mime_type: desc.mime, size_bytes: desc.size,
        filename: desc.name, descriptor: desc, previewUrl: URL.createObjectURL(file),
      }]);
    } catch (err: any) {
      setSendError(err?.message || t('media_upload_failed'));
      setTimeout(() => setSendError(null), 6000);
    }
  };

  const handleSend = async () => {
    if (editingMsg()) { await handleEdit(); return; }

    const text = messageInput().trim();
    const atts = attachments();
    if ((!text && atts.length === 0) || sending()) return;

    const signer = getSigner();
    if (!signer || !walletAddress()) return;

    setSending(true);
    setSendError(null);
    try {
      const client = getClient();
      // DMs are E2E-encrypted (P1). Attachments are encrypted before upload (P5)
      // and ride as `MediaDescriptor`s inside the message ciphertext — the node
      // never sees the file bytes, the real MIME, or the filename.
      const media = atts.map((a) => a.descriptor).filter((d): d is NonNullable<typeof d> => !!d);
      const envelope = await buildEncryptedDm(props.peerAddress, text, undefined, media);
      await client.sendDm(props.peerAddress, envelope);
      setMessageInput('');
      revokePreviewUrls(atts);
      setAttachments([]);

      // Optimistic: show sent message immediately. The DM bubble renders from the
      // decrypted display record (`dmDisplays`), not the raw payload, so seed it
      // directly with the plaintext text + encrypted-media descriptors (the same
      // ones the recipient will decrypt) so the image/file shows instantly.
      const localId = `local-${Date.now()}`;
      setLocalMessages((prev) => [...prev, {
        msg_id: localId,
        author: walletAddress(),
        timestamp: Date.now(),
        payload: buildOptimisticChatPayload({ content: text }),
      }]);
      setDmDisplays((prev) => ({ ...prev, [localId]: { kind: 'text', text, media: media.length > 0 ? media : undefined } }));

      setTimeout(() => {
        inputRef?.focus();
        if (messagesRef) messagesRef.scrollTo({ top: messagesRef.scrollHeight, behavior: 'smooth' });
      }, 50);
    } catch (err: any) {
      console.error('sendDm failed:', err);
      const raw = err?.message || String(err);
      // Recipient has no registered encryption keys → they can't receive E2E DMs.
      const msg = raw.includes('RECIPIENT_NO_ENC_KEYS')
        ? t('dm_recipient_no_encryption')
        : raw;
      setSendError(msg);
      setTimeout(() => setSendError(null), 6000);
    } finally {
      setSending(false);
    }
  };

  const insertEmoji = (emoji: string) => {
    if (!inputRef) return;
    const start = inputRef.selectionStart ?? messageInput().length;
    const end = inputRef.selectionEnd ?? start;
    const current = messageInput();
    setMessageInput(current.slice(0, start) + emoji + current.slice(end));
    setTimeout(() => {
      inputRef?.focus();
      const pos = start + emoji.length;
      inputRef?.setSelectionRange(pos, pos);
    }, 0);
  };

  const msgIdToHex = (id: unknown): string => {
    if (typeof id === 'string') return id;
    if (id instanceof Uint8Array) return Array.from(id).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (Array.isArray(id)) return id.map((b: number) => b.toString(16).padStart(2, '0')).join('');
    return String(id);
  };

  // NOTE: unlike NewsEdit, the node does NOT require on-chain registration for DM
  // (or chat) edits/deletes — only own-message + within the edit window. Gating on
  // isRegistered() here wrongly hid the actions whenever registration detection was
  // stale (e.g. the node-not-ready boot race), so it's deliberately omitted.
  const canEdit = (msg: any) =>
    msg.author === walletAddress() && !msg.deleted &&
    (Date.now() - new Date(msg.timestamp).getTime()) < EDIT_WINDOW_MS;

  const canDelete = (msg: any) =>
    msg.author === walletAddress() && !msg.deleted;

  const startEdit = (msg: any) => {
    // Editing is a verified-wallet feature (node `requires_verified_identity`).
    // Nudge unverified users to verify instead of letting the edit fail with a 400.
    if (!isRegistered()) { setShowVerifyPrompt(true); return; }
    // Prefill with decrypted text (raw payload content is ciphertext for encrypted
    // DMs). The edit is re-encrypted under the conv_key on save (see handleEdit), so
    // the node never sees the new plaintext.
    const text = dmText(msg);
    setEditingMsg({ msgId: msgIdToHex(msg.msg_id), content: text });
    setMessageInput(text);
    inputRef?.focus();
  };

  const cancelEdit = () => { setEditingMsg(null); setMessageInput(''); };

  const handleEdit = async () => {
    const edit = editingMsg();
    if (!edit || !messageInput().trim()) return;
    setSending(true);
    try {
      const client = getClient();
      const newText = messageInput().trim();
      // Re-encrypt the new content under the conv_key and send as a DM edit
      // envelope via the same DM POST path as a fresh message.
      const envelope = await buildEncryptedDmEditEnvelope(props.peerAddress, edit.msgId, newText);
      await client.sendDm(props.peerAddress, envelope);
      // Optimistic: show the new text immediately. The decrypt effect re-confirms
      // it from the re-encrypted server echo once `last_edited_at` advances.
      setDmDisplays((p) => ({ ...p, [edit.msgId]: { kind: 'text', text: newText } }));
      setLocalMessages((prev) => prev.map((m) =>
        msgIdToHex(m.msg_id) === edit.msgId ? { ...m, edited: true } : m,
      ));
      setEditingMsg(null);
      setMessageInput('');
    } catch (err) {
      console.error('DM edit failed:', err);
    }
    finally { setSending(false); }
  };

  const handleDeleteDm = async (msg: any) => {
    // Deleting is likewise a verified-wallet feature — prompt instead of failing.
    if (!isRegistered()) { setShowVerifyPrompt(true); return; }
    if (!(await confirmDialog(t('chat_delete_confirm')))) return;
    try {
      const client = getClient();
      await client.deleteDm(props.peerAddress, msgIdToHex(msg.msg_id));
      setLocalMessages((prev) => prev.map((m) =>
        msgIdToHex(m.msg_id) === msgIdToHex(msg.msg_id) ? { ...m, deleted: true } : m,
      ));
    } catch { /* failed */ }
  };

  const handleReactDm = async (msg: any, emoji: string) => {
    if (!walletAddress()) return;
    setShowReactPicker(null);
    try {
      const client = getClient();
      await client.reactToDm(props.peerAddress, msgIdToHex(msg.msg_id), emoji);
    } catch { /* failed */ }
  };

  const truncateAddress = (addr: string) =>
    `${addr.slice(0, 8)}...${addr.slice(-4)}`;

  return (
    <div class="dm-conv-view">
      <div class="dm-conv-header">
        <Show when={isModernStyle()} fallback={
          <>
            <button class="dm-back-btn" onClick={() => navigate('/dm')}>← {t('nav_dms')}</button>
            <span class="dm-conv-peer" onClick={() => navigate(`/user/${props.peerAddress}`)}>{truncateAddress(props.peerAddress)}</span>
          </>
        }>
          <button class="channel-back-btn content-back-btn" onClick={() => showMobileList()}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
          </button>
          <div style="width:36px; height:36px; border-radius:50%; flex-shrink:0; overflow:hidden; cursor:pointer" onClick={() => navigate(`/user/${props.peerAddress}`)}>
            <Show when={peerProfile().avatar_cid} fallback={
              <div style="width:36px; height:36px; border-radius:50%; background:var(--color-dm); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px">
                {peerName().slice(0, 1).toUpperCase()}
              </div>
            }>
              <img src={getClient().getMediaUrl(peerProfile().avatar_cid!)} alt="" style="width:36px; height:36px; border-radius:50%; object-fit:cover" />
            </Show>
          </div>
          <span class="dm-conv-peer" onClick={() => navigate(`/user/${props.peerAddress}`)}>{peerName()}</span>
        </Show>
      </div>

      <div class="dm-conv-messages" ref={messagesRef} onScroll={handleDmScroll}>
        <Show
          when={allMessages().length > 0}
          fallback={<div class="dm-conv-empty">{t('dm_no_messages')}</div>}
        >
          <For each={allMessages()}>
            {(msg) => (
              <div
                class={`dm-msg ${msg.author === walletAddress() ? 'own' : 'peer'} ${msg.deleted ? 'deleted' : ''}`}
                onContextMenu={(e) => { if (msg.deleted) return; e.preventDefault(); openDmMenu(e.clientX, e.clientY, msg); }}
                onTouchStart={(e) => handleDmTouchStart(e, msg)}
                onTouchEnd={cancelDmLongPress}
                onTouchMove={cancelDmLongPress}
              >
                <Show
                  when={!msg.deleted}
                  fallback={<div class="dm-msg-body dm-msg-deleted">{t('message_deleted')}</div>}
                >
                  <div class="dm-msg-body">
                    <FormattedText
                      content={dmText(msg)}
                      encryptedMedia={dmMedia(msg)}
                      attachments={dmMedia(msg) ? [] : getPayloadAttachments(msg.payload)}
                    />
                  </div>
                </Show>
                <span class="dm-msg-time">
                  {new Date(msg.timestamp).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  <Show when={msg.edited}>
                    <span class="dm-edited"> ({t('message_edited')})</span>
                  </Show>
                </span>
                <Show when={!msg.deleted}>
                  <div class="dm-msg-actions">
                    <Show when={walletAddress()}>
                      <button class="dm-action-btn" onClick={() => setShowReactPicker(showReactPicker() === msgIdToHex(msg.msg_id) ? null : msgIdToHex(msg.msg_id))} title={t('chat_react')}>😊</button>
                    </Show>
                    <Show when={canEdit(msg)}>
                      <button class="dm-action-btn" onClick={() => startEdit(msg)} title={t('chat_edit')}>✏</button>
                    </Show>
                    <Show when={canDelete(msg)}>
                      <button class="dm-action-btn" onClick={() => handleDeleteDm(msg)} title={t('chat_delete')}>🗑</button>
                    </Show>
                  </div>
                </Show>
                <Show when={showReactPicker() === msgIdToHex(msg.msg_id)}>
                  <div class="dm-react-picker">
                    {['👍', '👎', '❤️', '🔥', '😂', '😮'].map((emoji) => (
                      <button class="dm-react-btn" onClick={() => handleReactDm(msg, emoji)}>{emoji}</button>
                    ))}
                  </div>
                </Show>
                <Show when={msg.reactions && Object.keys(msg.reactions).length > 0}>
                  <div class="dm-msg-reactions">
                    {Object.entries(msg.reactions as Record<string, number>).map(([emoji, count]) => (
                      <span class="reaction-badge">{emoji} {count}</span>
                    ))}
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>

      {/* Verify-wallet nudge — shown when an unverified wallet tries edit/delete */}
      <Show when={showVerifyPrompt()}>
        <div class="dm-verify-overlay" onClick={() => setShowVerifyPrompt(false)}>
          <div class="dm-verify-modal" onClick={(e) => e.stopPropagation()}>
            <div class="dm-verify-icon">🔓</div>
            <p class="dm-verify-text">{t('verification_required')}</p>
            <div class="dm-verify-actions">
              <button class="dm-verify-cancel" onClick={() => setShowVerifyPrompt(false)}>{t('chat_edit_cancel')}</button>
              <button class="dm-verify-go" onClick={() => { setShowVerifyPrompt(false); navigate('/wallet'); }}>{t('verification_go_to_wallet')}</button>
            </div>
          </div>
        </div>
      </Show>

      {/* Right-click / long-press message context menu */}
      <Show when={dmMenu()}>
        <div
          class="dm-context-menu"
          style={{ left: `${dmMenu()!.x}px`, top: `${dmMenu()!.y}px` }}
          ref={(el) => {
            dmMenuRef = el;
            // The pre-clamp uses an ESTIMATED size; the emoji row makes the real
            // menu wider, so re-measure once mounted and nudge fully on-screen.
            if (!el) return;
            requestAnimationFrame(() => {
              const r = el.getBoundingClientRect();
              if (r.right > window.innerWidth - DM_MENU_MARGIN) {
                el.style.left = `${Math.max(DM_MENU_MARGIN, window.innerWidth - r.width - DM_MENU_MARGIN)}px`;
              }
              if (r.bottom > window.innerHeight - DM_MENU_MARGIN) {
                el.style.top = `${Math.max(DM_MENU_MARGIN, window.innerHeight - r.height - DM_MENU_MARGIN)}px`;
              }
            });
          }}
        >
          <Show when={walletAddress() && !dmMenu()!.msg.deleted}>
            <div class="dm-ctx-emoji">
              {['👍', '❤️', '😂', '🔥', '😮', '👎'].map((emoji) => (
                <button onClick={() => { handleReactDm(dmMenu()!.msg, emoji); setDmMenu(null); }}>{emoji}</button>
              ))}
            </div>
          </Show>
          <Show when={canEdit(dmMenu()!.msg)}>
            <button class="dm-ctx-item" onClick={() => { startEdit(dmMenu()!.msg); setDmMenu(null); }}>✏ {t('chat_edit')}</button>
          </Show>
          <Show when={canDelete(dmMenu()!.msg)}>
            <button class="dm-ctx-item dm-ctx-danger" onClick={() => { handleDeleteDm(dmMenu()!.msg); setDmMenu(null); }}>🗑 {t('chat_delete')}</button>
          </Show>
        </div>
      </Show>

      <Show when={editingMsg()}>
        <div class="dm-edit-indicator">
          <span class="dm-edit-label">✏ {t('chat_edit_mode')}</span>
          <button class="dm-edit-cancel" onClick={cancelEdit}>{t('chat_edit_cancel')}</button>
        </div>
      </Show>

      <Show when={authStatus() === 'ready'}>
        <Show when={sendError()}>
          <div class="dm-send-error" onClick={() => setSendError(null)}>{sendError()}</div>
        </Show>
        <Show when={isModernStyle()} fallback={
          /* Classic DM input */
          <>
            <Show when={!editingMsg()}>
              <div class="dm-media-bar">
                <MediaUpload encrypted attachments={attachments()} onAttach={(a) => setAttachments((prev) => [...prev, a])} onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))} disabled={sending()} />
              </div>
            </Show>
            <div class="dm-input-area">
              <div class="dm-input-row">
                <textarea ref={inputRef} class="dm-textarea" rows={3} placeholder={t('chat_placeholder')} value={messageInput()}
                  onInput={(e) => setMessageInput(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && (messageInput().trim() || attachments().length > 0)) { e.preventDefault(); handleSend(); } }}
                  onPaste={(e) => { const items = e.clipboardData?.items; if (!items || !walletAddress()) return; const img = Array.from(items).find((i) => i.type.startsWith('image/')); if (!img) return; e.preventDefault(); const blob = img.getAsFile(); if (!blob) return; const file = new File([blob], `paste.${blob.type.split('/')[1] || 'png'}`, { type: blob.type }); void attachEncryptedFile(file); }}
                  disabled={sending() || !walletAddress()} />
                <div class="dm-input-actions">
                  <div class="dm-emoji-container">
                    <button class="dm-emoji-toggle" onClick={() => walletAddress() && setShowEmoji(!showEmoji())} disabled={!walletAddress()}>😊</button>
                    <Show when={showEmoji()}><EmojiPicker onSelect={insertEmoji} onClose={() => setShowEmoji(false)} /></Show>
                  </div>
                  <button class="dm-send-btn" onClick={handleSend} disabled={sending() || (!messageInput().trim() && attachments().length === 0) || !walletAddress()}>{t('chat_send')}</button>
                </div>
              </div>
            </div>
          </>
        }>
          {/* Modern DM input: [emoji] [attach] [textarea] [send] */}
          <div class="dm-input-area">
            {/* Attachment preview strip — same fix as ChatView's modern
                input. `.dm-media-bar` is hidden in modern, so without
                this strip the upload looks like a no-op to the user. */}
            <Show when={attachments().length > 0}>
              <div class="modern-attachments-preview">
                <For each={attachments()}>
                  {(att, i) => (
                    <div class="modern-attach-chip">
                      <Show
                        when={att.mime_type.startsWith('image/')}
                        fallback={<span class="modern-attach-icon">{att.mime_type.startsWith('video/') ? '🎬' : '📎'}</span>}
                      >
                        <img
                          class="modern-attach-thumb"
                          src={att.previewUrl || getClient().getMediaUrl(att.thumbnail_cid || att.cid)}
                          alt={att.filename || ''}
                          loading="lazy"
                        />
                      </Show>
                      <span class="modern-attach-name">{safeAttachmentName(att, 10)}</span>
                      <button
                        class="modern-attach-remove"
                        onClick={() =>
                          setAttachments((prev) => {
                            const gone = prev[i()];
                            if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
                            return prev.filter((_, idx) => idx !== i());
                          })
                        }
                        title={t('cancel')}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div class="dm-input-row">
              <div class="dm-emoji-container">
                <button class="input-icon-btn" onClick={() => walletAddress() && setShowEmoji(!showEmoji())} disabled={!walletAddress()}>😊</button>
                <Show when={showEmoji()}><EmojiPicker onSelect={insertEmoji} onClose={() => setShowEmoji(false)} /></Show>
              </div>
              <button class="input-icon-btn" onClick={() => modernDmAttachInputRef?.click()} disabled={!walletAddress()}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
              </button>
              <input
                type="file"
                ref={modernDmAttachInputRef}
                style="display:none"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  if (file) void attachEncryptedFile(file);
                  e.currentTarget.value = '';
                }}
              />
              <textarea ref={inputRef} class="dm-textarea" rows={1} placeholder={t('chat_placeholder')} value={messageInput()}
                onInput={(e) => { setMessageInput(e.currentTarget.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 160) + 'px'; }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && (messageInput().trim() || attachments().length > 0)) { e.preventDefault(); handleSend(); } }}
                onPaste={(e) => { const items = e.clipboardData?.items; if (!items || !walletAddress()) return; const img = Array.from(items).find((i) => i.type.startsWith('image/')); if (!img) return; e.preventDefault(); const blob = img.getAsFile(); if (!blob) return; const file = new File([blob], `paste.${blob.type.split('/')[1] || 'png'}`, { type: blob.type }); void attachEncryptedFile(file); }}
                disabled={sending() || !walletAddress()} />
              <button class="dm-send-btn" onClick={handleSend} disabled={sending() || (!messageInput().trim() && attachments().length === 0) || !walletAddress()} title={t('chat_send')}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
              </button>
            </div>
          </div>
        </Show>
      </Show>

      <style>{`
        .dm-conv-view { display: flex; flex-direction: column; height: 100%; height: 100dvh; max-height: -webkit-fill-available; }
        .dm-conv-header {
          display: flex;
          align-items: center;
          gap: var(--spacing-md);
          padding: var(--spacing-sm) var(--spacing-md);
          border-bottom: 1px solid var(--color-border);
          background: var(--color-bg-secondary);
        }
        .dm-back-btn {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          padding: var(--spacing-xs) var(--spacing-sm);
          border-radius: var(--radius-md);
        }
        .dm-back-btn:hover { background: var(--color-bg-tertiary); }
        .dm-conv-peer {
          font-weight: 600;
          color: var(--color-accent-primary);
          cursor: pointer;
          font-size: var(--font-size-sm);
        }
        .dm-conv-peer:hover { text-decoration: underline; }
        .dm-conv-messages {
          flex: 1;
          overflow-y: auto;
          padding: var(--spacing-md);
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
        }
        .dm-conv-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--color-text-secondary);
        }
        .dm-msg {
          max-width: 70%;
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-lg);
        }
        .dm-msg.own {
          align-self: flex-end;
          background: color-mix(in srgb, var(--color-accent-primary) 35%, var(--color-bg-secondary));
          border: 1px solid var(--color-accent-primary);
        }
        .dm-msg.peer {
          align-self: flex-start;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
        }
        .dm-msg-body { font-size: var(--font-size-md); line-height: 1.5; }
        .dm-msg-time {
          display: block;
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          text-align: right;
          margin-top: var(--spacing-xs);
        }
        .dm-media-bar {
          padding: var(--spacing-xs) var(--spacing-md);
          border-top: 1px solid var(--color-border);
        }
        .dm-send-error {
          padding: var(--spacing-xs) var(--spacing-md);
          background: var(--color-error);
          color: white;
          font-size: var(--font-size-sm);
          cursor: pointer;
          text-align: center;
        }
        .dm-input-area {
          border-top: 1px solid var(--color-border);
          padding: var(--spacing-sm) var(--spacing-md);
        }
        .dm-input-row {
          display: flex;
          gap: var(--spacing-sm);
          align-items: flex-end;
        }
        .dm-textarea {
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
        .dm-textarea:focus { outline: none; border-color: var(--color-accent-primary); }
        .dm-textarea:disabled { opacity: 0.6; }
        .dm-input-actions {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-xs);
          align-items: center;
        }
        .dm-emoji-container { position: relative; }
        .dm-emoji-toggle {
          font-size: var(--font-size-lg);
          padding: var(--spacing-xs);
          border-radius: var(--radius-sm);
          cursor: pointer;
        }
        .dm-emoji-toggle:hover { background: var(--color-bg-tertiary); }
        .dm-emoji-toggle:disabled { opacity: 0.4; cursor: default; }
        .dm-send-btn {
          padding: var(--spacing-sm) var(--spacing-lg);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-sm);
        }
        .dm-send-btn:disabled { opacity: 0.5; cursor: default; }
        .dm-msg-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; margin-top: var(--spacing-xs); }
        .dm-msg:hover .dm-msg-actions { opacity: 1; }
        .dm-action-btn { font-size: var(--font-size-xs); color: var(--color-text-secondary); cursor: pointer; padding: 2px 4px; border-radius: var(--radius-sm); }
        .dm-action-btn:hover { color: var(--color-accent-primary); background: var(--color-bg-tertiary); }
        .dm-context-menu {
          position: fixed;
          z-index: 1000;
          min-width: 160px;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
          padding: 4px;
          display: flex;
          flex-direction: column;
        }
        .dm-ctx-emoji {
          display: flex;
          gap: 2px;
          padding: 4px 6px;
          border-bottom: 1px solid var(--color-border);
          margin-bottom: 4px;
        }
        .dm-ctx-emoji button {
          font-size: 20px;
          padding: 4px 5px;
          border-radius: var(--radius-sm);
          cursor: pointer;
          line-height: 1;
          background: none;
          border: none;
          transition: transform 0.1s;
        }
        .dm-ctx-emoji button:hover { transform: scale(1.2); }
        .dm-ctx-item {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 8px 12px;
          background: none;
          border: none;
          border-radius: var(--radius-sm);
          color: var(--color-text-primary);
          font-size: var(--font-size-sm);
          text-align: left;
          cursor: pointer;
        }
        .dm-ctx-item:hover { background: var(--color-bg-tertiary); }
        .dm-ctx-danger { color: var(--color-error, #e5484d); }
        .dm-verify-overlay {
          position: fixed;
          inset: 0;
          z-index: 1100;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--spacing-lg);
        }
        .dm-verify-modal {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
          padding: var(--spacing-xl);
          max-width: 360px;
          text-align: center;
          display: flex;
          flex-direction: column;
          gap: var(--spacing-md);
        }
        .dm-verify-icon { font-size: 32px; }
        .dm-verify-text { margin: 0; color: var(--color-text-primary); line-height: 1.5; }
        .dm-verify-actions { display: flex; gap: var(--spacing-sm); justify-content: center; }
        .dm-verify-cancel, .dm-verify-go {
          padding: 8px 16px;
          border-radius: var(--radius-md);
          cursor: pointer;
          font-size: var(--font-size-sm);
          border: 1px solid var(--color-border);
        }
        .dm-verify-cancel { background: var(--color-bg-tertiary); color: var(--color-text-secondary); }
        .dm-verify-go { background: var(--color-accent-primary); color: #fff; border-color: var(--color-accent-primary); font-weight: 600; }
        .dm-verify-go:hover { opacity: 0.9; }
        .dm-react-picker { display: flex; gap: 4px; padding: var(--spacing-xs) 0; }
        .dm-react-btn { font-size: var(--font-size-md); padding: 2px 4px; border-radius: var(--radius-sm); cursor: pointer; }
        .dm-react-btn:hover { background: var(--color-bg-tertiary); }
        .dm-edit-indicator {
          display: flex; align-items: center; justify-content: space-between;
          padding: var(--spacing-xs) var(--spacing-md); background: var(--color-bg-tertiary);
          border-top: 1px solid var(--color-accent-primary); font-size: var(--font-size-sm);
        }
        .dm-edit-label { color: var(--color-accent-primary); font-weight: 600; }
        .dm-edit-cancel { font-size: var(--font-size-xs); color: var(--color-text-secondary); cursor: pointer; padding: var(--spacing-xs); }
        .dm-edit-cancel:hover { color: var(--color-text-primary); }
        .dm-msg.deleted { opacity: 0.5; }
        .dm-msg-deleted { font-style: italic; color: var(--color-text-secondary); }
        .dm-edited { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .dm-msg-reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: var(--spacing-xs); }
        .reaction-badge {
          display: inline-flex; align-items: center; gap: 2px;
          padding: 2px 6px; font-size: var(--font-size-xs);
          background: var(--color-bg-tertiary); border: 1px solid var(--color-border);
          border-radius: var(--radius-full);
        }
      `}</style>
    </div>
  );
};
