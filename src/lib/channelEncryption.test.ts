/**
 * Regression test for the 2026-08-02 media-encryption fail-open bug: an image
 * attached to a private/encrypted channel while `channelInfo` was still
 * loading (or mid-refetch) uploaded to IPFS in the clear. Run with:
 *   node --test src/lib/channelEncryption.test.ts
 * (Node 24 strips simple TS type syntax natively — no build step needed.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIsEncrypted } from './channelEncryption.ts';

const PRIVATE = 2;
const PUBLIC = 0;

test('unresolved channel state fails closed (encrypted) even with no channel data', () => {
  assert.equal(resolveIsEncrypted('unresolved', undefined, PRIVATE), true);
  assert.equal(resolveIsEncrypted('pending', undefined, PRIVATE), true);
  assert.equal(resolveIsEncrypted('refreshing', undefined, PRIVATE), true);
});

test('errored fetch fails closed (encrypted)', () => {
  assert.equal(resolveIsEncrypted('errored', undefined, PRIVATE), true);
  assert.equal(resolveIsEncrypted('errored', { channel_type: PUBLIC }, PRIVATE), true);
});

test('ready but null channel record fails closed (encrypted)', () => {
  assert.equal(resolveIsEncrypted('ready', null, PRIVATE), true);
});

test('the exact reported bug: attach mid-load on a private channel must stay encrypted', () => {
  // Before the fix this returned false because `channel` was undefined while
  // `state` was still 'pending' — the media upload picked plaintext.
  assert.equal(resolveIsEncrypted('pending', undefined, PRIVATE), true);
});

test('ready + private channel type -> encrypted, regardless of encryption_enabled', () => {
  assert.equal(resolveIsEncrypted('ready', { channel_type: PRIVATE }, PRIVATE), true);
  assert.equal(resolveIsEncrypted('ready', { channel_type: PRIVATE, encryption_enabled: false }, PRIVATE), true);
});

test('ready + public channel with encryption_enabled -> encrypted', () => {
  assert.equal(resolveIsEncrypted('ready', { channel_type: PUBLIC, encryption_enabled: true }, PRIVATE), true);
});

test('ready + public legacy channel (no flag) -> plaintext ONLY when definitively resolved', () => {
  assert.equal(resolveIsEncrypted('ready', { channel_type: PUBLIC, encryption_enabled: false }, PRIVATE), false);
  assert.equal(resolveIsEncrypted('ready', { channel_type: PUBLIC }, PRIVATE), false);
});

test('refreshing with a stale-but-plaintext-looking payload still fails closed', () => {
  // solid-js keeps the PREVIOUS channel's resolved value visible while a
  // createResource refetch is in flight (state 'refreshing') — never
  // `undefined`. A future refactor might be tempted to trust that non-null
  // data; `state !== 'ready'` must win regardless of how definitive the
  // stale payload looks.
  assert.equal(resolveIsEncrypted('refreshing', { channel_type: PUBLIC, encryption_enabled: false }, PRIVATE), true);
});

// ---------------------------------------------------------------------------
// Side-effect gating (desktop 1.82.0). `resolveIsEncrypted` fails CLOSED, which
// is right for confidentiality and was WRONG when reused to gate auto-join: it
// joined any channel whose record was still loading or failed to fetch. The
// two functions below demand positive evidence instead.
// ---------------------------------------------------------------------------
import { isChannelRecordUsable, shouldAutoJoinEncryptedChannel } from './channelEncryption.ts';

const ENC_PUBLIC = { channel_type: PUBLIC, encryption_enabled: true };
const PLAIN_PUBLIC = { channel_type: PUBLIC, encryption_enabled: false };
const PRIV = { channel_type: PRIVATE, encryption_enabled: true };

test('isChannelRecordUsable: only a resolved, present, non-restricted record is usable', () => {
  for (const st of ['unresolved', 'pending', 'refreshing', 'errored'] as const) {
    assert.equal(isChannelRecordUsable(st, ENC_PUBLIC), false, st);
  }
  assert.equal(isChannelRecordUsable('ready', null), false, 'ready-null (failed fetch)');
  assert.equal(isChannelRecordUsable('ready', undefined), false, 'ready-undefined');
  assert.equal(isChannelRecordUsable('ready', PRIV, true), false, 'restricted non-member view');
  assert.equal(isChannelRecordUsable('ready', ENC_PUBLIC), true);
  assert.equal(isChannelRecordUsable('ready', PLAIN_PUBLIC, false), true);
  assert.equal(isChannelRecordUsable('ready', PRIV, null), true, 'member view of a private channel');
});

test('isChannelRecordUsable: a record without a numeric channel_type is not usable', () => {
  assert.equal(isChannelRecordUsable('ready', {}), false);
  assert.equal(isChannelRecordUsable('ready', { encryption_enabled: true }), false);
  assert.equal(isChannelRecordUsable('ready', { channel_type: null, encryption_enabled: true }), false);
  assert.equal(isChannelRecordUsable('ready', { channel_type: '0' as unknown as number }), false);
  assert.equal(isChannelRecordUsable('ready', { channel_type: 0 }), true);
});

test('shouldAutoJoinEncryptedChannel: never joins without a known record', () => {
  for (const st of ['unresolved', 'pending', 'refreshing', 'errored'] as const) {
    assert.equal(shouldAutoJoinEncryptedChannel(st, ENC_PUBLIC, PRIVATE), false, st);
    assert.equal(shouldAutoJoinEncryptedChannel(st, undefined, PRIVATE), false, `${st}/undefined`);
  }
  // The reported bug: record fetch failed (null) → isEncrypted() said true →
  // the effect joined. Must be false now.
  assert.equal(shouldAutoJoinEncryptedChannel('ready', null, PRIVATE), false);
});

test('shouldAutoJoinEncryptedChannel: stale refreshing payload is not trusted', () => {
  assert.equal(shouldAutoJoinEncryptedChannel('refreshing', ENC_PUBLIC, PRIVATE), false);
});

test('shouldAutoJoinEncryptedChannel: private channels are never auto-joined', () => {
  assert.equal(shouldAutoJoinEncryptedChannel('ready', PRIV, PRIVATE), false);
  assert.equal(shouldAutoJoinEncryptedChannel('ready', PRIV, PRIVATE, true), false, 'restricted');
  assert.equal(shouldAutoJoinEncryptedChannel('ready', { channel_type: PRIVATE }, PRIVATE), false);
});

test('shouldAutoJoinEncryptedChannel: restricted placeholder is never joined, whatever it claims', () => {
  assert.equal(shouldAutoJoinEncryptedChannel('ready', ENC_PUBLIC, PRIVATE, true), false);
});

test('shouldAutoJoinEncryptedChannel: plaintext public channels need no join', () => {
  assert.equal(shouldAutoJoinEncryptedChannel('ready', PLAIN_PUBLIC, PRIVATE), false);
  assert.equal(shouldAutoJoinEncryptedChannel('ready', { channel_type: PUBLIC }, PRIVATE), false);
  assert.equal(shouldAutoJoinEncryptedChannel('ready', { channel_type: PUBLIC, encryption_enabled: null }, PRIVATE), false);
});

test('shouldAutoJoinEncryptedChannel: a missing channel_type is not evidence of "public"', () => {
  assert.equal(shouldAutoJoinEncryptedChannel('ready', { encryption_enabled: true }, PRIVATE), false);
});

test('shouldAutoJoinEncryptedChannel: resolved encrypted public (and ReadPublic) channel joins', () => {
  assert.equal(shouldAutoJoinEncryptedChannel('ready', ENC_PUBLIC, PRIVATE), true);
  assert.equal(shouldAutoJoinEncryptedChannel('ready', ENC_PUBLIC, PRIVATE, false), true);
  assert.equal(shouldAutoJoinEncryptedChannel('ready', { channel_type: 1, encryption_enabled: true }, PRIVATE), true);
});

test('resolveIsEncrypted is unchanged: still fail-closed where auto-join now says no', () => {
  assert.equal(resolveIsEncrypted('ready', null, PRIVATE), true);
  assert.equal(resolveIsEncrypted('pending', undefined, PRIVATE), true);
});
