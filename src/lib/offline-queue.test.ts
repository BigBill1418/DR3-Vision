// @vitest-environment jsdom
//
// ADR-0078 — the offline queue, against a REAL IndexedDB implementation.
//
// `fake-indexeddb` is a full implementation of the IndexedDB spec, not a stub of
// our calls, so the version-upgrade path, the object stores and the index
// ordering all behave as they do on the iPad. That matters most for the v1 → v2
// upgrade: at the time of writing, one production device holds 99 real queued
// photos in a v1 database. An upgrade that dropped them would destroy evidence
// of loads that have already been through the dock, and the only way to know it
// does not is to run the actual upgrade over actual legacy-shaped rows.
//
// `idb` is a runtime dependency already; `fake-indexeddb` is added as a
// devDependency. Worth being explicit that this does not violate a standing
// rule: `offline-queue.ts` cites "CLAUDE.md per ADR-0012 §4 — no new deps for
// T-009", but ADR-0012 §4 is the decision to swap `next-pwa` for Serwist and
// says nothing about a dependency freeze. The citation is wrong; the constraint
// it names does not exist. (Reported with ADR-0078 rather than silently relied
// upon.)

// `/auto` installs the whole global surface (IDBRequest, IDBKeyRange, …), not
// just `indexedDB` — `idb` does `value instanceof IDBRequest` internally, so a
// lone factory is not enough. Each test then swaps in a fresh IDBFactory for
// isolation while those globals stay put.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const DB_NAME = 'dr3-vision-queue';

/**
 * Load the queue module against whatever database currently exists.
 *
 * Deliberately does NOT install a new IDBFactory: `beforeEach` already did that
 * for isolation, and doing it again here would discard any v1 database a test
 * had just seeded — which would leave the upgrade tests passing against an empty
 * database while claiming to prove that 99 rows survive.
 *
 * `vi.resetModules()` is what matters: `offline-queue` memoises its `openDB`
 * promise at module scope, so without a fresh registry the second test would
 * reuse the first test's connection.
 */
async function loadQueue() {
  vi.resetModules();
  return import('./offline-queue');
}

/** Write a v1-shaped database directly, bypassing the v2 module entirely. */
function seedV1(rows: {
  uploads?: Array<Record<string, unknown>>;
  actions?: Array<Record<string, unknown>>;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const u = db.createObjectStore('pending_uploads', { keyPath: 'id' });
      u.createIndex('by-queued-at', 'queued_at');
      u.createIndex('by-load', 'load_id');
      const a = db.createObjectStore('pending_actions', { keyPath: 'id' });
      a.createIndex('by-queued-at', 'queued_at');
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['pending_uploads', 'pending_actions'], 'readwrite');
      for (const r of rows.uploads ?? []) tx.objectStore('pending_uploads').put(r);
      for (const r of rows.actions ?? []) tx.objectStore('pending_actions').put(r);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ADR-0078 — v1 → v2 upgrade preserves queued work', () => {
  // The production case, exactly: 99 photo rows queued by the v1 app, several
  // already parked with a `conflict:` flag from failed re-mints. NONE of them may
  // be lost, and none may be silently mutated into something the replay path
  // would treat differently.
  it('keeps every v1 UPLOAD row, blob and flags intact', async () => {
    const uploads = Array.from({ length: 99 }, (_, i) => ({
      id: `00000000000${i}-legacy`,
      load_id: `load-${i % 7}`,
      kind: 'bol',
      blob: new Blob([`photo-${i}`]),
      content_type: 'image/jpeg',
      byte_size: 10 + i,
      storage_key: null,
      upload_url: null,
      queued_at: 1_700_000_000_000 + i,
      attempts: i % 3,
      // A third of them are already parked, as on the real device.
      last_error: i % 3 === 0 ? 'conflict:mint 403' : null,
    }));
    await seedV1({ uploads });

    const q = await loadQueue();
    const { uploads: after } = await q.listPending();

    expect(after).toHaveLength(99);
    // Row identity and metadata carry through the upgrade untouched. The upgrade
    // never re-creates the uploads store, so the stored value objects are the
    // same records — which is the property that matters for not losing evidence.
    //
    // Stated plainly rather than over-claimed: the Blob PAYLOAD is not asserted
    // here, because a jsdom Blob does not survive fake-indexeddb's structured
    // clone as a usable Blob. That is a limitation of this test environment, not
    // of the upgrade, and asserting around it would be measuring jsdom. The
    // guard that the upgrade does not touch this store is the row count and the
    // preserved per-row fields below.
    // G2 — every legacy row leaves the upgrade WITH a key.
    //
    // Without this the D3 fix has a hole shaped exactly like the bug: the
    // upgrade backfilled actions only, `enqueueUpload` mints for new captures
    // only, so the ~99 rows the fix was built for would have replayed with no
    // key at all and `withIdempotency` would have short-circuited on every one.
    //
    // FALSIFIED BY HAND: removing the uploads cursor from the `oldVersion < 2`
    // block leaves all 99 keys null and this red on the first assertion.
    const keys = after.map((r) => r.idempotency_key);
    const unkeyed = keys.filter((k) => !k).length;
    expect(unkeyed, `${unkeyed} legacy uploads would replay with NO idempotency key`).toBe(0);
    expect(new Set(keys).size, 'keys must be distinct per row').toBe(99);
    // The indexed state summary is derived from each row's OWN last_error, so a
    // legacy row already parked stays parked rather than silently re-entering
    // the retry loop.
    expect(after.filter((r) => r.state === 'conflict')).toHaveLength(33);
    expect(after[0]!.id).toBe('000000000000-legacy');
    expect(after[0]!.byte_size).toBe(10);
    expect(after[0]!.load_id).toBe('load-0');
    // Existing conflict flags are preserved, not cleared and not invented.
    expect(after.filter((r) => q.isConflict(r))).toHaveLength(33);
  });

  // A v1 ACTION row cannot be dispatched (no scope, no key, no day) and we
  // cannot honestly guess what day it was for. It is FLAGGED, not deleted.
  it('flags v1 ACTION rows as conflicts rather than dropping them', async () => {
    await seedV1({
      actions: [
        {
          id: '00000000001-legacy',
          action_name: 'bolCapturedAction',
          args_json: '{"loadId":"L1"}',
          queued_at: 1_700_000_000_000,
          attempts: 0,
          last_error: null,
        },
      ],
    });

    const q = await loadQueue();
    const { actions } = await q.listPending();
    expect(actions).toHaveLength(1);
    expect(actions[0]!.last_error).toBe('conflict:legacy_v1_entry');
    expect(q.isConflict(actions[0]!)).toBe(true);
  });
});

