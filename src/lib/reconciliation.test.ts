// Sprint-1 T-016 — reconciliation engine + persistence tests.
//
// Covered surface area:
//   - Parser: required-column validation, sha256 stability,
//     date-format tolerance (MM/DD/YYYY + ISO), comma-stripped
//     numbers, empty-input + missing-haul-id rejection.
//   - Categorizer: every category branch + tolerance edges, with
//     and without DR3 weight/count nulls.
//   - Persistence: idempotency (same sha256 -> reuse session, no
//     duplicate items, no duplicate audit row).
//   - Resolution: writes one item update + one audit row per click;
//     resolved_count maintenance; cross-site rejection.
//
// The Prisma client is mocked in-process so tests run on the
// vitest `node` env without standing up a database. The mock store
// is the same shape as the admin-users.test.ts harness (adapted to
// the reconciliation tables).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Test doubles ────────────────────────────────────────────────

interface MockReconciliation {
  id: string;
  site_id: string;
  filename: string;
  content_sha256: string;
  weight_tolerance_pct: { toString(): string };
  total_rows: number;
  matched_count: number;
  unmatched_count: number;
  resolved_count: number;
  match_clean_count: number;
  weight_mismatch_count: number;
  count_mismatch_count: number;
  missing_in_dr3_count: number;
  missing_in_mymrc_count: number;
  uploaded_by_id: string | null;
  uploaded_at: Date;
  period_start: Date;
  period_end: Date;
}

interface MockItem {
  id: string;
  reconciliation_id: string;
  external_haul_id: string;
  external_delivery_date: Date | null;
  external_source_name: string | null;
  external_unit_count: number | null;
  external_weight_lbs: number | null;
  matched_load_id: string | null;
  dr3_unit_count: number | null;
  dr3_weight_lbs: number | null;
  status: string;
  resolution: string;
  resolution_notes: string | null;
  resolved_at: Date | null;
  resolved_by_id: string | null;
}

interface MockAuditRow {
  actor_user_id: string | null;
  action: string;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
}

const recsStore = new Map<string, MockReconciliation>();
const itemsStore = new Map<string, MockItem>();
const auditRows: MockAuditRow[] = [];
let idCounter = 1;

function nextId(prefix: string): string {
  return `${prefix}-${idCounter++}`;
}

function resetStores() {
  recsStore.clear();
  itemsStore.clear();
  auditRows.length = 0;
  idCounter = 1;
}

