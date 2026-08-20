// ADR-0048 D1/D2 — promotion matrix. The load-bearing behaviors: the happy
// promotion (counts + source='import' + import_id stamped + one audit row per
// table), conflict-refusal (no partial promotion), the re-run no-op, the
// unresolved-source refusal, the scope clip, and the 4,062 close-balance live
// assertion (pass AND fail → commit refused). Fake-prisma idiom (the repo has no
// test Postgres): a small in-memory client that records inserts.

import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { inMemoryAliasResolver } from './workbook/site-alias';
import {
  promoteWorkbookImport,
  decodeStagingRows,
  computeCloseFromCandidates,
  assertPromotedInboundReconciles,
  PromotionConflictError,
  PromotionBalanceAssertionError,
  PromotionInboundReconciliationError,
  PromotionParseError,
  type StagingRowInput,
  type PromotionScope,
} from './workbook-promotion';

const SITE = 'site-woodland';
const IMPORT = 'imp-1';

// A promotion staging row: section selects the table; raw_value is the record JSON.
function row(section: string, record: Record<string, unknown>, siteName?: string, rc = 1): StagingRowInput {
  return {
    section,
    raw_value: JSON.stringify(record),
    numeric_value: null,
    site_name_raw: siteName ?? null,
    provenance: { tab: section, row: rc, col: 'A' },
  };
}

// The canonical Woodland June scenario that closes to exactly 4,062:
//   4000 (opening) + 100 (inbound) + 12 (dropoffs) − 30 (stripped) − 15 (reno) − 5 (landfilled) = 4062
function woodlandRows(): StagingRowInput[] {
  return [
    row('opening_inventory', { date: '2026-06-01', unitsIndoor: 4000 }),
    row('inbound', { date: '2026-06-03', units: 100, slipNumber: 'S-1', retracId: 'RT-1' }, 'Depot Alpha'),
    row('dropoff', { date: '2026-06-05', kind: 'incentive', personName: 'Jane Doe', units: 12, incentiveCents: 600 }),
    row('daily_close', { date: '2026-06-10', strippedProgram: 30, materialTicketNumber: 'M-1' }),
    row('outbound', { date: '2026-06-12', commodity: 'foam', subCategory: 'renovation', weightLbs: 900, wholeUnits: 15 }),
    row('outbound', { date: '2026-06-12', commodity: 'foam', subCategory: 'baled', weightLbs: 1200 }),
    row('landfilled', { date: '2026-06-20', units: 5, reason: 'bed_bug' }),
  ];
}

const RESOLVER = inMemoryAliasResolver({
  'Depot Alpha': { siteId: SITE, canonicalName: 'Depot Alpha', isNonProgram: false },
});

const SCOPE: PromotionScope = { siteId: SITE, from: '2026-06-01', to: '2026-06-30', expectedCloseTotal: 4062 };

// ── In-memory fake prisma ────────────────────────────────────────────────
interface Stores {
  snapshots: Record<string, unknown>[];
  processed: Record<string, unknown>[];
  inbound: Record<string, unknown>[];
  outbound: Record<string, unknown>[];
  landfilled: Record<string, unknown>[];
  dropoffs: Record<string, unknown>[];
  promotions: Record<string, unknown>[];
  audits: { table_name: string; row_id: string; after: unknown }[];
}

function inWindow(row: Record<string, unknown>, field: string, where: Record<string, unknown>): boolean {
  const w = where[field] as { gte?: Date; lte?: Date } | undefined;
  if (!w) return true;
  const t = (row[field] as Date).getTime();
  return (!w.gte || t >= w.gte.getTime()) && (!w.lte || t <= w.lte.getTime());
}
function liveOnly(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  if ('import_id' in where && where['import_id'] === null) return row['import_id'] == null;
  const s = where['source'] as { not?: string } | undefined;
  if (s && 'not' in s) return row['source'] !== s.not;
  return true;
}

