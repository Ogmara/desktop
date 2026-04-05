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

  // In edit mode, fetch the existing post and pre-fill fields
  onMount(async () => {
    const eid = editMsgId();
    if (!eid) { setLoaded(true); return; }
    try {
      const client = getClient();
      const resp = await client.getNewsPost(eid);
      if (resp?.post) {
        const post = resp.post;
        setTitle(getPayloadTitle(post.payload) || '');
        setContent(getPayloadContent(post.payload));
        try {
          const decoded = decodePayload(post.payload);
          if (decoded.tags) setTags(decoded.tags.join(', '));
        } catch { /* ignore */ }
      }
    } catch { /* failed to fetch */ }
    setLoaded(true);
  });

  const handleSubmit = async () => {
    if (!content().trim()) return;
    if (!getSigner() || !walletAddress()) {
      setError(t('auth_required'));
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const tagList = tags()
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);

      const client = getClient();

      if (isEditMode()) {
        // Edit existing post
        await client.editNews(editMsgId()!, content().trim(), {
          title: title().trim() || undefined,
          tags: tagList.length > 0 ? tagList : undefined,
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
        <textarea
          class="compose-textarea"
          placeholder={t('compose_content')}
          value={content()}
          onInput={(e) => setContent(e.currentTarget.value)}
          rows={10}
          maxLength={10000}
        />
        <input
          type="text"
          class="compose-input"
          placeholder={t('compose_tags')}
          value={tags()}
          onInput={(e) => setTags(e.currentTarget.value)}
        />
        <Show when={!isEditMode()}>
          <MediaUpload
            attachments={attachments()}
            onAttach={(att) => setAttachments((prev) => [...prev, att])}
            onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
            disabled={submitting()}
          />
        </Show>
        <button
          class="compose-submit"
          onClick={handleSubmit}
          disabled={submitting() || !content().trim() || authStatus() !== 'ready' || (isEditMode() && !isRegistered())}
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
        .compose-textarea { resize: vertical; min-height: 200px; line-height: 1.6; }
        .compose-input:focus, .compose-textarea:focus { outline: none; border-color: var(--color-accent-primary); }
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
