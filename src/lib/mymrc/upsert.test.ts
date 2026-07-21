import { describe, expect, it, vi } from 'vitest';
import { upsertScrapedHauls } from './upsert';
import type { ScrapedHaul } from './types';

// Tests for `src/lib/mymrc/upsert.ts`. We mock Prisma at the call-site
// level — the upsert path makes a small, well-bounded set of method
// calls (site lookup, source/transporter prefetch, per-haul find/
// create/update, stale-window cancel, audit insert) and asserting on
// those is more useful than a real test container at this layer.
//
// What we cover:
//   - Site lookup miss → throws with a useful message
//   - Empty haul list → no inserts/updates/cancels (clean no-op)
//   - New haul → insert + audit row
//   - Existing haul, no material change → touches `last_synced_at`
//     only, no audit row written
//   - Existing haul, material change → update + audit row
//   - Stale haul in window → cancellation + audit row
//   - Stale haul OUT of window → left untouched
//   - Source name unmatched → row inserted with source_id=null,
//     summary counter incremented

const HAUL_BASE: Omit<ScrapedHaul, 'external_mymrc_haul_id'> = {
  expected_arrival_at: new Date('2026-05-08T12:00:00.000Z'),
  source_name: 'Source Alpha',
  transporter_name: 'Carrier One',
  expected_unit_count: 50,
  bol_number: 'BOL-A',
  scheduled_at_mymrc: null,
};

function buildHaul(id: string, overrides: Partial<ScrapedHaul> = {}): ScrapedHaul {
  return { ...HAUL_BASE, external_mymrc_haul_id: id, ...overrides };
}

function buildPrismaMock(opts: {
  siteFound?: boolean;
  sources?: Array<{ id: string; name: string }>;
  transporters?: Array<{ id: string; name: string }>;
  existingByHaulId?: Map<string, ExistingExpected | null>;
  staleRows?: Array<{ id: string; external_mymrc_haul_id: string; cancelled_at: Date | null }>;
}) {
  const expectedCreate = vi.fn();
  const expectedUpdate = vi.fn();
  const auditCreate = vi.fn();
  return {
    site: {
      findUnique: vi.fn(async () =>
        opts.siteFound === false ? null : { id: 'site-id-1' },
      ),
    },
    source: {
      findMany: vi.fn(async () => opts.sources ?? []),
    },
    transporter: {
      findMany: vi.fn(async () => opts.transporters ?? []),
    },
    expectedLoad: {
      create: vi.fn(async (args: { data: { external_mymrc_haul_id: string } }) => {
        expectedCreate(args);
        return { id: `created-${args.data.external_mymrc_haul_id}` };
      }),
      update: vi.fn(async (args: { where: { id: string } }) => {
        expectedUpdate(args);
        return { id: args.where.id };
      }),
      // Two callers: the batched existing-load lookup keys off
      // `where.external_mymrc_haul_id.in`; the stale-window scan does not.
      findMany: vi.fn(async (args: { where?: { external_mymrc_haul_id?: { in: string[] } } }) => {
        const inIds = args.where?.external_mymrc_haul_id?.in;
        if (inIds) {
          const map = opts.existingByHaulId ?? new Map();
          return inIds
            .map((id) => {
              const row = map.get(id);
              return row ? { ...row, external_mymrc_haul_id: id } : null;
            })
            .filter((r): r is ExistingExpected => r !== null);
        }
        return opts.staleRows ?? [];
      }),
    },
    auditLog: {
      create: vi.fn(async (args: { data: unknown }) => {
        auditCreate(args);
        return { id: 'audit-1' };
      }),
    },
    // Counters exposed for assertions.
    _spies: { expectedCreate, expectedUpdate, auditCreate },
  };
}

interface ExistingExpected {
  id: string;
  site_id: string;
  expected_arrival_at: Date;
  source_id: string | null;
  source_name_at_sync: string;
  transporter_id: string | null;
  transporter_name_at_sync: string | null;
  expected_unit_count: number | null;
  bol_number: string | null;
  scheduled_at_mymrc: Date | null;
  cancelled_at: Date | null;
}

const NOW = new Date('2026-05-06T18:00:00.000Z');

describe('upsertScrapedHauls — preconditions', () => {
  it('throws when the site code does not resolve', async () => {
    const prisma = buildPrismaMock({ siteFound: false });
    await expect(
      upsertScrapedHauls({
        prisma: prisma as unknown as Parameters<typeof upsertScrapedHauls>[0]['prisma'],
        site: 'eugene',
        hauls: [],
        scrapedAt: NOW,
        now: NOW,
      }),
    ).rejects.toThrow(/site code "eugene" not found/);
  });

  it('handles empty haul list — no inserts, no audit rows, only stale-scan', async () => {
    const prisma = buildPrismaMock({});
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as Parameters<typeof upsertScrapedHauls>[0]['prisma'],
      site: 'eugene',
      hauls: [],
      scrapedAt: NOW,
      now: NOW,
    });
    expect(summary).toEqual({
      inserted: 0,
      updated: 0,
      cancelled: 0,
      unmatched_source_count: 0,
      unmatched_transporter_count: 0,
      unmatched_source_names: [],
      unmatched_transporter_names: [],
      alias_resolved_source_names: [],
    });
    expect(prisma._spies.expectedCreate).not.toHaveBeenCalled();
    expect(prisma._spies.auditCreate).not.toHaveBeenCalled();
  });
});

