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
