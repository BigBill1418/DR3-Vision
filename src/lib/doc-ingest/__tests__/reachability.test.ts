// ADR-0080 Phase 1 — reachable vs watched.
//
// The fixtures are the REAL 2026-08-07 measurement, not invented shapes: eleven
// spreadsheets readable by `docs-dr3@svdp.us` inside the configured scope, three
// of them already watched, eight not — including `DR3 Machine List (2).xlsx`,
// the Outlook-attachment share that appears in NO enumeration route and was the
// document that proved discovery was under-reporting.
//
// ── Why this file builds its own fake instead of using `__testutils__` ──────
// The shared doc-ingest fake does not model the two tables under test, and — the
// load-bearing reason — this suite has to prove the module reads IDENTITY rather
// than names, and that a probe FAILURE is not recorded as a clean scan. Both are
// properties of what the code asks the database, so the fake has to honour
// `where`/`orderBy` rather than hand back a convenient answer. A fake that is
// wrong in the reassuring direction is worse than no fake at all.
//
// Every guard below was falsified before it was kept, and each red names the
// real wrong value.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { DocIngestSearch, GraphDriveItem } from '../graph';
import {
  docIngestDiscoveryGapWarning,
  runReachabilityScan,
  REACHABILITY_SUBJECT,
} from '../reachability';

const NOW = new Date('2026-08-07T20:00:00Z');
const SCOPE = '(filetype:xlsx) AND path:"https://svdplanecounty-my.sharepoint.com"';

// The two personal OneDrives that actually hold DR3's documents, verbatim.
const KELSEY = 'b!4CzvoBCatkKoV1oZd9MkhSzOViAhiXNFthpKKUzGJEHt66jhPKMvTLNpGh1zvpwT';
const JANETTE = 'b!bcdH9g_Pl06E3lDo97KbaG1GwDY1getJsoZP-EbLB_7oeK1a7djzQogo_4-nX8Q2';
const BILL = 'b!0qdek2Vb40OOiVdThQy0tgCyBZJXkDRCulCe-5IGKYWhC7UF3DWeRLCFPkNend8E';

/** Shared by BOTH TEREX.xlsx copies — see `liveReachable()`. */
const TEREX_ID = '01BUKLLR4SP7OVQTGCYZFLHJIVQT2NVYR7';

function item(over: Partial<GraphDriveItem> & { id: string; driveId: string }): GraphDriveItem {
  return {
    name: 'x.xlsx',
    isFolder: false,
    webUrl: null,
    ctag: null,
    etag: null,
    size: 1024,
    contentType: null,
    lastModifiedAt: '2026-08-01T00:00:00Z',
    lastModifiedBy: null,
    ownerUpn: null,
    createdByUpn: null,
    sharedOwnerUpn: null,
    parentItemId: null,
    parentPath: null,
    deleted: false,
    ...over,
  };
}

/** The live scope's eleven hits, in the order Search returned them. */
function liveReachable(): GraphDriveItem[] {
  return [
    item({ id: TEREX_ID, driveId: JANETTE, name: 'TEREX.xlsx' }),
    item({
      id: 'commodity',
      driveId: KELSEY,
      name: 'Woodland Data Auditing Tracker (1).xlsx',
      createdByUpn: 'kelsey.ruhland@svdp.us',
    }),
    item({ id: 'trailer', driveId: KELSEY, name: 'Woodland Trailer list.xlsx' }),
    // The document that started this: same NAME as nothing else, but note the
    // next entry — a SECOND TEREX.xlsx in a different drive.
    item({
      id: 'machine',
      driveId: BILL,
      name: 'DR3 Machine List (2).xlsx',
      createdByUpn: 'bill.barnard@svdp.us',
      lastModifiedAt: '2026-08-06T12:00:00Z',
    }),
    // SAME item id, DIFFERENT drive — that is legal and normal: a driveItem id
    // is unique only within its drive, which is the entire reason the identity
    // is the PAIR (D8). A fixture with globally-unique ids would let a regression
    // that drops `driveId` from the key pass unnoticed.
    item({ id: TEREX_ID, driveId: KELSEY, name: 'TEREX.xlsx' }),
    item({ id: 'journal', driveId: KELSEY, name: 'JOURNAL Woodland Facility.xlsx' }),
    item({ id: 'datatrack', driveId: KELSEY, name: 'DR3 Data Tracking.xlsx' }),
    item({ id: 'meeting', driveId: KELSEY, name: 'DR3 Meeting Notes Log 2026.xlsx' }),
    item({ id: 'tasks', driveId: KELSEY, name: 'DR3 Task Lists for 2025.xlsx' }),
    item({ id: 'invoices', driveId: KELSEY, name: 'Woodland Invoices tracking.xlsx' }),
    item({ id: 'outbound', driveId: KELSEY, name: 'Woodland Outbound Auditing 2026.xlsx' }),
  ];
}

