/**
 * Core of the automatic synced-objects pull (`downloadChannelOrg` in
 * settings-sync.ts), with its I/O injected so the account-switch guard is
 * testable under `node --test` (orgPull.test.ts) — settings-sync.ts itself
 * imports the Tauri-bound API client.
 *
 * Every `await` here can straddle an account switch. Each one is followed by a
 * `sameAccount()` check BEFORE anything is written to account-scoped storage
 * or uploaded: applying afterwards would file account A's channel
 * organisation / hidden DMs / topic follows under account B, and the
 * re-upload would seal them under A's key (`hexKey`) while authenticated as B
 * — linking the two accounts' interest graphs on the node.
 */

export interface OrgPullBlob {
  encrypted_settings: ArrayLike<number> | Uint8Array;
  nonce: ArrayLike<number> | Uint8Array;
}

export interface OrgPullDeps {
  /** True while the account that started the pull is still active on EVERY
   *  "who's active" signal (walletAddress AND wallet scope). */
  sameAccount: () => boolean;
  /** The captured account's own key, exported AFTER capture (accountKey.ts),
   *  or null. Never a key handed in from before the capture. */
  getKey: () => Promise<string | null>;
  fetch: () => Promise<OrgPullBlob | null | undefined>;
  /** Derive + decrypt; returns the parsed settings object. */
  decrypt: (blob: OrgPullBlob, hexKey: string) => Promise<Record<string, unknown>>;
  applyOrg: (org: object) => number[];
  addJoined: (ids: number[]) => void;
  applyHidden: (hidden: object) => void;
  applyTopics: (topics: object) => void;
  localTimestamp: () => number;
  remoteTimestamp: (settings: Record<string, unknown>) => number;
  upload: () => void;
}

export const ORG_KEYS = { org: 'channelOrg', hidden: 'hiddenDms', topics: 'topicGroups' } as const;

/** Returns whether anything was applied. Never throws (best-effort). */
export async function runChannelOrgPull(deps: OrgPullDeps): Promise<boolean> {
  try {
    if (!deps.sameAccount()) return false;
    const hexKey = await deps.getKey();
    if (!hexKey || !deps.sameAccount()) return false;
    const resp = await deps.fetch();
    if (!deps.sameAccount()) return false;
    if (!resp) {
      // Fresh node with nothing for this wallet. If THIS device holds real
      // synced state, seed the node once — it then gossips it to the mesh so
      // every node converges. Safe: the upload carries the content's own
      // `updated_at`, so a node that already has a newer copy will LWW-drop it.
      if (deps.localTimestamp() > 0) deps.upload();
      return false;
    }
    const settings = await deps.decrypt(resp, hexKey);
    // Re-checked AFTER the decrypt await, immediately before the first write.
    if (!deps.sameAccount()) return false;
    let applied = false;
    const org = settings?.[ORG_KEYS.org];
    if (org && typeof org === 'object') {
      const placedIds = deps.applyOrg(org);
      if (placedIds.length) deps.addJoined(placedIds);
      applied = true;
    }
    const hidden = settings?.[ORG_KEYS.hidden];
    if (hidden && typeof hidden === 'object') {
      deps.applyHidden(hidden);
      applied = true;
    }
    const topics = settings?.[ORG_KEYS.topics];
    if (topics && typeof topics === 'object') {
      deps.applyTopics(topics);
      applied = true;
    }
    // This device's copy is strictly newer than the node's → push it up once so
    // this node — and, via its re-gossip, every other node — converges to it.
    if (deps.localTimestamp() > deps.remoteTimestamp(settings)) deps.upload();
    return applied;
  } catch {
    return false;
  }
}
