/**
 * Keep a floating context menu inside the visible window.
 *
 * Context menus open at the pointer's client coordinates. When the pointer is
 * near the right or bottom edge — routine once the sidebar holds enough
 * channels or DM conversations to fill its height — the menu extends past the
 * window and the OS clips whatever spills over, hiding menu items.
 *
 * Used as a ref callback on the menu element. It measures the menu on the next
 * frame (after its items are laid out and it has its real size) and nudges it
 * back inside: flipped above / left of the anchor point when there is no room
 * below / to the right, and clamped to a small margin from every edge. If the
 * menu is taller than the window it is pinned to the top margin and left to
 * scroll (`overflow-y: auto` in the menu CSS).
 *
 *   <div ref={keepMenuInViewport} style={{ left: `${x}px`, top: `${y}px` }} />
 */
const EDGE_MARGIN = 8;

export function keepMenuInViewport(el: HTMLElement): void {
  requestAnimationFrame(() => {
    if (!el.isConnected) return;

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left;
    let top = rect.top;

    if (rect.right > vw - EDGE_MARGIN) {
      left = vw - EDGE_MARGIN - rect.width;
    }
    left = Math.max(EDGE_MARGIN, left);

    if (rect.bottom > vh - EDGE_MARGIN) {
      top = vh - EDGE_MARGIN - rect.height;
    }
    top = Math.max(EDGE_MARGIN, top);

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  });
}
