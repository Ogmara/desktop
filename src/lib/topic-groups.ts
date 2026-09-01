/**
 * Followed news topics — hashtags the user follows, optionally organized into
 * named subgroups, for the News Feed sidebar.
 *
 * Mirrors `channel-org.ts` in every structural respect: the object is carried
 * inside the existing encrypted `SettingsSync` blob (see `settings-sync.ts`),
 * the L2 node stores it as an opaque last-writer-wins value, and cross-device
 * conflicts are resolved here by the `updatedAt` high-water mark (a remote copy
 * is applied only when strictly newer — `applyRemoteTopicGroups`). A remote
 * apply never re-uploads, so devices converge and never ping-pong.
 *
 * Every hashtag is stored in the node's canonical form (`normalizeHashtag`,
 * protocol §3.5) — a follow that normalizes differently from the node would
 * silently match nothing.
 */

import { createSignal } from 'solid-js';
import { normalizeHashtag } from '@ogmara/sdk';

/** A user-named subgroup of followed hashtags. Render order = array order. */
export interface TopicGroup {
  /** Stable id (crypto.randomUUID). */
  id: string;
  name: string;
  /** Canonical hashtags in this group — a subset of `follows`. */
  tags: string[];
}

/** The full synced object (one key inside the settings blob). */
export interface TopicGroups {
  /** Schema version — guards future migrations. */
  v: number;
  /** ms epoch of the last local edit; the client LWW key for sync. */
  updatedAt: number;
  /** Every followed hashtag (canonical form). The "Followed Topics" entry. */
  follows: string[];
  groups: TopicGroup[];
}

export const TOPIC_GROUPS_VERSION = 1;

const STORAGE_KEY = 'ogmara.topicGroups';

// Bounds — keep the synced blob small (node caps the whole blob at 1 MiB).
const MAX_FOLLOWS = 200;
const MAX_GROUPS = 20;
const MAX_TAGS_PER_GROUP = 50;
const MAX_GROUP_NAME = 32;

/** An empty, zero-config topic set. */
export function emptyTopicGroups(): TopicGroups {
  return { v: TOPIC_GROUPS_VERSION, updatedAt: 0, follows: [], groups: [] };
}

function sanitizeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME);
}

/** Normalize + dedupe a list of raw tags, capped at `max`, preserving order. */
function cleanTags(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const n = normalizeHashtag(t);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

/** Coerce arbitrary parsed JSON into a valid TopicGroups (defensive). */
function normalize(raw: unknown): TopicGroups {
  const tg = emptyTopicGroups();
  if (!raw || typeof raw !== 'object') return tg;
  const r = raw as Record<string, unknown>;
  if (typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt)) {
    tg.updatedAt = r.updatedAt;
  }
  tg.follows = cleanTags(r.follows, MAX_FOLLOWS);
  const followSet = new Set(tg.follows);
  if (Array.isArray(r.groups)) {
    const seenIds = new Set<string>();
    for (const g of r.groups as unknown[]) {
      if (!g || typeof g !== 'object') continue;
      const gr = g as Record<string, unknown>;
      if (typeof gr.id !== 'string' || seenIds.has(gr.id)) continue;
      seenIds.add(gr.id);
      // A group tag must also be a follow (the union invariant).
      const tags = cleanTags(gr.tags, MAX_TAGS_PER_GROUP).filter((t) => followSet.has(t));
      tg.groups.push({
        id: gr.id,
        name: sanitizeName(typeof gr.name === 'string' ? gr.name : ''),
        tags,
      });
      if (tg.groups.length >= MAX_GROUPS) break;
    }
  }
  return tg;
}

// --- Reactive store -------------------------------------------------------

function load(): TopicGroups {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyTopicGroups();
    return normalize(JSON.parse(raw));
  } catch {
    return emptyTopicGroups();
  }
}

const [signal, setSignal] = createSignal<TopicGroups>(load());

/** Reactive accessor — the sidebar reacts to this. */
export const topicGroups = signal;

/** Non-reactive snapshot. */
export function getTopicGroups(): TopicGroups {
  return signal();
}

/** Whether the caps have been reached (drives a UI hint). */
export function topicCaps() {
  const tg = signal();
  return {
    follows: { count: tg.follows.length, max: MAX_FOLLOWS, full: tg.follows.length >= MAX_FOLLOWS },
    groups: { count: tg.groups.length, max: MAX_GROUPS, full: tg.groups.length >= MAX_GROUPS },
    maxTagsPerGroup: MAX_TAGS_PER_GROUP,
  };
}