/**
 * A `doc_sources` row. `enabled` / `disappeared_at` are modelled because the
 * module reads BOTH: every source counts as WATCHED (including disabled ones),
 * but only a LIVE source — enabled and not disappeared — is evidence that
 * documents exist for the probe to have found. Defaulting them here keeps the
 * two readings from being silently conflated by a fixture that omits the fields.
 */
function source(
  drive_id: string,
  item_id: string,
  over: { enabled?: boolean; disappeared_at?: Date | null } = {},
): DocSourceRow {
  return { drive_id, item_id, enabled: true, disappeared_at: null, ...over };
}

interface DocSourceRow {
  drive_id: string;
  item_id: string;
  enabled: boolean;
  disappeared_at: Date | null;
}

/** The three `doc_sources` rows production actually held on 2026-08-07. */
function liveWatched(): DocSourceRow[] {
  return [source(JANETTE, TEREX_ID), source(KELSEY, 'commodity'), source(KELSEY, 'trailer')];
}

interface Store {
  connectionState: 'connected' | 'reauth_required';
  sources: DocSourceRow[];
  scans: Record<string, unknown>[];
  items: Record<string, unknown>[];
  anomalies: { kind: string; subject: string; detail: string }[];
  resolved: { kind: string; subject: string }[];
}

let store: Store;

const raiseAnomalyMock = vi.hoisted(() => vi.fn());
const resolveAnomalyMock = vi.hoisted(() => vi.fn());

vi.mock('../anomalies', async (orig) => {
  const actual = await orig<typeof import('../anomalies')>();
  return {
    ...actual,
    raiseAnomaly: raiseAnomalyMock,
    resolveAnomaly: resolveAnomalyMock,
  };
});

function fakePrisma(): PrismaClient {
  let n = 0;
  return {
    // The digest warning is gated on document ingestion actually being CONNECTED
    // — see `docIngestDiscoveryGapWarning`. These tests are about what it says
    // WHEN there is an ingester, so the connection is seeded connected.
    docIngestConnection: {
      findUnique: vi.fn(async () => ({ state: store.connectionState })),
    },
    docSource: {
      findMany: vi.fn(async () => store.sources.map((s) => ({ ...s }))),
    },
    docIngestReachabilityScan: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `scan-${++n}`, ...data };
        store.scans.push(row);
        return { ...row };
      }),
      // HONOURS `orderBy` rather than hardcoding newest-first. A fake that always
      // sorted descending would make the direction untestable: flipping the
      // module to `asc` would read a stale scan, produce a plausible number, and
      // the suite would stay green.
      findFirst: vi.fn(async ({ orderBy }: { orderBy?: { scanned_at?: 'asc' | 'desc' } } = {}) => {
        const dir = orderBy?.scanned_at ?? 'asc';
        const sorted = [...store.scans].sort((a, b) => {
          const av = (a['scanned_at'] as Date).getTime();
          const bv = (b['scanned_at'] as Date).getTime();
          return dir === 'desc' ? bv - av : av - bv;
        });
        return sorted[0] ? { ...sorted[0] } : null;
      }),
      findMany: vi.fn(async ({ skip = 0 }: { skip?: number } = {}) =>
        [...store.scans]
          .sort((a, b) => (b['scanned_at'] as Date).getTime() - (a['scanned_at'] as Date).getTime())
          .slice(skip)
          .map((s) => ({ id: s['id'] as string })),
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        store.scans = store.scans.filter((s) => !where.id.in.includes(s['id'] as string));
        return { count: 0 };
      }),
    },
    docIngestReachableItem: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        store.items.push(...data);
        return { count: data.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { scan_id: { in: string[] } } }) => {
        const before = store.items.length;
        store.items = store.items.filter((i) => !where.scan_id.in.includes(i['scan_id'] as string));
        return { count: before - store.items.length };
      }),
      // Honours the scan filter — otherwise the digest would happily read another
      // scan's items and nothing would notice.
      findMany: vi.fn(async ({ where, take }: { where: { scan_id: string }; take?: number }) =>
        store.items
          .filter((i) => i['scan_id'] === where.scan_id)
          .slice(0, take ?? undefined)
          .map((i) => ({ ...i })),
      ),
    },
  } as unknown as PrismaClient;
}

