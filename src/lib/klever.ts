/**
 * Standalone Klever blockchain integration — desktop replacement for
 * the web app's browser extension bridge.
 *
 * Builds, signs, and broadcasts Klever transactions directly using
 * the vault's WalletSigner. No browser extension or K5 wallet needed.
 *
 * On-chain operations: user registration, channel creation, tipping,
 * device delegation, governance voting.
 */

import { vaultGetSigner } from './vault';
import { t } from '../i18n/init';
import { requireTxConfirmation } from './txConfirm';
import { stripBidi } from './sanitize';
import { getSetting, setSetting } from './settings';

// Bundled logos for native Klever tokens. The Klever asset-details API's
// logo URL for KLV currently points to a host that no longer serves the
// image, and KFI has no logo in the API response at all. Shipping these
// two PNGs (~17KB total) inside the desktop bundle removes the runtime
// dependency on external image hosts and keeps the wallet usable offline.
import klvLogoUrl from '../assets/tokens/klv.png';
import kfiLogoUrl from '../assets/tokens/kfi.png';

/**
 * Bundled logo overrides for native tokens whose API-provided logos are
 * unreliable. Other KDAs fall through to whatever `getTokenMetadata`
 * returns from the Klever asset API.
 */
const BUNDLED_TOKEN_LOGOS: Record<string, string> = {
  KLV: klvLogoUrl,
  KFI: kfiLogoUrl,
};

/**
 * Desktop always has standalone signing capability.
 * These signals exist for API compatibility with web components
 * that check kleverAvailable() before enabling on-chain operations.
 */
export const kleverAvailable = () => true;
export const kleverAddress = () => vaultGetSigner()?.address ?? null;
export const kleverConnecting = () => false;

// --- Network Configuration ---

// Initialize from the last-known network (persisted) so cold-boot SC node
// discovery targets the right registry BEFORE we've reached any node to read
// its `networkStats.network`. Defaults to mainnet (the production registry).
let currentNetwork = getSetting('kleverNetwork') === 'testnet' ? 'testnet' : 'mainnet';
let kleverProvider = currentNetwork === 'testnet'
  ? { api: 'https://api.testnet.klever.org', node: 'https://node.testnet.klever.org' }
  : { api: 'https://api.mainnet.klever.org', node: 'https://node.mainnet.klever.org' };

/**
 * The canonical Ogmara KApp address per network, PINNED in the client.
 *
 * Never taken on the connected node's word. The node is user-chosen and anyone
 * may run one, so trusting it to name the contract lets a hostile operator
 * point `register` at a contract they control — and that call now carries a
 * real KLV payment, so the fee would go to them with no refund. Before the fee
 * existed the worst case was a failed zero-value call, which is why the node's
 * value was accepted unconditionally until now.
 */
const PINNED_CONTRACTS: Record<string, string> = {
  testnet: 'klv1qqqqqqqqqqqqqpgq0ja2j7xwz843ryfsk9vlz6xzsaak590h6pgq7nwr02',
  mainnet: 'klv1qqqqqqqqqqqqqpgq8c9yag9vuc2pe64fwvqsq9e8ul8w5zuglf5qfgh7z3',
};

/** Ogmara KApp smart contract address (client-pinned per network). */
let scAddress = PINNED_CONTRACTS[currentNetwork] || '';
/** True when `scAddress` is client-pinned rather than node-supplied. */
let scAddressPinned = Boolean(scAddress);


/** Set the Klever network provider URLs (called after fetching node stats). */
export function setKleverNetwork(network: string): void {
  currentNetwork = network;
  // Persist so the NEXT cold boot's SC node discovery targets this network
  // before any node has been reached. Only mainnet/testnet are valid.
  setSetting('kleverNetwork', network === 'testnet' ? 'testnet' : 'mainnet');
  if (network === 'testnet') {
    kleverProvider = {
      api: 'https://api.testnet.klever.org',
      node: 'https://node.testnet.klever.org',
    };
  } else {
    kleverProvider = {
      api: 'https://api.mainnet.klever.org',
      node: 'https://node.mainnet.klever.org',
    };
  }
  // Re-pin for the new network. Startup sets the address BEFORE the network,
  // so without this the client would hold the wrong network's pin.
  repinContractForNetwork();
}

