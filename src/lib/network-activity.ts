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

  // Defense-in-depth guard against a runaway /api/v1/health loop. A client bug
  // that pings /health in a tight loop can DoS the node and leak memory in the
  // webview. Legit boot makes only a handful of /health calls, so >25/s is
  // always a bug: past that we short-circuit (replay the last good response,
  // no network hit) and warn once. The proper protection is the node-side
  // per-IP limit; this just keeps a buggy client from taking a node down.
  const now = () => { try { return performance.now(); } catch { return 0; } };
  const HEALTH_FLOOD_PER_SEC = 25;
  const healthTimes: number[] = [];          // sliding 1s window of /health starts
  let lastHealthBody: string | null = null;  // replayed while the guard is engaged
  let floodWarnedAt = 0;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const isTracked = url.includes('/api/v1/');
    const isHealth = isTracked && url.includes('/api/v1/health');

    if (isHealth) {
      const tnow = now();
      healthTimes.push(tnow);
      while (healthTimes.length && tnow - healthTimes[0] > 1000) healthTimes.shift();
      if (healthTimes.length > HEALTH_FLOOD_PER_SEC) {
        if (tnow - floodWarnedAt > 10000) {
          floodWarnedAt = tnow;
          // eslint-disable-next-line no-console
          console.warn(`[net] /api/v1/health rate guard engaged (${healthTimes.length}/s) — short-circuiting to protect the node`);
        }
        return new Response(
          lastHealthBody ?? '{"status":"ok","throttled":true}',
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
    }

    if (isTracked) {
      setPendingRequests((n) => n + 1);
      refreshSlowTimer();
    }

    try {
      const resp = await originalFetch(input, init);
      // Cache the last good /health body so the guard can replay it if it trips.
      if (isHealth && resp.ok) {
        resp.clone().text().then((b) => { lastHealthBody = b; }).catch(() => {});
      }
      return resp;
    } finally {
      if (isTracked) {
        setPendingRequests((n) => Math.max(0, n - 1));
        refreshSlowTimer();
      }
    }
  };
}