function searchReturning(items: GraphDriveItem[], truncated = false): DocIngestSearch {
  return {
    searchDriveItems: vi.fn(async () => ({ items, total: items.length, truncated })),
  };
}

beforeEach(() => {
  store = {
    connectionState: 'connected',
    sources: liveWatched(),
    scans: [],
    items: [],
    anomalies: [],
    resolved: [],
  };
  raiseAnomalyMock.mockReset();
  resolveAnomalyMock.mockReset();
  raiseAnomalyMock.mockImplementation(
    async (_p: unknown, a: { kind: string; subject: string; detail: string }) => {
      store.anomalies.push({ kind: a.kind, subject: a.subject, detail: a.detail });
      return { raised: true, anomalyId: 'a-1' };
    },
  );
  resolveAnomalyMock.mockImplementation(async (_p: unknown, kind: string, subject: string) => {
    store.resolved.push({ kind, subject });
    return { resolved: 1 };
  });
});

describe('runReachabilityScan — the live 2026-08-07 measurement', () => {
  it('reports 11 readable, 3 watched, 8 unwatched', async () => {
    const res = await runReachabilityScan(fakePrisma(), searchReturning(liveReachable()), {
      now: NOW,
      scope: SCOPE,
    });

    expect(res.error).toBeNull();
    expect(res.reachable).toBe(11);
    expect(res.watched).toBe(3);
    expect(res.gap).toHaveLength(8);
  });

  it('names DR3 Machine List (2).xlsx — the document no enumeration route sees', async () => {
    const res = await runReachabilityScan(fakePrisma(), searchReturning(liveReachable()), {
      now: NOW,
      scope: SCOPE,
    });
    // Asserted by NAME so a regression's red says which document went missing
    // rather than reporting a count that happens to be off by one.
    expect(res.gap.map((g) => g.name)).toContain('DR3 Machine List (2).xlsx');
  });

  it('compares on (driveId, itemId), NOT on display name', async () => {
    // TWO documents are called `TEREX.xlsx` — one in Janette's drive (watched)
    // and one in Kelsey's (not). Comparing by name would treat the second as
    // already-watched and report SEVEN unwatched documents instead of eight,
    // hiding a real one. That is the D8 identity rule, and this is its guard.
    const res = await runReachabilityScan(fakePrisma(), searchReturning(liveReachable()), {
      now: NOW,
      scope: SCOPE,
    });

    const terexInGap = res.gap.filter((g) => g.name === 'TEREX.xlsx');
    expect(terexInGap).toHaveLength(1);
    expect(terexInGap[0]?.driveId).toBe(KELSEY);
    expect(res.gap).toHaveLength(8);
  });

  it('counts one document once when search returns it on two pages', async () => {
    const dupes = [
      ...liveReachable(),
      item({ id: 'machine', driveId: BILL, name: 'DR3 Machine List (2).xlsx' }),
    ];
    const res = await runReachabilityScan(fakePrisma(), searchReturning(dupes), {
      now: NOW,
      scope: SCOPE,
    });
    // Without the dedup this is 12/9 — an inflated gap that would send Bill
    // looking for a document that was already in the list.
    expect(res.reachable).toBe(11);
    expect(res.gap).toHaveLength(8);
  });

  it('does not count a folder as an unwatched document', async () => {
    const withFolder = [
      ...liveReachable(),
      item({ id: 'attachments', driveId: KELSEY, name: 'Attachments', isFolder: true }),
    ];
    const res = await runReachabilityScan(fakePrisma(), searchReturning(withFolder), {
      now: NOW,
      scope: SCOPE,
    });
    expect(res.gap.map((g) => g.name)).not.toContain('Attachments');
    expect(res.gap).toHaveLength(8);
  });

  it('treats a DISABLED source as watched, not as a gap', async () => {
    // Bill's kill switch means "stop spending effort on this", not "keep
    // reminding me about it". Re-reporting a deliberately disabled document
    // every sweep is the deduplication failure ADR-0037 question 4 asks about.
    store.sources = [...liveWatched(), source(BILL, 'machine', { enabled: false })];
    const res = await runReachabilityScan(fakePrisma(), searchReturning(liveReachable()), {
      now: NOW,
      scope: SCOPE,
    });
    expect(res.watched).toBe(4);
    expect(res.gap.map((g) => g.name)).not.toContain('DR3 Machine List (2).xlsx');
  });

  it('raises discovery_gap NAMING the documents, not just the count', async () => {
    await runReachabilityScan(fakePrisma(), searchReturning(liveReachable()), {
      now: NOW,
      scope: SCOPE,
    });
    expect(store.anomalies).toHaveLength(1);
    expect(store.anomalies[0]?.kind).toBe('discovery_gap');
    expect(store.anomalies[0]?.subject).toBe(REACHABILITY_SUBJECT);
    // "8 documents are unwatched" is not actionable; the name is.
    expect(store.anomalies[0]?.detail).toContain('DR3 Machine List (2).xlsx');
    // And it must state that nothing was auto-adopted, because the whole design
    // rests on a human deciding.
    expect(store.anomalies[0]?.detail).toMatch(/registered automatically/i);
  });

  it('resolves the anomaly — and raises none — when everything is watched', async () => {
    store.sources = liveReachable().map((i) => source(i.driveId, i.id));
    const res = await runReachabilityScan(fakePrisma(), searchReturning(liveReachable()), {
      now: NOW,
      scope: SCOPE,
    });
    expect(res.gap).toHaveLength(0);
    expect(store.anomalies).toHaveLength(0);
    expect(store.resolved).toEqual([{ kind: 'discovery_gap', subject: REACHABILITY_SUBJECT }]);
  });

  it('records the EXACT scope that produced the numbers', async () => {
    await runReachabilityScan(fakePrisma(), searchReturning(liveReachable()), {
      now: NOW,
      scope: SCOPE,
    });
    // A count whose bound is unknown is not evidence of anything, so the bound
    // is stored beside it rather than re-derived at render time (by which point
    // the config may have changed).
    expect(store.scans[0]?.['scope_query']).toBe(SCOPE);
  });

  it('propagates truncation — an under-stated gap must not look complete', async () => {
    const res = await runReachabilityScan(fakePrisma(), searchReturning(liveReachable(), true), {
      now: NOW,
      scope: SCOPE,
    });
    expect(res.truncated).toBe(true);
    expect(store.scans[0]?.['truncated']).toBe(true);
    expect(store.anomalies[0]?.detail).toMatch(/TRUNCATED/i);
  });
});

