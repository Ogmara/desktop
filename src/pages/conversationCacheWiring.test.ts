/**
 * Regression test for the channel/DM cache "merge + persist effect"
 * WIRING PATTERN used in `ChatView.tsx` and `DmConversationView.tsx` —
 * not `lib/messageCache.ts` itself (already covered by
 * `lib/messageCache.test.ts`), but the Solid `createResource` +
 * `createEffect` glue around it.
 *
 * Why this exists: the cross-conversation content leak this file guards
 * against was found, "fixed", and found AGAIN — twice, across two
 * separate re-audit rounds — because the same wiring pattern is
 * duplicated in both view files, and the fix landed correctly in one
 * spot (the merge effect) while missing another (the persist effect) the
 * first time, then missed a THIRD spot (`createResource`'s source being
 * conditionally `undefined`, which short-circuits Solid entirely and
 * bypasses the `messages.loading` guard both effects depend on) the
 * second time. Nothing in `messageCache.test.ts` — which only exercises
 * pure functions — could ever have caught any of that; it's a property
 * of how `createResource`/`createEffect` actually schedule at runtime.
 * This file exercises that real scheduling directly.
 *
 * Run: node --conditions=browser --test \
 *      src/pages/conversationCacheWiring.test.ts
 * (the repo's `npm test` now passes `--conditions=browser` for every test
 * file; the default Node resolution for `solid-js` picks its non-reactive
 * SSR/server build, under which `createEffect` callbacks never fire. This
 * is deliberately just `browser`, not also `development` — solid-js's
 * `browser` condition alone already resolves to its real, production
 * reactive build, so this exercises the exact code that ships; diffed
 * against the `development` build during the round-4 re-audit and
 * confirmed `createResource`'s scheduling is byte-identical between the
 * two, so this isn't a coverage tradeoff.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoot, createSignal, createResource, createEffect } from 'solid-js';

/**
 * Mirrors the exact wiring shape from `ChatView.tsx`/`DmConversationView.tsx`
 * (post round-3 fix): an always-truthy resource source, a merge effect
 * guarded on `messages.loading`, and a persist effect guarded the same way
 * with schedule-time capture (not fire-time re-reads).
 */
function makeConversationCacheSync(fetchImpl: (convId: string) => Promise<string[]>) {
  const [convId, setConvId] = createSignal<string | null>(null);
  const writes: { convId: string; snapshot: string[] }[] = [];
  const fetchCalls: string[] = [];

  const [messages] = createResource(
    () => ({ convId: convId() }), // ALWAYS-TRUTHY source — the round-3 fix
    async ({ convId: id }) => {
      if (!id) return [];
      fetchCalls.push(id);
      try {
        // Matches the REAL fetchers in ChatView.tsx/DmConversationView.tsx:
        // network failures are always caught internally and degrade to
        // `[]` — the fetcher itself never rejects. A test that let it
        // reject would be exercising a scenario production code doesn't
        // actually have.
        return await fetchImpl(id);
      } catch {
        return [];
      }
    },
  );

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: { convId: string; snapshot: string[] } | null = null;
  const writePending = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    writes.push(p);
  };
  const flush = () => {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    writePending();
  };

  createEffect(() => {
    const id = convId();
    const snapshot = messages() ?? [];
    const loading = messages.loading;
    if (persistTimer) clearTimeout(persistTimer);
    if (pending && pending.convId !== id) writePending();
    if (!id) { pending = null; return; }
    if (loading) return; // THE guard under test
    pending = { convId: id, snapshot };
    persistTimer = setTimeout(writePending, 30);
  });

  return { setConvId, messages, writes, fetchCalls, flush };
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test('conversation cache wiring: rapid A -> B(slow) -> C switch never writes one conversation\'s content under another\'s key', async () => {
  await createRoot(async (dispose) => {
    const { setConvId, writes } = makeConversationCacheSync(async (id) => {
      if (id === 'B') await wait(60); // the slow one
      return [`${id}-msg1`, `${id}-msg2`];
    });

    setConvId('A');
    await wait(20);
    setConvId('B');
    await wait(10); // still well inside B's fetch
    setConvId('C');
    await wait(150);

    for (const w of writes) {
      for (const row of w.snapshot) {
        assert.ok(row.startsWith(`${w.convId}-`), `write for ${w.convId} contained a row from a different conversation: ${row}`);
      }
    }
    dispose();
  });
});

