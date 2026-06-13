/**
 * E2E DM trace recorder — a persistent, always-on, in-memory ring buffer of every
 * step in the DM-encryption flow (binding, establish, wrap, publish, fetch,
 * unwrap, decode, decrypt). Designed for debugging WITHOUT scrolling a console
 * that's flooded by the Klever extension's chatter.
 *
 * Console helpers (available in dev AND prod — they print/return public metadata
 * only, never secrets):
 *   __ogmaraE2ETrace()        → console.table of the whole trace + returns the array
 *   __ogmaraE2ETraceSave()    → downloads the full trace as a JSON file (cleanest)
 *   __ogmaraE2ETraceClear()   → reset the buffer (call before reproducing a step)
 *
 * Recording is ALWAYS on (cheap, capped). The `ogmara.e2eDebug` localStorage flag
 * only controls whether steps ALSO mirror to the console live.
 */

export interface TraceEvent {
  /** epoch ms */
  t: number;
  /** monotonic sequence within this session */
  seq: number;
  step: string;
  data?: Record<string, unknown>;
}

const TRACE_MAX = 2000;
const traceBuf: TraceEvent[] = [];
let seq = 0;

let consoleCached: boolean | null = null;
/** Whether to ALSO mirror steps to the console live (localStorage flag). */
export function e2eDebugOn(): boolean {
  if (consoleCached === null) {
    try {
      consoleCached = typeof localStorage !== 'undefined' && localStorage.getItem('ogmara.e2eDebug') === '1';
    } catch {
      consoleCached = false;
    }
  }
  return consoleCached;
}

/** Record one step into the always-on trace buffer (+ console if the flag is on). */
export function e2elog(step: string, data?: Record<string, unknown>): void {
  const ev: TraceEvent = { t: Date.now(), seq: seq++, step, data };
  traceBuf.push(ev);
  if (traceBuf.length > TRACE_MAX) traceBuf.splice(0, traceBuf.length - TRACE_MAX);
  if (e2eDebugOn()) {
    // eslint-disable-next-line no-console
    console.info(`[e2e] ${step}`, data ?? {});
  }
}

/** The full trace, oldest→newest (a copy). */
export function getE2ETrace(): TraceEvent[] {
  return traceBuf.slice();
}

/** Clear the buffer — call right before reproducing the step you want to capture. */
export function clearE2ETrace(): void {
  traceBuf.length = 0;
  seq = 0;
}

function hhmmss(t: number): string {
  try {
    return new Date(t).toISOString().slice(11, 23); // HH:MM:SS.mmm (UTC)
  } catch {
    return String(t);
  }
}

if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;
  w.__ogmaraE2ETrace = () => {
    const rows = traceBuf.map((e) => ({
      time: hhmmss(e.t), seq: e.seq, step: e.step,
      info: e.data ? JSON.stringify(e.data) : '',
    }));
    // eslint-disable-next-line no-console
    console.table(rows);
    return traceBuf.slice();
  };
  w.__ogmaraE2ETraceSave = () => {
    try {
      const blob = new Blob([JSON.stringify(traceBuf, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ogmara-e2e-trace-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return `saved ${traceBuf.length} events`;
    } catch (e) {
      return `save failed: ${(e as Error)?.message}`;
    }
  };
  w.__ogmaraE2ETraceClear = () => {
    clearE2ETrace();
    return 'cleared';
  };
}

/** True if an error looks like an HTTP 429 / rate-limit rejection. */
export function isRateLimit(e: unknown): boolean {
  const msg = (e as { message?: string })?.message || String(e);
  return msg.includes('429') || /too many requests/i.test(msg);
}

/**
 * Run `fn`, retrying ONLY on 429 with linear backoff (default 3 tries:
 * ~0.8s, 1.6s). Any non-rate-limit error propagates immediately.
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
