/**
 * "Bot" badge — shown next to a display name wherever an account that has
 * self-declared itself automated appears (frontend spec §6.2).
 *
 * Deliberately NEUTRAL chrome: not a checkmark, not a shield, no green. It sits
 * BESIDE the on-chain `verified` badge and never replaces or merges with it,
 * because the two say different things:
 *
 *   verified — the wallet paid to register on-chain. A trust signal.
 *   bot      — the account says it is automated. Free, self-declared, cosmetic.
 *
 * Shown for EVERY self-declared bot, verified or not. Restricting it to verified
 * bots would be backwards: an unverified bot is precisely the one a user most
 * needs labelled.
 */

import { Component, Show } from 'solid-js';
import { t } from '../i18n/init';

interface BotBadgeProps {
  /** Render nothing unless this is true. */
  isBot?: boolean | null;
}

/**
 * Injected ONCE at module load, not per instance.
 *
 * The obvious pattern in this codebase is a `<style>` inside the component
 * body, which is fine for the badges that appear a handful of times per screen.
 * This one renders inside ChatView's per-message loop, so an active channel
 * would insert hundreds of byte-identical `<style>` elements into the document.
 */
const BADGE_STYLE_ID = 'ogmara-bot-badge-style';
if (typeof document !== 'undefined' && !document.getElementById(BADGE_STYLE_ID)) {
  const el = document.createElement('style');
  el.id = BADGE_STYLE_ID;
  el.textContent = `
    .bot-badge {
      display: inline-flex;
      align-items: center;
      margin-left: 6px;
      padding: 0 5px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background: var(--color-bg-tertiary);
      color: var(--color-text-secondary);
      font-size: var(--font-size-xs);
      font-weight: 500;
      line-height: 1.5;
      vertical-align: middle;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(el);
}

export const BotBadge: Component<BotBadgeProps> = (props) => (
  <Show when={props.isBot}>
    <span
      class="bot-badge"
      title={t('bot_badge_tooltip') || 'Self-declared — not verified by Ogmara'}
    >
      {t('bot_badge') || 'Bot'}
    </span>
  </Show>
);