vi.mock('@/lib/prisma', () => {
  const mymrcReconciliation = {
    findUnique: vi.fn(
      async ({
        where,
      }: {
        where:
          | { id: string }
          | { site_id_content_sha256: { site_id: string; content_sha256: string } };
      }) => {
        if ('id' in where) return recsStore.get(where.id) ?? null;
        for (const r of recsStore.values()) {
          if (
            r.site_id === where.site_id_content_sha256.site_id &&
            r.content_sha256 === where.site_id_content_sha256.content_sha256
          ) {
            return r;
          }
        }
        return null;
      }
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = nextId('rec');
      const tol = data['weight_tolerance_pct'] as { toString(): string } | string;
      const tolWrapped =
        typeof tol === 'string' ? { toString: () => tol } : (tol as { toString(): string });
      const r: MockReconciliation = {
        id,
        site_id: data['site_id'] as string,
        filename: data['filename'] as string,
        content_sha256: data['content_sha256'] as string,
        weight_tolerance_pct: tolWrapped,
        total_rows: data['total_rows'] as number,
        matched_count: data['matched_count'] as number,
        unmatched_count: data['unmatched_count'] as number,
        resolved_count: 0,
        match_clean_count: data['match_clean_count'] as number,
        weight_mismatch_count: data['weight_mismatch_count'] as number,
        count_mismatch_count: data['count_mismatch_count'] as number,
        missing_in_dr3_count: data['missing_in_dr3_count'] as number,
        missing_in_mymrc_count: data['missing_in_mymrc_count'] as number,
        uploaded_by_id: (data['uploaded_by_id'] as string) ?? null,
        uploaded_at: new Date(),
        period_start: data['period_start'] as Date,
        period_end: data['period_end'] as Date,
      };
      // Enforce the unique constraint on (site_id, content_sha256).
      for (const ex of recsStore.values()) {
        if (ex.site_id === r.site_id && ex.content_sha256 === r.content_sha256) {
          const violation = Object.assign(new Error('unique violation'), {
            code: 'P2002',
          });
          throw violation;
        }
      }
      recsStore.set(id, r);
      return r;
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = recsStore.get(where.id);
        if (!r) throw new Error('not found');
        if (data['resolved_count']) {
          const inc = (data['resolved_count'] as { increment?: number }).increment ?? 0;
          r.resolved_count += inc;
        }
        return r;
      }
    ),
  };

  const mymrcReconciliationItem = {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const d of data) {
        const id = nextId('it');
        itemsStore.set(id, {
          id,
          reconciliation_id: d['reconciliation_id'] as string,
          external_haul_id: d['external_haul_id'] as string,
          external_delivery_date: (d['external_delivery_date'] as Date | null) ?? null,
          external_source_name: (d['external_source_name'] as string | null) ?? null,
          external_unit_count: (d['external_unit_count'] as number | null) ?? null,
          external_weight_lbs: (d['external_weight_lbs'] as number | null) ?? null,
          matched_load_id: (d['matched_load_id'] as string | null) ?? null,
          dr3_unit_count: (d['dr3_unit_count'] as number | null) ?? null,
          dr3_weight_lbs: (d['dr3_weight_lbs'] as number | null) ?? null,
          status: d['status'] as string,
          resolution: 'unresolved',
          resolution_notes: null,
          resolved_at: null,
          resolved_by_id: null,
        });
      }
      return { count: data.length };
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const it = itemsStore.get(where.id);
      if (!it) return null;
      const rec = recsStore.get(it.reconciliation_id);
      return { ...it, reconciliation: rec ? { site_id: rec.site_id } : null };
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const it = itemsStore.get(where.id);
        if (!it) throw new Error('not found');
        if ('resolution' in data) it.resolution = data['resolution'] as string;
        if ('resolution_notes' in data)
          it.resolution_notes = data['resolution_notes'] as string | null;
        if ('resolved_at' in data) it.resolved_at = data['resolved_at'] as Date | null;
        if ('resolved_by_id' in data) it.resolved_by_id = data['resolved_by_id'] as string | null;
        return it;
      }
    ),
  };

  const auditLog = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      auditRows.push({
        actor_user_id: (data['actor_user_id'] as string) ?? null,
        action: data['action'] as string,
        table_name: data['table_name'] as string,
        row_id: data['row_id'] as string,
        before: data['before'],
        after: data['after'],
      });
      return { id: nextId('audit') };
    }),
  };

  return {
    prisma: {
      mymrcReconciliation,
      mymrcReconciliationItem,
      auditLog,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn({ mymrcReconciliation, mymrcReconciliationItem, auditLog });
      }),
    },
  };
});

// Patch Prisma's runtime check for known errors so our P2002 mock
// triggers the catch branch in persistReconciliation.
vi.mock('@prisma/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  class FakePrismaKnownError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  }
  return {
    ...actual,
    Prisma: {
      ...actual.Prisma,
      PrismaClientKnownRequestError: FakePrismaKnownError,
      // Decimal: leave actual untouched (used by other code paths).
    },
  };
});

beforeEach(() => {
  resetStores();
});

// ── Imports under test (after the mocks) ────────────────────────

import {
  DEFAULT_WEIGHT_TOLERANCE_PCT,
  REQUIRED_CSV_COLUMNS,
  categorizeRows,
  parseReconciliationCsv,
  persistReconciliation,
  resolveReconciliationItem,
  __testing,
  type Dr3LoadForReconcile,
  type ParsedCsv,
} from './reconciliation';

// ── Fixtures ────────────────────────────────────────────────────

const HEADER = REQUIRED_CSV_COLUMNS.join(',');

function csvRows(rows: ReadonlyArray<readonly string[]>): string {
  return [HEADER, ...rows.map((r) => r.join(','))].join('\n');
}

function dr3(
  id: string,
  hid: string | null,
  units: number | null,
  weight: number | null
): Dr3LoadForReconcile {
  return { id, external_mymrc_haul_id: hid, total_units: units, weight_lbs: weight };
}

// ── Parser tests ────────────────────────────────────────────────

