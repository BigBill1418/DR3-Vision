// @vitest-environment jsdom
//
// ADR-0086 — the grant on the QUEUE side, against a real IndexedDB.
//
// `fake-indexeddb` is a full implementation of the spec, not a stub of our
// calls, so the upgrade path, the stores and the index ordering behave as they
// do on the iPad. That is what makes the upgrade tests below worth anything:
// the device holding these rows is the only place the photos exist.
//
// The additive `upload_grant` field deliberately did NOT bump `DB_VERSION`.
// There is nothing to backfill it WITH — a grant can only be minted server-side
// against a live session — so a v4 bump would walk every row in a blob-carrying
// store to stamp `null`, for zero benefit, while re-opening the interleaving
// hazard that silently reverted the ADR-0078 G2 backfill. The last two tests in
// this file are the guard on that reasoning.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const DB_NAME = 'dr3-vision-queue';

async function loadQueue() {
  vi.resetModules();
  return import('./offline-queue');
}

/** Write a v1-shaped row directly, bypassing the current module entirely. */
function seedV1Upload(row: Record<string, unknown>): Promise<void> {
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

type Call = { url: string; headers: Record<string, string>; body: unknown };

/** A fetch double that records the HEADERS actually issued — the contract here. */
function recordingFetch(handler: (url: string, body: unknown) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : (init?.body ?? null);
    calls.push({ url, headers, body });
    return handler(url, body);
  });
  return { fn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const GRANT = 'eyJ2IjoxfQ.SIGNATURE';
const REISSUED = 'eyJ2IjoxLCJyIjoxfQ.RESIGNED';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── The grant reaches the wire ───────────────────────────────────────────────

describe('ADR-0086 — the grant rides the row and is sent on BOTH calls', () => {
  // §2's mint-and-confirm-move-together constraint, enforced on the CLIENT side
  // too: sending the grant on the mint and forgetting it on the confirm would
  // PUT bytes to R2 and then be refused the row — an orphaned object, no record,
  // and a queue row that still cannot drain.
  //
  // Asserted against the headers the fetch double actually RECEIVED, not against
  // a call-graph stub, because "did we send the credential" is a wire-level
  // claim and nothing else can answer it.
  //
  // FALSIFIED BY HAND: removing `...grantHeaders` from either fetch in
  // `replayUpload` makes the corresponding assertion red naming that call.
  it('sends X-Upload-Grant on the mint and on the confirm', async () => {
    const q = await loadQueue();
    const { fn, calls } = recordingFetch((url) => {
      if (url === '/api/photos/upload-url') {
        return json({ storage_key: 'loads/load-1/bol/x.jpg', upload_url: 'https://r2/put' });
      }
      if (url.startsWith('https://r2/')) return new Response(null, { status: 200 });
      return json({ id: 'photo-1' });
    });
    vi.stubGlobal('fetch', fn);

    await q.enqueueUpload({
      load_id: 'load-1',
      kind: 'bol',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
      idempotency_key: 'aaaaaaaaaaaaa-00000000000000000001',
      upload_grant: GRANT,
    });

    const r = await q.replayAll();
    expect(r.uploads_replayed).toBe(1);

    const mint = calls.find((c) => c.url === '/api/photos/upload-url')!;
    const confirm = calls.find((c) => c.url === '/api/photos/confirm')!;
    expect(mint.headers['x-upload-grant'], 'the MINT went out with no grant').toBe(GRANT);
    expect(confirm.headers['x-upload-grant'], 'the CONFIRM went out with no grant').toBe(GRANT);

    // The key the grant is bound to must ride BOTH: the mint binds it into the
    // re-issue, the confirm redeems under it.
    expect((mint.body as { idempotency_key: string }).idempotency_key).toBe(
      'aaaaaaaaaaaaa-00000000000000000001',
    );
    expect(confirm.headers['idempotency-key']).toBe('aaaaaaaaaaaaa-00000000000000000001');

    // The grant is a credential: header only, never in a body or a URL, where it
    // would land in access logs, `Referer` and browser history.
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(GRANT);
    expect(calls.map((c) => c.url).join(' ')).not.toContain(GRANT);
  });

  // D2 — the mint re-issues, and the row must PERSIST what came back or the
  // credential's binding goes stale across a multi-day queue life.
  //
  // FALSIFIED BY HAND: dropping the `if (minted.upload_grant)` block makes the
  // confirm go out under the ORIGINAL grant and this red on the last assertion.
  it('persists the RE-ISSUED grant and uses it for the confirm', async () => {
    const q = await loadQueue();
    const { fn, calls } = recordingFetch((url) => {
      if (url === '/api/photos/upload-url') {
        return json({
          storage_key: 'loads/load-1/bol/x.jpg',
          upload_url: null,
          upload_grant: REISSUED,
        });
      }
      return json({ error: 'nope' }, 500); // stop before removal so the row survives
    });
    vi.stubGlobal('fetch', fn);

    await q.enqueueUpload({
      load_id: 'load-1',
      kind: 'bol',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
      upload_grant: GRANT,
    });
    await q.replayAll();

    const { uploads } = await q.listPending();
    expect(uploads[0]?.upload_grant, 'the re-issued grant was not persisted').toBe(REISSUED);
    expect(calls.find((c) => c.url === '/api/photos/confirm')!.headers['x-upload-grant']).toBe(
      REISSUED,
    );
  });

  // A server that issues no grant — no secret provisioned — must not ERASE the
  // one the row already holds. That would be a silent downgrade to the session
  // path on the first sweep after a secret went missing.
  it('a mint that returns no grant does not clear the row’s existing one', async () => {
    const q = await loadQueue();
    const { fn } = recordingFetch((url) => {
      if (url === '/api/photos/upload-url') {
        return json({ storage_key: 'loads/load-1/bol/x.jpg', upload_url: null });
      }
      return json({ error: 'nope' }, 500);
    });
    vi.stubGlobal('fetch', fn);

    await q.enqueueUpload({
      load_id: 'load-1',
      kind: 'bol',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
      upload_grant: GRANT,
    });
    await q.replayAll();

    const { uploads } = await q.listPending();
    expect(uploads[0]?.upload_grant, 'a grantless mint response wiped the credential').toBe(GRANT);
  });
});

// ── Rows that have no grant behave exactly as before ─────────────────────────

describe('ADR-0086 — a grantless row replays EXACTLY as it does today', () => {
  // Every photo queued before this shipped, plus every capture made while no
  // secret was provisioned. These genuinely have no grant, and the correct
  // outcome is the pre-ADR-0086 one: drain down the session path, unchanged.
  //
  // FALSIFIED BY HAND: sending `'X-Upload-Grant': String(row.upload_grant)`
  // unconditionally makes this red with the literal string "null" on the wire —
  // which the middleware keyhole would then let through to a route that refuses
  // it, converting every legacy row into a 401.
  it('sends NO grant header at all', async () => {
    const q = await loadQueue();
    const { fn, calls } = recordingFetch((url) => {
      if (url === '/api/photos/upload-url') {
        return json({ storage_key: 'loads/load-1/bol/x.jpg', upload_url: null });
      }
      return json({ id: 'photo-1' });
    });
    vi.stubGlobal('fetch', fn);

    await q.enqueueUpload({
      load_id: 'load-1',
      kind: 'bol',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
    });
    const r = await q.replayAll();

    expect(r.uploads_replayed, 'a grantless row stopped draining').toBe(1);
    for (const c of calls) {
      expect(c.headers, `${c.url} carried a grant header it should not have`).not.toHaveProperty(
        'x-upload-grant',
      );
    }
  });
});

// ── §6.5 — a refused grant is a DISTINCT, visible state ──────────────────────

describe('ADR-0086 §6.5 — a refused grant is visible, never a generic retry', () => {
  // "Verification failure must be a distinct, visible client state, never folded
  // into the generic offline retry — that conflation is precisely what let 97
  // photos accumulate invisibly behind the CORS 403."
  //
  // The server answers 401 with a `grant` reason, so the row lands in the `auth`
  // family (a sign-in genuinely fixes it — the session path then takes over) but
  // under its OWN `last_error`, so the queue screen can say which.
  //
  // FALSIFIED BY HAND: returning `AUTH_EXPIRED` unconditionally from
  // `authErrorFor` makes the first assertion red — the refused grant becomes
  // indistinguishable from an ordinary lapsed session, which is the conflation.
  it('parks the row as auth:grant_refused, not as a conflict and not as generic', async () => {
    const q = await loadQueue();
    const { fn } = recordingFetch(() =>
      json({ error: 'unauthenticated', grant: 'grant_actor_inactive' }, 401),
    );
    vi.stubGlobal('fetch', fn);

    await q.enqueueUpload({
      load_id: 'load-1',
      kind: 'bol',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
      upload_grant: GRANT,
    });
    const r = await q.replayAll();

    const { uploads } = await q.listPending();
    expect(uploads, 'the row was dropped').toHaveLength(1);
    expect(uploads[0]!.last_error).toBe(q.AUTH_GRANT_REFUSED);
    // In the `auth` family — recoverable by a PIN, counted as still trying —
    // and NOT a conflict, which would demand individual human adjudication for
    // the ordinary expiry of a fortnight-old credential.
    expect(uploads[0]!.state).toBe('auth');
    expect(q.isConflict(uploads[0]!)).toBe(false);
    expect(r.auth).toBe(1);
    expect(r.conflicts).toBe(0);
  });

  it('a plain 401 with no grant reason is still an ordinary session expiry', async () => {
    const q = await loadQueue();
    const { fn } = recordingFetch(() => json({ error: 'unauthenticated' }, 401));
    vi.stubGlobal('fetch', fn);

    await q.enqueueUpload({
      load_id: 'load-1',
      kind: 'bol',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
    });
    await q.replayAll();

    const { uploads } = await q.listPending();
    expect(uploads[0]!.last_error, 'a lapsed session was relabelled as a grant problem').toBe(
      q.AUTH_EXPIRED,
    );
  });

  // "Retry all" is the one-tap recovery from a parked queue (ADR-0078 G8c). It
  // discards the stale presign — and must NOT discard the grant, or pressing it
  // would quietly convert "try again" into "try again, but only if somebody is
  // signed in", on the exact screen an operator reaches when the queue is stuck.
  //
  // FALSIFIED BY HAND: adding `upload_grant: null` to `retryRow`'s put makes
  // this red.
  it('Retry preserves the grant while discarding the stale presign', async () => {
    const q = await loadQueue();
    const row = await q.enqueueUpload({
      load_id: 'load-1',
      kind: 'bol',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      content_type: 'image/jpeg',
      storage_key: 'loads/load-1/bol/old.jpg',
      upload_url: 'https://r2/expired',
      upload_grant: GRANT,
    });
    await q.markUploadAttempt(row.id, 'conflict:mint 403');
    await q.retryRow(row.id, 'upload');

    const { uploads } = await q.listPending();
    expect(uploads[0]!.storage_key, 'the stale presign survived a retry').toBeNull();
    expect(uploads[0]!.upload_url).toBeNull();
    expect(uploads[0]!.upload_grant, 'Retry threw away the credential').toBe(GRANT);
    expect(uploads[0]!.last_error).toBeNull();
  });
});

// ── The upgrade discipline ───────────────────────────────────────────────────

describe('ADR-0086 — the additive field did not disturb the upgrade path', () => {
  // REGRESSION GUARD on the double-walk class. The v2→v3 block originally ran on
  // `oldVersion < 3`, so a v1 database got two concurrent cursor walks over
  // `pending_uploads`; they interleave — the second reads a row the first has
  // already queued an update for and writes its own copy over the top — which
  // silently reverted the ADR-0078 G2 idempotency-key backfill for every legacy
  // row. The upgrade looked successful while quietly re-arming the
  // duplicate-confirm defect for exactly the rows it was built to protect.
  //
  // Repeated here rather than assumed still-covered: this ADR touched the
  // `PendingUpload` shape, and "the other suite covers it" is how a shared
  // invariant stops being covered by anybody.
  //
  // FALSIFIED BY HAND: changing the v2→v3 guard back to `oldVersion < 3` makes
  // the idempotency-key assertion red.
  it('v1 → current still preserves the blob, the byte size and the G2 key', async () => {
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

    expect(uploads, 'a legacy row was dropped by the upgrade').toHaveLength(1);
    expect(uploads[0]!.idempotency_key, 'the ADR-0078 G2 key backfill was clobbered').toBeTruthy();
    expect(uploads[0]!.subject, 'the ADR-0085 subject backfill did not run').toBe('load');
    expect(uploads[0]!.byte_size, 'the legacy row was rebuilt, not preserved').toBe(3);
    expect(uploads[0]!.state).toBe('active');
    // A pre-ADR-0086 row has no grant, and there is nothing honest to invent for
    // it. `undefined` reads as absent at every call site, which is why no
    // version bump and no third cursor walk were needed.
    expect(uploads[0]!.upload_grant ?? null).toBeNull();
  });

  it('a legacy row with no grant still replays end to end after the upgrade', async () => {
    await seedV1Upload({
      id: 'v1-row',
      load_id: 'load-9',
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
    const { fn, calls } = recordingFetch((url) => {
      if (url === '/api/photos/upload-url') {
        return json({ storage_key: 'loads/load-9/bol/x.jpg', upload_url: null });
      }
      return json({ id: 'photo-1' });
    });
    vi.stubGlobal('fetch', fn);

    const r = await q.replayAll();
    expect(r.uploads_replayed, 'an upgraded legacy row stopped draining').toBe(1);
    expect(calls.map((c) => c.url)).toEqual(['/api/photos/upload-url', '/api/photos/confirm']);
    // The backfilled key rides the confirm, which is what G2 was for.
    expect(calls[1]!.headers['idempotency-key']).toBeTruthy();
  });
});
