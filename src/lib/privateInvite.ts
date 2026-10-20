/**
 * Private-channel invite gate — pure UI decision logic (spec 05 §8.4
 * "Join page behaviour", spec 06 §6.5).
 *
 * A Private channel can only be joined with a signed `ChannelInvite` that
 * names the joining wallet (l2-node 0.140.0+ verifies it on every node). The
 * join page therefore has to decide, from an UNVERIFIED decoded invite, which
 * of these to show:
 *
 *   - `none`                 no usable invite → invite-only text + copy-my-address, NO Join
 *   - `wrong-account`        invite is for another wallet → say so, NO Join
 *   - `expired`              past the client margin → show the date, NO Join
 *   - `inviter-unverifiable` usable, but the client can't show the inviter as
 *                            creator/moderator → informational line, Join allowed
 *                            (the node is the verifier; never block on this alone)
 *   - `valid`                usable → Join
 *   - `member`               the active wallet is ALREADY a member/creator of the
 *                            channel on this node → "open channel", no invite
 *                            needed. Requires POSITIVE evidence
 *                            ({@link membershipEvidence}); unknown → the invite
 *                            states above (fail closed)
 *
 * Nothing here is a security check: the node verifies signature, authority,
 * expiry and removal state. These helpers only keep the UI from offering a
 * Join button for an invite the node would certainly reject, and from showing
 * one at all when there is no invite.
 *
 * No SDK import (keeps the module loadable under `node --test`); the SDK's
 * constants are passed in by the caller.
 */

/** The decoded-invite fields this module reads (structural subset of the SDK's `DecodedChannelInvite`). */
export interface InviteFieldsLike {
  channelId: number;
  targetUser: string;
  /** Envelope author (signing address — may be a device key). */
  inviter: string;
  /** Signed envelope timestamp (unix ms). */
  timestamp: number;
  /** Effective expiry (unix ms). */
  expiresAt: number;
  /** Inviter's home node (federation host hint), when present. */
  anchorNode?: string;
}

/** A candidate invite: the decoded fields plus the raw bytes to send on join. */
export interface InviteCandidate<B = Uint8Array> {
  decoded: InviteFieldsLike;
  bytes: B;
}

export type InviteStateKind = 'none' | 'wrong-account' | 'expired' | 'inviter-unverifiable' | 'valid' | 'member';

export interface InviteState<B = Uint8Array> {
  kind: InviteStateKind;
  /** Present for every kind except `none`. */
  candidate?: InviteCandidate<B>;
}

export interface InviteEvalContext {
  /** Channel id from the route. An invite for another channel counts as none. */
  channelId: number;
  /** The ACTIVE wallet (klv1…), or null when not connected. */
  wallet: string | null;
  /** Unix ms. */
  now: number;
  /** Client expiry margin (SDK `INVITE_EXPIRY_MARGIN_MS`). */
  expiryMarginMs: number;
  /** How far an invite's signed timestamp may lie in the future (SDK `INVITE_FUTURE_TOLERANCE_MS`). */
  futureToleranceMs: number;
  /** Channel creator, when the channel record is known. */
  creator?: string | null;
  /** Channel moderators, when the channel record lists them. */
  moderators?: readonly string[] | null;
  /**
   * Whether the active wallet is already a member of this channel on THIS node
   * (from {@link membershipEvidence}). Only `'member'` changes anything;
   * absent / `'unknown'` falls through to the invite states (fail closed).
   */
  membership?: MembershipEvidence;
}

/** Positive membership evidence, or none. There is deliberately no "not a member" value. */
export type MembershipEvidence = 'member' | 'unknown';

/** Minimal member row (structural subset of the SDK's `ChannelMember`). */
export interface MemberRowLike {
  address: string;
}