function makeDb(staging: StagingRowInput[], preload?: Partial<Stores>): { db: PrismaClient; stores: Stores } {
  const stores: Stores = {
    snapshots: [],
    processed: [],
    inbound: [],
    outbound: [],
    landfilled: [],
    dropoffs: [],
    promotions: [],
    audits: [],
    ...preload,
  } as Stores;
  let seq = 0;
  const id = () => `id-${++seq}`;

  const finder =
    (arr: Record<string, unknown>[], dateField: string) =>
    async ({ where }: { where: Record<string, unknown> }) =>
      arr.filter(
        (r) => r['site_id'] === where['site_id'] && inWindow(r, dateField, where) && liveOnly(r, where),
      );
  const inserter = (arr: Record<string, unknown>[]) => ({
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      for (const d of data) arr.push({ id: id(), ...d });
      return { count: data.length };
    },
    create: async ({ data, select }: { data: Record<string, unknown>; select?: unknown }) => {
      const rowObj = { id: id(), ...data };
      arr.push(rowObj);
      return select ? { id: rowObj.id } : rowObj;
    },
  });

  const client = {
    workbookImport: {
      findUnique: async () => ({ id: IMPORT, site_id: SITE }),
    },
    workbookImportRow: {
      findMany: async () => staging,
    },
    workbookPromotion: {
      findUnique: async ({ where }: { where: { import_id: string } }) =>
        stores.promotions.find((p) => p['import_id'] === where.import_id) ?? null,
      create: async ({ data, select }: { data: Record<string, unknown>; select?: unknown }) => {
        const p = { id: id(), ...data };
        stores.promotions.push(p);
        return select ? { id: p.id } : p;
      },
    },
    siteInventorySnapshot: { ...inserter(stores.snapshots), findMany: finder(stores.snapshots, 'snapshot_at') },
    processedUnitsDaily: { ...inserter(stores.processed), findMany: finder(stores.processed, 'production_date') },
    inboundLoad: { ...inserter(stores.inbound), findMany: finder(stores.inbound, 'arrived_at') },
    outboundMaterial: { ...inserter(stores.outbound), findMany: finder(stores.outbound, 'ship_date') },
    landfilledUnit: { ...inserter(stores.landfilled), findMany: finder(stores.landfilled, 'disposal_date') },
    consumerDropoff: { ...inserter(stores.dropoffs), findMany: finder(stores.dropoffs, 'dropoff_date') },
    auditLog: {
      create: async ({ data }: { data: { table_name: string; row_id: string; after: unknown } }) => {
        stores.audits.push({ table_name: data.table_name, row_id: data.row_id, after: data.after });
        return data;
      },
    },
    // ADR-0120 — the workbook-promotion site lock. A fake cannot take a
    // real advisory lock, so this accepts it and does nothing. What the lock
    // actually does — block a concurrent floor write at the SAME site, and
    // not block a different site — is a Postgres property, proven in
    // `src/lib/audit/promotion-lock.db.test.ts`. No-op-ing it here keeps this
    // suite measuring the behaviour it is actually about.
    $executeRaw: async () => 0,
  } as unknown as PrismaClient & { $transaction: unknown };

  // $transaction runs the callback with the same client acting as tx.
  (client as unknown as { $transaction: (fn: (tx: unknown) => unknown) => unknown }).$transaction = (fn) =>
    fn(client);

  return { db: client, stores };
}

describe('computeCloseFromCandidates', () => {
  it('closes the Woodland scenario to exactly 4062 via the shared running balance', () => {
    const c = decodeStagingRows(woodlandRows(), SCOPE, RESOLVER);
    const close = computeCloseFromCandidates(c);
    expect(close.total.toString()).toBe('4062');
    expect(close.program.plus(close.nonProgram).equals(close.total)).toBe(true);
  });
});