describe('ADR-0078 D5 — a mid-submit disconnect queues, it does not lose', () => {
  // ── FALSIFICATION 6: disconnect.queues-not-loses ────────────────────────
  //
  // FALSIFIED BY HAND: restoring the bare `catch { setError(...) }` in
  // `count-client.tsx` — i.e. not calling `enqueueAction` at all — leaves this
  // at 0 rows, which is the defect: the operator's count existed only as an
  // error message telling them to type it again from memory.
  it('an enqueued count survives with its day, key and scope', async () => {
    const q = await loadQueue();
    const key = q.newIdempotencyKey();

    await q.enqueueAction({
      scope: 'operator.count.create',
      site_code: 'eugene',
      target_day: '2026-08-07',
      idempotency_key: key,
      payload: { countDate: '2026-08-07', unitsTotal: 412 },
      endpoint: '/api/operator/eugene/count',
    });

    const { actions } = await q.listPending();
    expect(actions).toHaveLength(1);
    expect(actions[0]!.target_day).toBe('2026-08-07');
    expect(actions[0]!.idempotency_key).toBe(key);
    expect(actions[0]!.scope).toBe('operator.count.create');
    expect(JSON.parse(actions[0]!.args_json)).toEqual({
      countDate: '2026-08-07',
      unitsTotal: 412,
    });
  });

  it('classifies a fetch TypeError as offline, which is what triggers queueing', async () => {
    const q = await loadQueue();
    expect(q.isOfflineError(new TypeError('Failed to fetch'))).toBe(true);
    // A refusal the server actually issued is NOT offline — queueing it would
    // retry forever against a decision that will not change.
    expect(q.isOfflineError(new Error('409 conflict'))).toBe(false);
  });
});

