/**
 * Key-recovery vault account binding (desktop 1.82.0), unreadable / missing
 * remote vault never treated as terminal `done`, and zeroed keys never used
 * (desktop 1.84.0). Controller-level tests (re-arm, backoff, marker, Replace)
 * live in keyVaultController.test.ts.
 * Mutation-style: scenarios that matter run against the real core AND against
 * a copy of the pre-fix (1.83.0) flow, which must reproduce the bug.
 * Run: node --conditions=browser --test src/lib/keyVaultCore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createBackupKeyCache,
  runRestore,
  runPublish,
  usable,
  replaceResultMessageKey,
  type OwnedKey,
  type PublishOutcome,
} from './keyVaultCore.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);
const keyOf = (w: string) => new Uint8Array(32).fill(w === A ? 0xaa : 0xbb);

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
  const pb = c.ensure(B); // pre-1.82.0: returned A's inflight promise
  assert.deepEqual(d.calls, [A, B], 'B gets its own derivation');
  d.pending[0].resolve(); d.pending[1].resolve();
  assert.equal((await pa)!.wallet, A);
  const kb = (await pb)!;
  assert.equal(kb.wallet, B);
  assert.deepEqual(kb.key, keyOf(B));
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

test('cache: clear() zeroes the key a caller still holds; usable() then refuses it', async () => {
  const c = createBackupKeyCache(async (w) => keyOf(w));
  const held = (await c.ensure(A))!;
  assert.equal(usable(held, A), true);
  c.clear();
  assert.ok(held.key.every((b) => b === 0), 'clear() zeroes in place');
  assert.equal(usable(held, A), false);
});

test('cache: an all-zero / empty derivation is never cached or returned', async () => {
  for (const bad of [new Uint8Array(32), new Uint8Array(0)]) {
    const c = createBackupKeyCache(async () => bad);
    assert.equal(await c.ensure(A), null);
    assert.equal(c.cachedWallet(), null);
  }
});

test('usable(): wrong wallet, null, empty and all-zero keys are refused', () => {
  assert.equal(usable(null, A), false);
  assert.equal(usable({ wallet: B, key: keyOf(B) }, A), false);
  assert.equal(usable({ wallet: A, key: new Uint8Array(0) }, A), false);
  assert.equal(usable({ wallet: A, key: new Uint8Array(32) }, A), false);
  const one = new Uint8Array(32); one[31] = 1;
  assert.equal(usable({ wallet: A, key: one }, A), true);
});

// --- runRestore / runPublish ------------------------------------------------

type Keyring = { conv: Record<string, number> };

function harness(opts: { decryptFails?: boolean; remote?: boolean } = {}) {
  const s = { wallet: A as string | null, gen: 1 };
  const imports: Keyring[] = [];
  const opened: number[][] = [];
  const sealed: number[][] = [];
  const sent: unknown[] = [];
  const marked: string[] = [];
  const deps = {
    currentWallet: () => s.wallet,
    generation: () => s.gen,
    log: () => {},
    ensureBackupKey: async (): Promise<OwnedKey | null> => (s.wallet ? { wallet: s.wallet, key: keyOf(s.wallet) } : null),
    fetchVault: async (): Promise<{ of: string } | null> => (opts.remote === false ? null : { of: s.wallet! }),
    open: (key: Uint8Array, _resp: { of: string }): Keyring => {
      opened.push([...key]);
      if (opts.decryptFails) throw new Error('auth fail');
      return { conv: { x: key[0] } };
    },
    importKeys: (kr: Keyring) => { imports.push(kr); return { conv: Object.keys(kr.conv).length }; },
    seenMarker: (_w: string): boolean | null => false,
    markSeen: (w: string) => { marked.push(w); },
    snapshot: (): Keyring => ({ conv: { mine: 1 } }),
    isEmpty: (kr: Keyring) => Object.keys(kr.conv).length === 0,
    seal: (key: Uint8Array, kr: Keyring) => { sealed.push([...key]); return { key: key[0], kr }; },
    publish: async (b: unknown) => { sent.push(b); },
    canPublish: () => true,
  };
  return { s, deps, imports, opened, sealed, sent, marked };
}

/** The pre-fix desktop runRestore (1.83.0) on the same deps: decrypt failure and 404 are terminal `done`. */
async function legacyRestore(d: ReturnType<typeof harness>['deps']): Promise<'idle' | 'done'> {
  const forWallet = d.currentWallet();
  const gen = d.generation();
  const stale = () => d.currentWallet() !== forWallet || d.generation() !== gen;
  if (!forWallet || stale()) return 'idle';
  const bk = await d.ensureBackupKey();
  if (stale() || !bk || bk.wallet !== forWallet) return 'idle';
  let resp;
  try { resp = await d.fetchVault(); } catch { return 'idle'; }
  if (stale()) return 'idle';
  if (resp) {
    let kr;
    try { kr = d.open(bk.key, resp); } catch { return stale() ? 'idle' : 'done'; }
    if (stale()) return 'idle';
    d.importKeys(kr);
  }
  return 'done';
}