/**
 * Record the contract address the connected node reports.
 *
 * ADVISORY ONLY when a pin exists: a mismatch is refused and the pin kept,
 * because the node does not get to choose where the user's money goes. The
 * node's value is adopted only on an unknown network with no pin, and payable
 * calls are then blocked outright — see `invokeContract`.
 */
export function setContractAddress(address: string): void {
  if (!address || !address.startsWith('klv1') || address.length < 40) return;
  const pin = PINNED_CONTRACTS[currentNetwork];
  if (pin) {
    if (address !== pin) {
      console.warn(
        '[Klever SC] node reported a different contract address than the pinned one; ignoring it.',
        { reported: address, pinned: pin },
      );
    }
    scAddress = pin;
    scAddressPinned = true;
    return;
  }
  scAddress = address;
  scAddressPinned = false;
}

/** Re-resolve the pin after the network changes. */
function repinContractForNetwork(): void {
  const pin = PINNED_CONTRACTS[currentNetwork];
  if (pin) {
    scAddress = pin;
    scAddressPinned = true;
  }
}

/** Default fetch timeout (15 seconds). */
const FETCH_TIMEOUT = 15_000;

/** Fetch with timeout via AbortSignal. */
function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Tx rate-limit + in-flight lock.
//
// The cooldown is enforced from the moment a *successful* broadcast
// completes — not from the moment a user clicks Send. Previously
// `lastTxTime` was set on entry, which meant the PIN-confirm modal
// time counted against the user (every retry after cancel reset the
// clock incorrectly). Setting it only after broadcast also defends
// against a quick double-click race: the in-flight flag rejects the
// second call before either has updated the timestamp.
const TX_MIN_INTERVAL_MS = 2000;
let lastTxBroadcastAt = 0;
let txInFlight = false;

function acquireTxSlot(): void {
  if (txInFlight) {
    throw new Error('A transaction is already in progress');
  }
  const now = Date.now();
  if (now - lastTxBroadcastAt < TX_MIN_INTERVAL_MS) {
    throw new Error('Please wait a moment before sending another transaction');
  }
  txInFlight = true;
}

function releaseTxSlot(success: boolean): void {
  if (success) lastTxBroadcastAt = Date.now();
  txInFlight = false;
}

// --- Helpers ---

function stringToHex(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function numberToHex(n: number): string {
  if (n === 0) return '00';
  const hex = n.toString(16);
  return hex.length % 2 === 0 ? hex : '0' + hex;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Decode a klv1... bech32 address to its 32-byte public key as hex. */
export function addressToPubkeyHex(address: string): string {
  // Verifies the bech32 CHECKSUM and the 32-byte length, not just the charset.
  // This decodes a node-supplied `operator_address` straight into calldata, so
  // a malformed value would otherwise be appended as a wrong-length argument
  // and revert the invoke on-chain — burning the user's network fee on every
  // attempt with nothing pointing at the node as the cause.
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const lower = address.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1) throw new Error('Invalid address: no separator');
  const hrp = lower.slice(0, sep);
  const dataPart = lower.slice(sep + 1);
  const values: number[] = [];
  for (const ch of dataPart) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) throw new Error('Invalid address: bad character');
    values.push(v);
  }
  // polymod over hrp-expansion + data (checksum included)
  const expanded: number[] = [];
  for (const c of hrp) expanded.push(c.charCodeAt(0) >> 5);
  expanded.push(0);
  for (const c of hrp) expanded.push(c.charCodeAt(0) & 31);
  let chk = 1;
  for (const v of expanded.concat(values)) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  if (chk !== 1) throw new Error('Invalid address: bad checksum');

  // Drop the 6-symbol checksum, then regroup 5-bit values into bytes.
  const payload = values.slice(0, -6);
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of payload) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (out.length !== 32) throw new Error('Invalid address: expected 32 bytes');
  return out.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Get "KLV" or "testnet KLV" depending on current network. */
