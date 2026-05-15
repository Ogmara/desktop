/**
 * WindowControls — Minimize / Maximize / Close icons for the Modern
 * design style (which hides the OS title bar via `decorations: false`).
 *
 * Rendered inside the slim global title-bar strip at the top of
 * `.app-layout`. The title bar itself owns the drag region and the
 * surrounding layout; this component just provides the three buttons.
 *
 * Each button opts out of the drag region with `-webkit-app-region:
 * no-drag` (defined alongside `.window-controls .window-ctrl` in
 * App.tsx) so clicks register normally.
 */

import { Component } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const WindowControls: Component = () => {
  return (
    <div class="window-controls">
      <button class="window-ctrl" title="Minimize"
        onClick={() => { void getCurrentWindow().minimize(); }}>
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect y="9" width="12" height="1.5" rx="0.75" fill="currentColor"/>
        </svg>
      </button>
      <button class="window-ctrl" title="Maximize"
        onClick={() => { void getCurrentWindow().toggleMaximize(); }}>
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
        </svg>
      </button>
      <button class="window-ctrl window-ctrl-close" title="Close"
        onClick={() => { void getCurrentWindow().close(); }}>
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  );
};