describe('runReachabilityScan — "we could not look" is never "there is no gap"', () => {
  it('records a FAILED scan and raises, rather than reporting a clean zero', async () => {
    const boom: DocIngestSearch = {
      searchDriveItems: vi.fn(async () => {
        throw new Error('graph POST /search/query → HTTP 503');
      }),
    };

    const res = await runReachabilityScan(fakePrisma(), boom, { now: NOW, scope: SCOPE });

    // The critical distinction. `gap.length === 0` is TRUE here — and it must
    // never be readable as good news, which is why `error` carries the verdict
    // and every consumer is required to branch on it first. A version of this
    // module that swallowed the throw and returned `{ gap: [], error: null }`
    // would look identical to a perfectly healthy scan.
    // Phrased as a VERDICT rather than `expect(res.error).not.toBeNull()`, so a
    // regression's red reads `expected 'CLEAN scan reporting 0 unwatched' …`
    // instead of the useless `expected null not to be null`. The whole risk here
    // is a failure that looks like health, so the red has to show it looking
    // like health.
    const verdict =
      res.error === null
        ? `CLEAN scan reporting ${res.gap.length} unwatched`
        : `FAILED: ${res.error}`;
    expect(verdict).toMatch(/^FAILED: .*503/);
    expect(res.gap).toHaveLength(0);

    // Persisted as a failure, not omitted: a scan that never appears is a scan
    // nobody can notice stopped happening.
    expect(store.scans).toHaveLength(1);
    expect(store.scans[0]?.['error']).toContain('503');

    expect(store.anomalies).toHaveLength(1);
    expect(store.anomalies[0]?.kind).toBe('discovery_gap');
    expect(store.resolved).toHaveLength(0);
  });
});

