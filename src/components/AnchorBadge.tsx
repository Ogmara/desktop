/**
 * AnchorBadge — visual trust badge for nodes that anchor L2 state on-chain.
 *
 * Renders a green checkmark SVG for verified/active nodes, nothing for "none".
 * "active" nodes get an additional label. Tooltip shows verification details.
 */

import { Component, Show } from 'solid-js';
import { t } from '../i18n/init';

interface Props {
  level: 'active' | 'verified' | 'none';
  showLabel?: boolean;
}

const CheckmarkSvg: Component<{ size?: number }> = (props) => {
  const s = props.size ?? 14;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="7.5" fill="var(--color-anchor-badge, #22c55e)" />
      <path
        d="M5 8.2L7 10.2L11 6"
        stroke="white"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
};

export const AnchorBadge: Component<Props> = (props) => {
  if (props.level === 'none') return null;

  const tooltip = () =>
    props.level === 'active' ? t('anchor_tooltip_active') : t('anchor_tooltip_verified');

  const label = () =>
    props.level === 'active' ? t('anchor_active') : t('anchor_verified');

  return (
    <span class="anchor-badge" title={tooltip()}>
      <CheckmarkSvg size={props.level === 'active' ? 14 : 12} />
      <Show when={props.showLabel === true || (props.showLabel !== false && props.level === 'active')}>
        <span class="anchor-badge-label">{label()}</span>
      </Show>

      <style>{`
        .anchor-badge {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          white-space: nowrap;
        }
        .anchor-badge-label {
          font-size: var(--font-size-xs, 11px);
          font-weight: 600;
          color: var(--color-anchor-badge, #22c55e);
        }
      `}</style>
    </span>
  );
};