/**
 * Is `wallet` a member/creator of `channelId` on this node? `'member'` only
 * on POSITIVE evidence, everything else `'unknown'`:
 *   - the channel record (this node's, for THIS channel id) names `wallet` as
 *     creator, or
 *   - a member list fetched for exactly this (wallet, channel) contains `wallet`.
 * A missing record, a record for another channel id, a failed/absent member
 * fetch, a list fetched for another wallet or channel, or a list that simply
 * doesn't contain the wallet (it is capped at one page) are all `'unknown'`.
 */
export function membershipEvidence(input: {
  wallet: string | null;
  channelId: number;
  /** Channel id of the record `creator` came from (undefined = record has none; accepted). */
  recordChannelId?: number | null;
  creator?: string | null;
  members?: readonly MemberRowLike[] | null;
  /** Wallet the member list was fetched for. */
  membersWallet?: string | null;
  /** Channel id the member list was fetched for. */
  membersChannelId?: number | null;
}): MembershipEvidence {
  const { wallet, channelId } = input;
  if (!wallet || !Number.isSafeInteger(channelId) || channelId <= 0) return 'unknown';
  const recordMatches = input.recordChannelId === undefined || input.recordChannelId === null
    || input.recordChannelId === channelId;
  if (recordMatches && input.creator && input.creator === wallet) return 'member';
  if (
    Array.isArray(input.members) &&
    input.membersWallet === wallet &&
    input.membersChannelId === channelId &&
    input.members.some((m) => m && m.address === wallet)
  ) {
    return 'member';
  }
  return 'unknown';
}

/** Whether a state means "already a member: offer Open channel". */
export function isMemberState(state: InviteState<unknown> | null | undefined): boolean {
  return state?.kind === 'member';
}

const NONE: InviteState<never> = { kind: 'none' };

/**
 * Classify ONE candidate invite against the active wallet and the clock.
 * Order follows spec 05 §8.4: channel mismatch → none, target ≠ wallet →
 * wrong-account, expired → expired, then inviter visibility.
 */
export function evaluateInvite<B>(
  candidate: InviteCandidate<B> | null | undefined,
  ctx: InviteEvalContext,
): InviteState<B> {
  if (!candidate || !candidate.decoded) return NONE;
  const d = candidate.decoded;
  if (!Number.isSafeInteger(ctx.channelId) || ctx.channelId <= 0) return NONE;
  if (d.channelId !== ctx.channelId) return NONE;
  // No wallet: nothing can be judged usable (private joins need auth). The
  // caller shows the connect prompt first.
  if (!ctx.wallet) return NONE;
  if (typeof d.targetUser !== 'string' || d.targetUser !== ctx.wallet) {
    return { kind: 'wrong-account', candidate };
  }
  if (!Number.isFinite(d.expiresAt) || ctx.now >= d.expiresAt - ctx.expiryMarginMs) {
    return { kind: 'expired', candidate };
  }
  // A signed timestamp well in the future would be rejected by the node
  // (invite.ts must not exceed join.ts + drift). Not joinable yet; nothing
  // useful to show either, so it reads as no invite.
  if (!Number.isFinite(d.timestamp) || d.timestamp > ctx.now + ctx.futureToleranceMs) return NONE;
  const creator = ctx.creator || null;
  const mods = ctx.moderators ?? [];
  const inviterShown = creator !== null && (d.inviter === creator || mods.includes(d.inviter));
  return { kind: inviterShown ? 'valid' : 'inviter-unverifiable', candidate };
}

/** Whether a state permits rendering the Join button. */
export function isJoinableInvite(state: InviteState<unknown> | null | undefined): boolean {
  return state?.kind === 'valid' || state?.kind === 'inviter-unverifiable';
}

/**
 * Pick what the join page shows from the link invite (`inv=`) and the
 * pending invite (`findPendingInvite`):
 *   0. `member` when `ctx.membership === 'member'` (and a wallet is active);
 *   1. the first JOINABLE one (link first — the user opened it explicitly);
 *   2. else the link's own state when it says something (wrong account /
 *      expired) — more useful than a bare "invite-only";
 *   3. else the pending invite's state; else none.
 */