describe('docIngestDiscoveryGapWarning — the 06:00 digest line', () => {
  it('warns when no scan has EVER run', async () => {
    const prisma = fakePrisma();
    const line = await docIngestDiscoveryGapWarning(prisma, NOW);
    // Silence here would mean an un-deployed or never-running scan reads exactly
    // like a healthy one — the ADR-0057 D9 failure, rebuilt in the digest. The
    // `??` makes the red SAY that instead of `expected null not to be null`.
    expect(line ?? 'SILENT — the digest said nothing about a pipeline nobody measured').toMatch(
      /never been checked/i,
    );
  });

  it('warns when the last scan ERRORED', async () => {
    const prisma = fakePrisma();
    const boom: DocIngestSearch = {
      searchDriveItems: vi.fn(async () => {
        throw new Error('graph POST /search/query → HTTP 503');
      }),
    };
    await runReachabilityScan(prisma, boom, { now: NOW, scope: SCOPE });

    const line = await docIngestDiscoveryGapWarning(prisma, NOW);
    expect(line ?? 'SILENT — the digest hid a probe that could not run').toMatch(/could not run/i);
    expect(line ?? '').toContain('503');
  });

  it('names the documents when there IS a gap', async () => {
    const prisma = fakePrisma();
    await runReachabilityScan(prisma, searchReturning(liveReachable()), {
      now: NOW,
      scope: SCOPE,
    });

    const line = await docIngestDiscoveryGapWarning(prisma, NOW);
    expect(line).toContain('8 document(s)');
    expect(line).toContain('DR3 Machine List (2).xlsx');
  });

  it('says the figure may be stale when the scan is over a day old', async () => {
    const prisma = fakePrisma();
    await runReachabilityScan(prisma, searchReturning(liveReachable()), {
      now: NOW,
      scope: SCOPE,
    });

    const twoDaysLater = new Date(NOW.getTime() + 48 * 3_600_000);
    const line = await docIngestDiscoveryGapWarning(prisma, twoDaysLater);
    // A gap number is only as good as the run that produced it; a check that
    // stopped running looks identical to one that keeps finding nothing.
    expect(line).toMatch(/48h ago/);
    expect(line).toMatch(/may be stale/i);
  });

  it('stays SILENT when ingestion is DISCONNECTED — the reauth warning owns that', async () => {
    const prisma = fakePrisma();
    store.connectionState = 'reauth_required';
    // "Discovery has never been checked" would be true here and useless: the
    // reason is that nothing is ingesting, `docIngestReauthWarning` already says
    // so, and a second line for one root cause is ADR-0037 question 4's failure.
    expect(await docIngestDiscoveryGapWarning(prisma, NOW)).toBeNull();
  });

  it('stays SILENT only when a successful scan found no gap', async () => {
    const prisma = fakePrisma();
    store.sources = liveReachable().map((i) => source(i.driveId, i.id));
    await runReachabilityScan(prisma, searchReturning(liveReachable()), {
      now: NOW,
      scope: SCOPE,
    });

    // The ONE quiet case. Asserted alongside the two noisy ones above so that a
    // change collapsing "never ran" or "errored" into silence goes red here by
    // making all three cases behave the same.
    expect(await docIngestDiscoveryGapWarning(prisma, NOW)).toBeNull();
  });
});

describe('runReachabilityScan — retention keeps the counts, drops the snapshots', () => {
  it('prunes ITEM rows without taking the scan history with them', async () => {
    const prisma = fakePrisma();
    // Three scans, retaining items for only the newest one.
    for (let i = 0; i < 3; i += 1) {
      await runReachabilityScan(prisma, searchReturning(liveReachable()), {
        now: new Date(NOW.getTime() + i * 900_000),
        scope: SCOPE,
        keepItemScans: 1,
        keepScans: 5_000,
      });
    }

    // The COUNTS are the history — "when did the gap open?" is only answerable
    // if scan rows outlive the sweep that wrote them. Deleting a scan cascades
    // to its items, so a single combined prune throws these away silently.
    expect(store.scans).toHaveLength(3);

    // …while only the newest scan keeps its per-document snapshot.
    const newestId = store.scans[store.scans.length - 1]?.['id'];
    const scansWithItems = new Set(store.items.map((i) => i['scan_id']));
    expect([...scansWithItems]).toEqual([newestId]);
  });
});

