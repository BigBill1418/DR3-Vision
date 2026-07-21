// ADR-0048 D3 — Terex import. The load-bearing behaviors: flexible header
// detection (date required, else typed error), downtime-vs-note mapping, the
// (site, event_date, kind, note-hash) idempotency skip, the re-upload no-op
// (source_sha256), and loud typed failure on an unrecognized shape.

import { describe, it, expect, beforeAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  detectHeaderMapping,
  rowsToEvents,
  parseFlexibleDate,
  noteHash,
  importTerexHistory,
  parseMaintenanceLogSheet,
  isMaintenanceLogSheetName,
  TerexParseError,
  type TerexHeaderMapping,
} from './import';
import {
  buildTerexWorkbook,
  buildNoLogSheetWorkbook,
  FIXTURE_LOG_2025_COUNT,
  FIXTURE_LOG_2026_COUNT,
} from './__fixtures__/build-terex-log';

describe('detectHeaderMapping', () => {
  it('detects date/hours/downtime/notes/vendor columns case-insensitively', () => {
    const m = detectHeaderMapping(['Date', 'Downtime?', 'Hours', 'Vendor', 'Notes']);
    expect(m.date).toBe('Date');
    expect(m.hours).toBe('Hours');
    expect(m.downtime).toBe('Downtime?');
    expect(m.notes).toBe('Notes');
    expect(m.vendor).toBe('Vendor');
  });
  it('falls back to the first spare column for notes when no notes header exists', () => {
    const m = detectHeaderMapping(['Day', 'Activity Log']);
    expect(m.date).toBe('Day');
    expect(m.notes).toBe('Activity Log');
  });
  it('throws a typed error when no date column can be found', () => {
    expect(() => detectHeaderMapping(['Widget', 'Gizmo'])).toThrow(TerexParseError);
  });
  it('throws on an empty header row', () => {
    expect(() => detectHeaderMapping([' ', ''])).toThrow(TerexParseError);
  });
});

describe('parseFlexibleDate', () => {
  it('parses ISO and US M/D/Y to UTC-midnight day keys', () => {
    expect(parseFlexibleDate('2026-06-15')?.getTime()).toBe(Date.UTC(2026, 5, 15));
    expect(parseFlexibleDate('6/15/2026')?.getTime()).toBe(Date.UTC(2026, 5, 15));
    expect(parseFlexibleDate('06/15/26')?.getTime()).toBe(Date.UTC(2026, 5, 15));
  });
  it('returns null for junk', () => {
    expect(parseFlexibleDate('not a date')).toBeNull();
    expect(parseFlexibleDate(null)).toBeNull();
  });
  it('rejects implausible dates outside [2000, 2100] (Excel-epoch 1900 artifacts, far-future strays)', () => {
    // The prod bug: a stray number in a date-FORMATTED cell surfaces as an
    // Excel-epoch Date. A real event date is never before 2000.
    expect(parseFlexibleDate(new Date(Date.UTC(1900, 0, 14)))).toBeNull();
    expect(parseFlexibleDate('1900-01-14')).toBeNull();
    expect(parseFlexibleDate('1/14/1900')).toBeNull();
    expect(parseFlexibleDate(new Date(Date.UTC(2200, 0, 1)))).toBeNull();
    // The plausible window boundaries still parse.
    expect(parseFlexibleDate('2000-01-01')?.getTime()).toBe(Date.UTC(2000, 0, 1));
    expect(parseFlexibleDate(new Date(Date.UTC(2026, 0, 15)))?.getTime()).toBe(Date.UTC(2026, 0, 15));
  });
});

const MAP: TerexHeaderMapping = {
  date: 'Date',
  notes: 'Notes',
  hours: 'Hours',
  downtime: 'Downtime',
  vendor: null,
};