function klvLabel(): string {
  return currentNetwork === 'testnet' ? 'testnet KLV' : 'KLV';
}

/** Abbreviate a klv1 address for display, e.g. "klv1abc…xyz". bech32
 *  charset is lowercase ASCII alphanumeric so no bidi sanitization
 *  is needed here — but we still pass it through stripBidi defensively
 *  at the summary boundary in case a caller passes a non-bech32 string. */
function abbrevAddress(addr: string): string {
  if (!addr || addr.length < 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

/** Format atomic units to a decimal string for tx-summary display, with
 *  locale-aware thousands separators on the integer part. Uses BigInt
 *  for the locale formatting so token amounts past 2^53 atomic units
 *  (high-precision assets at large balances) don't silently lose
 *  digits during display. */
function atomicToDisplay(atomic: number, precision: number): string {
  const intToLocale = (s: string) => {
    try { return BigInt(s).toLocaleString(); }
    catch { return s; }
  };
  if (precision === 0) return intToLocale(String(Math.trunc(atomic)));
  const str = String(Math.trunc(atomic)).padStart(precision + 1, '0');
  const intPart = str.slice(0, str.length - precision);
  const fracPart = str.slice(str.length - precision).replace(/0+$/, '');
  return fracPart ? `${intToLocale(intPart)}.${fracPart}` : intToLocale(intPart);
}

/** Parse Klever node error responses into user-friendly messages. */
function parseKleverError(rawText: string, status: number): string {
  const lower = rawText.toLowerCase();
  const klv = klvLabel();

  // Insufficient balance
  if (lower.includes('insufficient') || lower.includes('balance') || lower.includes('not enough')) {
    return t('tx_error_insufficient', { klv });
  }
  // Account doesn't exist on-chain (nil address / GetExistingAccount / 404)
  if (lower.includes('nil address') || lower.includes('getexistingaccount') || lower.includes('existing account')
      || status === 404 || lower.includes('not found') || lower.includes('account not found')) {
    return t('tx_error_no_account', { klv });
  }
  // Nonce errors
  if (lower.includes('nonce')) {
    return t('tx_error_nonce');
  }
  // Signature errors
  if (lower.includes('signature') || lower.includes('invalid sig')) {
    return t('tx_error_signature');
  }
  // Contract errors
  if (lower.includes('contract') || lower.includes('execution')) {
    try {
      const parsed = JSON.parse(rawText);
      const detail = parsed?.error || parsed?.data?.error || parsed?.message;
      if (detail) return `${t('tx_error_contract')}: ${detail}`;
    } catch { /* not JSON */ }
    return `${t('tx_error_failed')}: ${rawText.slice(0, 200)}`;
  }
  // Generic fallback
  if (rawText.length > 0) {
    try {
      const parsed = JSON.parse(rawText);
      const msg = parsed?.error || parsed?.data?.error || parsed?.message;
      if (msg) return msg;
    } catch { /* not JSON */ }
    return rawText.slice(0, 300);
  }
  return `${t('tx_error_failed')} (HTTP ${status})`;
}

// --- Standalone Transaction Building ---

/**
 * Get the wallet signer or throw if unavailable.
 * Desktop always uses the built-in vault signer.
 */
function requireSigner() {
  const signer = vaultGetSigner();
  if (!signer) throw new Error('Wallet not available — unlock your vault first');
  return signer;
}

/**
 * Build, sign, and broadcast a transaction via the Klever node API.
 *
 * Flow:
 * 1. POST contract payload to /transaction/send → get unsigned TX
 * 2. Hash the raw TX with Keccak-256
 * 3. Ed25519 sign the hash with the wallet's private key
 * 4. POST signed TX to /transaction/broadcast
 *
 * @param contracts - Array of contract objects (type + payload)
 * @param data - Optional TX data array (base64-encoded strings)
 * @returns Transaction hash
 */
async function buildSignBroadcast(
  contracts: Array<{ type: number; payload: Record<string, unknown> }>,
  data?: string[],
  summary?: string,
): Promise<string> {
  acquireTxSlot();
  let success = false;
  try {
    // PIN re-prompt when app-lock is enabled. No-op when no PIN is set.
    // The broker throws TxConfirmationCancelled if the user dismisses;
    // we let it propagate up so callers can surface a localized message.
    await requireTxConfirmation(summary || t('tx_confirm_generic'));
    const result = await broadcastImpl(contracts, data);
    success = true;
    return result;
  } finally {
    releaseTxSlot(success);
  }
}

async function broadcastImpl(
  contracts: Array<{ type: number; payload: Record<string, unknown> }>,
  data?: string[],
): Promise<string> {
  const signer = requireSigner();
  const nodeBase = kleverProvider.node;

  // Step 1: Get unsigned TX from the node
  // Klever SDK format: contracts are flat objects with contractType merged in
  const kleverContracts = contracts.map((c) => ({
    ...c.payload,
    contractType: c.type,
  }));
  const senderAddr = signer.walletAddress || signer.address;
  const usedNonce = await getAccountNonce(senderAddr);
  const sendBody: Record<string, unknown> = {
    type: contracts[0].type,
    sender: senderAddr,
    nonce: usedNonce,
    contracts: kleverContracts,
  };
  if (data && data.length > 0) {
    sendBody.data = data;
  }

  const sendResp = await fetchWithTimeout(`${nodeBase}/transaction/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sendBody),
  });
  const sendText = await sendResp.text().catch(() => '');
  let sendData: any;
  try { sendData = JSON.parse(sendText); } catch { sendData = null; }

  // The Klever node may return both data.result AND error in the same 200 response.
  // If we have a result with RawData, proceed despite the error field.
  const rawTx = sendData?.data?.result;
  if (!rawTx?.RawData && !rawTx?.rawData) {
    // No usable result — throw the error
    if (!sendResp.ok || sendData?.error) {
      throw new Error(parseKleverError(sendText, sendResp.status));
    }
    throw new Error('Node did not return a transaction to sign');
  }

  // Step 2: Get the TX hash via /transaction/decode
  // The /transaction/send response may have an empty txHash. The Klever SDK
  // uses /transaction/decode to extract the canonical hash for signing.
  let txHash = sendData?.data?.txHash || '';
  if (!txHash) {
    const decodeResp = await fetchWithTimeout(`${nodeBase}/transaction/decode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rawTx),
    });
    if (decodeResp.ok) {
      const decodeData = await decodeResp.json();
      txHash = decodeData?.data?.tx?.hash || '';
    }
  }
  if (!txHash) {
    throw new Error('Could not obtain TX hash for signing');
  }

  // Step 3: Sign the TX hash with raw Ed25519.
  // Try signing the hex-decoded raw bytes (32 bytes), not the UTF-8 string (64 bytes).
  // The node verifies against BLAKE2b(protobuf(RawData)) which is 32 raw bytes.
  const hashRawBytes = hexToBytes(txHash);
  const sigBytes = await signer.signRawHash(hashRawBytes);
  const sigBase64 = btoa(String.fromCharCode(...sigBytes));

  // Step 4: Attach signature and broadcast (PascalCase to match Klever TX format)
  rawTx.Signature = [sigBase64];

  const broadcastBody = { tx: rawTx };

  const broadcastResp = await fetchWithTimeout(`${nodeBase}/transaction/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(broadcastBody),
  });
  const broadcastText = await broadcastResp.text().catch(() => '');
  let broadcastData: any;
  try { broadcastData = JSON.parse(broadcastText); } catch { broadcastData = {}; }

  if (!broadcastResp.ok || broadcastData?.error) {
    throw new Error(parseKleverError(broadcastText, broadcastResp.status));
  }
  const broadcastHash = broadcastData?.data?.txsHashes?.[0]
    || broadcastData?.data?.txHash
    || txHash;

  // Track the nonce we used so consecutive TXs don't collide
  recordUsedNonce(senderAddr, usedNonce);

  return broadcastHash;
}

/**
 * Track the last nonce we used locally so rapid-fire TXs don't collide.
 * The API returns the last *confirmed* nonce, which may lag behind
 * recently broadcast transactions.
 */
const nonceCache: Record<string, { nonce: number; ts: number }> = {};

/**
 * Get the next nonce for a transaction.
 *
 * The Klever API `Nonce` field is already the next nonce to use (not the
 * last used). However, the API indexes every ~4 seconds, so if we broadcast
 * a TX and immediately try another, the API still returns the old nonce.
 *
 * We track locally submitted nonces to handle this window.
 */
async function getAccountNonce(address: string): Promise<number> {
  const apiBase = kleverProvider.api;
  const resp = await fetchWithTimeout(`${apiBase}/v1.0/address/${address}`);
  // 404 = account doesn't exist on-chain yet (new wallet, no KLV) → nonce is 0
  if (resp.status === 404) return 0;
  if (!resp.ok) {
    throw new Error(`Failed to fetch account nonce (HTTP ${resp.status})`);
  }
  const rawBody = await resp.text();
  let data: any;
  try { data = JSON.parse(rawBody); } catch { data = null; }
  const apiNonce: number = data?.data?.account?.nonce ?? data?.data?.account?.Nonce ?? 0;
  const cached = nonceCache[address];

  // If we recently broadcast a TX, the API may not have indexed it yet.
  // Use whichever is higher: API nonce or our locally tracked next nonce.
  if (cached && cached.ts > Date.now() - 30_000) {
    const localNext = cached.nonce + 1;
    return Math.max(apiNonce, localNext);
  }

  return apiNonce;
}

/** Record that we successfully broadcast a TX with this nonce. */
function recordUsedNonce(address: string, nonce: number): void {
  nonceCache[address] = { nonce, ts: Date.now() };
}

// --- Smart Contract Invocations ---

interface ScInvokeParams {
  functionName: string;
  args: string[];
  /** KLV amount to send in atomic units (1 KLV = 1_000_000). */
  value?: number;
  /** Optional human-readable summary for the PIN-confirm modal. */
  summary?: string;
}

/**
 * Build, sign, and broadcast a smart contract invocation.
 * Returns the transaction hash.
 */
async function invokeContract(params: ScInvokeParams): Promise<string> {
  if (!scAddress) {
    throw new Error('Smart contract address not configured');
  }
  // Never send money to a contract address the client did not pin. Reaching
  // here unpinned means the node named the contract, and a hostile node would
  // simply name its own.
  if (params.value && !scAddressPinned) {
    throw new Error(
      'Refusing to send a payment to a contract address supplied by the node. ' +
        'No pinned Ogmara contract is configured for this network.',
    );
  }

  // Encode function call: "functionName@hexArg1@hexArg2..." then base64
  const callData = [params.functionName, ...params.args].join('@');

  const payload: Record<string, unknown> = {
    scType: 0, // InvokeContract
    address: scAddress,
    // MUST be a JSON number. The Klever node refuses a string at JSON decode
    // ("cannot unmarshal string into Go struct field
    // SmartContractRequest.callValue of type int64") — verified against live
    // testnet on BOTH the extension and direct-RPC signing paths. An empty
    // `{}` is correct when no value is attached, which is why this went
    // unnoticed: no payable SC call had ever shipped.
    callValue: params.value ? { KLV: params.value } : {},
  };

  // Strip bidi/control chars from any caller-supplied summary in case
  // a future call site interpolates user input. The functionName here
  // is internal (registerUser / createChannel / etc.) so safe today.
  const summary = stripBidi(
    params.summary
    || t('tx_confirm_contract_summary', { fn: params.functionName })
  );

  return buildSignBroadcast(
    [{ type: 63, payload }], // 63 = SmartContract
    [btoa(callData)],
    summary,
  );
}

// --- On-Chain Operations ---

/** Options for {@link registerUser}. */
export interface RegisterOptions {
  /**
   * The on-chain registration fee in atomic units, read live from
   * `GET /api/v1/registration/info`. Omit or pass 0 when registration is free.
   * Never hard-code it: the fee is node-governance controlled and changes with
   * no client release.
   */
  feeAtomic?: number;
  /**
   * The node operator's wallet (`operator_address` from the same response),
   * credited a share of the fee for onboarding this user. Omit when the node
   * reports `null`; the contract then routes the whole fee to the treasury.
   */
  viaNode?: string;
}

/**
 * Register ("verify") a wallet on the Ogmara smart contract.
 *
 * Costs the Klever network fee (~4.4 KLV kAppFee + bandwidth) PLUS the
 * on-chain registration fee, if governance has set one.
 *
 * @param publicKeyHex - 64-char hex Ed25519 public key
 */
export async function registerUser(
  publicKeyHex: string,
  opts: RegisterOptions = {},
): Promise<string> {
  const args = [stringToHex(publicKeyHex)];
  // `via_node` is an OptionalValue tail argument, encoded by PRESENCE.
  if (opts.viaNode) args.push(addressToPubkeyHex(opts.viaNode));
  return invokeContract({
    functionName: 'register',
    args,
    value: opts.feeAtomic || undefined,
    // The PIN modal is where the user authorises spending, so it must state
    // the AMOUNT. Without this the summary read "Smart contract call:
    // register" with no figure — and this is the first value-bearing contract
    // invoke the app has ever shipped.
    summary: opts.feeAtomic
      ? t('tx_confirm_register_fee').replace(
          '{{amount}}',
          atomicToDisplay(opts.feeAtomic, 6),
        )
      : undefined,
  });
}

/**
 * Create a channel on the Ogmara smart contract.
 * Cost: ~4.8 KLV.
 * @param slug - Channel slug (lowercase alphanumeric + hyphens)
 * @param channelType - 0 = Public, 1 = ReadPublic
 */
export async function createChannelOnChain(slug: string, channelType: number): Promise<string> {
  return invokeContract({
    functionName: 'createChannel',
    args: [stringToHex(slug), numberToHex(channelType)],
  });
}

/**
 * Wait for a createChannel TX to confirm, then query the SC view function
 * `getChannelBySlug` to retrieve the assigned channel_id.
 */
export async function getChannelIdFromTx(txHash: string, slug: string): Promise<number> {
  const apiBase = kleverProvider.api;
  const nodeBase = kleverProvider.node;
  const maxAttempts = 20;
  const delay = 2000;

  // Step 1: Wait for TX to succeed
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetchWithTimeout(`${apiBase}/v1.0/transaction/${txHash}`);
      if (!resp.ok) { await sleep(delay); continue; }
      const data = await resp.json();
      const tx = data?.data?.transaction;

      if (!tx || !tx.status) { await sleep(delay); continue; }
      if (tx.status === 'fail') {
        throw new Error(tx.resultCode || 'Transaction failed');
      }
      if (tx.status === 'success') break;
      await sleep(delay);
    } catch (e: any) {
      if (e.message?.includes('failed')) throw e;
      await sleep(delay);
    }
  }

  // Step 2: Query SC view function to get channel_id by slug
  const slugHex = Array.from(new TextEncoder().encode(slug))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const vmResp = await fetchWithTimeout(`${nodeBase}/vm/hex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scAddress: scAddress,
      funcName: 'getChannelBySlug',
      args: [slugHex],
    }),
  });

  if (!vmResp.ok) {
    throw new Error('Failed to query SC for channel ID');
  }

  const vmData = await vmResp.json();
  const hexResult = vmData?.data?.data;

  if (!hexResult) {
    throw new Error('Channel not found in SC after creation');
  }

  // Result is a hex-encoded integer (e.g., "03" = 3)
  return parseInt(hexResult, 16);
}