test('conversation cache wiring: a fetch that throws does not leave `loading` stuck true (which would silently kill persistence for that conversation forever)', async () => {
  await createRoot(async (dispose) => {
    let shouldThrow = true;
    const { setConvId, messages, writes } = makeConversationCacheSync(async (id) => {
      if (id === 'B' && shouldThrow) throw new Error('simulated fetch failure');
      return [`${id}-msg1`];
    });

    setConvId('A');
    await wait(20);
    setConvId('B');
    await wait(20);
    assert.equal(messages.loading, false, 'loading must settle back to false after a thrown fetch, not stay stuck true');

    shouldThrow = false;
    setConvId('C');
    await wait(60);
    const cWrite = writes.find((w) => w.convId === 'C');
    assert.ok(cWrite, 'a conversation opened AFTER a prior fetch failure must still persist normally');
    dispose();
  });
});

test('conversation cache wiring: switching away and back to the SAME conversation before the abandoned fetch resolves never lets the stale promise write', async () => {
  await createRoot(async (dispose) => {
    let resolveA: ((v: string[]) => void) | null = null;
    let callCount = 0;
    const { setConvId, writes } = makeConversationCacheSync(async (id) => {
      if (id === 'A') {
        callCount++;
        if (callCount === 1) {
          // First call to A never resolves on its own — captured and
          // resolved LATE, after we've already switched away and back.
          return new Promise((resolve) => { resolveA = resolve; });
        }
        return [`A-fresh-${callCount}`];
      }
      return [`${id}-msg1`];
    });

    setConvId('A');
    await wait(10);
    setConvId('B');
    await wait(10);
    setConvId('A'); // back to A — this is a SECOND, fresh fetch
    await wait(60);

    // Now let the abandoned FIRST call resolve, late.
    if (resolveA) resolveA(['A-stale-from-abandoned-call']);
    await wait(60);

    const finalAWrite = [...writes].reverse().find((w) => w.convId === 'A');
    assert.ok(finalAWrite, 'expected at least one write for A');
    assert.equal(finalAWrite!.snapshot.includes('A-stale-from-abandoned-call'), false,
      'the late-resolving ABANDONED fetch must never contribute to what gets persisted');
    dispose();
  });
});

test('conversation cache wiring negative control: without the `messages.loading` guard, the round-2/round-3 contamination reproduces — proves this test actually detects the bug', async () => {
  await createRoot(async (dispose) => {
    const [convId, setConvId] = createSignal<string | null>(null);
    const writes: { convId: string; snapshot: string[] }[] = [];
    const [messages] = createResource(
      () => ({ convId: convId() }),
      async ({ convId: id }) => {
        if (!id) return [];
        if (id === 'B') await wait(60);
        return [`${id}-msg1`];
      },
    );
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let pending: { convId: string; snapshot: string[] } | null = null;
    createEffect(() => {
      const id = convId();
      const snapshot = messages() ?? [];
      // Deliberately NO `if (messages.loading) return;` — this is the bug.
      if (persistTimer) clearTimeout(persistTimer);
      if (pending && pending.convId !== id) { writes.push(pending); pending = null; }
      if (!id) { pending = null; return; }
      pending = { convId: id, snapshot };
      persistTimer = setTimeout(() => { if (pending) { writes.push(pending); pending = null; } }, 30);
    });

    setConvId('A');
    await wait(20);
    setConvId('B');
    await wait(10);
    setConvId('C');
    await wait(150);

    const contaminated = writes.some((w) => w.snapshot.some((row) => !row.startsWith(`${w.convId}-`)));
    assert.ok(contaminated, 'negative control: removing the loading guard should reproduce cross-conversation contamination — if this fails, the test harness itself is not sensitive to the bug');
    dispose();
  });
});