describe('rowsToEvents', () => {
  it('maps a stated downtime to kind=downtime with hours, and a plain row to kind=note', () => {
    const evs = rowsToEvents(
      [
        { Date: '2026-06-03', Notes: 'belt replaced', Hours: 2.5, Downtime: 'yes' },
        { Date: '2026-06-04', Notes: 'ran 340 units', Hours: null, Downtime: 'no' },
      ],
      MAP,
    );
    expect(evs).toHaveLength(2);
    expect(evs[0]?.kind).toBe('downtime');
    expect(evs[0]?.hoursDown).toBe(2.5);
    expect(evs[1]?.kind).toBe('note');
    expect(evs[1]?.hoursDown).toBeNull();
  });
  it('treats positive hours alone as downtime even without a downtime flag column', () => {
    const evs = rowsToEvents([{ Date: '2026-06-03', Notes: 'x', Hours: 1 }], {
      ...MAP,
      downtime: null,
    });
    expect(evs[0]?.kind).toBe('downtime');
    expect(evs[0]?.hoursDown).toBe(1);
  });
  it('skips fully blank rows but throws on a content row with an unparseable date', () => {
    const evs = rowsToEvents([{ Date: null, Notes: null, Hours: null, Downtime: null }], MAP);
    expect(evs).toHaveLength(0);
    expect(() =>
      rowsToEvents([{ Date: 'garbage', Notes: 'has content', Hours: null, Downtime: null }], MAP),
    ).toThrow(TerexParseError);
  });
  it('stays STRICT: a content row with an Excel-epoch (1900) date is a hard error, not a stored 1900 event', () => {
    expect(() =>
      rowsToEvents(
        [{ Date: new Date(Date.UTC(1900, 0, 14)), Notes: 'has content', Hours: null, Downtime: null }],
        MAP,
      ),
    ).toThrow(TerexParseError);
  });
});

// ── In-memory fake prisma ────────────────────────────────────────────────
function makeDb(preload?: {
  imports?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
}) {
  const imports: Record<string, unknown>[] = preload?.imports ?? [];
  const events: Record<string, unknown>[] = preload?.events ?? [];
  const audits: unknown[] = [];
  let seq = 0;
  const id = () => `id-${++seq}`;

  const client = {
    equipmentHistoryImport: {
      findUnique: async ({ where }: { where: { source_sha256: string } }) =>
        imports.find((i) => i['source_sha256'] === where.source_sha256) ?? null,
      create: async ({ data, select }: { data: Record<string, unknown>; select?: unknown }) => {
        const r = { id: id(), events_created: 0, events_skipped: 0, ...data };
        imports.push(r);
        return select ? { id: r.id } : r;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = imports.find((i) => i['id'] === where.id)!;
        Object.assign(r, data);
        return r;
      },
    },
    equipmentEvent: {
      findMany: async ({
        where,
      }: {
        where: { site_id: string; event_date: { gte: Date; lte: Date } };
      }) =>
        events.filter(
          (e) =>
            e['site_id'] === where.site_id &&
            (e['event_date'] as Date).getTime() >= where.event_date.gte.getTime() &&
            (e['event_date'] as Date).getTime() <= where.event_date.lte.getTime(),
        ),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const r = { id: id(), ...data };
        events.push(r);
        return r;
      },
    },
    auditLog: { create: async ({ data }: { data: unknown }) => (audits.push(data), data) },
  } as unknown as PrismaClient;
  (client as unknown as { $transaction: (fn: (tx: unknown) => unknown) => unknown }).$transaction =
    (fn) => fn(client);
  return { db: client, imports, events, audits };
}

// A tiny CSV Terex history (parsed via papaparse — no exceljs needed).
const CSV = [
  'Date,Notes,Hours,Downtime',
  '2026-06-03,belt replaced,2.5,yes',
  '2026-06-04,ran 340 units,,no',
].join('\n');
function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('importTerexHistory', () => {
  it('imports CSV rows into equipment_events (source=import, import_id, one audit row)', async () => {
    const { db, events, audits } = makeDb();
    const res = await importTerexHistory({
      db,
      siteId: 's1',
      filename: 'terex.csv',
      buffer: bytes(CSV),
      importedByUserId: 'u1',
    });
    expect(res.imported).toBe(true);
    expect(res.created).toBe(2);
    expect(res.skipped).toBe(0);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e['source'] === 'import' && e['import_id'] === res.batchId)).toBe(
      true,
    );
    expect(events.find((e) => e['kind'] === 'downtime')?.['hours_down']).toBe(2.5);
    expect(audits).toHaveLength(1);
  });

  it('re-uploading the identical file is a no-op (source_sha256)', async () => {
    const { db, events } = makeDb();
    await importTerexHistory({
      db,
      siteId: 's1',
      filename: 'terex.csv',
      buffer: bytes(CSV),
      importedByUserId: 'u1',
    });
    const again = await importTerexHistory({
      db,
      siteId: 's1',
      filename: 'terex.csv',
      buffer: bytes(CSV),
      importedByUserId: 'u1',
    });
    expect(again.imported).toBe(false);
    expect(events).toHaveLength(2); // no duplicates
  });

  it('skips events already present by (site, date, kind, note-hash) on a different file', async () => {
    const preEvent = {
      id: 'pre-1',
      site_id: 's1',
      equipment_code: 'terex',
      event_date: new Date(Date.UTC(2026, 5, 4)),
      kind: 'note',
      notes: 'ran 340 units',
    };
    const { db, events } = makeDb({ events: [preEvent] });
    // Same content but a trailing newline → different file SHA, same event rows.
    const res = await importTerexHistory({
      db,
      siteId: 's1',
      filename: 'terex2.csv',
      buffer: bytes(CSV + '\n'),
      importedByUserId: 'u1',
    });
    expect(res.skipped).toBe(1); // the note row already existed
    expect(res.created).toBe(1); // only the downtime row is new
    expect(events).toHaveLength(2); // 1 preloaded + 1 newly created
  });

  it('note-hash is stable across whitespace/case', () => {
    expect(noteHash('note', '  Ran 340   UNITS ')).toBe(noteHash('note', 'ran 340 units'));
  });
});

