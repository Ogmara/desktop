/**
 * NewsFeedTopics — the "Followed Topics" + topic group entries in the News
 * Feed sidebar, styled and behaving exactly like the Global/Following rows
 * above them: an icon, a label, a description, a click that navigates.
 *
 * All editing (follow/unfollow, create/rename/delete group, add/remove a
 * topic) lives on its own page — `TopicsSettingsView`, reached via the
 * "Manage topics" link at the bottom — not inline here. This used to be an
 * always-expanded management panel (add-topic input, per-tag ✕ buttons,
 * inline rename, a floating context menu) sitting where a simple list of
 * feeds belongs, which is what made this section read as a settings panel
 * bolted onto the sidebar instead of a set of feeds you can pick.
 *
 * Model + cross-device sync: `lib/topic-groups.ts` (the `topicGroups` object
 * inside the encrypted settings blob). Selecting an entry navigates to
 * `/news?topics=all` or `/news?group=<id>`, which NewsView resolves into a
 * `listNews({ tags })` filter.
 */

import { Component, For, Show, createMemo } from 'solid-js';
import { t } from '../i18n/init';
import { navigate, queryParam } from '../lib/router';
import { isModernStyle } from '../lib/theme';
import { topicGroups } from '../lib/topic-groups';
import { HotTopics } from './HotTopics';

/** A followed-topics feed or a group's tags, joined for the description line. */
function tagList(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(', ');
}

export const NewsFeedTopics: Component = () => {
  const tg = topicGroups;

  const activeTopicsAll = createMemo(() => queryParam('topics') === 'all');
  const activeGroup = createMemo(() => queryParam('group'));

  // Modern style: icon-circle + label + description, matching the
  // Global/Following pills exactly. Classic style: `.sidebar-nav-item`, no
  // sub-line, matching how that style already renders Global/Following.
  const pillStyle = (active: boolean) =>
    `display:flex; align-items:center; gap:10px; padding:10px 12px; width:100%; text-align:left; cursor:pointer; transition:background 0.1s; background:${active ? 'var(--color-chat-active-bg)' : 'transparent'}`;
  const iconStyle =
    'width:32px; height:32px; border-radius:50%; background:var(--color-bg-tertiary); display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0';
  const labelStyle = (active: boolean) =>
    `font-weight:600; font-size:var(--font-size-sm); color:${active ? 'var(--color-accent-primary)' : 'var(--color-text-primary)'}`;
  const subStyle = 'font-size:var(--font-size-xs); color:var(--color-text-secondary); margin-top:2px';

  return (
    <div class="news-feed-topics">
      <Show
        when={isModernStyle()}
        fallback={
          <>
            <button
              class={`sidebar-nav-item ${activeTopicsAll() ? 'active' : ''}`}
              onClick={() => navigate('/news?topics=all')}
              title={t('news_topics_followed')}
            >
              🏷️ {t('news_topics_followed')}
            </button>
            <For each={tg().groups}>
              {(g) => (
                <button
                  class={`sidebar-nav-item ${activeGroup() === g.id ? 'active' : ''}`}
                  onClick={() => navigate(`/news?group=${encodeURIComponent(g.id)}`)}
                  title={g.name}
                >
                  📁 {g.name}
                </button>
              )}
            </For>
          </>
        }
      >
        <button style={pillStyle(activeTopicsAll())} onClick={() => navigate('/news?topics=all')}>
          <div style={iconStyle}>🏷️</div>
          <div style="flex:1; overflow:hidden">
            <div style={labelStyle(activeTopicsAll())}>{t('news_topics_followed')}</div>
            <div style={`${subStyle} overflow:hidden; text-overflow:ellipsis; white-space:nowrap`}>
              {tg().follows.length > 0 ? tagList(tg().follows) : t('news_topics_empty')}
            </div>
          </div>
        </button>

        <For each={tg().groups}>
          {(g) => (
            <button style={pillStyle(activeGroup() === g.id)} onClick={() => navigate(`/news?group=${encodeURIComponent(g.id)}`)}>
              <div style={iconStyle}>📁</div>
              <div style="flex:1; overflow:hidden">
                <div style={labelStyle(activeGroup() === g.id)}>{g.name}</div>
                <div style={`${subStyle} overflow:hidden; text-overflow:ellipsis; white-space:nowrap`}>
                  {g.tags.length > 0 ? tagList(g.tags) : t('news_topic_group_empty')}
                </div>
              </div>
            </button>
          )}
        </For>
      </Show>

      <div style="padding:4px 12px 0">
        <button
          style="font-size:var(--font-size-xs); color:var(--color-accent-primary); background:transparent; cursor:pointer; padding:4px 0"
          onClick={() => navigate('/settings/topics')}
        >
          {t('news_topics_manage')} →
        </button>
      </div>

      <hr style="border:none; border-top:1px solid var(--color-border); margin:8px 12px" />

      <HotTopics />
    </div>
  );
};
