/**
 * privateInvite (desktop 1.83.0; same module as web 0.83.0 + desktop additions). Run:
 *   node --conditions=browser --test src/lib/privateInvite.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluateInvite,
  resolveJoinInvite,
  isJoinableInvite,
  isInviteProofRejection,
  INVITE_TTL_OPTIONS,
  DEFAULT_INVITE_TTL_OPTION_MS,
  inviteTtlFromPicker,
  membershipEvidence,
  isPrivateJoinRejection,
  joinRouteForInviteNotification,
  isMemberState,
  type InviteCandidate,
  type InviteEvalContext,
  pickFederationHost,
  isInviteGatedChannel,
  PRIVATE_CHANNEL_ID_FLOOR,
  isPreviewCreator,
  isTransientFederateError,
} from './privateInvite.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CID = 5_000_000_000; // above the private-id floor
const ME = 'klv1me';
const OTHER = 'klv1other';
const CREATOR = 'klv1creator';
const MOD = 'klv1mod';

function cand(over: Partial<InviteCandidate['decoded']> = {}, tag = 'bytes'): InviteCandidate<string> {
  return {
    decoded: {
      channelId: CID,
      targetUser: ME,
      inviter: CREATOR,
      timestamp: NOW - 10 * MIN,
      expiresAt: NOW + DAY,
      ...over,
    },
    bytes: tag,
  };
}

function ctx(over: Partial<InviteEvalContext> = {}): InviteEvalContext {
  return {
    channelId: CID,
    wallet: ME,
    now: NOW,
    expiryMarginMs: 5 * MIN,
    futureToleranceMs: 4 * MIN,
    creator: CREATOR,
    moderators: [MOD],
    ...over,
  };
}

test('no candidate -> none, not joinable', () => {
  assert.equal(evaluateInvite(null, ctx()).kind, 'none');
  assert.equal(evaluateInvite(undefined, ctx()).kind, 'none');
  assert.equal(isJoinableInvite(evaluateInvite(null, ctx())), false);
});

test('creator invite for me, unexpired -> valid and joinable (positive control)', () => {
  const s = evaluateInvite(cand(), ctx());
  assert.equal(s.kind, 'valid');
  assert.equal(s.candidate?.bytes, 'bytes');
  assert.equal(isJoinableInvite(s), true);
});

test('moderator invite -> valid', () => {
  assert.equal(evaluateInvite(cand({ inviter: MOD }), ctx()).kind, 'valid');
});

test('invite for another channel -> none', () => {
  assert.equal(evaluateInvite(cand({ channelId: CID + 1 }), ctx()).kind, 'none');
});

test('invalid route channel id -> none', () => {
  assert.equal(evaluateInvite(cand({ channelId: NaN as unknown as number }), ctx({ channelId: NaN })).kind, 'none');
  assert.equal(evaluateInvite(cand({ channelId: 0 }), ctx({ channelId: 0 })).kind, 'none');
});

test('no wallet connected -> none (connect prompt is shown instead)', () => {
  assert.equal(evaluateInvite(cand(), ctx({ wallet: null })).kind, 'none');
});

test('invite targeting another wallet -> wrong-account, not joinable', () => {
  const s = evaluateInvite(cand({ targetUser: OTHER }), ctx());
  assert.equal(s.kind, 'wrong-account');
  assert.equal(isJoinableInvite(s), false);
});

test('account switch re-evaluates the same invite', () => {
  const c = cand({ targetUser: OTHER });
  assert.equal(evaluateInvite(c, ctx({ wallet: ME })).kind, 'wrong-account');
  assert.equal(evaluateInvite(c, ctx({ wallet: OTHER })).kind, 'valid');
});

test('expiry uses the client margin (tighter than the node)', () => {
  // 6 min left: still valid.
  assert.equal(evaluateInvite(cand({ expiresAt: NOW + 6 * MIN }), ctx()).kind, 'valid');
  // Exactly at the margin: expired.
  assert.equal(evaluateInvite(cand({ expiresAt: NOW + 5 * MIN }), ctx()).kind, 'expired');
  // Past expiry.
  const s = evaluateInvite(cand({ expiresAt: NOW - 1 }), ctx());
  assert.equal(s.kind, 'expired');
  assert.equal(isJoinableInvite(s), false);
  // Non-finite expiry never counts as valid.
  assert.equal(evaluateInvite(cand({ expiresAt: NaN }), ctx()).kind, 'expired');
});

test('wrong account outranks expiry (spec order)', () => {
  assert.equal(evaluateInvite(cand({ targetUser: OTHER, expiresAt: NOW - 1 }), ctx()).kind, 'wrong-account');
});

test('signed timestamp too far in the future -> none', () => {
  assert.equal(evaluateInvite(cand({ timestamp: NOW + 10 * MIN }), ctx()).kind, 'none');
  // Within tolerance: fine.
  assert.equal(evaluateInvite(cand({ timestamp: NOW + 3 * MIN }), ctx()).kind, 'valid');
});

test('inviter not shown as creator/moderator -> inviter-unverifiable, still joinable', () => {
  const s = evaluateInvite(cand({ inviter: 'klv1stranger' }), ctx());
  assert.equal(s.kind, 'inviter-unverifiable');
  assert.equal(isJoinableInvite(s), true);
});

test('channel record not loaded -> inviter-unverifiable even for the real creator', () => {
  assert.equal(evaluateInvite(cand(), ctx({ creator: null, moderators: null })).kind, 'inviter-unverifiable');
  assert.equal(evaluateInvite(cand({ inviter: MOD }), ctx({ creator: undefined, moderators: [MOD] })).kind, 'inviter-unverifiable');
});

test('resolveJoinInvite: joinable link wins over pending', () => {
  const s = resolveJoinInvite(cand({}, 'link'), cand({}, 'pending'), ctx());
  assert.equal(s.candidate?.bytes, 'link');
});

test('resolveJoinInvite: wrong-account link falls back to a usable pending invite', () => {
  const s = resolveJoinInvite(cand({ targetUser: OTHER }, 'link'), cand({}, 'pending'), ctx());
  assert.equal(s.kind, 'valid');
  assert.equal(s.candidate?.bytes, 'pending');
});

test('resolveJoinInvite: expired link with no pending shows expired (not bare none)', () => {
  assert.equal(resolveJoinInvite(cand({ expiresAt: NOW - 1 }, 'link'), null, ctx()).kind, 'expired');
});

test('resolveJoinInvite: nothing anywhere -> none (negative control: no Join)', () => {
  const s = resolveJoinInvite(null, null, ctx());
  assert.equal(s.kind, 'none');
  assert.equal(isJoinableInvite(s), false);
});

test('resolveJoinInvite: link for another channel + no pending -> none', () => {
  assert.equal(resolveJoinInvite(cand({ channelId: 7 }, 'link'), null, ctx()).kind, 'none');
});

test('isInviteProofRejection matches the node rejection, not unrelated errors', () => {
  assert.equal(isInviteProofRejection('API error (403): private channel: invite proof required'), true);
  assert.equal(isInviteProofRejection('API error (500): internal'), false);
  assert.equal(isInviteProofRejection('Signer required'), false);
  assert.equal(isInviteProofRejection(undefined), false);
});

test('TTL options: exactly 1h/24h/7d/14d, default 7d, max 14d', () => {
  assert.deepEqual(INVITE_TTL_OPTIONS.map((o) => o.ms), [3600_000, 86_400_000, 7 * DAY, 14 * DAY]);
  assert.equal(DEFAULT_INVITE_TTL_OPTION_MS, 7 * DAY);
  assert.ok(INVITE_TTL_OPTIONS.some((o) => o.ms === DEFAULT_INVITE_TTL_OPTION_MS));
  assert.ok(Math.max(...INVITE_TTL_OPTIONS.map((o) => o.ms)) <= 14 * DAY);
  assert.ok(Object.isFrozen(INVITE_TTL_OPTIONS));
});

test('inviteTtlFromPicker accepts only offered values', () => {
  assert.equal(inviteTtlFromPicker('3600000'), 3600_000);
  assert.equal(inviteTtlFromPicker(14 * DAY), 14 * DAY);
  // Negative controls: anything else falls back to the default, never passes through.
  assert.equal(inviteTtlFromPicker(15 * DAY), DEFAULT_INVITE_TTL_OPTION_MS);
  assert.equal(inviteTtlFromPicker('abc'), DEFAULT_INVITE_TTL_OPTION_MS);
  assert.equal(inviteTtlFromPicker(1), DEFAULT_INVITE_TTL_OPTION_MS);
  assert.equal(inviteTtlFromPicker(undefined), DEFAULT_INVITE_TTL_OPTION_MS);
});

// --- Already-a-member state ---

test('membershipEvidence: creator of THIS channel -> member', () => {
  assert.equal(membershipEvidence({ wallet: CREATOR, channelId: CID, recordChannelId: CID, creator: CREATOR }), 'member');
  // Record without a channel id field is accepted (it was fetched for the route).
  assert.equal(membershipEvidence({ wallet: CREATOR, channelId: CID, creator: CREATOR }), 'member');
});

test('membershipEvidence: wallet in a member list fetched for this wallet+channel -> member', () => {
  assert.equal(
    membershipEvidence({ wallet: ME, channelId: CID, members: [{ address: OTHER }, { address: ME }], membersWallet: ME, membersChannelId: CID }),
    'member',
  );
});

test('membershipEvidence: fails closed (negative controls)', () => {
  // No evidence at all.
  assert.equal(membershipEvidence({ wallet: ME, channelId: CID }), 'unknown');
  // Fetch failed.
  assert.equal(membershipEvidence({ wallet: ME, channelId: CID, members: null, membersWallet: ME, membersChannelId: CID }), 'unknown');
  // Not in the (capped) list.
  assert.equal(membershipEvidence({ wallet: ME, channelId: CID, members: [{ address: OTHER }], membersWallet: ME, membersChannelId: CID }), 'unknown');
  // List fetched for ANOTHER wallet (stale after an account switch) even though it contains ME.
  assert.equal(membershipEvidence({ wallet: ME, channelId: CID, members: [{ address: ME }], membersWallet: OTHER, membersChannelId: CID }), 'unknown');
  // List fetched for another channel.
  assert.equal(membershipEvidence({ wallet: ME, channelId: CID, members: [{ address: ME }], membersWallet: ME, membersChannelId: CID + 1 }), 'unknown');
  // Creator of a DIFFERENT channel's record.
  assert.equal(membershipEvidence({ wallet: CREATOR, channelId: CID, recordChannelId: CID + 1, creator: CREATOR }), 'unknown');
  // Someone else is the creator.
  assert.equal(membershipEvidence({ wallet: ME, channelId: CID, recordChannelId: CID, creator: CREATOR }), 'unknown');
  // No wallet.
  assert.equal(membershipEvidence({ wallet: null, channelId: CID, creator: CREATOR }), 'unknown');
  // Bad channel id.
  assert.equal(membershipEvidence({ wallet: CREATOR, channelId: NaN, creator: CREATOR }), 'unknown');
});

test('resolveJoinInvite: member evidence -> member state (Open channel, not Join)', () => {
  const s = resolveJoinInvite(null, null, ctx({ membership: 'member' }));
  assert.equal(s.kind, 'member');
  assert.equal(isMemberState(s), true);
  assert.equal(isJoinableInvite(s), false);
  // Wins over a usable invite too: no re-join needed.
  assert.equal(resolveJoinInvite(cand(), null, ctx({ membership: 'member' })).kind, 'member');
});

test('resolveJoinInvite: unknown/absent membership keeps the invite states (negative control)', () => {
  assert.equal(resolveJoinInvite(null, null, ctx({ membership: 'unknown' })).kind, 'none');
  assert.equal(resolveJoinInvite(null, null, ctx()).kind, 'none');
  assert.equal(isMemberState(resolveJoinInvite(null, null, ctx())), false);
  // Member evidence without an active wallet never yields member.
  assert.equal(resolveJoinInvite(null, null, ctx({ wallet: null, membership: 'member' })).kind, 'none');
});

// --- Private join rejection (403 robustness) ---

test('isPrivateJoinRejection: proof wording or any 403 on a private channel', () => {
  assert.equal(isPrivateJoinRejection(new Error('API error (403): private channel: invite proof required'), true), true);
  assert.equal(isPrivateJoinRejection(new Error('API error (403): forbidden: not invited'), true), true);
  assert.equal(isPrivateJoinRejection({ status: 403, message: 'whatever' }, true), true);
  assert.equal(isPrivateJoinRejection('invite proof required', true), true);
});

test('isPrivateJoinRejection: negative controls', () => {
  // Public channel: never mapped, even for a 403.
  assert.equal(isPrivateJoinRejection(new Error('API error (403): forbidden'), false), false);
  // Other statuses / errors stay raw.
  assert.equal(isPrivateJoinRejection(new Error('API error (500): internal'), true), false);
  assert.equal(isPrivateJoinRejection(new Error('API error (404): not found'), true), false);
  assert.equal(isPrivateJoinRejection(new Error('network down, saw 403 earlier'), true), false);
  assert.equal(isPrivateJoinRejection({ status: 500 }, true), false);
  assert.equal(isPrivateJoinRejection(null, true), false);
  assert.equal(isPrivateJoinRejection(undefined, true), false);
});

// --- channel_invite notification -> join route ---

test('joinRouteForInviteNotification: join route with encoded anchor node', () => {
  assert.equal(joinRouteForInviteNotification({ type: 'channel_invite', channel_id: '5000000000' }), '/join/5000000000');
  assert.equal(
    joinRouteForInviteNotification({ type: 'channel_invite', channel_id: '5000000000', anchor_node: 'https://node.example.org:8443' }),
    '/join/5000000000?node=' + encodeURIComponent('https://node.example.org:8443'),
  );
  assert.equal(joinRouteForInviteNotification({ type: 'channel_invite', channel_id: 42 }), '/join/42');
});

test('joinRouteForInviteNotification: never carries the invite envelope', () => {
  const r = joinRouteForInviteNotification({
    type: 'channel_invite', channel_id: '7', anchor_node: 'https://n.example', invite_envelope: 'AAAA',
  } as any);
  assert.equal(r, '/join/7?node=' + encodeURIComponent('https://n.example'));
  assert.ok(!r!.includes('inv='));
});

test('joinRouteForInviteNotification: negative controls', () => {
  assert.equal(joinRouteForInviteNotification({ type: 'mention', channel_id: '7' }), null);
  assert.equal(joinRouteForInviteNotification({ type: 'channel_invite' }), null);
  assert.equal(joinRouteForInviteNotification({ type: 'channel_invite', channel_id: '7/../../wallet' }), null);
  assert.equal(joinRouteForInviteNotification({ type: 'channel_invite', channel_id: '0' }), null);
  assert.equal(joinRouteForInviteNotification({ type: 'channel_invite', channel_id: -3 }), null);
  assert.equal(joinRouteForInviteNotification({ type: 'channel_invite', channel_id: '99999999999999999' }), null);
  assert.equal(joinRouteForInviteNotification(null), null);
  // Bad anchors are dropped, the route itself survives.
  assert.equal(joinRouteForInviteNotification({ type: 'channel_invite', channel_id: '7', anchor_node: 'javascript:alert(1)' }), '/join/7');
  assert.equal(joinRouteForInviteNotification({ type: 'channel_invite', channel_id: '7', anchor_node: null }), '/join/7');
  assert.equal(joinRouteForInviteNotification({ type: 'channel_invite', channel_id: '7', anchor_node: 'https://a b' }), '/join/7');
});

// --- Public-path gate (floor-aware) ---

test('isInviteGatedChannel: a normal public / read-public channel takes the public path', () => {
  assert.equal(isInviteGatedChannel(0, 42), false);
  assert.equal(isInviteGatedChannel(1, 42), false);
  assert.equal(isInviteGatedChannel(0, PRIVATE_CHANNEL_ID_FLOOR - 1), false);
});

test('isInviteGatedChannel: a "public" type for an id in the private namespace is gated', () => {
  // A hostile ?node= host answering channel_type 0 for a private id.
  assert.equal(isInviteGatedChannel(0, PRIVATE_CHANNEL_ID_FLOOR), true);
  assert.equal(isInviteGatedChannel(0, CID), true);
  assert.equal(isInviteGatedChannel(1, CID), true);
});

test('isInviteGatedChannel: private, unknown or garbled type is gated', () => {
  for (const ty of [2, 3, -1, undefined, null, '0', '1', NaN, {}]) assert.equal(isInviteGatedChannel(ty, 42), true, String(ty));
});

test('isInviteGatedChannel: NaN / zero / negative / unsafe id is gated', () => {
  for (const id of [NaN, 0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2]) assert.equal(isInviteGatedChannel(0, id), true, String(id));
});

// --- Creator hosting / transient federate errors ---

test('isPreviewCreator: creator of THIS channel in the preview -> true (positive control)', () => {
  assert.equal(isPreviewCreator(CREATOR, CREATOR, CID, CID), true);
});

test('isPreviewCreator: fails closed (negative controls)', () => {
  assert.equal(isPreviewCreator(ME, CREATOR, CID, CID), false, 'other creator');
  assert.equal(isPreviewCreator(null, CREATOR, CID, CID), false, 'null wallet');
  assert.equal(isPreviewCreator(undefined, CREATOR, CID, CID), false, 'undefined wallet');
  assert.equal(isPreviewCreator('', '', CID, CID), false, 'empty wallet');
  assert.equal(isPreviewCreator(CREATOR, { toString: () => CREATOR }, CID, CID), false, 'non-string creator');
  assert.equal(isPreviewCreator(CREATOR, null, CID, CID), false, 'no creator');
  assert.equal(isPreviewCreator(CREATOR, CREATOR, CID + 1, CID), false, 'wrong preview channel id');
  assert.equal(isPreviewCreator(CREATOR, CREATOR, String(CID), CID), false, 'string preview channel id');
  assert.equal(isPreviewCreator(CREATOR, CREATOR, undefined, CID), false, 'preview without channel id');
});

test('isTransientFederateError: 429 / 503 by status or SDK message', () => {
  assert.equal(isTransientFederateError({ status: 429 }), true);
  assert.equal(isTransientFederateError({ status: 503 }), true);
  assert.equal(isTransientFederateError(new Error('API error (429): rate limited')), true);
  assert.equal(isTransientFederateError(new Error('API error (503): unavailable')), true);
  assert.equal(isTransientFederateError('API error (429): slow down'), true);
});

test('isTransientFederateError: everything else is not transient (negative controls)', () => {
  assert.equal(isTransientFederateError(new Error('API error (403): forbidden')), false);
  assert.equal(isTransientFederateError(new Error('API error (502): bad gateway')), false);
  assert.equal(isTransientFederateError({ status: 500 }), false);
  assert.equal(isTransientFederateError(new Error('upstream said API error (429)')), false, 'must be a prefix');
  assert.equal(isTransientFederateError(null), false);
  assert.equal(isTransientFederateError(undefined), false);
  assert.equal(isTransientFederateError({}), false);
});

// --- Desktop additions ---

test('pickFederationHost: node= first, then anchor; skips invalid, current and oversized', () => {
  const valid = (u: string) => u.startsWith('https://');
  assert.equal(pickFederationHost(['https://a.example', 'https://b.example'], 'https://me.example', valid), 'https://a.example');
  assert.equal(pickFederationHost([undefined, 'https://b.example'], 'https://me.example', valid), 'https://b.example');
  assert.equal(pickFederationHost(['javascript:alert(1)', 'https://b.example'], 'https://me.example', valid), 'https://b.example');
  assert.equal(pickFederationHost(['https://me.example/', 'https://b.example'], 'https://me.example', valid), 'https://b.example');
  assert.equal(pickFederationHost(['https://me.example'], 'https://me.example', valid), null);
  assert.equal(pickFederationHost(['https://' + 'x'.repeat(3000)], 'https://me.example', () => true), null);
});

test('every TTL label + invite key exists in all 7 desktop locales', () => {
  const keys = [
    ...INVITE_TTL_OPTIONS.map((o) => o.key),
    'channel_invite_required', 'channel_invite_required_desc', 'channel_invite_expired',
    'channel_invite_wrong_account', 'channel_invite_copy_my_address', 'channel_invite_address_copied',
    'channel_invite_copy_personal_link', 'channel_invite_validity', 'channel_invite_valid_until',
    'channel_invite_inviter_unverifiable', 'channel_private_invite_link', 'channel_invite_already_member',
    'channel_invite_creator_host', 'channel_invite_busy_retry',
  ];
  for (const lang of ['en', 'de', 'es', 'pt', 'ru', 'ja', 'zh']) {
    const json = JSON.parse(readFileSync(new URL(`../i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of keys) assert.equal(typeof json[k], 'string', `${lang}:${k}`);
    assert.match(json.channel_invite_required_desc, /\{\{address\}\}/);
    assert.match(json.channel_invite_expired, /\{\{date\}\}/);
    assert.match(json.channel_invite_valid_until, /\{\{date\}\}/);
  }
});
