/**
 * share.ts wrappers over the SDK's buildPermalink (desktop 1.86.0). Run:
 *   node --conditions=browser --test src/lib/share.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePermalink } from '@ogmara/sdk';
import { buildChatShareUrl, buildNewsShareUrl, buildChannelInviteUrl, SHARE_PARSE_OPTIONS } from './share.ts';

const A = 'a'.repeat(64);
const B = 'B'.repeat(64);

test('chat link: canonical form, lower-cased id, numeric or string channel id', () => {
  assert.equal(buildChatShareUrl(7, B), `https://ogmara.org/app/#/chat/7?msg=${B.toLowerCase()}`);
  assert.equal(buildChatShareUrl('7', A), `https://ogmara.org/app/#/chat/7?msg=${A}`);
});

test('chat link: invalid ids return null', () => {
  assert.equal(buildChatShareUrl(0, A), null);
  assert.equal(buildChatShareUrl(-1, A), null);
  assert.equal(buildChatShareUrl('07', A), null);
  assert.equal(buildChatShareUrl('1e3', A), null);
  assert.equal(buildChatShareUrl(2 ** 53, A), null);
  assert.equal(buildChatShareUrl(1, 'abc'), null);
  assert.equal(buildChatShareUrl(1, A + 'a'), null);
});

test('news post + comment links', () => {
  assert.equal(buildNewsShareUrl(A), `https://ogmara.org/app/#/news/${A}`);
  assert.equal(buildNewsShareUrl(A, B), `https://ogmara.org/app/#/news/${A}?c=${B.toLowerCase()}`);
  assert.equal(buildNewsShareUrl(A, 'nope'), null);
  assert.equal(buildNewsShareUrl('nope'), null);
});

test('invite link: valid node kept (encoded), unusable node dropped, bad id null', () => {
  const node = 'https://node.example:8443/x';
  assert.equal(buildChannelInviteUrl(5), 'https://ogmara.org/app/#/join/5');
  assert.equal(buildChannelInviteUrl(5, node), `https://ogmara.org/app/#/join/5?node=${encodeURIComponent(node)}`);
  assert.equal(buildChannelInviteUrl(5, 'javascript:alert(1)'), 'https://ogmara.org/app/#/join/5');
  assert.equal(buildChannelInviteUrl(5, 'https://ogmara.org@evil.example'), 'https://ogmara.org/app/#/join/5');
  assert.equal(buildChannelInviteUrl('x'), null);
});

test('every built link round-trips through parsePermalink', () => {
  const node = 'https://node.example/';
  assert.deepEqual(parsePermalink(buildChatShareUrl(9, A)!, SHARE_PARSE_OPTIONS), { kind: 'chat', channelId: 9, msgId: A });
  assert.deepEqual(parsePermalink(buildNewsShareUrl(A, B)!, SHARE_PARSE_OPTIONS), { kind: 'news', msgId: A, commentId: B.toLowerCase() });
  assert.deepEqual(parsePermalink(buildChannelInviteUrl(3, node)!, SHARE_PARSE_OPTIONS), { kind: 'join', channelId: 3, node });
});
