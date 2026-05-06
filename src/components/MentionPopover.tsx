/**
 * Mention autocomplete popover — Telegram-style `@`-mention picker for any
 * text input. Watches a textarea's value + cursor position, detects when
 * the cursor sits inside a fresh `@<prefix>` token, debounces a server
 * search via `client.searchUsers()`, and renders a keyboard-navigable
 * popover. On selection it invokes `onSelect(hit, range)` so the caller
 * can decide exactly how to splice the result into the input value.
 *
 * Wire it into a composer like:
 *
 *   <MentionPopover
 *     textareaRef={inputRef}
 *     onSelect={(hit, range) => {
 *       const v = messageInput();
 *       const inserted = `@${hit.display_name || hit.address.slice(0, 12)}`;
 *       setMessageInput(v.slice(0, range.start) + inserted + ' ' + v.slice(range.end));
 *       setMentions(prev => Array.from(new Set([...prev, hit.address])));
 *       inputRef!.focus();
 *     }}
 *   />
 *
 * Spec: protocol §3.3 (mentions wire format), L2 §4.1 (search endpoint),
 * frontend §6.1.1 (popover UX).
 */

import { Component, createSignal, createEffect, For, Show, onCleanup } from 'solid-js';
import type { UserSearchHit } from '@ogmara/sdk';
import { getClient } from '../lib/api';
import { t } from '../i18n/init';

export interface MentionRange {
  /** Index of the leading `@` in the textarea value. */
  start: number;
  /** Index after the last typed character of the prefix. */
  end: number;
  /** The query the user typed after `@` (may be empty on a fresh trigger). */
  prefix: string;
}

interface MentionPopoverProps {
  /**
   * The textarea/input being watched. The popover attaches input + keydown
   * listeners to this element. SolidJS refs are functions; pass the raw
   * element from the composer.
   */
  textareaRef: HTMLTextAreaElement | HTMLInputElement | undefined;
  /**
   * Called when the user picks a result. The caller is responsible for
   * splicing the text into the input value and pushing `hit.address` into
   * the envelope's `mentions[]` array.
   */
  onSelect: (hit: UserSearchHit, range: MentionRange) => void;
  /**
   * Search debounce in ms. Default 150 — fast enough to feel live, slow
   * enough to coalesce typed bursts.
   */
  debounceMs?: number;
}

/** How far back to scan from the cursor when looking for an `@` trigger. */
const MAX_PREFIX_LEN = 32;

/** Detect whether `value[cursor-1..cursor]` sits inside an `@<prefix>` token.
 *  Returns the range + prefix when active, `null` otherwise. */