// ── ADR-0112 — a zero that contradicts the watched set ──────────────────────
//
// The 2026-08-19 blindness review. The scan table was read as "the probe has
// gone blind" and the premise died on measurement — `reachable_count` had been
// 11 on every successful scan since 2026-08-07, and the 0 that was read as
// blindness was `gap_count`, which went to 0 legitimately when Bill registered
// the last six documents at 17:12 PT on 2026-08-15.
//
// But the hole the review went looking for is REAL and was unguarded. A
// SUCCESSFUL search that returns an empty result set — Microsoft's search index
// lagging, a scope edited into matching nothing, or a projection that drops
// every hit — lands on the `gap.length === 0` branch and RESOLVES the anomaly
// with "Every document in scope is being watched (0 of 0)". That is a cheerful
// all-clear assembled from nothing, and it is indistinguishable, in the scan
// row and in the digest, from the genuinely healthy 11/11/0 that runs today.
//
// The contradiction is what makes it decidable without guessing: Vision was
// reading eleven live documents in the same sweep. "I can see zero documents"
// and "I am successfully reading eleven documents" cannot both be true.
describe('runReachabilityScan — a zero that contradicts the watched set is not an all-clear', () => {
  it('raises the CONTRADICTION instead of resolving to a quiet "gap 0"', async () => {
    // Search SUCCEEDS — no throw, no error, `truncated: false` — and returns
    // nothing, while eleven enabled, non-disappeared sources are on the books.
    store.sources = liveReachable().map((i) => source(i.driveId, i.id));

    const res = await runReachabilityScan(fakePrisma(), searchReturning([]), {
      now: NOW,
      scope: SCOPE,
    });

    // Phrased as a VERDICT for the same reason the 503 guard above is: the whole
    // risk is a failure that LOOKS like health, so the red has to show it looking
    // like health rather than printing `expected null not to be null`.
    const verdict =
      res.error === null
        ? `ALL-CLEAR: ${res.reachable} readable, ${res.watched} watched, gap ${res.gap.length}`
        : `CONTRADICTION: ${res.error}`;
    expect(verdict).toMatch(/^CONTRADICTION: /);

    // Persisted as a scan that CANNOT be trusted, not as a clean zero.
    expect(store.scans).toHaveLength(1);
    expect(store.scans[0]?.['error']).toMatch(/0 document/);

    // And the gap anomaly is NOT resolved. Resolving here would clear a standing
    // alert on the strength of a measurement that just proved itself unreliable.
    expect(store.resolved).toHaveLength(0);
    expect(store.anomalies).toHaveLength(1);
    expect(store.anomalies[0]?.kind).toBe('discovery_probe_contradiction');
  });

  it('stays QUIET when the zero is explainable — no live source contradicts it', async () => {
    // The legitimate empty tenant: nothing enabled, nothing undeleted. A zero
    // here contradicts nothing, and shouting would make the guard wallpaper.
    store.sources = [
      source(KELSEY, 'commodity', { enabled: false }),
      source(KELSEY, 'trailer', { disappeared_at: new Date('2026-08-01T00:00:00Z') }),
    ];

    const res = await runReachabilityScan(fakePrisma(), searchReturning([]), {
      now: NOW,
      scope: SCOPE,
    });

    expect(res.error).toBeNull();
    expect(res.reachable).toBe(0);
    expect(store.anomalies).toHaveLength(0);
    expect(store.resolved).toEqual([{ kind: 'discovery_gap', subject: REACHABILITY_SUBJECT }]);
  });

  it('tells the DIGEST the figure is unverified, rather than staying silent', async () => {
    const prisma = fakePrisma();
    store.sources = liveReachable().map((i) => source(i.driveId, i.id));
    await runReachabilityScan(prisma, searchReturning([]), { now: NOW, scope: SCOPE });

    // `gap_count` is 0 on this row, which is precisely the value the digest
    // treats as the one quiet case. It must branch on `error` FIRST.
    const line = await docIngestDiscoveryGapWarning(prisma, NOW);
    expect(line).not.toBeNull();
    expect(line).toMatch(/0 document/);
  });
});