// ── Finding 1: the promoted inbound must reconcile to the authoritative ledger ──
// When a workbook carries its OWN Processed ledger, the close is computed from the
// ledger but `onHand` re-derives the live floor from the inserted inbound rows. If the
// raw DAY grid over-sums inbound (June DAY23's netted-out non-program row), the stored
// close and the live query-backed balance diverge. The guard refuses that commit.
describe('assertPromotedInboundReconciles (finding 1)', () => {
  const ledgerRow = (programInbound: number, nonProgramInbound: number): StagingRowInput =>
    row('inventory_ledger', {
      programOpen: 1423,
      nonProgramOpen: 0,
      programInbound,
      nonProgramInbound,
      programStripped: 17126,
      nonProgramStripped: 0,
      savedUnits: 0,
      sold: 0,
      landfilled: 0,
    });
  // Inbound rows summing to program 135 / non-program 95 (the raw grid).
  const gridInbound: StagingRowInput[] = [
    row('inbound', { date: '2026-06-03', units: 145, programUnits: 135, nonProgramUnits: 10 }, 'Depot Alpha'),
    row('inbound', { date: '2026-06-23', units: 85, programUnits: 0, nonProgramUnits: 85 }, 'Depot Alpha'),
  ];

  it('passes when the promoted inbound sums exactly to the ledger inbound', () => {
    const c = decodeStagingRows([ledgerRow(135, 95), ...gridInbound], SCOPE, RESOLVER);
    expect(() => assertPromotedInboundReconciles(c)).not.toThrow();
  });

  it('REFUSES when the grid over-sums non-program inbound vs the ledger (the DAY23 case)', () => {
    // Ledger nets the 85-unit non-program row out (authoritative non-program inbound = 10),
    // but the grid rows sum to 95. Committing would leave the live floor 85 above the close.
    const c = decodeStagingRows([ledgerRow(135, 10), ...gridInbound], SCOPE, RESOLVER);
    expect(() => assertPromotedInboundReconciles(c)).toThrow(PromotionInboundReconciliationError);
  });

  it('is a no-op without a ledger (close then equals the inserted rows by construction)', () => {
    const c = decodeStagingRows(woodlandRows(), SCOPE, RESOLVER);
    expect(c.inventoryLedger).toBeNull();
    expect(() => assertPromotedInboundReconciles(c)).not.toThrow();
  });

  it('promoteWorkbookImport refuses to commit an over-summing import (nothing inserted)', async () => {
    const { db, stores } = makeDb([ledgerRow(135, 10), ...gridInbound]);
    await expect(
      promoteWorkbookImport({ db, importId: IMPORT, scope: { ...SCOPE, expectedCloseTotal: null }, promotedByUserId: 'u1', resolver: RESOLVER }),
    ).rejects.toBeInstanceOf(PromotionInboundReconciliationError);
    expect(stores.inbound).toHaveLength(0);
    expect(stores.promotions).toHaveLength(0);
  });
});

describe('promoteWorkbookImport — happy path', () => {
  it('promotes every table with source=import + import_id stamped and one audit row per table', async () => {
    const { db, stores } = makeDb(woodlandRows());
    const res = await promoteWorkbookImport({ db, importId: IMPORT, scope: SCOPE, promotedByUserId: 'u1', resolver: RESOLVER });

    expect(res.promoted).toBe(true);
    expect(res.counts).toEqual({
      processed_units_daily: 1,
      inbound_loads: 1,
      outbound_materials: 2,
      landfilled_units: 1,
      consumer_dropoffs: 1,
      site_inventory_snapshots: 1,
    });
    expect(res.computedClose?.total).toBe('4062');

    const pid = res.promotionId;
    expect(stores.inbound[0]?.['import_id']).toBe(pid);
    expect(stores.inbound[0]?.['status']).toBe('verified');
    expect(stores.inbound[0]?.['program_unit_count']).toBe(100);
    expect(stores.processed[0]?.['source']).toBe('import');
    expect(stores.outbound.every((o) => o['source'] === 'import' && o['import_id'] === pid)).toBe(true);
    // The anchor snapshot is dated just BEFORE the window opening so June flows count.
    expect((stores.snapshots[0]?.['snapshot_at'] as Date).getTime()).toBe(Date.UTC(2026, 5, 1) - 1);
    expect(stores.snapshots[0]?.['source']).toBe('import');

    // One audit row per table that got rows (6 tables here).
    const tables = stores.audits.map((a) => a.table_name).sort();
    expect(tables).toEqual(
      ['consumer_dropoffs', 'inbound_loads', 'landfilled_units', 'outbound_materials', 'processed_units_daily', 'site_inventory_snapshots'].sort(),
    );
    expect(stores.audits.every((a) => a.row_id === pid)).toBe(true);
  });
});

