/**
 * Links to the Ogmara Klever block explorer (kleverchain.org).
 *
 * The explorer auto-detects whether a transaction, account, or asset lives on
 * mainnet or testnet — if a hash isn't found on mainnet it falls back to
 * testnet and shows the result there. A single base URL therefore works for
 * every network, so no testnet subdomain or `network` query parameter is
 * needed (unlike the old Kleverscan links).
 */

/** Default Ogmara explorer base URL. */
export const EXPLORER_BASE_URL = 'https://kleverchain.org';

export interface ExplorerLinks {
  /** Account/wallet page for a bech32 address (`klv1…`). */
  wallet(address: string): string;
  /** Transaction page for a 64-char hex tx hash. */
  tx(hash: string): string;
  /** Asset (KDA) page for an asset id, e.g. `"KLV"`. */
  asset(assetId: string): string;
}

/**
 * Build a set of explorer link helpers for the given base URL.
 *
 * @example
 * const ex = explorer();
 * ex.wallet('klv1…'); // https://kleverchain.org/wallet?address=klv1…
 * ex.tx('<64-hex>');  // https://kleverchain.org/transactions?hash=…
 * ex.asset('KLV');    // https://kleverchain.org/assets?asset=KLV
 */
export function explorer(baseUrl: string = EXPLORER_BASE_URL): ExplorerLinks {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    wallet: (address: string) => `${base}/wallet?address=${encodeURIComponent(address)}`,
    tx: (hash: string) => `${base}/transactions?hash=${encodeURIComponent(hash)}`,
    asset: (assetId: string) => `${base}/assets?asset=${encodeURIComponent(assetId)}`,
  };
}

/** Shared explorer link helper bound to the default base URL. */
export const ex: ExplorerLinks = explorer();
