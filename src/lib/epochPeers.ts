/**
 * Peer nodes for split detection (`peerCommitments`), desktop 1.85.0 — pure,
 * tested in epochPeers.test.ts.
 *
 * UNIFIED CROSS-CLIENT PEER RULE (web / desktop / mobile): per queried peer
 *  - a commitment answer (2xx) is an ANSWER;
 *  - 403 / 404 means "this node does not carry the channel / we are not a
 *    member there": SKIPPED (neither an answer nor a failure);
 *  - 401, a network error, a timeout or a 5xx is a FAILURE (that peer might
 *    hold a split we cannot see).
 * Result: `[]` when there are no peers or every queried peer skipped; the
 * answered commitments when at least one answered (failures ignored); THROW
 * only when no commitment answered AND at least one peer failed — the SDK
 * then keeps the key unconfirmed.
 *
 * Peer SOURCES (privacy): only the user's own known nodes (user-configured)
 * and the on-chain registry (`getActiveNodes`, already used by the node
 * picker) — never hosts the home node lists, which would let a node choose
 * who receives signed requests carrying our wallet, the channel id and our
 * IP. Loopback / private / link-local literal hosts are refused unless the
 * user configured that URL. Requests to peers do not follow redirects.
 */
import type { KeyCommitmentInfo } from '@ogmara/sdk';

/** How one failed peer read counts. */
export type PeerErrorKind = 'skip' | 'fail';

/**
 * 403 / 404 → `skip`; everything else (401, 5xx, timeout / abort, network
 * error, a malformed body) → `fail`. Reads the status from the SDK's
 * `API error (NNN)` message or a numeric `status` field.
 */
export function peerErrorKind(e: unknown): PeerErrorKind {
  const st = (e as { status?: unknown })?.status;
  let status = typeof st === 'number' ? st : NaN;
  if (!Number.isFinite(status)) {
    const m = /API error \((\d{3})\)/.exec(String((e as { message?: unknown })?.message ?? e));
    if (m) status = Number(m[1]);
  }
  return status === 403 || status === 404 ? 'skip' : 'fail';
}

/** `peerCommitments` per the unified peer rule (see the module comment). Each `read` must time out. */
export async function queryPeerCommitments(
  peers: readonly string[],
  read: (peer: string) => Promise<KeyCommitmentInfo>,
  classify: (e: unknown) => PeerErrorKind = peerErrorKind,
): Promise<KeyCommitmentInfo[]> {
  if (peers.length === 0) return [];
  const rs = await Promise.allSettled(peers.map((p) => read(p)));
  const answers: KeyCommitmentInfo[] = [];
  let failed = 0;
  for (const r of rs) {
    if (r.status === 'fulfilled') answers.push(r.value);
    else if (classify(r.reason) === 'fail') failed++;
  }
  if (answers.length > 0) return answers;
  if (failed > 0) throw new Error(`no peer node answered (${failed} of ${peers.length} failed)`);
  return []; // every peer skipped: none of them carries the channel for us
}

/**
 * Literal loopback / private / link-local / CGNAT / multicast / unspecified
 * host? (Hostnames are not resolved.) A trailing dot is ignored
 * (`localhost.`). IPv6: `::/96` (unspecified, loopback, IPv4-compatible) and
 * `::ffff:0:0/96` (IPv4-mapped), `64:ff9b::/96` (NAT64), `fc00::/7` (ULA),
 * `fe80::/10` (link-local), `fec0::/10` (site-local), `ff00::/8` (multicast).
 */
export function isPrivateHostLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(':')) {
    return h.startsWith('::') || h.startsWith('0:0:0:0:0:') || h.startsWith('64:ff9b:')
      || /^f[cd]/.test(h) || /^fe[89a-f]/.test(h) || h.startsWith('ff');
  }
  return false;
}

/** Normalised peer URL (`scheme://host[:port]`, no path) or null when not acceptable. */
export function normalizePeerUrl(raw: string, userConfigured: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (!userConfigured && u.protocol !== 'https:') return null;
  if (!userConfigured && isPrivateHostLiteral(u.hostname)) return null;
  const host = u.hostname.replace(/\.+$/, '');
  if (host === '') return null;
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
}

/** Max peer candidates probed and peers used. */
export const MAX_PEER_CANDIDATES = 8;
export const MAX_PEERS = 3;

/**
 * Candidate peers: the user's known nodes first (user-configured), then the
 * on-chain registry; never the home node, deduplicated, capped.
 */
export function selectPeerCandidates(args: { known: readonly string[]; registry: readonly string[]; home: string }): string[] {
  const home = normalizePeerUrl(args.home, true);
  const out: string[] = [];
  const add = (raw: string, user: boolean) => {
    const n = normalizePeerUrl(raw, user);
    if (n && n !== home && !out.includes(n) && out.length < MAX_PEER_CANDIDATES) out.push(n);
  };
  for (const k of args.known) add(k, true);
  for (const r of args.registry) add(r, false);
  return out;
}

/**
 * Keep the candidates whose `/health` answers on OUR network with
 * `key_commitment_v1` (a dead, foreign-network or pre-0.143 node must not
 * count as a peer: "peers known, none answered" never confirms). Capped.
 */
export async function probePeers(
  candidates: readonly string[],
  health: (url: string) => Promise<{ network?: string; features?: unknown }>,
  network: string,
  feature: string,
): Promise<string[]> {
  const rs = await Promise.allSettled(candidates.map(async (u) => {
    const h = await health(u);
    return Array.isArray(h.features) && h.features.includes(feature) && h.network === network ? u : null;
  }));
  return rs.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : [])).slice(0, MAX_PEERS);
}

// --- No-redirect registry (read by the global fetch wrapper in index.tsx) ----------------

const noRedirectOrigins = new Set<string>();
const MAX_NO_REDIRECT = 64;

/**
 * Requests to this origin must not follow redirects (peer queries). Returns
 * false when it could not be registered (full / not a URL): the caller must
 * then NOT use that peer (fail closed — a peer whose redirects cannot be
 * turned off never gets a signed request).
 */
export function markNoRedirect(url: string): boolean {
  try {
    const o = new URL(url).origin;
    if (noRedirectOrigins.has(o)) return true;
    if (noRedirectOrigins.size >= MAX_NO_REDIRECT) return false;
    noRedirectOrigins.add(o);
    return true;
  } catch {
    return false;
  }
}

/** Test hook: forget every registered origin. */
export function resetNoRedirectForTests(): void {
  noRedirectOrigins.clear();
}

/** Whether a request URL targets an origin registered with {@link markNoRedirect}. */
export function isNoRedirect(url: string): boolean {
  try {
    return noRedirectOrigins.has(new URL(url).origin);
  } catch {
    return false;
  }
}
