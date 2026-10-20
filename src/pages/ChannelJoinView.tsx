/**
 * ChannelJoinView — deeplink landing page for joining a channel.
 *
 * URL: #/join/{channelId}[?node=<host url>][&inv=<base64url invite>]
 *
 * Public / ReadPublic: channel info + Join button (permissionless; behaviour
 * unchanged).
 *
 * Private (spec 05 §8.4 "Join page behaviour", spec 06 §6.5): every node
 * requires the joiner's own signed `ChannelInvite` (protocol §3.9.1). The
 * invite comes from the personal link's `inv=` parameter, else from the
 * wallet's newest `channel_invite` notification (`findPendingInvite`). With no
 * usable invite there is NO Join button — only the invite-only notice and a
 * copy-my-address button. Expired invites and invites for another account are
 * explained, not offered. A usable invite goes, byte-for-byte, to both
 * `federateChannel` (when the channel lives on another node) and `joinChannel`.
 * The client never verifies the invite; the node does.
 *
 * An EXISTING member (or the creator) opening a private join link is offered
 * "open channel" instead of a dead end — on positive evidence only (creator
 * field, or the node's member list for this wallet); unknown membership keeps
 * the invite gate.
 *
 * Account switching (spec 06 §6.10): this route survives a switch (an invite
 * link is often opened before switching to the right account), so all fetched
 * data is tagged with (channel, wallet, link) and ignored for any other key;
 * every async action captures wallet + switch generation + channel first and
 * re-checks them after every await.
 */

import { Component, createMemo, createResource, createSignal, createEffect, on, onCleanup, Show } from 'solid-js';
import {
  OgmaraClient,
  validateNodeUrl,
  decodeInviteFromUrl,
  decodeChannelInvite,
  INVITE_EXPIRY_MARGIN_MS,
  INVITE_FUTURE_TOLERANCE_MS,
  type ChannelDetailResponse,
} from '@ogmara/sdk';
import { t, currentLanguage } from '../i18n/init';
import { getClient, getCurrentNodeUrl } from '../lib/api';
import { authStatus, walletAddress } from '../lib/auth';
import { navigate, queryParam } from '../lib/router';
import { addJoinedChannel } from '../components/Sidebar';
import { stillSameAccount } from '../lib/accountGuard';
import { currentSwitchGeneration } from '../lib/walletScope';
import { copyToClipboard } from '../lib/share';
import {
  evaluateInvite,
  resolveJoinInvite,
  isJoinableInvite,
  isMemberState,
  isPrivateJoinRejection,
  isPreviewCreator,
  isTransientFederateError,
  isInviteGatedChannel,
  PRIVATE_CHANNEL_ID_FLOOR,
  membershipEvidence,
  pickFederationHost,
  type InviteCandidate,
  type InviteEvalContext,
  type InviteState,
} from '../lib/privateInvite';

interface ChannelJoinProps {
  channelId: string;
}

/** Everything the page renders, fetched for ONE (channel, wallet, link) key. */
interface JoinData {
  id: string;
  wallet: string | null;
  node: string;
  inv: string;
  /** The channel as the CURRENT node serves it (may be the `restricted` non-member view). */
  local: ChannelDetailResponse | null;
  /** Not on the current node: the federation host, plus its preview when it serves one. */
  cross: { host: string; detail: ChannelDetailResponse | null } | null;
  /** Best `channel_invite` notification for this wallet + channel (gated channels only). */
  pending: InviteCandidate | null;
  /** Member addresses per THIS node, fetched for this wallet (gated + local only); null = unknown. */
  members: { address: string }[] | null;
}

const hostLabel = (url: string): string => {
  try { return new URL(url).hostname; } catch { return url; }
};

/** The router already percent-decoded once; legacy links double-encode `node=`. */
const decodeHint = (raw: string): string => {
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch { return raw; }
};