export function resolveJoinInvite<B>(
  link: InviteCandidate<B> | null | undefined,
  pending: InviteCandidate<B> | null | undefined,
  ctx: InviteEvalContext,
): InviteState<B> {
  // Already a member (positive evidence, active wallet): no invite needed.
  if (ctx.wallet && ctx.membership === 'member') return { kind: 'member' };
  const a = evaluateInvite(link, ctx);
  if (isJoinableInvite(a)) return a;
  const b = evaluateInvite(pending, ctx);
  if (isJoinableInvite(b)) return b;
  if (a.kind !== 'none') return a;
  return b;
}

/**
 * Join errors meaning "the node wants an invite proof" (missing, expired,
 * forged, wrong inviter, removed). The join page then falls back to the
 * invite-required state instead of a raw API string.
 */
export function isInviteProofRejection(message: unknown): boolean {
  return typeof message === 'string' && /invite proof required|private channel:.*invite/i.test(message);
}

/**
 * Should a failed federate/join on a PRIVATE channel show the invite-required
 * state instead of the raw error? Yes for the node's "invite proof required"
 * wording ({@link isInviteProofRejection}) AND for any HTTP 403 (the SDK's
 * `API error (403): …` form, or an error object with `status === 403`), so a
 * differently-worded node rejection never surfaces as a raw API string.
 * Public channels never map (`isPrivate` false) — their errors stay as-is.
 */
export function isPrivateJoinRejection(err: unknown, isPrivate: boolean): boolean {
  if (!isPrivate || err === null || err === undefined) return false;
  const message = typeof err === 'string' ? err : (err as { message?: unknown }).message;
  if (isInviteProofRejection(message)) return true;
  const status = typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  if (status === 403) return true;
  return typeof message === 'string' && /^API error \(403\)/.test(message);
}

// --- Invite-gate decision (floor-aware) ---

/** Private channel ids are always above this floor (protocol: `PRIVATE_CHANNEL_ID_FLOOR`, 2^32). */
export const PRIVATE_CHANNEL_ID_FLOOR = 2 ** 32;

/**
 * Does joining this channel go through the invite gate? Gated unless the type
 * is EXACTLY Public (0) or ReadPublic (1) AND the id is a positive safe integer
 * below {@link PRIVATE_CHANNEL_ID_FLOOR}. Fail-closed for gating: an unknown or
 * garbled type, a NaN/negative id, or a record claiming a public type for an
 * id in the private range (e.g. a hostile `?node=` host answering
 * `channel_type: 0` for a private id) all take the invite-gated path.
 */
export function isInviteGatedChannel(type: unknown, id: number): boolean { const publicType = type === 0 || type === 1; const belowFloor = Number.isSafeInteger(id) && id > 0 && id < PRIVATE_CHANNEL_ID_FLOOR; return !(publicType && belowFloor); }

// --- Creator hosting their own channel on a fresh home node ---

/**
 * Does a CROSS-NODE preview name the active wallet as the channel's creator?
 * Used only to offer the creator a "host it on this node" action (a
 * `federateChannel` without an invite, which the node accepts for an unknown
 * channel only when the caller is the verified creator). The preview comes
 * from an attacker-choosable host, so this is NOT membership evidence: a host
 * falsely naming the wallet as creator only earns a node rejection. True only
 * for a non-empty wallet, a string creator equal to it, and a preview whose
 * own channel id equals the route's id.
 */
export function isPreviewCreator(wallet: string | null | undefined, previewCreator: unknown, previewChannelId: unknown, channelId: number): boolean { return typeof wallet === 'string' && wallet.length > 0 && typeof previewCreator === 'string' && previewCreator === wallet && previewChannelId === channelId; }

