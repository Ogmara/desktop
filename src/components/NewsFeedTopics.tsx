/**
 * NewsFeedTopics — the "Followed Topics" + user topic groups section of the
 * News Feed sidebar, an always-visible follow / unfollow strip, the
 * "＋ Topic group" affordance, a separator, and the Hot Topics trending list.
 *
 * Model + cross-device sync: `lib/topic-groups.ts` (the `topicGroups` object
 * inside the encrypted settings blob). Selecting an entry navigates to
 * `/news?topics=all` or `/news?group=<id>`, which NewsView resolves into a
 * `listNews({ tags })` filter.
 *
 * Group create / rename / add-topic use inline `<input>` editing and a styled
 * floating menu (the same `.org-group-rename` + `.sidebar-context-menu` pattern
 * the channel-group sidebar uses) — never `window.prompt`, which renders as an
 * unstyled OS dialog and returns null inside the Tauri webview.
 */

import { Component, For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import { t } from '../i18n/init';
import { navigate, queryParam } from '../lib/router';
import { keepMenuInViewport } from '../lib/menu-position';
import {
  topicGroups,
  topicCaps,
  followTag,
  unfollowTag,
  createGroup,
  renameGroup,
  deleteGroup,
  addTagToGroup,
  removeTagFromGroup,
} from '../lib/topic-groups';
import { HotTopics } from './HotTopics';

export const NewsFeedTopics: Component = () => {
  const tg = topicGroups;
  const [addValue, setAddValue] = createSignal('');
  // Inline-edit state, mirroring Sidebar's channel-group pattern.
  const [renamingGroup, setRenamingGroup] = createSignal<string | null>(null);
  const [addingTagTo, setAddingTagTo] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<{ x: number; y: number; groupId: string } | null>(null);

  // Active-state: which entry the URL currently points at.
  const activeTopicsAll = createMemo(() => queryParam('topics') === 'all');
  const activeGroup = createMemo(() => queryParam('group'));

  const caps = () => topicCaps();

  // Close the floating menu on any click outside it or its trigger.
  if (typeof document !== 'undefined') {
    const closeMenu = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest('.nft-group-menu') || tgt.closest('.sidebar-context-menu')) return;
      setMenu(null);
    };
    document.addEventListener('click', closeMenu);
    onCleanup(() => document.removeEventListener('click', closeMenu));
  }

  const rowStyle = (active: boolean) =>
    `display:flex; align-items:center; gap:8px; width:100%; text-align:left; cursor:pointer; padding:8px 12px; background:${
      active ? 'var(--color-chat-active-bg)' : 'transparent'
    }; font-size:var(--font-size-sm); color:${active ? 'var(--color-accent-primary)' : 'var(--color-text-primary)'}`;

  // New group: create with a default name, then drop straight into inline rename
  // (identical to Sidebar.handleNewGroup — no prompt).
  const handleNewGroup = () => {
    const id = createGroup(t('news_topic_group_new'));
    if (id) setRenamingGroup(id);
  };
  const commitRename = (id: string, value: string) => {
    const v = value.trim();
    if (v) renameGroup(id, v);
    setRenamingGroup(null);
  };
  const handleDeleteGroup = (id: string) => {
    setMenu(null);
    if (window.confirm(t('news_topic_group_delete_confirm'))) deleteGroup(id);
  };
  const commitAddTag = (id: string, value: string) => {
    const v = value.trim();
    if (v) addTagToGroup(id, v);
    setAddingTagTo(null);
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

      {/* Always-visible follow / unfollow strip — add a hashtag, and remove any
          followed one with its ✕ (no hidden "manage" panel to discover). */}
      <div style="padding:2px 12px 8px">
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
          <div style="display:flex; flex-wrap:wrap; gap:4px; max-height:132px; overflow-y:auto">
            <For each={tg().follows}>
              {(tag) => (
                <span style="display:inline-flex; align-items:center; gap:4px; padding:2px 4px 2px 6px; font-size:11px; background:var(--color-bg-tertiary); border-radius:var(--radius-full); color:var(--color-text-secondary)">
                  #{tag}
                  <button
                    style="background:transparent; cursor:pointer; font-weight:700; line-height:1; padding:0 3px; color:var(--color-text-secondary)"
                    title={t('news_topic_unfollow')}
                    aria-label={`${t('news_topic_unfollow')} #${tag}`}
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

      {/* One row per user group. */}
      <For each={tg().groups}>
        {(g) => (
          <>
            <div style="display:flex; align-items:center; gap:2px; padding-right:6px">
              <Show
                when={renamingGroup() === g.id}
                fallback={
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
                }
              >
                {/* Inline rename — a sibling of the row button, never nested. */}
                <input
                  class="org-group-rename"
                  style="margin:4px 0 4px 12px"
                  value={g.name}
                  ref={(el) => setTimeout(() => el.focus(), 0)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(g.id, e.currentTarget.value);
                    else if (e.key === 'Escape') setRenamingGroup(null);
                  }}
                  onBlur={(e) => commitRename(g.id, e.currentTarget.value)}
                />
              </Show>
              <Show when={renamingGroup() !== g.id}>
                <button
                  class="nft-group-menu"
                  style="flex-shrink:0; padding:6px; cursor:pointer; background:transparent; color:var(--color-text-secondary)"
                  title={t('news_topics_manage')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, groupId: g.id });
                  }}
                >
                  ⋯
                </button>
              </Show>
            </div>

            {/* Group members — remove a hashtag from this group with its ✕. */}
            <Show when={g.tags.length > 0}>
              <div style="display:flex; flex-wrap:wrap; gap:4px; padding:0 12px 4px 30px">
                <For each={g.tags}>
                  {(tag) => (
                    <span style="display:inline-flex; align-items:center; gap:4px; padding:2px 4px 2px 6px; font-size:11px; background:var(--color-bg-tertiary); border-radius:var(--radius-full); color:var(--color-text-secondary)">
                      #{tag}
                      <button
                        style="background:transparent; cursor:pointer; font-weight:700; line-height:1; padding:0 3px; color:var(--color-text-secondary)"
                        title={t('news_topic_remove_from_group')}
                        aria-label={`${t('news_topic_remove_from_group')} #${tag}`}
                        onClick={() => removeTagFromGroup(g.id, tag)}
                      >
                        ✕
                      </button>
                    </span>
                  )}
                </For>
              </div>
            </Show>

            {/* Inline "add topic to this group" input. */}
            <Show when={addingTagTo() === g.id}>
              <input
                class="org-group-rename"
                style="margin:0 12px 6px 30px; width:calc(100% - 42px)"
                placeholder={t('news_topic_add')}
                ref={(el) => setTimeout(() => el.focus(), 0)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitAddTag(g.id, e.currentTarget.value);
                  else if (e.key === 'Escape') setAddingTagTo(null);
                }}
                onBlur={() => setAddingTagTo(null)}
              />
            </Show>
          </>
        )}
      </For>

      {/* Floating group context menu (reuses Sidebar's styled menu). */}
      <Show when={menu()} keyed>
        {(m) => (
          <div
            ref={keepMenuInViewport}
            class="sidebar-context-menu"
            style={`left:${m.x}px; top:${m.y}px`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setMenu(null);
                setRenamingGroup(null);
                setAddingTagTo(m.groupId);
              }}
            >
              {t('news_topic_add')}
            </button>
            <button
              onClick={() => {
                setMenu(null);
                setAddingTagTo(null);
                setRenamingGroup(m.groupId);
              }}
            >
              {t('news_topic_group_rename')}
            </button>
            <button class="danger" onClick={() => handleDeleteGroup(m.groupId)}>
              {t('news_topic_group_delete')}
            </button>
          </div>
        )}
      </Show>

      {/* Create a new group. */}
      <div style="padding:0 12px 8px">
        <button
          style="font-size:var(--font-size-xs); color:var(--color-accent-primary); background:transparent; cursor:pointer; padding:4px 6px"
          onClick={handleNewGroup}
          disabled={caps().groups.full}
          title={caps().groups.full ? t('news_topics_cap_reached') : t('news_topic_group_new')}
        >
          ＋ {t('news_topic_group_new')}
        </button>
      </div>

      <hr style="border:none; border-top:1px solid var(--color-border); margin:8px 12px" />

      <HotTopics />
    </div>
  );
};
