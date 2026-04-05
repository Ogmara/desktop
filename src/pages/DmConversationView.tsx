/**
 * DmConversationView — direct message conversation with a peer.
 */

import { Component, createResource, createSignal, createMemo, For, Show, onCleanup, onMount } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { authStatus, walletAddress, getSigner, isRegistered } from '../lib/auth';
import { onWsEvent } from '../lib/ws';
import { navigate } from '../lib/router';
import { FormattedText } from '../components/FormattedText';
import { MediaUpload, type MediaAttachment } from '../components/MediaUpload';
import { getPayloadContent, getPayloadAttachments } from '../lib/payload';
import { EmojiPicker } from '../components/EmojiPicker';
import { buildDirectMessage } from '@ogmara/sdk';

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
  const EDIT_WINDOW_MS = 30 * 60 * 1000;
  let inputRef: HTMLTextAreaElement | undefined;

  const [messages] = createResource(
    () => props.peerAddress,
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

  const MAX_LOCAL_MESSAGES = 200;

  // Real-time DM updates
  const cleanup = onWsEvent((event) => {
    if (event.type === 'dm') {
      const msg = event.envelope;
      if (msg.author === props.peerAddress || msg.author === walletAddress()) {
        setLocalMessages((prev) => {
          const next = [...prev, msg];
          return next.length > MAX_LOCAL_MESSAGES ? next.slice(-MAX_LOCAL_MESSAGES) : next;
        });
        // Mark as read while viewing so unread badge doesn't appear
        if (authStatus() === 'ready') {
          getClient().markDmRead(props.peerAddress).catch(() => {});
        }
      }
    }
  });
  onCleanup(cleanup);

  // Deduplicate by msg_id
  const allMessages = () => {
    const seen = new Set<string>();
    const combined = [...(messages() || []), ...localMessages()];
    return combined.filter((msg) => {
      if (!msg.msg_id || seen.has(msg.msg_id)) return false;
      seen.add(msg.msg_id);
      return true;
    });
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
      const envelope = await buildDirectMessage(signer, {
        recipient: props.peerAddress,
        content: text,
        attachments: atts.length > 0 ? atts : undefined,
      });
      await client.sendDm(props.peerAddress, envelope);
      setMessageInput('');
      setAttachments([]);

      // Optimistic: show sent message immediately
      setLocalMessages((prev) => [...prev, {
        msg_id: `local-${Date.now()}`,
        author: walletAddress(),
        timestamp: Date.now(),
        payload: text,
      }]);

      setTimeout(() => inputRef?.focus(), 50);
    } catch (err: any) {
      console.error('sendDm failed:', err);
      const msg = err?.message || String(err);
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

  const canEdit = (msg: any) =>
    isRegistered() &&
    msg.author === walletAddress() && !msg.deleted &&
    (Date.now() - new Date(msg.timestamp).getTime()) < EDIT_WINDOW_MS;

  const canDelete = (msg: any) =>
    isRegistered() && msg.author === walletAddress() && !msg.deleted;

  const startEdit = (msg: any) => {
    setEditingMsg({ msgId: msgIdToHex(msg.msg_id), content: getPayloadContent(msg.payload) });
    setMessageInput(getPayloadContent(msg.payload));
    inputRef?.focus();
  };

  const cancelEdit = () => { setEditingMsg(null); setMessageInput(''); };

  const handleEdit = async () => {
    const edit = editingMsg();
    if (!edit || !messageInput().trim()) return;
    setSending(true);
    try {
      const client = getClient();
      await client.editDm(props.peerAddress, edit.msgId, messageInput().trim());
      setLocalMessages((prev) => prev.map((m) =>
        msgIdToHex(m.msg_id) === edit.msgId
          ? { ...m, payload: messageInput().trim(), edited: true }
          : m,
      ));
      setEditingMsg(null);
      setMessageInput('');
    } catch { /* failed */ }
    finally { setSending(false); }
  };

  const handleDeleteDm = async (msg: any) => {
    if (!window.confirm(t('chat_delete_confirm'))) return;
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
        <button class="dm-back-btn" onClick={() => navigate('/dm')}>
          ← {t('nav_dms')}
        </button>
        <span
          class="dm-conv-peer"
          onClick={() => navigate(`/user/${props.peerAddress}`)}
        >
          {truncateAddress(props.peerAddress)}
        </span>
      </div>

      <div class="dm-conv-messages">
        <Show
          when={allMessages().length > 0}
          fallback={<div class="dm-conv-empty">{t('dm_no_messages')}</div>}
        >
          <For each={allMessages()}>
            {(msg) => (
              <div
                class={`dm-msg ${msg.author === walletAddress() ? 'own' : 'peer'} ${msg.deleted ? 'deleted' : ''}`}
              >
                <Show
                  when={!msg.deleted}
                  fallback={<div class="dm-msg-body dm-msg-deleted">{t('message_deleted')}</div>}
                >
                  <div class="dm-msg-body">
                    <FormattedText content={getPayloadContent(msg.payload)} attachments={getPayloadAttachments(msg.payload)} />
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

      <Show when={editingMsg()}>
        <div class="dm-edit-indicator">
          <span class="dm-edit-label">✏ {t('chat_edit_mode')}</span>
          <button class="dm-edit-cancel" onClick={cancelEdit}>{t('chat_edit_cancel')}</button>
        </div>
      </Show>

      <Show when={authStatus() === 'ready'}>
        <Show when={!editingMsg()}>
          <div class="dm-media-bar">
            <MediaUpload
              attachments={attachments()}
              onAttach={(a) => setAttachments((prev) => [...prev, a])}
              onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
              disabled={sending()}
            />
          </div>
        </Show>
        <Show when={sendError()}>
          <div class="dm-send-error" onClick={() => setSendError(null)}>
            {sendError()}
          </div>
        </Show>
        <div class="dm-input-area">
          <div class="dm-input-row">
            <textarea
              ref={inputRef}
              class="dm-textarea"
              rows={3}
              placeholder={t('chat_placeholder')}
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
                e.preventDefault();
                const file = imageItem.getAsFile();
                if (!file) return;
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
            <div class="dm-input-actions">
              <div class="dm-emoji-container">
                <button
                  class="dm-emoji-toggle"
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
                class="dm-send-btn"
                onClick={handleSend}
                disabled={sending() || (!messageInput().trim() && attachments().length === 0) || !walletAddress()}
              >
                {t('chat_send')}
              </button>
            </div>
          </div>
        </div>
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
