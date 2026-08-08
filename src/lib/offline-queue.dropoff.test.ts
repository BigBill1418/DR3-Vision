// @vitest-environment jsdom
//
// ADR-0085 — a walk-up drop-off queued offline must drain with its photo,
// exactly once, or be visibly held.
//
// Run against `fake-indexeddb`, a full implementation of the IndexedDB spec
// rather than a stub of our calls, for the same reason ADR-0078's suite does:
// the v2 → v3 upgrade path, the object store and the index ordering all have to
// behave as they do on the iPad. A drop-off row carries the ONLY copy of its
// photo — the blob exists in that one device's IndexedDB and nowhere else — so
// an upgrade that dropped it, or a replay that removed the row before the server
// had the write, destroys evidence that cannot be recovered.
//
// The order of the two network calls is the load-bearing part and is asserted
// explicitly: a drop-off row cannot exist without its photo key
// (`consumer_dropoffs_floor_requires_photo`), so the R2 PUT must succeed BEFORE
// the submit is attempted. Reversed, every offline drop-off would submit a key
// the bucket never received.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const DB_NAME = 'dr3-vision-queue';

async function loadQueue() {
  vi.resetModules();
  return import('./offline-queue');
}

/** Write a v2-shaped upload row directly, bypassing the v3 module entirely. */
function seedV2Upload(row: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      const u = db.createObjectStore('pending_uploads', { keyPath: 'id' });
      u.createIndex('by-queued-at', 'queued_at');
      u.createIndex('by-load', 'load_id');
      u.createIndex('by-state', 'state');
      const a = db.createObjectStore('pending_actions', { keyPath: 'id' });
      a.createIndex('by-queued-at', 'queued_at');
      a.createIndex('by-state', 'state');
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('pending_uploads', 'readwrite');
      tx.objectStore('pending_uploads').put(row);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Write a v1-shaped upload row — no state index, no idempotency key, no subject. */
function seedV1Upload(row: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const u = db.createObjectStore('pending_uploads', { keyPath: 'id' });
      u.createIndex('by-queued-at', 'queued_at');
      u.createIndex('by-load', 'load_id');
      db.createObjectStore('pending_actions', { keyPath: 'id' }).createIndex(
        'by-queued-at',
        'queued_at',
      );
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('pending_uploads', 'readwrite');
      tx.objectStore('pending_uploads').put(row);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

type Call = { url: string; init: RequestInit | undefined };

/** A fetch double that records the call ORDER — which is the contract here. */
function recordingFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  return { fn, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DROPOFF = {
  site_code: 'eugene',
  dropoff_date: '2026-08-08',
  kind: 'floor_public' as const,
  units: 6,
};

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal('navigator', { onLine: true });
});

describe('ADR-0085 — offline drop-off replay', () => {
  it('mints, PUTs the blob, then submits — in that order — and removes the row', async () => {
    const q = await loadQueue();
    const { fn, calls } = recordingFetch((url) => {
      if (url.includes('/dropoff/upload-url')) {
        return json({ storage_key: 'dropoffs/site-eugene/k.jpg', upload_url: 'https://r2/put' });
      }
      if (url.startsWith('https://r2/')) return new Response(null, { status: 200 });
      return json({ id: 'row-1' }, 201);
    });
    vi.stubGlobal('fetch', fn);

    const blob = new Blob(['photo-bytes'], { type: 'image/jpeg' });
    await q.enqueueDropoff({
      ...DROPOFF,
      blob,
      content_type: 'image/jpeg',
      idempotency_key: 'key-abc',
    });

    const result = await q.replayAll();
    expect(result.uploads_replayed).toBe(1);
    expect(result.uploads_failed).toBe(0);

    // The ORDER. Not an incidental detail: a submit that ran before the PUT would
    // name a key the bucket never received.
    expect(calls.map((c) => c.url)).toEqual([
      '/api/operator/eugene/dropoff/upload-url',
      'https://r2/put',
      '/api/queue/replay',
    ]);

    // The PUT carried the stored payload and declared the captured type.
    //
    // Stated plainly rather than over-claimed: the Blob PAYLOAD itself is not
    // compared here, because a jsdom Blob does not survive fake-indexeddb's
    // structured clone as a usable Blob — the same environment limitation
    // `offline-queue.test.ts` records for the v1 upgrade. Asserting around it
    // would be measuring jsdom. What IS asserted is that a body was sent, that
    // it is the value the queue read back from the row rather than a fresh
    // placeholder, and that the content-type the mint was told about is the one
    // the PUT declares — a mismatch there is what parks an object R2 will later
    // serve with the wrong active type.
    expect(calls[1]?.init?.body, 'the R2 PUT carried no body').toBeDefined();
    expect(
      (calls[1]?.init?.headers as Record<string, string> | undefined)?.['Content-Type'],
    ).toBe('image/jpeg');

    // The submit carries the whole drop-off through the ALLOWLISTED scope, so it
    // is subject to the identical auth / rollout / day-pin gates a live submit
    // gets. There is no drop-off-shaped bypass of `/api/queue/replay`.
    const submit = JSON.parse(String(calls[2]?.init?.body)) as Record<string, unknown>;
    expect(submit['scope']).toBe('operator.dropoff.create');
    expect(submit['site_code']).toBe('eugene');
    expect(submit['idempotency_key']).toBe('key-abc');
    expect(submit['target_day']).toBe('2026-08-08');
    expect(submit['payload']).toMatchObject({
      dropoffDate: '2026-08-08',
      kind: 'floor_public',
      units: 6,
      photoStorageKey: 'dropoffs/site-eugene/k.jpg',
      photoContentType: 'image/jpeg',
    });

    // Drained exactly once: the row is gone, so a second sweep is a no-op. The
    // blob is only ever removed after the SERVER acknowledged the write.
    expect(await q.pendingCount()).toBe(0);
    const before = fn.mock.calls.length;
    await q.replayAll();
    expect(fn.mock.calls.length, 'a drained drop-off was replayed a second time').toBe(before);
  });

  it('EXACTLY ONCE — a failed submit keeps the blob and reuses the SAME key', async () => {
    // The case the idempotency key exists for: the write landed and the response
    // was lost. The row must survive with its photo intact, and the retry must
    // present the same key so the server replays its stored response instead of
    // writing a second drop-off.
    const q = await loadQueue();
    let submits = 0;
    const { fn, calls } = recordingFetch((url) => {
      if (url.includes('/dropoff/upload-url')) {
        // A FRESH key each mint — presigns expire in ten minutes and a queued
        // entry may be days old. This is exactly why the server excludes the
        // photo key from the idempotency request hash.
        return json({ storage_key: `dropoffs/site-eugene/mint-${submits}.jpg`, upload_url: 'https://r2/put' });
      }
      if (url.startsWith('https://r2/')) return new Response(null, { status: 200 });
      submits += 1;
      return submits === 1 ? json({ error: 'boom' }, 500) : json({ id: 'row-1' }, 201);
    });
    vi.stubGlobal('fetch', fn);

    const blob = new Blob(['photo-bytes'], { type: 'image/jpeg' });
    await q.enqueueDropoff({
      ...DROPOFF,
      blob,
      content_type: 'image/jpeg',
      idempotency_key: 'key-stable',
    });

    const first = await q.replayAll();
    expect(first.uploads_failed).toBe(1);
    // A 500 is retryable, NOT a conflict — nothing here needs a person.
    expect((await q.queueCounts()).conflicts).toBe(0);

    const { uploads } = await q.listPending();
    expect(uploads, 'the drop-off was dropped after a server error').toHaveLength(1);
    // The row's evidence and its data both survive. Blob identity is not compared
    // — see the note in the first test — so the stand-in is `byte_size`, which is
    // recorded from the blob at capture and would not survive a row that had been
    // re-created empty.
    expect(uploads[0]?.byte_size, 'the photo was lost on the failed submit').toBe(blob.size);
    expect(uploads[0]?.content_type).toBe('image/jpeg');
    expect(uploads[0]?.dropoff).toMatchObject({ units: 6, kind: 'floor_public' });

    // `retryRow` clears the cached presign and the backoff, which is what a
    // person pressing "try again" means.
    await q.retryRow(uploads[0]!.id, 'upload');
    const second = await q.replayAll();
    expect(second.uploads_replayed).toBe(1);

    const submitBodies = calls
      .filter((c) => c.url === '/api/queue/replay')
      .map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
    expect(submitBodies).toHaveLength(2);
    // THE assertion. A key minted per attempt would make the retry a second
    // drop-off; the same key makes it the same write.
    expect(
      submitBodies.map((b) => b['idempotency_key']),
      'the retry presented a different idempotency key — it is now a second drop-off',
    ).toEqual(['key-stable', 'key-stable']);
    // …while the photo key legitimately differed, which is the thing the server
    // must not treat as key reuse.
    const keys = submitBodies.map(
      (b) => (b['payload'] as Record<string, unknown>)['photoStorageKey'],
    );
    expect(keys[0]).not.toBe(keys[1]);
    expect(await q.pendingCount()).toBe(0);
  });

  it('a stale day is HELD as a conflict, never re-filed against today', async () => {
    const q = await loadQueue();
    const { fn } = recordingFetch((url) => {
      if (url.includes('/dropoff/upload-url')) {
        return json({ storage_key: 'dropoffs/site-eugene/k.jpg', upload_url: 'https://r2/put' });
      }
      if (url.startsWith('https://r2/')) return new Response(null, { status: 200 });
      return json({ error: 'date_not_today' }, 422);
    });
    vi.stubGlobal('fetch', fn);

    await q.enqueueDropoff({
      ...DROPOFF,
      dropoff_date: '2026-08-06',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
      idempotency_key: 'key-stale',
    });

    await q.replayAll();
    const counts = await q.queueCounts();
    expect(counts.conflicts, 'a stale drop-off did not surface for a person').toBe(1);

    const { uploads } = await q.listPending();
    expect(uploads[0]?.last_error).toBe(q.CONFLICT_DATE_NOT_TODAY);
    // Neither retargeted (which mis-files units against the wrong production day)
    // nor dropped (which loses the operator's work AND the only copy of the photo).
    expect(uploads[0]?.dropoff?.dropoff_date).toBe('2026-08-06');
    expect(uploads[0]?.byte_size, 'the held drop-off lost its photo').toBeGreaterThan(0);

    const before = fn.mock.calls.length;
    await q.replayAll();
    expect(fn.mock.calls.length, 'a conflict was retried automatically').toBe(before);
  });

  it('v2 → v3 — a legacy load photo still replays as a LOAD, not as a drop-off', async () => {
    // The upgrade adds `subject`. A v2 row has none, and `replayAll` dispatches on
    // it — so a row that missed the backfill must still take the load-photo path.
    // Getting this wrong would park every pre-upgrade photo (85 of them drained
    // on 2026-08-07 through exactly this machinery) as a payload-less drop-off
    // conflict.
    await seedV2Upload({
      id: 'legacy-1',
      load_id: 'load-9',
      kind: 'bol',
      blob: new Blob(['old'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
      byte_size: 3,
      storage_key: null,
      upload_url: null,
      idempotency_key: 'legacy-key',
      queued_at: Date.now(),
      attempts: 0,
      last_error: null,
      state: 'active',
    });

    const q = await loadQueue();
    const { fn, calls } = recordingFetch((url) => {
      if (url === '/api/photos/upload-url') {
        return json({ storage_key: 'loads/load-9/bol/x.jpg', upload_url: 'https://r2/put' });
      }
      if (url.startsWith('https://r2/')) return new Response(null, { status: 200 });
      return json({ id: 'photo-1' }, 200);
    });
    vi.stubGlobal('fetch', fn);

    const { uploads } = await q.listPending();
    expect(uploads[0]?.subject, 'the v2→v3 backfill did not stamp subject').toBe('load');
    expect(uploads[0]?.dropoff).toBeNull();
    expect(uploads[0]?.byte_size, 'the legacy photo row was rebuilt, not preserved').toBe(3);
    expect(uploads[0]?.idempotency_key).toBe('legacy-key');

    const r = await q.replayAll();
    expect(r.uploads_replayed).toBe(1);
    expect(calls.map((c) => c.url)).toEqual([
      '/api/photos/upload-url',
      'https://r2/put',
      '/api/photos/confirm',
    ]);
  });

  it('a drop-off does not halt behind an unrelated failed load photo', async () => {
    // `replayAll` halts a LOAD's remaining steps on any failure, because a load's
    // actions describe a sequence. A drop-off is independent and carries
    // `load_id: null`, so it must not be caught by that net — one stuck truck
    // would otherwise block every walk-up capture on the device.
    const q = await loadQueue();
    const { fn } = recordingFetch((url) => {
      if (url === '/api/photos/upload-url') return json({ error: 'nope' }, 500);
      if (url.includes('/dropoff/upload-url')) {
        return json({ storage_key: 'dropoffs/site-eugene/k.jpg', upload_url: null });
      }
      return json({ id: 'row-1' }, 201);
    });
    vi.stubGlobal('fetch', fn);

    await q.enqueueUpload({
      load_id: 'load-9',
      kind: 'bol',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
    });
    await q.enqueueDropoff({
      ...DROPOFF,
      blob: new Blob(['y'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
      idempotency_key: 'key-indep',
    });

    const r = await q.replayAll();
    expect(r.uploads_failed).toBe(1);
    expect(r.uploads_replayed, 'the drop-off was halted by an unrelated load failure').toBe(1);
  });

  it('v1 → v3 DIRECTLY — one walk per store, so neither backfill clobbers the other', async () => {
    // A device that has not opened the app since before ADR-0078 jumps v1 → v3 in
    // ONE upgrade, running both backfill blocks in the same transaction.
    //
    // This is a REGRESSION TEST for a bug this ADR introduced and this suite
    // caught: the v2→v3 block originally ran on `oldVersion < 3`, so a v1 database
    // got two concurrent cursor walks over `pending_uploads`. They interleave —
    // the second reads a row the first has already queued an update for and writes
    // its own copy over the top — which silently reverted ADR-0078 G2's
    // idempotency-key backfill for every legacy row. The upgrade then looked
    // successful while quietly re-arming the duplicate-confirm defect for exactly
    // the rows it was built to protect.
    await seedV1Upload({
      id: 'v1-row',
      load_id: 'load-1',
      kind: 'bol',
      blob: new Blob(['old'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
      byte_size: 3,
      storage_key: null,
      upload_url: null,
      queued_at: 1_700_000_000_000,
      attempts: 0,
      last_error: null,
    });

    const q = await loadQueue();
    const { uploads } = await q.listPending();
    expect(uploads).toHaveLength(1);
    // BOTH backfills survived the jump.
    expect(uploads[0]?.idempotency_key, 'the ADR-0078 G2 key backfill was clobbered').toBeTruthy();
    expect(uploads[0]?.subject, 'the ADR-0085 subject backfill did not run').toBe('load');
    expect(uploads[0]?.state).toBe('active');
    expect(uploads[0]?.byte_size, 'the legacy row was rebuilt, not preserved').toBe(3);
  });
});
