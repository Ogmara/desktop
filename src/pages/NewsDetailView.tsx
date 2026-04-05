/**
 * NewsDetailView — thread view for a single news post with comments.
 *
 * Fetches the post and its comments via getNewsPost(), displays the full
 * post content with all interactions, and shows a threaded comment section
 * with a reply form for authenticated users.
 */

import { Component, createResource, createSignal, createEffect, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { authStatus, getSigner, l2Address, walletAddress, isRegistered } from '../lib/auth';
import { navigate, goBack, routeParam } from '../lib/router';
import { FormattedText } from '../components/FormattedText';
import { getPayloadContent, getPayloadTitle, getPayloadAttachments, decodePayload } from '../lib/payload';
import { MediaUpload, type MediaAttachment } from '../components/MediaUpload';
import { sendTip, kleverAvailable, getExplorerUrl } from '../lib/klever';
import { resolveProfile, type CachedProfile } from '../lib/profile';
import { ensureHexMsgId, formatLocalTime, truncateAddress } from '../lib/news-utils';
import { ReactionPicker } from '../components/ReactionPicker';

/** Single comment in the thread. */
const CommentCard: Component<{ comment: any; onReply: (msgId: string, author: string) => void }> = (props) => {
  const [profile, setProfile] = createSignal<CachedProfile>({});

  createEffect(() => {
    resolveProfile(props.comment.author).then(setProfile);
  });


  const displayName = () => profile().display_name || truncateAddress(props.comment.author);

  return (
    <div class="comment-card">
      <div class="comment-header">
        <div class="comment-author-row" onClick={() => navigate(`/user/${props.comment.author}`)}>
          <Show when={profile().avatar_cid}>
            <img
              class="comment-avatar"
              src={getClient().getMediaUrl(profile().avatar_cid!)}
              alt=""
              loading="lazy"
            />
          </Show>
          <Show when={!profile().avatar_cid}>
            <span class="comment-avatar-placeholder">
              {(profile().display_name || props.comment.author).slice(0, 2).toUpperCase()}
            </span>
          </Show>
          <span class="comment-author">{displayName()}</span>
          <Show when={profile().verified}>
            <span class="comment-verified" title="On-chain verified">✓</span>
          </Show>
        </div>
        <span class="comment-time">{formatLocalTime(props.comment.timestamp)}</span>
      </div>
      <Show
        when={!props.comment.deleted}
        fallback={<div class="comment-body comment-deleted-text">{t('message_deleted')}</div>}
      >
        <div class="comment-body">
          <FormattedText content={getPayloadContent(props.comment.payload)} />
        </div>
      </Show>
      <Show when={getPayloadAttachments(props.comment.payload).length > 0}>
        <div class="comment-attachments">
          <For each={getPayloadAttachments(props.comment.payload)}>
            {(att) => (
              <Show
                when={att.mime_type.startsWith('image/')}
                fallback={
                  <a class="detail-file-link" href={getClient().getMediaUrl(att.cid)} target="_blank" rel="noopener noreferrer">
                    📎 {att.filename || att.cid.slice(0, 12)}
                  </a>
                }
              >
                <a href={getClient().getMediaUrl(att.cid)} target="_blank" rel="noopener noreferrer">
                  <img class="comment-attachment-img" src={getClient().getMediaUrl(att.thumbnail_cid || att.cid)} alt={att.filename || ''} loading="lazy" />
                </a>
              </Show>
            )}
          </For>
        </div>
      </Show>
      <div class="comment-actions">
        <button
          class="comment-reply-btn"
          onClick={() => props.onReply(ensureHexMsgId(props.comment.msg_id), displayName())}
        >
          ↩ {t('news_reply')}
        </button>
      </div>
    </div>
  );
};

export const NewsDetailView: Component = () => {
  const msgId = () => routeParam('msgId') || '';

  const [postData, { refetch }] = createResource(msgId, async (id) => {
    if (!id) return null;
    try {
      const client = getClient();
      return await client.getNewsPost(id);
    } catch {
      return null;
    }
  });

  // Post author profile
  const [postProfile, setPostProfile] = createSignal<CachedProfile>({});

  createEffect(() => {
    const data = postData();
    if (data?.post?.author) {
      resolveProfile(data.post.author).then(setPostProfile);
    }
  });

  // Reaction state
  const [reactionCounts, setReactionCounts] = createSignal<Record<string, number>>({});
  createEffect(() => {
    const data = postData();
    if (data?.post?.reaction_counts) {
      setReactionCounts(data.post.reaction_counts);
    }
  });

  // Bookmark state
  const [bookmarked, setBookmarked] = createSignal(false);
  const [reposted, setReposted] = createSignal(false);
  const [actionError, setActionError] = createSignal('');

  // Tip state
  const [showTip, setShowTip] = createSignal(false);
  const [tipAmount, setTipAmount] = createSignal('1');
  const [tipNote, setTipNote] = createSignal('');
  const [tipPending, setTipPending] = createSignal(false);
  const [tipTxHash, setTipTxHash] = createSignal('');

  // Comment compose state
  const [commentText, setCommentText] = createSignal('');
  const [replyTo, setReplyTo] = createSignal<{ msgId: string; authorName: string } | null>(null);
  const [commentPending, setCommentPending] = createSignal(false);
  const [commentError, setCommentError] = createSignal('');
  const [commentAttachments, setCommentAttachments] = createSignal<MediaAttachment[]>([]);
  let commentInputRef: HTMLTextAreaElement | undefined;

  const EDIT_WINDOW_MS = 30 * 60 * 1000;

  const isOwnPost = () => {
    const post = postData()?.post;
    return post && (post.author === walletAddress() || post.author === l2Address());
  };

  const canEditPost = () =>
    isOwnPost() && isRegistered() &&
    postData()?.post && !postData()!.post.deleted &&
    (Date.now() - new Date(postData()!.post.timestamp).getTime()) < EDIT_WINDOW_MS;

  const canDeletePost = () => isOwnPost() && isRegistered() && postData()?.post && !postData()!.post.deleted;

  const requireAuthOrRedirect = (): boolean => {
    if (!getSigner() || !walletAddress()) {
      navigate('/wallet');
      return false;
    }
    return true;
  };


  const displayName = () => {
    const p = postProfile();
    const post = postData()?.post;
    return p.display_name || (post ? truncateAddress(post.author) : '...');
  };

  // Extract tags from post payload
  const postTags = () => {
    const post = postData()?.post;
    if (!post || typeof post.payload === 'string') return [];
    try {
      return decodePayload(post.payload).tags ?? [];
    } catch {
      return [];
    }
  };

  const handleReaction = async (emoji: string) => {
    if (!requireAuthOrRedirect()) return;
    setActionError('');
    try {
      const client = getClient();
      const current = reactionCounts()[emoji] ?? 0;
      await client.reactToNews(msgId(), emoji);
      setReactionCounts((prev) => ({ ...prev, [emoji]: current + 1 }));
    } catch (e: any) {
      setActionError(e?.message || 'Reaction failed');
    }
  };

  const handleBookmark = async () => {
    if (!requireAuthOrRedirect()) return;
    setActionError('');
    try {
      const client = getClient();
      if (bookmarked()) {
        await client.removeBookmark(msgId());
        setBookmarked(false);
      } else {
        await client.saveBookmark(msgId());
        setBookmarked(true);
      }
    } catch (e: any) {
      setActionError(e?.message || 'Bookmark failed');
    }
  };

  const handleRepost = async () => {
    if (!requireAuthOrRedirect()) return;
    if (reposted()) return;
    const post = postData()?.post;
    if (!post) return;
    if (post.author === l2Address() || post.author === walletAddress()) {
      setActionError(t('news_repost_own'));
      return;
    }
    setActionError('');
    try {
      const client = getClient();
      await client.repostNews(msgId(), post.author);
      setReposted(true);
    } catch (e: any) {
      setActionError(e?.message || 'Repost failed');
    }
  };

  const handleEditPost = () => {
    navigate(`/compose?edit=${msgId()}`);
  };

  const handleDeletePost = async () => {
    if (!requireAuthOrRedirect()) return;
    if (!window.confirm(t('news_delete_confirm'))) return;
    setActionError('');
    try {
      const client = getClient();
      await client.deleteNews(msgId());
      navigate('/news');
    } catch (e: any) {
      setActionError(e?.message || 'Delete failed');
    }
  };

  const handleTip = async () => {
    if (!requireAuthOrRedirect()) return;
    if (!kleverAvailable()) {
      setActionError('Klever Extension required for tipping');
      return;
    }
    const amount = parseFloat(tipAmount());
    if (isNaN(amount) || amount <= 0) {
      setActionError('Enter a valid tip amount');
      return;
    }
    setActionError('');
    setTipTxHash('');
    setTipPending(true);
    try {
      const post = postData()?.post;
      if (!post) return;
      const txHash = await sendTip(post.author, msgId(), 0, tipNote(), amount);
      setTipTxHash(txHash);
      setTipAmount('1');
      setTipNote('');
    } catch (e: any) {
      setActionError(e?.message || 'Tip failed');
    } finally {
      setTipPending(false);
    }
  };

  const handleSubmitComment = async () => {
    if (!requireAuthOrRedirect()) return;
    const text = commentText().trim();
    if (!text) return;
    setCommentPending(true);
    setCommentError('');
    try {
      const client = getClient();
      await client.postComment(msgId(), text, {
        replyTo: replyTo()?.msgId,
        attachments: commentAttachments().length > 0 ? commentAttachments() : undefined,
      });
      setCommentText('');
      setReplyTo(null);
      setCommentAttachments([]);
      refetch();
    } catch (e: any) {
      setCommentError(e?.message || 'Failed to post comment');
    } finally {
      setCommentPending(false);
    }
  };

  const handleReplyToComment = (commentMsgId: string, authorName: string) => {
    setReplyTo({ msgId: commentMsgId, authorName });
    commentInputRef?.focus();
  };

  return (
    <div class="news-detail-view">
      {/* Back navigation */}
      <div class="detail-nav">
        <button class="back-btn" onClick={() => goBack()}>← {t('news_back_to_feed')}</button>
      </div>

      <Show when={postData.loading}>
        <div class="detail-loading">{t('loading')}</div>
      </Show>

      <Show when={!postData.loading && !postData()?.post}>
        <div class="detail-not-found">{t('error_not_found')}</div>
      </Show>

      <Show when={postData()?.post}>
        {/* Main post */}
        <article class="detail-post">
          <div class="detail-post-header">
            <div class="detail-author-row" onClick={() => navigate(`/user/${postData()!.post.author}`)}>
              <Show when={postProfile().avatar_cid}>
                <img
                  class="detail-avatar"
                  src={getClient().getMediaUrl(postProfile().avatar_cid!)}
                  alt=""
                  loading="lazy"
                />
              </Show>
              <Show when={!postProfile().avatar_cid}>
                <span class="detail-avatar-placeholder">
                  {(postProfile().display_name || postData()!.post.author).slice(0, 2).toUpperCase()}
                </span>
              </Show>
              <span class="detail-author">{displayName()}</span>
              <Show when={postProfile().verified}>
                <span class="detail-verified" title="On-chain verified">✓</span>
              </Show>
            </div>
            <span class="detail-time">
              {formatLocalTime(postData()!.post.timestamp)}
              <Show when={postData()!.post.edited}>
                <span class="detail-edited"> ({t('message_edited')})</span>
              </Show>
            </span>
          </div>

          <Show when={getPayloadTitle(postData()!.post.payload)}>
            <h2 class="detail-title">{getPayloadTitle(postData()!.post.payload)}</h2>
          </Show>
          <div class="detail-body">
            <FormattedText content={getPayloadContent(postData()!.post.payload)} />
          </div>
          <Show when={getPayloadAttachments(postData()!.post.payload).length > 0}>
            <div class="detail-attachments">
              <For each={getPayloadAttachments(postData()!.post.payload)}>
                {(att) => (
                  <Show
                    when={att.mime_type.startsWith('image/')}
                    fallback={
                      <a class="detail-file-link" href={getClient().getMediaUrl(att.cid)} target="_blank" rel="noopener noreferrer">
                        📎 {att.filename || att.cid.slice(0, 12)}
                      </a>
                    }
                  >
                    <a href={getClient().getMediaUrl(att.cid)} target="_blank" rel="noopener noreferrer">
                      <img class="detail-attachment-img" src={getClient().getMediaUrl(att.thumbnail_cid || att.cid)} alt={att.filename || ''} loading="lazy" />
                    </a>
                  </Show>
                )}
              </For>
            </div>
          </Show>

          <Show when={postTags().length > 0}>
            <div class="detail-tags">
              <For each={postTags()}>
                {(tag) => (
                  <button class="detail-tag" onClick={() => navigate(`/search?q=${encodeURIComponent('#' + tag)}`)}>
                    #{tag}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={actionError()}>
            <div class="detail-action-error">{actionError()}</div>
          </Show>

          {/* Actions bar */}
          <div class="detail-actions">
            <Show when={canEditPost()}>
              <button class="action-btn" onClick={handleEditPost} title={t('news_edit')}>
                ✏ {t('news_edit')}
              </button>
            </Show>
            <Show when={canDeletePost()}>
              <button class="action-btn" onClick={handleDeletePost} title={t('news_delete')} style="color: var(--color-error)">
                🗑 {t('news_delete')}
              </button>
            </Show>
            <ReactionPicker counts={reactionCounts()} onReact={handleReaction} />
            <button
              class={`action-btn ${reposted() ? 'active' : ''}`}
              onClick={handleRepost}
              title={t('news_repost')}
            >
              ↗ {t('news_repost')}
            </button>
            <button
              class={`action-btn ${bookmarked() ? 'active' : ''}`}
              onClick={handleBookmark}
              title={bookmarked() ? t('news_bookmarked') : t('news_bookmark')}
            >
              {bookmarked() ? '★' : '☆'} {bookmarked() ? t('news_bookmarked') : t('news_bookmark')}
            </button>
            <button
              class="tip-btn"
              onClick={() => {
                if (!requireAuthOrRedirect()) return;
                setShowTip(!showTip());
              }}
              title={t('chat_tip')}
            >
              💰 {t('chat_tip')}
            </button>
            <Show when={!isOwnPost() && walletAddress()}>
              <button
                class="action-btn"
                onClick={async () => {
                  if (!requireAuthOrRedirect()) return;
                  const reason = window.prompt(t('report_reason'));
                  if (reason !== null) {
                    try {
                      const client = getClient();
                      await client.reportMessage(msgId(), (reason || 'No reason').slice(0, 500), 'other');
                      setActionError('');
                    } catch (e: any) {
                      setActionError(e?.message || 'Report failed');
                    }
                  }
                }}
                title={t('report_title')}
              >
                🚩 {t('report_title')}
              </button>
            </Show>
          </div>

          {/* Tip dialog */}
          <Show when={showTip()}>
            <div class="tip-dialog">
              <div class="tip-dialog-header">
                <strong>Tip {displayName()}</strong>
                <button class="tip-dialog-close" onClick={() => setShowTip(false)}>✕</button>
              </div>
              <div class="tip-dialog-body">
                <label class="tip-label">Amount (KLV)</label>
                <input
                  type="number"
                  class="tip-input"
                  min="0.1"
                  step="0.1"
                  value={tipAmount()}
                  onInput={(e) => setTipAmount(e.currentTarget.value)}
                />
                <label class="tip-label">Note (optional)</label>
                <input
                  type="text"
                  class="tip-input"
                  maxLength={128}
                  placeholder="Say thanks..."
                  value={tipNote()}
                  onInput={(e) => setTipNote(e.currentTarget.value)}
                />
                <Show when={!tipTxHash()}>
                  <button
                    class="tip-confirm-btn"
                    onClick={handleTip}
                    disabled={tipPending()}
                  >
                    {tipPending() ? 'Sending...' : `Send ${tipAmount()} KLV`}
                  </button>
                </Show>
                <Show when={tipTxHash()}>
                  <div class="tip-success">
                    Tip sent!{' '}
                    <a
                      href={`${getExplorerUrl()}/transaction/${tipTxHash()}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="tip-tx-link"
                    >
                      {tipTxHash().slice(0, 12)}...
                    </a>
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </article>

        {/* Comments section */}
        <div class="comments-section">
          <h3 class="comments-heading">
            {t('news_comments')}
            <Show when={(postData()?.comments?.length ?? 0) > 0}>
              <span class="comments-count">({postData()!.comments.length})</span>
            </Show>
          </h3>

          {/* Comment compose */}
          <Show when={authStatus() === 'ready'}>
            <div class="comment-compose">
              <Show when={replyTo()}>
                <div class="comment-reply-indicator">
                  {t('news_replying_to')} <strong>{replyTo()!.authorName}</strong>
                  <button class="comment-reply-cancel" onClick={() => setReplyTo(null)}>✕</button>
                </div>
              </Show>
              <textarea
                class="comment-input"
                ref={commentInputRef}
                rows={3}
                placeholder={t('news_comment_placeholder')}
                value={commentText()}
                onInput={(e) => setCommentText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    handleSubmitComment();
                  }
                }}
              />
              <MediaUpload
                attachments={commentAttachments()}
                onAttach={(att) => setCommentAttachments((prev) => [...prev, att])}
                onRemove={(i) => setCommentAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                disabled={commentPending()}
              />
              <Show when={commentError()}>
                <div class="comment-error">{commentError()}</div>
              </Show>
              <div class="comment-compose-footer">
                <span class="comment-hint">Ctrl+Enter {t('chat_send').toLowerCase()}</span>
                <button
                  class="comment-submit-btn"
                  onClick={handleSubmitComment}
                  disabled={commentPending() || !commentText().trim()}
                >
                  {commentPending() ? t('loading') : t('news_post_comment')}
                </button>
              </div>
            </div>
          </Show>
          <Show when={authStatus() !== 'ready'}>
            <div class="comment-auth-prompt">
              <button class="comment-auth-btn" onClick={() => navigate('/wallet')}>
                {t('auth_connect_prompt')}
              </button>
            </div>
          </Show>

          {/* Comments list */}
          <Show
            when={(postData()?.comments?.length ?? 0) > 0}
            fallback={<div class="comments-empty">{t('news_no_comments')}</div>}
          >
            <div class="comments-list">
              <For each={postData()!.comments}>
                {(comment) => (
                  <CommentCard comment={comment} onReply={handleReplyToComment} />
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      <style>{`
        .news-detail-view { padding: var(--spacing-md); overflow-y: auto; height: 100%; max-width: 720px; }
        .detail-nav { margin-bottom: var(--spacing-md); }
        .back-btn {
          color: var(--color-accent-primary);
          font-size: var(--font-size-sm);
          font-weight: 500;
          cursor: pointer;
          padding: var(--spacing-xs) 0;
        }
        .back-btn:hover { text-decoration: underline; }
        .detail-loading, .detail-not-found {
          text-align: center;
          color: var(--color-text-secondary);
          padding: var(--spacing-xl);
        }

        /* Main post */
        .detail-post {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-lg);
          margin-bottom: var(--spacing-lg);
        }
        .detail-post-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: var(--spacing-md);
        }
        .detail-author-row {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          cursor: pointer;
        }
        .detail-author-row:hover .detail-author { text-decoration: underline; }
        .detail-avatar {
          width: 36px;
          height: 36px;
          border-radius: var(--radius-full);
          object-fit: cover;
        }
        .detail-avatar-placeholder {
          width: 36px;
          height: 36px;
          border-radius: var(--radius-full);
          background: var(--color-accent-secondary);
          color: var(--color-text-inverse);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .detail-author {
          font-weight: 600;
          color: var(--color-accent-primary);
          font-size: var(--font-size-md);
        }
        .detail-verified {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          border-radius: var(--radius-full);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          font-size: 11px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .detail-time { font-size: var(--font-size-sm); color: var(--color-text-secondary); }
        .detail-edited { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .comment-deleted-text { font-style: italic; color: var(--color-text-secondary); opacity: 0.6; }
        .detail-title { font-size: var(--font-size-xl); margin-bottom: var(--spacing-sm); }
        .detail-body { line-height: 1.7; margin-bottom: var(--spacing-md); font-size: var(--font-size-md); }
        .detail-attachments, .comment-attachments {
          display: flex;
          flex-wrap: wrap;
          gap: var(--spacing-sm);
          margin-bottom: var(--spacing-md);
        }
        .detail-attachment-img {
          max-width: 100%;
          max-height: 500px;
          border-radius: var(--radius-md);
          object-fit: contain;
          cursor: pointer;
        }
        .detail-attachment-img:hover { opacity: 0.9; }
        .comment-attachment-img {
          max-width: 100%;
          max-height: 300px;
          border-radius: var(--radius-md);
          object-fit: contain;
          cursor: pointer;
        }
        .comment-attachment-img:hover { opacity: 0.9; }
        .detail-file-link {
          display: inline-flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: var(--spacing-xs) var(--spacing-sm);
          background: var(--color-bg-tertiary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-sm);
          font-size: var(--font-size-sm);
          color: var(--color-accent-primary);
        }
        .detail-file-link:hover { text-decoration: none; background: var(--color-border); }
        .detail-tags {
          display: flex;
          flex-wrap: wrap;
          gap: var(--spacing-xs);
          margin-bottom: var(--spacing-md);
        }
        .detail-tag {
          font-size: var(--font-size-xs);
          color: var(--color-accent-primary);
          background: var(--color-bg-tertiary);
          padding: 2px 8px;
          border-radius: var(--radius-full);
          cursor: pointer;
        }
        .detail-tag:hover { background: var(--color-accent-primary); color: var(--color-text-inverse); }
        .detail-action-error {
          font-size: var(--font-size-sm);
          color: var(--color-error);
          background: var(--color-bg-tertiary);
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-sm);
          border-left: 3px solid var(--color-error);
        }

        /* Actions (shared styles with NewsView) */
        .detail-actions {
          display: flex;
          gap: var(--spacing-sm);
          align-items: center;
          border-top: 1px solid var(--color-border);
          padding-top: var(--spacing-sm);
          flex-wrap: wrap;
        }
        .action-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          border-radius: var(--radius-sm);
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          cursor: pointer;
          margin-left: auto;
        }
        .action-btn:hover { color: var(--color-accent-primary); }
        .action-btn.active { color: var(--color-accent-primary); }
        .tip-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          border-radius: var(--radius-sm);
          font-size: var(--font-size-sm);
          color: var(--color-warning);
          cursor: pointer;
        }
        .tip-btn:hover { color: var(--color-accent-primary); }
        .tip-dialog {
          margin-top: var(--spacing-sm);
          padding: var(--spacing-md);
          background: var(--color-bg-tertiary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
        }
        .tip-dialog-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: var(--spacing-sm);
          font-size: var(--font-size-sm);
        }
        .tip-dialog-close {
          color: var(--color-text-secondary);
          font-size: var(--font-size-md);
          cursor: pointer;
        }
        .tip-dialog-close:hover { color: var(--color-text-primary); }
        .tip-dialog-body { display: flex; flex-direction: column; gap: var(--spacing-xs); }
        .tip-label { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .tip-input {
          padding: var(--spacing-xs) var(--spacing-sm);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-sm);
          background: var(--color-bg-secondary);
          color: var(--color-text-primary);
          font-family: inherit;
          font-size: var(--font-size-sm);
        }
        .tip-input:focus { outline: none; border-color: var(--color-accent-primary); }
        .tip-confirm-btn {
          margin-top: var(--spacing-xs);
          padding: var(--spacing-sm);
          background: var(--color-warning);
          color: #1a1a1a;
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-sm);
          cursor: pointer;
        }
        .tip-confirm-btn:hover { opacity: 0.9; }
        .tip-confirm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .tip-success {
          padding: var(--spacing-sm);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-size: var(--font-size-sm);
          font-weight: 600;
          text-align: center;
        }
        .tip-tx-link { color: var(--color-text-inverse); text-decoration: underline; }

        /* Comments section */
        .comments-section { margin-bottom: var(--spacing-xl); }
        .comments-heading {
          font-size: var(--font-size-lg);
          margin-bottom: var(--spacing-md);
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
        }
        .comments-count { font-size: var(--font-size-sm); color: var(--color-text-secondary); font-weight: 400; }
        .comments-empty {
          text-align: center;
          color: var(--color-text-secondary);
          padding: var(--spacing-lg);
          font-size: var(--font-size-sm);
        }
        .comments-list { display: flex; flex-direction: column; gap: var(--spacing-sm); }

        /* Comment card */
        .comment-card {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: var(--spacing-md);
        }
        .comment-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: var(--spacing-xs);
        }
        .comment-author-row {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          cursor: pointer;
        }
        .comment-author-row:hover .comment-author { text-decoration: underline; }
        .comment-avatar {
          width: 24px;
          height: 24px;
          border-radius: var(--radius-full);
          object-fit: cover;
        }
        .comment-avatar-placeholder {
          width: 24px;
          height: 24px;
          border-radius: var(--radius-full);
          background: var(--color-accent-secondary);
          color: var(--color-text-inverse);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .comment-author {
          font-weight: 600;
          color: var(--color-accent-primary);
          font-size: var(--font-size-sm);
        }
        .comment-verified {
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
        .comment-time { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .comment-body { line-height: 1.5; font-size: var(--font-size-sm); }
        .comment-actions { margin-top: var(--spacing-xs); }
        .comment-reply-btn {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          cursor: pointer;
        }
        .comment-reply-btn:hover { color: var(--color-accent-primary); }

        /* Comment compose */
        .comment-compose {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: var(--spacing-md);
          margin-bottom: var(--spacing-md);
        }
        .comment-reply-indicator {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          padding: var(--spacing-xs) var(--spacing-sm);
          background: var(--color-bg-tertiary);
          border-radius: var(--radius-sm);
          margin-bottom: var(--spacing-sm);
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
        }
        .comment-reply-cancel {
          margin-left: auto;
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          cursor: pointer;
        }
        .comment-reply-cancel:hover { color: var(--color-text-primary); }
        .comment-input {
          width: 100%;
          padding: var(--spacing-sm);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-sm);
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
          font-family: inherit;
          font-size: var(--font-size-sm);
          resize: vertical;
          min-height: 60px;
        }
        .comment-input:focus { outline: none; border-color: var(--color-accent-primary); }
        .comment-error {
          font-size: var(--font-size-xs);
          color: var(--color-error);
          margin-top: var(--spacing-xs);
        }
        .comment-compose-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: var(--spacing-sm);
        }
        .comment-hint { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .comment-submit-btn {
          padding: var(--spacing-xs) var(--spacing-md);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-sm);
          cursor: pointer;
        }
        .comment-submit-btn:hover { opacity: 0.9; }
        .comment-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .comment-auth-prompt { text-align: center; padding: var(--spacing-md); }
        .comment-auth-btn {
          color: var(--color-accent-primary);
          font-weight: 500;
          cursor: pointer;
        }
        .comment-auth-btn:hover { text-decoration: underline; }
      `}</style>
    </div>
  );
};
