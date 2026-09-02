/**
 * What it costs the current user to verify their wallet on-chain.
 *
 * The registration fee is set by NODE GOVERNANCE and changes with no client
 * release, so it must be read live from the connected node — never hard-coded
 * and never cached across sessions.
 */

import { getClient } from './api';

/** Atomic units per KLV (6 decimals). */
const KLV = 1_000_000;

/**
 * The contract's own ceiling on `registration_fee`: 10,000 KLV
 * (`MAX_REGISTRATION_FEE` in smart-contract/src/registry.rs, enforced on every
 * write path). Anything above it is provably not a legitimate fee, so a value
 * that large means the node is broken or hostile — treat it as UNKNOWN rather
 * than asking the user to sign it.
 */
const MAX_FEE_ATOMIC = 10_000_000_000;

export interface RegistrationCost {
  /**
   * `true` when we have an authoritative fee from the node.
   *
   * `false` means UNKNOWN, not free — an older node without the endpoint, a
   * node with no contract configured, or an RPC failure. The UI must say the
   * amount is unknown and let the wallet's own confirmation reveal it, rather
   * than implying the action is free.
   */
  known: boolean;
  /** Fee in atomic units. 0 when the fee is genuinely zero, or when unknown. */
  feeAtomic: number;
  /** Display-ready KLV amount from the node, e.g. "100" or "50.5". */
  feeKlv: string;
  /** Share routed to the operator, in basis points (10_000 = 100%). */
  shareBps: number;
  /** Operator wallet to credit, or `null` when the node has no anchor wallet. */
  operatorAddress: string | null;
}

const UNKNOWN: RegistrationCost = {
  known: false,
  feeAtomic: 0,
  feeKlv: '',
  shareBps: 0,
  operatorAddress: null,
};

/**
 * Read the live registration cost from the connected node.
 *
 * NEVER throws: verification must not be blocked because a fee lookup failed.
 * Every failure degrades to `known: false`, which the UI renders as "amount
 * unknown — the transaction will show the exact cost".
 */
export async function loadRegistrationCost(): Promise<RegistrationCost> {
  try {
    const info = await getClient().registrationInfo();
    // `contract_configured: false` and a null fee both mean the node cannot
    // tell us. Treating either as 0 would be read as "free" and would build a
    // zero-value transaction that the chain rejects.
    if (!info || info.contract_configured === false || info.registration_fee == null) {
      return UNKNOWN;
    }
    // A decimal STRING of raw units. Parse via BigInt so a large value cannot
    // silently round, then narrow only once it is known to be safe.
    let raw: bigint;
    try {
      raw = BigInt(info.registration_fee);
    } catch {
      // Not a decimal string — a broken or hostile node.
      return UNKNOWN;
    }
    if (raw < 0n || raw > BigInt(MAX_FEE_ATOMIC)) return UNKNOWN;
    const feeAtomic = Number(raw);
    return {
      known: true,
      feeAtomic,
      // Derived from the amount we will actually SIGN, never from the node's
      // own display string. A node returning registration_fee "10000000000"
      // alongside registration_fee_klv "100" would otherwise show "100 KLV"
      // and charge 10,000.
      feeKlv: formatKlv(feeAtomic),
      shareBps: Number(info.node_fee_share_bps ?? 0),
      // Validated HERE, in the one place all three clients share, so a
      // malformed operator address never reaches calldata. Web/desktop would
      // otherwise append a wrong-length argument and revert the invoke on
      // chain — burning the network fee on every attempt — while mobile's
      // stricter decoder would throw and block registration outright. Dropping
      // to null simply routes the whole fee to the treasury, which the
      // contract already handles as a normal case.
      operatorAddress: isWellFormedAddress(info.operator_address) ? info.operator_address! : null,
    };
  } catch {
    // 404 on a pre-0.126.0 node, 503 on an RPC failure, or an offline node.
    return UNKNOWN;
  }
}

/**
 * True for a syntactically valid `klv1` bech32 address with a correct checksum
 * and a 32-byte payload. Deliberately strict: this gates a value that goes
 * straight into on-chain calldata.
 */
function isWellFormedAddress(a: string | null | undefined): boolean {
  if (!a || !a.startsWith('klv1')) return false;
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const sep = a.lastIndexOf('1');
  if (sep < 1) return false;
  const hrp = a.slice(0, sep);
  const values: number[] = [];
  for (const ch of a.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) return false;
    values.push(v);
  }
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
  if (chk !== 1) return false;
  // 32 bytes = 52 five-bit symbols + 6 checksum symbols.
  return values.length - 6 === 52;
}

/** Format atomic units as KLV, trimming trailing zeros (`100`, `50.5`). */
export function formatKlv(atomic: number): string {
  if (!atomic) return '0';
  const whole = Math.floor(atomic / KLV);
  const frac = atomic % KLV;
  if (!frac) return String(whole);
  return `${whole}.${String(frac).padStart(6, '0').replace(/0+$/, '')}`;
}
