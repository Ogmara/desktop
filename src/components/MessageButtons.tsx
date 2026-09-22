/**
 * MessageButtons — renders the interactive button row(s) attached to a
 * message (protocol §3.3, frontend spec §6.1.3).
 *
 * A NEW component, not a fork of CommandPopover — that's a composer
 * autocomplete UI, this is a message-render UI. Rendered between the
 * message body and the reaction row.
 */

import { Component, For, Show, createSignal, onCleanup } from 'solid-js';
import { walletAddress } from '../lib/auth';
import { t } from '../i18n/init';
import { stripBidi, safeText } from '../lib/sanitize';
import type { PayloadButtonRow } from '../lib/payload';

interface ButtonOrigin {
  channelId: number;
  msgId: string;
  author: string;
}

interface MessageButtonsProps {
  rows: PayloadButtonRow[];
  /** The message THESE buttons are attached to — becomes `origin` on press. */
  channelId: number;
  msgId: string;
  author: string;
  /**
   * Sends the press: signs and broadcasts a message whose content is
   * `command`, replying to `origin`. The caller (`ChatView`) owns this
   * because it alone knows whether the channel is encrypted — spec §6.1.3:
   * "Private and encrypted channels. Buttons work there unchanged" — only
   * `content` is ever sealed, so a press there needs the channel's epoch
   * key, which this component has no access to. Reject/throw to report a
   * failure; the error's `message` is shown to the user (sanitized).
   */
  onPress: (origin: ButtonOrigin, command: string) => Promise<void>;
}

/**
 * Injected ONCE at module load, not per instance — this renders inside
 * ChatView's per-message loop, so a component-body `<style>` would insert
 * one copy per message in an active channel. Mirrors `BotBadge`'s pattern.
 */
const STYLE_ID = 'ogmara-message-buttons-style';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
    .message-buttons { display: flex; flex-direction: column; gap: 4px; margin-top: var(--spacing-xs); }
    .message-button-row { display: flex; flex-wrap: wrap; gap: 4px; }
    .message-button-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 30px;
      max-width: 16ch;
      padding: 4px 10px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-bg-tertiary);
      color: var(--color-text-primary);
      font-size: var(--font-size-sm);
      cursor: pointer;
      transition: background 0.15s;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .message-button-btn:hover:not(:disabled) { background: var(--color-accent-primary); color: var(--color-text-inverse); }
    .message-button-btn:disabled { opacity: 0.6; cursor: default; }
    .message-button-spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: message-button-spin 0.6s linear infinite;
    }
    @keyframes message-button-spin { to { transform: rotate(360deg); } }
    .message-button-error { font-size: var(--font-size-xs); color: var(--color-error, #e05252); margin-top: 2px; }
    .message-button-sent { font-size: var(--font-size-xs); color: var(--color-text-secondary); margin-top: 2px; }
    .message-button-sent code { font-family: var(--font-mono, monospace); }
  `;
  document.head.appendChild(el);
}

export const MessageButtons: Component<MessageButtonsProps> = (props) => {
  // Keyed by "rowIndex-buttonIndex" — each button tracks its OWN in-flight
  // state independently (spec: "the tapped button shows a disabled/loading
  // state", not the whole row).
  const [pendingKeys, setPendingKeys] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal<string | null>(null);
  // "Immediately after pressing" disclosure (frontend spec §6.1.3 — clients
  // MUST show the literal command "before OR immediately after" a press).
  // `title` below covers "before" for a mouse/hover user; this covers
  // EVERY input method uniformly, including touch, where `title` never
  // fires and there is no long-press equivalent implemented here. A hand-
  // rolled touch-gesture "preview" was considered and rejected: it adds
  // real event-handling surface (double-fire, context-menu bubbling into
  // the message row's own long-press handler) for a case this simpler,
  // input-agnostic confirmation already covers.
  //
  // Deliberately NOT auto-cleared on a timer: since the press itself is
  // suppressed from the feed (spec §6.1.3), this is the only artifact that
  // ever shows a touch user what they signed and broadcast. A 6s timeout
  // would silently remove the one disclosure mechanism that isn't hover-
  // only — it clears when a new press starts, or on unmount.
  const [sentCommand, setSentCommand] = createSignal<string | null>(null);

  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(errorTimer));

  const press = async (command: string, key: string) => {
    if (!walletAddress() || pendingKeys().has(key)) return;
    setPendingKeys((prev) => new Set(prev).add(key));
    setError(null);
    setSentCommand(null);
    try {
      await props.onPress({ channelId: props.channelId, msgId: props.msgId, author: props.author }, command);
      setSentCommand(command);
    } catch (e: any) {
      // `stripBidi`, not the fuller `safeText` — this is a raw string from
      // an HTTP/SDK error, not a protocol field with the tighter descriptor
      // charset rule, but it can still carry attacker/node-influenced text
      // (the node's own error body) and deserves the same defense-in-depth
      // already applied to attachment filenames.
      const msg = stripBidi(e?.message || '') || t('message_button_send_failed') || 'Failed to send';
      setError(msg);
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => setError(null), 6000);
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <Show when={props.rows.some((r) => r.buttons.length > 0)}>
      <div class="message-buttons">
        <For each={props.rows}>
          {(row, ri) => (
            <Show when={row.buttons.length > 0}>
              <div class="message-button-row">
                <For each={row.buttons}>
                  {(button, bi) => {
                    const key = () => `${ri()}-${bi()}`;
                    // Render-time re-sanitization, on top of `payload.ts`'s
                    // decode-time `safeText()` pass — spec §6.1.3 asks for
                    // the strip to happen "at render time" specifically, as
                    // defense in depth for any future callsite that decodes
                    // a payload without going through that helper.
                    const label = () => safeText(button.label);
                    const command = () => safeText(button.command);
                    return (
                      <button
                        class="message-button-btn"
                        type="button"
                        // "Before pressing" disclosure for a mouse/hover user
                        // (frontend spec §6.1.3) — see `sentCommand` above for
                        // the input-agnostic "immediately after" counterpart
                        // that covers touch too.
                        title={walletAddress() ? command() : t('auth_connect_prompt')}
                        aria-label={label()}
                        aria-busy={pendingKeys().has(key())}
                        disabled={!walletAddress() || pendingKeys().has(key())}
                        onClick={() => press(command(), key())}
                      >
                        <Show when={pendingKeys().has(key())} fallback={label()}>
                          <span class="message-button-spinner" aria-hidden="true" />
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
          )}
        </For>
        <Show when={sentCommand()}>
          <div class="message-button-sent">{t('message_button_sent') || 'Sent:'} <code>{safeText(sentCommand())}</code></div>
        </Show>
        <Show when={error()}>
          <div class="message-button-error">{error()}</div>
        </Show>
      </div>
    </Show>
  );
};