function detectMentionAt(value: string, cursor: number): MentionRange | null {
  // Walk left from the cursor looking for an `@`. Stop at whitespace or
  // length cap. The token must be either at the start of the input or
  // preceded by whitespace — `foo@bar` is an email, not a mention.
  let i = cursor - 1;
  while (i >= 0 && cursor - i <= MAX_PREFIX_LEN) {
    const ch = value[i];
    if (ch === '@') {
      const before = i === 0 ? '' : value[i - 1];
      if (i === 0 || /\s/.test(before)) {
        const prefix = value.slice(i + 1, cursor);
        // Reject prefixes containing whitespace or another `@` — the user
        // has typed past the mention boundary.
        if (/\s|@/.test(prefix)) return null;
        return { start: i, end: cursor, prefix };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

export const MentionPopover: Component<MentionPopoverProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [range, setRange] = createSignal<MentionRange | null>(null);
  const [results, setResults] = createSignal<UserSearchHit[]>([]);
  const [selectedIdx, setSelectedIdx] = createSignal(0);
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Cache lookups for ~30s so re-typing the same prefix is instant.
  const cache = new Map<string, { hits: UserSearchHit[]; ts: number }>();
  const CACHE_TTL = 30_000;

  const close = () => {
    setOpen(false);
    setResults([]);
    setSelectedIdx(0);
    setRange(null);
    setPos(null);
  };

  /** Debounced server search. The popover is allowed to be empty mid-debounce. */
  const queryServer = (prefix: string) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    const cached = cache.get(prefix);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      setResults(cached.hits);
      setSelectedIdx(0);
      return;
    }
    debounceTimer = setTimeout(async () => {
      try {
        // Don't fire a network request for empty prefix — show nothing
        // until the user types at least one character.
        if (prefix.length === 0) {
          setResults([]);
          return;
        }
        const resp = await getClient().searchUsers(prefix, 20);
        cache.set(prefix, { hits: resp.users, ts: Date.now() });
        setResults(resp.users);
        setSelectedIdx(0);
      } catch {
        // Silent — popover just stays empty. The user can keep typing.
        setResults([]);
      }
    }, props.debounceMs ?? 150);
  };

  /** Position the popover anchored ABOVE the textarea, slightly inset. The
   *  textarea is the natural anchor (we don't try to track the caret per
   *  character, which would require a hidden mirror element). */
  const updatePosition = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setPos({
      left: rect.left,
      top: rect.top, // popover renders ABOVE via translateY(-100%) in CSS
    });
  };

  const onInput = () => {
    const el = props.textareaRef;
    if (!el) return;
    const value = el.value;
    const cursor = el.selectionStart ?? value.length;
    const detected = detectMentionAt(value, cursor);
    if (!detected) {
      if (open()) close();
      return;
    }
    setRange(detected);
    setOpen(true);
    updatePosition(el);
    queryServer(detected.prefix.toLowerCase());
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open()) return;
    if (results().length === 0) {
      // Allow Esc to close even with no results
      if (e.key === 'Escape') {
        close();
        e.preventDefault();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        setSelectedIdx((i) => (i + 1) % results().length);
        e.preventDefault();
        break;
      case 'ArrowUp':
        setSelectedIdx((i) => (i - 1 + results().length) % results().length);
        e.preventDefault();
        break;
      case 'Enter':
      case 'Tab': {
        const hit = results()[selectedIdx()];
        const r = range();
        if (hit && r) {
          props.onSelect(hit, r);
          close();
          e.preventDefault();
        }
        break;
      }
      case 'Escape':
        close();
        e.preventDefault();
        break;
    }
  };

  // Re-attach listeners whenever the textarea ref changes. Solid runs
  // createEffect on every dependency change — `props.textareaRef` is a
  // value, so this fires on initial mount only, but defensively re-binds
  // if the parent ever swaps the ref.
  createEffect(() => {
    const el = props.textareaRef;
    if (!el) return;
    const inputListener = onInput as EventListener;
    const keyListener = onKeyDown as unknown as EventListener;
    el.addEventListener('input', inputListener);
    el.addEventListener('keydown', keyListener);
    el.addEventListener('blur', () => {
      // Delay close so a click on a result row still fires before blur
      // tears down the popover.
      setTimeout(() => close(), 150);
    });
    onCleanup(() => {
      el.removeEventListener('input', inputListener);
      el.removeEventListener('keydown', keyListener);
    });
  });

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  const truncateAddress = (a: string) => `${a.slice(0, 7)}…${a.slice(-4)}`;

  return (
    <Show when={open() && pos()}>
      <div
        class="mention-popover"
        role="listbox"
        aria-label={t('mention_popover_label') || 'Mention suggestions'}
        style={{
          position: 'fixed',
          left: `${pos()!.left}px`,
          top: `${pos()!.top}px`,
          transform: 'translateY(-100%)',
          'min-width': '280px',
          'max-width': '420px',
        }}
        // Clicking inside the popover before mouseup shouldn't blur the
        // textarea (which would close us before onSelect fires).
        onMouseDown={(e) => e.preventDefault()}
      >
        <Show
          when={results().length > 0}
          fallback={
            <div class="mention-popover-empty">
              {t('mention_no_results') || 'No matching users'}
            </div>
          }
        >
          <For each={results()}>
            {(hit, idx) => (
              <button
                type="button"
                class={`mention-popover-row ${idx() === selectedIdx() ? 'mention-popover-row-active' : ''}`}
                role="option"
                aria-selected={idx() === selectedIdx()}
                onClick={() => {
                  const r = range();
                  if (r) {
                    props.onSelect(hit, r);
                    close();
                  }
                }}
                onMouseEnter={() => setSelectedIdx(idx())}
              >
                <div class="mention-popover-avatar">
                  <Show
                    when={hit.avatar_cid}
                    fallback={<span>{(hit.display_name || hit.address).slice(0, 1).toUpperCase()}</span>}
                  >
                    <img
                      src={getClient().getMediaUrl(hit.avatar_cid!)}
                      alt=""
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  </Show>
                </div>
                <div class="mention-popover-text">
                  <span class="mention-popover-name">
                    {hit.display_name || truncateAddress(hit.address)}
                    <Show when={hit.verified}><span class="mention-popover-verified" title={t('user_verified') || 'Verified on-chain'}>✓</span></Show>
                  </span>
                  <span class="mention-popover-addr">{truncateAddress(hit.address)}</span>
                </div>
              </button>
            )}
          </For>
        </Show>
      </div>
      <style>{`
        .mention-popover {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
          z-index: 10000;
          padding: 4px;
          margin-top: -4px;
          max-height: 320px;
          overflow-y: auto;
        }
        .mention-popover-empty {
          padding: 12px 16px;
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
        }
        .mention-popover-row {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 6px 8px;
          border-radius: var(--radius-sm);
          background: transparent;
          border: none;
          cursor: pointer;
          color: var(--color-text-primary);
          text-align: left;
        }
        .mention-popover-row-active,
        .mention-popover-row:hover {
          background: var(--color-bg-tertiary);
        }
        .mention-popover-avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: var(--font-size-sm);
          font-weight: 600;
          flex-shrink: 0;
          overflow: hidden;
        }
        .mention-popover-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .mention-popover-text {
          display: flex;
          flex-direction: column;
          min-width: 0;
          flex: 1;
        }
        .mention-popover-name {
          font-size: var(--font-size-sm);
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mention-popover-verified {
          color: var(--color-success);
          margin-left: 4px;
          font-size: 11px;
        }
        .mention-popover-addr {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          font-family: monospace;
        }
      `}</style>
    </Show>
  );
};
