/**
 * wipeWalletScope also removes the Sidebar's single-colon list caches
 * (desktop 1.82.0). Run:
 *   node --conditions=browser --test src/lib/walletScopeWipe.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
}
const storage = new MemStorage();
(globalThis as unknown as { localStorage: Storage }).localStorage = storage as unknown as Storage;
const { wipeWalletScope, LEGACY_LIST_CACHE_PREFIXES } = await import('./walletScope.ts');

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);
const NODE = 'https://node.example:8443';

test('removes A\'s channel/DM list caches on every node, keeps B\'s and global keys', () => {
  storage.setItem(`channelsCache:${NODE}:${A}`, '[1]');
  storage.setItem(`dmConvsCache:${NODE}:${A}`, '[2]');
  storage.setItem(`channelsCache:http://other:9000:${A}`, '[3]');
  storage.setItem(`ogmara.lastChannel::${A}`, '5');
  storage.setItem(`channelsCache:${NODE}:${B}`, '[4]');
  storage.setItem(`dmConvsCache:${NODE}:${B}`, '[5]');
  storage.setItem(`ogmara.lastChannel::${B}`, '6');
  storage.setItem('ogmara.sidebarWidth', '320');
  storage.setItem(`channelsCache:${NODE}:`, '[]'); // signed-out cache, not A's

  wipeWalletScope(A);

  const left = [...storage.m.keys()].sort();
  assert.deepEqual(left, [
    `channelsCache:${NODE}:`,
    `channelsCache:${NODE}:${B}`,
    `dmConvsCache:${NODE}:${B}`,
    `ogmara.lastChannel::${B}`,
    'ogmara.sidebarWidth',
  ].sort());
});

test('Sidebar still builds the cache keys with the prefixes the wipe matches', () => {
  const src = readFileSync(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8');
  assert.match(src, /const CHANNELS_CACHE_PREFIX = 'channelsCache:';/);
  assert.match(src, /const DM_CACHE_PREFIX = 'dmConvsCache:';/);
  assert.match(src, /CHANNELS_CACHE_PREFIX \+ \(getCurrentNodeUrl\(\) \|\| ''\) \+ ':' \+ \(walletAddress\(\) \|\| ''\)/);
  assert.deepEqual([...LEGACY_LIST_CACHE_PREFIXES], ['channelsCache:', 'dmConvsCache:']);
});

test('mergeJoinedSlot: appends once, preserves existing ids, tolerates junk', async () => {
  const { mergeJoinedSlot } = await import('./joinedSlot.ts');
  assert.equal(mergeJoinedSlot('[3]', 7), '[3,7]');
  assert.equal(mergeJoinedSlot('[3,7]', 7), null, 'no duplicate write');
  // A missing slot stays missing, so the account's first live sync still
  // seeds its default + private channels (storageInitialized() === false).
  assert.equal(mergeJoinedSlot(null, 7), null);
  assert.equal(mergeJoinedSlot('[]', 7), '[7]');
  assert.equal(mergeJoinedSlot('not json', 7), '[7]');
  assert.equal(mergeJoinedSlot('[3,"x",null]', 7), '[3,7]');
});

test('addJoinedChannelFor: active account via the signal, others via their OWN slot', () => {
  const src = readFileSync(new URL('./joined-channels.ts', import.meta.url), 'utf8');
  const start = src.indexOf('export function addJoinedChannelFor(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /if \(address === getWalletScope\(\)\) \{ addJoinedChannel\(channelId\); return; \}/);
  assert.match(body, /const key = `\$\{STORAGE_KEY\}\$\{SEP\}\$\{address\}`;/);
  assert.doesNotMatch(body, /scopedSet|persistJoined/, 'must never write the ACTIVE account for another one');
});
