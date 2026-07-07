// ADR-0048 D3 — Terex import. The load-bearing behaviors: flexible header
// detection (date required, else typed error), downtime-vs-note mapping, the
// (site, event_date, kind, note-hash) idempotency skip, the re-upload no-op
// (source_sha256), and loud typed failure on an unrecognized shape.

import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  detectHeaderMapping,
  rowsToEvents,
  parseFlexibleDate,
  noteHash,
  importTerexHistory,
  TerexParseError,
  type TerexHeaderMapping,
} from './import';

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
});

const MAP: TerexHeaderMapping = { date: 'Date', notes: 'Notes', hours: 'Hours', downtime: 'Downtime', vendor: null };

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
    const evs = rowsToEvents([{ Date: '2026-06-03', Notes: 'x', Hours: 1 }], { ...MAP, downtime: null });
    expect(evs[0]?.kind).toBe('downtime');
    expect(evs[0]?.hoursDown).toBe(1);
  });
  it('skips fully blank rows but throws on a content row with an unparseable date', () => {
    const evs = rowsToEvents([{ Date: null, Notes: null, Hours: null, Downtime: null }], MAP);
    expect(evs).toHaveLength(0);
    expect(() => rowsToEvents([{ Date: 'garbage', Notes: 'has content', Hours: null, Downtime: null }], MAP)).toThrow(
      TerexParseError,
    );
  });
});

// ── In-memory fake prisma ────────────────────────────────────────────────
function makeDb(preload?: { imports?: Record<string, unknown>[]; events?: Record<string, unknown>[] }) {
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
      findMany: async ({ where }: { where: { site_id: string; event_date: { gte: Date; lte: Date } } }) =>
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
  (client as unknown as { $transaction: (fn: (tx: unknown) => unknown) => unknown }).$transaction = (fn) => fn(client);
  return { db: client, imports, events, audits };
}

// A tiny CSV Terex history (parsed via papaparse — no exceljs needed).
const CSV = ['Date,Notes,Hours,Downtime', '2026-06-03,belt replaced,2.5,yes', '2026-06-04,ran 340 units,,no'].join('\n');
function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('importTerexHistory', () => {
  it('imports CSV rows into equipment_events (source=import, import_id, one audit row)', async () => {
    const { db, events, audits } = makeDb();
    const res = await importTerexHistory({ db, siteId: 's1', filename: 'terex.csv', buffer: bytes(CSV), importedByUserId: 'u1' });
    expect(res.imported).toBe(true);
    expect(res.created).toBe(2);
    expect(res.skipped).toBe(0);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e['source'] === 'import' && e['import_id'] === res.batchId)).toBe(true);
    expect(events.find((e) => e['kind'] === 'downtime')?.['hours_down']).toBe(2.5);
    expect(audits).toHaveLength(1);
  });

  it('re-uploading the identical file is a no-op (source_sha256)', async () => {
    const { db, events } = makeDb();
    await importTerexHistory({ db, siteId: 's1', filename: 'terex.csv', buffer: bytes(CSV), importedByUserId: 'u1' });
    const again = await importTerexHistory({ db, siteId: 's1', filename: 'terex.csv', buffer: bytes(CSV), importedByUserId: 'u1' });
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
    const res = await importTerexHistory({ db, siteId: 's1', filename: 'terex2.csv', buffer: bytes(CSV + '\n'), importedByUserId: 'u1' });
    expect(res.skipped).toBe(1); // the note row already existed
    expect(res.created).toBe(1); // only the downtime row is new
    expect(events).toHaveLength(2); // 1 preloaded + 1 newly created
  });

  it('note-hash is stable across whitespace/case', () => {
    expect(noteHash('note', '  Ran 340   UNITS ')).toBe(noteHash('note', 'ran 340 units'));
  });
});
