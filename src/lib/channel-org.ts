/**
 * Channel organization — user-defined groups + custom ordering for the sidebar.
 *
 * The *structure* (groups, names, group order, channel→group assignment, custom
 * per-bucket channel order) is synced across the user's devices through the
 * existing encrypted `SettingsSync` blob (see `settings-sync.ts`). Ephemeral
 * view-state — which group is collapsed, which channel is open — is kept LOCAL
 * per device (`ogmara.groupCollapsed`, `ogmara.lastChannel`) and never synced.
 *
 * The L2 node never sees plaintext (the blob is E2E-encrypted) and stores it as
 * a dumb last-writer-wins value, so cross-device conflicts are resolved here on
 * the client by the `updatedAt` high-water mark: a remote org is applied only
 * when it is strictly newer than the local one (see `applyRemoteOrg`).
 */

import { createSignal } from 'solid-js';

/** A user-created sidebar group. Render order = position in `ChannelOrg.groups`. */
export interface ChannelGroup {
  /** Stable id (crypto.randomUUID); placements reference this, not the name. */
  id: string;
  name: string;
}

/** Where a channel sits. Absent placement = ungrouped + alphabetical (default). */
export interface ChannelPlacement {
  /** Owning group id, or null for the ungrouped bucket. */
  groupId: string | null;
  /** Sort index within its bucket. Lower = higher in the list. */
  order: number;
}

/** The full synced organization payload (one object inside the settings blob). */
export interface ChannelOrg {
  /** Schema version — guards future migrations. */
  v: number;
  /** ms epoch of the last local edit; the client LWW key for sync. */
  updatedAt: number;
  groups: ChannelGroup[];
  /** channel_id → placement. */
  placements: Record<number, ChannelPlacement>;
}

/**
 * Channel shape the resolver needs. `channel_id`/`slug`/`display_name` drive
 * ordering; the remaining optional fields are passed through untouched so the
 * sidebar row renderers can read them off the resolved layout type-safely.
 */
export interface OrgChannel {
  channel_id: number;
  slug: string;
  display_name?: string;
  channel_type?: number;
  creator?: string;
  logo_cid?: string;
  description?: string;
}

export const CHANNEL_ORG_VERSION = 1;

const STORAGE_KEY = 'ogmara.channelOrg';
const COLLAPSE_KEY = 'ogmara.groupCollapsed';

/** Default channel always pinned at the top of the list, never grouped. */
export const DEFAULT_CHANNEL_SLUG = 'ogmara';

// Bounds — keep the synced blob small and reject abusive input. The settings
// blob is hard-capped at 1 MiB on the node; these limits keep us far below it.
const MAX_GROUPS = 50;
const MAX_GROUP_NAME = 32;
// Far above any realistic joined-channel count; bounds a corrupt/oversized blob
// the same way MAX_GROUPS bounds the group array.
const MAX_PLACEMENTS = 2000;

/** An empty, zero-config organization → pure alphabetical, no groups. */
export function emptyOrg(): ChannelOrg {
  return { v: CHANNEL_ORG_VERSION, updatedAt: 0, groups: [], placements: {} };
}

function sanitizeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME);
}

/** Coerce arbitrary parsed JSON into a valid ChannelOrg (defensive). */
function normalizeOrg(raw: unknown): ChannelOrg {
  const org = emptyOrg();
  if (!raw || typeof raw !== 'object') return org;
  const r = raw as Record<string, unknown>;
  if (typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt)) {
    org.updatedAt = r.updatedAt;
  }
  if (Array.isArray(r.groups)) {
    const seen = new Set<string>();
    for (const g of r.groups as unknown[]) {
      if (!g || typeof g !== 'object') continue;
      const id = (g as Record<string, unknown>).id;
      const nm = (g as Record<string, unknown>).name;
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      org.groups.push({ id, name: sanitizeName(typeof nm === 'string' ? nm : '') });
      if (org.groups.length >= MAX_GROUPS) break;
    }
  }
  const validGroupIds = new Set(org.groups.map((g) => g.id));
  if (r.placements && typeof r.placements === 'object') {
    let count = 0;
    for (const [k, v] of Object.entries(r.placements as Record<string, unknown>)) {
      if (count >= MAX_PLACEMENTS) break; // bound a corrupt/oversized blob
      // Only integer-coercible keys reach the assignment — "__proto__",
      // "constructor", etc. coerce to NaN and are skipped, so there is no
      // prototype-pollution path (and the target is a fresh object literal).
      const cid = Number(k);
      if (!Number.isInteger(cid) || !v || typeof v !== 'object') continue;
      const pv = v as Record<string, unknown>;
      const order = typeof pv.order === 'number' && Number.isFinite(pv.order) ? pv.order : 0;
      let groupId = typeof pv.groupId === 'string' ? pv.groupId : null;
      // A placement that references a since-deleted group falls back to ungrouped.
      if (groupId !== null && !validGroupIds.has(groupId)) groupId = null;
      org.placements[cid] = { groupId, order };
      count++;
    }
  }
  return org;
}

