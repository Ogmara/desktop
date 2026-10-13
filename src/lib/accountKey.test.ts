/**
 * exportKeyForCaptured (desktop 1.82.0). Run:
 *   node --conditions=browser --test src/lib/accountKey.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportKeyForCaptured, type CapturedAccount } from './accountKey.ts';

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);
const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);
const derive = async (k: string) => (k === KEY_A ? A : k === KEY_B ? B : 'klv1unknown');

/** Simulated session: `gen` bumps the moment a switch starts. */
function session() {
  const s = { wallet: A as string | null, gen: 1 };
  const still = (cap: CapturedAccount) => cap.gen === s.gen && cap.wallet === s.wallet;
  return { s, still };
}

test('control: no switch → the captured account\'s own key', async () => {
  const { s, still } = session();
  const cap = { wallet: s.wallet, gen: s.gen };
  assert.equal(await exportKeyForCaptured(cap, { still, exportKey: async () => KEY_A, deriveAddress: derive }), KEY_A);
});

test('switch begins while the key is being exported → null (even though walletAddress still says A)', async () => {
  const { s, still } = session();
  const cap = { wallet: s.wallet, gen: s.gen };
  const key = await exportKeyForCaptured(cap, {
    still,
    // vaultActivate(B) runs inside the switch: the generation bumps first and
    // the vault now hands out B's key; walletAddress/scope are still A.
    exportKey: async () => { s.gen++; return KEY_B; },
    deriveAddress: derive,
  });
  assert.equal(key, null);
});

test('key already flipped to B before the generation check would notice → caught by key ownership', async () => {
  const { s, still } = session();
  const cap = { wallet: s.wallet, gen: s.gen }; // captured mid-switch: gen already bumped, wallet still A
  const key = await exportKeyForCaptured(cap, { still, exportKey: async () => KEY_B, deriveAddress: derive });
  assert.equal(key, null);
});

test('the pre-fix order (export first, capture second) is exactly what this rejects', async () => {
  const { s, still } = session();
  // Pre-fix: key exported while the vault already pointed at B...
  const exported = KEY_B;
  // ...then "who am I" captured from signals that still say A.
  const cap = { wallet: s.wallet, gen: s.gen };
  assert.equal(await exportKeyForCaptured(cap, { still, exportKey: async () => exported, deriveAddress: derive }), null);
});

test('switch during the derivation await → null', async () => {
  const { s, still } = session();
  const cap = { wallet: s.wallet, gen: s.gen };
  const key = await exportKeyForCaptured(cap, {
    still, exportKey: async () => KEY_A,
    deriveAddress: async (k) => { s.gen++; return derive(k); },
  });
  assert.equal(key, null);
});

test('no wallet, no key, or export/derive failures → null', async () => {
  const { still } = session();
  const deps = { still, exportKey: async () => KEY_A, deriveAddress: derive };
  assert.equal(await exportKeyForCaptured({ wallet: null, gen: 1 }, deps), null);
  assert.equal(await exportKeyForCaptured({ wallet: A, gen: 1 }, { ...deps, exportKey: async () => null }), null);
  assert.equal(await exportKeyForCaptured({ wallet: A, gen: 1 }, { ...deps, exportKey: async () => { throw new Error('x'); } }), null);
  assert.equal(await exportKeyForCaptured({ wallet: A, gen: 1 }, { ...deps, deriveAddress: async () => { throw new Error('x'); } }), null);
});

// Source probe: no caller hands settings-sync a key exported before capture.
import { readFileSync } from 'node:fs';
test('settings-sync callers do not export a key and pass it in', () => {
  for (const f of ['./channel-org.ts', './dm-hide.ts', './topic-groups.ts', '../components/Sidebar.tsx', '../pages/SettingsView.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /uploadSettings\(\s*key\s*\)|downloadSettings\(\s*key\s*\)|downloadChannelOrg\(\s*key\s*\)/, f);
    assert.doesNotMatch(src, /vaultExportKey\(\)[\s\S]{0,200}(uploadSettings|downloadSettings|downloadChannelOrg)\(/, f);
  }
});
