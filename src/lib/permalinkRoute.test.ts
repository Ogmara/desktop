/**
 * Inbound permalink parsing for the router / message links (desktop 1.86.0). Run:
 *   node --conditions=browser --test src/lib/permalinkRoute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permalinkFromHashRoute, permalinkFromUrl, routeForPermalink } from './permalinkRoute.ts';

const A = 'a'.repeat(64);
const U = 'F'.repeat(64);

test('hash routes: chat / news / comment / join', () => {
  assert.deepEqual(permalinkFromHashRoute(`chat/12?msg=${U}`), { kind: 'chat', channelId: 12, msgId: U.toLowerCase() });
  assert.deepEqual(permalinkFromHashRoute(`#/news/${A}`), { kind: 'news', msgId: A });
  assert.deepEqual(permalinkFromHashRoute(`/news/${A}?c=${A}`), { kind: 'news', msgId: A, commentId: A });
  assert.deepEqual(
    permalinkFromHashRoute(`join/5000000001?node=${encodeURIComponent('https://n.example:8443')}&inv=abc_-`),
    { kind: 'join', channelId: 5000000001, node: 'https://n.example:8443', inv: 'abc_-' },
  );
});

test('hash routes: non-permalinks and hostile input are null', () => {
  assert.equal(permalinkFromHashRoute('chat/12'), null); // bare channel
  assert.equal(permalinkFromHashRoute('chat/12?msg=xyz'), null);
  assert.equal(permalinkFromHashRoute(`chat/012?msg=${A}`), null); // non-canonical id
  assert.equal(permalinkFromHashRoute(`chat/12?msg=${A}&msg=${A}`), null); // repeated key
  assert.equal(permalinkFromHashRoute(`chat/12/x?msg=${A}`), null); // extra segment
  assert.equal(permalinkFromHashRoute(`chat/12?msg=${A}#x`), null); // second #
  assert.equal(permalinkFromHashRoute('join/5?node=javascript:alert(1)'), null);
  assert.equal(permalinkFromHashRoute('user/klv1abc'), null);
  assert.equal(permalinkFromHashRoute(`chat/1?msg=${A}`.padEnd(9000, 'x')), null);
});

test('legacy double-encoded ?node= on invite links still resolves', () => {
  const node = 'https://node.example';
  const twice = encodeURIComponent(encodeURIComponent(node));
  assert.deepEqual(permalinkFromHashRoute(`join/7?node=${twice}`), { kind: 'join', channelId: 7, node });
  // The retry never upgrades a non-join route.
  assert.equal(permalinkFromHashRoute(`chat/7?node=${twice}`), null);
});

test('message links: canonical + own app base, never look-alike hosts', () => {
  assert.deepEqual(permalinkFromUrl(`https://ogmara.org/app/#/chat/3?msg=${A}`), { kind: 'chat', channelId: 3, msgId: A });
  assert.equal(permalinkFromUrl(`https://ogmara.org.evil.tld/app/#/chat/3?msg=${A}`), null);
  assert.equal(permalinkFromUrl(`https://evil@ogmara.org/app/#/chat/3?msg=${A}`), null);
  assert.equal(permalinkFromUrl(`http://ogmara.org/app/#/chat/3?msg=${A}`), null);
  assert.equal(permalinkFromUrl(`https://self.example/app/#/chat/3?msg=${A}`), null);
  assert.deepEqual(
    permalinkFromUrl(`https://self.example/app/#/chat/3?msg=${A}`, 'https://self.example/app'),
    { kind: 'chat', channelId: 3, msgId: A },
  );
  // An unusable app base falls back to the canonical base instead of throwing.
  assert.deepEqual(permalinkFromUrl(`https://ogmara.org/app/#/news/${A}`, 'tauri://localhost'), { kind: 'news', msgId: A });
  assert.equal(permalinkFromUrl(`ogmara://chat/3?msg=${A}`), null);
});

test('routeForPermalink rebuilds a canonical in-app route', () => {
  assert.equal(routeForPermalink({ kind: 'chat', channelId: 3, msgId: U }), `/chat/3?msg=${U.toLowerCase()}`);
  assert.equal(routeForPermalink({ kind: 'news', msgId: A, commentId: A }), `/news/${A}?c=${A}`);
  assert.equal(routeForPermalink({ kind: 'join', channelId: 4, node: 'https://n.example' }), `/join/4?node=${encodeURIComponent('https://n.example')}`);
  assert.equal(routeForPermalink({ kind: 'chat', channelId: 0, msgId: A }), null);
});
