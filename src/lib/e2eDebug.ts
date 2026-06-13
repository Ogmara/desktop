/**
 * E2E DM debugging helpers — structured logging + a 429-aware retry wrapper.
 *
 * Logging is OFF by default; enable in the browser console with
 *   localStorage['ogmara.e2eDebug'] = '1'
 * and reload. Then key-lifecycle steps (binding check, wrap targets, key fetch,
 * decrypt outcome) print as `[e2e]` lines. The full one-shot self-check is
 * `window.__ogmaraE2E('<peer klv1…>')` (see `dmCrypto.ts`).
 */

let cached: boolean | null = null;

/** Whether `[e2e]` debug logging is enabled (localStorage flag, cached). */
export function e2eDebugOn(): boolean {
  if (cached === null) {
    try {
      cached = typeof localStorage !== 'undefined' && localStorage.getItem('ogmara.e2eDebug') === '1';
    } catch {
      cached = false;
    }
  }
  return cached;
}

/** Structured `[e2e]` console log, gated on the debug flag. */
export function e2elog(step: string, data?: Record<string, unknown>): void {
  if (!e2eDebugOn()) return;
  // eslint-disable-next-line no-console
  console.info(`[e2e] ${step}`, data ?? {});
}

/** True if an error looks like an HTTP 429 / rate-limit rejection. */
export function isRateLimit(e: unknown): boolean {
  const msg = (e as { message?: string })?.message || String(e);
  return msg.includes('429') || /too many requests/i.test(msg);
}

/**
 * Run `fn`, retrying ONLY on 429 with linear backoff (default 3 tries:
 * ~0.8s, 1.6s). Any non-rate-limit error propagates immediately. Keeps the
 * E2E publish/fetch flow alive when a node briefly rate-limits, without
 * masking real failures.
 */
export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRateLimit(e)) throw e;
      const backoff = 800 * (attempt + 1);
      e2elog(`${label}: 429, retry ${attempt + 1}/${tries} in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}
