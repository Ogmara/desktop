/**
 * Token price feed — combines two public, keyless sources:
 *
 *   1. bitcoin.me (formerly Klever DEX) — per-KDA USD prices, 24h change.
 *      `GET https://api.bitcoin.me/tokens` returns one entry per KDA with
 *      `tokenInID` (e.g. "KLV", "KFI", "SAME-3LRL"), `price` (USD, decimal
 *      string with high precision) and `variationPercent` (24h move).
 *
 *   2. CoinGecko — USD → other-currency conversion rates only.
 *      `GET /api/v3/simple/price?ids=tether&vs_currencies=...` is hit
 *      against a USD-pegged stablecoin, so the returned ratios act as a
 *      USD/fiat forex table without us needing an API key.
 *
 * Caches:
 *   - bitcoin.me prices: in-memory + localStorage, 5 min TTL.
 *   - CoinGecko forex:   in-memory + localStorage, 60 min TTL (fiat
 *     rates change slowly).
 *
 * Why not embed an API key for a premium tier: Tauri installers can be
 * unpacked and string-searched, so anything we ship to clients is public.
 * If we ever need higher rate limits we should proxy through a server.
 *
 * Network-down behaviour: callers receive `null` if no data can be served
 * even from cache. Stale cache (older than TTL but still parseable) is
 * preferred over `null` when the live fetch fails.
 */

import { readResponseJsonCapped } from './sanitize';

const BITCOIN_ME_URL = 'https://api.bitcoin.me/tokens';
const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd,eur,brl,gbp,jpy,cny';

const PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const FOREX_CACHE_TTL_MS = 60 * 60 * 1000; // 60 min
const STALE_GRACE_MS = 24 * 60 * 60 * 1000; // serve stale up to 24h on failure

const PRICE_STORAGE_KEY = 'ogmara.bitcoin_me.tokens';
const FOREX_STORAGE_KEY = 'ogmara.forex.rates';

// Response-size cap for the price feed. Today's payload is ~350 KB
// (every KDA on the chain) so 2 MB gives plenty of headroom while
// still bounding the renderer's memory in the event of a hostile
// or proxy-tampered response.
const MAX_PRICE_RESPONSE_BYTES = 2_000_000;
// Cap on entries persisted to localStorage so an attacker who somehow
// inflates the asset list (e.g. by registering many tokens) cannot
// exhaust the per-origin quota (~5–10 MB) and silently corrupt
// unrelated `ogmara.*` keys (settings, push state, etc.).
const MAX_CACHED_ASSETS = 5000;

const FETCH_TIMEOUT = 10_000;

/** Per-asset price data from bitcoin.me, USD-quoted. */
export interface TokenPrice {
  /** Asset ID — same format as Klever balance API (e.g. "KLV", "FLIPPY-3FQ0"). */
  assetId: string;
  /** Spot price in USD. May be very small for low-cap tokens — keep full precision. */
  usd: number;
  /** 24h change, percent. Positive = up. */
  change24h: number;
}

/** Forex rates: USD → other currency. Always includes `usd: 1`. */
export type ForexRates = Record<string, number>;

/** Supported display currencies (subset of CoinGecko `vs_currencies`). */
export const SUPPORTED_CURRENCIES = ['usd', 'eur', 'brl', 'gbp', 'jpy', 'cny'] as const;
export type Currency = typeof SUPPORTED_CURRENCIES[number];

/** Fractional digits for currency display. Most are 2; JPY has none. */
const CURRENCY_FRACTION_DIGITS: Record<string, number> = {
  usd: 2,
  eur: 2,
  brl: 2,
  gbp: 2,
  jpy: 0,
  cny: 2,
};

interface CachedPrices {
  ts: number;
  byAsset: Record<string, TokenPrice>;
}

interface CachedForex {
  ts: number;
  rates: ForexRates;
}

// --- In-memory caches (avoid re-reading localStorage on every render) ---

let memPrices: CachedPrices | null = null;
let memForex: CachedForex | null = null;
let pricesInFlight: Promise<CachedPrices | null> | null = null;
let forexInFlight: Promise<CachedForex | null> | null = null;

function nowMs(): number {
  return Date.now();
}

function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function readStorage<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or disabled — caller falls back to in-memory cache.
  }
}

// --- bitcoin.me prices ---

async function fetchPricesNetwork(): Promise<CachedPrices> {
  const resp = await fetchWithTimeout(BITCOIN_ME_URL);
  if (!resp.ok) {
    throw new Error(`bitcoin.me HTTP ${resp.status}`);
  }
  // Bounded read — defends against a multi-GB stream from a hijacked
  // DNS / hostile proxy that would otherwise OOM the renderer.
  const arr = await readResponseJsonCapped<unknown[]>(resp, MAX_PRICE_RESPONSE_BYTES);
  if (!Array.isArray(arr)) {
    throw new Error('bitcoin.me did not return an array');
  }
  const byAsset: Record<string, TokenPrice> = {};
  let count = 0;
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const obj = t as Record<string, unknown>;
    const assetId = typeof obj.tokenInID === 'string' ? obj.tokenInID : '';
    if (!assetId) continue;
    // `price` is a high-precision decimal string. parseFloat is good enough
    // for display — we don't multiply by atomic units, we multiply by the
    // already-divided balance.
    const usd = typeof obj.price === 'string' ? parseFloat(obj.price) : Number(obj.price);
    if (!Number.isFinite(usd)) continue;
    const change24h = typeof obj.variationPercent === 'number' ? obj.variationPercent : 0;
    byAsset[assetId] = { assetId, usd, change24h };
    if (++count >= MAX_CACHED_ASSETS) break;
  }
  const fresh: CachedPrices = { ts: nowMs(), byAsset };
  memPrices = fresh;
  writeStorage(PRICE_STORAGE_KEY, fresh);
  return fresh;
}

