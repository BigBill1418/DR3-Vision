// ADR-0037 amendment (rollup §12) — promotion-time source resolution + linkage.
//
// June/July workbook promotion must RESOLVE every inbound customer name (via
// canonical names + source_aliases, case-insensitively) and LINK the promoted
// `inbound_loads` row to its Source (`source_id`). Unmatched names are never
// guessed: the whole promotion refuses with a PromotionUnresolvedSourceError
// listing every offender once, so the operator can seed an alias and re-run.
// A name resolving to ANOTHER site's source is treated as unresolved (hard
// rule #2 site scoping — a Woodland workbook cannot link a Eugene source).

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { inMemoryAliasResolver } from './workbook/site-alias';
import {
  decodeStagingRows,
  promoteWorkbookImport,
  PromotionUnresolvedSourceError,
  type PromotionScope,
  type StagingRowInput,
} from './workbook-promotion';

const SITE = 'site-eugene';
const IMPORT = 'imp-alias-1';
const SCOPE: PromotionScope = { siteId: SITE, from: '2026-06-01', to: '2026-06-30' };

const ALBANY = 'ST Vincent De Paul OF Lane County-Albany Thrift Store';

// Mirrors the seeded resolver surface: canonical name + drifted aliases → sourceId.
const RESOLVER = inMemoryAliasResolver({
  [ALBANY]: { sourceId: 'src-albany', siteId: SITE, canonicalName: ALBANY, isNonProgram: false },
  'SVDP Albany': { sourceId: 'src-albany', siteId: SITE, canonicalName: ALBANY, isNonProgram: false },
  'Salem-Keizer Recycling Center': {
    sourceId: 'src-salem',
    siteId: SITE,
    canonicalName: 'St Vincent De Paul Of Lane County - Salem Thrift Store',
    isNonProgram: false,
  },
  'Chester Transfer': {
    sourceId: 'src-chester',
    siteId: 'site-woodland', // WRONG site for this scope — must not link
    canonicalName: 'Chester Transfer',
    isNonProgram: true,
  },
});

function inboundRow(record: Record<string, unknown>, siteName: string, rc = 1): StagingRowInput {
  return {
    section: 'inbound',
    raw_value: JSON.stringify(record),
    numeric_value: null,
    site_name_raw: siteName,
    provenance: { tab: 'Inbound', row: rc, col: 'A' },
  };
}

describe('decodeStagingRows — source resolution + linkage (rollup §12)', () => {
  it('resolves a drifted alias case-insensitively and carries the sourceId', () => {
    const rows = [inboundRow({ date: '2026-06-03', units: 25 }, 'svdp ALBANY')];
    const c = decodeStagingRows(rows, SCOPE, RESOLVER);
    expect(c.inbound).toHaveLength(1);
    expect(c.inbound[0]?.sourceId).toBe('src-albany');
    expect(c.inbound[0]?.programUnits).toBe(25); // program pool from the resolved source
  });

  it('resolves the old live-era name and still honors an explicit split (payload wins)', () => {
    const rows = [
      inboundRow(
        { date: '2026-06-05', units: 40, programUnits: 30, nonProgramUnits: 10 },
        'Salem-Keizer Recycling Center',
      ),
    ];
    const c = decodeStagingRows(rows, SCOPE, RESOLVER);
    expect(c.inbound[0]?.sourceId).toBe('src-salem');
    expect(c.inbound[0]?.programUnits).toBe(30);
    expect(c.inbound[0]?.nonProgramUnits).toBe(10);
  });

  it('refuses an unknown name even when the payload carries an explicit split — never guesses', () => {
    const rows = [
      inboundRow({ date: '2026-06-03', units: 40, programUnits: 40, nonProgramUnits: 0 }, 'Mystery Yard'),
    ];
    let err: unknown;
    try {
      decodeStagingRows(rows, SCOPE, RESOLVER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PromotionUnresolvedSourceError);
    expect((err as PromotionUnresolvedSourceError).names).toEqual(['Mystery Yard']);
  });

  it('lists every distinct unresolved name ONCE (deduped, sorted) for operator review', () => {
    const rows = [
      inboundRow({ date: '2026-06-03', units: 10 }, 'Zed Yard', 1),
      inboundRow({ date: '2026-06-04', units: 10 }, 'Alpha Yard', 2),
      inboundRow({ date: '2026-06-05', units: 10 }, 'Zed Yard', 3),
      inboundRow({ date: '2026-06-06', units: 10 }, 'SVDP Albany', 4), // resolves fine
    ];
    let err: unknown;
    try {
      decodeStagingRows(rows, SCOPE, RESOLVER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PromotionUnresolvedSourceError);
    expect((err as PromotionUnresolvedSourceError).names).toEqual(['Alpha Yard', 'Zed Yard']);
  });

  it("treats a name resolving to ANOTHER site's source as unresolved (site scoping)", () => {
    const rows = [inboundRow({ date: '2026-06-03', units: 10 }, 'Chester Transfer')];
    let err: unknown;
    try {
      decodeStagingRows(rows, SCOPE, RESOLVER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PromotionUnresolvedSourceError);
    expect((err as PromotionUnresolvedSourceError).names).toEqual(['Chester Transfer']);
  });
});

describe('promoteWorkbookImport — writes the resolved source_id', () => {
  function makeDb(staging: StagingRowInput[]): { db: PrismaClient; inbound: Record<string, unknown>[] } {
    const inbound: Record<string, unknown>[] = [];
    const promotions: Record<string, unknown>[] = [];
    let seq = 0;
    const id = () => `id-${++seq}`;
    const emptyStore = () => ({
      findMany: async () => [],
      createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: id(), ...data }),
    });
    const client = {
      workbookImport: { findUnique: async () => ({ id: IMPORT, site_id: SITE }) },
      workbookImportRow: { findMany: async () => staging },
      workbookPromotion: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const p = { id: id(), ...data };
          promotions.push(p);
          return { id: p.id };
        },
      },
      inboundLoad: {
        findMany: async () => [],
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          for (const d of data) inbound.push({ id: id(), ...d });
          return { count: data.length };
        },
      },
      siteInventorySnapshot: emptyStore(),
      processedUnitsDaily: emptyStore(),
      outboundMaterial: emptyStore(),
      landfilledUnit: emptyStore(),
      consumerDropoff: emptyStore(),
      auditLog: { create: async ({ data }: { data: unknown }) => data },
    } as unknown as PrismaClient & { $transaction: unknown };
    (client as unknown as { $transaction: (fn: (tx: unknown) => unknown) => unknown }).$transaction =
      (fn) => fn(client);
    return { db: client, inbound };
  }

  it('stamps inbound_loads.source_id from the alias-resolved Source', async () => {
    const staging = [
      inboundRow({ date: '2026-06-03', units: 25, slipNumber: 'S-9' }, 'SVDP Albany'),
      inboundRow({ date: '2026-06-04', units: 10 }, 'Salem-Keizer Recycling Center', 2),
    ];
    const { db, inbound } = makeDb(staging);
    const res = await promoteWorkbookImport({
      db,
      importId: IMPORT,
      scope: SCOPE,
      promotedByUserId: 'u1',
      resolver: RESOLVER,
    });
    expect(res.promoted).toBe(true);
    expect(inbound).toHaveLength(2);
    expect(inbound[0]?.['source_id']).toBe('src-albany');
    expect(inbound[1]?.['source_id']).toBe('src-salem');
    expect(inbound[0]?.['site_id']).toBe(SITE);
  });
});
