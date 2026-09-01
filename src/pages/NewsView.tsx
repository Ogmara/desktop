/**
 * NewsView — news feed with reactions, bookmarks, reposts (auth-gated).
 */

import { Component, createSignal, createEffect, createMemo, onCleanup, onMount, on, For, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { avatarUrl } from '../lib/ownAvatar';
import { authStatus, getSigner, l2Address, walletAddress } from '../lib/auth';
import { navigate, queryParam } from '../lib/router';
import { getSetting, setSetting } from '../lib/settings';
import { FormattedText } from '../components/FormattedText';
import { VideoAttachment } from '../components/VideoAttachment';
import { MediaImage } from '../components/MediaImage';
import { openLightbox } from '../components/ImageLightbox';
import { getPayloadContent, getPayloadTitle, getPayloadAttachments, decodePayload, safeAttachmentName } from '../lib/payload';
import { sendTip, kleverAvailable } from '../lib/klever';
import { ex } from '../lib/klever-explorer-links';
import { openExternal } from '../lib/open-external';
import { TxConfirmationCancelled } from '../lib/txConfirm';
import { resolveProfile } from '../lib/profile';
import { ensureHexMsgId, formatLocalTime, truncateAddress } from '../lib/news-utils';
import { ReactionPicker } from '../components/ReactionPicker';
import { buildNewsShareUrl, copyToClipboard } from '../lib/share';
import { onWsEvent } from '../lib/ws';
import { isNewsEnvelope, normalizeHashtag } from '@ogmara/sdk';
import { getPayloadTags } from '../lib/payload';
import { getTopicGroups, allFollowedTags } from '../lib/topic-groups';

type FeedMode = 'global' | 'following';

/**
 * Resolve the feed mode for the current render: URL query param wins
 * (the sidebar pills write `?feed=...`), otherwise the user's last
 * saved preference, otherwise global. Returned as a getter so it stays
 * reactive when the route changes.
 */
function resolveFeedMode(): FeedMode {
  const q = queryParam('feed');
  if (q === 'following' || q === 'global') return q;
  const saved = getSetting('defaultFeed');
  return saved === 'following' ? 'following' : 'global';
}

/** An active hashtag filter overlaying the feed, or null. */
type TagFilter = { tags: string[]; label: string } | null;

/**
 * Resolve a hashtag filter from the URL — orthogonal to `feedMode`. A filter
 * always runs against the GLOBAL feed (`listNews({ tags })`).
 *  `?tag=<t>` · `?tags=t1,t2` · `?group=<id>` · `?topics=all`
 */
function resolveTagFilter(): TagFilter {
  const clean = (raw: string[]): string[] => {
    const out: string[] = [];
    for (const s of raw) {
      const n = normalizeHashtag(s);
      if (n && !out.includes(n)) out.push(n);
      if (out.length >= 50) break;
    }
    return out;
  };
  const group = queryParam('group');
  if (group) {
    const g = getTopicGroups().groups.find((x) => x.id === group);
    const tags = clean(g?.tags ?? []);
    return tags.length ? { tags, label: g!.name } : null;
  }
  if (queryParam('topics') === 'all') {
    const tags = clean(allFollowedTags());
    return tags.length ? { tags, label: t('news_topics_followed') } : null;
  }
  const tags = queryParam('tags');
  if (tags) {
    const list = clean(tags.split(','));
    return list.length ? { tags: list, label: list.map((x) => '#' + x).join('  ') } : null;
  }
  const tag = queryParam('tag');
  if (tag) {
    const n = normalizeHashtag(tag);
    if (n) return { tags: [n], label: '#' + n };
  }
  return null;
}

export const NewsView: Component = () => {
  const [loadError, setLoadError] = createSignal('');
  // Reactive feed-mode signal — reads from URL/settings on every change.
  // The accumulator effect below keys off it, so a sidebar click that
  // updates `?feed=` re-runs `initFeed()` for the new mode.
  const feedMode = createMemo<FeedMode>(() => resolveFeedMode());
  const tagFilter = createMemo<TagFilter>(() => resolveTagFilter());
  const tagKey = createMemo(() => tagFilter()?.tags.join(',') ?? '');

  // Auto-save the resolved mode as the user's new default ON CHANGE — but NOT
  // while a tag filter is active (transient browsing, not a preference).
  createEffect((prev?: FeedMode) => {
    const m = feedMode();
    if (!tagFilter() && prev !== undefined && prev !== m) {
      setSetting('defaultFeed', m);
    }
    return m;
  });

  // Anon-on-Following: don't even hit the auth-required endpoint when
  // the user has no wallet. We surface the value-prop card instead.
  const showFollowingAnonPrompt = () =>
    feedMode() === 'following' && authStatus() !== 'ready';

  // --- Feed accumulator -----------------------------------------------------
  // The feed is no longer a fixed page fetched once: it's a growing list the
  // user can scroll through in BOTH directions. Reaching the oldest loaded
  // post autoloads the next-older page (`?before=`); reaching the top autoloads
  // posts that arrived since (`?after=`), keeping the viewport anchored. A
  // `createStore` (not a plain signal) so a live reaction/comment/edit can be
  // patched into one item without rebuilding every card — the cause of the
  // "feed jumps to the top when I react" bug.
  const PAGE = 20;
  const SCROLL_THRESHOLD_PX = 240;
  const MAX_POSTS = 500;
  const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

  const [feed, setFeed] = createStore<{ items: any[] }>({ items: [] });
  const [loading, setLoading] = createSignal(true);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [loadingNewer, setLoadingNewer] = createSignal(false);
  const [hasMoreOlder, setHasMoreOlder] = createSignal(false);
  const [hasMoreNewer, setHasMoreNewer] = createSignal(false);
  const [atNewest, setAtNewest] = createSignal(true);
  const [newPosts, setNewPosts] = createSignal(0);

  let scrollEl: HTMLDivElement | undefined;
  let loadToken = 0;
  let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined;

  const hexId = (p: any): string => ensureHexMsgId(p?.msg_id);
  const lastReadKey = (): 'newsLastReadGlobal' | 'newsLastReadFollowing' =>
    feedMode() === 'following' ? 'newsLastReadFollowing' : 'newsLastReadGlobal';

  const dedupeById = (arr: any[]): any[] => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const p of arr) {
      const id = hexId(p);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(p);
    }
    return out;
  };

  // Map an unreachable/misconfigured node's HTML error page (the SDK's
  // JSON.parse throws "Unexpected token '<' …") to a clear message rather than
  // the raw noise. Shared by every fetch path below.
  const reportLoadError = (e: any) => {
    const msg = e?.message || String(e);
    console.error('[NewsView] Failed to load news:', msg);
    const isHtmlOrParse = /<!DOCTYPE|Unexpected token|not valid JSON|Failed to fetch|NetworkError/i.test(msg);
    setLoadError(
      isHtmlOrParse
        ? t('news_load_node_unreachable') ||
            'Couldn’t reach the node. It may be offline — try another node from the status bar.'
        : msg,
    );
  };

  // One page of the ACTIVE feed mode. `has_more` comes from l2-node 0.123.0+;
  // older nodes omit it, so fall back to "a full page came back".
  const fetchPage = async (
    opts: { before?: string; after?: string },
  ): Promise<{ posts: any[]; hasMore: boolean }> => {
    const client = getClient();
    const tf = tagFilter();
    const resp = tf
      ? await client.listNews({ limit: PAGE, tags: tf.tags, ...opts })
      : feedMode() === 'following'
        ? await client.getFeed({ limit: PAGE, ...opts })
        : await client.listNews({ limit: PAGE, ...opts });
    const posts = resp.posts ?? [];
    return { posts, hasMore: resp.has_more ?? posts.length >= PAGE };
  };

  const topmostVisibleId = (): string => {
    if (!scrollEl) return feed.items[0] ? hexId(feed.items[0]) : '';
    const top = scrollEl.getBoundingClientRect().top;
    const nodes = scrollEl.querySelectorAll<HTMLElement>('[data-msg-id]');
    for (const n of nodes) {
      if (n.getBoundingClientRect().bottom > top + 8) return n.dataset.msgId ?? '';
    }
    return feed.items[0] ? hexId(feed.items[0]) : '';
  };

  const persistPosition = () => {
    if (feed.items.length === 0) return;
    const id = topmostVisibleId();
    if (id) setSetting(lastReadKey(), id);
    setSetting('newsLastViewedAt', Date.now());
  };

  const scrollToId = (id: string | null) => {
    if (!scrollEl || !id) return;
    const sel = (window as any).CSS?.escape ? CSS.escape(id) : id;
    const el = scrollEl.querySelector<HTMLElement>(`[data-msg-id="${sel}"]`);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
    scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + delta - 8);
  };

  const initFeed = async () => {
    const myToken = ++loadToken;
    setLoading(true);
    setLoadError('');
    setNewPosts(0);
    setFeed('items', []);
    try {
      if (feedMode() === 'following' && authStatus() !== 'ready') {
        setHasMoreOlder(false);
        setHasMoreNewer(false);
        setAtNewest(true);
        return;
      }

      const savedId = getSetting(lastReadKey());
      const viewedAt = getSetting('newsLastViewedAt');
      const stale = !!tagFilter() || !savedId || Date.now() - viewedAt > RESUME_WINDOW_MS;

      if (stale) {
        const { posts, hasMore } = await fetchPage({});
        if (myToken !== loadToken) return;
        setFeed('items', dedupeById(posts));
        setHasMoreOlder(hasMore);
        setHasMoreNewer(false);
        setAtNewest(true);
        queueMicrotask(() => {
          if (myToken === loadToken && scrollEl) scrollEl.scrollTop = 0;
        });
        return;
      }

      const [older, newer, anchor] = await Promise.all([
        fetchPage({ before: savedId }),
        fetchPage({ after: savedId }),
        getClient()
          .getNewsPost(savedId)
          .then((r) => r.post)
          .catch(() => null),
      ]);
      if (myToken !== loadToken) return;
      const merged = dedupeById([
        ...newer.posts,
        ...(anchor ? [anchor] : []),
        ...older.posts,
      ]);
      setFeed('items', merged);
      setHasMoreNewer(newer.hasMore);
      setHasMoreOlder(older.hasMore);
      setAtNewest(!newer.hasMore && newer.posts.length === 0);
      queueMicrotask(() => {
        if (myToken !== loadToken) return;
        const anchorId = anchor
          ? ensureHexMsgId(anchor.msg_id)
          : older.posts[0]
          ? ensureHexMsgId(older.posts[0].msg_id)
          : newer.posts.length
          ? ensureHexMsgId(newer.posts[newer.posts.length - 1].msg_id)
          : null;
        scrollToId(anchorId);
      });
    } catch (e: any) {
      if (myToken !== loadToken) return;
      reportLoadError(e);
      setFeed('items', []);
      setHasMoreOlder(false);
      setHasMoreNewer(false);
      setAtNewest(true);
    } finally {
      if (myToken === loadToken) setLoading(false);
    }
  };

  const loadOlder = async () => {
    if (loadingOlder() || !hasMoreOlder() || feed.items.length === 0) return;
    setLoadingOlder(true);
    try {
      const oldest = feed.items[feed.items.length - 1];
      const { posts, hasMore } = await fetchPage({ before: hexId(oldest) });
      const known = new Set(feed.items.map(hexId));
      const fresh = posts.filter((p) => !known.has(hexId(p)));
      if (fresh.length > 0) setFeed('items', (items) => [...items, ...fresh]);
      setHasMoreOlder(hasMore && fresh.length > 0);
      if (feed.items.length > MAX_POSTS) {
        // Trimming off the TOP of a top-anchored scroller shifts everything up —
        // compensate so the viewport stays on the same post.
        const prevH = scrollEl?.scrollHeight ?? 0;
        const prevTop = scrollEl?.scrollTop ?? 0;
        setFeed('items', (items) => items.slice(items.length - MAX_POSTS));
        setHasMoreNewer(true);
        setAtNewest(false);
        requestAnimationFrame(() => {
          if (scrollEl) scrollEl.scrollTop = Math.max(0, prevTop - (prevH - scrollEl.scrollHeight));
        });
      }
    } catch {
      /* leave state; scrolling again retries */
    } finally {
      setLoadingOlder(false);
    }
  };

  const loadNewer = async () => {
    if (loadingNewer() || !hasMoreNewer() || feed.items.length === 0 || !scrollEl) return;
    setLoadingNewer(true);
    const prevH = scrollEl.scrollHeight;
    const prevTop = scrollEl.scrollTop;
    try {
      const newest = feed.items[0];
      const { posts, hasMore } = await fetchPage({ after: hexId(newest) });
      const known = new Set(feed.items.map(hexId));
      const fresh = posts.filter((p) => !known.has(hexId(p)));
      if (fresh.length > 0) {
        setFeed('items', (items) => [...fresh, ...items]);
        requestAnimationFrame(() => {
          if (scrollEl) scrollEl.scrollTop = prevTop + (scrollEl.scrollHeight - prevH);
        });
      }
      const more = hasMore && fresh.length > 0;
      setHasMoreNewer(more);
      if (!more) setAtNewest(true);
    } catch {
      /* noop */
    } finally {
      setLoadingNewer(false);
    }
  };

  const prependLatest = async () => {
    try {
      const newest = feed.items[0];
      const { posts } = newest ? await fetchPage({ after: hexId(newest) }) : await fetchPage({});
      const known = new Set(feed.items.map(hexId));
      const fresh = posts.filter((p) => !known.has(hexId(p)));
      if (fresh.length === 0) return;
      const atTop = scrollEl ? scrollEl.scrollTop < 4 : true;
      const prevH = scrollEl?.scrollHeight ?? 0;
      const prevTop = scrollEl?.scrollTop ?? 0;
      setFeed('items', (items) => dedupeById([...fresh, ...items]));
      if (scrollEl && !atTop) {
        requestAnimationFrame(() => {
          if (scrollEl) scrollEl.scrollTop = prevTop + (scrollEl.scrollHeight - prevH);
        });
      }
    } catch {
      /* noop */
    }
  };

  const jumpToNewest = async () => {
    setNewPosts(0);
    try {
      const { posts, hasMore } = await fetchPage({});
      setFeed('items', dedupeById(posts));
      setHasMoreOlder(hasMore);
      setHasMoreNewer(false);
      setAtNewest(true);
      queueMicrotask(() => {
        if (scrollEl) scrollEl.scrollTop = 0;
      });
    } catch (e: any) {
      reportLoadError(e);
    }
  };

  const applyOwnReaction = (msgId: string, emoji: string) => {
    const idx = feed.items.findIndex((p) => hexId(p) === msgId);
    if (idx < 0) return;
    setFeed('items', idx, 'reaction_counts', (rc: Record<string, number> = {}) => ({
      ...(rc || {}),
      [emoji]: (rc?.[emoji] ?? 0) + 1,
    }));
  };

  // Apply a live news envelope IN PLACE — never a full refetch. This is what
  // stops the feed jumping to the newest post every time any reaction, comment
  // or edit (including the echo of the user's own) comes over the WS.
  const applyNewsEnvelope = (env: any) => {
    const type = env?.msg_type;
    const mine = !!env?.author && env.author === walletAddress();

    if (type === 'NewsPost' || type === 'NewsRepost') {
      if (mine) return;
      const tf = tagFilter();
      if (tf) {
        const postTags = new Set(
          getPayloadTags(env?.payload ?? []).map((x) => normalizeHashtag(x)).filter(Boolean),
        );
        if (!tf.tags.some((x) => postTags.has(x))) return;
      }
      if (atNewest()) void prependLatest();
      else setNewPosts((n) => n + 1);
      return;
    }

    const targetHex: string | undefined = env?.target_msg_id;
    if (!targetHex) return;
    const idx = feed.items.findIndex((p) => hexId(p) === targetHex);
    if (idx < 0) return;

    if (type === 'NewsReaction') {
      if (mine) return;
      const emoji: string | undefined = env?.emoji;
      if (!emoji) return;
      setFeed('items', idx, 'reaction_counts', (rc: Record<string, number> = {}) => {
        const copy = { ...(rc || {}) };
        const next = (copy[emoji] ?? 0) + (env.remove ? -1 : 1);
        if (next <= 0) delete copy[emoji];
        else copy[emoji] = next;
        return copy;
      });
    } else if (type === 'NewsComment') {
      setFeed('items', idx, 'comment_count', (c: number = 0) => (c ?? 0) + 1);
    } else if (type === 'NewsEdit') {
      setFeed('items', idx, 'edited', true);
      getClient()
        .getNewsPost(targetHex)
        .then((r) => {
          const i = feed.items.findIndex((p) => hexId(p) === targetHex);
          if (i >= 0 && r?.post) setFeed('items', i, r.post);
        })
        .catch(() => {});
    } else if (type === 'NewsDelete') {
      setFeed('items', idx, 'deleted', true);
    }
  };

  onCleanup(
    onWsEvent((event) => {
      if (event.type !== 'message') return;
      const env = (event as { envelope?: unknown }).envelope;
      if (!isNewsEnvelope(env)) return;
      applyNewsEnvelope(env as any);
    }),
  );

  createEffect(
    on(
      () => [feedMode(), tagKey(), authStatus() === 'ready'] as const,
      () => {
        void initFeed();
      },
      { defer: true },
    ),
  );

  const onScroll = () => {
    if (!scrollEl) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    if (scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD_PX) void loadOlder();
    if (scrollTop < SCROLL_THRESHOLD_PX) void loadNewer();
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(persistPosition, 400);
  };

  onMount(() => {
    void initFeed();
    const onVis = () => {
      if (document.hidden) persistPosition();
    };
    const onRestored = () => {
      void initFeed(); // tray-restore: re-evaluate the 24h window
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('ogmara:app-restored', onRestored);
    onCleanup(() => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('ogmara:app-restored', onRestored);
      clearTimeout(scrollSaveTimer);
      persistPosition();
    });
  });

  const handleNewPost = () => {
    if (authStatus() !== 'ready') {
      navigate('/wallet');
      return;
    }
    navigate('/compose');
  };

  const headerTitle = () =>
    tagFilter()
      ? tagFilter()!.label
      : feedMode() === 'following'
        ? t('news_feed_following')
        : t('news_title');

  return (
    <div class="news-view" ref={scrollEl} onScroll={onScroll}>
      <div class="news-header">
        <h2>{headerTitle()}</h2>
        <button class="new-post-btn" onClick={handleNewPost}>{t('news_new_post')}</button>
      </div>
      <Show when={tagFilter()}>
        <button
          class="news-filter-chip"
          onClick={() => navigate('/news?feed=global')}
          title={t('news_filter_clear')}
        >
          {t('news_filter_active', { tag: tagFilter()!.tags.join(', ') })}
          <span aria-hidden="true" style="margin-left:8px; font-weight:700">✕</span>
        </button>
      </Show>
      <Show when={loadError()}>
        <div class="news-error">{loadError()}</div>
      </Show>
      <Show when={newPosts() > 0}>
        <button class="news-new-pill" onClick={() => void jumpToNewest()}>
          ↑ {t('news_show_new_posts')}
        </button>
      </Show>
      {/* Anon clicking 'Following' — value-prop card instead of the empty list.
          Conversion funnel: bullet points sell the wallet, single CTA to connect.
          We render this BEFORE the feed list so we never show 'no posts' for a
          state that means 'no account', not 'no follows'. */}
      <Show when={showFollowingAnonPrompt()}>
        <div class="news-anon-prompt">
          <div class="news-anon-icon">👥</div>
          <h3 class="news-anon-title">{t('news_following_anon_title')}</h3>
          <p class="news-anon-sub">{t('news_following_anon_sub')}</p>
          <ul class="news-anon-bullets">
            <li>{t('news_following_anon_bullet_1')}</li>
            <li>{t('news_following_anon_bullet_2')}</li>
            <li>{t('news_following_anon_bullet_3')}</li>
          </ul>
          <button class="news-anon-cta" onClick={() => navigate('/wallet')}>
            {t('news_following_anon_cta')}
          </button>
        </div>
      </Show>
      <Show when={!showFollowingAnonPrompt()}>
        <div class="news-feed">
          <Show when={loadingNewer()}>
            <div class="news-loading-row">{t('loading')}</div>
          </Show>
          <Show when={loading() && feed.items.length === 0}>
            <div class="news-empty">{t('loading')}</div>
          </Show>
          <Show when={!loading() && feed.items.length === 0 && !loadError()}>
            <div class="news-empty">
              {feedMode() === 'following' ? t('news_following_empty') : t('news_no_posts')}
            </div>
          </Show>
          <For each={feed.items}>
            {(post) => (
              <div class="news-item" data-msg-id={hexId(post)}>
                <NewsCard post={post} onReact={applyOwnReaction} />
              </div>
            )}
          </For>
          <Show when={loadingOlder()}>
            <div class="news-loading-row">{t('loading')}</div>
          </Show>
        </div>
      </Show>

      <style>{`
        .news-view { padding: var(--spacing-md); overflow-y: auto; height: 100%; }
        .news-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--spacing-lg); }
        .news-header h2 { font-size: var(--font-size-xl); }
        .new-post-btn {
          padding: var(--spacing-sm) var(--spacing-lg);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
        }
        .news-feed { display: flex; flex-direction: column; gap: var(--spacing-md); }
        .news-item { min-width: 0; }
        .news-loading-row {
          text-align: center;
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          padding: var(--spacing-md);
        }
        .news-new-pill {
          position: sticky;
          top: 0;
          align-self: center;
          z-index: 2;
          margin: 0 auto var(--spacing-md);
          padding: var(--spacing-xs) var(--spacing-lg);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-full);
          font-size: var(--font-size-sm);
          font-weight: 600;
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        }
        .news-new-pill:hover { opacity: 0.92; }
        .news-filter-chip {
          display: inline-flex;
          align-items: center;
          align-self: flex-start;
          margin-bottom: var(--spacing-md);
          padding: 4px 12px;
          background: var(--color-accent-bg, var(--color-bg-secondary));
          color: var(--color-accent-primary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-full);
          font-size: var(--font-size-sm);
          font-weight: 600;
          cursor: pointer;
        }
        .news-filter-chip:hover { background: var(--color-bg-tertiary); }
        .news-comment-context {
          padding: var(--spacing-xs) var(--spacing-md);
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          border-bottom: 1px solid var(--color-border);
          cursor: pointer;
        }
        .news-comment-context:hover { color: var(--color-accent-primary); }
        .news-comment-parent { font-weight: 600; color: var(--color-text-primary); }
        .news-repost-note {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          margin-bottom: var(--spacing-sm);
        }
        .news-repost-comment {
          margin-bottom: var(--spacing-sm);
          white-space: pre-wrap;
        }
        .news-repost-quote {
          display: flex;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          cursor: pointer;
        }
        .news-repost-quote:hover { border-color: var(--color-accent-primary); }
        .news-repost-quote-thumb {
          width: 48px;
          height: 48px;
          object-fit: cover;
          border-radius: var(--radius-sm);
          flex-shrink: 0;
        }
        .news-repost-quote-body { min-width: 0; }
        .news-repost-quote-title { font-weight: 600; color: var(--color-text-primary); }
        .news-repost-quote-author { font-size: var(--font-size-xs); color: var(--color-text-secondary); margin-bottom: 2px; }
        .news-repost-quote-content {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .news-repost-quote-unavailable { font-size: var(--font-size-sm); color: var(--color-text-secondary); font-style: italic; }
        .news-card {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-lg);
        }
        .news-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--spacing-sm); }
        .news-author-row {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          cursor: pointer;
        }
        .news-author-row:hover .news-author { text-decoration: underline; }
        .news-avatar {
          width: 28px;
          height: 28px;
          border-radius: var(--radius-full);
          object-fit: cover;
        }
        .news-avatar-placeholder {
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
        .news-author {
          font-weight: 600;
          color: var(--color-accent-primary);
          font-size: var(--font-size-sm);
        }
        .news-verified {
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
        .news-time { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .news-tags {
          display: flex;
          flex-wrap: wrap;
          gap: var(--spacing-xs);
          margin-bottom: var(--spacing-sm);
        }
        .news-tag {
          font-size: var(--font-size-xs);
          color: var(--color-accent-primary);
          background: var(--color-bg-tertiary);
          padding: 2px 8px;
          border-radius: var(--radius-full);
          cursor: pointer;
        }
        .news-tag:hover { background: var(--color-accent-primary); color: var(--color-text-inverse); }
        .news-action-error {
          font-size: var(--font-size-sm);
          color: var(--color-error);
          background: var(--color-bg-tertiary);
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-sm);
          border-left: 3px solid var(--color-error);
        }
        .news-title { cursor: pointer; }
        .news-title:hover { color: var(--color-accent-primary); }
        .news-card-body { line-height: 1.6; margin-bottom: var(--spacing-md); }
        .news-card-body-clickable { cursor: pointer; }
        .news-card-body-clickable:hover { color: var(--color-accent-primary); }
        .news-attachments {
          display: flex;
          flex-wrap: wrap;
          gap: var(--spacing-sm);
          margin-bottom: var(--spacing-md);
        }
        .news-attachment-img {
          max-width: 100%;
          max-height: 400px;
          border-radius: var(--radius-md);
          object-fit: contain;
          cursor: pointer;
        }
        .news-attachment-img:hover { opacity: 0.9; }
        /* Match image sizing for inline videos so a video-only card
           doesn't blow out its container at the browser default size. */
        .news-attachment-video {
          max-width: 100%;
          max-height: 400px;
          border-radius: var(--radius-md);
          background: #000;
          display: block;
        }
        .news-file-link {
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
        .news-file-link:hover { text-decoration: none; background: var(--color-border); }
        .news-deleted-text { font-style: italic; color: var(--color-text-secondary); opacity: 0.6; }
        .news-edited { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .news-empty { text-align: center; color: var(--color-text-secondary); padding: var(--spacing-xl); }
        .news-error { padding: var(--spacing-sm) var(--spacing-md); background: rgba(255,118,117,0.15); color: var(--color-error); border-radius: var(--radius-md); font-size: var(--font-size-sm); margin-bottom: var(--spacing-md); word-break: break-all; }

        /* Anon value-prop card — shown only when an unauthenticated user
           clicks 'Following'. Layout mirrors the typical "feature gate"
           pattern: icon, title, sub, bullets, single CTA. Kept compact
           (max-width 540) so it doesn't look like the main content. */
        .news-anon-prompt {
          max-width: 540px;
          margin: var(--spacing-xl) auto;
          padding: var(--spacing-xl) var(--spacing-lg);
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          text-align: center;
        }
        .news-anon-icon {
          font-size: 40px;
          line-height: 1;
          margin-bottom: var(--spacing-md);
        }
        .news-anon-title {
          font-size: var(--font-size-lg);
          font-weight: 700;
          margin-bottom: var(--spacing-sm);
          color: var(--color-text-primary);
        }
        .news-anon-sub {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          margin-bottom: var(--spacing-lg);
          line-height: 1.5;
        }
        .news-anon-bullets {
          text-align: left;
          margin: 0 auto var(--spacing-lg);
          padding-left: var(--spacing-lg);
          max-width: 420px;
          font-size: var(--font-size-sm);
          color: var(--color-text-primary);
          line-height: 1.7;
        }
        .news-anon-bullets li { margin-bottom: var(--spacing-xs); }
        .news-anon-cta {
          padding: var(--spacing-sm) var(--spacing-xl);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-md);
          cursor: pointer;
        }
        .news-anon-cta:hover { opacity: 0.9; }

        .news-actions {
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
        .action-btn.bookmarked { color: var(--color-accent-primary); }
        .action-btn.has-comments { color: var(--color-accent-primary); }
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
      `}</style>
    </div>
  );
};


