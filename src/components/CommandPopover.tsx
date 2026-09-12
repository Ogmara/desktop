/**
 * Command autocomplete popover — the `/`-picker for bot commands in a channel
 * composer (frontend spec §6.1.2). Sibling of `MentionPopover`; the differences
 * below are deliberate, not oversights.
 *
 * Wire it into a channel composer like:
 *
 *   <CommandPopover
 *     textareaRef={inputRef}
 *     channelId={activeChannelId()}
 *     onSelect={(insert, botAddress) => {
 *       setMessageInput(insert);
 *       if (botAddress) setMentions(prev => [...new Set([...prev, botAddress])]);
 *       inputRef()!.focus();
 *     }}
 *   />
 *
 * Spec: protocol §3.3 (a command is an ordinary chat message), §3.11 (the
 * descriptor), L2 §4.1 (`/bots`), §4.3 (`bot_commands_changed`).
 */

import { Component, createSignal, createEffect, createMemo, For, Show, onCleanup } from 'solid-js';
import type { ChannelBot } from '@ogmara/sdk';
import { getClient } from '../lib/api';
import { onWsEvent } from '../lib/ws';
import { stripBidi } from '../lib/sanitize';

/**
 * Every codepoint the node refuses in a descriptor (protocol §3.11), mirrored
 * from `@ogmara/sdk`'s `FORBIDDEN_DESCRIPTOR_CHARS`.
 *
 * The shared `stripBidi()` is a STRICT SUBSET of this — it misses U+061C,
 * U+200B, U+2060-U+2064, U+FEFF, U+FFF9-U+FFFB and the U+E0000 tag block, which
 * is the primitive behind invisible text smuggling. Since the whole point of
 * sanitizing here is defending against a node OLDER than 0.127.0 that never
 * validated, a filter laxer than the node's defeats its own purpose.
 *
 * U+200C ZWNJ and U+200D ZWJ are deliberately NOT stripped — ZWJ is required
 * for emoji sequences and ZWNJ for Persian and Indic orthography, and neither
 * can reorder text.
 */
const FORBIDDEN_DESCRIPTOR_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/gu;

/** Render-time sanitizer for any self-declared, wallet-supplied string. */
function safeText(s: string | null | undefined): string {
  return stripBidi(s ?? '').replace(FORBIDDEN_DESCRIPTOR_CHARS, '');
}
import { t } from '../i18n/init';
import { BotBadge } from './BotBadge';

/** One row in the picker — a command paired with the bot offering it. */
interface CommandRow {
  bot: ChannelBot;
  name: string;
  description: string;
  argsHint: string | null;
  /** `true` when another bot in this channel exposes the same command name. */
  ambiguous: boolean;
}

interface CommandPopoverProps {
  /** Getter for the composer element — pass the SIGNAL, not a plain local. */
  textareaRef: () => HTMLTextAreaElement | HTMLInputElement | undefined;
  /** Channel currently open. The picker is channel-scoped; `undefined` disables it. */
  channelId: () => number | undefined;
  /**
   * Called with the full replacement composer value and, when the command is
   * ambiguous, the bot's wallet address to add to the envelope's `mentions[]`.
   */
  onSelect: (insertValue: string, botAddress: string | null) => void;
}

/** Rows rendered at once. Matches §6.1.1's candidate cap — a channel can hold
 *  many bots with up to 32 commands each, and `/` is a keystroke path. */
const MAX_ROWS = 20;
/** How long a channel's bot list is reused before refetching. */
const CACHE_TTL = 60_000;
/**
 * How long a FAILED fetch is remembered.
 *
 * Deliberately much shorter than `CACHE_TTL`: a failure is not the same fact as
 * "this channel has no bots", and caching it for the full minute meant one
 * dropped request disabled the picker until the TTL expired — even after
 * connectivity came straight back — because the next `/` saw a valid-looking
 * empty entry and skipped the refetch.
 */
const ERROR_CACHE_TTL = 3_000;
/**
 * Channels retained in the per-instance cache.
 *
 * The map is destroyed when ChatView unmounts, so this is already bounded in
 * practice — but "already bounded in practice" is how unbounded maps get
 * shipped, and entries are cheap to evict.
 */
const MAX_CACHED_CHANNELS = 32;

