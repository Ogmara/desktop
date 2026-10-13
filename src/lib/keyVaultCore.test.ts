/**
 * Key-recovery vault account binding (desktop 1.82.0). Run:
 *   node --conditions=browser --test src/lib/keyVaultCore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackupKeyCache, runRestore, runPublish, type BackupKey } from './keyVaultCore.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);
const keyOf = (w: string) => new Uint8Array([w === A ? 0xaa : 0xbb]);

/** A derivation whose completion the test controls. */
function deferredDerive() {
  const pending: { wallet: string; resolve: () => void }[] = [];
  const calls: string[] = [];
  const derive = (wallet: string) => {
    calls.push(wallet);
    return new Promise<Uint8Array>((res) => pending.push({ wallet, resolve: () => res(keyOf(wallet)) }));
  };
  return { derive, pending, calls };
}

// --- backup-key cache -------------------------------------------------------

test('cache: concurrent callers for the SAME wallet share one derivation', async () => {
  const d = deferredDerive();
  const c = createBackupKeyCache(d.derive);
  const p1 = c.ensure(A); const p2 = c.ensure(A);
  d.pending[0].resolve();
  assert.deepEqual([(await p1)!.wallet, (await p2)!.wallet], [A, A]);
  assert.deepEqual(d.calls, [A]);
});

test('cache: an in-flight derivation for A is NEVER handed to a caller asking for B', async () => {
  const d = deferredDerive();
  const c = createBackupKeyCache(d.derive);
  const pa = c.ensure(A);
  const pb = c.ensure(B); // pre-fix: returned A's inflight promise
  assert.deepEqual(d.calls, [A, B], 'B gets its own derivation');
  d.pending[0].resolve(); d.pending[1].resolve();
  assert.equal((await pa)!.wallet, A);
  const kb = (await pb)!;
  assert.equal(kb.wallet, B);
  assert.deepEqual([...kb.key], [0xbb]);
});

test('cache: clear() abandons the in-flight derivation — its result is dropped, not cached', async () => {
  const d = deferredDerive();
  const c = createBackupKeyCache(d.derive);
  const pa = c.ensure(A);
  c.clear(); // account switch
  d.pending[0].resolve();
  assert.equal(await pa, null);
  assert.equal(c.cachedWallet(), null);
  // And a later ensure(A) derives afresh instead of joining the abandoned one.
  const pa2 = c.ensure(A);
  assert.equal(d.calls.length, 2);
  d.pending[1].resolve();
  assert.equal((await pa2)!.wallet, A);
});

test('cache: a failed derivation resolves null and re-arms', async () => {
  let fail = true;
  const c = createBackupKeyCache(async (w) => { if (fail) throw new Error('declined'); return keyOf(w); });
  assert.equal(await c.ensure(A), null);
  fail = false;
  assert.equal((await c.ensure(A))!.wallet, A);
});

// --- restore ------------------------------------------------------------------

function restoreHarness(opts: { ensureKey?: (w: string | null) => Promise<BackupKey | null>; openThrows?: boolean; flipDuringKey?: boolean } = {}) {
  let active = A as string;
  const imported: unknown[] = [];
  const deps = {
    forWallet: A,
    stale: () => active !== A,
    ensureKey: opts.ensureKey ?? (async (w: string | null) => {
      if (opts.flipDuringKey) active = B;
      return w ? { wallet: w, key: keyOf(w) } : null;
    }),
    fetch: async () => ({ blob: 1 }),
    open: (key: Uint8Array) => {
      if (opts.openThrows) throw new Error('auth fail');
      return { by: key[0] };
    },
    importKeys: (kr: unknown) => { imported.push(kr); },
  };
  return { deps, imported };
}

test('restore control: same account → imports and is done', async () => {
  const h = restoreHarness();
  assert.equal(await runRestore(h.deps), 'done');
  assert.deepEqual(h.imported, [{ by: 0xaa }]);
});

test('restore: switch during ensureBackupKey → no import, NOT done (so no backup is re-armed)', async () => {
  const h = restoreHarness({ flipDuringKey: true });
  assert.equal(await runRestore(h.deps), 'idle');
  assert.deepEqual(h.imported, []);
});

