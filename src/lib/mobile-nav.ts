/**
 * Mobile-nav state — tracks whether the sidebar (chat list) or the main
 * content is visible on mobile viewports.
 *
 * Desktop layout shows both side-by-side. Mobile layout shows one OR the
 * other: the sidebar is the "list view", the main content is the "detail
 * view". Tapping a sidebar item flips to detail; tapping the back button
 * in the detail header flips back.
 */

import { createSignal } from 'solid-js';

export const MOBILE_BREAKPOINT_PX = 768;

/**
 * Reactive viewport flag. Reads `window.innerWidth` once at startup and
 * then updates whenever the window is resized. Components that call
 * `isMobileViewport()` inside a reactive scope (JSX, createMemo, createEffect)
 * will automatically re-run when the user drags the browser between
 * desktop and mobile widths.
 */
function computeMobile(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT_PX;
}

const [mobileViewport, setMobileViewport] = createSignal(computeMobile());

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const next = computeMobile();
    if (next !== mobileViewport()) {
      setMobileViewport(next);
      // When switching from mobile to desktop, reset to list-open so both panes show
      if (!next) setMobileListOpen(true);
    }
  });
}

/** True when the current viewport should use the mobile one-view-at-a-time layout. */
export function isMobileViewport(): boolean {
  return mobileViewport();
}

/**
 * `true`  = sidebar (chat list) is visible, content is hidden
 * `false` = content is visible, sidebar is hidden
 *
 * On desktop this signal is ignored — both are always visible.
 *
 * Default: show the list on initial load.
 */
const [mobileListOpen, setMobileListOpen] = createSignal(true);

export { mobileListOpen };

/** Show the chat list (used by content view back buttons). */
export function showMobileList(): void {
  setMobileListOpen(true);
}

/** Hide the chat list (used when opening a chat/detail from the sidebar). */
export function showMobileDetail(): void {
  setMobileListOpen(false);
}