describe('promoteWorkbookImport — conflict refusal', () => {
  it('refuses (no partial promotion) when a live row exists in the window', async () => {
    const { db, stores } = makeDb(woodlandRows(), {
      processed: [{ id: 'live-1', site_id: SITE, production_date: new Date(Date.UTC(2026, 5, 10)), source: 'manual' }],
    });
    await expect(
      promoteWorkbookImport({ db, importId: IMPORT, scope: SCOPE, promotedByUserId: 'u1', resolver: RESOLVER }),
    ).rejects.toMatchObject({ name: 'PromotionConflictError' });
    // Nothing was written — the promotion ledger row is absent.
    expect(stores.promotions).toHaveLength(0);
    try {
      await promoteWorkbookImport({ db, importId: IMPORT, scope: SCOPE, promotedByUserId: 'u1', resolver: RESOLVER });
    } catch (e) {
      expect(e).toBeInstanceOf(PromotionConflictError);
      expect((e as PromotionConflictError).conflicts[0]?.table).toBe('processed_units_daily');
      expect((e as PromotionConflictError).conflicts[0]?.dates).toContain('2026-06-10');
    }
  });
});

describe('promoteWorkbookImport — re-run no-op', () => {
  it('a second promotion of the same import writes nothing and returns the prior counts', async () => {
    const { db, stores } = makeDb(woodlandRows());
    const first = await promoteWorkbookImport({ db, importId: IMPORT, scope: SCOPE, promotedByUserId: 'u1', resolver: RESOLVER });
    const inboundAfterFirst = stores.inbound.length;
    const second = await promoteWorkbookImport({ db, importId: IMPORT, scope: SCOPE, promotedByUserId: 'u1', resolver: RESOLVER });

    expect(second.promoted).toBe(false);
    expect(second.promotionId).toBe(first.promotionId);
    expect(second.counts).toEqual(first.counts);
    expect(stores.inbound.length).toBe(inboundAfterFirst); // no new rows
    expect(stores.promotions).toHaveLength(1);
  });
});

describe('promoteWorkbookImport — unresolved source', () => {
  it('refuses and lists the unresolved workbook source name', async () => {
    const rows = [
      row('opening_inventory', { date: '2026-06-01', unitsIndoor: 4000 }),
      row('inbound', { date: '2026-06-03', units: 100 }, 'Mystery Yard'),
    ];
    const { db } = makeDb(rows);
    await expect(
      promoteWorkbookImport({ db, importId: IMPORT, scope: SCOPE, promotedByUserId: 'u1', resolver: RESOLVER }),
    ).rejects.toMatchObject({ name: 'PromotionUnresolvedSourceError', names: ['Mystery Yard'] });
  });

  // ADR-0037 amendment (rollup §12): an explicit split no longer bypasses source
  // resolution — every inbound name must resolve (source_id linkage), so an
  // unknown name is refused even when the payload carries its own split.
  it('an explicit program split does NOT bypass source resolution (unknown name refused)', () => {
    const rows = [row('inbound', { date: '2026-06-03', units: 40, programUnits: 30, nonProgramUnits: 10 }, 'Mystery Yard')];
    expect(() => decodeStagingRows(rows, SCOPE, RESOLVER)).toThrowError(
      expect.objectContaining({ name: 'PromotionUnresolvedSourceError', names: ['Mystery Yard'] }),
    );
  });

  it('an explicit program split on a RESOLVED name wins over the pool default', () => {
    const rows = [row('inbound', { date: '2026-06-03', units: 40, programUnits: 30, nonProgramUnits: 10 }, 'Depot Alpha')];
    const c = decodeStagingRows(rows, SCOPE, RESOLVER);
    expect(c.inbound[0]?.programUnits).toBe(30);
    expect(c.inbound[0]?.nonProgramUnits).toBe(10);
  });
});