/** The pre-fix desktop runPublish (1.83.0): no restore gate, no zero-key check. */
async function legacyPublish(d: ReturnType<typeof harness>['deps']): Promise<boolean> {
  const w = d.currentWallet();
  const kr = d.snapshot();
  if (!w || d.isEmpty(kr)) return false;
  const bk = await d.ensureBackupKey();
  if (!bk || bk.wallet !== w || d.currentWallet() !== w) return false;
  await d.publish(d.seal(bk.key, kr));
  return true;
}

test('restore control: same account -> imports, sets the marker, done', async () => {
  const h = harness();
  assert.equal(await runRestore(h.deps), 'done');
  assert.deepEqual(h.imports, [{ conv: { x: 0xaa } }]);
  assert.deepEqual(h.marked, [A]);
});

test('restore: switch during ensureBackupKey -> stale, nothing fetched or imported', async () => {
  const h = harness();
  let fetched = 0;
  h.deps.ensureBackupKey = async () => { h.s.wallet = B; h.s.gen++; return { wallet: A, key: keyOf(A) }; };
  h.deps.fetchVault = async () => { fetched++; return { of: A }; };
  assert.equal(await runRestore(h.deps), 'stale');
  assert.equal(fetched, 0, 'no GET as the new account');
  assert.deepEqual(h.imports, []);
});

test('restore: A -> B -> A during the fetch is caught by the generation', async () => {
  const h = harness();
  h.deps.fetchVault = async () => { h.s.gen += 2; return { of: A }; };
  assert.equal(await runRestore(h.deps), 'stale');
  assert.deepEqual(h.imports, []);
});

test('restore: a key derived for ANOTHER wallet is refused — no fetch, no import', async () => {
  const h = harness();
  let fetched = 0;
  h.deps.ensureBackupKey = async () => ({ wallet: B, key: keyOf(B) });
  h.deps.fetchVault = async () => { fetched++; return { of: A }; };
  assert.equal(await runRestore(h.deps), 'idle');
  assert.equal(fetched, 0);
  assert.deepEqual(h.imports, []);
});

test("decrypt failure under the account's own key is BLOCKED (unreadable), not terminal done (1.84.0)", async () => {
  const h = harness({ decryptFails: true });
  assert.equal(await runRestore(h.deps), 'unreadable');
  assert.deepEqual(h.imports, []);
  assert.deepEqual(h.marked, [], 'an unreadable vault does not set the marker');
});

test('negative control: the pre-fix restore reports done for an unreadable vault (the next backup overwrote it)', async () => {
  const h = harness({ decryptFails: true });
  assert.equal(await legacyRestore(h.deps), 'done');
});

test('decrypt failure after a switch is stale, never blocked', async () => {
  const h = harness({ decryptFails: true });
  h.deps.fetchVault = async () => { h.s.wallet = B; h.s.gen++; return { of: A }; };
  assert.equal(await runRestore(h.deps), 'stale');
});

test('restore 404: verifiably empty only without the marker; unknown marker stays idle', async () => {
  const mk = (seen: boolean | null) => {
    const h = harness({ remote: false });
    h.deps.seenMarker = () => seen;
    return h;
  };
  assert.equal(await runRestore(mk(false).deps), 'done');
  assert.equal(await runRestore(mk(true).deps), 'missing');
  assert.equal(await runRestore(mk(null).deps), 'idle');
});

test('404 + marker negative control: the pre-fix restore calls it done', async () => {
  const h = harness({ remote: false });
  h.deps.seenMarker = () => true;
  assert.equal(await legacyRestore(h.deps), 'done');
});

test('switch during a fetch that 404s -> stale; the marker is not consulted for the old account', async () => {
  const h = harness({ remote: false });
  let consulted = 0;
  h.deps.fetchVault = async () => { await Promise.resolve(); h.s.wallet = B; h.s.gen++; return null; };
  h.deps.seenMarker = () => { consulted++; return false; };
  assert.equal(await runRestore(h.deps), 'stale');
  assert.equal(consulted, 0);
});

// --- usable(): a key zeroed by clear() while a run held it ------------------

test('restore: key zeroed (session clear) during the fetch -> never opened with zeros, not blocked', async () => {
  const h = harness();
  const owned = { wallet: A, key: keyOf(A) };
  h.deps.ensureBackupKey = async () => owned;
  h.deps.fetchVault = async () => { owned.key.fill(0); return { of: A }; };
  assert.equal(await runRestore(h.deps), 'idle');
  assert.deepEqual(h.opened, [], 'open() never ran');
});

