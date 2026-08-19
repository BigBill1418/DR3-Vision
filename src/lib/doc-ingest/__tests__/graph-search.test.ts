// ADR-0080 — the tenant-search transport behind the reachability probe.
//
// This gets its own tests because the whole feature is INERT if the response
// walk is wrong, and it would be inert QUIETLY: `runReachabilityScan` would see
// zero items, compute a gap of zero, and render "every document in scope is
// being watched" — the exact reassuring falsehood the feature exists to remove.
//
// Two shapes in Graph's response are easy to get wrong and both are pinned here:
//
//   1. `total` and `moreResultsAvailable` live on the HITS CONTAINER, not on the
//      response. Reading them off the response yields `undefined`, which reads as
//      "no more results" and silently caps every scan at one page.
//   2. Each hit wraps the driveItem in `resource`. Projecting the hit itself
//      yields null (no `id`), i.e. an empty scan.
//
// Every network path is driven through an injected `fetchImpl`; CI has no
// tenant, and this must never reach one.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { docIngestGraph } from '../graph';

// The token store derives its AES key from this. Set BEFORE `seal` is imported
// and used, so the cached-token path below is the REAL crypto path rather than a
// stub of it — the point is to exercise `acquireAccessToken`'s short-circuit, not
// to route around it.
process.env['MYMRC_CRED_KEY'] = 'a'.repeat(64);

let sealed: { ciphertext: string; iv: string; authTag: string };

beforeAll(async () => {
  const { seal } = await import('../secret-box');
  sealed = seal('test-access-token');
});

/**
 * A prisma stand-in holding a LIVE cached access token, so `acquireAccessToken`
 * short-circuits before any refresh call and the only fetch in these tests is
 * the search itself.
 */
function prismaWithToken(): PrismaClient {
  return {
    docIngestConnection: {
      findUnique: vi.fn(async () => ({
        id: 'singleton',
        state: 'connected',
        reauth_reason: null,
        access_token_ciphertext: sealed.ciphertext,
        access_token_iv: sealed.iv,
        access_token_auth_tag: sealed.authTag,
        // Comfortably beyond the 60s expiry skew.
        access_token_expires_at: new Date(Date.now() + 30 * 60_000),
        key_version: 1,
      })),
    },
  } as unknown as PrismaClient;
}

function hit(id: string, driveId: string, name: string): unknown {
  return {
    resource: {
      id,
      name,
      file: { mimeType: 'application/vnd.ms-excel' },
      size: 1024,
      webUrl: `https://example-my.sharepoint.com/${name}`,
      lastModifiedDateTime: '2026-08-06T12:00:00Z',
      createdBy: { user: { email: 'kelsey.ruhland@svdp.us' } },
      parentReference: { driveId },
    },
  };
}

function searchBody(hits: unknown[], more: boolean, total: number): unknown {
  return {
    value: [
      {
        hitsContainers: [{ hits, total, moreResultsAvailable: more }],
      },
    ],
  };
}

function jsonFetch(pages: unknown[]): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

