/**
 * ComposeView — create or edit a news post.
 *
 * Edit mode: navigate to /compose?edit=<msgId>
 */

import { Component, createSignal, createResource, Show, onMount } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { authStatus, getSigner, walletAddress, isRegistered } from '../lib/auth';
import { navigate, queryParam } from '../lib/router';
import { MediaUpload, type MediaAttachment } from '../components/MediaUpload';
import { EmojiPicker } from '../components/EmojiPicker';
import { getPayloadContent, getPayloadTitle, decodePayload } from '../lib/payload';

export const ComposeView: Component = () => {
  const editMsgId = () => queryParam('edit');
  const isEditMode = () => !!editMsgId();

  const [title, setTitle] = createSignal('');
  const [content, setContent] = createSignal('');
  const [tags, setTags] = createSignal('');
  const [attachments, setAttachments] = createSignal<MediaAttachment[]>([]);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');
  const [loaded, setLoaded] = createSignal(false);
  const [showEmoji, setShowEmoji] = createSignal(false);
  let textareaRef: HTMLTextAreaElement | undefined;

  // Insert an emoji at the textarea cursor (or append to the end if the
  // textarea hasn't been focused yet). Mirrors the pattern used in
  // ChatView's chat composer.
  const insertEmoji = (emoji: string) => {
    const el = textareaRef;
    if (!el) {
      setContent(content() + emoji);
      return;
    }
    const start = el.selectionStart ?? content().length;
    const end = el.selectionEnd ?? content().length;
    const before = content().slice(0, start);
    const after = content().slice(end);
    const next = before + emoji + after;
    setContent(next);
    // Restore caret position just past the inserted emoji on the next
    // tick so SolidJS has rendered the new value.
    queueMicrotask(() => {
      el.focus();
      const pos = before.length + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // In edit mode, fetch the existing post and pre-fill EVERY field —
  // including attachments. The L2 node overwrites the stored payload
  // with the edit envelope's contents, so any field we don't carry
  // through will be lost. Pre-loading attachments lets the user see
  // them in the MediaUpload preview and decide whether to remove any
  // before saving.
  //
  // Failure handling: if the GET fails we KEEP `loaded()` false and
  // set an error message instead. The Save button's disabled predicate
  // includes `!loaded()` for edit mode, so the user can't accidentally
  // submit a half-loaded form (which would send `attachments: []` and
  // wipe every attachment server-side).
  onMount(async () => {
    const eid = editMsgId();
    if (!eid) { setLoaded(true); return; }
    try {
      const client = getClient();
      const resp = await client.getNewsPost(eid);
      if (!resp?.post) {
        setError(t('error_generic'));
        return; // leave loaded() false → Save stays disabled
      }
      const post = resp.post;
      setTitle(getPayloadTitle(post.payload) || '');
      setContent(getPayloadContent(post.payload));
      try {
        const decoded = decodePayload(post.payload);
        if (decoded.tags) setTags(decoded.tags.join(', '));
        if (decoded.attachments && decoded.attachments.length > 0) {
          // PayloadAttachment shape matches MediaAttachment (cid,
          // mime_type, size_bytes, filename, thumbnail_cid) so we
          // can pass through directly.
          setAttachments(decoded.attachments.map((a) => ({
            cid: a.cid,
            mime_type: a.mime_type,
            size_bytes: a.size_bytes,
            filename: a.filename,
            thumbnail_cid: a.thumbnail_cid,
          })));
        }
      } catch { /* ignore tag/attachment decode errors — title+content still loaded */ }
      setLoaded(true);
    } catch (e: any) {
      // Network or auth failure — leave loaded() false so submit stays
      // locked. Surface the error so the user knows to retry.
      setError(e?.message || t('error_generic'));
    }
  });

  const handleSubmit = async () => {
    if (!content().trim()) return;
    if (!getSigner() || !walletAddress()) {
      setError(t('auth_required'));
      return;
    }
    // Block submission until pre-fill has completed so the user can't
    // accidentally clobber the existing title / tags / attachments by
    // submitting an empty form before the fetch resolves.
    if (isEditMode() && !loaded()) return;

    setSubmitting(true);
    setError('');
    try {
      const tagList = tags()
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);

      const client = getClient();

      if (isEditMode()) {
        // Edit existing post — pass attachments explicitly so the
        // server doesn't drop them when it rewrites the payload.
        await client.editNews(editMsgId()!, content().trim(), {
          title: title().trim() || undefined,
          tags: tagList.length > 0 ? tagList : undefined,
          attachments: attachments().length > 0 ? attachments() : undefined,
        });
        navigate(`/news/${editMsgId()}`);
      } else {
        // Create new post
        await client.postNews(title().trim(), content().trim(), {
          tags: tagList.length > 0 ? tagList : undefined,
          attachments: attachments().length > 0 ? attachments() : undefined,
        });
        navigate('/news');
      }
    } catch (e: any) {
      setError(e.message || t('error_generic'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="compose-view">
      <div class="compose-header">
        <h2>{isEditMode() ? t('news_edit') : t('news_new_post')}</h2>
        <button class="compose-cancel" onClick={() => isEditMode() ? navigate(`/news/${editMsgId()}`) : navigate('/news')}>
          {t('compose_cancel')}
        </button>
      </div>

      <Show when={authStatus() !== 'ready'}>
        <div class="compose-auth-prompt">{t('auth_connect_prompt')}</div>
      </Show>

      <Show when={isEditMode() && authStatus() === 'ready' && !isRegistered()}>
        <div class="compose-auth-prompt">
          <p>{t('verification_required')}</p>
          <button onClick={() => navigate('/wallet')}>{t('verification_go_to_wallet')}</button>
        </div>
      </Show>

      <Show when={error()}>
        <div class="compose-error">{error()}</div>
      </Show>

      <Show when={!isEditMode() || isRegistered()}>
      <div class="compose-form">
        <input
          type="text"
          class="compose-input"
          placeholder={t('compose_title')}
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          maxLength={200}
        />
        <div class="compose-textarea-wrap">
          <textarea
            ref={(el) => { textareaRef = el; }}
            class="compose-textarea"
            placeholder={t('compose_content')}
            value={content()}
            onInput={(e) => setContent(e.currentTarget.value)}
            rows={10}
            maxLength={10000}
          />
          <button
            class="compose-emoji-btn"
            type="button"
            onClick={() => setShowEmoji(!showEmoji())}
            title="Emoji"
            disabled={submitting()}
          >
            😊
          </button>
          <Show when={showEmoji()}>
            <EmojiPicker onSelect={insertEmoji} onClose={() => setShowEmoji(false)} />
          </Show>
        </div>
        <input
          type="text"
          class="compose-input"
          placeholder={t('compose_tags')}
          value={tags()}
          onInput={(e) => setTags(e.currentTarget.value)}
        />
        {/* MediaUpload is now shown in edit mode too — pre-filled with
            the post's existing attachments. Removing the previous
            `<Show when={!isEditMode()}>` guard, which hid the upload
            UI on edit and caused every attachment to silently
            disappear when the user saved. */}
        <MediaUpload
          attachments={attachments()}
          onAttach={(att) => setAttachments((prev) => [...prev, att])}
          onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
          disabled={submitting()}
        />
        <button
          class="compose-submit"
          onClick={handleSubmit}
          disabled={
            submitting()
            || !content().trim()
            || authStatus() !== 'ready'
            || (isEditMode() && !isRegistered())
            // Disable while the existing post is still loading — without
            // this, a fast click would send `attachments: []` and wipe
            // every attachment on the server.
            || (isEditMode() && !loaded())
          }
        >
          {submitting() ? t('loading') : isEditMode() ? t('news_save_edit') : t('compose_submit')}
        </button>
      </div>
      </Show>

      <style>{`
        .compose-view {
          padding: var(--spacing-lg);
          overflow-y: auto;
          height: 100%;
          max-width: 700px;
        }
        .compose-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: var(--spacing-lg);
        }
        .compose-header h2 { font-size: var(--font-size-xl); }
        .compose-cancel {
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-md);
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
        }
        .compose-cancel:hover { background: var(--color-bg-tertiary); }
        .compose-form { display: flex; flex-direction: column; gap: var(--spacing-md); }
        .compose-input, .compose-textarea {
          width: 100%;
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-family: inherit;
          font-size: var(--font-size-md);
        }
        .compose-textarea { resize: vertical; min-height: 200px; line-height: 1.6; padding-right: 44px; }
        .compose-input:focus, .compose-textarea:focus { outline: none; border-color: var(--color-accent-primary); }
        .compose-textarea-wrap { position: relative; }
        .compose-emoji-btn {
          position: absolute;
          top: 8px;
          right: 8px;
          width: 32px;
          height: 32px;
          border-radius: var(--radius-sm);
          background: transparent;
          color: var(--color-text-secondary);
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
        }
        .compose-emoji-btn:hover:not(:disabled) {
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
        }
        .compose-emoji-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .compose-submit {
          padding: var(--spacing-sm) var(--spacing-lg);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-md);
          align-self: flex-end;
        }
        .compose-submit:hover { opacity: 0.9; }
        .compose-submit:disabled { opacity: 0.5; cursor: not-allowed; }
        .compose-error {
          padding: var(--spacing-sm) var(--spacing-md);
          background: var(--color-error);
          color: white;
          border-radius: var(--radius-md);
          font-size: var(--font-size-sm);
          margin-bottom: var(--spacing-md);
        }
        .compose-auth-prompt {
          padding: var(--spacing-md);
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          text-align: center;
          color: var(--color-text-secondary);
          margin-bottom: var(--spacing-md);
        }
      `}</style>
    </div>
  );
};