/** Individual news card with reactions, repost, bookmark, tip. */
const NewsCard: Component<{
  post: any;
  /** Parent hook: called after this card's OWN reaction succeeds, so the
   *  parent can keep the shared store item in sync (and safely skip the WS
   *  echo). Reaction counts render straight off `props.post` so a live
   *  reaction from another user patched into the store shows with no refetch. */
  onReact?: (msgId: string, emoji: string) => void;
}> = (props) => {
  const reactionCounts = (): Record<string, number> => props.post.reaction_counts ?? {};
  const [bookmarked, setBookmarked] = createSignal(false);
  const [reposted, setReposted] = createSignal(false);
  const [actionError, setActionError] = createSignal('');
  const [shareCopied, setShareCopied] = createSignal(false);
  let shareCopiedTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => { if (shareCopiedTimer) clearTimeout(shareCopiedTimer); });
  const [profile, setProfile] = createSignal<{ display_name?: string; avatar_cid?: string; verified?: boolean }>({});
  const [showTip, setShowTip] = createSignal(false);
  const [tipAmount, setTipAmount] = createSignal('1');
  const [tipNote, setTipNote] = createSignal('');
  const [tipPending, setTipPending] = createSignal(false);
  const [tipTxHash, setTipTxHash] = createSignal('');

  // Resolve author profile (username + avatar)
  createEffect(() => {
    resolveProfile(props.post.author).then(setProfile);
  });

  const requireAuthOrRedirect = (): boolean => {
    if (!getSigner() || !walletAddress()) {
      navigate('/wallet');
      return false;
    }
    return true;
  };

  const handleReaction = async (emoji: string) => {
    if (!requireAuthOrRedirect()) return;
    setActionError('');
    try {
      const client = getClient();
      await client.reactToNews(ensureHexMsgId(props.post.msg_id), emoji);
      props.onReact?.(ensureHexMsgId(props.post.msg_id), emoji);
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
        await client.removeBookmark(ensureHexMsgId(props.post.msg_id));
        setBookmarked(false);
      } else {
        await client.saveBookmark(ensureHexMsgId(props.post.msg_id));
        setBookmarked(true);
      }
    } catch (e: any) {
      setActionError(e?.message || 'Bookmark failed');
    }
  };

  const handleRepost = async () => {
    if (!requireAuthOrRedirect()) return;
    if (reposted()) return;
    // Prevent self-repost (the L2 node also rejects it, but give clear feedback)
    const author = props.post.author;
    if (author === l2Address() || author === walletAddress()) {
      setActionError(t('news_repost_own'));
      return;
    }
    setActionError('');
    try {
      const client = getClient();
      await client.repostNews(ensureHexMsgId(props.post.msg_id), author);
      setReposted(true);
    } catch (e: any) {
      setActionError(e?.message || 'Repost failed');
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
      const msgId = ensureHexMsgId(props.post.msg_id);
      const txHash = await sendTip(props.post.author, msgId, 0, tipNote(), amount);
      setTipTxHash(txHash);
      setTipAmount('1');
      setTipNote('');
    } catch (e: any) {
      // User dismissing the PIN modal isn't a failure — surface a calm
      // localized message instead of an angry "Tip failed: …".
      if (e instanceof TxConfirmationCancelled) {
        setActionError(t('tx_confirm_cancelled'));
      } else {
        setActionError(e?.message || 'Tip failed');
      }
    } finally {
      setTipPending(false);
    }
  };

  const displayName = () => profile().display_name || truncateAddress(props.post.author);

  // Decode payload once, memoize for title/content/tags/attachments
  const decoded = createMemo(() => {
    try { return decodePayload(props.post.payload); }
    catch { return { content: '' }; }
  });

  const postTags = () => decoded().tags ?? [];
  const isComment = () => props.post.msg_type === 'NewsComment';
  // A NewsRepost payload only carries {original_id, original_author, comment}
  // — no title/content — so `decoded()` above is meaningless for this type.
  // The l2-node enriches repost feed items with original_* / repost_comment
  // fields (mirroring the parent_* enrichment for comments); render those
  // instead of the raw (empty) decoded payload.
  const isRepost = () => props.post.msg_type === 'NewsRepost';

  return (
    <article class="news-card">
      {/* Comment context banner — links to parent post */}
      <Show when={isComment() && props.post.parent_post_id}>
        <div
          class="news-comment-context"
          onClick={() => navigate(`/news/${props.post.parent_post_id}`)}
        >
          ↩ {t('news_commented_on')}{' '}
          <Show when={props.post.parent_title} fallback={
            <span class="news-comment-parent">{truncateAddress(props.post.parent_author ?? '')}</span>
          }>
            <span class="news-comment-parent">{props.post.parent_title}</span>
          </Show>
        </div>
      </Show>
      <div class="news-card-header">
        <div class="news-author-row" onClick={() => navigate(`/user/${props.post.author}`)}>
          <Show when={profile().avatar_cid}>
            <img
              class="news-avatar"
              src={avatarUrl(profile().avatar_cid!)}
              alt=""
              loading="lazy"
            />
          </Show>
          <Show when={!profile().avatar_cid}>
            <span class="news-avatar-placeholder">
              {(profile().display_name || props.post.author).slice(0, 2).toUpperCase()}
            </span>
          </Show>
          <span class="news-author">{displayName()}</span>
          <Show when={profile().verified}>
            <span class="news-verified" title="On-chain verified">✓</span>
          </Show>
        </div>
        <span class="news-time">
          {formatLocalTime(props.post.timestamp)}
          <Show when={props.post.edited}>
            <span class="news-edited"> ({t('message_edited')})</span>
          </Show>
        </span>
      </div>
      <Show when={props.post.deleted}>
        <div class="news-card-body news-deleted-text">{t('message_deleted')}</div>
      </Show>
      <Show when={!props.post.deleted && isRepost()}>
        <Show when={props.post.repost_comment}>
          <div class="news-repost-comment"><FormattedText content={props.post.repost_comment} /></div>
        </Show>
        <Show
          when={props.post.original_available}
          fallback={<div class="news-repost-quote-unavailable">{t('news_original_unavailable')}</div>}
        >
          <div
            class="news-repost-quote"
            onClick={() => navigate(`/news/${props.post.original_id}`)}
          >
            <Show when={props.post.original_attachment?.mime_type?.startsWith('image/')}>
              <img
                class="news-repost-quote-thumb"
                src={getClient().getMediaUrl(props.post.original_attachment.thumbnail_cid || props.post.original_attachment.cid)}
                alt=""
                loading="lazy"
              />
            </Show>
            <div class="news-repost-quote-body">
              <div class="news-repost-quote-author">{truncateAddress(props.post.original_author ?? '')}</div>
              <Show when={props.post.original_deleted}>
                <div class="news-repost-quote-unavailable">{t('message_deleted')}</div>
              </Show>
              <Show when={!props.post.original_deleted}>
                <Show when={props.post.original_title}>
                  <div class="news-repost-quote-title">{props.post.original_title}</div>
                </Show>
                <div class="news-repost-quote-content">{props.post.original_content}</div>
              </Show>
            </div>
          </div>
        </Show>
      </Show>
      <Show when={!props.post.deleted && !isRepost()}>
        <Show when={decoded().title}>
          <h3 class="news-title" onClick={() => navigate(`/news/${ensureHexMsgId(props.post.msg_id)}`)}>
            {decoded().title}
          </h3>
        </Show>
        {/* Body is a click-target for the detail view (where the existing
            30-min edit-window + author + registered rules in NewsDetailView's
            `canEditPost` apply). Posts without a title used to be unreachable
            from the feed because the <h3> was the only entry point. Ignore
            clicks that land on an interactive descendant (links inside
            FormattedText, mention buttons, etc.) so this overlay can't
            swallow them. */}
        <div
          class="news-card-body news-card-body-clickable"
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest('a, button, [data-no-detail]')) return;
            navigate(`/news/${ensureHexMsgId(props.post.msg_id)}`);
          }}
          title={t('news_view_post')}
        >
          <FormattedText content={decoded().content} />
        </div>
      </Show>
      <Show when={!isRepost() && (decoded().attachments ?? []).length > 0}>
        <div class="news-attachments">
          <For each={decoded().attachments!}>
            {(att) => {
              const isImage = att.mime_type.startsWith('image/');
              const isVideo = att.mime_type.startsWith('video/');
              const mediaUrl = getClient().getMediaUrl(att.cid);
              if (isImage) {
                return (
                  <MediaImage
                    src={getClient().getMediaUrl(att.thumbnail_cid || att.cid)}
                    href={mediaUrl}
                    onOpen={() => openLightbox(mediaUrl, safeAttachmentName(att))}
                    alt={att.filename || ''}
                    class="news-attachment-img"
                  />
                );
              }
              if (isVideo) {
                return (
                  <VideoAttachment
                    src={mediaUrl}
                    filename={att.filename}
                    videoClass="news-attachment-video"
                    fallbackClass="news-file-link"
                  />
                );
              }
              return (
                <a class="news-file-link" href={mediaUrl} target="_blank" rel="noopener noreferrer">
                  📎 {safeAttachmentName(att)}
                </a>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={!isComment() && postTags().length > 0}>
        <div class="news-tags">
          <For each={postTags()}>
            {(tag) => {
              const n = normalizeHashtag(tag);
              return (
                <button
                  class="news-tag"
                  onClick={() =>
                    navigate(n ? `/news?tag=${encodeURIComponent(n)}` : `/search?q=${encodeURIComponent('#' + tag)}`)
                  }
                >
                  #{tag}
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={actionError()}>
        <div class="news-action-error">{actionError()}</div>
      </Show>
      <div class="news-actions">
        <ReactionPicker counts={reactionCounts()} onReact={handleReaction} />
        <button
          class={`action-btn ${reposted() ? 'bookmarked' : ''}`}
          onClick={handleRepost}
          title={t('news_repost')}
        >
          ↗ {t('news_repost')}
        </button>
        <button
          class={`action-btn ${bookmarked() ? 'bookmarked' : ''}`}
          onClick={handleBookmark}
          title={bookmarked() ? t('news_bookmarked') : t('news_bookmark')}
        >
          {bookmarked() ? '★' : '☆'} {bookmarked() ? t('news_bookmarked') : t('news_bookmark')}
        </button>
        <button
          class={`action-btn ${(props.post.comment_count ?? 0) > 0 ? 'has-comments' : ''}`}
          onClick={() => navigate(`/news/${isComment() ? props.post.parent_post_id : ensureHexMsgId(props.post.msg_id)}`)}
          title={isComment() ? t('news_view_thread') : t('news_comments')}
        >
          💬 {isComment() ? t('news_view_thread') : t('news_comments')}
          <Show when={!isComment() && (props.post.comment_count ?? 0) > 0}>
            <span class="reaction-count">{props.post.comment_count}</span>
          </Show>
        </button>
        <button
          class={`action-btn ${shareCopied() ? 'bookmarked' : ''}`}
          onClick={async (e) => {
            e.stopPropagation();
            const url = buildNewsShareUrl(ensureHexMsgId(props.post.msg_id));
            if (!url) return;
            const ok = await copyToClipboard(url);
            if (ok) {
              setShareCopied(true);
              if (shareCopiedTimer) clearTimeout(shareCopiedTimer);
              shareCopiedTimer = setTimeout(() => setShareCopied(false), 1500);
            }
          }}
          title={t('share_news_link')}
        >
          🔗 {shareCopied() ? t('share_link_copied') : t('share')}
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
      </div>
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
                  href={ex.tx(tipTxHash())}
                  class="tip-tx-link"
                  onClick={(e) => { e.preventDefault(); openExternal(ex.tx(tipTxHash())); }}
                >
                  {tipTxHash().slice(0, 12)}...
                </a>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </article>
  );
};
