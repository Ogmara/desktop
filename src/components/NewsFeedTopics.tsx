/**
 * NewsFeedTopics — the "Followed Topics" + user topic groups section of the
 * News Feed sidebar, plus the "＋ Topic group" affordance, a lightweight
 * manage panel (follow / unfollow hashtags), a separator, and the Hot Topics
 * trending list.
 *
 * Model + cross-device sync: `lib/topic-groups.ts` (the `topicGroups` object
 * inside the encrypted settings blob). Selecting an entry navigates to
 * `/news?topics=all` or `/news?group=<id>`, which NewsView resolves into a
 * `listNews({ tags })` filter.
 */

import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import { t } from '../i18n/init';
import { navigate, queryParam } from '../lib/router';
import {
  topicGroups,
  topicCaps,
  followTag,
  unfollowTag,
  createGroup,
  renameGroup,
  deleteGroup,
  addTagToGroup,
} from '../lib/topic-groups';
import { HotTopics } from './HotTopics';

export const NewsFeedTopics: Component = () => {
  const tg = topicGroups;
  const [managing, setManaging] = createSignal(false);
  const [addValue, setAddValue] = createSignal('');

  // Active-state: which entry the URL currently points at.
  const activeTopicsAll = createMemo(() => queryParam('topics') === 'all');
  const activeGroup = createMemo(() => queryParam('group'));

  const caps = () => topicCaps();

  const rowStyle = (active: boolean) =>
    `display:flex; align-items:center; gap:8px; width:100%; text-align:left; cursor:pointer; padding:8px 12px; background:${
      active ? 'var(--color-chat-active-bg)' : 'transparent'
    }; font-size:var(--font-size-sm); color:${active ? 'var(--color-accent-primary)' : 'var(--color-text-primary)'}`;

  const onNewGroup = () => {
    const name = window.prompt(t('news_topic_group_new_prompt'))?.trim();
    if (name) createGroup(name);
  };
  const onRenameGroup = (id: string, current: string) => {
    const name = window.prompt(t('news_topic_group_rename'), current)?.trim();
    if (name) renameGroup(id, name);
  };
  const onDeleteGroup = (id: string) => {
    if (window.confirm(t('news_topic_group_delete_confirm'))) deleteGroup(id);
  };
  const onAddTagToGroup = (id: string) => {
    const raw = window.prompt(t('news_topic_add'))?.trim();
    if (raw) addTagToGroup(id, raw);
  };
  const submitAdd = (e: Event) => {
    e.preventDefault();
    const v = addValue().trim();
    if (v) {
      followTag(v);
      setAddValue('');
    }
  };

  return (
    <div class="news-feed-topics">
      {/* Followed Topics — the union of every followed hashtag. */}
      <button
        style={rowStyle(activeTopicsAll())}
        onClick={() => navigate('/news?topics=all')}
        title={t('news_topics_followed')}
      >
        <span aria-hidden="true">🏷️</span>
        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
          {t('news_topics_followed')}
        </span>
        <Show when={tg().follows.length > 0}>
          <span style="color:var(--color-text-secondary); font-size:var(--font-size-xs)">
            {tg().follows.length}
          </span>
        </Show>
      </button>

      {/* One row per user group. */}
      <For each={tg().groups}>
        {(g) => (
          <div style="display:flex; align-items:center">
            <button
              style={rowStyle(activeGroup() === g.id)}
              onClick={() => navigate(`/news?group=${encodeURIComponent(g.id)}`)}
              title={g.name}
            >
              <span aria-hidden="true">📁</span>
              <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
                {g.name}
              </span>
              <span style="color:var(--color-text-secondary); font-size:var(--font-size-xs)">
                {g.tags.length}
              </span>
            </button>
            <button
              class="nft-group-menu"
              style="flex-shrink:0; padding:6px; cursor:pointer; background:transparent; color:var(--color-text-secondary)"
              title={t('news_topics_manage')}
              onClick={() => {
                const pick = window.prompt(
                  `1 = ${t('news_topic_add')}\n2 = ${t('news_topic_group_rename')}\n3 = ${t('news_topic_group_delete')}`,
                  '1',
                );
                if (pick === '1') onAddTagToGroup(g.id);
                else if (pick === '2') onRenameGroup(g.id, g.name);
                else if (pick === '3') onDeleteGroup(g.id);
              }}
            >
              ⋯
            </button>
          </div>
        )}
      </For>

      {/* Actions row. */}
      <div style="display:flex; gap:4px; padding:4px 12px 8px">
        <button
          style="font-size:var(--font-size-xs); color:var(--color-accent-primary); background:transparent; cursor:pointer; padding:4px 6px"
          onClick={onNewGroup}
          disabled={caps().groups.full}
          title={caps().groups.full ? t('news_topics_cap_reached') : t('news_topic_group_new')}
        >
          ＋ {t('news_topic_group_new')}
        </button>
        <button
          style="font-size:var(--font-size-xs); color:var(--color-text-secondary); background:transparent; cursor:pointer; padding:4px 6px; margin-left:auto"
          onClick={() => setManaging((m) => !m)}
        >
          {t('news_topics_manage')}
        </button>
      </div>

      <Show when={managing()}>
        <div style="padding:0 12px 10px">
          <form onSubmit={submitAdd} style="display:flex; gap:4px; margin-bottom:6px">
            <input
              type="text"
              value={addValue()}
              onInput={(e) => setAddValue(e.currentTarget.value)}
              placeholder={t('news_topic_add')}
              disabled={caps().follows.full}
              style="flex:1; min-width:0; padding:4px 6px; font-size:var(--font-size-xs); background:var(--color-bg-secondary); color:var(--color-text-primary); border:1px solid var(--color-border); border-radius:var(--radius-sm)"
            />
          </form>
          <Show
            when={tg().follows.length > 0}
            fallback={
              <div style="font-size:var(--font-size-xs); color:var(--color-text-secondary)">
                {t('news_topics_empty')}
              </div>
            }
          >
            <div style="display:flex; flex-wrap:wrap; gap:4px">
              <For each={tg().follows}>
                {(tag) => (
                  <span
                    style="display:inline-flex; align-items:center; gap:4px; padding:2px 6px; font-size:11px; background:var(--color-bg-tertiary); border-radius:var(--radius-full); color:var(--color-text-secondary)"
                  >
                    #{tag}
                    <button
                      style="background:transparent; cursor:pointer; font-weight:700; color:var(--color-text-secondary)"
                      title={t('news_topic_unfollow')}
                      onClick={() => unfollowTag(tag)}
                    >
                      ✕
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show when={caps().follows.full}>
            <div style="font-size:11px; color:var(--color-text-secondary); margin-top:4px">
              {t('news_topics_cap_reached')}
            </div>
          </Show>
        </div>
      </Show>

      <hr style="border:none; border-top:1px solid var(--color-border); margin:8px 12px" />

      <HotTopics />
    </div>
  );
};
