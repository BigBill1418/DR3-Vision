// ADR-0006 Amendment 1 — with the service worker no longer replaying server
// actions, `offline-queue.ts` is the ONLY replay path for the dock writes. These
// pin the contract that path owes the floor for the two writes that carry an
// idempotency key (`add_stack`, `finish_unload`):
//
//   1. queued under AUTH_EXPIRED → kept, not dropped, not a conflict;
//   2. the same operator signs back in → it replays ONCE, with the key it was
//      queued with;
//   3. a later sweep sends nothing (the row is gone — no second write);
//   4. a DIFFERENT operator signs in → the server refuses (403
//      load_not_assigned_to_operator, `assertOwn`), the row is KEPT as a
//      conflict naming the takeover, and no later sweep re-sends it.
//
// The server half — the second replay of the same key writes nothing, and a
// different operator's replay writes nothing — is proved against real Postgres
// in `floor-exactly-once.db.test.ts`. Synthetic ids only.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/fetch-timeout', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/fetch-timeout')>();
  return {
    ...orig,
    fetchWithTimeout: (url: string, init?: RequestInit) => orig.fetchWithTimeout(url, init, 50),
  };
});

async function loadQueue() {
  vi.resetModules();
  return import('./offline-queue');
}

type Sent = { url: string; body: { scope: string; idempotency_key: string | null } };

/** A server whose answer is set per sweep; records every replay it receives. */
function server() {
  const sent: Sent[] = [];
  let answer: () => Response = () => new Response('{}', { status: 500 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Sent['body'] });
      return answer();
    }),
  );
  return {
    sent,
    answer: (fn: () => Response) => {
      answer = fn;
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CASES = [
  {
    scope: 'operator.load.add_stack',
    payload: { loadId: 'load-syn-1', stackIndex: 1, unitCount: 4, countMode: 'ledger' },
    ok: 201,
  },
  {
    scope: 'operator.load.finish_unload',
    payload: { loadId: 'load-syn-1', countMode: 'ledger' },
    ok: 200,
  },
] as const;

/** Past every backoff window, so `isReady` is never the reason a row is skipped. */
function pastBackoff() {
  vi.setSystemTime(Date.now() + 10 * 60 * 1000);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(CASES)('$scope queued under AUTH_EXPIRED', ({ scope, payload, ok }) => {
  async function queueExpired() {
    const q = await loadQueue();
    const srv = server();
    const key = q.newIdempotencyKey();
    await q.enqueueAction({
      scope,
      site_code: 'woodland',
      target_day: null,
      idempotency_key: key,
      payload,
      endpoint: `server-action:${scope}`,
      load_id: payload.loadId,
    });
    srv.answer(() => json(401, { error: 'unauthenticated' }));
    const r = await q.replayAll();
    expect(r.auth).toBe(1);
    expect(r.conflicts).toBe(0);
    const { actions } = await q.listPending();
    expect(actions).toHaveLength(1);
    expect(actions[0]!.last_error).toBe(q.AUTH_EXPIRED);
    return { q, srv, key };
  }

  it('the same operator signs in → replays ONCE with its key; the next sweep sends nothing', async () => {
    const { q, srv, key } = await queueExpired();

    srv.answer(() => json(ok, { ok: true }));
    pastBackoff();
    const r = await q.replayAll();
    expect(r.actions_replayed).toBe(1);
    expect((await q.listPending()).actions).toHaveLength(0);

    pastBackoff();
    await q.replayAll();

    // One 401 (the expired attempt) and ONE accepted replay — never a third.
    expect(srv.sent.map((s) => s.url)).toEqual(['/api/queue/replay', '/api/queue/replay']);
    expect(srv.sent.every((s) => s.body.scope === scope && s.body.idempotency_key === key)).toBe(
      true,
    );
  });

  it('a DIFFERENT operator signs in → refused, kept as a conflict, never re-sent', async () => {
    const { q, srv } = await queueExpired();

    srv.answer(() => json(403, { error: 'load_not_assigned_to_operator' }));
    pastBackoff();
    const r = await q.replayAll();
    expect(r.actions_replayed).toBe(0);
    const { actions } = await q.listPending();
    expect(actions, 'a refused write must not be dropped').toHaveLength(1);
    expect(actions[0]!.last_error).toBe(q.CONFLICT_LOAD_TAKEN_OVER);

    pastBackoff();
    await q.replayAll();
    expect(srv.sent).toHaveLength(2); // the 401 and the 403 — nothing after
  });
});
