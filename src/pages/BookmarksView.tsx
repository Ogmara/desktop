import { Component, createResource, createEffect, createSignal, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { navigate } from '../lib/router';
import { getPayloadContent, getPayloadTitle } from '../lib/payload';
import { FormattedText } from '../components/FormattedText';
import { resolveProfile, type CachedProfile } from '../lib/profile';
import { ensureHexMsgId, truncateAddress } from '../lib/news-utils';

/** Format timestamp for bookmark display (date only, no time). */
function formatBookmarkTime(timestamp: string | number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Single bookmark card with full content. */
const BookmarkCard: Component<{ post: any; onRemoved: () => void }> = (props) => {
  const [profile, setProfile] = createSignal<CachedProfile>({});

  createEffect(() => {
    resolveProfile(props.post.author).then(setProfile);
  });

  const displayName = () => profile().display_name || truncateAddress(props.post.author);

  const msgId = () => ensureHexMsgId(props.post.msg_id);

  const handleRemoveBookmark = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      const client = getClient();
      await client.removeBookmark(msgId());
      props.onRemoved();
    } catch {
      // Silently fail — user can retry
    }
  };

  return (
    <article class="bookmark-card" onClick={() => navigate(`/news/${msgId()}`)}>
      <div class="bookmark-header">
        <div class="bookmark-author-row" onClick={(e) => { e.stopPropagation(); navigate(`/user/${props.post.author}`); }}>
          <Show when={profile().avatar_cid}>
            <img
              class="bookmark-avatar"
              src={getClient().getMediaUrl(profile().avatar_cid!)}
              alt=""
              loading="lazy"
            />
          </Show>
          <Show when={!profile().avatar_cid}>
            <span class="bookmark-avatar-placeholder">
              {(profile().display_name || props.post.author).slice(0, 2).toUpperCase()}
            </span>
          </Show>
          <span class="bookmark-author">{displayName()}</span>
          <Show when={profile().verified}>
            <span class="bookmark-verified" title="On-chain verified">✓</span>
          </Show>
        </div>
        <div class="bookmark-meta">
          <span class="bookmark-time">{formatBookmarkTime(props.post.timestamp)}</span>
          <button
            class="bookmark-remove"
            onClick={handleRemoveBookmark}
            title={t('news_bookmark')}
          >
            ✕
          </button>
        </div>
      </div>
      <Show when={getPayloadTitle(props.post.payload)}>
        <h3 class="bookmark-title">{getPayloadTitle(props.post.payload)}</h3>
      </Show>
      <div class="bookmark-body">
        <FormattedText content={getPayloadContent(props.post.payload)} />
      </div>
      <div class="bookmark-footer">
        <span class="bookmark-view-thread">{t('news_view_thread')} →</span>
      </div>
    </article>
  );
};

export const BookmarksView: Component = () => {
  const [bookmarks, { refetch }] = createResource(async () => {
    try {
      const client = getClient();
      const resp = await client.listBookmarks({ page: 1, limit: 50 });
      return resp.bookmarks;
    } catch {
      return [];
    }
  });

  return (
    <div class="bookmarks-view">
      <div class="bookmarks-header">
        <h2>{t('bookmarks_title')}</h2>
      </div>
      <div class="bookmarks-list">
        <Show
          when={bookmarks() && bookmarks()!.length > 0}
          fallback={<div class="bookmarks-empty">{t('bookmarks_empty')}</div>}
        >
          <For each={bookmarks()}>
            {(post) => <BookmarkCard post={post} onRemoved={refetch} />}
          </For>
        </Show>
      </div>

      <style>{`
        .bookmarks-view { padding: var(--spacing-md); overflow-y: auto; height: 100%; }
        .bookmarks-header { margin-bottom: var(--spacing-lg); }
        .bookmarks-header h2 { font-size: var(--font-size-xl); }
        .bookmarks-list { display: flex; flex-direction: column; gap: var(--spacing-md); }
        .bookmark-card {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-lg);
          cursor: pointer;
          transition: border-color 0.15s;
        }
        .bookmark-card:hover { border-color: var(--color-accent-primary); }
        .bookmark-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: var(--spacing-sm);
        }
        .bookmark-author-row {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          cursor: pointer;
        }
        .bookmark-author-row:hover .bookmark-author { text-decoration: underline; }
        .bookmark-avatar {
          width: 28px;
          height: 28px;
          border-radius: var(--radius-full);
          object-fit: cover;
        }
        .bookmark-avatar-placeholder {
          width: 28px;
          height: 28px;
          border-radius: var(--radius-full);
          background: var(--color-accent-secondary);
          color: var(--color-text-inverse);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .bookmark-author {
          font-weight: 600;
          color: var(--color-accent-primary);
          font-size: var(--font-size-sm);
        }
        .bookmark-verified {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          border-radius: var(--radius-full);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          font-size: 10px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .bookmark-meta {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
        }
        .bookmark-time { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .bookmark-remove {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          cursor: pointer;
          padding: 2px 6px;
          border-radius: var(--radius-sm);
        }
        .bookmark-remove:hover { color: var(--color-error); background: var(--color-bg-tertiary); }
        .bookmark-title {
          font-size: var(--font-size-lg);
          font-weight: 600;
          margin-bottom: var(--spacing-xs);
        }
        .bookmark-body {
          line-height: 1.6;
          margin-bottom: var(--spacing-sm);
          /* Clamp long posts to 4 lines */
          display: -webkit-box;
          -webkit-line-clamp: 4;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .bookmark-footer {
          border-top: 1px solid var(--color-border);
          padding-top: var(--spacing-sm);
        }
        .bookmark-view-thread {
          font-size: var(--font-size-sm);
          color: var(--color-accent-primary);
          font-weight: 500;
        }
        .bookmarks-empty { text-align: center; color: var(--color-text-secondary); padding: var(--spacing-xl); }
      `}</style>
    </div>
  );
};