describe('parseReconciliationCsv', () => {
  it('rejects empty input with empty_csv', () => {
    const r = parseReconciliationCsv('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty_csv');
  });

  it('rejects missing required columns', () => {
    const r = parseReconciliationCsv('Recycler,Haul: Haul ID\nDR3 Eugene,H-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_columns');
  });

  it('rejects when no rows have a haul id', () => {
    const text = csvRows([
      ['DR3 Eugene', '', '03/01/2026', 'SourceA', '50', 'Carrier', '5000'],
    ]);
    const r = parseReconciliationCsv(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_valid_rows');
  });

  it('parses MM/DD/YYYY dates', () => {
    const text = csvRows([
      ['DR3 Eugene', 'H-100', '03/15/2026', 'SourceA', '50', 'Carrier', '5000'],
    ]);
    const r = parseReconciliationCsv(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.rows[0]?.delivery_date?.toISOString().slice(0, 10)).toBe('2026-03-15');
    }
  });

  it('parses ISO yyyy-mm-dd dates (Excel re-save)', () => {
    const text = csvRows([
      ['DR3 Eugene', 'H-100', '2026-03-15', 'SourceA', '50', 'Carrier', '5000'],
    ]);
    const r = parseReconciliationCsv(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.rows[0]?.delivery_date?.toISOString().slice(0, 10)).toBe('2026-03-15');
    }
  });

  it('strips commas from numeric fields', () => {
    // Quote the comma-bearing cells so papaparse treats them as one
    // field rather than splitting on the embedded comma.
    const text = csvRows([
      ['DR3 Eugene', 'H-100', '03/15/2026', 'SourceA', '"1,234"', 'Carrier', '"12,345"'],
    ]);
    const r = parseReconciliationCsv(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.rows[0]?.unit_count).toBe(1234);
      expect(r.parsed.rows[0]?.weight_lbs).toBe(12345);
    }
  });

  it('produces a stable sha256 for identical input', () => {
    const text = csvRows([
      ['DR3 Eugene', 'H-100', '03/15/2026', 'SourceA', '50', 'Carrier', '5000'],
    ]);
    const a = parseReconciliationCsv(text);
    const b = parseReconciliationCsv(text);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.parsed.sha256).toBe(b.parsed.sha256);
  });

  it('produces different sha256 for different input', () => {
    const a = parseReconciliationCsv(
      csvRows([['DR3 Eugene', 'H-100', '03/15/2026', 'A', '50', 'C', '5000']])
    );
    const b = parseReconciliationCsv(
      csvRows([['DR3 Eugene', 'H-100', '03/15/2026', 'A', '51', 'C', '5000']])
    );
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.parsed.sha256).not.toBe(b.parsed.sha256);
  });

  it('observes period_start and period_end across all dated rows', () => {
    const text = csvRows([
      ['DR3 Eugene', 'H-1', '03/01/2026', 'A', '10', 'C', '1000'],
      ['DR3 Eugene', 'H-2', '03/15/2026', 'A', '10', 'C', '1000'],
      ['DR3 Eugene', 'H-3', '03/31/2026', 'A', '10', 'C', '1000'],
    ]);
    const r = parseReconciliationCsv(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.period_start.toISOString().slice(0, 10)).toBe('2026-03-01');
      expect(r.parsed.period_end.toISOString().slice(0, 10)).toBe('2026-03-31');
    }
  });
});

// ── Categorizer tests ───────────────────────────────────────────

