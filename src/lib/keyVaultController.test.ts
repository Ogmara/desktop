/**
 * Key-vault controller (desktop 1.84.0, mirrors web 0.84.0): never overwrite
 * the remote vault unless this session opened it with this wallet's own key,
 * confirmed it verifiably empty, or the user confirmed "Replace backup";
 * coalesced re-arm; bounded failure backoff.
 *
 * Real crypto end to end: built-in signers from fixed seeds, the real SDK
 * derive/seal/open, and the real per-wallet backup-key cache with a derive
 * that behaves like `signMessageAs` (throws unless the vault signer IS the
 * requested wallet). Every rule has a negative control: the same scenario
 * against a copy of the pre-fix flow (keyVault.ts @ desktop 1.83.0)
 * reproduces the bug.
 * Run: node --conditions=browser --test src/lib/keyVaultController.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WalletSigner,
  deriveVaultBackupKey,
  sealKeyVault,
  openKeyVault,
  type VaultKeyring,
  type KeyVaultSyncData,
} from '@ogmara/sdk';
import {
  createBackupKeyCache,
  createVaultController,
  type OwnedKey,
} from './keyVaultCore.ts';

const CLAIM = 'ogmara-keyvault-v1';
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const signerA = await WalletSigner.fromPrivateKey(new Uint8Array(32).fill(0x11));
const signerB = await WalletSigner.fromPrivateKey(new Uint8Array(32).fill(0x22));
const A = signerA.address;
const B = signerB.address;
/** What `signMessageAs(w, CLAIM)` returns on desktop: 128-char hex. */
const SIG: Record<string, string> = {
  [A]: hex(await signerA.signKleverMessage(enc(CLAIM))),
  [B]: hex(await signerB.signKleverMessage(enc(CLAIM))),
};
const KEY: Record<string, Uint8Array> = {
  [A]: deriveVaultBackupKey(SIG[A]),
  [B]: deriveVaultBackupKey(SIG[B]),
};
const k = (n: number) => new Uint8Array(32).fill(n);

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

/** Injected fake clock: timers only fire on `advance`. */
class Clock {
  now = 0;
  private seq = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (id: unknown) => { this.timers.delete(id as number); };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      await settle();
    }
    this.now = end;
    await settle();
  }
}

/** Which account opens a sealed blob (null = nobody we know). */
function sealedFor(blob: KeyVaultSyncData): string | null {
  for (const w of [A, B]) {
    try { openKeyVault(KEY[w], blob); return w; } catch { /* not this one */ }
  }
  return null;
}

interface Vault {
  scheduleBackup(): void;
  tryRestore(): void;
  clearSession(): void;
}

type Flavor = 'fixed' | 'legacy';

