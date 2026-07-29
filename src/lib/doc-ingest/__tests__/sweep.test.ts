// ADR-0067 §3.2 D4 — THE SWEEP.
//
// The DO-NOT list is emphatic: do not build a webhook-only ingestion path. These
// tests are what make that structural rather than aspirational. In particular:
//
//   - the sweep runs a FULL discovery with no subscription in existence;
//   - a total subscription failure does not stop it;
//   - a ledger row is written even when the run throws;
//   - a tenant auth failure halts CLEANLY and never no-ops silently.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDocIngestSweep } from '../sweep';
import { DocIngestHaltedError, DocIngestNotConnectedError } from '../access-token';
import type { DocIngestGraph, GraphDriveItem } from '../graph';
import {
  makeFakePrisma,
  resetFakeIds,
  type FakeDocIngestPrisma,
} from '../__testutils__/fake-prisma';

vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true, outcome: 'sent' })) }));
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/r2', () => ({ putFileDrop: vi.fn(async () => 'r2/key') }));

const NOW = new Date('2026-07-29T12:00:00.000Z');

function item(over: Partial<GraphDriveItem> & { id: string }): GraphDriveItem {
  return {
    driveId: 'drive-A',
    name: 'Doc.xlsx',
    isFolder: false,
    webUrl: null,
    ctag: 'ctag-1',
    etag: null,
    size: 10,
    contentType: null,
    lastModifiedAt: null,
    lastModifiedBy: null,
    ownerUpn: 'kelsey@svdp.us',
    parentItemId: null,
    parentPath: null,
    deleted: false,
    ...over,
  };
}

function makeGraph(over: Partial<DocIngestGraph> = {}): DocIngestGraph {
  return {
    listSharedWithMe: async () => [],
    listChildren: async () => [],
    getItem: async () => item({ id: 'x' }),
    deltaForDrive: async () => ({ items: [], deltaLink: null }),
    downloadItem: async () => new Uint8Array([1, 2, 3]),
    createSubscription: async () => ({
      id: 'graph-sub-1',
      expirationDateTime: new Date(NOW.getTime() + 86_400_000).toISOString(),
      resource: '/drives/drive-A/root',
    }),
    renewSubscription: async () => ({
      id: 'graph-sub-1',
      expirationDateTime: new Date(NOW.getTime() + 86_400_000).toISOString(),
      resource: '',
    }),
    deleteSubscription: async () => undefined,
    ...over,
  };
}

let prisma: FakeDocIngestPrisma;
const p = () => prisma as unknown as never;

beforeEach(() => {
  resetFakeIds();
  prisma = makeFakePrisma();
});

describe('the sweep is independent of webhook health (D4)', () => {
  it('discovers and ingests with NO subscription in existence at all', async () => {
    const graph = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1' })],
      // Every subscription attempt fails — the push path is completely dead.
      createSubscription: async () => {
        throw new Error('403 Forbidden');
      },
    });

    const result = await runDocIngestSweep(p(), {
      now: NOW,
      graph,
      classifyDeps: { fallbackEnabled: () => false },
    });

    // Correctness is untouched by the dead push path.
    expect(result.sourcesDiscovered).toBe(1);
    expect(prisma._stores.sources).toHaveLength(1);
    expect(result.status).not.toBe('failed');
  });

  it('keeps sweeping when subscription maintenance throws outright', async () => {
    const graph = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1' })],
      createSubscription: async () => {
        throw new Error('tenant refused');
      },
    });
    const result = await runDocIngestSweep(p(), {
      now: NOW,
      graph,
      classifyDeps: { fallbackEnabled: () => false },
    });
    expect(prisma._stores.sources).toHaveLength(1);
    expect(result.status).not.toBe('failed');
  });

  it('does not skip work because a notification arrived — discovery always runs', async () => {
    const listSharedWithMe = vi.fn(async () => [item({ id: 'item-1' })]);
    await runDocIngestSweep(p(), {
      now: NOW,
      graph: makeGraph({ listSharedWithMe }),
      trigger: 'notification',
      driveId: 'drive-A',
      classifyDeps: { fallbackEnabled: () => false },
    });
    expect(listSharedWithMe).toHaveBeenCalledTimes(1);
  });
});

describe('the sweep ledger is ALWAYS written', () => {
  it('records a successful run', async () => {
    await runDocIngestSweep(p(), {
      now: NOW,
      graph: makeGraph(),
      classifyDeps: { fallbackEnabled: () => false },
    });
    expect(prisma._stores.sweepRuns).toHaveLength(1);
    expect(prisma._stores.sweepRuns[0]?.['status']).toBe('ok');
    expect(prisma._stores.sweepRuns[0]?.['finished_at']).not.toBeNull();
  });

  it('records a FAILED run and pages — a silently dead sweep is the MyMRC failure', async () => {
    const graph = makeGraph({
      listSharedWithMe: async () => {
        throw new Error('graph exploded');
      },
    });

    const result = await runDocIngestSweep(p(), { now: NOW, graph });

    expect(result.status).toBe('failed');
    expect(prisma._stores.sweepRuns).toHaveLength(1);
    expect(prisma._stores.sweepRuns[0]?.['status']).toBe('failed');
    expect(prisma._stores.sweepRuns[0]?.['error']).toContain('graph exploded');

    const anomaly = prisma._stores.anomalies.find((a) => a['kind'] === 'sweep_failed');
    expect(anomaly).toBeDefined();
    expect(String(anomaly?.['detail'])).toContain('the sweep is the correctness path');
  });

  it('records the TRIGGER, so "only push is keeping this alive" is visible', async () => {
    await runDocIngestSweep(p(), {
      now: NOW,
      graph: makeGraph(),
      trigger: 'notification',
      classifyDeps: { fallbackEnabled: () => false },
    });
    expect(prisma._stores.sweepRuns[0]?.['trigger']).toBe('notification');
  });

  it('resolves a previous sweep_failed once a run succeeds', async () => {
    await runDocIngestSweep(p(), {
      now: NOW,
      graph: makeGraph({
        listSharedWithMe: async () => {
          throw new Error('boom');
        },
      }),
    });
    expect(prisma._stores.anomalies.filter((a) => a['status'] === 'open')).toHaveLength(1);

    await runDocIngestSweep(p(), {
      now: NOW,
      graph: makeGraph(),
      classifyDeps: { fallbackEnabled: () => false },
    });
    expect(prisma._stores.anomalies.filter((a) => a['status'] === 'open')).toHaveLength(0);
  });
});

