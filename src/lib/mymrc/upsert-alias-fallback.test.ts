// ADR-0037 amendment (rollup §12) — source_aliases fallback in the MyMRC intake.
//
// The scraper's exact-verbatim `sources.name` match stays primary (the
// reconciliation join key). A name that misses it gets ONE second chance:
// a site-scoped, normalized (trim/lowercase/collapse-ws) lookup over the
// site's canonical names + `source_aliases`. Unmatched names still persist
// `source_id = null` + `source_name_at_sync` and are warned once per run —
// never guessed.

import { describe, expect, it, vi } from 'vitest';
import { upsertScrapedHauls } from './upsert';
import type { ScrapedHaul } from './types';
import type { Logger } from './sync';

const SALEM = 'St Vincent De Paul Of Lane County - Salem Thrift Store';
const ALBANY = 'ST Vincent De Paul OF Lane County-Albany Thrift Store';

interface SeedSource {
  id: string;
  name: string;
  aliases: { alias: string }[];
}

const SITE_SOURCES: SeedSource[] = [
  {
    id: 's-salem',
    name: SALEM,
    aliases: [{ alias: 'Salem-Keizer Recycling Center' }, { alias: 'Salem SVDP' }, { alias: 'SVDP Salem' }],
  },
  {
    id: 's-albany',
    name: ALBANY,
    aliases: [{ alias: 'SVDP Albany' }, { alias: 'SvdP Albany' }, { alias: 'Albany' }],
  },
];

function haul(id: string, sourceName: string): ScrapedHaul {
  return {
    external_mymrc_haul_id: id,
    expected_arrival_at: new Date('2026-07-22T12:00:00.000Z'),
    source_name: sourceName,
    transporter_name: null,
    expected_unit_count: 40,
    bol_number: null,
    scheduled_at_mymrc: null,
  };
}

/**
 * Mock prisma honoring the two distinct `source.findMany` call shapes:
 *   1. verbatim prefetch — `where.name.in` (returns exact-name hits, no aliases)
 *   2. alias fallback    — `where.site_id` only (returns sources WITH aliases)
 */
function buildPrisma() {
  const created: Record<string, unknown>[] = [];
  const sourceFindMany = vi.fn(
    async (args: { where: { name?: { in: string[] }; site_id?: string }; select: unknown }) => {
      if (args.where.name?.in) {
        return SITE_SOURCES.filter((s) => args.where.name!.in.includes(s.name)).map((s) => ({
          id: s.id,
          name: s.name,
        }));
      }
      return SITE_SOURCES.map((s) => ({ id: s.id, name: s.name, aliases: s.aliases }));
    },
  );
  return {
    prisma: {
      site: { findUnique: vi.fn(async () => ({ id: 'site-eugene' })) },
      source: { findMany: sourceFindMany },
      transporter: { findMany: vi.fn(async () => []) },
      expectedLoad: {
        findMany: vi.fn(async (args: { where?: { external_mymrc_haul_id?: unknown } }) =>
          args.where?.external_mymrc_haul_id ? [] : [],
        ),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { id: `el-${created.length}` };
        }),
        update: vi.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })),
      },
      auditLog: { create: vi.fn(async () => ({ id: 'a1' })) },
    },
    created,
    sourceFindMany,
  };
}

type PrismaParam = Parameters<typeof upsertScrapedHauls>[0]['prisma'];
const NOW = new Date('2026-07-21T18:00:00.000Z');

describe('mymrc upsert — source_aliases fallback (rollup §12)', () => {
  it('resolves a drifted workbook-style name via its alias and sets the FK', async () => {
    const { prisma, created } = buildPrisma();
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as PrismaParam,
      site: 'eugene',
      hauls: [haul('H-1001', 'Salem SVDP')],
      scrapedAt: NOW,
      now: NOW,
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.['source_id']).toBe('s-salem');
    expect(created[0]?.['source_name_at_sync']).toBe('Salem SVDP'); // verbatim retained
    expect(summary.unmatched_source_count).toBe(0);
    expect(summary.alias_resolved_source_names).toEqual(['Salem SVDP']);
  });

  it('matches case- and whitespace-insensitively (canonical AND alias forms)', async () => {
    const { prisma, created } = buildPrisma();
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as PrismaParam,
      site: 'eugene',
      hauls: [haul('H-1002', 'sVDP albany'), haul('H-1003', `  ${SALEM.toUpperCase()}  `)],
      scrapedAt: NOW,
      now: NOW,
    });
    expect(created[0]?.['source_id']).toBe('s-albany');
    expect(created[1]?.['source_id']).toBe('s-salem');
    expect(summary.unmatched_source_count).toBe(0);
    expect(summary.alias_resolved_source_names.sort()).toEqual([
      `  ${SALEM.toUpperCase()}  `,
      'sVDP albany',
    ]);
  });

  it('an exact verbatim match never triggers the fallback query', async () => {
    const { prisma, created, sourceFindMany } = buildPrisma();
    await upsertScrapedHauls({
      prisma: prisma as unknown as PrismaParam,
      site: 'eugene',
      hauls: [haul('H-1004', SALEM)],
      scrapedAt: NOW,
      now: NOW,
    });
    expect(created[0]?.['source_id']).toBe('s-salem');
    expect(sourceFindMany).toHaveBeenCalledTimes(1); // verbatim prefetch only
  });

  it('an unknown name stays unmatched (source_id null), is warned, and is NEVER guessed', async () => {
    const { prisma, created } = buildPrisma();
    const logs: { level: string; message: string }[] = [];
    const log: Logger = (level, message) => logs.push({ level, message });
    const summary = await upsertScrapedHauls({
      prisma: prisma as unknown as PrismaParam,
      site: 'eugene',
      hauls: [haul('H-1005', 'Mystery Hauler Depot'), haul('H-1006', 'SVDP Albany')],
      scrapedAt: NOW,
      now: NOW,
      log,
    });
    expect(created[0]?.['source_id']).toBeNull();
    expect(created[1]?.['source_id']).toBe('s-albany');
    expect(summary.unmatched_source_count).toBe(1);
    expect(summary.unmatched_source_names).toEqual(['Mystery Hauler Depot']);
    expect(summary.alias_resolved_source_names).toEqual(['SVDP Albany']);
    const warn = logs.find((l) => l.level === 'warn');
    expect(warn?.message).toContain('Mystery Hauler Depot');
    const info = logs.find((l) => l.level === 'info');
    expect(info?.message).toContain('resolved via source_aliases');
  });
});
