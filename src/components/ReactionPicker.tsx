/**
 * ReactionPicker — compact reaction bar for news posts.
 *
 * Shows a single default 👍 when no reactions exist. On click, opens a small
 * popup with all reaction options. After selection, shows only reactions with
 * counts > 0.
 */

import { Component, createSignal, For, Show, onCleanup } from 'solid-js';
import { NEWS_REACTIONS } from '../lib/news-utils';

interface ReactionPickerProps {
  counts: Record<string, number>;
  onReact: (emoji: string) => void;
}

export const ReactionPicker: Component<ReactionPickerProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  // Close on outside click
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  };

  // Register/cleanup global listeners when popup opens/closes
  const startListening = () => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  };
  const stopListening = () => {
    document.removeEventListener('mousedown', handleClickOutside);
    document.removeEventListener('keydown', handleKeyDown);
  };
  onCleanup(stopListening);

  const togglePicker = () => {
    const next = !open();
    setOpen(next);
    if (next) startListening();
    else stopListening();
  };

  const handleSelect = (emoji: string) => {
    setOpen(false);
    stopListening();
    props.onReact(emoji);
  };

  // Active reactions = those with count > 0
  const activeReactions = () =>
    NEWS_REACTIONS.filter((r) => (props.counts[r.emoji] ?? 0) > 0);

  const hasAnyReaction = () => activeReactions().length > 0;

  return (
    <div class="reaction-picker" ref={containerRef}>
      {/* Show active reactions with counts */}
      <Show when={hasAnyReaction()}>
        <For each={activeReactions()}>
          {(r) => (
            <button
              class="reaction-btn active"
              onClick={() => handleSelect(r.emoji)}
              title={r.label}
            >
              {r.emoji}
              <span class="reaction-count">{props.counts[r.emoji]}</span>
            </button>
          )}
        </For>
      </Show>

      {/* Default thumbs-up trigger (shown when no reactions, or always as "add" button) */}
      <button
        class={`reaction-btn reaction-trigger ${open() ? 'open' : ''}`}
        onClick={togglePicker}
        title="React"
      >
        <Show when={hasAnyReaction()} fallback={<span class="reaction-default">👍</span>}>
          <span class="reaction-add">+</span>
        </Show>
      </button>

      {/* Popup picker */}
      <Show when={open()}>
        <div class="reaction-popup">
          <For each={NEWS_REACTIONS}>
            {(r) => (
              <button
                class="reaction-popup-btn"
                onClick={() => handleSelect(r.emoji)}
                title={r.label}
              >
                {r.emoji}
              </button>
            )}
          </For>
        </div>
      </Show>

      <style>{`
        .reaction-picker {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          position: relative;
        }
        .reaction-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          border-radius: var(--radius-sm);
          font-size: var(--font-size-sm);
          background: var(--color-bg-tertiary);
          cursor: pointer;
          transition: background 0.15s;
        }
        .reaction-btn:hover { background: var(--color-accent-primary); color: var(--color-text-inverse); }
        .reaction-btn.active { background: var(--color-accent-primary); color: var(--color-text-inverse); }
        .reaction-count { font-size: var(--font-size-xs); font-weight: 600; }
        .reaction-trigger {
          background: var(--color-bg-tertiary);
          color: var(--color-text-secondary);
        }
        .reaction-trigger.open { background: var(--color-border); }
        .reaction-default { font-size: var(--font-size-md); filter: grayscale(1); opacity: 0.6; }
        .reaction-trigger:hover .reaction-default { filter: none; opacity: 1; }
        .reaction-add { font-size: var(--font-size-sm); font-weight: 600; }
        .reaction-popup {
          position: absolute;
          bottom: calc(100% + 4px);
          left: 0;
          display: flex;
          gap: 2px;
          padding: 4px;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          box-shadow: 0 -2px 8px rgba(0,0,0,0.2);
          z-index: 50;
        }
        .reaction-popup-btn {
          width: 32px;
          height: 32px;
          font-size: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: var(--radius-sm);
          cursor: pointer;
        }
        .reaction-popup-btn:hover { background: var(--color-bg-tertiary); }
      `}</style>
    </div>
  );
};
