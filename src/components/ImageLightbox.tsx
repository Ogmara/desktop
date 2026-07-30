/**
 * ImageLightbox — global fullscreen image viewer with zoom/pan + download.
 *
 * Mounted once at the app root; any component opens it via {@link openLightbox}.
 * Zoom: mouse wheel, pinch (2-pointer tracking via Pointer Events, unifying
 * mouse/touch/pen), or double-click/double-tap — all anchored so the point
 * under the cursor/pinch-midpoint stays fixed. Pan: drag with a single pointer
 * once zoomed in. Download re-fetches the currently-displayed URL as a blob
 * (works for both a remote CID URL and an already-decrypted `blob:` URI) so
 * the saved file gets the real filename instead of the CID.
 */
import { Component, Show, createSignal, createEffect, onCleanup } from 'solid-js';
import { t } from '../i18n/init';

interface LightboxState {
  url: string;
  name?: string;
}

const [state, setState] = createSignal<LightboxState | null>(null);
const [scale, setScale] = createSignal(1);
const [pos, setPos] = createSignal({ x: 0, y: 0 });

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DBLCLICK_SCALE = 2.5;

/** Open the lightbox for `url` (a media CID URL or a decrypted `blob:` URI). */
export function openLightbox(url: string, name?: string): void {
  setScale(1);
  setPos({ x: 0, y: 0 });
  setState({ url, name });
}

function close(): void {
  setState(null);
  setScale(1);
  setPos({ x: 0, y: 0 });
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state()) close();
  });
}

/** Zoom so the image-space point under (px, py) — relative to the viewport
 *  center — stays fixed, moving from `s0`/`p0` to `s1`. */
function zoomAnchored(px: number, py: number, cx: number, cy: number, s0: number, p0: { x: number; y: number }, s1: number): { x: number; y: number } {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s1));
  const imgX = (px - cx - p0.x) / s0;
  const imgY = (py - cy - p0.y) / s0;
  if (clamped === MIN_SCALE) return { x: 0, y: 0 };
  return { x: px - cx - imgX * clamped, y: py - cy - imgY * clamped };
}

async function downloadCurrent(): Promise<void> {
  const s = state();
  if (!s) return;
  try {
    const resp = await fetch(s.url);
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = s.name || 'image';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    // Best-effort fallback — opens the raw URL so the user can still save it
    // manually (e.g. via the webview's context menu).
    window.open(s.url, '_blank', 'noopener,noreferrer');
  }
}

/** Fullscreen image lightbox overlay. */
export const ImageLightbox: Component = () => {
  let containerRef: HTMLDivElement | undefined;
  // Active pointers by id, for 1-finger pan / 2-finger pinch. This state
  // lives in the component's closure, which is mounted once for the app's
  // whole session (see App.tsx) — so it must be reset on every close, not
  // just on unmount, or a lightbox dismissed mid-touch (e.g. Escape key
  // while 2 fingers are still down) leaves stale pointer entries that
  // corrupt the next session's gesture-mode detection.
  const pointers = new Map<number, { x: number; y: number }>();
  let dragStart: { x: number; y: number; pos: { x: number; y: number } } | null = null;
  let pinchStart: { dist: number; scale: number; mid: { x: number; y: number } } | null = null;

  createEffect(() => {
    if (!state()) {
      pointers.clear();
      dragStart = null;
      pinchStart = null;
    }
  });

  const center = (): { x: number; y: number } => {
    const r = containerRef?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const c = center();
    const s0 = scale();
    const delta = -e.deltaY * 0.0015;
    const s1 = s0 * (1 + delta);
    const p1 = zoomAnchored(e.clientX, e.clientY, c.x, c.y, s0, pos(), s1);
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s1)));
    setPos(p1);
  };

  const onDblClick = (e: MouseEvent) => {
    const c = center();
    const s0 = scale();
    if (s0 > MIN_SCALE + 0.01) {
      setScale(MIN_SCALE);
      setPos({ x: 0, y: 0 });
    } else {
      setPos(zoomAnchored(e.clientX, e.clientY, c.x, c.y, s0, pos(), DBLCLICK_SCALE));
      setScale(DBLCLICK_SCALE);
    }
  };

  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const onPointerDown = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, pos: pos() };
    } else if (pointers.size === 2) {
      dragStart = null;
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: dist(a, b), scale: scale(), mid: midpoint(a, b) };
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const ratio = dist(a, b) / (pinchStart.dist || 1);
      const c = center();
      const s1 = pinchStart.scale * ratio;
      const mid = midpoint(a, b);
      setPos(zoomAnchored(mid.x, mid.y, c.x, c.y, pinchStart.scale, pos(), s1));
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s1)));
    } else if (pointers.size === 1 && dragStart && scale() > MIN_SCALE) {
      setPos({ x: dragStart.pos.x + (e.clientX - dragStart.x), y: dragStart.pos.y + (e.clientY - dragStart.y) });
    }
  };

  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) {
      dragStart = null;
    } else if (pointers.size === 1) {
      // Lifting one finger out of a pinch — re-seed drag from the remaining
      // pointer so panning continues smoothly instead of going dead until
      // the user fully releases and re-touches.
      const [remaining] = [...pointers.values()];
      dragStart = { x: remaining.x, y: remaining.y, pos: pos() };
    }
  };

  // Zoom-button clicks anchor at the viewport center (no cursor position to anchor to).
  const zoomBy = (factor: number) => {
    const c = center();
    const s0 = scale();
    const s1 = s0 * factor;
    setPos(zoomAnchored(c.x, c.y, c.x, c.y, s0, pos(), s1));
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s1)));
  };

  onCleanup(() => pointers.clear());

  return (
    <Show when={state()}>
      <div
        ref={containerRef}
        class="lightbox-overlay"
        onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <img
          src={state()!.url}
          class="lightbox-image"
          alt={state()!.name || 'Full size'}
          style={{
            transform: `translate(${pos().x}px, ${pos().y}px) scale(${scale()})`,
            cursor: scale() > MIN_SCALE ? 'grab' : 'zoom-in',
            'touch-action': 'none',
          }}
          onClick={(e) => e.stopPropagation()}
          onDblClick={onDblClick}
          draggable={false}
        />
        <div class="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
          <button class="lightbox-btn" title={t('media_zoom_out')} onClick={() => zoomBy(1 / 1.5)}>−</button>
          <button class="lightbox-btn" title={t('media_zoom_in')} onClick={() => zoomBy(1.5)}>+</button>
          <button class="lightbox-btn" title={t('media_download')} onClick={() => void downloadCurrent()}>⬇</button>
          <button class="lightbox-btn" title={t('media_close')} onClick={close}>✕</button>
        </div>
      </div>
      <style>{`
        .lightbox-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.9);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          overflow: hidden;
          touch-action: none;
        }
        .lightbox-image {
          max-width: 90vw;
          max-height: 90vh;
          object-fit: contain;
          user-select: none;
          transition: transform 0.05s linear;
        }
        .lightbox-toolbar {
          position: fixed;
          top: var(--spacing-md, 12px);
          right: var(--spacing-md, 12px);
          display: flex;
          gap: var(--spacing-xs, 6px);
        }
        .lightbox-btn {
          width: 40px;
          height: 40px;
          border-radius: var(--radius-md, 8px);
          background: rgba(255, 255, 255, 0.15);
          color: #fff;
          font-size: 18px;
          line-height: 1;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .lightbox-btn:hover { background: rgba(255, 255, 255, 0.3); }
      `}</style>
    </Show>
  );
};