function world(flavor: Flavor = 'fixed') {
  const w = {
    wallet: A as string | null,
    gen: 1,
    /** The vault's active signer (null = follows `wallet`). */
    signerIs: null as string | null,
    remote: new Map<string, KeyVaultSyncData>(),
    marker: new Map<string, string>(),
    /** Storage scope ≠ wallet (marker unreadable right now). */
    scopeMismatch: false,
    fetchFails: false,
    publishFails: false,
    publishGate: null as Promise<void> | null,
    local: { conv: {}, chan: {} } as VaultKeyring,
    signCalls: 0,
    ensureCalls: 0,
    fetchCalls: 0,
    publishes: [] as { as: string; blob: KeyVaultSyncData; sealedFor: string | null; keys: string[] }[],
    sendAttempts: 0,
  };
  const clock = new Clock();
  /** `signMessageAs(wallet, CLAIM)` → `deriveVaultBackupKey`, as keyVault.ts wires it. */
  const derive = async (wallet: string): Promise<Uint8Array> => {
    w.signCalls++;
    await Promise.resolve();
    const active = w.signerIs ?? w.wallet;
    if (active !== wallet) throw new Error('Active signer is not the requested account');
    return deriveVaultBackupKey(SIG[wallet]);
  };
  const io = {
    currentWallet: () => w.wallet,
    generation: () => w.gen,
    log: () => {},
    fetchVault: async (): Promise<KeyVaultSyncData | null> => {
      w.fetchCalls++;
      const of = w.wallet!;
      await Promise.resolve();
      if (w.fetchFails) throw new Error('API error (502)');
      return w.remote.get(of) ?? null;
    },
    open: openKeyVault,
    importKeys: (kr: VaultKeyring) => {
      Object.assign(w.local.conv, kr.conv);
      Object.assign(w.local.chan, kr.chan);
      return { conv: Object.keys(kr.conv).length };
    },
    seenMarker: (wallet: string) => (w.scopeMismatch ? null : w.marker.get(wallet) === wallet),
    markSeen: (wallet: string) => { if (!w.scopeMismatch) w.marker.set(wallet, wallet); },
    snapshot: (): VaultKeyring => ({ conv: { ...w.local.conv }, chan: { ...w.local.chan } }),
    isEmpty: (kr: VaultKeyring) => Object.keys(kr.conv).length + Object.keys(kr.chan).length === 0,
    seal: sealKeyVault,
    publish: async (blob: KeyVaultSyncData) => {
      w.sendAttempts++;
      const as = w.wallet!; // the node attributes it to the signing account
      if (w.publishGate) await w.publishGate;
      await Promise.resolve();
      if (w.publishFails) throw new Error('API error (503)');
      w.remote.set(as, blob);
      const opened = sealedFor(blob);
      w.publishes.push({
        as, blob, sealedFor: opened,
        keys: opened ? Object.keys(openKeyVault(KEY[opened], blob).conv).sort() : [],
      });
    },
    setTimer: clock.set,
    clearTimer: clock.clear,
  };

  const keyCache = createBackupKeyCache(derive);
  const ensureBackupKey = (): Promise<OwnedKey | null> => {
    w.ensureCalls++;
    return keyCache.ensure(w.wallet);
  };

  const ctl = createVaultController({ ...io, ensureBackupKey });
  const vault: Vault = flavor === 'fixed'
    ? ctl
    : createLegacyVault({ ...io, ensureBackupKey, clearKey: () => keyCache.clear() });

  const addKey = (name: string, n = 7) => {
    w.local.conv[name] = k(n);
    vault.scheduleBackup();
  };
  /** switchAccountInner / disconnect as auth.ts does it: bump the generation first,
   *  tear the session down (caches + clearKeyVaultSession), then flip the wallet. */
  const switchTo = (next: string) => {
    w.gen++;
    w.signerIs = next; // vaultActivate re-points the signer before the teardown
    w.local = { conv: {}, chan: {} }; // clearDmKeyCache / clearChannelKeyCache
    if (flavor === 'fixed') { keyCache.clear(); ctl.clearSession(); } else vault.clearSession();
    w.wallet = next;
    w.signerIs = null;
  };
  const seedRemote = (wallet: string, keys: Record<string, number>, sealWith = KEY[wallet]) => {
    const conv: Record<string, Uint8Array> = {};
    for (const [n, v] of Object.entries(keys)) conv[n] = k(v);
    w.remote.set(wallet, sealKeyVault(sealWith, { conv, chan: {} }));
  };
  return { w, clock, ctl, keyCache, vault, addKey, switchTo, seedRemote };
}

// --- the pre-fix flow (keyVault.ts @ desktop 1.83.0), deps injected ---------------

interface LegacyDeps {
  currentWallet(): string | null;
  generation(): number;
  ensureBackupKey(): Promise<OwnedKey | null>;
  fetchVault(): Promise<KeyVaultSyncData | null>;
  open(key: Uint8Array, r: KeyVaultSyncData): VaultKeyring;
  importKeys(kr: VaultKeyring): unknown;
  snapshot(): VaultKeyring;
  isEmpty(kr: VaultKeyring): boolean;
  seal(key: Uint8Array, kr: VaultKeyring): KeyVaultSyncData;
  publish(b: KeyVaultSyncData): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  clearKey(): void;
}

