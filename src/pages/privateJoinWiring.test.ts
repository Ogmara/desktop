/**
 * Source probes for the private-channel invite gate wiring (desktop 1.83.0). Run:
 *   node --conditions=browser --test src/pages/privateJoinWiring.test.ts
 *
 * The decision logic is unit-tested in lib/privateInvite.test.ts; these probes
 * pin the parts that live in components: the private join always carries the
 * invite, every await is followed by the account re-check, and the bare
 * private copy-link is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const join = readFileSync(new URL('./ChannelJoinView.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('./ChannelSettingsView.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');

function body(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = async`);
  assert.ok(start > 0, `${name} not found`);
  const next = src.indexOf('\n  const ', start + 10);
  return src.slice(start, next > 0 ? next : undefined);
}

test('private join: every federate/join carries the invite, re-checked after each await', () => {
  const b = body(join, 'handlePrivateJoin');
  const calls = b.match(/client\.(federateChannel|joinChannel)\([^)]*\)/g) ?? [];
  assert.ok(calls.length >= 3);
  for (const c of calls) assert.match(c, /\{ invite \}/, c);
  // Captured BEFORE any await: wallet, switch generation, route.
  const firstAwait = b.indexOf('await ');
  for (const cap of ['const me = walletAddress()', 'const gen = currentSwitchGeneration()', 'const routeId = props.channelId']) {
    const i = b.indexOf(cap);
    assert.ok(i > 0 && i < firstAwait, cap);
  }
  // Every awaited federate/join is followed by a same() check before the next write.
  const awaits = [...b.matchAll(/await client\.(federateChannel|joinChannel)/g)].map((m) => m.index!);
  const add = b.indexOf('addJoinedChannel(cid)');
  for (const a of awaits) {
    const nextCheck = b.indexOf('if (!same()) return;', a);
    assert.ok(nextCheck > a && nextCheck < add, 'missing re-check after await at ' + a);
  }
  // The Join requires a joinable invite re-evaluated against the exact clock.
  assert.match(b, /evaluateInvite\(state\.candidate, evalCtx\(Date\.now\(\)\)\)/);
  assert.match(b, /!isJoinableInvite\(fresh\)/);
});

test('public handlers refuse gated channels; gated channels never reach them', () => {
  assert.match(body(join, 'handlePublicJoin'), /if \(isGated\(\)\) return;/);
  assert.match(body(join, 'handlePublicFederateAndJoin'), /isGated\(\)\) return;/);
  // The only private Join button is inside the joinable-invite branch.
  const gate = join.slice(join.indexOf('const PrivateGate'), join.indexOf('return (\n    <div class="join-view">'));
  const btns = gate.match(/onClick=\{handlePrivateJoin\}/g) ?? [];
  assert.equal(btns.length, 1);
  assert.ok(gate.indexOf('isJoinableInvite(inviteState())') < gate.indexOf('onClick={handlePrivateJoin}'));
});

test('public-path decisions are floor-aware; membership uses the LOCAL record only', () => {
  assert.doesNotMatch(join, /isInviteGatedType/);
  assert.match(join, /const isGated = \(\) => isInviteGatedChannel\(shownDetail\(\)\?\.channel\?\.channel_type, channelIdNum\(\)\);/);
  assert.match(join, /const gated = isInviteGatedChannel\(out\.local\?\.channel\?\.channel_type, cid\);/);
  const m = join.slice(join.indexOf('const membership = () =>'), join.indexOf('const linkInvite'));
  assert.match(m, /if \(!d \|\| !d\.local \|\| authStatus\(\) !== 'ready'\) return 'unknown'/);
  assert.doesNotMatch(m, /cross/);
});

test('creator-host path: federate WITHOUT invite, offered only via isPreviewCreator, guarded', () => {
  const b = body(join, 'handleCreatorHost');
  assert.match(b, /await getClient\(\)\.federateChannel\(cid, host\);/);
  assert.doesNotMatch(b, /joinChannel|\{ invite \}/);
  const firstAwait = b.indexOf('await ');
  for (const cap of ['const me = walletAddress()', 'const gen = currentSwitchGeneration()', 'const routeId = props.channelId']) {
    const i = b.indexOf(cap);
    assert.ok(i > 0 && i < firstAwait, cap);
  }
  assert.ok(b.indexOf('if (!isCreatorHostCase()) return;') < firstAwait);
  const after = b.indexOf('if (!same()) return;', firstAwait);
  assert.ok(after > firstAwait && after < b.indexOf('addJoinedChannel(cid)'));
  // Error mapping order: account check, busy (429/503), node refusal -> invite-required, raw.
  const c0 = b.indexOf('catch (e: any)');
  const iSame = b.indexOf('if (!same()) return;', c0);
  const iBusy = b.indexOf("if (isTransientFederateError(e)) setError(t('channel_invite_busy_retry'));", c0);
  const iRej = b.indexOf('else if (isPrivateJoinRejection(e, true)) setInviteRejected(true);', c0);
  const iRaw = b.indexOf("else setError(e?.message || t('channel_federate_failed'));", c0);
  assert.ok(c0 > 0 && iSame > c0 && iBusy > iSame && iRej > iBusy && iRaw > iRej, 'creator-host catch order');
  const c = join.slice(join.indexOf('const isCreatorHostCase'), join.indexOf('const handleCreatorHost'));
  assert.match(c, /if \(!d \|\| d\.local \|\| !d\.cross/);
  assert.match(c, /if \(inviteRejected\(\)\) return false;/, 'a refused creator claim must not re-offer the action');
  assert.match(c, /isPreviewCreator\(walletAddress\(\), ch\?\.creator, ch\?\.channel_id, channelIdNum\(\)\)/);
  // The preview creator is never membership evidence.
  const m = join.slice(join.indexOf('const membership = () =>'), join.indexOf('const linkInvite'));
  assert.doesNotMatch(m, /isPreviewCreator/);
});

test('private join maps 429/503 to the localized busy message', () => {
  assert.match(body(join, 'handlePrivateJoin'), /if \(isTransientFederateError\(e\)\) setError\(t\('channel_invite_busy_retry'\)\);/);
});

test('fetched data is tagged and ignored for another channel / wallet / link', () => {
  assert.match(join, /d\.id !== props\.channelId/);
  assert.match(join, /d\.wallet !== \(walletAddress\(\) \?\? null\)/);
  assert.match(join, /d\.inv !== \(queryParam\('inv'\) \?\? ''\)/);
});

test('existing member: "open channel" only on positive evidence, signs nothing', () => {
  const open = join.slice(join.indexOf('const handleOpenChannel'), join.indexOf('const handlePrivateJoin'));
  assert.match(open, /if \(!isMemberState\(resolveJoinInvite\(null, null, evalCtx\(Date\.now\(\)\)\)\)\) return;/);
  assert.doesNotMatch(open, /joinChannel|federateChannel|await /);
});

test('settings: no bare link for private, personal link tagged with wallet+generation+channel', () => {
  assert.match(settings, /<Show when=\{isPublicPathChannel\(\)\}>\s*<div class="ch-section">\s*<button class="ch-link-btn" onClick=\{handleCopyLink\}>/);
  assert.match(settings, /const handleCopyLink = \(\) => \{\s*if \(!isPublicPathChannel\(\)\) return;/);
  assert.match(settings, /isPublicPathChannel = \(\) =>\s*channelTypeKnown\(\) && recordIsForRoute\(\) && !isInviteGatedChannel\(channelType\(\), channelIdNum\(\)\)/);
  assert.match(settings, /const recordIsForRoute = \(\) => detail\(\)\?\.channel\?\.channel_id === channelIdNum\(\);/);
  assert.match(settings, /const priv = isInviteGated\(\);/);
  assert.doesNotMatch(settings, /buildChannelInviteUrl\([^)]*getCurrentNodeUrl/);
  assert.match(settings, /li\.wallet !== walletAddress\(\) \|\| li\.gen !== currentSwitchGeneration\(\) \|\| li\.channelId !== props\.channelId/);
  const inv = body(settings, 'handleInviteUser');
  const aw = inv.indexOf('await getClient().inviteUser(');
  assert.ok(inv.indexOf('const me = walletAddress()') < aw);
  assert.ok(inv.indexOf('if (changed()) return;', aw) > aw);
  assert.match(inv, /inviteTtlFromPicker\(inviteTtlMs\(\)\)/);
});

test('channel_invite notification routes to the join page without the envelope', () => {
  const notif = readFileSync(new URL('./NotificationsView.tsx', import.meta.url), 'utf8');
  assert.match(notif, /case 'channel_invite': \{[\s\S]*?joinRouteForInviteNotification\(notif\)[\s\S]*?navigate\(r\)/);
  assert.doesNotMatch(notif, /invite_envelope/);
});

test('ChatView never auto-joins a private channel (unchanged gate)', () => {
  assert.match(chat, /shouldAutoJoinEncryptedChannel\(/);
  assert.doesNotMatch(chat, /joinChannel\([^)]*invite/);
});