describe('upsertScrapedHauls — insert path', () => {
  it('inserts a brand-new haul with resolved FKs and writes an audit row', async () => {
    const prisma = buildPrismaMock({
      sources: [{ id: 'src-1', name: 'Source Alpha' }],
      transporters: [{ id: 'tx-1', name: 'Carrier One' }],
    });
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as Parameters<typeof upsertScrapedHauls>[0]['prisma'],
      site: 'eugene',
      hauls: [buildHaul('H-NEW')],
      scrapedAt: NOW,
      now: NOW,
    });
    expect(summary.inserted).toBe(1);
    expect(summary.updated).toBe(0);
    expect(prisma._spies.expectedCreate).toHaveBeenCalledTimes(1);
    const createArgs = prisma._spies.expectedCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createArgs.data['source_id']).toBe('src-1');
    expect(createArgs.data['transporter_id']).toBe('tx-1');
    expect(createArgs.data['site_id']).toBe('site-id-1');
    expect(createArgs.data['cancelled_at']).toBeNull();
    expect(prisma._spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArgs = prisma._spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArgs.data['action']).toBe('insert');
    expect(auditArgs.data['actor_label']).toBe('system:mymrc-scrape');
    expect(auditArgs.data['table_name']).toBe('expected_loads');
  });

  it('inserts with null FKs when source/transporter unmatched and increments counters', async () => {
    const prisma = buildPrismaMock({
      sources: [],
      transporters: [],
    });
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as Parameters<typeof upsertScrapedHauls>[0]['prisma'],
      site: 'eugene',
      hauls: [buildHaul('H-UNMATCHED')],
      scrapedAt: NOW,
      now: NOW,
    });
    expect(summary.unmatched_source_count).toBe(1);
    expect(summary.unmatched_transporter_count).toBe(1);
    const createArgs = prisma._spies.expectedCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createArgs.data['source_id']).toBeNull();
    expect(createArgs.data['transporter_id']).toBeNull();
    expect(createArgs.data['source_name_at_sync']).toBe('Source Alpha');
    expect(createArgs.data['transporter_name_at_sync']).toBe('Carrier One');
  });

  it('returns DEDUPED unmatched names and warns ONCE per run naming them', async () => {
    const prisma = buildPrismaMock({ sources: [], transporters: [] });
    const logged: Array<{ level: string; message: string }> = [];
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as Parameters<typeof upsertScrapedHauls>[0]['prisma'],
      site: 'eugene',
      // Two hauls sharing the SAME unmatched source name → count 2, deduped names 1.
      hauls: [
        buildHaul('H-A', { source_name: 'Ghost Depot', transporter_name: 'Phantom Freight' }),
        buildHaul('H-B', { source_name: 'Ghost Depot', transporter_name: null }),
      ],
      scrapedAt: NOW,
      now: NOW,
      log: (level, message) => logged.push({ level, message }),
    });
    expect(summary.unmatched_source_count).toBe(2);
    expect(summary.unmatched_source_names).toEqual(['Ghost Depot']);
    expect(summary.unmatched_transporter_names).toEqual(['Phantom Freight']);
    // Exactly one warn per category, and it names the offending values.
    const sourceWarns = logged.filter((l) => l.level === 'warn' && l.message.includes('unmatched source name'));
    expect(sourceWarns).toHaveLength(1);
    expect(sourceWarns[0]?.message).toContain('Ghost Depot');
    const txWarns = logged.filter((l) => l.level === 'warn' && l.message.includes('unmatched transporter name'));
    expect(txWarns).toHaveLength(1);
    expect(txWarns[0]?.message).toContain('Phantom Freight');
  });
});

