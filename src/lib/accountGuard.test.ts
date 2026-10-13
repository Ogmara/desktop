/**
 * accountGuard (desktop 1.82.0). Run:
 *   node --conditions=browser --test src/lib/accountGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stillSameAccount } from './accountGuard.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);

test('every signal must still be the captured account', () => {
  assert.equal(stillSameAccount(A, A, A), true);
  assert.equal(stillSameAccount(A, B, A), false, 'walletAddress flipped');
  assert.equal(stillSameAccount(A, A, B), false, 'signer / scope flipped first');
  assert.equal(stillSameAccount(A, A, undefined), false, 'signer gone');
  assert.equal(stillSameAccount(A, null), false, 'signed out');
});

test('no captured account is never "the same"', () => {
  assert.equal(stillSameAccount(null, null), false);
  assert.equal(stillSameAccount(undefined, undefined, undefined), false);
  assert.equal(stillSameAccount('', ''), false);
});

// Source probe: ChannelCreateView checks the account after the on-chain wait
// and before both the L2 signature and the joined-channels write.
test('ChannelCreateView: account re-checked before createChannel and before addJoinedChannel', () => {
  const src = readFileSync(new URL('../pages/ChannelCreateView.tsx', import.meta.url), 'utf8');
  const confirm = src.indexOf('await getChannelIdFromTx(');
  const sign = src.indexOf('await client.createChannel(');
  const join = src.indexOf('addJoinedChannel(resp.channel_id)');
  assert.ok(confirm > 0 && sign > confirm && join > sign);
  const between = (a: number, b: number) => src.slice(a, b);
  assert.match(between(confirm, sign), /if \(!sameAccount\(\)\) \{\s*setInterrupted\('channel_create_interrupted'\);\s*return;/);
  assert.match(between(confirm, sign), /if \(!sameAccount\(\)\) \{\s*setInterrupted\('channel_create_interrupted_private'\);\s*return;/);
  const post = between(sign, join);
  assert.match(post, /if \(!sameAccount\(\)\) \{/);
  assert.match(post, /addJoinedChannelFor\(me, resp\.channel_id\)/);
  assert.match(post, /held\.some\(\(e\) => e\.a === me\)/, 'only for a still-held account');
  assert.match(post, /setInterrupted\('channel_create_interrupted_published'\);\s*return;/);
  // The notice is rendered OUTSIDE the auth/registration-gated form.
  const notice = src.indexOf('<Show when={interrupted()}>');
  const gated = src.indexOf("<Show when={authStatus() === 'ready' && isRegistered()}>");
  assert.ok(notice > 0 && gated > 0 && notice < gated, 'interrupted notice must not be inside the gated form');
  assert.match(src, /const sameAccount = \(\) => stillSameAccount\(me, walletAddress\(\), getClient\(\)\.address\);/);
});