/**
 * Send a KLV tip as a direct transfer to the recipient.
 * Uses type 0 (Transfer).
 * @param recipient - klv1... address of the recipient
 * @param _msgIdHex - unused for now (will be used for SC-based tip attribution)
 * @param _channelId - unused for now
 * @param note - Optional note (encoded as memo)
 * @param amountKlv - Tip amount in KLV
 */
export async function sendTip(
  recipient: string,
  _msgIdHex: string,
  _channelId: number,
  note: string,
  amountKlv: number,
): Promise<string> {
  // Use Math.round to avoid floating point precision issues (e.g., 0.1 * 1e6)
  const amountAtomic = Math.round(amountKlv * 1_000_000);
  const txData = note ? [btoa(note.slice(0, 128))] : undefined;

  const summary = stripBidi(t('tx_confirm_tip_summary', {
    amount: amountKlv,
    klv: klvLabel(),
    to: abbrevAddress(recipient),
  }));

  return buildSignBroadcast(
    [{
      type: 0, // Transfer
      payload: {
        receiver: recipient,
        amount: amountAtomic,
        kda: 'KLV',
      },
    }],
    txData,
    summary,
  );
}

/**
 * Delegate a device key for signing on behalf of the user.
 * Cost: ~4.5 KLV.
 * @param devicePubKeyHex - 64-char hex Ed25519 public key of the device
 * @param permissions - Bitmask: 0x01=messages, 0x02=channels, 0x04=profile
 * @param expiresAt - Unix timestamp (0 = permanent)
 */