/**
 * Detect a `/`-trigger.
 *
 * Position 0 of an otherwise-empty-or-single-token composer ONLY — NOT after
 * whitespace, unlike `@`. A mid-message `/` is a date, a path, a fraction or an
 * "and/or"; a leading `/` is unambiguous. Because the trigger is at position 0
 * there is nothing to scan back through, so this is simpler than
 * `detectMentionAt` rather than a copy of it.
 *
 * Returns the typed command token (may be empty right after `/`), or `null`.
 */
function detectCommandAt(value: string, cursor: number): string | null {
  if (!value.startsWith('/')) return null;
  // ANY whitespace closes the picker permanently for this composer content —
  // not merely "the cursor is past it". Per §6.1.2, re-triggering requires
  // deleting back to a composer that is only the command token.
  //
  // The weaker "cursor <= firstSpace" test DESTROYED USER TEXT: with
  // `/ping check server status`, moving the caret back into `ping` to fix a
  // typo and typing a character reopened the picker, and Enter — the natural
  // key in a chat composer, and the picker's own select key — replaced the
  // whole composer with `/ping `, silently discarding the arguments with no
  // undo.
  if (/\s/.test(value)) return null;
  const token = value.slice(1);
  // `/` is also how a handle is disambiguated; stop at `@` so the picker
  // narrows on the command name rather than the handle.
  if (token.includes('@')) return null;
  // Guard the caret too: with no whitespace the token is the whole value, so
  // the caret must be inside it for the picker to make sense.
  if (cursor < 1 || cursor > value.length) return null;
  return token;
}

