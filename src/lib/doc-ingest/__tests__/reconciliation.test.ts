// ADR-0069 — the reconciliation read: spreadsheet figure vs. Vision figure.
//
// This is the measuring device for "has Vision taken this over yet?", so the tests
// that matter are the ones that stop it giving a reassuring answer:
//
//   - the coverage window, so a July workbook does not report 900 days of 2023
//     MyMRC history as "missing from the spreadsheet" and bury the real findings;
//   - one voice per document, so a superseded revision does not get counted
//     alongside the current one and double a day;
//   - exact comparison, so a half-unit difference is a difference.
//
// A purpose-built store stands in for Prisma here rather than the shared
// doc-ingest fake: this module's reads traverse a RELATION filter
// (`doc_source: { site_id: … }`) and a relation `select`, and teaching the shared
// fake to fake relation traversal would make it a worse stand-in for every other
// test that uses it. The store below implements exactly the four reads this module
// performs, with real filtering.

import { describe, it, expect } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { reconcileReference } from '../reconciliation';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

interface SeedVersion {
  id: string;
  docSourceId: string;
  siteId: string;
  displayName: string;
  appliedAt: string;
  absorptionStatus?: string;
}
interface SeedReference {
  versionId: string;
  docSourceId: string;
  siteId: string;
  date: string;
  metric: 'stripped_program' | 'stripped_non_program' | 'saved_units';
  value: number;
}
interface SeedVision {
  siteId: string;
  date: string;
  program: number;
  nonProgram: number;
  saved?: number | null;
}

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function makeDb(seed: {
  versions: SeedVersion[];
  references: SeedReference[];
  vision: SeedVision[];
}): PrismaClient {
  const sites = [
    { id: WOODLAND, name: 'DR3 Woodland' },
    { id: EUGENE, name: 'DR3 Eugene' },
  ];

  return {
    site: {
      async findMany({ where }: { where: { id: { in: string[] } } }) {
        return sites
          .filter((s) => where.id.in.includes(s.id))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
    },
    docSourceVersion: {
      async findMany({
        where,
      }: {
        where: { absorption_status: string; doc_source: { site_id: { in: string[] } } };
      }) {
        return seed.versions
          .filter(
            (v) =>
              (v.absorptionStatus ?? 'absorbed') === where.absorption_status &&
              where.doc_source.site_id.in.includes(v.siteId),
          )
          .map((v) => ({
            id: v.id,
            doc_source_id: v.docSourceId,
            applied_at: new Date(v.appliedAt),
            doc_source: { display_name: v.displayName },
          }))
          .sort((a, b) => b.applied_at.getTime() - a.applied_at.getTime());
      },
    },
    docReferenceRow: {
      async findMany({
        where,
      }: {
        where: {
          site_id: { in: string[] };
          doc_source_version_id: { in: string[] };
          production_date: { gte: Date; lte: Date };
        };
      }) {
        return seed.references
          .filter(
            (r) =>
              where.site_id.in.includes(r.siteId) &&
              where.doc_source_version_id.in.includes(r.versionId) &&
              day(r.date) >= where.production_date.gte &&
              day(r.date) <= where.production_date.lte,
          )
          .map((r) => ({
            site_id: r.siteId,
            production_date: day(r.date),
            metric: r.metric,
            value: new Prisma.Decimal(r.value),
            doc_source_id: r.docSourceId,
            doc_source_version_id: r.versionId,
          }));
      },
    },
    processedUnitsDaily: {
      async findMany({
        where,
      }: {
        where: { site_id: { in: string[] }; production_date: { gte: Date; lte: Date } };
      }) {
        return seed.vision
          .filter(
            (v) =>
              where.site_id.in.includes(v.siteId) &&
              day(v.date) >= where.production_date.gte &&
              day(v.date) <= where.production_date.lte,
          )
          .map((v) => ({
            site_id: v.siteId,
            production_date: day(v.date),
            stripped_program: new Prisma.Decimal(v.program),
            stripped_non_program: new Prisma.Decimal(v.nonProgram),
            saved_units:
              v.saved === undefined || v.saved === null ? null : new Prisma.Decimal(v.saved),
          }));
      },
    },
  } as unknown as PrismaClient;
}

const V1: SeedVersion = {
  id: 'ver-1',
  docSourceId: 'src-1',
  siteId: WOODLAND,
  displayName: 'JULY 2026 DAILY LOG WOODLAND.xlsm',
  appliedAt: '2026-07-20T00:00:00.000Z',
};

describe('reconcileReference (ADR-0069)', () => {
  it('reports agreement, and disagreement with the signed delta', async () => {
    const db = makeDb({
      versions: [V1],
      references: [
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-07-01',
          metric: 'stripped_program',
          value: 120,
        },
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-07-02',
          metric: 'stripped_program',
          value: 130,
        },
      ],
      vision: [
        { siteId: WOODLAND, date: '2026-07-01', program: 120, nonProgram: 0 },
        { siteId: WOODLAND, date: '2026-07-02', program: 125, nonProgram: 0 },
      ],
    });

    const out = await reconcileReference({
      db,
      siteIds: [WOODLAND],
      from: '2026-07-01',
      to: '2026-07-31',
    });
    const byDay = new Map(
      out.rows.filter((r) => r.metric === 'stripped_program').map((r) => [r.productionDate, r]),
    );

    expect(byDay.get('2026-07-01')?.status).toBe('agree');
    expect(byDay.get('2026-07-01')?.delta).toBe(0);
    expect(byDay.get('2026-07-02')?.status).toBe('disagree');
    expect(byDay.get('2026-07-02')?.delta).toBe(5);
    expect(byDay.get('2026-07-02')?.documentName).toBe('JULY 2026 DAILY LOG WOODLAND.xlsm');
  });

  it('compares EXACTLY — a half unit is a disagreement, not a rounding artefact', async () => {
    const db = makeDb({
      versions: [V1],
      references: [
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-07-01',
          metric: 'stripped_program',
          value: 120.5,
        },
      ],
      vision: [{ siteId: WOODLAND, date: '2026-07-01', program: 120, nonProgram: 0 }],
    });

    const out = await reconcileReference({
      db,
      siteIds: [WOODLAND],
      from: '2026-07-01',
      to: '2026-07-31',
    });
    const row = out.rows.find((r) => r.metric === 'stripped_program');
    expect(row?.status).toBe('disagree');
    expect(row?.delta).toBe(0.5);
  });

  it('flags a spreadsheet day Vision has no row for', async () => {
    const db = makeDb({
      versions: [V1],
      references: [
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-07-03',
          metric: 'stripped_program',
          value: 88,
        },
      ],
      vision: [],
    });

    const out = await reconcileReference({
      db,
      siteIds: [WOODLAND],
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(out.rows[0]?.status).toBe('missing_in_vision');
    expect(out.rows[0]?.delta).toBeNull();
    expect(out.summaries[0]?.missingInVision).toBe(1);
  });

  it('bounds missing_in_reference by the COVERAGE WINDOW, so history is not noise', async () => {
    const db = makeDb({
      versions: [V1],
      references: [
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-07-01',
          metric: 'stripped_program',
          value: 120,
        },
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-07-03',
          metric: 'stripped_program',
          value: 100,
        },
      ],
      vision: [
        { siteId: WOODLAND, date: '2026-07-01', program: 120, nonProgram: 0 },
        // INSIDE the covered span (07-01 .. 07-03) and unmentioned → a finding.
        { siteId: WOODLAND, date: '2026-07-02', program: 77, nonProgram: 0 },
        { siteId: WOODLAND, date: '2026-07-03', program: 100, nonProgram: 0 },
        // OUTSIDE it. The workbook says nothing about this day and never claimed to.
        { siteId: WOODLAND, date: '2026-07-20', program: 55, nonProgram: 0 },
      ],
    });

    const out = await reconcileReference({
      db,
      siteIds: [WOODLAND],
      from: '2026-07-01',
      to: '2026-07-31',
    });
    const missing = out.rows.filter((r) => r.status === 'missing_in_reference');

    expect(missing.map((r) => r.productionDate)).toEqual(['2026-07-02']);
    expect(missing.every((r) => r.metric === 'stripped_program')).toBe(true);
    expect(out.summaries[0]?.coverageFrom).toBe('2026-07-01');
    expect(out.summaries[0]?.coverageTo).toBe('2026-07-03');
    expect(out.summaries[0]?.daysCovered).toBe(2);
  });

  it('counts ONE voice per document — a superseded revision does not double a day', async () => {
    const db = makeDb({
      versions: [V1, { ...V1, id: 'ver-2', appliedAt: '2026-07-25T00:00:00.000Z' }],
      references: [
        // The old revision said 120; the current one says 130. Only 130 counts.
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-07-01',
          metric: 'stripped_program',
          value: 120,
        },
        {
          versionId: 'ver-2',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-07-01',
          metric: 'stripped_program',
          value: 130,
        },
      ],
      vision: [{ siteId: WOODLAND, date: '2026-07-01', program: 130, nonProgram: 0 }],
    });

    const out = await reconcileReference({
      db,
      siteIds: [WOODLAND],
      from: '2026-07-01',
      to: '2026-07-31',
    });
    const program = out.rows.filter((r) => r.metric === 'stripped_program');

    expect(program).toHaveLength(1);
    expect(program[0]?.referenceValue).toBe(130);
    expect(program[0]?.status).toBe('agree');
    expect(out.summaries[0]?.disagree).toBe(0);
  });

  it('honours the requested window', async () => {
    const db = makeDb({
      versions: [V1],
      references: [
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-06-30',
          metric: 'stripped_program',
          value: 1,
        },
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-07-01',
          metric: 'stripped_program',
          value: 2,
        },
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-08-01',
          metric: 'stripped_program',
          value: 3,
        },
      ],
      vision: [],
    });

    const out = await reconcileReference({
      db,
      siteIds: [WOODLAND],
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(out.rows.map((r) => r.productionDate)).toEqual(['2026-07-01']);
  });

  it('never leaks another site into a caller confined to one', async () => {
    const db = makeDb({
      versions: [
        V1,
        { ...V1, id: 'ver-e', docSourceId: 'src-e', siteId: EUGENE, displayName: 'EUGENE.xlsm' },
      ],
      references: [
        {
          versionId: 'ver-1',
          docSourceId: 'src-1',
          siteId: WOODLAND,
          date: '2026-07-01',
          metric: 'stripped_program',
          value: 1,
        },
        {
          versionId: 'ver-e',
          docSourceId: 'src-e',
          siteId: EUGENE,
          date: '2026-07-01',
          metric: 'stripped_program',
          value: 9,
        },
      ],
      vision: [{ siteId: EUGENE, date: '2026-07-01', program: 9, nonProgram: 0 }],
    });

    const out = await reconcileReference({
      db,
      siteIds: [WOODLAND],
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(out.rows.every((r) => r.siteId === WOODLAND)).toBe(true);
    expect(out.summaries.map((s) => s.siteId)).toEqual([WOODLAND]);
  });

  it('returns an empty result rather than throwing when the caller reaches no sites', async () => {
    const db = makeDb({ versions: [], references: [], vision: [] });
    const out = await reconcileReference({ db, siteIds: [], from: '2026-07-01', to: '2026-07-31' });
    expect(out.rows).toEqual([]);
    expect(out.summaries).toEqual([]);
  });
});