function createLegacyVault(d: LegacyDeps): Vault {
  let restoreState: 'idle' | 'inflight' | 'done' = 'idle';
  let restoreRun = 0;
  let pendingBackup = false;
  let publishing = false;
  let timer: unknown = null;
  async function runRestore(): Promise<'done' | 'idle'> {
    const forWallet = d.currentWallet(); const gen = d.generation();
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
  async function publishBackup() {
    if (publishing) return; // the dropped publish
    const sealWallet = d.currentWallet(); const gen = d.generation();
    const stale = () => d.currentWallet() !== sealWallet || d.generation() !== gen;
    const kr = d.snapshot();
    publishing = true;
    try {
      if (!sealWallet || stale() || d.isEmpty(kr)) return;
      const bk = await d.ensureBackupKey();
      if (!bk || bk.wallet !== sealWallet || stale()) return;
      const sealed = d.seal(bk.key, kr);
      if (stale()) return;
      await d.publish(sealed);
    } catch { /* nothing re-arms */ } finally { publishing = false; }
  }
  function scheduleBackup() {
    if (restoreState !== 'done') { pendingBackup = true; tryRestore(); return; }
    if (timer !== null) d.clearTimer(timer);
    timer = d.setTimer(() => { timer = null; void publishBackup(); }, 4_000);
  }
  function tryRestore() {
    if (restoreState !== 'idle') return;
    restoreState = 'inflight';
    const my = restoreRun;
    void (async () => {
      try {
        const out = await runRestore();
        if (my === restoreRun) restoreState = out;
      } catch {
        if (my === restoreRun) restoreState = 'idle';
      } finally {
        if (my === restoreRun && restoreState === 'done' && pendingBackup) { pendingBackup = false; scheduleBackup(); }
      }
    })();
  }
  return {
    scheduleBackup,
    tryRestore,
    clearSession() {
      d.clearKey(); restoreRun++; restoreState = 'idle'; pendingBackup = false;
      if (timer !== null) { d.clearTimer(timer); timer = null; }
    },
  };
}

// --- owner binding: the built-in signer is not the connected wallet ------------------

test('signer is not the connected wallet (mid-switch): no key, nothing fetched or published; recovers once it is', async () => {
  const h = world();
  h.w.signerIs = B;
  h.seedRemote(A, { 'old-dm': 1 });
  h.addKey('new-dm');
  await settle();
  await h.clock.advance(3_600_000);
  assert.equal(h.w.fetchCalls, 0, 'nothing is fetched without this wallet\'s own key');
  assert.equal(h.w.sendAttempts, 0);
  assert.equal(h.keyCache.cachedWallet(), null);
  assert.equal(h.ctl.status().restore, 'idle', 'retryable, not terminal');
  assert.equal(h.ctl.status().pendingBackup, true, 'the backup intent survives');

  h.w.signerIs = null;
  h.ctl.tryRestore();
  await settle();
  assert.equal(h.ctl.status().restore, 'done');
  await h.clock.advance(4_000);
  assert.equal(h.w.publishes.length, 1);
  assert.equal(h.w.publishes[0].sealedFor, A);
  assert.deepEqual(h.w.publishes[0].keys, ['new-dm', 'old-dm']);
});

test('built-in signer derives once and caches: one derivation for restore + publishes', async () => {
  const h = world();
  h.addKey('a');
  await settle();
  await h.clock.advance(4_000);
  h.addKey('b');
  await h.clock.advance(4_000);
  assert.equal(h.w.signCalls, 1);
  assert.equal(h.w.publishes.length, 2);
  assert.ok(h.w.publishes.every((p) => p.sealedFor === A));
});

// --- (3) unreadable remote under our own key ------------------------------------------

for (const kind of ['wrong-key blob', 'unsupported format_version'] as const) {
  test(`unreadable remote (${kind}) -> blocked:'unreadable'; pending backup never published; Replace publishes exactly once`, async () => {
    const h = world();
    if (kind === 'wrong-key blob') h.seedRemote(A, { 'x': 1 }, KEY[B]);
    else {
      h.seedRemote(A, { 'x': 1 });
      h.w.remote.set(A, { ...h.w.remote.get(A)!, format_version: 2 });
    }
    const before = h.w.remote.get(A);
    h.addKey('dm');
    await settle();
    assert.deepEqual(h.ctl.status(), { restore: 'blocked', blockReason: 'unreadable', pendingBackup: true, publishing: false, failStreak: 0 });
    for (let i = 0; i < 5; i++) h.addKey(`dm${i}`);
    h.ctl.tryRestore();
    await h.clock.advance(3_600_000);
    assert.equal(h.w.fetchCalls, 1, 'blocked: no GET loop');
    assert.equal(h.w.publishes.length, 0);
    assert.equal(h.w.remote.get(A), before, 'the unreadable vault is preserved');
    assert.equal(h.w.marker.get(A), undefined, 'an unreadable vault does not set the marker');

    const out = await h.ctl.replace();
    assert.equal(out, 'published');
    await h.clock.advance(3_600_000);
    assert.equal(h.w.publishes.length, 1);
    assert.equal(h.w.publishes[0].sealedFor, A);
    assert.equal(h.ctl.status().restore, 'done');
    assert.equal(h.w.marker.get(A), A, 'the replacing publish sets the marker');
    h.addKey('after');
    await h.clock.advance(4_000);
    assert.equal(h.w.publishes.length, 2, 'backups resume normally after Replace');
  });
}

test('unreadable negative control: the pre-fix flow treats it as done and overwrites the vault', async () => {
  const h = world('legacy');
  h.seedRemote(A, { 'x': 1 }, KEY[B]);
  h.addKey('dm');
  await settle();
  await h.clock.advance(4_000);
  assert.equal(h.w.publishes.length, 1);
  assert.deepEqual(h.w.publishes[0].keys, ['dm'], 'the old vault is replaced by a partial keyring');
});

test('Replace is refused unless blocked (it can never skip a restore that has not run)', async () => {
  const h = world();
  h.w.local.conv['dm'] = k(1);
  assert.equal(await h.ctl.replace(), 'blocked'); // idle
  h.w.fetchFails = true;
  h.ctl.tryRestore();
  assert.equal(await h.ctl.replace(), 'blocked'); // inflight
  await settle();
  assert.equal(h.ctl.status().restore, 'idle');
  assert.equal(await h.ctl.replace(), 'blocked');
  h.w.fetchFails = false;
  h.ctl.tryRestore();
  await settle();
  assert.equal(h.ctl.status().restore, 'done');
  assert.equal(await h.ctl.replace(), 'blocked'); // done: a normal backup, not a Replace
  assert.equal(h.w.sendAttempts, 0);
});

test('Replace for a blocked account is refused after a switch to another account', async () => {
  const h = world();
  h.seedRemote(A, { 'x': 1 }, KEY[B]);
  h.addKey('dm');
  await settle();
  assert.equal(h.ctl.status().restore, 'blocked');
  h.switchTo(B);
  assert.equal(await h.ctl.replace(), 'blocked');
  assert.equal(h.w.sendAttempts, 0);
});

test('Retry from blocked re-reads the remote (e.g. after switching node)', async () => {
  const h = world();
  h.seedRemote(A, { 'x': 1 }, KEY[B]);
  h.addKey('dm');
  await settle();
  assert.equal(h.ctl.status().restore, 'blocked');
  h.seedRemote(A, { 'x': 1 }); // the readable copy
  h.ctl.retry();
  await settle();
  assert.equal(h.ctl.status().restore, 'done');
  await h.clock.advance(4_000);
  assert.deepEqual(h.w.publishes.map((p) => p.keys), [['dm', 'x']]);
});

// --- (4) 404 is "empty" only without the marker ------------------------------------------

test("404 + keyVaultSeen marker -> blocked:'missing', nothing published", async () => {
  const h = world();
  h.w.marker.set(A, A);
  h.addKey('dm');
  await settle();
  await h.clock.advance(3_600_000);
  assert.equal(h.ctl.status().restore, 'blocked');
  assert.equal(h.ctl.status().blockReason, 'missing');
  assert.equal(h.w.publishes.length, 0);
  assert.equal(h.w.fetchCalls, 1, 'no GET loop while blocked');
});

test('404 without the marker -> done, publishes, and sets the marker', async () => {
  const h = world();
  h.addKey('dm');
  await settle();
  assert.equal(h.ctl.status().restore, 'done');
  await h.clock.advance(4_000);
  assert.equal(h.w.publishes.length, 1);
  assert.equal(h.w.marker.get(A), A);
});

test('a marker for ANOTHER wallet does not count; a successful open sets the marker', async () => {
  const h = world();
  h.w.marker.set(A, B);
  h.seedRemote(A, { 'x': 1 });
  h.ctl.tryRestore();
  await settle();
  assert.equal(h.ctl.status().restore, 'done');
  assert.equal(h.w.marker.get(A), A);
});

test('marker unreadable right now (storage scope != wallet) -> stays retryable, never "empty"', async () => {
  const h = world();
  h.w.scopeMismatch = true;
  h.addKey('dm');
  await settle();
  await h.clock.advance(3_600_000);
  assert.equal(h.ctl.status().restore, 'idle');
  assert.equal(h.w.publishes.length, 0);
});

test('404 + marker negative control: the pre-fix flow overwrites the real vault from a node without a copy', async () => {
  const h = world('legacy');
  h.w.marker.set(A, A);
  h.addKey('dm');
  await settle();
  await h.clock.advance(4_000);
  assert.equal(h.w.publishes.length, 1);
});

// --- (5) coalesced re-arm ----------------------------------------------------------------

test('ten key changes during one in-flight publish -> exactly ONE follow-up, containing the newest key', async () => {
  const h = world();
  h.addKey('k0');
  await settle();
  let release!: () => void;
  h.w.publishGate = new Promise<void>((r) => { release = r; });
  await h.clock.advance(4_000);
  assert.equal(h.ctl.status().publishing, true);
  for (let i = 1; i <= 10; i++) {
    h.addKey(`k${i}`);
    await h.clock.advance(4_000);
  }
  assert.equal(h.w.sendAttempts, 1);
  h.w.publishGate = null;
  release();
  await settle();
  await h.clock.advance(3_600_000);
  assert.equal(h.w.publishes.length, 2);
  assert.ok(h.w.publishes[1].keys.includes('k10'));
  assert.equal(h.w.publishes[1].keys.length, 11);
});

test('re-arm negative control: the pre-fix flow drops every change made during the flight', async () => {
  const h = world('legacy');
  h.addKey('k0');
  await settle();
  let release!: () => void;
  h.w.publishGate = new Promise<void>((r) => { release = r; });
  await h.clock.advance(4_000);
  for (let i = 1; i <= 10; i++) {
    h.addKey(`k${i}`);
    await h.clock.advance(4_000);
  }
  h.w.publishGate = null;
  release();
  await settle();
  await h.clock.advance(3_600_000);
  assert.equal(h.w.publishes.length, 1, 'zero follow-ups: k1..k10 exist only in memory');
});

// --- (6) coalescing restore + manual backup ---------------------------------------------

test('double restore trigger -> ONE fetch; ensureRestored joins the flight', async () => {
  const h = world();
  h.seedRemote(A, { 'x': 1 });
  h.ctl.tryRestore();
  h.ctl.tryRestore();
  const [a, b] = await Promise.all([h.ctl.ensureRestored(), h.ctl.ensureRestored()]);
  assert.deepEqual([a, b], ['done', 'done']);
  assert.equal(h.w.fetchCalls, 1);
  assert.equal(h.w.signCalls, 1);
});

test('a publish requested during restore waits for it, then ONE publish with the merged keyring', async () => {
  const h = world();
  h.seedRemote(A, { 'x': 1, 'y': 2 });
  h.addKey('new');
  h.addKey('new2');
  await settle();
  await h.clock.advance(3_600_000);
  assert.equal(h.w.fetchCalls, 1);
  assert.equal(h.w.publishes.length, 1);
  assert.deepEqual(h.w.publishes[0].keys, ['new', 'new2', 'x', 'y']);
});

test('backupNow during an in-flight restore: one fetch, published keyring is a superset of the remote', async () => {
  const h = world();
  h.seedRemote(A, { 'x': 1, 'y': 2 });
  h.w.local.conv['new'] = k(3);
  h.ctl.tryRestore();
  assert.equal(await h.ctl.backupNow(), 'published');
  assert.equal(h.w.fetchCalls, 1);
  assert.deepEqual(h.w.publishes.map((p) => p.keys), [['new', 'x', 'y']]);
});

test('backupNow reports honestly: restore-failed / blocked / nothing / failed — and never sends unless done', async () => {
  let h = world();
  h.seedRemote(A, { 'x': 1 });
  h.w.local.conv['new'] = k(3);
  h.w.fetchFails = true;
  assert.equal(await h.ctl.backupNow(), 'restore-failed');
  assert.equal(h.w.sendAttempts, 0);

  h = world();
  h.seedRemote(A, { 'x': 1 }, KEY[B]);
  h.w.local.conv['new'] = k(3);
  assert.equal(await h.ctl.backupNow(), 'blocked');
  assert.equal(h.w.sendAttempts, 0);

  h = world();
  assert.equal(await h.ctl.backupNow(), 'nothing');

  h = world();
  h.w.local.conv['new'] = k(3);
  h.w.publishFails = true;
  assert.equal(await h.ctl.backupNow(), 'failed');
});

// --- (7) account switches -----------------------------------------------------------------

test("A -> B mid-publish: A's keyring never reaches B; a B request during A's flight -> B-only publish", async () => {
  const h = world();
  h.addKey('a-dm');
  await settle();
  let release!: () => void;
  h.w.publishGate = new Promise<void>((r) => { release = r; });
  await h.clock.advance(4_000); // A's publish is now in flight (sealed for A)
  h.switchTo(B);
  h.addKey('b-dm');
  await settle(); // B's restore (404, no marker) -> done -> debounce
  await h.clock.advance(4_000); // B's publish requested while A's is in flight
  h.w.publishGate = null;
  release();
  await settle();
  await h.clock.advance(3_600_000);
  const toB = h.w.publishes.filter((p) => p.as === B);
  assert.equal(toB.length, 1);
  assert.equal(toB[0].sealedFor, B);
  assert.deepEqual(toB[0].keys, ['b-dm']);
  assert.ok(h.w.publishes.every((p) => p.as === p.sealedFor), 'every blob is sealed for its own account');
});

test('A -> B -> A without a session clear: generation change voids the "done" state (re-restore before publishing)', async () => {
  const h = world();
  h.addKey('dm');
  await settle();
  await h.clock.advance(4_000);
  assert.equal(h.w.fetchCalls, 1);
  h.w.wallet = B; h.w.gen++;
  h.w.wallet = A; h.w.gen++;
  assert.equal(h.ctl.status().restore, 'idle');
  h.addKey('dm2');
  await settle();
  assert.equal(h.w.fetchCalls, 2, 'restored again for the new generation');
});

test('a debounce armed for A that fires after the account changed derives nothing and sends nothing', async () => {
  const h = world();
  h.addKey('dm');
  await settle();
  // Account flips (no session clear reached the vault yet) before the debounce fires.
  h.w.wallet = B; h.w.gen++;
  const signsBefore = h.w.signCalls;
  const ensureBefore = h.w.ensureCalls;
  await h.clock.advance(4_000);
  assert.equal(h.w.signCalls, signsBefore, 'no derivation for B');
  assert.equal(h.w.ensureCalls, ensureBefore, 'controller gate: runPublish is not even started');
  assert.equal(h.w.sendAttempts, 0);
});

test('blocked state of A does not carry over to B (per account, per session)', async () => {
  const h = world();
  h.seedRemote(A, { 'x': 1 }, KEY[B]);
  h.addKey('dm');
  await settle();
  assert.equal(h.ctl.status().restore, 'blocked');
  h.switchTo(B);
  assert.equal(h.ctl.status().restore, 'idle');
  assert.equal(h.ctl.status().pendingBackup, false);
  h.addKey('b-dm');
  await settle();
  await h.clock.advance(4_000);
  assert.deepEqual(h.w.publishes.map((p) => [p.as, p.sealedFor]), [[B, B]]);
  assert.equal(sealedFor(h.w.remote.get(A)!), B, "A's unreadable vault untouched");
});

// --- (8) failure backoff -----------------------------------------------------------------

test('failed publish retries at 60 s / 5 min / 15 min, at most 3 times; session clear resets', async () => {
  const h = world();
  h.w.publishFails = true;
  h.addKey('dm');
  await settle();
  await h.clock.advance(4_000);
  assert.equal(h.w.sendAttempts, 1);
  await h.clock.advance(59_000);
  assert.equal(h.w.sendAttempts, 1);
  await h.clock.advance(1_000);
  assert.equal(h.w.sendAttempts, 2);
  await h.clock.advance(300_000);
  assert.equal(h.w.sendAttempts, 3);
  await h.clock.advance(900_000);
  assert.equal(h.w.sendAttempts, 4);
  await h.clock.advance(24 * 3_600_000);
  assert.equal(h.w.sendAttempts, 4, 'capped at 3 automatic retries');
  assert.equal(h.ctl.status().failStreak, 3);
  h.ctl.clearSession();
  assert.equal(h.ctl.status().failStreak, 0);
  assert.equal(h.clock.timers.size, 0);
});

test('a success resets the failure streak', async () => {
  const h = world();
  h.w.publishFails = true;
  h.addKey('dm');
  await settle();
  await h.clock.advance(4_000);
  h.w.publishFails = false;
  await h.clock.advance(60_000);
  assert.equal(h.w.publishes.length, 1);
  assert.equal(h.ctl.status().failStreak, 0);
  assert.equal(h.clock.timers.size, 0);
});

test('backoff negative control: the pre-fix flow never retries a failed publish', async () => {
  const h = world('legacy');
  h.w.publishFails = true;
  h.addKey('dm');
  await settle();
  await h.clock.advance(4_000);
  h.w.publishFails = false;
  await h.clock.advance(24 * 3_600_000);
  assert.equal(h.w.sendAttempts, 1);
  assert.equal(h.w.publishes.length, 0);
});

test('session clear cancels a pending backoff retry (no retry under the next account)', async () => {
  const h = world();
  h.w.publishFails = true;
  h.addKey('dm');
  await settle();
  await h.clock.advance(4_000);
  h.switchTo(B);
  h.w.publishFails = false;
  await h.clock.advance(3_600_000);
  assert.equal(h.w.sendAttempts, 1);
});

// --- session-clear / account-change bookkeeping (each kills a specific mutation) ---------

test('session clear cancels the backoff retry even when the same account comes back', async () => {
  const h = world();
  h.w.publishFails = true;
  h.addKey('dm');
  await settle();
  await h.clock.advance(4_000);
  assert.equal(h.w.sendAttempts, 1);
  h.ctl.clearSession(); // e.g. clearKeyVaultSession without a wallet change
  assert.equal(h.clock.timers.size, 0, 'no retry timer survives the clear');
  h.w.publishFails = false;
  h.ctl.tryRestore();
  await settle();
  assert.equal(h.ctl.status().restore, 'done');
  await h.clock.advance(3_600_000);
  assert.equal(h.w.sendAttempts, 1, 'the cleared session does not publish on its own');
});

test('a follow-up requested during a flight is dropped by a session clear', async () => {
  const h = world();
  h.addKey('k0');
  await settle();
  let release!: () => void;
  h.w.publishGate = new Promise<void>((r) => { release = r; });
  await h.clock.advance(4_000);
  h.addKey('k1');
  await h.clock.advance(4_000); // publishAgain armed
  h.ctl.clearSession();
  const fetchesBefore = h.w.fetchCalls;
  h.w.publishGate = null;
  release();
  await settle();
  await h.clock.advance(3_600_000);
  assert.equal(h.w.fetchCalls, fetchesBefore, 'no restore/publish re-armed for the cleared session');
  assert.equal(h.ctl.status().pendingBackup, false);
});

test('a follow-up requested by A is not run after the account changed (no session clear yet)', async () => {
  const h = world();
  h.addKey('k0');
  await settle();
  let release!: () => void;
  h.w.publishGate = new Promise<void>((r) => { release = r; });
  await h.clock.advance(4_000);
  h.addKey('k1');
  await h.clock.advance(4_000); // publishAgain armed for A
  h.w.wallet = B; h.w.gen++;
  const fetchesBefore = h.w.fetchCalls;
  const ensureBefore = h.w.ensureCalls;
  h.w.publishGate = null;
  release();
  await settle();
  assert.equal(h.w.fetchCalls, fetchesBefore, "A's follow-up starts nothing for B");
  assert.equal(h.w.ensureCalls, ensureBefore);
  assert.equal(h.ctl.status().pendingBackup, false);
});

test('a restore superseded by a session clear never writes the (same) account\'s state', async () => {
  const h = world();
  h.seedRemote(A, { 'x': 1 }, KEY[B]); // would be 'unreadable'
  h.ctl.tryRestore();
  h.ctl.clearSession();
  await settle();
  assert.equal(h.ctl.status().restore, 'idle', 'not blocked by the abandoned run');
  assert.equal(h.ctl.status().blockReason, null);
});

test('backupNow waiting behind a flight re-checks the gate before starting its own publish', async () => {
  const h = world();
  h.addKey('k0');
  await settle();
  let release!: () => void;
  h.w.publishGate = new Promise<void>((r) => { release = r; });
  await h.clock.advance(4_000); // flight in progress, restore done
  const p = h.ctl.backupNow();
  await settle();
  h.ctl.clearSession(); // restore state back to idle while backupNow waits
  const ensureBefore = h.w.ensureCalls;
  h.w.publishGate = null;
  release();
  assert.equal(await p, 'blocked');
  assert.equal(h.w.ensureCalls, ensureBefore, 'controller gate: no second run started');
  assert.equal(h.w.sendAttempts, 1);
  assert.equal(h.ctl.status().pendingBackup, false, 'nothing re-armed into the cleared session');
});
