// ADR-0069 — the absorption bridge's guards.
//
// Three of these tests exist because of a specific past defect class rather than
// for coverage:
//
//   - "never writes processed_units_daily" is the ONE-WRITER rule. workbook-sync
//     (ADR-0049) owns that table. A second writer would not fail loudly; it would
//     produce plausible numbers that disagree with the paper record, and the
//     disagreement would be found in payroll.
//   - "a zero raises an anomaly" is the silent-zero rule. Every previous defect in
//     this module was a zero or a null read as good news (a null ctag as
//     "unchanged", a missing baseline as "no variance", a failed archive as
//     "applied").
//   - "a NULL site refuses and does NOT latch" is hard rule #2 plus its recovery
//     path: refusing is only correct if confirming the site actually fixes it.

import { describe, it, expect, beforeEach } from 'vitest';
import type { PrismaClient, DocSource, DocSourceVersion } from '@prisma/client';
import type { ParsedWorkbook } from '@/lib/audit/workbook/parser';
import type { DailyProductionRow, DailyParseResult } from '@/lib/workbook-sync/daily-adapter';
import {
  makeFakePrisma,
  resetFakeIds,
  type FakeDocIngestPrisma,
} from '../__testutils__/fake-prisma';
import { absorbVersion, runAbsorptionPass, ABSORBABLE_KINDS } from '../absorb';
import { DOC_KINDS } from '../doc-kinds';

const SITE_ID = 'site-woodland';
const NOW = new Date('2026-07-30T12:00:00.000Z');

function makeSource(over: Partial<DocSource> = {}): DocSource {
  return {
    id: 'src-1',
    drive_id: 'drive-1',
    item_id: 'item-1',
    display_name: 'JULY 2026 DAILY LOG WOODLAND.xlsm',
    doc_class: 'daily_log_workbook',
    site_id: SITE_ID,
    enabled: true,
    ...over,
  } as unknown as DocSource;
}

function makeVersion(over: Partial<DocSourceVersion> = {}): DocSourceVersion {
  return {
    id: 'ver-1',
    doc_source_id: 'src-1',
    ctag: 'ctag-1',
    r2_key: 'file-drops/doc-source-src-1-abc/JULY.xlsm',
    applied_at: NOW,
    absorbed_at: null,
    absorption_rows: 0,
    ...over,
  } as unknown as DocSourceVersion;
}

const layoutStub = async (): Promise<ParsedWorkbook> =>
  ({
    templateGeneration: 'woodland_daily',
    sheetTypes: new Map([['Daily', 'daily_close']]),
  }) as unknown as ParsedWorkbook;

function rowsStub(rows: DailyProductionRow[], midEditCount = 0) {
  return async (): Promise<DailyParseResult> => ({
    rows,
    midEditCount,
    skipped: [],
    templateGeneration: 'woodland_daily',
    daysSeen: rows.length + midEditCount,
    failure: null,
  });
}

const DAY = (
  date: string,
  program: number,
  nonProgram = 0,
  saved: number | null = null,
): DailyProductionRow => ({
  productionDate: date,
  strippedProgram: program,
  strippedNonProgram: nonProgram,
  strippedNonProgramInferred: false,
  materialTicketNumber: 'M-000001',
  savedUnits: saved,
});

const deps = (rows: DailyProductionRow[], midEdit = 0) => ({
  getBytes: async (): Promise<Uint8Array> => new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  parseRows: rowsStub(rows, midEdit),
  parseLayout: layoutStub,
  now: NOW,
});

