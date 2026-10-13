/**
 * Resolve the wallet key for an account CAPTURED before the key was exported.
 *
 * Why this exists: an account switch flips the vault's active account
 * (`vaultActivate`, so `vaultExportKey()` already returns the NEW account's
 * key) several awaits before `walletAddress()` and the storage scope flip.
 * A caller that exported the key first and captured "who am I" second could
 * therefore hold account B's key while every account check still said A —
 * and settings-sync would seal A's data under B's key and upload it as A,
 * making A's synced copy undecryptable everywhere.
 *
 * The order here is the fix: capture (wallet + switch generation) FIRST,
 * export SECOND, then require that the generation hasn't moved and that the
 * key actually derives to the captured wallet. Pure (I/O injected) so the
 * ordering is unit-tested (accountKey.test.ts).
 */

export interface CapturedAccount {
  wallet: string | null;
  /** `currentSwitchGeneration()` at capture time. */
  gen: number;
}

export interface AccountKeyDeps {
  /** True while `cap` is still the active account on every signal AND no
   *  switch has started since (generation unchanged). */
  still: (cap: CapturedAccount) => boolean;
  exportKey: () => Promise<string | null>;
  deriveAddress: (hexKey: string) => Promise<string>;
}

/** The captured account's key, or `null` if it can't be proven to be theirs. */
export async function exportKeyForCaptured(
  cap: CapturedAccount,
  deps: AccountKeyDeps,
): Promise<string | null> {
  if (!cap.wallet || !deps.still(cap)) return null;
  let key: string | null;
  try {
    key = await deps.exportKey();
  } catch {
    return null;
  }
  if (!key || !deps.still(cap)) return null;
  let owner: string;
  try {
    owner = await deps.deriveAddress(key);
  } catch {
    return null;
  }
  if (owner !== cap.wallet || !deps.still(cap)) return null;
  return key;
}