test('restore negative control: without usable() the zero key is opened (pre-fix: a terminal decrypt failure)', async () => {
  const h = harness();
  const owned = { wallet: A, key: keyOf(A) };
  h.deps.ensureBackupKey = async () => owned;
  h.deps.fetchVault = async () => { owned.key.fill(0); return { of: A }; };
  h.deps.open = (key: Uint8Array) => { h.opened.push([...key]); if (key.every((b) => b === 0)) throw new Error('auth fail'); return { conv: {} }; };
  // The pre-fix desktop restore: decrypt failure under "our" key is terminal.
  assert.equal(await legacyRestore(h.deps), 'done');
  assert.deepEqual(h.opened, [new Array(32).fill(0)], 'opened with an all-zero key');
});

test('publish: a key zeroed before sealing -> nothing sealed or sent', async () => {
  const h = harness();
  h.deps.ensureBackupKey = async () => ({ wallet: A, key: new Uint8Array(32) });
  assert.equal(await runPublish(h.deps), 'unavailable');
  assert.deepEqual(h.sealed, []);
  assert.deepEqual(h.sent, []);
});

test('publish negative control: without usable() the keyring is sealed with zeros and sent', async () => {
  const h = harness();
  h.deps.ensureBackupKey = async () => ({ wallet: A, key: new Uint8Array(32) });
  assert.equal(await legacyPublish(h.deps), true);
  assert.deepEqual(h.sealed, [new Array(32).fill(0)]);
  assert.equal(h.sent.length, 1);
});

// --- runPublish ---------------------------------------------------------------

test("publish control: seals with this wallet's key, sends, sets the marker", async () => {
  const h = harness();
  assert.equal(await runPublish(h.deps), 'published');
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.marked, [A]);
});

test('publish: switch during ensureBackupKey -> stale, nothing sealed or sent', async () => {
  const h = harness();
  h.deps.ensureBackupKey = async () => { h.s.wallet = B; h.s.gen++; return { wallet: A, key: keyOf(A) }; };
  assert.equal(await runPublish(h.deps), 'stale');
  assert.deepEqual(h.sealed, []);
  assert.deepEqual(h.sent, []);
});

test('publish: a key tagged for another wallet -> unavailable, nothing sent', async () => {
  const h = harness();
  h.deps.ensureBackupKey = async () => ({ wallet: B, key: keyOf(B) });
  assert.equal(await runPublish(h.deps), 'unavailable');
  assert.deepEqual(h.sent, []);
});

test('publish: empty keyring -> empty, no key derived', async () => {
  const h = harness();
  let derived = 0;
  h.deps.snapshot = () => ({ conv: {} });
  h.deps.ensureBackupKey = async () => { derived++; return { wallet: A, key: keyOf(A) }; };
  assert.equal(await runPublish(h.deps), 'empty');
  assert.equal(derived, 0);
});

test('publish: canPublish() false -> blocked, nothing sealed', async () => {
  const h = harness();
  h.deps.canPublish = () => false;
  assert.equal(await runPublish(h.deps), 'blocked');
  assert.deepEqual(h.sealed, []);
  assert.deepEqual(h.sent, []);
});

test('publish: canPublish() re-checked AFTER the key derivation (state changed while deriving)', async () => {
  const h = harness();
  let allowed = true;
  h.deps.canPublish = () => allowed;
  h.deps.ensureBackupKey = async () => { await Promise.resolve(); allowed = false; return { wallet: A, key: keyOf(A) }; };
  assert.equal(await runPublish(h.deps), 'blocked');
  assert.deepEqual(h.sealed, []);
});

test('publish: a throwing send -> failed, marker not set', async () => {
  const h = harness();
  h.deps.publish = async () => { throw new Error('API error (503)'); };
  assert.equal(await runPublish(h.deps), 'failed');
  assert.deepEqual(h.marked, []);
});

test('signed out at start -> idle / unavailable, nothing touched', async () => {
  const h = harness();
  h.s.wallet = null;
  assert.equal(await runRestore(h.deps), 'idle');
  assert.equal(await runPublish(h.deps), 'unavailable');
  assert.equal(h.imports.length + h.sent.length, 0);
});

// --- source probe: keyVault.ts wires the core the way these tests assume ------

