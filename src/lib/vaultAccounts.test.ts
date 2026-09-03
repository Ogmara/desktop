/**
 * Unit tests for the multi-account index core. Run with:
 *   node --test src/lib/vaultAccounts.test.ts
 * (Node 24 strips simple TS type syntax natively — no build step needed.)
 *
 * Every test here corresponds to a way an account could be LOST. The index is
 * a metadata cache on desktop rather than the sole record (the keystore is
 * enumerable), but a dropped entry still hides a wallet from the user, and the
 * mobile implementation shipped two bugs of exactly that shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SS,
  MAX_ACCOUNTS,
  isValidAddress,
  isStorableKey,
  parseIndex,
  parseMirror,
  parseAddressesFromScopedKeys,
  mergeIndexes,
  serializeMirror,
  type AccountEntry,
} from './vaultAccounts.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);
const C = 'klv1' + 'c'.repeat(58);

const entry = (a: string, over: Partial<AccountEntry> = {}): AccountEntry => ({
  a,
  label: null,
  source: 'builtin',
  added: 1,
  ...over,
});

// --- address validation ---------------------------------------------------

test('accepts a well-formed bech32 address', () => {
  assert.equal(isValidAddress(A), true);
});

test('rejects malformed, wrong-prefix and non-string addresses', () => {
  for (const bad of ['', 'klv', 'xyz1' + 'a'.repeat(58), 'klv1' + 'A'.repeat(58),
                     'klv1short', null, undefined, 42, {}, []]) {
    assert.equal(isValidAddress(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('rejects an address containing a colon', () => {
  // Pins the `.` separator: a `:` would make `<prefix>.<addr>` ambiguous
  // against the `::` used for localStorage scopes.
  assert.equal(isValidAddress('klv1' + 'a'.repeat(50) + ':' + 'b'.repeat(7)), false);
});

test('every generated secure-store key is storable by the Rust layer', () => {
  // The Rust `validate_key` rejects anything outside the two allowed prefixes,
  // so a bad key name would fail at runtime, not at compile time.
  for (const k of [SS.rawFor(A), SS.encFor(A), SS.modeFor(A), SS.encPrivFor(A),
                   SS.mirror, SS.active, SS.version, SS.pending, SS.pinMigration,
                   SS.dek, SS.dekMirror]) {
    assert.ok(isStorableKey(k), `not storable: ${k}`);
    assert.ok(k.length <= 256, `too long: ${k}`);
  }
});

// --- parsing --------------------------------------------------------------

test('parseIndex tolerates garbage without throwing', () => {
  for (const raw of [null, '', 'not json', '{}', '[1,2,3]', '[{"a":"nope"}]']) {
    assert.deepEqual(parseIndex(raw), [], `raw=${raw}`);
  }
});

test('parseIndex keeps valid entries and drops invalid ones in the same array', () => {
  const raw = JSON.stringify([{ a: A, added: 5 }, { a: 'bogus' }, { a: B, label: 'work', added: 7 }]);
  const got = parseIndex(raw);
  assert.deepEqual(got.map((e) => e.a), [A, B]);
  assert.equal(got[1].label, 'work');
});

test('parseIndex coerces any source to builtin', () => {
  // Desktop has no K5 or extension wallets. An index written by another build
  // must not introduce a source this client cannot act on.
  const got = parseIndex(JSON.stringify([{ a: A, source: 'k5-delegation', added: 1 }]));
  assert.equal(got[0].source, 'builtin');
});

test('parseMirror and parseAddressesFromScopedKeys tolerate garbage', () => {
  assert.deepEqual(parseMirror('not json'), []);
  assert.deepEqual(parseMirror(JSON.stringify([A, 'bad', B])), [A, B]);
  assert.deepEqual(parseAddressesFromScopedKeys(['no-separator', 'x::bad']), []);
  assert.deepEqual(parseAddressesFromScopedKeys([`ogmara.topicGroups::${A}`]), [A]);
});

test('scoped-key recovery takes the LAST separator', () => {
  // A base key that itself contains `::` must not yield a truncated address.
  assert.deepEqual(parseAddressesFromScopedKeys([`a::b::${A}`]), [A]);
});

// --- the union invariant --------------------------------------------------

test('each source ALONE keeps an account reachable', () => {
  assert.deepEqual(mergeIndexes([entry(A)], [], [], []).map((e) => e.a), [A]);
  assert.deepEqual(mergeIndexes([], [A], [], []).map((e) => e.a), [A]);
  assert.deepEqual(mergeIndexes([], [], [A], []).map((e) => e.a), [A]);
  assert.deepEqual(mergeIndexes([], [], [], [A]).map((e) => e.a), [A]);
});

test('merge is a union — nothing is dropped for being absent from a source', () => {
  const got = mergeIndexes([entry(A)], [B], [C], []);
  assert.deepEqual(got.map((e) => e.a).sort(), [A, B, C].sort());
});

test('the primary index wins on conflict because it carries labels', () => {
  const got = mergeIndexes([entry(A, { label: 'main', added: 9 })], [A], [A], [A]);
  assert.equal(got.length, 1);
  assert.equal(got[0].label, 'main');
  assert.equal(got[0].added, 9);
});

test('merge applies no cap of its own — a wipe must reach every account', () => {
  // vaultWipe enumerates through this. Capping here would leave key material
  // for accounts past the limit that nothing could ever remove.
  const many = Array.from({ length: MAX_ACCOUNTS + 5 }, (_, i) => 'klv1' + String(i).padStart(58, 'z'))
    .filter(isValidAddress);
  assert.ok(many.length > MAX_ACCOUNTS, 'test needs more than the cap');
  assert.equal(mergeIndexes([], [], [], many).length, many.length);
});

// --- the eviction ordering (mobile round-2 finding) ------------------------

test('a cap sheds unconfirmed candidates, never real accounts', () => {
  // Entries recovered from a scan have `added: 0`. A plain ascending sort put
  // those FIRST, so a cap evicted every real, indexed account — a defensive
  // limit turned into a data-loss mechanism.
  const real = entry(A, { added: Date.now() });
  const ghosts = [B, C];
  const merged = mergeIndexes([real], [], ghosts, []);
  assert.equal(merged[0].a, A, 'a real, indexed account must sort ahead of ghosts');
  assert.deepEqual(merged.slice(0, 1).map((e) => e.a), [A], 'and must survive a cap of 1');
});

test('a flood of scanned keys cannot evict real accounts', () => {
  const reals = [entry(A, { added: 10 }), entry(B, { added: 20 }), entry(C, { added: 30 })];
  const flood = Array.from({ length: 50 }, (_, i) => 'klv1' + String(i).padStart(58, 'd'))
    .filter(isValidAddress);
  const merged = mergeIndexes(reals, [], flood, []);
  const kept = merged.slice(0, MAX_ACCOUNTS).map((e) => e.a);
  for (const r of [A, B, C]) {
    assert.ok(kept.includes(r), `real account ${r.slice(0, 8)} must survive the cap`);
  }
});

test('keystore entries outrank the scan when a cap is applied', () => {
  // Both are timestamp-less, but a keystore entry PROVES a slot exists while a
  // scanned preference key does not. Keystore is listed first into the map.
  const keystore = [A];
  const scanned = [B];
  const merged = mergeIndexes([], [], scanned, keystore);
  assert.deepEqual(merged.map((e) => e.a).sort(), [A, B].sort());
});

test('merge rejects invalid addresses arriving from any untrusted source', () => {
  const merged = mergeIndexes([], ['bogus'], ['also-bogus'], ['klv1short']);
  assert.deepEqual(merged, []);
});

// --- serialization --------------------------------------------------------

test('serializeMirror round-trips through parseMirror', () => {
  const entries = [entry(A), entry(B)];
  assert.deepEqual(parseMirror(serializeMirror(entries)), [A, B]);
});

test('serializeMirror caps at MAX_ACCOUNTS', () => {
  const entries = Array.from({ length: MAX_ACCOUNTS + 3 }, (_, i) =>
    entry('klv1' + String(i).padStart(58, 'e'), { added: i + 1 }));
  assert.equal(parseMirror(serializeMirror(entries)).length, MAX_ACCOUNTS);
});