describe('categorizeRows', () => {
  const baseCsv = (overrides: Partial<{ unit: number; weight: number }> = {}) => [
    {
      recycler: 'DR3 Eugene',
      external_haul_id: 'H-100',
      delivery_date: new Date('2026-03-15T00:00:00Z'),
      source_name: 'SourceA',
      unit_count: overrides.unit ?? 50,
      transporter_name: 'Carrier',
      weight_lbs: overrides.weight ?? 5000,
    },
  ];

  it('categorizes match_clean when counts and weights agree', () => {
    const r = categorizeRows(baseCsv(), [dr3('L-1', 'H-100', 50, 5000)]);
    expect(r.counts.match_clean).toBe(1);
    expect(r.counts.weight_mismatch).toBe(0);
    expect(r.items[0]?.status).toBe('match_clean');
  });

  it('categorizes weight_mismatch when weight is outside tolerance', () => {
    // 5000 vs 5500 == 9.09% diff, > default 2%
    const r = categorizeRows(baseCsv(), [dr3('L-1', 'H-100', 50, 5500)]);
    expect(r.counts.weight_mismatch).toBe(1);
    expect(r.items[0]?.status).toBe('weight_mismatch');
  });

  it('categorizes match_clean when weight diff is within tolerance', () => {
    // 5000 vs 5100 == 1.96% < 2%
    const r = categorizeRows(baseCsv({ weight: 5100 }), [dr3('L-1', 'H-100', 50, 5000)]);
    expect(r.items[0]?.status).toBe('match_clean');
  });

  it('honors a custom tolerance', () => {
    // 1% diff with tolerance=0 -> mismatch
    const r = categorizeRows(baseCsv({ weight: 5050 }), [dr3('L-1', 'H-100', 50, 5000)], 0);
    expect(r.items[0]?.status).toBe('weight_mismatch');
  });

  it('categorizes count_mismatch even if weights match', () => {
    const r = categorizeRows(baseCsv({ unit: 51 }), [dr3('L-1', 'H-100', 50, 5000)]);
    expect(r.items[0]?.status).toBe('count_mismatch');
  });

  it('categorizes missing_in_dr3 when CSV row has no DR3 match', () => {
    const r = categorizeRows(baseCsv(), [dr3('L-9', 'H-OTHER', 50, 5000)]);
    expect(r.counts.missing_in_dr3).toBe(1);
    expect(r.items[0]?.status).toBe('missing_in_dr3');
  });

  it('categorizes missing_in_mymrc when DR3 has a haul that CSV omits', () => {
    const r = categorizeRows([], [dr3('L-1', 'H-100', 50, 5000)]);
    expect(r.counts.missing_in_mymrc).toBe(1);
    expect(r.items[0]?.status).toBe('missing_in_mymrc');
  });

  it('emits the full counts object with total = sum of categories', () => {
    const csv = [
      ...baseCsv(), // match
      {
        ...baseCsv()[0]!,
        external_haul_id: 'H-WT',
        unit_count: 50,
        weight_lbs: 9999,
      }, // weight mismatch
      {
        ...baseCsv()[0]!,
        external_haul_id: 'H-CT',
        unit_count: 999,
        weight_lbs: 5000,
      }, // count mismatch
      {
        ...baseCsv()[0]!,
        external_haul_id: 'H-MIA',
        unit_count: 50,
        weight_lbs: 5000,
      }, // missing in dr3
    ];
    const r = categorizeRows(csv, [
      dr3('L-1', 'H-100', 50, 5000),
      dr3('L-2', 'H-WT', 50, 5000),
      dr3('L-3', 'H-CT', 50, 5000),
      dr3('L-4', 'H-EXTRA', 1, 1), // missing in mymrc
    ]);
    expect(r.counts.total).toBe(5);
    expect(r.counts.match_clean).toBe(1);
    expect(r.counts.weight_mismatch).toBe(1);
    expect(r.counts.count_mismatch).toBe(1);
    expect(r.counts.missing_in_dr3).toBe(1);
    expect(r.counts.missing_in_mymrc).toBe(1);
  });

  it('treats both-zero weights as a clean match', () => {
    expect(__testing.weightsWithinTolerance(0, 0, 2)).toBe(true);
  });

  it('treats null on one side and a value on the other as mismatch', () => {
    expect(__testing.weightsWithinTolerance(null, 5000, 2)).toBe(false);
    expect(__testing.unitsMatch(null, 50)).toBe(false);
  });
});

// ── Persistence tests ───────────────────────────────────────────

