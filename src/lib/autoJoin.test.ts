/**
 * Auto-join de-dup (desktop 1.82.0): at most once per account, per channel,
 * per session; reset on a wallet switch; a failure re-arms. Run:
 *   node --conditions=browser --test src/lib/autoJoin.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureEncryptedChannelMembership, __resetAutoJoinForTests } from './autoJoin.ts';
import { setWalletScope, getWalletScope } from './walletScope.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);

function recorder(fail = false) {
  const calls: number[] = [];
  const join = (id: number) => {
    calls.push(id);
    return fail ? Promise.reject(new Error('boom')) : Promise.resolve();
  };
  return { calls, join };
}

/** Let the rejection handler inside ensureEncryptedChannelMembership run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setWalletScope(null);
  __resetAutoJoinForTests();
});

test('joins once per wallet+channel', () => {
  setWalletScope(A);
  const r = recorder();
  assert.equal(ensureEncryptedChannelMembership(7, A, r.join), true);
  assert.equal(ensureEncryptedChannelMembership(7, A, r.join), false);
  assert.equal(ensureEncryptedChannelMembership(8, A, r.join), true);
  assert.deepEqual(r.calls, [7, 8]);
});

test('a wallet switch resets the set, so the new account joins for itself', () => {
  setWalletScope(A);
  const r = recorder();
  ensureEncryptedChannelMembership(7, A, r.join);
  setWalletScope(B);
  assert.equal(ensureEncryptedChannelMembership(7, B, r.join), true);
  // Back to A: the session set was dropped on the switch, so A re-attempts
  // (idempotent server-side) rather than inheriting anything from B.
  setWalletScope(A);
  assert.equal(ensureEncryptedChannelMembership(7, A, r.join), true);
  assert.deepEqual(r.calls, [7, 7, 7]);
});

test('a stale wallet (not the active scope) never triggers a join', () => {
  setWalletScope(B);
  const r = recorder();
  assert.equal(ensureEncryptedChannelMembership(7, A, r.join), false);
  setWalletScope(null);
  assert.equal(ensureEncryptedChannelMembership(7, A, r.join), false);
  assert.deepEqual(r.calls, []);
});

test('a failed join re-arms so a later visit retries', async () => {
  setWalletScope(A);
  const bad = recorder(true);
  assert.equal(ensureEncryptedChannelMembership(7, A, bad.join), true);
  await flush();
  const good = recorder();
  assert.equal(ensureEncryptedChannelMembership(7, A, good.join), true);
  assert.equal(ensureEncryptedChannelMembership(7, A, good.join), false);
  assert.deepEqual(good.calls, [7]);
});

test('a synchronously throwing join also re-arms', () => {
  setWalletScope(A);
  assert.equal(ensureEncryptedChannelMembership(7, A, () => { throw new Error('sync'); }), false);
  const r = recorder();
  assert.equal(ensureEncryptedChannelMembership(7, A, r.join), true);
});

test('invalid ids / empty wallet are rejected', () => {
  setWalletScope(A);
  const r = recorder();
  assert.equal(ensureEncryptedChannelMembership(0, A, r.join), false);
  assert.equal(ensureEncryptedChannelMembership(-1, A, r.join), false);
  assert.equal(ensureEncryptedChannelMembership(1.5, A, r.join), false);
  assert.equal(ensureEncryptedChannelMembership(7, '', r.join), false);
  assert.deepEqual(r.calls, []);
});

// --- Race: the wallet check and the signed call must happen in one turn ---

test('join is invoked while the scope is still the checked wallet (no await in between)', () => {
  setWalletScope(A);
  const scopeAtCall: (string | null)[] = [];
  ensureEncryptedChannelMembership(7, A, async () => {
    scopeAtCall.push(getWalletScope());
  });
  assert.deepEqual(scopeAtCall, [A]);
});

test('scope flipping before the call (stale caller) never signs as the new account', async () => {
  setWalletScope(A);
  const r = recorder();
  // A caller captured `A`, then the switch landed before it got to call us.
  setWalletScope(B);
  assert.equal(ensureEncryptedChannelMembership(7, A, r.join), false);
  await flush();
  assert.deepEqual(r.calls, []);
  // B's own attempt is unaffected.
  assert.equal(ensureEncryptedChannelMembership(7, B, r.join), true);
});

test('a switch during an in-flight join: the late failure does not re-arm/clobber the new account', async () => {
  setWalletScope(A);
  let rejectA!: (e: Error) => void;
  ensureEncryptedChannelMembership(7, A, () => new Promise((_, rej) => { rejectA = rej; }));
  setWalletScope(B); // clears the set
  const b = recorder();
  assert.equal(ensureEncryptedChannelMembership(7, B, b.join), true);
  rejectA(new Error('late'));
  await flush();
  // B's key must still be recorded: A's failure only removes A's own key.
  assert.equal(ensureEncryptedChannelMembership(7, B, b.join), false);
  assert.deepEqual(b.calls, [7]);
});