export const CommandPopover: Component<CommandPopoverProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [bots, setBots] = createSignal<ChannelBot[]>([]);
  const [selectedIdx, setSelectedIdx] = createSignal(0);
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);

  // Per-channel cache. The list is fetched on channel open and on a
  // `bot_commands_changed` nudge — NOT per keystroke. Filtering is local.
  const cache = new Map<number, { bots: ChannelBot[]; ts: number; failed?: boolean }>();

  const close = () => {
    setOpen(false);
    setSelectedIdx(0);
    setPos(null);
  };

  const loadBots = async (channelId: number, force = false) => {
    const cached = cache.get(channelId);
    const ttl = cached?.failed ? ERROR_CACHE_TTL : CACHE_TTL;
    if (!force && cached && Date.now() - cached.ts < ttl) {
      setBots(cached.bots);
      return;
    }
    try {
      const resp = await getClient().getChannelBots(channelId);
      if (cache.size >= MAX_CACHED_CHANNELS && !cache.has(channelId)) {
        // Map preserves insertion order, so the first key is the oldest.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(channelId, { bots: resp.bots, ts: Date.now() });
      // Guard against a channel switch that happened while this was in flight.
      // Without it, a slow response for the channel we LEFT lands after the one
      // for the channel we are now in and overwrites it — so the picker offers
      // commands from another channel, and picking one puts a bot address in
      // `mentions[]` for a bot that is not even a member here.
      if (props.channelId() === channelId) setBots(resp.bots);
    } catch {
      // Offline, or the node predates 0.127.0 — the picker simply never opens.
      // `/` stays ordinary text, which is the right fallback. Remembered only
      // briefly (see ERROR_CACHE_TTL) so a blip does not read as "no bots".
      cache.set(channelId, { bots: [], ts: Date.now(), failed: true });
      if (props.channelId() === channelId) setBots([]);
    }
  };

  /**
   * Flatten bots → command rows, filter by the typed prefix, order, cap.
   *
   * Memoized: this is read from the `Show` guard, the `For` iterator AND
   * `onKeyDown`, so without it every keystroke and every arrow press redid the
   * whole flatten + sort two or three times over.
   */
  const rows = createMemo((): CommandRow[] => {
    const q = query().toLowerCase();
    const all = bots();

    // A command name offered by more than one bot needs `@handle` to
    // disambiguate on insert.
    // Case-FOLDED, because matching is case-insensitive. Counting raw names
    // would treat a bot declaring `Ping` and another declaring `ping` as two
    // distinct commands, flag neither as ambiguous, and then insert a bare
    // `/ping` with no handle and no `mentions[]` — silently unguarded against
    // exactly the collision this disambiguation exists to prevent.
    // (The node forces lowercase on the wire, so this only bites against a
    // pre-0.127.0 node — which is precisely when it matters.)
    const counts = new Map<string, number>();
    for (const b of all) {
      for (const c of b.commands ?? []) {
        const key = c.name.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    const flat: CommandRow[] = [];
    for (const b of all) {
      for (const c of b.commands ?? []) {
        // Matching is case-INSENSITIVE: mobile keyboards autocapitalise the
        // first character of an empty composer, so `/C` must match `c`.
        if (q && !c.name.toLowerCase().startsWith(q)) continue;
        flat.push({
          bot: b,
          name: c.name,
          description: c.description,
          argsHint: c.args_hint ?? null,
          ambiguous: (counts.get(c.name.toLowerCase()) ?? 0) > 1,
        });
      }
    }

    // Deterministic ordering, so all three clients agree: exact match first,
    // then prefix matches alphabetically, ties broken by verified then address.
    // NEVER rank by handle similarity to what was typed — that is a squatter's
    // ladder.
    const byBot = (a: CommandRow, b: CommandRow) => {
      if (a.bot.verified !== b.bot.verified) return a.bot.verified ? -1 : 1;
      return a.bot.address.localeCompare(b.bot.address);
    };
    flat.sort((a, b) => {
      // Empty query: group by bot, then by command name within each bot — §6.1.2.
      // Interleaving every bot's commands alphabetically makes a multi-bot
      // channel unreadable at a glance.
      if (!q) return byBot(a, b) || a.name.localeCompare(b.name);
      const aExact = a.name.toLowerCase() === q ? 0 : 1;
      const bExact = b.name.toLowerCase() === q ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return byBot(a, b);
    });
    return flat.slice(0, MAX_ROWS);
  });

  const updatePosition = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setPos({ left: rect.left, top: rect.top });
  };

  const onInput = () => {
    const el = props.textareaRef();
    const channelId = props.channelId();
    if (!el || channelId === undefined) return;
    const detected = detectCommandAt(el.value, el.selectionStart ?? el.value.length);
    if (detected === null) {
      if (open()) close();
      return;
    }
    setQuery(detected);
    setSelectedIdx(0);
    void loadBots(channelId);
    setOpen(true);
    updatePosition(el);
  };

  const pick = (row: CommandRow) => {
    // Insert `/name ` — or `/name@handle ` when two bots expose the same name.
    // The `@handle` is a hint for humans; `mentions[]` carries the wallet and is
    // what actually routes, so a handle collision cannot misdirect the command.
    const handle = row.ambiguous && row.bot.bot_handle ? `@${row.bot.bot_handle}` : '';
    props.onSelect(`/${row.name}${handle} `, row.ambiguous ? row.bot.address : null);
    close();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open()) return;
    const list = rows();
    if (list.length === 0) {
      if (e.key === 'Escape') {
        close();
        e.preventDefault();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        setSelectedIdx((i) => (i + 1) % list.length);
        e.preventDefault();
        break;
      case 'ArrowUp':
        setSelectedIdx((i) => (i - 1 + list.length) % list.length);
        e.preventDefault();
        break;
      case 'Enter':
      case 'Tab': {
        const row = list[selectedIdx()];
        if (row) {
          pick(row);
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

  createEffect(() => {
    const el = props.textareaRef();
    if (!el) return;
    const inputListener = onInput as EventListener;
    const keyListener = onKeyDown as unknown as EventListener;
    const blurListener = () => setTimeout(() => close(), 150);
    el.addEventListener('input', inputListener);
    el.addEventListener('keydown', keyListener);
    el.addEventListener('blur', blurListener);
    onCleanup(() => {
      el.removeEventListener('input', inputListener);
      el.removeEventListener('keydown', keyListener);
      el.removeEventListener('blur', blurListener);
    });
  });

  // Prefetch on channel open so the first `/` is instant, and drop the cache
  // for a channel we leave.
  createEffect(() => {
    const channelId = props.channelId();
    // Clear synchronously so a `/` typed immediately after switching cannot
    // show the PREVIOUS channel's commands during the fetch window.
    setBots([]);
    close();
    if (channelId !== undefined) void loadBots(channelId);
  });

  // A bot edited its commands — refetch the open channel so an open picker and
  // the next one both reflect it. The node suppresses this event when the
  // descriptor did not actually change, so a bot restarting causes no churn
  // here; it also coalesces per wallet, so an editing burst arrives once.
  const wsCleanup = onWsEvent((event) => {
    if (event.type !== 'bot_commands_changed') return;
    const channelId = props.channelId();
    if (channelId !== undefined) void loadBots(channelId, true);
  });
  onCleanup(wsCleanup);

  onCleanup(() => close());

  const truncateAddress = (a: string) => `${a.slice(0, 7)}…${a.slice(-4)}`;

  return (
    <Show when={open() && pos() && rows().length > 0}>
      <div
        class="command-popover"
        role="listbox"
        aria-label={t('bot_commands_label') || 'Bot commands'}
        style={{
          position: 'fixed',
          left: `${pos()!.left}px`,
          top: `${pos()!.top}px`,
          transform: 'translateY(-100%)',
          'min-width': '320px',
          'max-width': '480px',
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <For each={rows()}>
          {(row, idx) => (
            <button
              type="button"
              class={`command-popover-row ${idx() === selectedIdx() ? 'command-popover-row-active' : ''}`}
              role="option"
              aria-selected={idx() === selectedIdx()}
              onClick={() => pick(row)}
              onMouseEnter={() => setSelectedIdx(idx())}
            >
              <div class="command-popover-avatar">
                <Show
                  when={row.bot.avatar_cid}
                  fallback={<span>{(row.bot.display_name || row.bot.address).slice(0, 1).toUpperCase()}</span>}
                >
                  <img
                    src={getClient().getMediaUrl(row.bot.avatar_cid!)}
                    alt=""
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  />
                </Show>
              </div>
              <div class="command-popover-text">
                <span class="command-popover-cmd">
                  {/* Descriptor strings are self-declared by an untrusted wallet.
                      They render as PLAIN TEXT — never through FormattedText or
                      any markdown/mention/link pass — and go through stripBidi
                      even though the node rejects those codepoints, because the
                      node serving us may predate that check. */}
                  /{safeText(row.name)}
                  <Show when={row.ambiguous && row.bot.bot_handle}>
                    <span class="command-popover-handle">@{safeText(row.bot.bot_handle)}</span>
                  </Show>
                  <Show when={row.argsHint}>
                    <span class="command-popover-args">{safeText(row.argsHint)}</span>
                  </Show>
                </span>
                <span class="command-popover-desc">{safeText(row.description)}</span>
                <span class="command-popover-bot">
                  {safeText(row.bot.display_name)}
                  {/* The truncated address is ALWAYS visible — the same
                      anti-impersonation rule §6.1.1 imposes, and mandatory for
                      the same reason: handles are self-declared and non-unique. */}
                  <span class="command-popover-addr">{truncateAddress(row.bot.address)}</span>
                  <Show when={row.bot.verified}>
                    <span class="command-popover-verified" title={t('user_verified') || 'Verified on-chain'}>✓</span>
                  </Show>
                  {/* Redundant in a picker where every row IS a bot, but kept
                      for consistency with §6.2's list so all three clients
                      render the same set of places. */}
                  <BotBadge isBot />
                </span>
              </div>
            </button>
          )}
        </For>
      </div>
      <style>{`
        .command-popover {
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
        .command-popover-row {
          display: flex;
          align-items: flex-start;
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
        .command-popover-row-active,
        .command-popover-row:hover {
          background: var(--color-bg-tertiary);
        }
        .command-popover-avatar {
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
        .command-popover-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .command-popover-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
        .command-popover-cmd {
          font-size: var(--font-size-sm);
          font-weight: 600;
          font-family: monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .command-popover-handle { color: var(--color-accent-primary); font-weight: 500; }
        .command-popover-args {
          color: var(--color-text-secondary);
          font-weight: 400;
          margin-left: 6px;
        }
        .command-popover-desc {
          font-size: var(--font-size-sm);
          color: var(--color-text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .command-popover-bot {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .command-popover-addr { font-family: monospace; }
        .command-popover-verified { color: var(--color-success); font-size: 11px; }
      `}</style>
    </Show>
  );
};