describe('decodeStagingRows — scope clip', () => {
  it('drops (and counts) rows dated outside the window without affecting the close', () => {
    const rows = [
      ...woodlandRows(),
      row('inbound', { date: '2026-07-15', units: 999 }, 'Depot Alpha'), // after window
      row('landfilled', { date: '2026-05-20', units: 50, reason: 'other' }), // before window
    ];
    const c = decodeStagingRows(rows, SCOPE, RESOLVER);
    expect(c.clippedRowCount).toBe(2);
    expect(computeCloseFromCandidates(c).total.toString()).toBe('4062');
  });

  it('an Eugene-style narrow scope clips everything before Jun 24', () => {
    const rows = [
      row('inbound', { date: '2026-06-20', units: 10 }, 'Depot Alpha'),
      row('inbound', { date: '2026-06-25', units: 7 }, 'Depot Alpha'),
    ];
    const eugene: PromotionScope = { siteId: SITE, from: '2026-06-24', to: '2026-06-30' };
    const c = decodeStagingRows(rows, eugene, RESOLVER);
    expect(c.inbound).toHaveLength(1);
    expect(c.inbound[0]?.date).toBe('2026-06-25');
    expect(c.clippedRowCount).toBe(1);
  });
});

describe('promoteWorkbookImport — 4062 assertion', () => {
  it('commits when the recomputed close matches the expected total', async () => {
    const { db } = makeDb(woodlandRows());
    const res = await promoteWorkbookImport({ db, importId: IMPORT, scope: SCOPE, promotedByUserId: 'u1', resolver: RESOLVER });
    expect(res.promoted).toBe(true);
  });

  it('REFUSES COMMIT (typed error, both numbers) when the close disagrees', async () => {
    const { db, stores } = makeDb(woodlandRows());
    const wrong: PromotionScope = { ...SCOPE, expectedCloseTotal: 4000 };
    await expect(
      promoteWorkbookImport({ db, importId: IMPORT, scope: wrong, promotedByUserId: 'u1', resolver: RESOLVER }),
    ).rejects.toMatchObject({ name: 'PromotionBalanceAssertionError', expected: 4000, computed: '4062' });
    void stores;
  });

  it('the balance error is a PromotionBalanceAssertionError instance', async () => {
    const { db } = makeDb(woodlandRows());
    const wrong: PromotionScope = { ...SCOPE, expectedCloseTotal: 1 };
    await expect(
      promoteWorkbookImport({ db, importId: IMPORT, scope: wrong, promotedByUserId: 'u1', resolver: RESOLVER }),
    ).rejects.toBeInstanceOf(PromotionBalanceAssertionError);
  });
});

describe('decodeStagingRows — strict parse', () => {
  it('throws PromotionParseError on an unrecognized section', () => {
    expect(() => decodeStagingRows([row('bogus', { date: '2026-06-01' })], SCOPE, RESOLVER)).toThrow(PromotionParseError);
  });
  it('throws on a renovation outbound whose split does not sum to whole units', () => {
    const rows = [
      row('outbound', { date: '2026-06-12', commodity: 'foam', subCategory: 'renovation', weightLbs: 900, wholeUnits: 15, programUnits: 10, nonProgramUnits: 2 }),
    ];
    expect(() => decodeStagingRows(rows, SCOPE, RESOLVER)).toThrow(PromotionParseError);
  });
  it('throws on a baled outbound carrying a unit split', () => {
    const rows = [row('outbound', { date: '2026-06-12', commodity: 'foam', subCategory: 'baled', weightLbs: 900, wholeUnits: 5 })];
    expect(() => decodeStagingRows(rows, SCOPE, RESOLVER)).toThrow(PromotionParseError);
  });
});
