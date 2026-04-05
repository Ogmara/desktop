/**
 * SearchView — search posts by tag, channels by name, users by address.
 */

import { Component, createSignal, onMount, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { navigate, queryParam } from '../lib/router';
import { FormattedText } from '../components/FormattedText';
import { getPayloadContent, getPayloadTitle, decodePayload } from '../lib/payload';

export const SearchView: Component = () => {
  const [query, setQuery] = createSignal(queryParam('q') || '');
  const [results, setResults] = createSignal<{ posts: any[]; channels: any[] }>({ posts: [], channels: [] });
  const [searching, setSearching] = createSignal(false);
  const [hasSearched, setHasSearched] = createSignal(false);

  // Auto-execute search when arriving with a query param (e.g. from hashtag click)
  onMount(() => {
    if (query()) handleSearch();
  });

  const handleSearch = async () => {
    const q = query().trim();
    if (!q) return;

    // If it looks like a klv1 bech32 address, navigate to user profile
    if (/^klv1[a-z0-9]{38,}$/.test(q)) {
      navigate(`/user/${q}`);
      return;
    }

    setSearching(true);
    setHasSearched(true);

    try {
      const client = getClient();

      const isHashtag = q.startsWith('#');
      const searchTerm = isHashtag ? q.slice(1).toLowerCase() : q.toLowerCase();

      // Fetch all posts — the L2 node doesn't support server-side filtering yet
      const [newsResp, channelsResp] = await Promise.all([
        client.listNews(1, 100).catch(() => ({ posts: [] })),
        client.listChannels(1, 50).catch(() => ({ channels: [] })),
      ]);

      let posts = newsResp.posts || [];

      // Client-side filtering on content, title, author, and tags
      posts = posts.filter((post: any) => {
        const content = getPayloadContent(post.payload).toLowerCase();
        const title = (getPayloadTitle(post.payload) || '').toLowerCase();
        const author = (post.author || '').toLowerCase();

        if (isHashtag) {
          // For hashtag search, match against tags array and content
          try {
            const decoded = decodePayload(post.payload);
            const tags = (decoded.tags ?? []).map((tag: string) => tag.toLowerCase());
            if (tags.includes(searchTerm)) return true;
          } catch { /* ignore */ }
          return content.includes('#' + searchTerm) || content.includes(searchTerm);
        }

        // Free text search across content, title, and author
        return content.includes(searchTerm) || title.includes(searchTerm) || author.includes(searchTerm);
      });

      // Filter channels by slug/name match — exclude private channels (type 2)
      const matchedChannels = (channelsResp.channels || []).filter((ch: any) => {
        if (ch.channel_type === 2 || ch.channel_type === 'Private') return false;
        return (
          ch.slug?.toLowerCase().includes(searchTerm) ||
          ch.display_name?.toLowerCase().includes(searchTerm)
        );
      });

      setResults({ posts, channels: matchedChannels });
    } catch {
      setResults({ posts: [], channels: [] });
    } finally {
      setSearching(false);
    }
  };

  const truncateAddress = (addr: string) =>
    `${addr.slice(0, 8)}...${addr.slice(-4)}`;

  return (
    <div class="search-view">
      <h2>{t('search_title')}</h2>

      <div class="search-bar">
        <input
          type="text"
          class="search-input"
          placeholder={t('search_placeholder')}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button class="search-btn" onClick={handleSearch} disabled={searching()}>
          {searching() ? t('loading') : t('nav_search')}
        </button>
      </div>

      <Show when={hasSearched()}>
        {/* Channel results */}
        <Show when={results().channels.length > 0}>
          <section class="search-section">
            <h3>{t('search_channels')}</h3>
            <For each={results().channels}>
              {(ch) => (
                <button class="search-channel" onClick={() => navigate(`/join/${ch.channel_id}`)}>
                  <span class="channel-hash">#</span>
                  <span class="channel-name">{ch.display_name || ch.slug}</span>
                  <Show when={ch.member_count}>
                    <span class="channel-members">{ch.member_count} {t('channel_members')}</span>
                  </Show>
                  <span class="channel-join-hint">{t('channel_join')}</span>
                </button>
              )}
            </For>
          </section>
        </Show>

        {/* Post results */}
        <Show when={results().posts.length > 0}>
          <section class="search-section">
            <h3>{t('search_posts')}</h3>
            <For each={results().posts}>
              {(post) => (
                <article class="search-post">
                  <div class="search-post-header">
                    <span
                      class="search-post-author"
                      onClick={() => navigate(`/user/${post.author}`)}
                    >
                      {truncateAddress(post.author)}
                    </span>
                    <span class="search-post-time">
                      {new Date(post.timestamp).toLocaleString(undefined, {
                        month: 'short', day: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div class="search-post-body">
                    <FormattedText content={getPayloadContent(post.payload)} />
                  </div>
                </article>
              )}
            </For>
          </section>
        </Show>

        <Show when={results().posts.length === 0 && results().channels.length === 0 && !searching()}>
          <div class="search-empty">{t('search_no_results')}</div>
        </Show>
      </Show>

      <style>{`
        .search-view { padding: var(--spacing-lg); overflow-y: auto; height: 100%; max-width: 700px; }
        .search-view h2 { font-size: var(--font-size-xl); margin-bottom: var(--spacing-lg); }
        .search-bar {
          display: flex;
          gap: var(--spacing-sm);
          margin-bottom: var(--spacing-lg);
        }
        .search-input {
          flex: 1;
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-family: inherit;
          font-size: var(--font-size-md);
        }
        .search-input:focus { outline: none; border-color: var(--color-accent-primary); }
        .search-btn {
          padding: var(--spacing-sm) var(--spacing-lg);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-sm);
        }
        .search-btn:disabled { opacity: 0.5; }
        .search-section { margin-bottom: var(--spacing-lg); }
        .search-section h3 {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: var(--spacing-sm);
        }
        .search-channel {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-md);
          width: 100%;
          text-align: left;
          margin-bottom: var(--spacing-xs);
        }
        .search-channel:hover { background: var(--color-bg-secondary); }
        .search-channel .channel-hash { opacity: 0.5; font-weight: 700; }
        .search-channel .channel-name { font-weight: 600; }
        .search-channel .channel-members { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .search-channel .channel-join-hint {
          margin-left: auto;
          font-size: var(--font-size-xs);
          color: var(--color-accent-primary);
          font-weight: 600;
        }
        .search-post {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-md);
          margin-bottom: var(--spacing-sm);
        }
        .search-post-header { display: flex; justify-content: space-between; margin-bottom: var(--spacing-xs); }
        .search-post-author {
          font-weight: 600;
          color: var(--color-accent-primary);
          font-size: var(--font-size-sm);
          cursor: pointer;
        }
        .search-post-author:hover { text-decoration: underline; }
        .search-post-time { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .search-post-body { line-height: 1.6; }
        .search-empty { text-align: center; color: var(--color-text-secondary); padding: var(--spacing-xl); }
      `}</style>
    </div>
  );
};