// ── The real-file (multi-sheet maintenance-log) path (ADR-0048 D3 finalized) ──

describe('isMaintenanceLogSheetName', () => {
  it('recognizes the "Maintenance Log <year>" import targets (with or without a space)', () => {
    expect(isMaintenanceLogSheetName('Maintenance Log 2025')).toBe(true);
    expect(isMaintenanceLogSheetName('Maintenance Log2026')).toBe(true);
  });
  it('rejects the sheets that must be skipped', () => {
    expect(isMaintenanceLogSheetName('Maintenance Prices')).toBe(false);
    expect(isMaintenanceLogSheetName('diesel')).toBe(false);
    expect(isMaintenanceLogSheetName('Jan 2026')).toBe(false);
    expect(isMaintenanceLogSheetName('Feb26')).toBe(false);
    expect(isMaintenanceLogSheetName('OVERVIEW2026')).toBe(false);
  });
});

describe('parseMaintenanceLogSheet', () => {
  // The real file's shape, by column index: 0=colA (unlabeled), 1=Date, 2=Time,
  // 3=Issue, 4=Measures, 5=EstTime, 6=EstCost, 7=Notes, 8=ActualCost, 9=Credited.
  const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
  const HEADER = [
    null,
    'Date *',
    'Time  *',
    'Issue *',
    'Measures taken *',
    'Estimated repair time/cost',
    'Estimated cost',
    'Notes*',
    'Actual Repair Cost',
    'Amount Credited',
  ];

  it('parses real entries, mapping cost→repair, credit→note, and excludes every noise row', () => {
    const grid = [
      [null, 'TEREX MACHINE MAINTENANCE LOG'], // banner
      HEADER, // header row (asterisks, empty col A)
      ['example', 'October 10/9/2024', '11:52am', 'x', 'y'], // literal example row
      [2024, 'September'], // year marker + month separator
      [null, 'October'], // month separator
      [null, D(2024, 11, 11), null, 'belt worn', 'replaced belt'], // → maintenance, no cost
      [null, D(2024, 11, 21), null, 'shaft broken', 'new shaft', null, null, null, 4850], // → repair 485000c
      [null, D(2024, 11, 27), null, 'conveyor tearing', null, null, null, null, 1584.66], // → repair 158466c
      [null, D(2025, 1, 9), null, null, null, null, null, null, null, 1200], // credit-only → maintenance
      [null, null, null, null, null, null, null, null, 9999, 250], // subtotal (money, no date) → skip
      [null, D(2025, 1, 20)], // bare date, no content → skip
    ];
    const { candidates: evs, warnings } = parseMaintenanceLogSheet(grid, 'Maintenance Log 2025');

    expect(evs).toHaveLength(4);
    expect(warnings).toHaveLength(0);
    expect(evs.map((e) => e.kind)).toEqual(['maintenance', 'repair', 'repair', 'maintenance']);
    expect(evs.map((e) => e.costCents)).toEqual([null, 485000, 158466, null]);
    expect(evs.every((e) => e.hoursDown === null && e.vendor === null)).toBe(true);
    expect(evs[0]?.notes).toBe('belt worn — replaced belt');
    expect(evs[3]?.notes).toBe('Amount credited: $1200.00'); // credit preserved in the note
    // day keys are UTC-midnight
    expect(evs[1]?.eventDate.getTime()).toBe(Date.UTC(2024, 10, 21));
  });

  it('collects a content row with an Excel-epoch (1900) Date into warnings, not events', () => {
    const grid = [
      [null, 'TEREX MACHINE MAINTENANCE LOG'],
      HEADER,
      [null, D(2026, 2, 3), null, 'good row', 'fixed'], // real event
      // Date cell is an Excel-epoch artifact; real date is inside the issue text.
      [null, D(1900, 1, 14), null, 'hose shooting oil real date 01-15-2026', 'called vendor'],
      [null, 'March'], // bare separator (no content) → NOT warned
    ];
    const { candidates: evs, warnings } = parseMaintenanceLogSheet(grid, 'Maintenance Log 2026');

    expect(evs).toHaveLength(1); // only the good row becomes an event
    expect(evs[0]?.eventDate.getTime()).toBe(Date.UTC(2026, 1, 3));
    expect(warnings).toHaveLength(1); // the epoch-dated content row is surfaced, not stored
    expect(warnings[0]?.sheet).toBe('Maintenance Log 2026');
    expect(warnings[0]?.rowNumber).toBe(4); // 1-based
    expect(warnings[0]?.rawDate).toContain('1900');
    expect(warnings[0]?.preview).toContain('hose shooting oil');
    // No 1900 event was ever produced.
    expect(evs.some((e) => e.eventDate.getUTCFullYear() < 2000)).toBe(false);
  });

  it('throws a typed error on a maintenance-log sheet with no Date header', () => {
    expect(() =>
      parseMaintenanceLogSheet(
        [
          [null, 'TEREX MACHINE MAINTENANCE LOG'],
          ['x', 'y'],
        ],
        'Maintenance Log X',
      ),
    ).toThrow(TerexParseError);
  });
});