function commit(next: TopicGroups, fromRemote = false): void {
  const tg: TopicGroups = {
    v: TOPIC_GROUPS_VERSION,
    updatedAt: fromRemote ? next.updatedAt : Date.now(),
    follows: next.follows.slice(0, MAX_FOLLOWS),
    groups: next.groups.slice(0, MAX_GROUPS),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tg));
  } catch {
    /* quota — keep the in-memory copy regardless */
  }
  setSignal(tg);
  if (!fromRemote) scheduleUpload();
}

// --- Mutations ----------------------------------------------------------

/** Follow a hashtag (any raw form). No-op if invalid or already followed / at cap. */
export function followTag(raw: string): void {
  const n = normalizeHashtag(raw);
  if (!n) return;
  const tg = getTopicGroups();
  if (tg.follows.includes(n) || tg.follows.length >= MAX_FOLLOWS) return;
  commit({ ...tg, follows: [...tg.follows, n] });
}

/** Unfollow a hashtag — also removes it from every group. */
export function unfollowTag(raw: string): void {
  const n = normalizeHashtag(raw);
  if (!n) return;
  const tg = getTopicGroups();
  if (!tg.follows.includes(n)) return;
  commit({
    ...tg,
    follows: tg.follows.filter((t) => t !== n),
    groups: tg.groups.map((g) => ({ ...g, tags: g.tags.filter((t) => t !== n) })),
  });
}

export function isFollowing(raw: string): boolean {
  const n = normalizeHashtag(raw);
  return !!n && getTopicGroups().follows.includes(n);
}

/** Create a group; returns its id ('' if at cap). */
export function createGroup(name: string): string {
  const tg = getTopicGroups();
  if (tg.groups.length >= MAX_GROUPS) return '';
  const id = crypto.randomUUID();
  commit({ ...tg, groups: [...tg.groups, { id, name: sanitizeName(name), tags: [] }] });
  return id;
}

export function renameGroup(id: string, name: string): void {
  const clean = sanitizeName(name);
  if (!clean) return;
  const tg = getTopicGroups();
  commit({ ...tg, groups: tg.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)) });
}

export function deleteGroup(id: string): void {
  const tg = getTopicGroups();
  commit({ ...tg, groups: tg.groups.filter((g) => g.id !== id) });
}

/** Add a hashtag to a group — implicitly follows it too. */
export function addTagToGroup(groupId: string, raw: string): void {
  const n = normalizeHashtag(raw);
  if (!n) return;
  const tg = getTopicGroups();
  const follows = tg.follows.includes(n)
    ? tg.follows
    : tg.follows.length < MAX_FOLLOWS
      ? [...tg.follows, n]
      : tg.follows;
  if (!follows.includes(n)) return; // couldn't follow (cap) → don't half-add
  commit({
    ...tg,
    follows,
    groups: tg.groups.map((g) =>
      g.id === groupId && !g.tags.includes(n) && g.tags.length < MAX_TAGS_PER_GROUP
        ? { ...g, tags: [...g.tags, n] }
        : g,
    ),
  });
}

/** Remove a hashtag from a group (stays followed / in other groups). */
export function removeTagFromGroup(groupId: string, raw: string): void {
  const n = normalizeHashtag(raw);
  if (!n) return;
  const tg = getTopicGroups();
  commit({
    ...tg,
    groups: tg.groups.map((g) =>
      g.id === groupId ? { ...g, tags: g.tags.filter((t) => t !== n) } : g,
    ),
  });
}

// --- Resolvers --------------------------------------------------------

/** All followed hashtags (the "Followed Topics" entry). */
export function allFollowedTags(): string[] {
  return getTopicGroups().follows;
}

/** The hashtags for a group id, or `[]` if unknown. */
export function tagsForGroup(id: string): string[] {
  return getTopicGroups().groups.find((g) => g.id === id)?.tags ?? [];
}

// --- Remote sync ----------------------------------------------------

/**
 * Apply a `topicGroups` object received from another device. LWW by
 * `updatedAt`, with a deterministic tie-break so every device converges on the
 * same winner; a remote apply never re-uploads.
 */
export function applyRemoteTopicGroups(raw: unknown): void {
  const remote = normalize(raw);
  const local = getTopicGroups();
  if (remote.updatedAt < local.updatedAt) return;
  if (remote.updatedAt === local.updatedAt) {
    if (JSON.stringify(remote) <= JSON.stringify(local)) return;
  }
  commit(remote, /* fromRemote */ true);
}

// --- Debounced upload (decoupled to avoid an import cycle) -----------

let uploadTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleUpload(): void {
  if (typeof window === 'undefined') return;
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(async () => {
    uploadTimer = null;
    try {
      const [{ vaultExportKey }, { uploadSettings }] = await Promise.all([
        import('./vault'),
        import('./settings-sync'),
      ]);
      const key = await vaultExportKey();
      if (key) await uploadSettings(key);
    } catch {
      /* best-effort; local copy already persisted */
    }
  }, 2500);
}