export async function delegateDevice(
  devicePubKeyHex: string,
  permissions: number,
  expiresAt: number,
): Promise<string> {
  return invokeContract({
    functionName: 'delegateDevice',
    args: [devicePubKeyHex, numberToHex(permissions), numberToHex(expiresAt)],
  });
}

/**
 * Revoke a device delegation.
 * @param devicePubKeyHex - 64-char hex Ed25519 public key to revoke
 */
export async function revokeDevice(devicePubKeyHex: string): Promise<string> {
  return invokeContract({
    functionName: 'revokeDevice',
    args: [devicePubKeyHex],
  });
}

/**
 * Update the user's public key on-chain (key rotation).
 * @param newPublicKeyHex - 64-char hex of the new public key
 */
export async function updatePublicKey(newPublicKeyHex: string): Promise<string> {
  return invokeContract({
    functionName: 'updatePublicKey',
    args: [newPublicKeyHex],
  });
}

/**
 * Sign an arbitrary message using the built-in vault signer.
 * Desktop standalone: uses Ed25519 directly (no extension needed).
 * Returns hex-encoded signature.
 */
export async function signMessage(message: string): Promise<string> {
  const signer = requireSigner();
  const sigBytes = await signer.signKleverMessage(new TextEncoder().encode(message));
  return bytesToHex(sigBytes);
}

