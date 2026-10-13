/**
 * Account-binding core of the E2E key-recovery vault (keyVault.ts), with I/O
 * injected so the cross-account rules are testable under `node --test`
 * (keyVaultCore.test.ts). keyVault.ts itself imports the Tauri-bound client.
 *
 * The rules, each of which was a way for one account's keys to reach another:
 *  - A backup key is always tagged with the wallet it was derived FOR, and a
 *    derivation in flight for one wallet is never handed to a caller asking
 *    for another (the old `if (bkInflight) return bkInflight` did exactly that).
 *  - Clearing the session also abandons any in-flight derivation: its result
 *    is dropped instead of being cached for whoever is active when it lands.
 *  - Restore uses a key only if it belongs to the wallet the restore was
 *    started for; a decrypt failure with a key that might not be that wallet's
 *    is NOT terminal (terminal `done` re-arms the backup, which would then
 *    overwrite the account's real remote vault with a partial keyring).
 *  - Publish seals and sends only while the wallet, the generation and the
 *    key's wallet all still match.
 */

export interface BackupKey {
  key: Uint8Array;
  /** The wallet this key was derived for (by that wallet's own signer). */
  wallet: string;
}

export interface BackupKeyCache {
  /** The backup key for `wallet` — cached, joined in flight, or derived. */
  ensure(wallet: string | null): Promise<BackupKey | null>;
  /** Zero + forget the cached key and abandon any in-flight derivation. */
  clear(): void;
  /** Test/introspection: the wallet of the cached key, if any. */
  cachedWallet(): string | null;
}

/**
 * `derive(wallet)` MUST sign with `wallet`'s own signer and throw otherwise
 * (keyVault.ts uses `signMessageAs`).
 */
export function createBackupKeyCache(
  derive: (wallet: string) => Promise<Uint8Array>,
  onError?: (e: unknown) => void,
): BackupKeyCache {
  let cached: BackupKey | null = null;
  let inflight: { wallet: string; p: Promise<BackupKey | null> } | null = null;
  let epoch = 0;

  return {
    ensure(wallet) {
      if (!wallet) return Promise.resolve(null);
      if (cached && cached.wallet === wallet) return Promise.resolve(cached);
      // Join an in-flight derivation ONLY if it is for this same wallet.
      if (inflight && inflight.wallet === wallet) return inflight.p;
      const myEpoch = epoch;
      const entry: { wallet: string; p: Promise<BackupKey | null> } = { wallet, p: Promise.resolve(null) };
      entry.p = (async () => {
        try {
          const key = await derive(wallet);
          // Session cleared (account switch / disconnect) while deriving:
          // drop the result rather than caching it for whoever is active now.
          if (epoch !== myEpoch) { key.fill(0); return null; }
          if (cached && cached.wallet !== wallet) cached.key.fill(0);
          cached = { key, wallet };
          return cached;
        } catch (e) {
          onError?.(e);
          return null;
        } finally {
          if (inflight === entry) inflight = null;
        }
      })();
      inflight = entry;
      return entry.p;
    },
    clear() {
      cached?.key.fill(0);
      cached = null;
      inflight = null;
      epoch++;
    },
    cachedWallet: () => cached?.wallet ?? null,
  };
}

export type RestoreOutcome = 'idle' | 'done';

export interface RestoreDeps<Resp, Keyring> {
  /** Wallet the restore was started for (captured before any await). */
  forWallet: string | null;
  /** True once the account switched / a switch started since capture. */
  stale: () => boolean;
  ensureKey: (wallet: string | null) => Promise<BackupKey | null>;
  /** Resolves null only on a genuine 404; throws on transient failure. */
  fetch: () => Promise<Resp | null>;
  open: (key: Uint8Array, resp: Resp) => Keyring;
  importKeys: (keyring: Keyring) => void;
  log?: (step: string, data?: Record<string, unknown>) => void;
}

/** One restore attempt. `idle` = retry on a later trigger; `done` = terminal. */
export async function runRestore<Resp, Keyring>(d: RestoreDeps<Resp, Keyring>): Promise<RestoreOutcome> {
  if (!d.forWallet || d.stale()) return 'idle';
  const bk = await d.ensureKey(d.forWallet);
  if (d.stale()) return 'idle';
  if (!bk) return 'idle'; // no wallet / declined popup — allow a later retry
  if (bk.wallet !== d.forWallet) return 'idle'; // never use another wallet's key
  let resp: Resp | null;
  try {
    resp = await d.fetch();
  } catch (e) {
    d.log?.('keyvault: restore fetch failed (will retry)', { err: (e as Error)?.message });
    return 'idle';
  }
  if (d.stale()) return 'idle';
  if (resp) {
    let keyring: Keyring;
    try {
      keyring = d.open(bk.key, resp);
    } catch (e) {
      // Terminal ONLY when we know the key was this wallet's and nothing moved:
      // a genuinely corrupt/foreign blob. Otherwise retry later, so `done`
      // can't re-arm a backup that would clobber the real remote vault.
      if (d.stale() || bk.wallet !== d.forWallet) return 'idle';
      d.log?.('keyvault: restore decrypt failed', { err: (e as Error)?.message });
      return 'done';
    }
    // Re-checked immediately before the writes themselves.
    if (d.stale()) return 'idle';
    d.importKeys(keyring);
  }
  return 'done';
}

export interface PublishDeps<Keyring, Sealed> {
  /** Wallet + generation captured before any await. */
  sealWallet: string | null;
  stale: () => boolean;
  keyring: Keyring;
  isEmpty: (k: Keyring) => boolean;
  ensureKey: (wallet: string | null) => Promise<BackupKey | null>;
  seal: (key: Uint8Array, k: Keyring) => Sealed;
  send: (sealed: Sealed) => Promise<void>;
}

/** Seal + send the keyring. Returns whether it was sent. */
export async function runPublish<Keyring, Sealed>(d: PublishDeps<Keyring, Sealed>): Promise<boolean> {
  if (!d.sealWallet || d.stale() || d.isEmpty(d.keyring)) return false;
  const bk = await d.ensureKey(d.sealWallet);
  if (!bk || bk.wallet !== d.sealWallet || d.stale()) return false;
  const sealed = d.seal(bk.key, d.keyring);
  // Sealing is synchronous; the client binds its signer at call time.
  if (d.stale()) return false;
  await d.send(sealed);
  return true;
}
