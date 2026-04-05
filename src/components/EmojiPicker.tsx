/**
 * EmojiPicker — compact emoji grid for inserting into text inputs.
 *
 * Shows a small panel of commonly used emojis. Clicking one calls onSelect
 * with the emoji character. Clicking outside or pressing Escape closes it.
 */

import { Component, For, Show, createSignal, onCleanup } from 'solid-js';

/** Standard emoji set grouped by category. */
const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  { label: 'Smileys', emojis: ['😀','😂','🤣','😊','😍','🥰','😎','🤔','😢','😭','😤','🤯','🥳','😴','🤮','🤡','👻','💀'] },
  { label: 'Gestures', emojis: ['👍','👎','👏','🙏','🤝','✌️','🤞','💪','👋','🖐️','✋','🫶'] },
  { label: 'Hearts', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❤️‍🔥','💕','💖'] },
  { label: 'Objects', emojis: ['🔥','⭐','✨','💎','🎉','🎊','🏆','🎯','💡','📎','🔗','🔔'] },
  { label: 'Nature', emojis: ['☀️','🌙','⛈️','🌈','🌊','🌸','🍀','🐱','🐶','🦄','🐸','🦋'] },
  { label: 'Food', emojis: ['🍕','🍔','🍟','🌮','🍣','🍦','🎂','🍺','☕','🧃','🍷','🥂'] },
  { label: 'Flags', emojis: ['🏴‍☠️','🏁','🚩','🏳️‍🌈'] },
];

export const EmojiPicker: Component<{
  onSelect: (emoji: string) => void;
  onClose: () => void;
}> = (props) => {
  let panelRef: HTMLDivElement | undefined;

  // Close on click outside
  const handleClickOutside = (e: MouseEvent) => {
    if (panelRef && !panelRef.contains(e.target as Node)) {
      props.onClose();
    }
  };

  // Close on Escape
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };

  document.addEventListener('mousedown', handleClickOutside);
  document.addEventListener('keydown', handleKeyDown);
  onCleanup(() => {
    document.removeEventListener('mousedown', handleClickOutside);
    document.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <div class="emoji-picker" ref={panelRef}>
      <For each={EMOJI_GROUPS}>
        {(group) => (
          <div class="emoji-group">
            <div class="emoji-group-label">{group.label}</div>
            <div class="emoji-grid">
              <For each={group.emojis}>
                {(emoji) => (
                  <button
                    class="emoji-btn"
                    onClick={() => props.onSelect(emoji)}
                    title={emoji}
                  >
                    {emoji}
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </For>

      <style>{`
        .emoji-picker {
          position: absolute;
          bottom: 100%;
          right: 0;
          margin-bottom: var(--spacing-xs);
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-sm);
          width: 300px;
          max-height: 320px;
          overflow-y: auto;
          box-shadow: 0 -4px 16px rgba(0,0,0,0.3);
          z-index: 50;
        }
        .emoji-group { margin-bottom: var(--spacing-xs); }
        .emoji-group-label {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          font-weight: 600;
          padding: var(--spacing-xs) 0;
        }
        .emoji-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 2px;
        }
        .emoji-btn {
          width: 32px;
          height: 32px;
          font-size: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: var(--radius-sm);
          cursor: pointer;
        }
        .emoji-btn:hover { background: var(--color-bg-tertiary); }
      `}</style>
    </div>
  );
};