describe('ADR-0078 — replay refuses a stale day and holds it for a person', () => {
  // ── FALSIFICATION 4 (client half): replay.wrong-day-refused ─────────────
  //
  // The server half lives in the replay route's own suite. Here: a 422
  // `date_not_today` must park the row as a CONFLICT — still present, not
  // retried, not rewritten to today.
  //
  // FALSIFIED BY HAND: mapping 422 to a plain retryable error instead of
  // `CONFLICT_DATE_NOT_TODAY` makes `isConflict` false and the row is swept
  // again on the next tick forever.
  it('a 422 date_not_today parks the entry, writes nothing, drops nothing', async () => {
    const q = await loadQueue();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ error: 'date_not_today' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await q.enqueueAction({
      scope: 'operator.count.create',
      site_code: 'eugene',
      target_day: '2026-08-06', // yesterday
      idempotency_key: q.newIdempotencyKey(),
      payload: { countDate: '2026-08-06', unitsTotal: 412 },
      endpoint: '/api/operator/eugene/count',
    });

    const result = await q.replayAll();

    expect(calls).toEqual(['/api/queue/replay']);
    expect(result.actions_replayed).toBe(0);
    expect(result.conflicts).toBe(1);

    const { actions } = await q.listPending();
    expect(actions, 'the entry must NOT be dropped').toHaveLength(1);
    expect(actions[0]!.last_error).toBe('conflict:date_not_today');
    // And the payload still names the ORIGINAL day — never retargeted.
    expect(JSON.parse(actions[0]!.args_json).countDate).toBe('2026-08-06');
  });

  it('a parked entry is not retried on the next sweep', async () => {
    const q = await loadQueue();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'date_not_today' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await q.enqueueAction({
      scope: 'operator.count.create',
      site_code: 'eugene',
      target_day: '2026-08-06',
      idempotency_key: q.newIdempotencyKey(),
      payload: { countDate: '2026-08-06' },
      endpoint: '/x',
    });

    await q.replayAll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await q.replayAll();
    expect(fetchMock, 'a conflict must not be re-attempted automatically').toHaveBeenCalledTimes(1);

    // …until a person asks for it. This is the affordance that did not exist,
    // and whose absence left one device at 99-and-not-draining.
    const { actions } = await q.listPending();
    await q.retryRow(actions[0]!.id, 'action');
    await q.replayAll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('ADR-0078 — the badge must not count parked rows as "waiting"', () => {
  // The trust defect from the live incident: a badge that folds permanently
  // parked rows into "waiting to send" sits at 99 across shifts and teaches
  // operators that the number means nothing.
  it('activeCount excludes conflicts; pendingCount includes them', async () => {
    const q = await loadQueue();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'date_not_today' }), {
            status: 422,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    for (const day of ['2026-08-06', '2026-08-05']) {
      await q.enqueueAction({
        scope: 'operator.count.create',
        site_code: 'eugene',
        target_day: day,
        idempotency_key: q.newIdempotencyKey(),
        payload: { countDate: day },
        endpoint: '/x',
      });
    }
    await q.replayAll();

    expect(await q.pendingCount()).toBe(2);
    expect(await q.conflictCount()).toBe(2);
    expect(await q.activeCount(), 'nothing is still trying').toBe(0);
  });
});

describe('ADR-0078 G7 — an auth redirect is not a success', () => {
  // THE PRIMARY BLOCKER of the 99-photo drain, and it never looked like a bug.
  //
  // Operator sessions idle out after 5 minutes. `/api/photos/*` is not a public
  // path, so a session-less queue request was answered 307 → /login; `fetch`
  // follows redirects by default, /login returns 200 text/html, and `mint.ok`
  // was TRUE. Parsing that page as JSON threw a SyntaxError, which was recorded
  // as a generic unlabelled error — retryable, invisible, forever. The R2 PUT
  // was never reached and nothing anywhere said "your session ended".
  //
  // This test reproduces the OLD server behaviour deliberately (200 text/html),
  // because a stale bundle or a cached service worker can still produce it even
  // after the middleware fix. Both halves have to hold independently.
  //
  // FALSIFIED BY HAND: removing the `isAuthResponse(mint)` check — i.e. going
  // back to the bare `if (!mint.ok)` — makes the mint "succeed", so the row is
  // no longer marked `auth:` and the assertion below goes red naming the HTML
  // body that was accepted as a mint response. That green-wrong state is
  // precisely today's production bug.
  it('a 200 text/html login page is treated as AUTH-EXPIRED, not a mint', async () => {
    const q = await loadQueue();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        // What /login actually returns after fetch follows the 307.
        return new Response('<!doctype html><html><body>Sign in</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }),
    );

    const row = await q.enqueueUpload({
      load_id: 'L1',
      kind: 'bol',
      blob: new Blob(['x']),
      content_type: 'image/jpeg',
    });

    const result = await q.replayAll();

    const after = (await q.listPending()).uploads;
    expect(after, 'an auth failure must NOT delete the operator’s photo').toHaveLength(1);
    expect(after[0]!.id).toBe(row.id);
    expect(
      after[0]!.last_error,
      'a 200 text/html login page was accepted as a successful mint',
    ).toBe('auth:session_expired');
    expect(after[0]!.state).toBe('auth');

    // The confirm must never be reached — the whole point is that the sequence
    // stops at the sign-in demand rather than proceeding on a fiction.
    expect(calls).toEqual(['/api/photos/upload-url']);
    expect(result.auth).toBe(1);
    // And it is NOT a conflict: nothing needs adjudicating, somebody needs a PIN.
    expect(result.conflicts).toBe(0);
    expect(await q.conflictCount()).toBe(0);
  });

  it('an explicit 401 is classified the same way', async () => {
    const q = await loadQueue();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'unauthenticated' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await q.enqueueAction({
      scope: 'operator.count.create',
      site_code: 'eugene',
      target_day: '2026-08-07',
      idempotency_key: q.newIdempotencyKey(),
      payload: { countDate: '2026-08-07' },
      endpoint: '/x',
    });
    const r = await q.replayAll();
    expect(r.auth).toBe(1);
    expect(r.conflicts).toBe(0);
    const { actions } = await q.listPending();
    expect(actions[0]!.last_error).toBe('auth:session_expired');
  });

  it('every queue fetch uses redirect: manual', async () => {
    // Structural: following a redirect is what turned an auth failure into a
    // 200. Asserted on the request INIT rather than on behaviour, because the
    // behaviour only differs against a server that redirects.
    const q = await loadQueue();
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        inits.push(init);
        return new Response(JSON.stringify({ error: 'nope' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    await q.enqueueAction({
      scope: 'operator.count.create',
      site_code: 'eugene',
      target_day: '2026-08-07',
      idempotency_key: q.newIdempotencyKey(),
      payload: { countDate: '2026-08-07' },
      endpoint: '/x',
    });
    await q.replayAll();
    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) expect(init.redirect).toBe('manual');
  });
});

describe('ADR-0078 — a sweep reports whether it actually REACHED the server', () => {
  // The connection badge is driven by this field, so getting it wrong repaints a
  // red offline state green — reversing the guarantee that is half the point of
  // this ADR. The three values are three genuinely different facts and the
  // difference is not cosmetic:
  //
  //   false — attempted, nothing got through (offline, or a dead uplink)
  //   true  — at least one request got an HTTP response
  //   null  — nothing attempted, so this sweep is NO EVIDENCE either way
  //
  // FALSIFIED BY HAND: hardcoding `result.reached = true` makes the first two
  // cases red naming the wrong value — which is precisely the state in which a
  // device with no network shows "Connected" and a fresh "last sent" time.
  const enqueueOne = async (q: Awaited<ReturnType<typeof loadQueue>>) => {
    await q.enqueueAction({
      scope: 'operator.count.create',
      site_code: 'eugene',
      target_day: '2026-08-07',
      idempotency_key: q.newIdempotencyKey(),
      payload: { countDate: '2026-08-07' },
      endpoint: '/x',
    });
  };

  it('reports FALSE when the device says it is offline', async () => {
    const q = await loadQueue();
    await enqueueOne(q);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { onLine: false });

    const r = await q.replayAll();
    expect(r.reached).toBe(false);
    expect(fetchMock, 'an offline sweep must not even try').not.toHaveBeenCalled();
  });

  // The AP-with-a-dead-uplink case: the OS insists it is online and every
  // request dies at the network layer.
  it('reports FALSE when every request dies at the network layer', async () => {
    const q = await loadQueue();
    await enqueueOne(q);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const r = await q.replayAll();
    expect(r.reached, 'a dead uplink reported as a healthy sync').toBe(false);
  });

  it('reports TRUE when the server answered, even to refuse', async () => {
    const q = await loadQueue();
    await enqueueOne(q);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'nope' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const r = await q.replayAll();
    // A 409 IS the server talking to us. Reachability and success are different
    // questions, and conflating them would paint the badge red on an ordinary
    // refusal.
    expect(r.reached).toBe(true);
  });

  it('reports NULL when there was nothing to attempt', async () => {
    const q = await loadQueue();
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn());

    const r = await q.replayAll();
    // An empty queue proves nothing about the network. Claiming `true` here is
    // how a badge goes green on a device that has not spoken to the server in
    // an hour.
    expect(r.reached).toBeNull();
  });
});

describe('ADR-0078 G3 — a human retry forces a fresh presign', () => {
  // A presign is valid for ~10 minutes. `retryRow` resets `queued_at` so backoff
  // does not immediately re-park the row — but `replayUpload` derives staleness
  // from `queued_at` too, so resetting it alone makes a URL minted WEEKS ago look
  // fresh. Every retry would then PUT at an expired URL and 403, and the opening
  // minutes of a 99-photo drain would read as total failure.
  //
  // FALSIFIED BY HAND: dropping `storage_key: null, upload_url: null` from
  // `retryRow` makes the first fetch the stale R2 PUT instead of the mint.
  it('clears the cached storage key and URL so replay re-mints', async () => {
    const q = await loadQueue();
    const row = await q.enqueueUpload({
      load_id: 'L1',
      kind: 'bol',
      blob: new Blob(['x']),
      content_type: 'image/jpeg',
      storage_key: 'loads/L1/bol/STALE.jpg',
      upload_url: 'https://r2.example/presigned-WEEKS-AGO',
    });
    await q.markUploadAttempt(row.id, 'conflict:mint 403');

    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ storage_key: 'k', upload_url: null }), {
          status: 200,
        });
      }),
    );

    await q.retryRow(row.id, 'upload');
    const after = (await q.listPending()).uploads[0]!;
    expect(after.storage_key).toBeNull();
    expect(after.upload_url).toBeNull();

    await q.replayAll();
    expect(urls[0], 'the first call must be a fresh mint, not a stale PUT').toBe(
      '/api/photos/upload-url',
    );
  });
});