describe('importTerexHistory — real-shape xlsx fixture', () => {
  let workbook: Uint8Array;
  let noLog: Uint8Array;
  beforeAll(async () => {
    workbook = new Uint8Array((await buildTerexWorkbook()) as ArrayBuffer);
    noLog = new Uint8Array((await buildNoLogSheetWorkbook()) as ArrayBuffer);
  });

  it('imports every maintenance-log sheet, skips unrelated sheets, with correct per-sheet counts', async () => {
    const { db, events, audits } = makeDb();
    const res = await importTerexHistory({
      db,
      siteId: 's1',
      filename: 'terex.xlsx',
      buffer: workbook,
      importedByUserId: 'u1',
    });

    expect(res.imported).toBe(true);
    expect(res.created).toBe(FIXTURE_LOG_2025_COUNT + FIXTURE_LOG_2026_COUNT); // 5 + 3
    expect(res.skipped).toBe(0);
    // The Excel-epoch (1900) content row in the 2026 sheet is surfaced as a
    // warning, NOT imported as a garbage 1900 event.
    expect(res.rowsWarned).toBe(1);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]?.sheet).toBe('Maintenance Log 2026');
    expect(res.warnings[0]?.rawDate).toContain('1900');
    expect(res.warnings[0]?.preview).toContain('hose shooting oil');
    expect(res.sheets).toEqual([
      { sheet: 'Maintenance Log 2025', imported: FIXTURE_LOG_2025_COUNT },
      { sheet: 'Maintenance Log 2026', imported: FIXTURE_LOG_2026_COUNT },
    ]);
    expect(events).toHaveLength(8);
    // Not one stored event carries a sub-2000 (epoch-artifact) date.
    expect(events.every((e) => (e['event_date'] as Date).getUTCFullYear() >= 2000)).toBe(true);
    expect(events.every((e) => e['source'] === 'import' && e['import_id'] === res.batchId)).toBe(
      true,
    );
    // money column stored as cost_cents on the repair rows
    const costs = events
      .map((e) => e['cost_cents'])
      .filter((c) => c != null)
      .sort((a, b) => (a as number) - (b as number));
    expect(costs).toEqual([30000, 158466, 485000]);
    expect(events.filter((e) => e['kind'] === 'repair')).toHaveLength(3);
    expect(audits).toHaveLength(1); // one batch audit row
  });

  it('re-uploading the identical workbook is a no-op (source_sha256)', async () => {
    const { db, events } = makeDb();
    await importTerexHistory({
      db,
      siteId: 's1',
      filename: 'terex.xlsx',
      buffer: workbook,
      importedByUserId: 'u1',
    });
    const again = await importTerexHistory({
      db,
      siteId: 's1',
      filename: 'terex.xlsx',
      buffer: workbook,
      importedByUserId: 'u1',
    });
    expect(again.imported).toBe(false);
    expect(events).toHaveLength(8); // no duplicates
  });

  it('fails loud (typed 422) when the workbook has zero maintenance-log sheets', async () => {
    const { db } = makeDb();
    await expect(
      importTerexHistory({
        db,
        siteId: 's1',
        filename: 'notterex.xlsx',
        buffer: noLog,
        importedByUserId: 'u1',
      }),
    ).rejects.toBeInstanceOf(TerexParseError);
  });
});