describe('persistReconciliation', () => {
  function fakeParsed(sha: string): ParsedCsv {
    return {
      rows: [],
      sha256: sha,
      period_start: new Date('2026-03-01T00:00:00Z'),
      period_end: new Date('2026-03-31T00:00:00Z'),
    };
  }

  it('creates the parent + items + one audit row on first upload', async () => {
    const r = await persistReconciliation({
      siteId: 'site-eugene',
      uploaderUserId: 'user-1',
      filename: 'march.csv',
      parsed: fakeParsed('abc123'),
      categorization: {
        items: [
          {
            external_haul_id: 'H-1',
            external_delivery_date: new Date('2026-03-15T00:00:00Z'),
            external_source_name: 'A',
            external_unit_count: 50,
            external_weight_lbs: 5000,
            matched_load_id: 'L-1',
            dr3_unit_count: 50,
            dr3_weight_lbs: 5000,
            status: 'match_clean',
          },
        ],
        counts: {
          total: 1,
          match_clean: 1,
          weight_mismatch: 0,
          count_mismatch: 0,
          missing_in_dr3: 0,
          missing_in_mymrc: 0,
        },
      },
      tolerancePct: DEFAULT_WEIGHT_TOLERANCE_PCT,
      ip: null,
      userAgent: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.created).toBe(true);
      expect(recsStore.size).toBe(1);
      expect(itemsStore.size).toBe(1);
      const ins = auditRows.filter((a) => a.action === 'insert');
      expect(ins.length).toBe(1);
      expect(ins[0]?.table_name).toBe('mymrc_reconciliations');
    }
  });

  it('returns the existing reconciliation_id on duplicate upload (no second item set, no second audit row)', async () => {
    const cat = {
      items: [],
      counts: {
        total: 0,
        match_clean: 0,
        weight_mismatch: 0,
        count_mismatch: 0,
        missing_in_dr3: 0,
        missing_in_mymrc: 0,
      },
    };
    const first = await persistReconciliation({
      siteId: 'site-eugene',
      uploaderUserId: 'user-1',
      filename: 'march.csv',
      parsed: fakeParsed('dedupe-key'),
      categorization: cat,
      tolerancePct: 2.0,
      ip: null,
      userAgent: null,
    });
    expect(first.ok && first.created).toBe(true);
    const second = await persistReconciliation({
      siteId: 'site-eugene',
      uploaderUserId: 'user-2',
      filename: 'march-v2.csv', // different filename, same content -> dedupe
      parsed: fakeParsed('dedupe-key'),
      categorization: cat,
      tolerancePct: 2.0,
      ip: null,
      userAgent: null,
    });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.created).toBe(false);
      expect(second.reconciliationId).toBe(first.reconciliationId);
    }
    expect(recsStore.size).toBe(1);
    expect(auditRows.filter((a) => a.action === 'insert').length).toBe(1);
  });

  it('isolates idempotency by site (same content sha at different sites = two rows)', async () => {
    const cat = {
      items: [],
      counts: {
        total: 0,
        match_clean: 0,
        weight_mismatch: 0,
        count_mismatch: 0,
        missing_in_dr3: 0,
        missing_in_mymrc: 0,
      },
    };
    await persistReconciliation({
      siteId: 'site-eugene',
      uploaderUserId: 'user-1',
      filename: 'x.csv',
      parsed: fakeParsed('shared-sha'),
      categorization: cat,
      tolerancePct: 2.0,
      ip: null,
      userAgent: null,
    });
    await persistReconciliation({
      siteId: 'site-woodland',
      uploaderUserId: 'user-1',
      filename: 'x.csv',
      parsed: fakeParsed('shared-sha'),
      categorization: cat,
      tolerancePct: 2.0,
      ip: null,
      userAgent: null,
    });
    expect(recsStore.size).toBe(2);
  });
});

// ── Resolution tests ────────────────────────────────────────────