/** Decode an `inv=` link parameter. UNVERIFIED — display / attach only. */
const linkCandidate = (raw: string): InviteCandidate | null => {
  if (!raw) return null;
  const bytes = decodeInviteFromUrl(raw);
  if (!bytes) return null;
  const decoded = decodeChannelInvite(bytes);
  return decoded ? { decoded, bytes } : null;
};

export const ChannelJoinView: Component<ChannelJoinProps> = (props) => {
  const [joining, setJoining] = createSignal(false);
  const [error, setError] = createSignal('');
  // The node refused our invite: fall back to the invite-required notice.
  const [inviteRejected, setInviteRejected] = createSignal(false);
  const [addressCopied, setAddressCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  // Coarse clock so an invite that expires while the page is open loses its
  // Join button; the click handler re-checks against the exact time anyway.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));

  const channelIdNum = () => (/^\d{1,16}$/.test(props.channelId) ? Number(props.channelId) : NaN);

  // Per-(channel, wallet, link) UI state must not outlive its key.
  createEffect(on(
    () => [props.channelId, walletAddress(), queryParam('inv'), queryParam('node')],
    () => { setError(''); setInviteRejected(false); setAddressCopied(false); },
    { defer: true },
  ));

  // Wallet-keyed: an account switch keeps this view mounted, and the record a
  // node returns for a private channel (member vs `restricted` placeholder),
  // the member list and the pending invite all depend on who asks.
  const [data] = createResource(
    () => ({
      id: props.channelId,
      wallet: walletAddress() ?? null,
      ready: authStatus() === 'ready',
      node: queryParam('node') ?? '',
      inv: queryParam('inv') ?? '',
    }),
    async ({ id, wallet, ready, node, inv }): Promise<JoinData> => {
      const out: JoinData = { id, wallet, node, inv, local: null, cross: null, pending: null, members: null };
      if (!/^\d{1,16}$/.test(id)) return out;
      const cid = Number(id);
      if (!Number.isSafeInteger(cid) || cid <= 0) return out;
      // The fetcher body outlives a wallet or channel change (Solid only drops
      // the stale RESULT). Stop early; `current()` also refuses a result whose
      // key no longer matches.
      const stale = () => walletAddress() !== wallet || props.channelId !== id;

      try { out.local = await getClient().getChannelDetail(cid); } catch { out.local = null; }
      if (stale()) return out;

      // Fail closed: no record / unknown type / a private-namespace id is gated.
      const gated = isInviteGatedChannel(out.local?.channel?.channel_type, cid);
      const link = linkCandidate(inv);
      const linkUsable = !!link && link.decoded.channelId === cid && link.decoded.targetUser === wallet;
      const signedIn = ready && !!wallet;

      if (gated && signedIn) {
        // Membership on THIS node (positive evidence for "open channel").
        if (out.local && (out.local as { restricted?: unknown }).restricted !== true) {
          try {
            const resp = await getClient().getChannelMembers(cid, { limit: 200 });
            out.members = Array.isArray(resp?.members) ? resp.members.map((m) => ({ address: m.address })) : null;
          } catch { out.members = null; }
          if (stale()) return out;
        }
        // Pending invite, unless the link already carries one for this wallet.
        if (!linkUsable) {
          try {
            const client = getClient();
            // Only while the client signs as THIS wallet (it reads ITS signer's notifications).
            if (client.address === wallet) {
              const p = await client.findPendingInvite(cid);
              if (p) out.pending = { decoded: p, bytes: p.invite };
            }
          } catch { out.pending = null; }
          if (stale()) return out;
        }
      }

      if (!out.local) {
        // Not on this node. Host hint: the link's `node=`, else the anchor node
        // inside the link's invite, else the pending invite's (spec 05 §8.4 step 4).
        const host = pickFederationHost(
          [
            decodeHint(node),
            link && link.decoded.channelId === cid ? link.decoded.anchorNode : undefined,
            out.pending?.decoded.anchorNode,
          ],
          getCurrentNodeUrl(),
          (u) => !!validateNodeUrl(u),
        );
        if (host) {
          let detail: ChannelDetailResponse | null = null;
          try { detail = await new OgmaraClient({ nodeUrl: host }).getChannelDetail(cid); } catch { detail = null; }
          if (stale()) return out;
          // A Public/ReadPublic channel needs a preview to be joined from
          // elsewhere; a private-namespace id may be hidden from non-members
          // by its host, so it stays joinable (with an invite) without one.
          // The preview's type is NOT trusted for the public path on its own:
          // `isGated()` is floor-aware, so a hostile host answering "public"
          // for a private id still gets the invite gate.
          if (detail || cid >= PRIVATE_CHANNEL_ID_FLOOR) out.cross = { host, detail };
        }
      }
      return out;
    },
  );

  /** The fetched data, only if it belongs to the CURRENT channel + wallet + link. */
  const current = (): JoinData | undefined => {
    if (data.error || data.loading) return undefined;
    const d = data();
    if (!d) return undefined;
    if (
      d.id !== props.channelId ||
      d.wallet !== (walletAddress() ?? null) ||
      d.inv !== (queryParam('inv') ?? '') ||
      d.node !== (queryParam('node') ?? '')
    ) return undefined;
    return d;
  };

  const shownDetail = (): ChannelDetailResponse | null => current()?.local ?? current()?.cross?.detail ?? null;
  const notFound = () => !!current() && !current()!.local && !current()!.cross;
  // Floor-aware and fail closed (privateInvite.ts): only an explicit public
  // type for an id below the private namespace takes the public path.
  const isGated = () => isInviteGatedChannel(shownDetail()?.channel?.channel_type, channelIdNum());

  /**
   * Already in the channel? POSITIVE evidence only, and only from the LOCAL
   * node (its record's creator, or its member list fetched for this wallet +
   * channel). A cross-node preview comes from an attacker-choosable `?node=`
   * host and is never membership evidence; anything else is 'unknown' and
   * keeps the invite gate.
   */
  const membership = () => {
    const d = current();
    if (!d || !d.local || authStatus() !== 'ready') return 'unknown' as const;
    const recId = (d.local.channel as { channel_id?: unknown } | undefined)?.channel_id;
    return membershipEvidence({
      wallet: walletAddress() ?? null,
      channelId: channelIdNum(),
      recordChannelId: typeof recId === 'number' ? recId : null,
      creator: d.local.channel?.creator ?? null,
      members: d.local ? d.members : null,
      membersWallet: d.local && d.members ? d.wallet : null,
      membersChannelId: d.local && d.members ? Number(d.id) : null,
    });
  };

  const linkInvite = createMemo(() => linkCandidate(queryParam('inv') ?? ''));

  const evalCtx = (at: number): InviteEvalContext => ({
    channelId: channelIdNum(),
    wallet: walletAddress() ?? null,
    now: at,
    expiryMarginMs: INVITE_EXPIRY_MARGIN_MS,
    futureToleranceMs: INVITE_FUTURE_TOLERANCE_MS,
    creator: shownDetail()?.channel?.creator ?? null,
    moderators: shownDetail()?.moderators ?? null,
    membership: membership(),
  });

  const inviteState = createMemo<InviteState>(() => {
    if (!current() || authStatus() !== 'ready') return { kind: 'none' };
    return resolveJoinInvite(linkInvite(), current()?.pending ?? null, evalCtx(now()));
  });

  const formatDate = (ms: number): string => {
    try {
      return new Date(ms).toLocaleString(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return new Date(ms).toISOString();
    }
  };

  const handleCopyAddress = async () => {
    const me = walletAddress();
    if (!me) return;
    const ok = await copyToClipboard(me);
    if (!ok || walletAddress() !== me) return;
    setAddressCopied(true);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setAddressCopied(false), 2000);
  };

  /**
   * Existing member / creator: open the channel. Re-evaluated at click time
   * for the CURRENT wallet; navigation + local list only — nothing is signed.
   */
  const handleOpenChannel = () => {
    const cid = channelIdNum();
    if (!Number.isSafeInteger(cid) || !walletAddress()) return;
    if (!isMemberState(resolveJoinInvite(null, null, evalCtx(Date.now())))) return;
    addJoinedChannel(cid);
    window.dispatchEvent(new Event('ogmara:channels-changed'));
    navigate(`/chat/${cid}`);
  };

  /**
   * PRIVATE / gated: federate (if the channel is not on this node, or to
   * refresh from a `node=` host) and join, both with the SAME invite bytes.
   * Wallet, switch generation and channel are captured first and re-checked
   * after every await; the invite is re-evaluated at click time.
   */
  const handlePrivateJoin = async () => {
    const routeId = props.channelId;
    const cid = channelIdNum();
    const me = walletAddress();
    const gen = currentSwitchGeneration();
    const d = current();
    if (!d || !Number.isSafeInteger(cid)) return;
    if (!me || authStatus() !== 'ready') { navigate('/wallet'); return; }
    const same = () =>
      stillSameAccount(me, walletAddress(), getClient().address) &&
      currentSwitchGeneration() === gen &&
      props.channelId === routeId;
    if (!same()) return;
    // Re-check against the exact clock: the reactive one ticks every 30 s.
    const state = inviteState();
    const fresh = state.candidate ? evaluateInvite(state.candidate, evalCtx(Date.now())) : state;
    if (!isJoinableInvite(fresh) || !fresh.candidate || fresh.candidate.decoded.targetUser !== me) {
      setNow(Date.now());
      return;
    }
    const invite = fresh.candidate.bytes;
    // Federation host: the cross-node host, else `node=`, else the invite's anchor.
    const host = d.cross?.host ?? pickFederationHost(
      [decodeHint(d.node), fresh.candidate.decoded.anchorNode],
      getCurrentNodeUrl(),
      (u) => !!validateNodeUrl(u),
    );
    // Unknown here and nowhere to federate from: the node would store the
    // join but apply nothing. (Not rendered in that case; belt and braces.)
    if (!d.local && !host) return;
    setJoining(true);
    setError('');
    setInviteRejected(false);
    try {
      const client = getClient();
      if (!d.local && host) {
        // FEDERATE + join: tell THIS (the member's home) node to replicate the
        // channel — the node verifies the invite before fetching from the host
        // and records the verified membership.
        await client.federateChannel(cid, host, { invite });
        if (!same()) return;
        // Announce membership to the host + other members (gossips;
        // best-effort: federate already recorded it here).
        try { await client.joinChannel(cid, { invite }); } catch { /* recorded by federate */ }
      } else {
        // On this node already. A host hint re-federates best-effort to
        // refresh metadata + the gossip subscription; the join must succeed.
        if (host) {
          try { await client.federateChannel(cid, host, { invite }); } catch { /* best-effort refresh */ }
          // Switched accounts while federating: the join would be signed by
          // the new account. Abort silently.
          if (!same()) return;
        }
        await client.joinChannel(cid, { invite });
      }
      if (!same()) return;
      addJoinedChannel(cid);
      window.dispatchEvent(new Event('ogmara:channels-changed'));
      navigate(`/chat/${cid}`);
    } catch (e: any) {
      if (!same()) return;
      if (isTransientFederateError(e)) setError(t('channel_invite_busy_retry'));
      else if (isPrivateJoinRejection(e, true)) setInviteRejected(true);
      else setError(e?.message || t(d.local ? 'error_generic' : 'channel_federate_failed'));
    } finally {
      setJoining(false);
    }
  };

  /**
   * The active wallet created this (gated) channel, which lives on another
   * node and is not on this one yet, and it holds no usable invite (a creator
   * never invites themselves). l2-node accepts a federate WITHOUT an invite
   * for an unknown channel when the caller is the verified creator, so offer
   * "host it on this node". The preview's creator field is attacker-supplied
   * (`?node=` host): it only decides whether to OFFER the action — a false
   * claim earns a node rejection (403/502), mapped like any other error. It
   * is never membership evidence (`membership()` stays local-only).
   */
  const isCreatorHostCase = (): boolean => {
    const d = current();
    if (!d || d.local || !d.cross || !d.cross.detail || authStatus() !== 'ready') return false;
    // The node already refused (403 / invite proof required): show the
    // invite-required state, not the same action again.
    if (inviteRejected()) return false;
    if (!isGated()) return false;
    const st = inviteState();
    if (isJoinableInvite(st) || isMemberState(st)) return false;
    const ch = d.cross.detail.channel as { creator?: unknown; channel_id?: unknown } | undefined;
    return isPreviewCreator(walletAddress(), ch?.creator, ch?.channel_id, channelIdNum());
  };

  /**
   * Creator: federate the channel onto this (home) node with NO invite, then
   * open it — the node records the creator as a member, so no join is sent.
   * Wallet, switch generation and route are captured first and re-checked
   * after the await.
   */
  const handleCreatorHost = async () => {
    const routeId = props.channelId;
    const cid = channelIdNum();
    const me = walletAddress();
    const gen = currentSwitchGeneration();
    const d = current();
    if (!d || !d.cross || !Number.isSafeInteger(cid)) return;
    if (!me || authStatus() !== 'ready') { navigate('/wallet'); return; }
    if (!isCreatorHostCase()) return;
    const host = d.cross.host;
    const same = () =>
      stillSameAccount(me, walletAddress(), getClient().address) &&
      currentSwitchGeneration() === gen &&
      props.channelId === routeId;
    if (!same()) return;
    setJoining(true);
    setError('');
    setInviteRejected(false);
    try {
      await getClient().federateChannel(cid, host);
      if (!same()) return;
      addJoinedChannel(cid);
      window.dispatchEvent(new Event('ogmara:channels-changed'));
      navigate(`/chat/${cid}`);
    } catch (e: any) {
      if (!same()) return;
      // Busy first; then a node refusal (403 / "invite proof required" — e.g.
      // a host falsely naming us as creator) falls back to the invite-required
      // state (spec 05 §8.4 item 4) instead of the raw API string.
      if (isTransientFederateError(e)) setError(t('channel_invite_busy_retry'));
      else if (isPrivateJoinRejection(e, true)) setInviteRejected(true);
      else setError(e?.message || t('channel_federate_failed'));
    } finally {
      setJoining(false);
    }
  };

  /** PUBLIC / ReadPublic on another node (behaviour unchanged): federate, then announce. */
  const handlePublicFederateAndJoin = async () => {
    const cn = current()?.cross;
    if (!cn || isGated()) return;
    const routeId = props.channelId;
    const cid = channelIdNum();
    const me = walletAddress();
    if (!me) { navigate('/wallet'); return; }
    setJoining(true);
    setError('');
    try {
      const client = getClient();
      await client.federateChannel(cid, cn.host);
      // The account may have switched while federating: the shared client
      // would then sign the join as the NEW account. Abort silently.
      if (walletAddress() !== me || props.channelId !== routeId) return;
      try { await client.joinChannel(cid); } catch { /* membership also recorded locally by federate */ }
      if (walletAddress() !== me || props.channelId !== routeId) return;
      addJoinedChannel(cid);
      window.dispatchEvent(new Event('ogmara:channels-changed'));
      navigate(`/chat/${cid}`);
    } catch (e: any) {
      if (walletAddress() !== me || props.channelId !== routeId) return;
      setError(isTransientFederateError(e) ? t('channel_invite_busy_retry') : (e?.message || t('channel_federate_failed')));
    } finally {
      setJoining(false);
    }
  };

  /** PUBLIC / ReadPublic on this node (behaviour unchanged). */
  const handlePublicJoin = async () => {
    if (isGated()) return; // gated joins go through handlePrivateJoin only
    const routeId = props.channelId;
    const cid = channelIdNum();
    if (!Number.isSafeInteger(cid)) return;
    setJoining(true);
    setError('');
    try {
      // Authenticated users: send join envelope so the node tracks membership.
      // Best-effort — a public channel is readable without it.
      const me = walletAddress();
      if (me) {
        try { await getClient().joinChannel(cid); } catch { /* non-critical for public channels */ }
        if (walletAddress() !== me || props.channelId !== routeId) return;
      }
      addJoinedChannel(cid);
      window.dispatchEvent(new Event('ogmara:channels-changed'));
      navigate(`/chat/${cid}`);
    } catch (e: any) {
      setError(e?.message || 'Failed to join');
    } finally {
      setJoining(false);
    }
  };

  const channelTitle = (): string => {
    const ch = shownDetail()?.channel;
    return ch?.display_name || ch?.slug || props.channelId;
  };
  const memberCount = (): number => {
    const d = shownDetail() as (ChannelDetailResponse & { member_count?: number }) | null;
    return d?.member_count ?? d?.channel?.member_count ?? 0;
  };

  /** Invite gate for a private / unknown-type channel — the ONLY place its Join button can appear. */
  const PrivateGate = () => (
    <>
      <Show when={authStatus() !== 'ready' || !walletAddress()}>
        <p class="join-private-hint">{t('channel_private_invite_link')}</p>
        <button class="join-btn" onClick={() => navigate('/wallet')}>
          {t('auth_connect_prompt')}
        </button>
      </Show>
      <Show when={authStatus() === 'ready' && walletAddress()}>
        <Show
          when={!isMemberState(inviteState())}
          fallback={
            <button class="join-btn" onClick={handleOpenChannel}>{t('channel_invite_already_member')}</button>
          }
        >
          <Show
            when={!inviteRejected() && isJoinableInvite(inviteState())}
            fallback={
              <Show
                when={isCreatorHostCase()}
                fallback={
                  <div class="join-invite-gate">
                    <Show when={!inviteRejected() && inviteState().kind === 'wrong-account'}>
                      <p class="join-invite-status">{t('channel_invite_wrong_account')}</p>
                    </Show>
                    <Show when={!inviteRejected() && inviteState().kind === 'expired'}>
                      <p class="join-invite-status">
                        {t('channel_invite_expired', { date: formatDate(inviteState().candidate!.decoded.expiresAt) })}
                      </p>
                    </Show>
                    <p class="join-invite-title">{t('channel_invite_required')}</p>
                    <p class="join-invite-desc">
                      {t('channel_invite_required_desc', { address: walletAddress() ?? '' })}
                    </p>
                    <button class="join-btn-secondary" onClick={handleCopyAddress}>
                      {addressCopied() ? t('channel_invite_address_copied') : t('channel_invite_copy_my_address')}
                    </button>
                  </div>
                }
              >
                <button class="join-btn" onClick={handleCreatorHost} disabled={joining()}>
                  {joining() ? t('loading') : t('channel_invite_creator_host')}
                </button>
              </Show>
            }
          >
            <p class="join-private-hint">{t('channel_private_invite_link')}</p>
            <p class="join-invite-note">
              {t('channel_invite_valid_until', { date: formatDate(inviteState().candidate!.decoded.expiresAt) })}
            </p>
            <Show when={inviteState().kind === 'inviter-unverifiable'}>
              <p class="join-invite-note">{t('channel_invite_inviter_unverifiable')}</p>
            </Show>
            <button class="join-btn" onClick={handlePrivateJoin} disabled={joining()}>
              {joining() ? t('loading') : t('channel_join')}
            </button>
          </Show>
        </Show>
      </Show>
    </>
  );

  return (
    <div class="join-view">
      <Show when={!current()}>
        <div class="join-loading">{t('loading')}</div>
      </Show>

      <Show when={notFound()}>
        <div class="join-card">
          <h2 class="join-name">{t('channel_not_found')}</h2>
          <p class="join-desc">{t('channel_not_found_desc')}</p>
          <button class="join-btn" onClick={() => navigate('/news')}>{t('nav_news')}</button>
        </div>
      </Show>

      <Show when={current() && !notFound()}>
        <div class="join-card">
          <h2 class="join-name">
            {isGated() ? '🔒' : '#'} {channelTitle()}
          </h2>
          <Show when={(shownDetail()?.channel as any)?.description}>
            <p class="join-desc">{(shownDetail()!.channel as any).description}</p>
          </Show>
          <Show when={shownDetail()}>
            <div class="join-meta">
              {memberCount()} {t('channel_members')}
            </div>
          </Show>

          {/* Lives on another node: federated to the member's home node on join (no switch). */}
          <Show when={!current()!.local && current()!.cross}>
            <p class="join-private-hint">
              {t('channel_on_other_node', { node: hostLabel(current()!.cross!.host) })}
            </p>
          </Show>

          <Show
            when={isGated()}
            fallback={
              <Show
                when={current()!.local}
                fallback={
                  <button class="join-btn" onClick={handlePublicFederateAndJoin} disabled={joining()}>
                    {joining() ? t('loading') : t('channel_join')}
                  </button>
                }
              >
                <button class="join-btn" onClick={handlePublicJoin} disabled={joining()}>
                  {joining() ? t('loading') : t('channel_join')}
                </button>
              </Show>
            }
          >
            <PrivateGate />
          </Show>

          <Show when={error()}>
            <div class="join-error">{error()}</div>
          </Show>
        </div>
      </Show>

      <style>{`
        .join-view {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          padding: var(--spacing-lg);
        }
        .join-loading { color: var(--color-text-secondary); }
        .join-card {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-xl);
          max-width: 400px;
          width: 100%;
          text-align: center;
        }
        .join-name { font-size: var(--font-size-xl); margin-bottom: var(--spacing-sm); overflow-wrap: anywhere; }
        .join-desc { color: var(--color-text-secondary); margin-bottom: var(--spacing-md); }
        .join-meta { font-size: var(--font-size-sm); color: var(--color-text-secondary); margin-bottom: var(--spacing-lg); }
        .join-btn {
          padding: var(--spacing-sm) var(--spacing-xl);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-md);
        }
        .join-btn:disabled { opacity: 0.5; }
        .join-btn-secondary {
          padding: var(--spacing-xs) var(--spacing-lg);
          background: var(--color-bg-secondary);
          color: var(--color-text-primary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          font-size: var(--font-size-sm);
        }
        .join-private-hint {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          margin-bottom: var(--spacing-md);
          padding: var(--spacing-sm);
          background: var(--color-bg-tertiary);
          border-radius: var(--radius-md);
        }
        .join-invite-gate {
          padding: var(--spacing-md);
          background: var(--color-bg-tertiary);
          border-radius: var(--radius-md);
        }
        .join-invite-status { font-size: var(--font-size-sm); margin-bottom: var(--spacing-sm); }
        .join-invite-title { font-weight: 600; margin-bottom: var(--spacing-xs); }
        .join-invite-desc {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          margin-bottom: var(--spacing-sm);
          overflow-wrap: anywhere;
        }
        .join-invite-note {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          margin-bottom: var(--spacing-md);
        }
        .join-error {
          margin-top: var(--spacing-md);
          color: #f44;
          font-size: var(--font-size-sm);
        }
      `}</style>
    </div>
  );
};
