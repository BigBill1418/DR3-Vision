// ADR-0067 §3.2 D6/D7/D8 — the ingest path: idempotency, the content-side D8
// conditions (oversize, password-protected), and apply-vs-stage.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { ingestSource } from '../ingest';
import { raiseAnomaly } from '../anomalies';
import { DocIngestAccessDeniedError, DocIngestOversizeError, type DocIngestGraph } from '../graph';
import {
  makeFakePrisma,
  resetFakeIds,
  type FakeDocIngestPrisma,
} from '../__testutils__/fake-prisma';

vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true, outcome: 'sent' })) }));
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));

import { writeAudit } from '@/lib/audit';

const NOW = new Date('2026-07-29T12:00:00.000Z');

async function workbookBytes(rows: (string | number)[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const row of rows) ws.addRow(row);
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

function makeGraph(over: Partial<DocIngestGraph> = {}): DocIngestGraph {
  return {
    listSharedWithMe: async () => [],
    listChildren: async () => [],
    getItem: async () => {
      throw new Error('unused');
    },
    deltaForDrive: async () => ({ items: [], deltaLink: null }),
    downloadItem: async () => new Uint8Array([1]),
    createSubscription: async () => ({ id: 's', expirationDateTime: '', resource: '' }),
    renewSubscription: async () => ({ id: 's', expirationDateTime: '', resource: '' }),
    deleteSubscription: async () => undefined,
    ...over,
  };
}

let prisma: FakeDocIngestPrisma;
const p = () => prisma as unknown as never;
const putBytes = vi.fn(async () => 'r2/key');

beforeEach(() => {
  resetFakeIds();
  prisma = makeFakePrisma();
  putBytes.mockClear();
  vi.mocked(writeAudit).mockClear();
});

async function seedSource(over: Record<string, unknown> = {}) {
  return (await prisma.docSource.create({
    data: {
      drive_id: 'drive-A',
      item_id: 'item-1',
      display_name: 'Daily Log.xlsm',
      ctag: 'ctag-1',
      doc_class: 'daily_log_workbook',
      ...over,
    },
  })) as unknown as Parameters<typeof ingestSource>[2];
}

const openAnomalies = (kind?: string) =>
  prisma._stores.anomalies.filter(
    (a) => a['status'] === 'open' && (kind === undefined || a['kind'] === kind),
  );

describe('ingestSource — idempotency', () => {
  it('is a NO-OP when the ctag is unchanged (a re-delivered notification costs nothing)', async () => {
    const source = await seedSource();
    const download = vi.fn(async () => workbookBytes([['Units'], [1]]));
    const graph = makeGraph({ downloadItem: download });

    const first = await ingestSource(p(), graph, source, { now: NOW, putBytes });
    expect(first.outcome).toBe('applied');
    expect(download).toHaveBeenCalledTimes(1);

    const second = await ingestSource(p(), graph, source, { now: NOW, putBytes });
    expect(second.outcome).toBe('unchanged');
    // The whole point: no second download, no second version, no second drop.
    expect(download).toHaveBeenCalledTimes(1);
    expect(prisma._stores.versions).toHaveLength(1);
    expect(prisma._stores.fileDrops).toHaveLength(1);
  });

  // ── REGRESSION 2026-08-12 (ADR-0098 §3) — a healed download that never clears ──
  //
  // ADR-0095 moved the `download_failed` resolve ABOVE the guardrail branch so a
  // recovered source whose revision merely STAGED would still clear. It did not
  // go far enough: the resolve still sits below the `unchanged` early return,
  // which is the path almost every sweep takes. So a source that 503'd once and
  // then downloaded cleanly kept an OPEN `download_failed` row for as long as its
  // content did not change again — re-paging every 24h about a failure that
  // healed in fifteen minutes.
  //
  // Measured live on TEREX.xlsx: Graph 503'd at 16:58 PT on 2026-08-11, the 17:13
  // sweep archived the file cleanly, and the row was still open at 22:00 PT
  // because the ctag had not moved since.
  //
  // "My copy is current and archived" is a STRONGER statement than "a download
  // succeeded", so the unchanged path is entitled to clear it.
  it('clears an open `download_failed` on the UNCHANGED path — a current copy is proof', async () => {
    const source = await seedSource();
    const graph = makeGraph({ downloadItem: async () => workbookBytes([['Units'], [1]]) });

    // Sweep 1 ingests cleanly.
    await ingestSource(p(), graph, source, { now: NOW, putBytes });

    // A later 503 opens a download_failed against this source.
    await raiseAnomaly(p(), {
      kind: 'download_failed',
      subject: 'drive-A:item-1',
      docSourceId: source.id,
      detail: 'graph 503',
      now: NOW,
    });
    expect(openAnomalies('download_failed')).toHaveLength(1);

    // Sweep 2: content has not changed, so this returns `unchanged` without
    // downloading. Under the pre-ADR-0098 code the row stayed open forever.
    const result = await ingestSource(p(), graph, source, { now: NOW, putBytes });

    expect(result.outcome).toBe('unchanged');
    expect(openAnomalies('download_failed')).toHaveLength(0);
    // Resolved, not deleted — the history is the evidence it happened.
    expect(
      prisma._stores.anomalies.filter(
        (a) => a['kind'] === 'download_failed' && a['status'] === 'resolved',
      ),
    ).toHaveLength(1);
  });

  it('does NOT clear `download_failed` when the current revision was never archived', async () => {
    // r2_key is null when the archive write failed. `applyVersion` raises
    // download_failed for exactly that, so clearing it here would put the two in
    // a resolve/raise loop — and the claim "I hold this document" would be false.
    const source = await seedSource();
    const graph = makeGraph({ downloadItem: async () => workbookBytes([['Units'], [1]]) });
    const failingPut = vi.fn(async () => {
      throw new Error('r2 unavailable');
    });

    await ingestSource(p(), graph, source, { now: NOW, putBytes: failingPut });
    expect(prisma._stores.versions[0]?.['r2_key']).toBeNull();

    const before = openAnomalies('download_failed').length;
    const result = await ingestSource(p(), graph, source, { now: NOW, putBytes: failingPut });

    expect(result.outcome).toBe('unchanged');
    expect(openAnomalies('download_failed')).toHaveLength(before);
    expect(before).toBeGreaterThan(0);
  });

  // ── REGRESSION 2026-07-29 — the silent permanent stop ─────────────────────
  // A missing ctag used to return `unchanged`, which is indistinguishable from
  // success. Combined with `applyDeltaItems` blanking the ctag on every delta
  // page (OneDrive for Business omits ctag from delta results), a document
  // stopped being ingested FOREVER while the sweep reported `ok`. Measured live:
  // `doc_sources.ctag` was NULL while the version row held the real marker.
  //
  // The correct behaviour for "I no longer know how to tell if this changed" is
  // to recover, and failing that to raise an alarm — never to report nothing to
  // do. These two tests are the ones that would have caught it.
  it('RECOVERS a missing ctag from Graph instead of silently stopping', async () => {
    const source = await seedSource({ ctag: null });
    const download = vi.fn(async () => workbookBytes([['Units'], [1]]));
    const graph = makeGraph({
      downloadItem: download,
      getItem: async () => ({
        id: 'item-1',
        driveId: 'drive-A',
        name: 'Daily Log.xlsm',
        isFolder: false,
        webUrl: null,
        ctag: 'ctag-recovered',
        etag: null,
        size: 10,
        contentType: null,
        lastModifiedAt: null,
        lastModifiedBy: null,
        ownerUpn: null,
        parentItemId: null,
        parentPath: null,
        deleted: false,
      }),
    });

    const result = await ingestSource(p(), graph, source, { now: NOW, putBytes });

    expect(result.outcome).toBe('applied');
    expect(download).toHaveBeenCalledTimes(1);
    // The recovered marker is persisted, so the NEXT sweep is a cheap no-op
    // rather than a re-download.
    expect(prisma._stores.sources[0]?.['ctag']).toBe('ctag-recovered');
  });

  it('raises an anomaly — never "unchanged" — when the marker cannot be recovered', async () => {
    const source = await seedSource({ ctag: null });
    const download = vi.fn(async () => new Uint8Array([1]));
    const graph = makeGraph({
      downloadItem: download,
      getItem: async () => {
        throw new Error('graph unavailable');
      },
    });

    const result = await ingestSource(p(), graph, source, { now: NOW, putBytes });

    // "unknown" must never be reported as "unchanged".
    expect(result.outcome).toBe('failed');
    expect(download).not.toHaveBeenCalled();
    const anomaly = openAnomalies('download_failed')[0];
    expect(anomaly).toBeDefined();
    expect(String(anomaly?.['detail'])).toContain('no content marker');
    expect(String(anomaly?.['detail'])).toContain('not "unchanged"');
  });
});

describe('ingestSource — the kill switch and folders', () => {
  it('skips a source Bill disabled', async () => {
    const source = await seedSource({ enabled: false });
    const download = vi.fn(async () => new Uint8Array([1]));
    const result = await ingestSource(p(), makeGraph({ downloadItem: download }), source, {
      now: NOW,
      putBytes,
    });
    expect(result.outcome).toBe('skipped_disabled');
    expect(download).not.toHaveBeenCalled();
  });

  it('skips a folder — a folder is a watched container, not a document', async () => {
    const source = await seedSource({ kind: 'folder' });
    const result = await ingestSource(p(), makeGraph(), source, { now: NOW, putBytes });
    expect(result.outcome).toBe('skipped_folder');
  });
});

describe('D8 — very large file', () => {
  it('PAGES rather than silently truncating, and latches so it is not re-downloaded forever', async () => {
    const source = await seedSource();
    const download = vi.fn(async () => {
      throw new DocIngestOversizeError(500_000_000, 104_857_600);
    });

    const result = await ingestSource(p(), makeGraph({ downloadItem: download }), source, {
      now: NOW,
      putBytes,
    });

    expect(result.outcome).toBe('failed');
    const anomaly = openAnomalies('oversize')[0];
    expect(anomaly).toBeDefined();
    // The reason truncation is refused, said out loud: a partial workbook parses
    // cleanly and produces wrong billing numbers.
    expect(String(anomaly?.['detail'])).toContain('NOT truncated');
    // Latched — a 500 MB re-download every 15 minutes is a self-inflicted outage.
    expect(prisma._stores.sources[0]?.['read_blocked_at']).toEqual(NOW);
    expect(prisma._stores.sources[0]?.['read_blocked_ctag']).toBe('ctag-1');
  });

  it('does not retry a latched source while the content is unchanged', async () => {
    const source = await seedSource({
      read_blocked_at: NOW,
      read_blocked_ctag: 'ctag-1',
      read_blocked_reason: 'too big',
    });
    const download = vi.fn(async () => new Uint8Array([1]));
    const result = await ingestSource(p(), makeGraph({ downloadItem: download }), source, {
      now: NOW,
      putBytes,
    });
    expect(result.outcome).toBe('skipped_read_blocked');
    expect(download).not.toHaveBeenCalled();
  });

  it('DOES try again once the content changes — a new ctag is a genuinely new file', async () => {
    const source = await seedSource({
      ctag: 'ctag-2',
      read_blocked_at: NOW,
      read_blocked_ctag: 'ctag-1',
    });
    const download = vi.fn(async () => workbookBytes([['Units'], [1]]));
    const result = await ingestSource(p(), makeGraph({ downloadItem: download }), source, {
      now: NOW,
      putBytes,
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('applied');
  });
});

describe('D8 — password-protected / unreadable', () => {
  const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);

  it('marks, pages, and DOES NOT retry in a loop', async () => {
    const source = await seedSource();
    const download = vi.fn(async () => OLE);

    const result = await ingestSource(p(), makeGraph({ downloadItem: download }), source, {
      now: NOW,
      putBytes,
    });

    expect(result.outcome).toBe('failed');
    const anomaly = openAnomalies('unreadable')[0];
    expect(anomaly).toBeDefined();
    expect(String(anomaly?.['detail'])).toContain('password-protected');
    expect(String(anomaly?.['detail'])).toContain('will not try again');
    expect(prisma._stores.sources[0]?.['read_blocked_at']).toEqual(NOW);

    // The loop that must not happen. Re-read the source first, exactly as the
    // sweep does on every run — the latch lives in the DATABASE, so a caller
    // holding a pre-latch snapshot is not what production ever passes in.
    const reread = (await prisma.docSource.findUnique({
      where: { id: source.id },
    })) as unknown as typeof source;
    const again = await ingestSource(p(), makeGraph({ downloadItem: download }), reread, {
      now: NOW,
      putBytes,
    });
    expect(again.outcome).toBe('skipped_read_blocked');
    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe('D8 — share revoked mid-ingest', () => {
  it('flips the source to access_denied and raises the matching anomaly', async () => {
    const source = await seedSource();
    const graph = makeGraph({
      downloadItem: async () => {
        throw new DocIngestAccessDeniedError('/drives/drive-A/items/item-1');
      },
    });

    const result = await ingestSource(p(), graph, source, { now: NOW, putBytes });

    expect(result.outcome).toBe('failed');
    expect(prisma._stores.sources[0]?.['state']).toBe('access_denied');
    expect(openAnomalies('access_denied')).toHaveLength(1);
  });
});

describe('D6 — auto-flow, and D7 — stage instead', () => {
  it('auto-applies a normal change and writes a FULL before/after audit row', async () => {
    const source = await seedSource();
    const graph = makeGraph({ downloadItem: async () => workbookBytes([['Units'], [10]]) });

    const result = await ingestSource(p(), graph, source, { now: NOW, putBytes });

    expect(result.outcome).toBe('applied');
    expect(prisma._stores.versions[0]?.['applied_at']).toEqual(NOW);
    // The file-drop is how an auto-applied revision becomes visible, tagged with
    // its provenance so /admin/file-drop can show where it came from.
    expect(prisma._stores.fileDrops[0]?.['ingest_source']).toBe('shared_file');
    expect(prisma._stores.fileDrops[0]?.['doc_source_id']).toBe(source.id);

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const audit = vi.mocked(writeAudit).mock.calls[0]?.[0];
    expect(audit?.table_name).toBe('doc_source_versions');
    expect(audit?.after).toMatchObject({ mode: 'auto' });
    // First revision: there is genuinely no "before", and that is recorded as
    // null rather than as an empty object pretending to be one.
    expect(audit?.before).toBeNull();
  });

  it('STAGES an abnormal change, leaves it unapplied, and raises the guardrail anomaly', async () => {
    const source = await seedSource();

    // Revision 1 establishes the baseline.
    await ingestSource(
      p(),
      makeGraph({ downloadItem: async () => workbookBytes([['Amount'], [1000]]) }),
      source,
      { now: NOW, putBytes },
    );

    // Revision 2 halves the total — well past $50 and 15%.
    const moved = { ...source, ctag: 'ctag-2' } as typeof source;
    const result = await ingestSource(
      p(),
      makeGraph({ downloadItem: async () => workbookBytes([['Amount'], [400]]) }),
      moved,
      { now: NOW, putBytes },
    );

    expect(result.outcome).toBe('staged');
    const staged = prisma._stores.versions.find((v) => v['ctag'] === 'ctag-2');
    expect(staged?.['staged']).toBe(true);
    // NOT applied — the numbers do not move until a human says so.
    expect(staged?.['applied_at']).toBeNull();
    expect(openAnomalies('aggregate_variance')).toHaveLength(1);
    // Exactly one drop: from revision 1 only.
    expect(prisma._stores.fileDrops).toHaveLength(1);
  });

  // ── ADR-0019.5 Am.1 — a stage must not hold a download failure open ───────
  //
  // TEREX.xlsx, 2026-08-11: Graph 503'd the content download at 16:58, the 17:13
  // sweep downloaded it cleanly, and the revision STAGED on an aggregate
  // variance. Because the `download_failed` resolve sat below the guardrail
  // branch, the anomaly stayed open on a source that was downloading perfectly —
  // and re-paged Bill every 24h for a failure that had already healed.
  it('clears download_failed when a recovered download STAGES rather than applies', async () => {
    const source = await seedSource();

    // Revision 1 establishes the baseline and downloads fine.
    await ingestSource(
      p(),
      makeGraph({ downloadItem: async () => workbookBytes([['Amount'], [1000]]) }),
      source,
      { now: NOW, putBytes },
    );

    // The download fails — exactly the Graph 503 TEREX hit.
    const failed = { ...source, ctag: 'ctag-2' } as typeof source;
    await ingestSource(
      p(),
      makeGraph({
        downloadItem: async () => {
          throw new Error('graph … → HTTP 503: service unavailable');
        },
      }),
      failed,
      { now: NOW, putBytes },
    );
    expect(openAnomalies('download_failed')).toHaveLength(1);

    // Next sweep: the download succeeds, but the content trips the guardrail so
    // the revision is staged rather than applied.
    const recovered = { ...source, ctag: 'ctag-3' } as typeof source;
    const result = await ingestSource(
      p(),
      makeGraph({ downloadItem: async () => workbookBytes([['Amount'], [400]]) }),
      recovered,
      { now: NOW, putBytes },
    );

    expect(result.outcome).toBe('staged');
    // The guardrail finding is real and stays open — a human must act on it.
    expect(openAnomalies('aggregate_variance')).toHaveLength(1);
    // But the DOWNLOAD is demonstrably working, so its anomaly must be closed.
    expect(openAnomalies('download_failed')).toHaveLength(0);
  });

  it('measures the next change against the last APPLIED revision, not a staged one', async () => {
    const source = await seedSource();
    await ingestSource(
      p(),
      makeGraph({ downloadItem: async () => workbookBytes([['Amount'], [1000]]) }),
      source,
      { now: NOW, putBytes },
    );
    // Staged, and deliberately never applied.
    await ingestSource(
      p(),
      makeGraph({ downloadItem: async () => workbookBytes([['Amount'], [400]]) }),
      { ...source, ctag: 'ctag-2' } as typeof source,
      { now: NOW, putBytes },
    );

    // Back to the original value. Against the APPLIED baseline (1000) this is a
    // no-change and must flow. If the staged 400 had become the baseline, this
    // would stage — letting a rejected revision silently become the new normal.
    const result = await ingestSource(
      p(),
      makeGraph({ downloadItem: async () => workbookBytes([['Amount'], [1000]]) }),
      { ...source, ctag: 'ctag-3' } as typeof source,
      { now: NOW, putBytes },
    );
    expect(result.outcome).toBe('applied');
  });

  it('still records the OBSERVATION when the R2 archive is unavailable', async () => {
    const source = await seedSource();
    const failingPut = vi.fn(async () => {
      throw new Error('R2 unreachable');
    });
    const result = await ingestSource(
      p(),
      makeGraph({ downloadItem: async () => workbookBytes([['Units'], [1]]) }),
      source,
      { now: NOW, putBytes: failingPut as unknown as typeof putBytes },
    );

    // Losing the observation because the evidence store blipped would be the
    // worse of the two failures by far.
    expect(result.outcome).toBe('applied');
    expect(prisma._stores.versions).toHaveLength(1);
    expect(prisma._stores.versions[0]?.['r2_key']).toBeNull();
  });
});
