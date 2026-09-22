/**
 * Regression coverage for message-buttons payload decoding (protocol §3.3).
 * Run with: node --test src/lib/payload.test.ts
 * (Node 24 strips simple TS type syntax natively — no build step needed.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '@msgpack/msgpack';
import { decodePayload, getPayloadButtons, getPayloadViaButton } from './payload.ts';

function chatPayload(extra: Record<string, unknown> = {}): Uint8Array {
  return encode({ content: 'hi', ...extra });
}

function button(label: string, command: string) {
  return { label, command };
}

test('decodePayload extracts buttons and via_button when present', () => {
  const bytes = chatPayload({
    buttons: [{ buttons: [button('1h', '/c BTC 1h')] }],
    via_button: true,
  });
  const decoded = decodePayload(bytes);
  assert.equal(decoded.via_button, true);
  assert.equal(decoded.buttons?.length, 1);
  assert.deepEqual(decoded.buttons?.[0].buttons[0], { label: '1h', command: '/c BTC 1h' });
});

test('decodePayload: buttons is undefined and via_button is false when absent (pre-0.131 messages)', () => {
  const decoded = decodePayload(chatPayload());
  assert.equal(decoded.buttons, undefined);
  // Deliberately `false`, not `undefined` — `decoded.via_button === true` is
  // an exact-type check (rejects a non-boolean truthy value like the string
  // "true"), so the negative case normalizes to a real boolean too.
  assert.equal(decoded.via_button, false);
});

test('via_button only decodes true from a literal boolean true, not a truthy non-boolean', () => {
  assert.equal(decodePayload(chatPayload({ via_button: 'true' })).via_button, false);
  assert.equal(decodePayload(chatPayload({ via_button: 1 })).via_button, false);
});

test('getPayloadButtons returns [] rather than throwing on a malformed row', () => {
  // A button row missing its `buttons` array entirely — defends against a
  // future node bug or a corrupted stored payload; must not throw and take
  // the whole message render down with it.
  const bytes = chatPayload({ buttons: [{}] });
  const rows = getPayloadButtons(bytes);
  assert.deepEqual(rows, [{ buttons: [] }]);
});

test('getPayloadButtons returns [] when the payload has no buttons field', () => {
  assert.deepEqual(getPayloadButtons(chatPayload()), []);
});

test('getPayloadViaButton returns false when absent', () => {
  assert.equal(getPayloadViaButton(chatPayload()), false);
});

test('getPayloadViaButton returns true when set', () => {
  assert.equal(getPayloadViaButton(chatPayload({ via_button: true })), true);
});

test('multiple rows and multiple buttons per row all decode in order', () => {
  const bytes = chatPayload({
    buttons: [
      { buttons: [button('15m', '/c BTC 15m'), button('1h', '/c BTC 1h')] },
      { buttons: [button('4h', '/c BTC 4h')] },
    ],
  });
  const rows = getPayloadButtons(bytes);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].buttons.length, 2);
  assert.equal(rows[1].buttons[0].label, '4h');
});

// --- Security-audit-driven hardening (client re-enforces caps the node
// only started enforcing in l2-node 0.131 — every pre-0.131 node, i.e. the
// whole fleet at ship time, never validated any of this) ---

test('caps rows at 10 even when the wire payload claims more', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ buttons: [button('x', `/x${i}`)] }));
  const decoded = getPayloadButtons(chatPayload({ buttons: rows }));
  assert.equal(decoded.length, 10);
});

test('caps buttons per row at 8 even when the wire payload claims more', () => {
  const buttons = Array.from({ length: 12 }, (_, i) => button('x', `/x${i}`));
  const decoded = getPayloadButtons(chatPayload({ buttons: [{ buttons }] }));
  assert.equal(decoded[0].buttons.length, 8);
});

test('caps the TOTAL button count at 40 across rows, independent of the row/per-row caps', () => {
  // 10 rows x 8/row = 80 individually-legal buttons, well over the 40 total
  // cap — this is exactly the "80 > 40" case the node-side validator (and
  // its own test suite) treats as the binding constraint.
  const rows = Array.from({ length: 10 }, (_, ri) => ({
    buttons: Array.from({ length: 8 }, (_, bi) => button('x', `/r${ri}b${bi}`)),
  }));
  const decoded = getPayloadButtons(chatPayload({ buttons: rows }));
  const total = decoded.reduce((n, row) => n + row.buttons.length, 0);
  assert.equal(total, 40);
});

test('a non-array top-level buttons field decodes as absent, not a throw', () => {
  assert.deepEqual(getPayloadButtons(chatPayload({ buttons: 'not-an-array' })), []);
});

test('a non-object row (null) is treated as an empty row, not a throw', () => {
  const decoded = getPayloadButtons(chatPayload({ buttons: [null, { buttons: [button('x', '/x')] }] }));
  assert.deepEqual(decoded[0], { buttons: [] });
  assert.equal(decoded[1].buttons[0].label, 'x');
});

test('a non-string label/command is coerced to empty and the button is dropped, not rendered blank', () => {
  const decoded = getPayloadButtons(
    chatPayload({ buttons: [{ buttons: [{ label: { nodeType: 1 }, command: '/x' }] }] }),
  );
  assert.deepEqual(decoded, [{ buttons: [] }]);
});

test('an empty label or command (even after sanitization strips it to empty) is dropped', () => {
  const decoded = getPayloadButtons(
    chatPayload({
      buttons: [
        {
          buttons: [
            button('', '/x'),
            button('ok', ''),
            // A label that is ONLY control/bidi codepoints sanitizes to "".
            button('‮​', '/x'),
          ],
        },
      ],
    }),
  );
  assert.deepEqual(decoded, [{ buttons: [] }]);
});

test('label is truncated to 24 chars and command to 256, matching the node caps', () => {
  const decoded = getPayloadButtons(
    chatPayload({ buttons: [{ buttons: [button('x'.repeat(100), '/' + 'y'.repeat(500))] }] }),
  );
  assert.equal(decoded[0].buttons[0].label.length, 24);
  assert.equal(decoded[0].buttons[0].command.length, 256);
});

test('control and bidi codepoints are stripped from label and command (defense against a pre-0.131 node)', () => {
  const decoded = getPayloadButtons(
    chatPayload({ buttons: [{ buttons: [button('1h‮evil', '/c​BTC')] }] }),
  );
  assert.equal(decoded[0].buttons[0].label, '1hevil');
  assert.equal(decoded[0].buttons[0].command, '/cBTC');
});

test('ZWJ emoji sequences survive sanitization (not swept up by the bidi/control strip)', () => {
  const decoded = getPayloadButtons(
    chatPayload({ buttons: [{ buttons: [button('👨‍👩‍👧', '/family')] }] }),
  );
  assert.equal(decoded[0].buttons[0].label, '👨‍👩‍👧');
});