// --- Reactive store -------------------------------------------------------

function load(): ChannelOrg {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyOrg();
    return normalizeOrg(JSON.parse(raw));
  } catch {
    return emptyOrg();
  }
}

const [orgSignal, setOrgSignal] = createSignal<ChannelOrg>(load());

/** Reactive accessor — sidebar render reacts to this. */
export const channelOrg = orgSignal;

/** Read the current organization (non-reactive snapshot). */
export function getChannelOrg(): ChannelOrg {
  return orgSignal();
}

/**
 * Persist a new organization locally, stamp `updatedAt`, make it reactive, and
 * schedule a debounced cross-device sync upload. `fromRemote` skips the upload
 * (we just received it) and lets the caller keep the remote `updatedAt`.
 */
function commitOrg(next: ChannelOrg, fromRemote = false): void {
  const org: ChannelOrg = {
    v: CHANNEL_ORG_VERSION,
    updatedAt: fromRemote ? next.updatedAt : Date.now(),
    groups: next.groups.slice(0, MAX_GROUPS),
    placements: next.placements,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(org));
  } catch { /* quota — keep the in-memory copy regardless */ }
  setOrgSignal(org);
  if (!fromRemote) scheduleUpload();
}

// --- Mutations ------------------------------------------------------------

/** Create a group and return its id. */
export function createGroup(name: string): string {
  const org = getChannelOrg();
  if (org.groups.length >= MAX_GROUPS) return '';
  const id = crypto.randomUUID();
  commitOrg({ ...org, groups: [...org.groups, { id, name: sanitizeName(name) }] });
  return id;
}

/** Rename a group; ignored if the name is empty after sanitizing. */
export function renameGroup(id: string, name: string): void {
  const clean = sanitizeName(name);
  if (!clean) return;
  const org = getChannelOrg();
  commitOrg({
    ...org,
    groups: org.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)),
  });
}

/** Delete a group; its channels fall back to ungrouped + alphabetical. */
export function deleteGroup(id: string): void {
  const org = getChannelOrg();
  const placements: Record<number, ChannelPlacement> = {};
  for (const [k, p] of Object.entries(org.placements)) {
    if (p.groupId === id) continue; // drop placement → back to alphabetical ungrouped
    placements[Number(k)] = p;
  }
  commitOrg({ ...org, groups: org.groups.filter((g) => g.id !== id), placements });
}

/** Reorder groups to match the given id order (ids not present are appended). */
export function reorderGroups(orderedIds: string[]): void {
  const org = getChannelOrg();
  const byId = new Map(org.groups.map((g) => [g.id, g]));
  const next: ChannelGroup[] = [];
  for (const id of orderedIds) {
    const g = byId.get(id);
    if (g) { next.push(g); byId.delete(id); }
  }
  for (const g of byId.values()) next.push(g); // safety: keep any leftovers
  commitOrg({ ...org, groups: next });
}

/**
 * Materialize the exact order of one bucket (`groupId` = null for ungrouped).
 * Every listed channel gets an explicit placement, pinning the order the user
 * just produced by dragging. Channels not listed keep their existing placement.
 */
export function setBucketOrder(groupId: string | null, orderedChannelIds: number[]): void {
  const org = getChannelOrg();
  const placements = { ...org.placements };
  orderedChannelIds.forEach((cid, i) => {
    placements[cid] = { groupId, order: i };
  });
  commitOrg({ ...org, placements });
}

/**
 * Move a single channel into a group (or out to ungrouped with `null`),
 * appended at the end of the target bucket. Used by the context-menu fallback.
 */
export function assignChannel(channelId: number, groupId: string | null): void {
  const org = getChannelOrg();
  let maxOrder = -1;
  for (const p of Object.values(org.placements)) {
    if (p.groupId === groupId && p.order > maxOrder) maxOrder = p.order;
  }
  commitOrg({
    ...org,
    placements: { ...org.placements, [channelId]: { groupId, order: maxOrder + 1 } },
  });
}

/** Drop a channel's custom placement → returns it to ungrouped + alphabetical. */
export function clearPlacement(channelId: number): void {
  const org = getChannelOrg();
  if (!(channelId in org.placements)) return;
  const placements = { ...org.placements };
  delete placements[channelId];
  commitOrg({ ...org, placements });
}

/**
 * "Sort A–Z" reset: clear ALL custom channel ordering/placement but KEEP the
 * groups themselves. Every channel returns to its group's alphabetical default
 * (or ungrouped if it had no group). Groups stay so the user keeps their
 * structure; only manual ordering is wiped.
 */
export function resetToAlphabetical(): void {
  const org = getChannelOrg();
  commitOrg({ ...org, placements: {} });
}

