/**
 * "Is this still the account that started the operation?" — for long-running
 * flows that await (on-chain confirmation, network round trips) and then sign
 * or write with the SHARED API client / account-scoped storage.
 *
 * An account switch keeps every view mounted and re-points the one shared
 * client at the new account's signer (`withSigner`), so a flow that captured
 * nothing would silently finish as whichever account is active when it
 * resumes — signing as it, and writing into its storage.
 *
 * Every signal must still equal the captured account; any unknown is "no".
 * Pure, so the rule is unit-testable (accountGuard.test.ts).
 */
export function stillSameAccount(
  captured: string | null | undefined,
  ...current: (string | null | undefined)[]
): boolean {
  if (!captured) return false;
  return current.every((c) => c === captured);
}