describe('absorbVersion (ADR-0069)', () => {
  let db: FakeDocIngestPrisma;
  let prisma: PrismaClient;

  beforeEach(() => {
    resetFakeIds();
    db = makeFakePrisma();
    prisma = db as unknown as PrismaClient;
    db._stores.sites.push({ id: SITE_ID, name: 'DR3 Woodland' });
    db._stores.versions.push(makeVersion() as unknown as Record<string, unknown>);
  });

  it('writes reference rows with provenance and NEVER touches processed_units_daily', async () => {
    const result = await absorbVersion(
      prisma,
      makeSource(),
      makeVersion(),
      deps([DAY('2026-07-01', 120, 8, 3), DAY('2026-07-02', 95.5, 0)]),
    );

    expect(result.outcome).toBe('absorbed');
    expect(result.datesCovered).toBe(2);
    // 2 metrics for the day without `saved_units`, 3 for the day with one.
    expect(result.rowsWritten).toBe(5);

    const refs = db._stores.referenceRows;
    expect(refs).toHaveLength(5);
    for (const r of refs) {
      expect(r['site_id']).toBe(SITE_ID);
      expect(r['doc_source_id']).toBe('src-1');
      expect(r['doc_source_version_id']).toBe('ver-1');
      expect(r['source_sheet']).toBe('daily');
    }

    // THE ONE-WRITER RULE. workbook-sync (ADR-0049) owns processed_units_daily.
    expect(db._stores.processedUnits).toHaveLength(0);

    const audit = db._stores.auditLogs.at(0);
    expect(audit?.['table_name']).toBe('doc_reference_rows');
    expect((audit?.['after'] as Record<string, unknown>)['reference_only']).toBe(true);
  });

  it('omits saved_units when the workbook states none (an absence is not a zero)', async () => {
    await absorbVersion(
      prisma,
      makeSource(),
      makeVersion(),
      deps([DAY('2026-07-01', 120, 8, null)]),
    );
    const metrics = db._stores.referenceRows.map((r) => r['metric']).sort();
    expect(metrics).toEqual(['stripped_non_program', 'stripped_program']);
  });

  it('raises absorption_empty on ZERO rows and never records a silent success', async () => {
    const result = await absorbVersion(prisma, makeSource(), makeVersion(), deps([], 4));

    expect(result.outcome).toBe('empty');
    expect(result.rowsWritten).toBe(0);
    expect(db._stores.referenceRows).toHaveLength(0);

    const anomaly = db._stores.anomalies.at(0);
    expect(anomaly?.['kind']).toBe('absorption_empty');
    expect(anomaly?.['status']).toBe('open');
    // The message must say what the parser SAW, or the next person re-derives it.
    expect(String(anomaly?.['detail'])).toContain('ZERO usable daily rows');
    expect(String(anomaly?.['detail'])).toContain('woodland_daily');

    // Terminal: latched so a 60 KB workbook is not re-downloaded every 15 minutes.
    const stored = db._stores.versions.find((v) => v['id'] === 'ver-1');
    expect(stored?.['absorbed_at']).toEqual(NOW);
    expect(stored?.['absorption_status']).toBe('empty');
  });

  it('REFUSES a NULL-site document loudly and does NOT latch, so confirming the site fixes it', async () => {
    const result = await absorbVersion(
      prisma,
      makeSource({ site_id: null }),
      makeVersion(),
      deps([DAY('2026-07-01', 120)]),
    );

    expect(result.outcome).toBe('refused_unclassified_site');
    expect(db._stores.referenceRows).toHaveLength(0);
    expect(db._stores.anomalies.at(0)?.['kind']).toBe('absorption_refused');

    // NOT latched — this is the recovery path. A latched refusal would need a new
    // ctag to clear, so confirming the site would appear to do nothing.
    const stored = db._stores.versions.find((v) => v['id'] === 'ver-1');
    expect(stored?.['absorbed_at']).toBeNull();
    expect(stored?.['absorption_status']).toBe('refused_unclassified_site');
  });

  it('absorbs on the retry once the site is confirmed, and resolves the refusal', async () => {
    await absorbVersion(
      prisma,
      makeSource({ site_id: null }),
      makeVersion(),
      deps([DAY('2026-07-01', 120)]),
    );
    expect(db._stores.anomalies.at(0)?.['status']).toBe('open');

    await absorbVersion(prisma, makeSource(), makeVersion(), deps([DAY('2026-07-01', 120)]));

    expect(db._stores.referenceRows).toHaveLength(2);
    expect(db._stores.anomalies.at(0)?.['status']).toBe('resolved');
  });

  it('re-absorbing one revision REPLACES its rows rather than accumulating them', async () => {
    await absorbVersion(prisma, makeSource(), makeVersion(), deps([DAY('2026-07-01', 120, 8)]));
    expect(db._stores.referenceRows).toHaveLength(2);

    await absorbVersion(prisma, makeSource(), makeVersion(), deps([DAY('2026-07-01', 130, 8)]));

    expect(db._stores.referenceRows).toHaveLength(2);
    const program = db._stores.referenceRows.find((r) => r['metric'] === 'stripped_program');
    expect(String(program?.['value'])).toBe('130');
  });

  it('records an unreadable archive as unreadable, not as an empty document', async () => {
    const result = await absorbVersion(prisma, makeSource(), makeVersion(), {
      ...deps([DAY('2026-07-01', 120)]),
      getBytes: async (): Promise<Uint8Array | null> => null,
    });

    expect(result.outcome).toBe('unreadable');
    expect(db._stores.anomalies.at(0)?.['kind']).toBe('absorption_empty');
    expect(String(db._stores.anomalies.at(0)?.['detail'])).toContain('archival storage');
  });

  it('is a quiet no-op for a kind with no extractor, and raises nothing', async () => {
    const result = await absorbVersion(
      prisma,
      makeSource({ doc_class: 'equipment_inventory' }),
      makeVersion(),
      deps([DAY('2026-07-01', 120)]),
    );

    expect(result.outcome).toBe('not_absorbable');
    expect(db._stores.anomalies).toHaveLength(0);
    expect(db._stores.referenceRows).toHaveLength(0);
  });

  it('the absorbable set is exactly the kinds with a real extractor — widening it is a deliberate act', () => {
    // WIDENED four times: Am.1 added `trailer_list`, Am.2 added
    // `terex_maintenance_log` (both 2026-07-31), ADR-0080 added
    // `commodity_audit_tracker` (2026-08-07), and ADR-0104 §D1 added
    // `outbound_weight_audit` + `facility_expense_log` (2026-08-15). This
    // assertion is a tripwire and it has fired on ALL FOUR changes, exactly as
    // intended. It stays exact rather than becoming a `toContain`: the point is
    // that adding a kind here without adding its extractor and its typed table
    // has to break a test.
    //
    // Each kind has its OWN extractor and its OWN table. There is deliberately no
    // shared "generic row" path — a generic extractor is how a trailer list ends
    // up in a daily-production table with a plausible-looking shape.
    expect([...ABSORBABLE_KINDS]).toEqual([
      'daily_log_workbook',
      'trailer_list',
      'terex_maintenance_log',
      'commodity_audit_tracker',
      'outbound_weight_audit',
      'facility_expense_log',
    ]);
  });

  it('the six ADR-0104 archive classes are registered but NOT absorbable', () => {
    // §D8. They exist in `DOC_KINDS` so the classifier stops re-proposing them
    // every sweep and so the confirm queue can ANSWER them — not so they can be
    // absorbed. `equipment_inventory` is the pre-existing member of that set and
    // is asserted alongside the five new ones so the rule reads as one rule.
    for (const kind of [
      'facility_journal',
      'meeting_notes_log',
      'admin_task_tracker',
      'analysis_workbook',
      'equipment_inventory',
      // Recognised so it can be REFUSED and redirected, never absorbed.
      'vendor_invoice',
    ]) {
      expect(DOC_KINDS).toContain(kind);
      expect(ABSORBABLE_KINDS.has(kind)).toBe(false);
    }
  });
});