describe('ADR-0078 G4 — the badge never reads a photo Blob', () => {
  // The chrome refreshes counters every few seconds on every screen. Counting by
  // scanning records deserialises every queued photo, so on the device holding
  // 99 unsent photos that was hundreds of multi-megabyte reads per minute — on
  // the single tab holding data that exists nowhere else — to render a number.
  //
  // FALSIFIED BY HAND: reverting `queueCounts` to three `listPending()`-based
  // helpers makes `getAllFromIndex` fire and this go red naming the call count.
  it('queueCounts answers from the index without materialising records', async () => {
    const q = await loadQueue();
    for (let i = 0; i < 20; i += 1) {
      await q.enqueueUpload({
        load_id: `L${i}`,
        kind: 'bol',
        blob: new Blob([new Uint8Array(1024)]),
        content_type: 'image/jpeg',
      });
    }
    const parked = (await q.listPending()).uploads[0]!;
    await q.markUploadAttempt(parked.id, 'conflict:mint 403');

    // Spy AFTER seeding, so only the counting pass is measured.
    const proto = IDBObjectStore.prototype as unknown as Record<string, unknown>;
    const getAll = vi.spyOn(proto as never, 'getAll' as never);
    const getAllFromIdx = vi.spyOn(IDBIndex.prototype as never, 'getAll' as never);

    const counts = await q.queueCounts();

    expect(counts.pending).toBe(20);
    expect(counts.conflicts).toBe(1);
    expect(counts.active).toBe(19);
    expect(getAll, 'counting must not read record VALUES').not.toHaveBeenCalled();
    expect(getAllFromIdx, 'counting must not read record VALUES').not.toHaveBeenCalled();
    getAll.mockRestore();
    getAllFromIdx.mockRestore();
  });
});