describe('upsertScrapedHauls — update path', () => {
  function existingMatching(): ExistingExpected {
    return {
      id: 'existing-1',
      site_id: 'site-id-1',
      expected_arrival_at: HAUL_BASE.expected_arrival_at,
      source_id: 'src-1',
      source_name_at_sync: 'Source Alpha',
      transporter_id: 'tx-1',
      transporter_name_at_sync: 'Carrier One',
      expected_unit_count: 50,
      bol_number: 'BOL-A',
      scheduled_at_mymrc: null,
      cancelled_at: null,
    };
  }

  it('touches last_synced_at WITHOUT writing an audit row when nothing material changed', async () => {
    const map = new Map<string, ExistingExpected | null>([['H-SAME', existingMatching()]]);
    const prisma = buildPrismaMock({
      sources: [{ id: 'src-1', name: 'Source Alpha' }],
      transporters: [{ id: 'tx-1', name: 'Carrier One' }],
      existingByHaulId: map,
    });
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as Parameters<typeof upsertScrapedHauls>[0]['prisma'],
      site: 'eugene',
      hauls: [buildHaul('H-SAME')],
      scrapedAt: NOW,
      now: NOW,
    });
    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(0);
    expect(prisma._spies.expectedUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = prisma._spies.expectedUpdate.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    // Bare last_synced_at + cancelled_at touch — NOT a full row update
    expect(Object.keys(updateArgs.data).sort()).toEqual(['cancelled_at', 'last_synced_at']);
    expect(prisma._spies.auditCreate).not.toHaveBeenCalled();
  });

  it('writes a full update + audit row when unit count changes', async () => {
    const map = new Map<string, ExistingExpected | null>([['H-CHG', existingMatching()]]);
    const prisma = buildPrismaMock({
      sources: [{ id: 'src-1', name: 'Source Alpha' }],
      transporters: [{ id: 'tx-1', name: 'Carrier One' }],
      existingByHaulId: map,
    });
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as Parameters<typeof upsertScrapedHauls>[0]['prisma'],
      site: 'eugene',
      hauls: [buildHaul('H-CHG', { expected_unit_count: 75 })],
      scrapedAt: NOW,
      now: NOW,
    });
    expect(summary.updated).toBe(1);
    const auditArgs = prisma._spies.auditCreate.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(auditArgs.data['action']).toBe('update');
  });

  it('un-cancels a previously cancelled haul that re-appears in MyMRC', async () => {
    const cancelledRow = { ...existingMatching(), cancelled_at: new Date('2026-05-05T00:00:00Z') };
    const map = new Map<string, ExistingExpected | null>([['H-RE', cancelledRow]]);
    const prisma = buildPrismaMock({
      sources: [{ id: 'src-1', name: 'Source Alpha' }],
      transporters: [{ id: 'tx-1', name: 'Carrier One' }],
      existingByHaulId: map,
    });
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as Parameters<typeof upsertScrapedHauls>[0]['prisma'],
      site: 'eugene',
      hauls: [buildHaul('H-RE')],
      scrapedAt: NOW,
      now: NOW,
    });
    expect(summary.updated).toBe(1);
  });
});

describe('upsertScrapedHauls — stale cancellation', () => {
  it('cancels in-window stale rows (cancelled_at = now) + writes soft_delete audit', async () => {
    const stale = [
      {
        id: 'stale-1',
        external_mymrc_haul_id: 'H-GONE',
        cancelled_at: null,
      },
      {
        id: 'stale-2',
        external_mymrc_haul_id: 'H-STILL-THERE',
        cancelled_at: null,
      },
    ];
    const prisma = buildPrismaMock({
      sources: [{ id: 'src-1', name: 'Source Alpha' }],
      transporters: [{ id: 'tx-1', name: 'Carrier One' }],
      staleRows: stale,
    });
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as Parameters<typeof upsertScrapedHauls>[0]['prisma'],
      site: 'eugene',
      hauls: [buildHaul('H-STILL-THERE')],
      scrapedAt: NOW,
      now: NOW,
    });
    expect(summary.cancelled).toBe(1);
    // 1 insert audit + 1 cancel audit
    expect(prisma._spies.auditCreate).toHaveBeenCalledTimes(2);
    const lastAudit = prisma._spies.auditCreate.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(lastAudit.data['action']).toBe('soft_delete');
    expect(lastAudit.data['row_id']).toBe('stale-1');
    // The cancellation update payload should set cancelled_at to NOW
    const cancelUpdate = prisma._spies.expectedUpdate.mock.calls.find(
      (c) => (c[0] as { where: { id: string } }).where.id === 'stale-1',
    );
    expect(cancelUpdate).toBeDefined();
    const cancelData = (cancelUpdate![0] as { data: { cancelled_at: Date } }).data;
    expect(cancelData.cancelled_at.toISOString()).toBe(NOW.toISOString());
  });

  it('NEVER cancels a manually-entered row (source=manual protection, ADR-0038 D2)', async () => {
    // An operator's manual expected load (non-"H-" id) sits in the scrape window
    // but is absent from the current MyMRC scrape. It must survive untouched —
    // Janette's manual morning entries must never be clobbered (mission §8).
    const stale = [
      { id: 'manual-1', external_mymrc_haul_id: 'MANUAL-am-entry-1', cancelled_at: null },
      { id: 'mymrc-gone', external_mymrc_haul_id: 'H-GONE', cancelled_at: null },
    ];
    const prisma = buildPrismaMock({
      sources: [{ id: 'src-1', name: 'Source Alpha' }],
      transporters: [{ id: 'tx-1', name: 'Carrier One' }],
      staleRows: stale,
    });
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as Parameters<typeof upsertScrapedHauls>[0]['prisma'],
      site: 'eugene',
      hauls: [buildHaul('H-STILL-THERE')],
      scrapedAt: NOW,
      now: NOW,
    });
    // Only the MyMRC-owned "H-GONE" is cancelled; the manual row is protected.
    expect(summary.cancelled).toBe(1);
    const cancelledIds = prisma._spies.expectedUpdate.mock.calls.map(
      (c) => (c[0] as { where: { id: string } }).where.id,
    );
    expect(cancelledIds).toContain('mymrc-gone');
    expect(cancelledIds).not.toContain('manual-1');
  });
});
