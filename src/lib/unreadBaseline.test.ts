/**
 * Fresh-account unread baseline (desktop 1.82.0): the flag is per wallet,
 * wiped with the account, and set ONLY on create-new paths. Run:
 *   node --conditions=browser --test src/lib/unreadBaseline.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
}
let storage = new MemStorage();
(globalThis as unknown as { localStorage: Storage }).localStorage = storage as unknown as Storage;

const { markUnreadBaselinePending, isUnreadBaselinePending, clearUnreadBaselinePending } =
  await import('./unreadBaseline.ts');
const { wipeWalletScope } = await import('./walletScope.ts');

const A = 'klv1' + 'a'.repeat(58);
const B = 'klv1' + 'b'.repeat(58);

beforeEach(() => {
  storage = new MemStorage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage as unknown as Storage;
});

test('flag is per wallet, independent of the active scope', () => {
  markUnreadBaselinePending(A);
  assert.equal(isUnreadBaselinePending(A), true);
  assert.equal(isUnreadBaselinePending(B), false);
  clearUnreadBaselinePending(A);
  assert.equal(isUnreadBaselinePending(A), false);
  assert.equal(isUnreadBaselinePending(null), false);
  assert.equal(isUnreadBaselinePending(''), false);
});

test('removing the account wipes the flag', () => {
  markUnreadBaselinePending(A);
  markUnreadBaselinePending(B);
  wipeWalletScope(A);
  assert.equal(isUnreadBaselinePending(A), false);
  assert.equal(isUnreadBaselinePending(B), true);
});

// --- Source probes: only the create-new paths set the flag ---------------

/** Body of `export async function <name>(` up to the next top-level `\n}`. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end);
}
/** Same, for a nested (2-space indented) function inside a component. */
function innerFnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const end = src.indexOf('\n  }', start);
  return src.slice(start, end);
}

function checkAuth(src: string): string[] {
  const problems: string[] = [];
  if (!/markUnreadBaselinePending\(address\)/.test(fnBody(src, 'generateWallet'))) problems.push('generateWallet does not set the flag');
  for (const fn of ['connectWithKey', 'initAuth', 'switchAccountInner']) {
    if (/markUnreadBaselinePending/.test(fnBody(src, fn))) problems.push(`${fn} sets the flag`);
  }
  return problems;
}

const authSrc = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
const addSrc = readFileSync(new URL('../pages/AddAccountView.tsx', import.meta.url), 'utf8');

test('auth.ts: generateWallet sets the flag; import / restore / switch do not', () => {
  assert.deepEqual(checkAuth(authSrc), []);
});

test('negative control: the probe catches the flag on the import path', () => {
  const bad = authSrc.replace(
    /(export async function connectWithKey\([^)]*\)[^{]*\{\n)/,
    '$1  markUnreadBaselinePending(hexKey);\n',
  );
  assert.notEqual(bad, authSrc);
  assert.ok(checkAuth(bad).includes('connectWithKey sets the flag'));
});

test('AddAccountView: Create passes fresh=true, Import passes fresh=false, flag gated on fresh', () => {
  assert.match(innerFnBody(addSrc, 'onCreate'), /add\(randomKeyHex\(\), true\)/);
  assert.match(innerFnBody(addSrc, 'onImport'), /add\(hex, false\)/);
  assert.match(innerFnBody(addSrc, 'add'), /if \(fresh\) markUnreadBaselinePending\(addr\)/);
  // Exactly one call site in the file.
  assert.equal(addSrc.match(/markUnreadBaselinePending\(/g)?.length, 1);
});

test('only auth.ts and AddAccountView call markUnreadBaselinePending', async () => {
  const { readdirSync } = await import('node:fs');
  const callers: string[] = [];
  const walk = (dir: URL) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
      if (e.isDirectory()) walk(u);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && e.name !== 'unreadBaseline.ts') {
        if (/markUnreadBaselinePending\(/.test(readFileSync(u, 'utf8'))) callers.push(e.name);
      }
    }
  };
  walk(new URL('../', import.meta.url));
  assert.deepEqual(callers.sort(), ['AddAccountView.tsx', 'auth.ts']);
});