describe('resolveReconciliationItem', () => {
  async function seedSession(siteId: string, status: string = 'weight_mismatch') {
    const { prisma } = (await import('@/lib/prisma')) as unknown as {
      prisma: {
        mymrcReconciliation: { create: (args: unknown) => Promise<MockReconciliation> };
        mymrcReconciliationItem: { createMany: (args: unknown) => Promise<unknown> };
      };
    };
    const rec = await prisma.mymrcReconciliation.create({
      data: {
        site_id: siteId,
        period_start: new Date('2026-03-01T00:00:00Z'),
        period_end: new Date('2026-03-31T00:00:00Z'),
        uploaded_by_id: 'user-1',
        filename: 't.csv',
        content_sha256: `sha-${Math.random()}`,
        weight_tolerance_pct: '2.00',
        total_rows: 1,
        matched_count: 0,
        unmatched_count: 1,
        match_clean_count: 0,
        weight_mismatch_count: 1,
        count_mismatch_count: 0,
        missing_in_dr3_count: 0,
        missing_in_mymrc_count: 0,
      },
    } as unknown as { data: Record<string, unknown> });
    await prisma.mymrcReconciliationItem.createMany({
      data: [
        {
          reconciliation_id: rec.id,
          external_haul_id: 'H-9',
          external_delivery_date: null,
          external_source_name: null,
          external_unit_count: 50,
          external_weight_lbs: 5500,
          matched_load_id: 'L-9',
          dr3_unit_count: 50,
          dr3_weight_lbs: 5000,
          status,
        },
      ],
    } as unknown as { data: Array<Record<string, unknown>> });
    return rec;
  }

  it('writes the item update + one audit row per click', async () => {
    const rec = await seedSession('site-eugene');
    const itemId = Array.from(itemsStore.values())[0]!.id;
    auditRows.length = 0; // ignore any audit from setup

    const r = await resolveReconciliationItem({
      itemId,
      siteId: rec.site_id,
      resolverUserId: 'user-mgr',
      resolution: 'dr3_correct',
      notes: 'verified at dock',
      ip: '1.2.3.4',
      userAgent: 'test-agent',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item.resolution).toBe('dr3_correct');
      expect(r.item.resolved_by_id).toBe('user-mgr');
    }
    const updates = auditRows.filter(
      (a) => a.action === 'update' && a.table_name === 'mymrc_reconciliation_items'
    );
    expect(updates.length).toBe(1);
    expect((updates[0]?.after as { resolution: string }).resolution).toBe('dr3_correct');
  });

  it('rejects cross-site resolution attempts', async () => {
    const rec = await seedSession('site-eugene');
    const itemId = Array.from(itemsStore.values())[0]!.id;

    const r = await resolveReconciliationItem({
      itemId,
      siteId: 'site-woodland', // mismatched
      resolverUserId: 'user-mgr',
      resolution: 'dr3_correct',
      notes: null,
      ip: null,
      userAgent: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_site');
    void rec;
  });

  it('rejects an "unresolved" payload (only forward transitions allowed)', async () => {
    const rec = await seedSession('site-eugene');
    const itemId = Array.from(itemsStore.values())[0]!.id;
    const r = await resolveReconciliationItem({
      itemId,
      siteId: rec.site_id,
      resolverUserId: 'user-mgr',
      resolution: 'unresolved',
      notes: null,
      ip: null,
      userAgent: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_resolution');
  });

  it('increments resolved_count exactly once for the first resolution', async () => {
    const rec = await seedSession('site-eugene');
    const itemId = Array.from(itemsStore.values())[0]!.id;

    await resolveReconciliationItem({
      itemId,
      siteId: rec.site_id,
      resolverUserId: 'user-mgr',
      resolution: 'dr3_correct',
      notes: null,
      ip: null,
      userAgent: null,
    });
    await resolveReconciliationItem({
      itemId,
      siteId: rec.site_id,
      resolverUserId: 'user-mgr',
      resolution: 'mymrc_correct', // change of mind
      notes: null,
      ip: null,
      userAgent: null,
    });
    const recAfter = recsStore.get(rec.id)!;
    expect(recAfter.resolved_count).toBe(1);
    // ... but TWO audit rows: one per click
    const updates = auditRows.filter(
      (a) => a.action === 'update' && a.table_name === 'mymrc_reconciliation_items'
    );
    expect(updates.length).toBe(2);
  });

  it('returns not_found for a non-existent item id', async () => {
    const r = await resolveReconciliationItem({
      itemId: 'no-such',
      siteId: 'site-eugene',
      resolverUserId: 'user-mgr',
      resolution: 'dr3_correct',
      notes: null,
      ip: null,
      userAgent: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });
});

// ── End-to-end sanity (parser + categorizer chained) ────────────

describe('end-to-end engine sanity', () => {
  it('takes a fixture CSV through parser + categorizer with correct totals', () => {
    const text = csvRows([
      ['DR3 Eugene', 'H-1', '03/01/2026', 'A', '50', 'C', '5000'], // clean
      ['DR3 Eugene', 'H-2', '03/05/2026', 'A', '60', 'C', '5500'], // count mismatch
      ['DR3 Eugene', 'H-3', '03/10/2026', 'B', '40', 'C', '7000'], // weight mismatch
      ['DR3 Eugene', 'H-MIA', '03/12/2026', 'B', '5', 'C', '500'], // missing in dr3
    ]);
    const parsed = parseReconciliationCsv(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cat = categorizeRows(parsed.parsed.rows, [
      dr3('L-1', 'H-1', 50, 5000),
      dr3('L-2', 'H-2', 50, 5500), // count diff
      dr3('L-3', 'H-3', 40, 5000), // weight diff
      dr3('L-EXTRA', 'H-EXTRA', 99, 9999), // missing in mymrc
    ]);
    expect(cat.counts).toEqual({
      total: 5,
      match_clean: 1,
      count_mismatch: 1,
      weight_mismatch: 1,
      missing_in_dr3: 1,
      missing_in_mymrc: 1,
    });
  });
});
