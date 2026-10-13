/**
 * Visible-only unread totals (desktop 1.82.0). Run:
 *   node --conditions=browser --test src/lib/unreadTotals.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumVisibleUnread } from './unreadTotals.ts';

test('sums only the visible ids', () => {
  const map = { '1': 3, '2': 99, '3': 99, '4': 5 };
  assert.equal(sumVisibleUnread(map, new Set(['1', '4'])), 8);
});

test('never-joined public channels (node caps at ~99 each) do not count', () => {
  const map: Record<string, number> = { '1': 2 };
  for (let i = 100; i < 110; i++) map[String(i)] = 99;
  assert.equal(sumVisibleUnread(map, new Set(['1'])), 2);
});

test('visible ids with no entry contribute 0', () => {
  assert.equal(sumVisibleUnread({ '1': 4 }, new Set(['1', '2', '3'])), 4);
});

test('empty / missing inputs are 0', () => {
  assert.equal(sumVisibleUnread({}, new Set(['1'])), 0);
  assert.equal(sumVisibleUnread({ '1': 4 }, new Set()), 0);
  assert.equal(sumVisibleUnread(null, new Set(['1'])), 0);
  assert.equal(sumVisibleUnread(undefined, new Set(['1'])), 0);
});

test('malformed counts are ignored rather than poisoning the total', () => {
  const map = { '1': 2, '2': -5, '3': Number.NaN, '4': Infinity, '5': '7' as unknown as number };
  assert.equal(sumVisibleUnread(map, new Set(['1', '2', '3', '4', '5'])), 2);
});

test('does not mutate the raw map', () => {
  const map = { '1': 1, '2': 2 };
  const copy = { ...map };
  sumVisibleUnread(map, new Set(['1']));
  assert.deepEqual(map, copy);
});