// --- Account & Token Queries ---

/** Token balance entry from the Klever API. */
export interface TokenBalance {
  /** Asset ID (e.g., "KLV", "FLIPPY-3FQ0") */
  assetId: string;
  /** Balance in atomic units (divide by precision for display) */
  balance: number;
  /** Frozen balance in atomic units */
  frozenBalance: number;
  /** Token precision (decimals). KLV = 6, KDA tokens vary. */
  precision: number;
  /** Token name (if available from metadata) */
  name?: string;
  /** Token logo URI (if available from metadata) */
  logo?: string;
}

/**
 * Fetch all token balances for an account from the Klever API.
 * Returns an array of TokenBalance sorted by balance (highest first),
 * with KLV always at the top.
 * @param address - klv1... address to query
 */
export async function getAccountBalances(address: string): Promise<TokenBalance[]> {
  const apiBase = kleverProvider.api;
  const resp = await fetchWithTimeout(`${apiBase}/v1.0/address/${address}`);
  if (resp.status === 404) return [];
  if (!resp.ok) {
    throw new Error(`Failed to fetch account data (HTTP ${resp.status})`);
  }
  const json = await resp.json();
  const account = json?.data?.account;
  if (!account) return [];

  const balances: TokenBalance[] = [];

  // KLV balance is always at the top level
  const klvBalance = account.Balance ?? account.balance ?? 0;
  balances.push({
    assetId: 'KLV',
    balance: klvBalance,
    frozenBalance: account.FrozenBalance ?? 0,
    precision: 6,
    name: 'Klever',
    logo: BUNDLED_TOKEN_LOGOS.KLV,
  });

  // KDA (Klever Digital Assets) — assets map
  const assets = account.Assets ?? account.assets ?? {};
  for (const [assetId, assetData] of Object.entries(assets)) {
    if (assetId === 'KLV') continue; // already added above
    const asset = assetData as Record<string, unknown>;
    balances.push({
      assetId,
      balance: (asset.Balance ?? asset.balance ?? 0) as number,
      frozenBalance: (asset.FrozenBalance ?? asset.frozenBalance ?? 0) as number,
      precision: (asset.Precision ?? asset.precision ?? 0) as number,
    });
  }

  // Sort: KLV first, then by balance descending
  balances.sort((a, b) => {
    if (a.assetId === 'KLV') return -1;
    if (b.assetId === 'KLV') return 1;
    return b.balance - a.balance;
  });

  return balances;
}