// The sweep calls `runAbsorptionPass` inside a try/catch so a failing absorption
// can never fail a sweep that correctly captured every document. That is right for
// production and dangerous for tests: a pass whose QUERY does not work would be
// swallowed as a warning and look exactly like "nothing to absorb". So the queue is
// exercised directly here, where nothing catches anything.
describe('runAbsorptionPass (ADR-0069)', () => {
  let db: FakeDocIngestPrisma;
  let prisma: PrismaClient;

  beforeEach(() => {
    resetFakeIds();
    db = makeFakePrisma();
    prisma = db as unknown as PrismaClient;
    db._stores.sites.push({ id: SITE_ID, name: 'DR3 Woodland' });
  });

  function seedSource(id: string, over: Record<string, unknown> = {}): void {
    db._stores.sources.push({
      id,
      drive_id: 'drive-1',
      item_id: `item-${id}`,
      display_name: `${id}.xlsm`,
      doc_class: 'daily_log_workbook',
      site_id: SITE_ID,
      enabled: true,
      ...over,
    });
  }
  function seedVersion(id: string, sourceId: string, over: Record<string, unknown> = {}): void {
    db._stores.versions.push({
      id,
      doc_source_id: sourceId,
      ctag: `ctag-${id}`,
      r2_key: `file-drops/${id}/x.xlsm`,
      applied_at: NOW,
      absorbed_at: null,
      absorption_rows: 0,
      ...over,
    });
  }

  it('picks up applied, unabsorbed revisions of confirmed absorbable documents', async () => {
    seedSource('src-1');
    seedVersion('ver-1', 'src-1');

    const out = await runAbsorptionPass(prisma, deps([DAY('2026-07-01', 120, 8)]));

    expect(out.versionsConsidered).toBe(1);
    expect(out.absorbed).toBe(1);
    expect(out.rowsWritten).toBe(2);
    expect(db._stores.referenceRows).toHaveLength(2);
  });

  it('is self-backfilling and then latches — a second pass finds nothing to do', async () => {
    seedSource('src-1');
    seedVersion('ver-1', 'src-1');

    await runAbsorptionPass(prisma, deps([DAY('2026-07-01', 120)]));
    const second = await runAbsorptionPass(prisma, deps([DAY('2026-07-01', 120)]));

    expect(second.versionsConsidered).toBe(0);
    expect(db._stores.referenceRows).toHaveLength(2);
  });

  it('skips unconfirmed, non-absorbable, disabled and unapplied revisions', async () => {
    seedSource('src-unconfirmed', { doc_class: null });
    seedVersion('ver-a', 'src-unconfirmed');
    seedSource('src-equipment', { doc_class: 'equipment_inventory' });
    seedVersion('ver-b', 'src-equipment');
    seedSource('src-disabled', { enabled: false });
    seedVersion('ver-c', 'src-disabled');
    seedSource('src-staged');
    seedVersion('ver-d', 'src-staged', { applied_at: null });

    const out = await runAbsorptionPass(prisma, deps([DAY('2026-07-01', 120)]));

    expect(out.versionsConsidered).toBe(0);
    expect(db._stores.referenceRows).toHaveLength(0);
  });

  it('keeps a REFUSED revision in the queue so confirming the site is the whole fix', async () => {
    seedSource('src-1', { site_id: null });
    seedVersion('ver-1', 'src-1');

    const first = await runAbsorptionPass(prisma, deps([DAY('2026-07-01', 120)]));
    expect(first.refused).toBe(1);

    // Bill confirms the site on the queue.
    const source = db._stores.sources.find((s) => s['id'] === 'src-1');
    if (source) source['site_id'] = SITE_ID;

    const second = await runAbsorptionPass(prisma, deps([DAY('2026-07-01', 120)]));
    expect(second.absorbed).toBe(1);
    expect(db._stores.referenceRows).toHaveLength(2);
  });
});
