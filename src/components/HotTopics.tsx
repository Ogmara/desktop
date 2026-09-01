/**
 * HotTopics — the "Trending" list under the News Feed sidebar (l2-node
 * 0.124.0+). The network's most-used news hashtags over a rolling 24h window
 * with usage counts; clicking one filters the feed to that tag.
 *
 * Degrades quietly: an old node (404) returns `{ scope: 'local', topics: [] }`
 * from the SDK, so this renders nothing rather than an error. A `scope:
 * 'local'` result from a fresh/partitioned node shows a one-line "warming up"
 * hint instead of implying the list is network-wide.
 */

import { Component, For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { navigate } from '../lib/router';

const REFRESH_MS = 60_000;

const fmtCount = (n: number): string => {
  try {
    return new Intl.NumberFormat(navigator.language, { notation: 'compact' }).format(n);
  } catch {
    return String(n);
  }
};

export const HotTopics: Component<{ limit?: number }> = (props) => {
  const [tick, setTick] = createSignal(0);
  const [data] = createResource(tick, async () => {
    try {
      return await getClient().getHotTopics({ limit: props.limit ?? 15 });
    } catch {
      // Network hiccup — keep whatever we had; don't blow up the sidebar.
      return { scope: 'local' as const, topics: [] };
    }
  });

  onMount(() => {
    const iv = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    const onFocus = () => setTick((n) => n + 1);
    window.addEventListener('focus', onFocus);
    onCleanup(() => {
      clearInterval(iv);
      window.removeEventListener('focus', onFocus);
    });
  });

  const open = (hashtag: string) => navigate(`/news?tag=${encodeURIComponent(hashtag)}`);

  const rowStyle =
    'display:flex; align-items:baseline; gap:8px; width:100%; text-align:left; cursor:pointer; padding:6px 12px; background:transparent; font-size:var(--font-size-sm); color:var(--color-text-primary)';

  return (
    // Hidden entirely while the very first load is in flight OR the node
    // doesn't support the endpoint (topics stays []). Only render once we know
    // there's something to show or an explicit empty state to show.
    <Show when={!data.loading || data()}>
      <Show when={data() && (data()!.topics.length > 0 || !data.loading)}>
        <div class="hot-topics">
          <div
            style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px 4px; font-size:var(--font-size-xs); font-weight:700; letter-spacing:0.04em; text-transform:uppercase; color:var(--color-text-secondary)"
          >
            <span>🔥 {t('news_hot_topics_title')}</span>
          </div>

          <Show
            when={(data()?.topics.length ?? 0) > 0}
            fallback={
              <div style="padding:6px 12px 10px; font-size:var(--font-size-xs); color:var(--color-text-secondary)">
                {t('news_hot_topics_empty')}
              </div>
            }
          >
            <For each={data()!.topics}>
              {(topic) => (
                <button
                  type="button"
                  style={rowStyle}
                  onClick={() => open(topic.hashtag)}
                  title={t('news_hot_topics_count', { count: topic.count })}
                >
                  <span style="color:var(--color-accent-primary); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1">
                    #{topic.hashtag}
                  </span>
                  <span style="color:var(--color-text-secondary); font-size:var(--font-size-xs); flex-shrink:0">
                    {fmtCount(topic.count)}
                  </span>
                </button>
              )}
            </For>
          </Show>

          <Show when={data()?.scope === 'local' && (data()?.topics.length ?? 0) > 0}>
            <div style="padding:4px 12px 10px; font-size:11px; color:var(--color-text-secondary); font-style:italic">
              {t('news_hot_topics_local_hint')}
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  );
};