// --- Remote sync ----------------------------------------------------------

/**
 * Apply an organization received from another device. Last-writer-wins by
 * `updatedAt`; on an exact-millisecond tie, a deterministic content comparison
 * picks the same winner on every device so they still converge (and never
 * ping-pong, since a remote apply does not re-upload). Returns the channel ids
 * placed in the incoming org so the caller can auto-join them — a synced
 * placement implies the channel should be visible on this device.
 */
export function applyRemoteOrg(raw: unknown): number[] {
  const remote = normalizeOrg(raw);
  const local = getChannelOrg();
  if (remote.updatedAt < local.updatedAt) return [];
  if (remote.updatedAt === local.updatedAt) {
    // Tie-break deterministically; skip if local already is (or outranks) remote.
    if (JSON.stringify(remote) <= JSON.stringify(local)) return [];
  }
  commitOrg(remote, /* fromRemote */ true);
  return Object.keys(remote.placements).map(Number).filter(Number.isInteger);
}

// --- Debounced upload (decoupled to avoid an import cycle) -----------------

let uploadTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleUpload(): void {
  if (typeof window === 'undefined') return;
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(async () => {
    uploadTimer = null;
    try {
      // Dynamic imports break the static cycle (settings-sync imports us back).
      const [{ vaultExportKey }, { uploadSettings }] = await Promise.all([
        import('./vault'),
        import('./settings-sync'),
      ]);
      const key = await vaultExportKey();
      if (key) await uploadSettings(key);
    } catch { /* best-effort; local copy already persisted */ }
  }, 2500);
}

// --- Local per-device collapse state (NOT synced) -------------------------

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const [collapsedSignal, setCollapsedSignal] = createSignal<Record<string, boolean>>(loadCollapsed());

/** Whether a group is currently collapsed on this device. */
export function isGroupCollapsed(id: string): boolean {
  return collapsedSignal()[id] === true;
}

/** Toggle a group's collapsed state (local only — never synced). */
export function toggleGroupCollapsed(id: string): void {
  const next = { ...collapsedSignal(), [id]: !isGroupCollapsed(id) };
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  setCollapsedSignal(next);
}

// --- Layout resolver ------------------------------------------------------

/** A resolved group with its ordered channels. */
export interface ResolvedGroup {
  group: ChannelGroup;
  channels: OrgChannel[];
}

/** The full ordered sidebar layout produced from channels + organization. */
export interface SidebarLayout {
  /** The pinned default channel, rendered first and never draggable (if joined). */
  defaultChannel: OrgChannel | null;
  groups: ResolvedGroup[];
  ungrouped: OrgChannel[];
}

function alpha(a: OrgChannel, b: OrgChannel): number {
  return (a.display_name || a.slug).localeCompare(b.display_name || b.slug, undefined, {
    sensitivity: 'base',
  });
}

/**
 * Produce the ordered sidebar layout. Rules:
 *  1. The default channel is pinned first, never grouped.
 *  2. Groups render in `org.groups` order; channels within a group by their
 *     placement `order`.
 *  3. Ungrouped channels: those with an explicit placement first (by `order`),
 *     then the rest alphabetically — so a fresh, un-customized list is purely
 *     alphabetical (requirement: alphabetical by default).
 */
export function resolveSidebarLayout(channels: OrgChannel[], org: ChannelOrg): SidebarLayout {
  const groups: ResolvedGroup[] = org.groups.map((g) => ({ group: g, channels: [] }));
  const groupIndex = new Map(groups.map((rg) => [rg.group.id, rg]));

  let defaultChannel: OrgChannel | null = null;
  const ungroupedPinned: { ch: OrgChannel; order: number }[] = [];
  const ungroupedAuto: OrgChannel[] = [];

  for (const ch of channels) {
    if (ch.slug === DEFAULT_CHANNEL_SLUG) { defaultChannel = ch; continue; }
    const p = org.placements[ch.channel_id];
    if (p && p.groupId && groupIndex.has(p.groupId)) {
      groupIndex.get(p.groupId)!.channels.push(ch);
    } else if (p && p.groupId === null) {
      ungroupedPinned.push({ ch, order: p.order });
    } else {
      ungroupedAuto.push(ch);
    }
  }

  // Within each group, order by placement.order (fall back to alpha for ties).
  for (const rg of groups) {
    rg.channels.sort((a, b) => {
      const oa = org.placements[a.channel_id]?.order ?? 0;
      const ob = org.placements[b.channel_id]?.order ?? 0;
      return oa !== ob ? oa - ob : alpha(a, b);
    });
  }

  ungroupedPinned.sort((a, b) => (a.order !== b.order ? a.order - b.order : alpha(a.ch, b.ch)));
  ungroupedAuto.sort(alpha);

  return {
    defaultChannel,
    groups,
    ungrouped: [...ungroupedPinned.map((x) => x.ch), ...ungroupedAuto],
  };
}
