/**
 * Split a hash route (`chat/1?msg=…`, `join/5000000001?node=…&inv=…`) into its
 * path and decoded query parameters. Kept free of imports so it is testable
 * under `node --test` (router.ts needs `window` and settings).
 *
 * Carry-through rules (the private-channel personal invite link depends on
 * them — spec 05 §8.4): the path ends at the FIRST `?`, and each `k=v` pair is
 * split on its FIRST `=`, so a value containing `=` or `?` is passed through
 * whole for the consumer to validate. A pair with a malformed percent-escape
 * is dropped rather than throwing out of the router (which would break every
 * route for a pasted link). The result has no prototype, so a `__proto__`
 * key is stored as plain data.
 */
export function splitHashRoute(raw: string): { path: string; query: Record<string, string> } {
  const qIdx = raw.indexOf('?');
  const path = qIdx < 0 ? raw : raw.slice(0, qIdx);
  const queryStr = qIdx < 0 ? '' : raw.slice(qIdx + 1);
  const query: Record<string, string> = Object.create(null);
  if (queryStr) {
    for (const pair of queryStr.split('&')) {
      const eq = pair.indexOf('=');
      const k = eq < 0 ? pair : pair.slice(0, eq);
      const v = eq < 0 ? '' : pair.slice(eq + 1);
      if (!k) continue;
      try {
        query[decodeURIComponent(k)] = decodeURIComponent(v);
      } catch {
        /* malformed escape — ignore this pair */
      }
    }
  }
  return { path, query };
}