test('keyVault.ts: derivation signs strictly as the requested wallet; clear abandons it; exported API kept', () => {
  const src = readFileSync(new URL('./keyVault.ts', import.meta.url), 'utf8');
  assert.match(src, /createBackupKeyCache\(\s*async \(wallet\) => deriveVaultBackupKey\(await signMessageAs\(wallet, VAULT_SIGN_CLAIM\)\)/);
  assert.match(src, /ensureBackupKey: \(\) => backupKeys\.ensure\(walletAddress\(\)\)/);
  assert.match(src, /currentWallet: walletAddress,\s*\n\s*generation: currentSwitchGeneration,/);
  assert.doesNotMatch(src, /import \{[^}]*\bsignMessage\b[^}]*\} from '\.\/klever'/, 'never the unbound signMessage');
  assert.doesNotMatch(src, /bkInflight|bkWallet/, 'no shared, untagged in-flight state left');
  const clear = src.slice(src.indexOf('export function clearKeyVaultSession'), src.indexOf('\n}\n', src.indexOf('export function clearKeyVaultSession')));
  assert.match(clear, /backupKeys\.clear\(\);/);
  assert.match(clear, /controller\.clearSession\(\);/);
  for (const name of ['clearKeyVaultSession', 'tryRestoreKeyVault', 'retryKeyVault', 'replaceKeyVault', 'keyVaultIssue']) {
    assert.match(src, new RegExp(`export (async )?function ${name}\\(`), `${name} exported`);
  }
  // The marker is read/written only while per-account storage points at the wallet.
  assert.match(src, /function seenMarker\(wallet: string\): boolean \| null \{\s*\n\s*if \(getWalletScope\(\) !== wallet\) return null;/);
  assert.match(src, /function markSeen\(wallet: string\): void \{\s*\n\s*if \(getWalletScope\(\) !== wallet\) return;/);
  // Replace only for the account the user confirmed it for.
  assert.match(src, /export async function replaceKeyVault\(forWallet\?: string\): Promise<PublishOutcome> \{\s*\n\s*if \(forWallet !== undefined && walletAddress\(\) !== forWallet\) return 'stale';/);
});

test('deviceEnc.ts: the enc-key binding signs strictly as the captured wallet', () => {
  const src = readFileSync(new URL('./deviceEnc.ts', import.meta.url), 'utf8');
  assert.match(src, /const sign: WalletSignFn = \(claim\) => signMessageAs\(wallet, claim\);/);
  assert.doesNotMatch(src, /import \{[^}]*\bsignMessage\b[^}]*\} from '\.\/klever'/);
});

// --- Replace result message (audit N1) -------------------------------------
// 'empty' unblocks backups but publishes nothing; the banner must not say the
// backup was replaced. Negative control: the pre-fix mapping (published OR
// empty -> keyvault_replaced) must fail the same assertions.

const LOCALES = ['en', 'de', 'es', 'pt', 'ru', 'ja', 'zh'];
type MsgMap = (out: PublishOutcome) => string | null;

/** Pre-fix (shipped in the first 0.84.0 cut) banner mapping, kept as the control. */
const preFixMapping: MsgMap = (out) =>
  out === 'published' || out === 'empty' ? 'keyvault_replaced' : out === 'failed' ? 'keyvault_replace_failed' : null;

function checkMapping(map: MsgMap): void {
  assert.equal(map('published'), 'keyvault_replaced');
  assert.equal(map('empty'), 'keyvault_replace_nothing');
  assert.equal(map('failed'), 'keyvault_replace_failed');
  for (const quiet of ['stale', 'blocked', 'unavailable'] as const) assert.equal(map(quiet), null, quiet);
}

test('N1: Replace outcome -> banner message; empty never claims "replaced"', () => {
  checkMapping(replaceResultMessageKey);
  assert.throws(() => checkMapping(preFixMapping), 'pre-fix mapping must fail (negative control)');
});

test('N1: every message the Replace mapping can return exists in all 7 locales', () => {
  const outs: PublishOutcome[] = ['published', 'empty', 'unavailable', 'blocked', 'stale', 'failed'];
  const keys = new Set(outs.map(replaceResultMessageKey).filter((k): k is string => k !== null));
  assert.equal(keys.size, 3);
  for (const lang of LOCALES) {
    const dict = JSON.parse(readFileSync(new URL(`../i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of keys) assert.ok(typeof dict[k] === 'string' && dict[k].length > 0, `${lang}: ${k}`);
    // A real translation: the 'nothing' copy differs from the 'replaced' copy.
    assert.notEqual(dict.keyvault_replace_nothing, dict.keyvault_replaced, lang);
  }
});

test('N1: the banner routes the Replace outcome through replaceResultMessageKey', () => {
  const src = readFileSync(new URL('../components/KeyVaultBanner.tsx', import.meta.url), 'utf8');
  assert.match(src, /const msgKey = replaceResultMessageKey\(out\);/);
  assert.doesNotMatch(src, /out === 'empty'/);
  assert.doesNotMatch(src, /t\('keyvault_replaced'\)/);
});
