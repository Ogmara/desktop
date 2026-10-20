/**
 * hashQuery (desktop 1.83.0). Run:
 *   node --conditions=browser --test src/lib/hashQuery.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitHashRoute } from './hashQuery.ts';

const INV = 'gqd2ZXJzaW9uAahtc2dfdHlwZa1DaGFubmVsSW52aXRl-_x'; // base64url alphabet incl. - and _
const NODE = 'https://node.example:8443/base';

test('personal invite link: node= and inv= arrive intact', () => {
  const { path, query } = splitHashRoute(`join/5000000001?node=${encodeURIComponent(NODE)}&inv=${INV}`);
  assert.equal(path, 'join/5000000001');
  assert.equal(query.node, NODE);
  assert.equal(query.inv, INV);
});

test('values containing = or ? are not truncated', () => {
  const { query } = splitHashRoute('join/1?inv=YWJj==&q=a?b');
  assert.equal(query.inv, 'YWJj==');
  assert.equal(query.q, 'a?b');
  // Negative control: the old split('=') / split('?') parser would have cut these.
  assert.notEqual('YWJj=='.split('=')[0], query.inv);
});

test('a malformed escape drops that pair only, never throws', () => {
  const r = splitHashRoute('join/1?node=%E0%A4%A&inv=abc');
  assert.equal(r.query.inv, 'abc');
  assert.equal('node' in r.query, false);
});

test('no query, empty keys, bare keys', () => {
  assert.deepEqual({ ...splitHashRoute('chat').query }, {});
  assert.equal(splitHashRoute('chat').path, 'chat');
  assert.deepEqual({ ...splitHashRoute('chat?=x&&flag').query }, { flag: '' });
});

test('__proto__ key is plain data, not prototype pollution', () => {
  const { query } = splitHashRoute('chat?__proto__=x');
  assert.equal(Object.getPrototypeOf(query), null);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});