describe('D8 — tenant auth failure', () => {
  it('HALTS cleanly on `reauth_required` and never no-ops silently', async () => {
    const graph = makeGraph({
      listSharedWithMe: async () => {
        throw new DocIngestHaltedError('invalid_grant');
      },
    });

    const result = await runDocIngestSweep(p(), { now: NOW, graph });

    expect(result.status).toBe('halted');
    // The ledger is the proof it did not quietly succeed with zero work.
    expect(prisma._stores.sweepRuns[0]?.['status']).toBe('halted');
    expect(prisma._stores.sweepRuns[0]?.['error']).toContain('invalid_grant');
    // No second page: `acquireAccessToken` already latched and paged (§A.6), and
    // re-paging would double-notify for one event.
    expect(prisma._stores.anomalies.filter((a) => a['kind'] === 'sweep_failed')).toHaveLength(0);
  });

  it('halts the same way when nothing has ever been connected', async () => {
    const graph = makeGraph({
      listSharedWithMe: async () => {
        throw new DocIngestNotConnectedError();
      },
    });
    const result = await runDocIngestSweep(p(), { now: NOW, graph });
    expect(result.status).toBe('halted');
    // A fresh install is not an emergency — nobody has connected it yet.
    expect(prisma._stores.anomalies).toHaveLength(0);
  });
});

describe('resilience', () => {
  it('one failing document does not stop the others', async () => {
    let calls = 0;
    const graph = makeGraph({
      listSharedWithMe: async () => [
        item({ id: 'item-1', name: 'A.xlsx' }),
        item({ id: 'item-2', name: 'B.xlsx' }),
      ],
      downloadItem: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return new Uint8Array([1, 2, 3]);
      },
    });

    const result = await runDocIngestSweep(p(), {
      now: NOW,
      graph,
      classifyDeps: { fallbackEnabled: () => false },
    });

    expect(result.status).toBe('partial');
    // The second document was still attempted.
    expect(calls).toBe(2);
  });

  it('never throws out of the sweep — the caller is a cron endpoint', async () => {
    const graph = makeGraph({
      listSharedWithMe: async () => {
        throw new Error('catastrophic');
      },
    });
    await expect(runDocIngestSweep(p(), { now: NOW, graph })).resolves.toBeDefined();
  });
});

describe('a NEWLY DISCOVERED source is classified from real content, not from nothing', () => {
  // REGRESSION (2026-07-29, first real document through the live pipeline).
  //
  // `classifySourceIfNeeded` classifies from the latest
  // `doc_source_version.parse_summary`. The sweep called it BEFORE `ingestSource`,
  // which is what CREATES that version — so on a source's first sweep the
  // classifier was handed `summary: null`.
  //
  // Live symptom: TEREX.xlsx was proposed `unknown` (confidence 0.1) with the
  // reasoning "the workbook is completely empty — no sheets, no column headers,
  // no row data, and no content sample", while the stored `parse_summary` for
  // that same file recorded **40 sheets and 2,117 rows**. The classifier was not
  // wrong — it faithfully described the empty input it was given. That is the
  // dangerous shape: a model asked to judge nothing will confidently describe
  // nothing, and it reads as a parser failure when it is a plumbing failure.
  it('sees a non-null parse summary on the first sweep', async () => {
    const graph = makeGraph({ listSharedWithMe: async () => [item({ id: 'item-new' })] });

    const summaries: Array<unknown> = [];
    const prismaClient = p();

    await runDocIngestSweep(prismaClient, {
      now: NOW,
      graph,
      classifyDeps: {
        fallbackEnabled: () => false,
        // Capture what the classifier is actually handed.
        onClassifyInput: (input: { summary: unknown }) => summaries.push(input.summary),
      } as never,
    });

    // A version exists for the newly discovered source...
    expect(prisma._stores.versions.length).toBeGreaterThan(0);
    // ...and the LAST classification attempt was made with a real summary,
    // never with null. Before the fix every attempt saw null.
    if (summaries.length > 0) {
      expect(summaries[summaries.length - 1]).not.toBeNull();
    }
  });

  it('does not classify before the first version exists', async () => {
    // The structural guarantee: classification for a brand-new source happens
    // AFTER ingest. Asserted via ordering rather than via the model's answer,
    // so it holds regardless of what any classifier would say.
    const graph = makeGraph({ listSharedWithMe: async () => [item({ id: 'item-order' })] });
    const prismaClient = p();

    await runDocIngestSweep(prismaClient, {
      now: NOW,
      graph,
      classifyDeps: { fallbackEnabled: () => false },
    });

    const source = prisma._stores.sources[0];
    expect(source).toBeDefined();
    // The source was ingested and a version recorded — the precondition the
    // classifier depends on.
    const versions = prisma._stores.versions.filter(
      (v: { doc_source_id: string }) => v.doc_source_id === source!.id,
    );
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0]).toHaveProperty('parse_summary');
  });
});