test('restore: a key derived for ANOTHER wallet is refused — no import, not done', async () => {
  const h = restoreHarness({ ensureKey: async () => ({ wallet: B, key: keyOf(B) }) });
  assert.equal(await runRestore(h.deps), 'idle');
  assert.deepEqual(h.imported, []);
});

test('restore: decrypt failure with THIS wallet\'s key and nothing moved is terminal (corrupt blob)', async () => {
  const h = restoreHarness({ openThrows: true });
  assert.equal(await runRestore(h.deps), 'done');
});

test('restore: decrypt failure after a switch is NOT terminal', async () => {
  let active = A;
  const h = restoreHarness({ openThrows: true });
  const deps = { ...h.deps, stale: () => active !== A, fetch: async () => { active = B; return { blob: 1 }; } };
  assert.equal(await runRestore(deps), 'idle');
});

test('restore mutation control: the pre-fix shape (key wallet unchecked) WOULD import B-keyed data', async () => {
  // Same "foreign key" scenario through a deliberately weakened guard proves
  // the harness can see the bug the real code refuses.
  const h = restoreHarness({ ensureKey: async () => ({ wallet: B, key: keyOf(B) }) });
  const weakened = { ...h.deps, ensureKey: async () => ({ wallet: A, key: keyOf(B) }) }; // mislabelled, as the old inflight sharing produced
  assert.equal(await runRestore(weakened), 'done');
  assert.deepEqual(h.imported, [{ by: 0xbb }], 'mislabelled key flows straight through — which is why labels must come from the derivation itself');
});

// --- publish ------------------------------------------------------------------

function publishHarness(opts: { keyWallet?: string; flipDuringKey?: boolean; empty?: boolean } = {}) {
  let active = A as string;
  const sent: unknown[] = [];
  const deps = {
    sealWallet: A,
    stale: () => active !== A,
    keyring: { conv: opts.empty ? {} : { x: 1 } },
    isEmpty: (k: { conv: Record<string, number> }) => Object.keys(k.conv).length === 0,
    ensureKey: async (w: string | null) => {
      if (opts.flipDuringKey) active = B;
      return w ? { wallet: opts.keyWallet ?? w, key: keyOf(opts.keyWallet ?? w) } : null;
    },
    seal: (key: Uint8Array, k: unknown) => ({ key: key[0], k }),
    send: async (s: unknown) => { sent.push(s); },
  };
  return { deps, sent };
}

test('publish control: seals with this wallet\'s key and sends', async () => {
  const h = publishHarness();
  assert.equal(await runPublish(h.deps), true);
  assert.equal(h.sent.length, 1);
});

test('publish: switch during ensureBackupKey → nothing sealed or sent', async () => {
  const h = publishHarness({ flipDuringKey: true });
  assert.equal(await runPublish(h.deps), false);
  assert.deepEqual(h.sent, []);
});

test('publish: a key tagged for another wallet → nothing sent', async () => {
  const h = publishHarness({ keyWallet: B });
  assert.equal(await runPublish(h.deps), false);
  assert.deepEqual(h.sent, []);
});

test('publish: empty keyring → nothing sent', async () => {
  const h = publishHarness({ empty: true });
  assert.equal(await runPublish(h.deps), false);
});

// Source probe: keyVault.ts wires the core the way these tests assume.
import { readFileSync } from 'node:fs';
test('keyVault.ts: derivation signs strictly as the requested wallet; clear abandons it', () => {
  const src = readFileSync(new URL('./keyVault.ts', import.meta.url), 'utf8');
  assert.match(src, /createBackupKeyCache\(\s*async \(wallet\) => deriveVaultBackupKey\(await signMessageAs\(wallet, VAULT_SIGN_CLAIM\)\)/);
  assert.doesNotMatch(src, /import \{[^}]*\bsignMessage\b[^}]*\} from '\.\/klever'/, 'never the unbound signMessage');
  assert.doesNotMatch(src, /bkInflight|bkWallet/, 'no shared, untagged in-flight state left');
  const clear = src.slice(src.indexOf('export function clearKeyVaultSession'), src.indexOf('\n}\n', src.indexOf('export function clearKeyVaultSession')));
  assert.match(clear, /backupKeys\.clear\(\);/);
  assert.match(clear, /restoreRun\+\+;/);
});
