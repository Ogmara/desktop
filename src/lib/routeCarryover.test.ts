/**
 * Per-account route carry-over on account switch (desktop 1.82.0). Run:
 *   node --conditions=browser --test src/lib/routeCarryover.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neutralRouteFor, isAccountChange, routeAfterAccountChange } from './routeCarryover.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);

test('first login (nothing -> A) never moves the route: deep links survive', () => {
  assert.equal(isAccountChange(null, A), false);
  assert.equal(routeAfterAccountChange('chat', { channelId: '42' }, null, A), null);
  assert.equal(routeAfterAccountChange('dm-conversation', { address: B }, null, A), null);
});

test('in-place switch A -> B leaves per-account detail routes', () => {
  assert.equal(routeAfterAccountChange('chat', { channelId: '42' }, A, B), '/chat');
  assert.equal(routeAfterAccountChange('channel-settings', { channelId: '42' }, A, B), '/chat');
  assert.equal(routeAfterAccountChange('dm-conversation', { address: 'klv1peer' }, A, B), '/dm');
});

test('handover through signed-out (lastActive stays A) still counts as A -> B', () => {
  // The router keeps the last NON-null wallet, so A -> null -> B is A -> B.
  assert.equal(isAccountChange(A, B), true);
  assert.equal(isAccountChange(A, null), false, 'signing out alone does not navigate');
});

test('same account, or neutral / public routes, are left alone', () => {
  assert.equal(routeAfterAccountChange('chat', { channelId: '42' }, A, A), null);
  assert.equal(routeAfterAccountChange('chat', {}, A, B), null);
  for (const v of ['dm', 'news', 'news-detail', 'user', 'follow-list', 'search', 'settings', 'channel-join', 'wallet']) {
    assert.equal(routeAfterAccountChange(v, { address: 'x', msgId: 'y', channelId: '1' }, A, B), null, v);
  }
});

test('neutralRouteFor covers exactly the per-account detail views', () => {
  assert.equal(neutralRouteFor('chat'), '/chat');
  assert.equal(neutralRouteFor('channel-settings'), '/chat');
  assert.equal(neutralRouteFor('dm-conversation'), '/dm');
  assert.equal(neutralRouteFor('channel-join'), null);
  assert.equal(neutralRouteFor('news-detail'), null);
});