/**
 * Is a federate/join failure a transient "node busy" condition (HTTP 429 rate
 * limit or 503 unavailable) worth a localized "try again shortly" instead of
 * the raw SDK string? Accepts an error object with `status` 429/503 or the
 * SDK's `API error (429): …` / `API error (503): …` message form.
 */
export function isTransientFederateError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const status = typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  if (status === 429 || status === 503) return true;
  const message = typeof err === 'string' ? err : (err as { message?: unknown }).message;
  return typeof message === 'string' && (message.startsWith('API error (429)') || message.startsWith('API error (503)'));
}

// --- channel_invite notification → join page route ---

/** Minimal notification shape (structural subset of the SDK's `Notification`). */
export interface InviteNotificationLike {
  type?: unknown;
  channel_id?: unknown;
  anchor_node?: unknown;
}

/**
 * Hash route for a tapped `channel_invite` notification:
 * `/join/{channel_id}` plus `?node=<encoded anchor_node>` when the notification
 * names an http(s) anchor node. The invite envelope is NEVER put in the route
 * (the join page fetches it with `findPendingInvite`). Returns null for any
 * other type or a malformed channel id.
 */
export function joinRouteForInviteNotification(n: InviteNotificationLike | null | undefined): string | null {
  if (!n || n.type !== 'channel_invite') return null;
  const raw = n.channel_id;
  const id = typeof raw === 'number' ? (Number.isSafeInteger(raw) && raw > 0 ? String(raw) : '')
    : typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? raw : '';
  if (!id || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) return null;
  let route = `/join/${id}`;
  const anchor = n.anchor_node;
  if (typeof anchor === 'string' && anchor.length <= 512 && /^https?:\/\/[^\s]+$/i.test(anchor)) {
    route += `?node=${encodeURIComponent(anchor)}`;
  }
  return route;
}

// --- Invite validity (TTL) picker, spec 06 §6.5 ---

const HOUR_MS = 60 * 60 * 1000;

/** The fixed validity choices: 1 h / 24 h / 7 d / 14 d. No free-form entry. */
export const INVITE_TTL_OPTIONS: readonly { key: string; ms: number }[] = Object.freeze([
  { key: 'channel_invite_ttl_1h', ms: HOUR_MS },
  { key: 'channel_invite_ttl_24h', ms: 24 * HOUR_MS },
  { key: 'channel_invite_ttl_7d', ms: 7 * 24 * HOUR_MS },
  { key: 'channel_invite_ttl_14d', ms: 14 * 24 * HOUR_MS },
]);

/** Default validity: 7 days. */
export const DEFAULT_INVITE_TTL_OPTION_MS = 7 * 24 * HOUR_MS;

/**
 * Map a picker value back to a TTL. Anything not exactly one of the offered
 * options (tampered DOM, stale value) yields the default rather than an
 * out-of-range number.
 */
export function inviteTtlFromPicker(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return INVITE_TTL_OPTIONS.some((o) => o.ms === n) ? n : DEFAULT_INVITE_TTL_OPTION_MS;
}

// --- Desktop additions (same conventions; candidates for the web module too) ---

/**
 * Pick the node to federate a Private channel from (spec 05 §8.4 step 4): the
 * `node=` link parameter first, then the invite's `anchor_node`. A candidate
 * must pass `isValidHost` (the SDK's `validateNodeUrl`) and differ from the
 * current node (trailing slashes ignored); else the next one is tried. Null
 * when none fits.
 */
export function pickFederationHost(
  candidates: readonly (string | null | undefined)[],
  currentNodeUrl: string,
  isValidHost: (url: string) => boolean,
): string | null {
  const norm = (u: string) => u.replace(/\/+$/, '');
  const cur = norm(currentNodeUrl || '');
  for (const c of candidates) {
    if (typeof c !== 'string' || c.length === 0 || c.length > 2048) continue;
    if (!isValidHost(c)) continue;
    if (norm(c) === cur) continue;
    return c;
  }
  return null;
}