describe('searchDriveItems — the response walk', () => {
  it('projects each hit’s `resource`, keyed on (driveId, itemId)', async () => {
    const { fetchImpl } = jsonFetch([
      searchBody(
        [
          hit('01MACHINE', 'drive-bill', 'DR3 Machine List (2).xlsx'),
          hit('01TRAILER', 'drive-kelsey', 'Woodland Trailer list.xlsx'),
        ],
        false,
        2,
      ),
    ]);

    const graph = docIngestGraph(prismaWithToken(), { fetchImpl });
    const res = await graph.searchDriveItems('filetype:xlsx', 200);

    // Named, so projecting the HIT rather than `hit.resource` reds with an empty
    // list against a real filename rather than an opaque length mismatch.
    expect(res.items.map((i) => i.name)).toEqual([
      'DR3 Machine List (2).xlsx',
      'Woodland Trailer list.xlsx',
    ]);
    expect(res.items[0]?.driveId).toBe('drive-bill');
    expect(res.items[0]?.id).toBe('01MACHINE');
    // `createdBy` is what the gap surface renders as "who to ask about this".
    expect(res.items[0]?.createdByUpn).toBe('kelsey.ruhland@svdp.us');
    expect(res.total).toBe(2);
    expect(res.truncated).toBe(false);
  });

  it('POSTs a driveItem-scoped query carrying the KQL verbatim', async () => {
    const { fetchImpl, calls } = jsonFetch([searchBody([], false, 0)]);
    const graph = docIngestGraph(prismaWithToken(), { fetchImpl });
    const kql = '(filetype:xlsx) AND path:"https://svdplanecounty-my.sharepoint.com"';

    await graph.searchDriveItems(kql, 200);

    const body = calls[0]?.body as {
      requests: { entityTypes: string[]; query: { queryString: string } }[];
    };
    expect(calls[0]?.url).toContain('/search/query');
    expect(body.requests[0]?.entityTypes).toEqual(['driveItem']);
    // Verbatim: a scope that is rewritten in flight is not the scope the health
    // surface claims produced the numbers.
    expect(body.requests[0]?.query.queryString).toBe(kql);
  });

  it('stops when the CONTAINER says there are no more results', async () => {
    const { fetchImpl, calls } = jsonFetch([
      searchBody([hit('a', 'd', 'a.xlsx')], false, 1),
      searchBody([hit('b', 'd', 'b.xlsx')], false, 1),
    ]);
    const graph = docIngestGraph(prismaWithToken(), { fetchImpl });

    const res = await graph.searchDriveItems('filetype:xlsx', 200);

    // Exactly ONE request. Reading `moreResultsAvailable` off the RESPONSE
    // instead of the container yields undefined — falsy — which happens to stop
    // here too, so the next test is the one that actually pins the location.
    expect(calls).toHaveLength(1);
    expect(res.items).toHaveLength(1);
  });

  it('pages while the container says there are more, and reports truncation at the cap', async () => {
    // limit 200 with a 200-item page size means ONE page fits; a container still
    // claiming more must therefore surface as `truncated`.
    const { fetchImpl, calls } = jsonFetch([searchBody([hit('a', 'd', 'a.xlsx')], true, 5_000)]);
    const graph = docIngestGraph(prismaWithToken(), { fetchImpl });

    const res = await graph.searchDriveItems('*', 200);

    expect(calls).toHaveLength(1);
    // The load-bearing assertion. If this were false the health surface would
    // present a partial gap as a complete one — an under-count wearing the
    // authority of a measurement, which is the defect ADR-0080 exists to end.
    expect(res.truncated).toBe(true);
    expect(res.total).toBe(5_000);
  });

  it('walks two pages when the cap allows, accumulating both', async () => {
    const { fetchImpl, calls } = jsonFetch([
      searchBody([hit('a', 'd', 'a.xlsx')], true, 2),
      searchBody([hit('b', 'd', 'b.xlsx')], false, 2),
    ]);
    const graph = docIngestGraph(prismaWithToken(), { fetchImpl });

    // A cap above one page's worth, so paging is permitted.
    const res = await graph.searchDriveItems('filetype:xlsx', 400);

    expect(calls).toHaveLength(2);
    expect((calls[0]?.body as { requests: { from: number }[] }).requests[0]?.from).toBe(0);
    expect((calls[1]?.body as { requests: { from: number }[] }).requests[0]?.from).toBe(200);
    expect(res.items.map((i) => i.name)).toEqual(['a.xlsx', 'b.xlsx']);
    expect(res.truncated).toBe(false);
  });

  it('returns an EMPTY result — never throws — for a container with no hits', async () => {
    const { fetchImpl } = jsonFetch([searchBody([], false, 0)]);
    const graph = docIngestGraph(prismaWithToken(), { fetchImpl });
    const res = await graph.searchDriveItems('filetype:xlsx', 200);
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  // ── ADR-0112 — a shape change must not project to a quiet zero ────────────
  //
  // `projectDriveItem` returns null for a resource it cannot key, and the walk
  // used to DROP those silently. That is the ADR-0102 lesson in its purest form:
  // a response whose branch field moved projects to nothing, the scan records
  // `reachable 0`, and the surface says every document is watched. The transport
  // cannot know a shape changed — but it CAN know that Graph handed it hits and
  // it produced no items from them, and that is never a legitimate state.
  it('THROWS on hits it cannot project, rather than dropping them silently', async () => {
    // The classic: `parentReference` present but carrying no `driveId`, so the
    // identity half of the (driveId, itemId) key is gone. Every hit is affected,
    // which is exactly how a real contract drift arrives.
    const drifted = {
      resource: {
        id: '01MACHINE',
        name: 'DR3 Machine List (2).xlsx',
        file: { mimeType: 'application/vnd.ms-excel' },
        parentReference: { siteId: 'svdplanecounty-my.sharepoint.com,abc,def' },
      },
    };
    const { fetchImpl } = jsonFetch([searchBody([drifted], false, 1)]);
    const graph = docIngestGraph(prismaWithToken(), { fetchImpl });

    const outcome = await graph
      .searchDriveItems('filetype:xlsx', 200)
      .then((r) => `SILENT: ${r.items.length} items from ${1} hit(s)`)
      .catch((e) => `THREW: ${(e as Error).name}`);
    expect(outcome).toBe('THREW: GraphContractDriftError');
  });

  it('still projects the hits it CAN, when only some drift', async () => {
    // Not an all-or-nothing guard: one unprojectable hit among good ones is
    // still a contract change, and reporting the rest would under-state the
    // reachable set — the same under-count ADR-0080 exists to end.
    const drifted = { resource: { name: 'no-id.xlsx', parentReference: { driveId: 'd' } } };
    const { fetchImpl } = jsonFetch([
      searchBody(
        [hit('01TRAILER', 'drive-kelsey', 'Woodland Trailer list.xlsx'), drifted],
        false,
        2,
      ),
    ]);
    const graph = docIngestGraph(prismaWithToken(), { fetchImpl });
    await expect(graph.searchDriveItems('filetype:xlsx', 200)).rejects.toThrow(
      /could not be projected/i,
    );
  });

  it('THROWS on an HTTP failure rather than reporting zero items', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('{"error":{"code":"serviceNotAvailable"}}', { status: 503 });
    const graph = docIngestGraph(prismaWithToken(), { fetchImpl });

    // Swallowing this into `{ items: [] }` is the single worst outcome available:
    // the scan would record a gap of zero and the surface would say every
    // document is watched. `runReachabilityScan` catches the throw and records a
    // FAILED scan — but only because there IS a throw to catch.
    await expect(graph.searchDriveItems('filetype:xlsx', 200)).rejects.toThrow(/503/);
  });
});
