// ADR-0049 — sync-engine tests. Injected mock transport + fake Prisma (no tenant,
// no DB). Covers the test-plan lines: delta no-redownload, mid-edit retry,
// overwrite-with-audit, monthly rollover, cutover no-op, and 403 fail-soft.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => undefined) }));

import { publishNtfy } from '@/lib/ntfy';
import { runWorkbookSyncPoll } from './engine';
import {
  mockFilesTransport,
  buildFixtureWorkbookBytes,
  type MockFileSpec,
} from '@/lib/msgraph-files';
import { FakePrisma, dec } from './__tests__/fake-prisma';

const JUNE = () => new Date('2026-06-15T18:00:00Z'); // June (PDT)
const JUNE_FILE = 'JUNE 2026 DAILY LOG WOODLAND.xlsm';

async function juneFile(ctag = 'ctag-v1'): Promise<MockFileSpec> {
  return { id: 'f-june', name: JUNE_FILE, ctag, bytes: await buildFixtureWorkbookBytes() };
}

beforeEach(() => vi.clearAllMocks());

describe('runWorkbookSyncPoll', () => {
  it('first sync downloads, upserts clean days, and counts mid-edit rows (D3/D11)', async () => {
    const db = new FakePrisma();
    const source = db.seedSource();
    const transport = mockFilesTransport({ files: [await juneFile()] });

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });
    expect(res.sourcesPolled).toBe(1);
    const r = res.results[0]!;
    expect(r.status).toBe('ok');
    expect(r.changesDetected).toBe(true);
    expect(r.rowsUpserted).toBe(3);
    expect(r.rowsSkippedMidedit).toBe(1);
    expect(r.fileName).toBe(JUNE_FILE);
    expect(transport.downloadCount).toBe(1);
    // Ledger + source watermark updated.
    expect(db.syncRuns).toHaveLength(1);
    expect(source.last_file_ctag).toBe('ctag-v1');
  });

  it('re-poll with an unchanged cTag does NOT re-download (delta no-op, test-plan line 1)', async () => {
    const db = new FakePrisma();
    db.seedSource();
    const transport = mockFilesTransport({ files: [await juneFile('ctag-v1')] });
    await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });
    const afterFirst = transport.downloadCount;

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });
    const r = res.results[0]!;
    expect(r.changesDetected).toBe(false);
    expect(r.rowsUpserted).toBe(0);
    expect(transport.downloadCount).toBe(afterFirst); // no extra download
  });

  it('re-poll after an edit (new cTag) re-downloads and clears a previously mid-edit day (retry, test-plan line 3)', async () => {
    const db = new FakePrisma();
    db.seedSource();
    const transport = mockFilesTransport({ files: [await juneFile('ctag-v1')] });
    await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });

    // Kelsey fills in day 4 (was mid-edit) → new bytes + new ctag.
    const filled = await buildFixtureWorkbookBytes({
      daily: [
        {
          date: '2026-06-01',
          strippedProgram: 150,
          strippedNonProgram: 25,
          materialTicket: 'M-000401',
        },
        {
          date: '2026-06-02',
          strippedProgram: 175,
          strippedNonProgram: 12,
          materialTicket: 'M-000402',
        },
        {
          date: '2026-06-03',
          strippedProgram: 160,
          strippedNonProgram: 0,
          materialTicket: 'M-000403',
        },
        {
          date: '2026-06-04',
          strippedProgram: 145,
          strippedNonProgram: 5,
          materialTicket: 'M-000404',
        },
      ],
    });
    transport.setFile(JUNE_FILE, filled, 'ctag-v2');

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });
    const r = res.results[0]!;
    expect(r.changesDetected).toBe(true);
    expect(r.rowsSkippedMidedit).toBe(0);
    expect(r.rowsUpserted).toBe(1); // only day 4 is new; the other 3 agree
    expect(db.pud.some((p) => p.production_date.toISOString().startsWith('2026-06-04'))).toBe(true);
  });

  it('overwrites a Vision-captured day with an audit entry (test-plan line 4)', async () => {
    const db = new FakePrisma();
    const source = db.seedSource();
    // A manual close for 6/1 that disagrees with the workbook (150).
    db.pud.push({
      id: 'pud-manual',
      site_id: source.site_id,
      production_date: new Date('2026-06-01T00:00:00Z'),
      source: 'manual',
      stripped_program: dec(999),
      stripped_non_program: dec(25),
      material_ticket_number: 'M-000401',
      employees_count: 6,
      processors_count: 4,
      saved_units: null,
      import_id: null,
      closed_at: null,
    });
    const transport = mockFilesTransport({ files: [await juneFile()] });

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });
    expect(res.results[0]!.rowsOverwritten).toBe(1);
    const overwriteAudit = db.audits.find(
      (a) => (a.before as { vision_overwrite?: boolean })?.vision_overwrite === true,
    );
    expect(overwriteAudit).toBeDefined();
  });

  it('rolls over to the August file on 8/1 without a config change (test-plan line 5)', async () => {
    const db = new FakePrisma();
    db.seedSource();
    const aug: MockFileSpec = {
      id: 'f-aug',
      name: 'AUGUST 2026 DAILY LOG WOODLAND.xlsm',
      ctag: 'aug-1',
      bytes: await buildFixtureWorkbookBytes(),
    };
    const transport = mockFilesTransport({ files: [aug] });

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: () => new Date('2026-08-05T18:00:00Z'),
    });
    const r = res.results[0]!;
    expect(r.fileName).toBe('AUGUST 2026 DAILY LOG WOODLAND.xlsm');
    expect(r.status).toBe('ok');
    expect(r.changesDetected).toBe(true);
  });

  it('is a NO-OP after cutover (surface live) — reads its own data, does not download (test-plan lines 6/7)', async () => {
    const db = new FakePrisma();
    const source = db.seedSource();
    db.surfaces.push({
      surface_code: 'workbook_sync',
      site_id: source.site_id,
      kind: 'workbook_sync',
      rollout_state: 'live',
    });
    const transport = mockFilesTransport({ files: [await juneFile()] });

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });
    const r = res.results[0]!;
    expect(r.cutoverNoop).toBe(true);
    expect(r.status).toBe('ok');
    expect(r.rowsUpserted).toBe(0);
    expect(transport.downloadCount).toBe(0);
    expect(db.syncRuns[0]).toMatchObject({ cutover_noop: true });
  });

  it('fails soft on a missing Files.Read.All grant (403): status forbidden, ntfy fired, no throw (test-plan line 8)', async () => {
    const db = new FakePrisma();
    db.seedSource();
    const transport = mockFilesTransport({ forbidden: true });

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });
    const r = res.results[0]!;
    expect(r.status).toBe('forbidden');
    expect(db.syncRuns[0]).toMatchObject({ status: 'forbidden' });
    expect(publishNtfy).toHaveBeenCalledOnce();
  });

  it('skips a not-yet-created new-month file (not_found), no throw', async () => {
    const db = new FakePrisma();
    db.seedSource();
    const transport = mockFilesTransport({ files: [] });
    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });
    expect(res.results[0]!.status).toBe('not_found');
  });

  it('does not poll a disabled (is_syncing=false) source', async () => {
    const db = new FakePrisma();
    db.seedSource({ is_syncing: false });
    const transport = mockFilesTransport({ files: [await juneFile()] });
    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });
    expect(res.sourcesPolled).toBe(0);
    expect(transport.downloadCount).toBe(0);
  });
});

