/**
 * Account-switch guard for the synced-objects pull (desktop 1.82.0). Run:
 *   node --conditions=browser --test src/lib/orgPull.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runChannelOrgPull, type OrgPullDeps, type OrgPullBlob } from './orgPull.ts';

const BLOB: OrgPullBlob = { encrypted_settings: [1], nonce: [2] };
const REMOTE = {
  channelOrg: { updatedAt: 1, groups: [] },
  hiddenDms: { klv1peer: 5 },
  topicGroups: { updatedAt: 1 },
};

/** Deps that record every write; `flipAt` names the await after which the
 *  active account changes ('fetch' | 'decrypt' | null). */
function harness(opts: { flipAt?: 'key' | 'fetch' | 'decrypt' | null; fetchResult?: OrgPullBlob | null; local?: number; key?: string | null } = {}) {
  let active = true;
  const writes: string[] = [];
  const deps: OrgPullDeps = {
    sameAccount: () => active,
    getKey: async () => {
      if (opts.flipAt === 'key') active = false;
      return opts.key === undefined ? 'aa'.repeat(32) : opts.key;
    },
    fetch: async () => {
      if (opts.flipAt === 'fetch') active = false;
      return opts.fetchResult === undefined ? BLOB : opts.fetchResult;
    },
    decrypt: async () => {
      if (opts.flipAt === 'decrypt') active = false;
      return REMOTE;
    },
    applyOrg: () => { writes.push('applyOrg'); return [7]; },
    addJoined: () => { writes.push('addJoined'); },
    applyHidden: () => { writes.push('applyHidden'); },
    applyTopics: () => { writes.push('applyTopics'); },
    localTimestamp: () => opts.local ?? 10,
    remoteTimestamp: () => 1,
    upload: () => { writes.push('upload'); },
  };
  return { deps, writes };
}

test('baseline: same account throughout applies everything and re-uploads the newer local copy', async () => {
  const h = harness();
  assert.equal(await runChannelOrgPull(h.deps), true);
  assert.deepEqual(h.writes, ['applyOrg', 'addJoined', 'applyHidden', 'applyTopics', 'upload']);
});

test('account switches DURING the decrypt await: no writes, no upload', async () => {
  const h = harness({ flipAt: 'decrypt' });
  assert.equal(await runChannelOrgPull(h.deps), false);
  assert.deepEqual(h.writes, []);
});

test('switch begins while the key is being exported: no fetch-driven writes, no upload', async () => {
  const h = harness({ flipAt: 'key' });
  assert.equal(await runChannelOrgPull(h.deps), false);
  assert.deepEqual(h.writes, []);
});

test('switch during key export on an EMPTY node: the seeding upload does not fire', async () => {
  const h = harness({ flipAt: 'key', fetchResult: null });
  await runChannelOrgPull(h.deps);
  assert.deepEqual(h.writes, []);
});

test('no provable key for the captured account: nothing happens', async () => {
  const h = harness({ key: null });
  assert.equal(await runChannelOrgPull(h.deps), false);
  assert.deepEqual(h.writes, []);
});

test('account switches during the fetch await: no writes, no upload', async () => {
  const h = harness({ flipAt: 'fetch' });
  assert.equal(await runChannelOrgPull(h.deps), false);
  assert.deepEqual(h.writes, []);
});

test('empty node + switch during fetch: no seeding upload under the wrong account', async () => {
  const h = harness({ flipAt: 'fetch', fetchResult: null });
  await runChannelOrgPull(h.deps);
  assert.deepEqual(h.writes, []);
});

test('empty node, same account: seeds once when this device has synced state', async () => {
  const h = harness({ fetchResult: null });
  assert.equal(await runChannelOrgPull(h.deps), false);
  assert.deepEqual(h.writes, ['upload']);
});

test('negative control: a guard that misses the switch lets the harness observe the leak', async () => {
  // Same mid-decrypt switch, but with a guard that never notices it (the
  // pre-fix shape, where the only check ran BEFORE the decrypt await). The
  // harness must see writes here — otherwise the tests above prove nothing.
  const h = harness({ flipAt: 'decrypt' });
  await runChannelOrgPull({ ...h.deps, sameAccount: () => true });
  assert.ok(h.writes.includes('applyOrg') && h.writes.includes('upload'));
});

// Source probe: the decryptAndApplySettings path is not injectable (Tauri
// client import), so verify the account check follows its LAST await.
test('settings-sync: every await before a write in decryptAndApplySettings / uploadSettings is followed by stillFor', () => {
  const src = readFileSync(new URL('./settings-sync.ts', import.meta.url), 'utf8');
  for (const name of ['decryptAndApplySettings', 'uploadSettings']) {
    const start = src.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `${name} not found`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    // Code awaits only (not the word in comments): `= await`, `return await`, or a statement start.
    const awaits = [...body.matchAll(/(?:=|return|^)[ \t]*await /gm)].map((m) => m.index!);
    assert.ok(awaits.length >= 1, `${name}: no awaits found`);
    const lastWriteFree = name === 'uploadSettings'
      ? awaits.slice(0, -1) // the final await IS the upload itself
      : awaits;
    for (const idx of lastWriteFree) {
      const stmtEnd = body.indexOf(');\n', idx);
      const after = body.slice(stmtEnd, stmtEnd + 200);
      assert.match(after, /if \((!hexKey \|\| )?!stillFor\(forWallet\)\) return/, `${name}: no account re-check after await at ${idx}`);
    }
  }
  // downloadChannelOrg delegates to the tested core, with the key resolved
  // for the captured account (never a key passed in by a caller).
  assert.match(src, /return runChannelOrgPull\(\{\n\s+sameAccount: \(\) => stillFor\(forWallet\),\n\s+getKey: \(\) => keyForCaptured\(forWallet\)/);
  // The account is captured before ANY key export in every entry point.
  for (const name of ['uploadSettings', 'downloadSettings', 'downloadChannelOrg']) {
    const start = src.indexOf(`export async function ${name}(`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.doesNotMatch(body, /vaultExportKey\(/, `${name} must not export a key directly`);
    assert.doesNotMatch(src.slice(start, src.indexOf('{', start)), /hexKey/, `${name} must not take a key parameter`);
  }
  // The generation is part of the account check.
  assert.match(src, /currentSwitchGeneration\(\) === cap\.gen/);
});