describe('ADR-0078 — replay ordering and per-load halting', () => {
  it('replays in queued-at order and stops a load after its first conflict', async () => {
    const q = await loadQueue();
    const seen: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { payload: { stackIndex: number } };
        seen.push(body.payload.stackIndex);
        // Stack 2 is refused hard; stacks 1 and 3 would succeed.
        const json = { 'content-type': 'application/json' };
        if (body.payload.stackIndex === 2) {
          return new Response(JSON.stringify({ error: 'nope' }), { status: 409, headers: json });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 201, headers: json });
      }),
    );

    for (const stackIndex of [1, 2, 3]) {
      await q.enqueueAction({
        scope: 'operator.load.add_stack',
        site_code: 'eugene',
        target_day: null,
        idempotency_key: q.newIdempotencyKey(),
        payload: { loadId: 'L1', stackIndex },
        endpoint: '/x',
        load_id: 'L1',
      });
      // Distinct queued_at so the by-queued-at index has a strict order.
      await new Promise((r) => setTimeout(r, 2));
    }

    await q.replayAll();

    // Stack 3 must NOT have been attempted: applying a later step of a load
    // whose earlier step was refused drives the server through a state the
    // operator never produced.
    expect(seen).toEqual([1, 2]);
    const { actions } = await q.listPending();
    expect(actions.map((a) => JSON.parse(a.args_json).stackIndex).sort()).toEqual([2, 3]);
  });
});
