/**
 * Behavioral regression test for `deviceId` account-scoping. Run:
 * node --test src/lib/deviceIdScope.test.ts
 *
 * `settingsScope.test.ts` guards the CLASSIFICATION (that `deviceId` stays
 * listed in `PER_ACCOUNT`) but never exercises `getSetting`/`setSetting`
 * against real storage, so it can't catch a regression where the
 * classification is correct but the resolution mechanism breaks — e.g. a
 * future `getOrCreateDeviceId()` rewrite that reads/writes a raw
 * `localStorage` key directly instead of going through `settings.ts`, which
 * would silently make `device_id` per-install again (protocol §2.4,
 * docs/specs/05-clients.md §5.5.1a: a shared `device_id` across accounts
 * publicly links them). This test exercises the real modules end to end
 * against a fake `localStorage`, the way `deviceEnc.ts`'s
 * `getOrCreateDeviceId()` actually would at runtime.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
}

// `settings.ts` reads localStorage at MODULE TOP LEVEL (initializing a
// reactive signal), not only inside functions — so the shim must be in
// place before that module first evaluates. A static top-level `import`
// would be hoisted ahead of any code in this file, shim included; a dynamic
// `import()` is NOT hoisted, so it's the only way to guarantee ordering here.
(globalThis as unknown as { localStorage: Storage }).localStorage = new MemStorage() as unknown as Storage;
const { getSetting, setSetting } = await import('./settings.ts');
const { setWalletScope } = await import('./walletScope.ts');

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemStorage() as unknown as Storage;
  setWalletScope(null);
});

test('two accounts on one install get two different deviceId values', () => {
  setWalletScope(A);
  assert.equal(getSetting('deviceId'), '', 'a fresh account has no deviceId yet');
  setSetting('deviceId', 'device-for-a');

  setWalletScope(B);
  assert.equal(
    getSetting('deviceId'), '',
    'switching to a different account must NOT see the previous account\'s deviceId',
  );
  setSetting('deviceId', 'device-for-b');

  setWalletScope(A);
  assert.equal(
    getSetting('deviceId'), 'device-for-a',
    'switching back must restore this account\'s OWN deviceId, not the other one',
  );

  setWalletScope(B);
  assert.equal(getSetting('deviceId'), 'device-for-b');
});

test('deviceId is stored under distinct, address-suffixed keys', () => {
  setWalletScope(A);
  setSetting('deviceId', 'device-for-a');
  setWalletScope(B);
  setSetting('deviceId', 'device-for-b');

  const ls = localStorage as unknown as MemStorage;
  assert.equal(ls.getItem(`ogmara.deviceId::${A}`), '"device-for-a"');
  assert.equal(ls.getItem(`ogmara.deviceId::${B}`), '"device-for-b"');
  // The bare, pre-namespacing key must never hold a live value once any
  // account is scoped — that's the legacy slot the adoption migration reads
  // from, not somewhere a scoped write should land.
  assert.equal(ls.getItem('ogmara.deviceId'), null);
});