// ── The guard that stops an UNREADABLE workbook looking like a clean run ────

describe('a workbook the adapter cannot read must FAIL the run, not report ok/0', () => {
  it('records status=error + the reason on the ledger, writes nothing, and does not advance the watermark', async () => {
    const db = new FakePrisma();
    const source = db.seedSource();
    // The Processed tab is gone: the file has content but no resolvable
    // daily-close layout. Zero rows here means "cannot read".
    const bytes = await buildFixtureWorkbookBytes({
      daily: [{ date: '2026-06-01', strippedProgram: 150, strippedNonProgram: 25 }],
      omitProcessedSheet: true,
    });
    const transport = mockFilesTransport({
      files: [{ id: 'f-june', name: JUNE_FILE, ctag: 'ctag-v1', bytes }],
    });

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });

    const r = res.results[0]!;
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/daily_section_unresolved/);
    expect(r.rowsUpserted).toBe(0);
    expect(db.pud).toHaveLength(0);
    // The ledger carries the reason — this is the whole point of the refusal.
    expect(db.syncRuns[0]).toMatchObject({ status: 'error' });
    expect(String(db.syncRuns[0]!['error_text'])).toMatch(/"cannot read", not "no production"/);
    // NOT marked as processed: the next poll re-reads the same file.
    expect(source.last_file_ctag).toBeNull();
    expect(publishNtfy).toHaveBeenCalledOnce();
  });

  it('refuses a workbook belonging to ANOTHER site (wrong-workbook cross-check)', async () => {
    const db = new FakePrisma();
    db.seedSource();
    db.sourceRows.push({
      id: 'src-far',
      site_id: 'site-elsewhere',
      name: 'Bass Hill Landfill',
      is_non_program: false,
      state: null,
      site: null,
      aliases: [],
    });
    const transport = mockFilesTransport({ files: [await juneFile()] });

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });

    const r = res.results[0]!;
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/wrong_site/);
    expect(db.pud).toHaveLength(0);
  });

  it('an EMPTY month is a clean run of zero rows — not an error', async () => {
    const db = new FakePrisma();
    db.seedSource();
    const bytes = await buildFixtureWorkbookBytes({ daily: [], month: '2026-06' });
    const transport = mockFilesTransport({
      files: [{ id: 'f-june', name: JUNE_FILE, ctag: 'ctag-v1', bytes }],
    });

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      allowNonGraphWrites: true,
      now: JUNE,
    });

    const r = res.results[0]!;
    expect(r.status).toBe('ok');
    expect(r.error).toBeNull();
    expect(r.rowsUpserted).toBe(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});

// ── The guard that stops a fixture reaching production ──────────────────────

describe('a non-graph transport must never write production', () => {
  it('REFUSES to upsert when the transport is the fixture mock', async () => {
    // `selectFilesTransport` silently falls back to the fixture mock whenever the
    // MSGRAPH_* creds are absent. Before this guard the write step ran anyway, so
    // a rotated secret would have written the June-Woodland FIXTURE over real
    // production figures under workbook-wins — with the run ledger saying `ok`.
    //
    // Note this test does NOT pass `allowNonGraphWrites`, i.e. it runs exactly the
    // way the production cron does.
    const db = new FakePrisma();
    db.seedSource();
    const transport = mockFilesTransport({ files: [await juneFile()] });

    const res = await runWorkbookSyncPoll({
      prisma: db.asClient(),
      transport,
      now: JUNE,
    });

    const one = res.results[0];
    expect(one?.status).toBe('error');
    expect(String(one?.error)).toMatch(/refusing to upsert/i);
    // The whole point: nothing was written.
    expect(one?.rowsUpserted ?? 0).toBe(0);
    expect(one?.rowsOverwritten ?? 0).toBe(0);
  });
});