/**
 * Fetch token metadata (name, logo, precision) from the Klever API.
 * @param assetId - Token ID (e.g., "FLIPPY-3FQ0")
 */
export async function getTokenMetadata(assetId: string): Promise<{
  name: string;
  ticker: string;
  logo: string;
  precision: number;
} | null> {
  if (assetId === 'KLV') {
    return { name: 'Klever', ticker: 'KLV', logo: BUNDLED_TOKEN_LOGOS.KLV, precision: 6 };
  }
  if (assetId === 'KFI') {
    return { name: 'Klever Finance', ticker: 'KFI', logo: BUNDLED_TOKEN_LOGOS.KFI, precision: 6 };
  }
  const apiBase = kleverProvider.api;
  try {
    const resp = await fetchWithTimeout(`${apiBase}/v1.0/assets/${encodeURIComponent(assetId)}`);
    if (!resp.ok) return null;
    const json = await resp.json();
    const asset = json?.data?.asset;
    if (!asset) return null;
    // Sanitize both name and ticker — they come from arbitrary KDA
    // issuers via the Klever asset API and end up rendered as JSX.
    return {
      name: stripBidi(String(asset.Name ?? asset.name ?? assetId)),
      ticker: stripBidi(String(asset.Ticker ?? asset.ticker ?? assetId.split('-')[0])),
      logo: asset.Logo ?? asset.logo ?? '',
      precision: asset.Precision ?? asset.precision ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Send a token transfer transaction.
 * Works for KLV and any KDA token.
 * @param recipient - klv1... address
 * @param assetId - Token ID (e.g., "KLV", "FLIPPY-3FQ0")
 * @param amount - Amount in atomic units
 */
export async function sendTransfer(
  recipient: string,
  assetId: string,
  amount: number,
  precision: number = 0,
): Promise<string> {
  const payload: Record<string, unknown> = {
    receiver: recipient,
    amount,
    kda: assetId,
  };

  // assetId is normally chain-enforced alphanumeric, but a future
  // network update or hostile-asset registration could embed RTL/bidi
  // codepoints. Sanitize before interpolation so the recipient address
  // shown in the PIN prompt cannot be visually reversed.
  const summary = stripBidi(t('tx_confirm_send_summary', {
    amount: atomicToDisplay(amount, precision),
    asset: stripBidi(assetId),
    to: abbrevAddress(recipient),
  }));

  return buildSignBroadcast([{
    type: 0, // Transfer
    payload,
  }], undefined, summary);
}
