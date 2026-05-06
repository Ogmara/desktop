/**
 * Network activity tracker — monkey-patches window.fetch to count
 * in-flight requests. Components can read the `pendingRequests` signal
 * (or `isLoading` derivation) to render a loading indicator.
 *
 * The patch is installed once via `installNetworkActivityTracker()` from
 * index.tsx. It only tracks requests to our own L2 node (URLs that
 * include `/api/v1/`) so unrelated fetches (favicon, manifest, etc.)
 * don't trigger the indicator.
 */

import { createSignal } from 'solid-js';

const [pendingRequests, setPendingRequests] = createSignal(0);
export { pendingRequests };

/** True when at least one tracked request is in flight. */
export const isLoading = () => pendingRequests() > 0;

/**
 * True when at least one tracked request has been pending for longer than
 * `slowThresholdMs`. Use this to show a stronger "still working..." hint
 * when the L2 node is unresponsive.
 */
const [slowLoading, setSlowLoading] = createSignal(false);
export { slowLoading };

const SLOW_THRESHOLD_MS = 1500;

let installed = false;

/** Install the global fetch wrapper. Idempotent. */
export function installNetworkActivityTracker(): void {
  if (installed || typeof window === 'undefined' || !window.fetch) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  const refreshSlowTimer = () => {
    if (slowTimer) {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
    if (pendingRequests() > 0) {
      slowTimer = setTimeout(() => {
        if (pendingRequests() > 0) setSlowLoading(true);
      }, SLOW_THRESHOLD_MS);
    } else {
      setSlowLoading(false);
    }
  };

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const isTracked = url.includes('/api/v1/');

    if (isTracked) {
      setPendingRequests((n) => n + 1);
      refreshSlowTimer();
    }

    try {
      const resp = await originalFetch(input, init);
      return resp;
    } finally {
      if (isTracked) {
        setPendingRequests((n) => Math.max(0, n - 1));
        refreshSlowTimer();
      }
    }
  };
}
