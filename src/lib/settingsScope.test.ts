/**
 * Settings classification. Run: node --test src/lib/settingsScope.test.ts
 *
 * Guards the one mistake this classification invites: adding a Settings key
 * and forgetting to decide whether it belongs to the ACCOUNT or the INSTALL.
 * Forgetting defaults it to install-scope, so a per-account value silently
 * leaks between accounts — which is the whole bug class this work exists to
 * close, reintroduced one key at a time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Mirrors `settings.ts`'s PER_ACCOUNT set. Duplicated deliberately: importing
 * `settings.ts` would drag in `walletScope` and `localStorage`, and the point
 * is to notice when the two lists diverge.
 */
const PER_ACCOUNT = [
  'pinnedChannels', 'mutedChannels', 'mutedUsers', 'lastChannel',
  'newsLastReadGlobal', 'newsLastReadFollowing', 'newsLastViewedAt',
  'deviceRegistered', 'encKeyBound', 'deviceId',
];

/** Keys that belong to the install and MUST stay global. */
const INSTALL = [
  'lang', 'theme', 'designStyle', 'colorScheme', 'fontSize', 'compactLayout',
  'notificationSound', 'notificationPreview', 'pushEnabled', 'mediaAutoload',
  'nodeUrl', 'knownNodes', 'defaultNodeUrl', 'pushGatewayUrl', 'kleverNetwork',
  'sidebarCollapsed', 'channelsExpanded', 'defaultLandingView', 'currency',
  'defaultFeed',
  // Deliberately global: they identify WHICH account is active, so scoping
  // them to that account is self-referential and unbootstrappable.
  'walletAddress', 'walletSource',
];

test('the two classifications are disjoint', () => {
  const overlap = PER_ACCOUNT.filter((k) => INSTALL.includes(k));
  assert.deepEqual(overlap, [], 'a key cannot be both account- and install-scoped');
});

test('the wallet pointer keys are NOT account-scoped', () => {
  // Scoping these would make the scope unbootstrappable: resolving them would
  // require already knowing the account they identify.
  for (const k of ['walletAddress', 'walletSource']) {
    assert.ok(!PER_ACCOUNT.includes(k), `${k} must stay global`);
    assert.ok(INSTALL.includes(k), `${k} must be listed as install-scoped`);
  }
});

test('every key in the real PER_ACCOUNT list is accounted for here', async () => {
  // Reads the source rather than importing it, so a key added there without a
  // matching decision here fails loudly.
  const src = await (await import('node:fs/promises')).readFile('src/lib/settings.ts', 'utf8');
  const block = src.slice(src.indexOf('const PER_ACCOUNT'), src.indexOf('] as (keyof Settings)[]'));
  const declared = [...block.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    declared.sort(),
    [...PER_ACCOUNT].sort(),
    'settings.ts PER_ACCOUNT and this test have diverged — classify the new key',
  );
});

test('no Settings key is left unclassified', async () => {
  const src = await (await import('node:fs/promises')).readFile('src/lib/settings.ts', 'utf8');
  const iface = src.slice(src.indexOf('export interface Settings {'), src.indexOf('\n}', src.indexOf('export interface Settings {')));
  const keys = [...iface.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
  const known = new Set([...PER_ACCOUNT, ...INSTALL]);
  const unclassified = keys.filter((k) => !known.has(k));
  assert.deepEqual(
    unclassified, [],
    'new Settings key(s) with no scope decision — an unclassified key defaults to GLOBAL and leaks between accounts',
  );
});