/**
 * Load token prices, using cache when fresh. Concurrent calls share one
 * in-flight network request. Falls back to stale cache (< 24h) when the
 * live fetch fails, returning `null` only when nothing is available.
 */
export async function loadPrices(force = false): Promise<CachedPrices | null> {
  if (!memPrices) {
    memPrices = readStorage<CachedPrices>(PRICE_STORAGE_KEY);
  }
  if (!force && memPrices && nowMs() - memPrices.ts < PRICE_CACHE_TTL_MS) {
    return memPrices;
  }
  if (pricesInFlight) return pricesInFlight;
  pricesInFlight = (async () => {
    try {
      return await fetchPricesNetwork();
    } catch (e) {
      // Log once per session so devtools shows the real error if prices
      // never render. Without this, silent fallback hides root causes
      // like Cloudflare blocking or DNS failure.
      console.warn('[prices] bitcoin.me fetch failed:', e);
      if (memPrices && nowMs() - memPrices.ts < STALE_GRACE_MS) {
        return memPrices;
      }
      return null;
    } finally {
      pricesInFlight = null;
    }
  })();
  return pricesInFlight;
}

// --- CoinGecko forex (USD → other) ---

async function fetchForexNetwork(): Promise<CachedForex> {
  const resp = await fetchWithTimeout(COINGECKO_URL);
  if (!resp.ok) {
    throw new Error(`CoinGecko HTTP ${resp.status}`);
  }
  // CoinGecko's `simple/price` for a single coin is a few hundred bytes;
  // even with all supported currencies the response is well under 4 KB.
  // We still cap defensively at 64 KB.
  const json = await readResponseJsonCapped<{ tether?: Record<string, number> }>(
    resp,
    64 * 1024,
  );
  const tether = json?.tether;
  if (!tether || typeof tether !== 'object') {
    throw new Error('CoinGecko response missing tether prices');
  }
  // tether is a USD-pegged stablecoin → tether-in-X ≈ USD-in-X.
  // Always set usd: 1 (anchor); divide-by-zero guarded below.
  const rates: ForexRates = { usd: 1 };
  for (const code of SUPPORTED_CURRENCIES) {
    if (code === 'usd') continue;
    const v = tether[code];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      rates[code] = v;
    }
  }
  const fresh: CachedForex = { ts: nowMs(), rates };
  memForex = fresh;
  writeStorage(FOREX_STORAGE_KEY, fresh);
  return fresh;
}

/**
 * Load forex rates with the same staleness rules as prices. Always returns
 * at least `{usd: 1}` when the call succeeds; on full failure with no
 * cache, returns `null`.
 */
export async function loadForex(force = false): Promise<CachedForex | null> {
  if (!memForex) {
    memForex = readStorage<CachedForex>(FOREX_STORAGE_KEY);
  }
  if (!force && memForex && nowMs() - memForex.ts < FOREX_CACHE_TTL_MS) {
    return memForex;
  }
  if (forexInFlight) return forexInFlight;
  forexInFlight = (async () => {
    try {
      return await fetchForexNetwork();
    } catch (e) {
      console.warn('[prices] CoinGecko forex fetch failed:', e);
      if (memForex && nowMs() - memForex.ts < STALE_GRACE_MS) {
        return memForex;
      }
      return null;
    } finally {
      forexInFlight = null;
    }
  })();
  return forexInFlight;
}

// --- Fiat conversion helpers ---

/**
 * Compute fiat value for an atomic balance.
 *
 * @param atomic     - Balance in atomic units (integer)
 * @param precision  - Token precision (number of decimals)
 * @param usdPrice   - USD spot price of one whole token
 * @param fiatRate   - USD → target ratio (1 for USD, e.g. 0.92 for EUR)
 * @returns          - Fiat value as a number (use formatFiat for display)
 */
export function computeFiatValue(
  atomic: number,
  precision: number,
  usdPrice: number,
  fiatRate: number,
): number {
  if (!Number.isFinite(atomic) || !Number.isFinite(usdPrice) || !Number.isFinite(fiatRate)) {
    return 0;
  }
  if (usdPrice <= 0 || fiatRate <= 0) return 0;
  // For display purposes Number-level precision is fine (we're showing
  // 2 decimals of fiat). The blockchain balances themselves stay integer.
  const whole = precision === 0 ? atomic : atomic / Math.pow(10, precision);
  return whole * usdPrice * fiatRate;
}

/**
 * Format a fiat amount for the given currency, using the browser's
 * Intl support for locale-aware grouping and symbols.
 */
export function formatFiat(value: number, currency: string, locale?: string): string {
  if (!Number.isFinite(value)) value = 0;
  const code = (currency || 'usd').toUpperCase();
  const fracDigits = CURRENCY_FRACTION_DIGITS[currency.toLowerCase()] ?? 2;
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: fracDigits,
      maximumFractionDigits: fracDigits,
    }).format(value);
  } catch {
    return `${value.toFixed(fracDigits)} ${code}`;
  }
}

