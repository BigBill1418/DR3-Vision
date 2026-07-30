// ADR-0049 D11/D12 — daily-production adapter.
//
// The property under test is NOT "does it produce rows". It is: does it produce
// rows ONLY when it actually resolved them, and does every other outcome arrive
// as a REFUSAL with a reason. A guessed column and a silent zero are the two
// failure modes that would put wrong figures into `processed_units_daily` under
// workbook-wins, so each guard here is asserted from both sides.

import { describe, expect, it } from 'vitest';
import { buildFixtureWorkbookBytes } from '@/lib/msgraph-files';
import {
  buildUnrecognizedWorkbook,
  buildWoodlandDailyLogWorkbook,
} from '@/lib/audit/workbook/__fixtures__/build-woodland-workbook';
import { buildGenerationWorkbook } from '@/lib/audit/workbook/__fixtures__/build-workbook';
import { inMemoryAliasResolver } from '@/lib/audit/workbook/site-alias';
import { parseDailyRows, type DailySiteScope } from './daily-adapter';

const SITE = 'site-woodland';

function scope(entries: Parameters<typeof inMemoryAliasResolver>[0]): DailySiteScope {
  return { siteId: SITE, resolver: inMemoryAliasResolver(entries) };
}

describe('parseDailyRows — the real Woodland layout', () => {
  it('derives per-day rows from the semantic parse, not from fixed columns', async () => {
    const res = await parseDailyRows(await buildWoodlandDailyLogWorkbook());

    expect(res.failure).toBeNull();
    expect(res.templateGeneration).toBe('woodland_daily');
    expect(res.daysSeen).toBe(2);
    // The Processed sheet's Day 1 / Day 2 rows: D=stripped program, E=non-program,
    // J=material ticket. Dates are built from "Day N" + the workbook's own month.
    expect(res.rows).toEqual([
      {
        productionDate: '2026-06-01',
        strippedProgram: 120,
        strippedNonProgram: 0,
        materialTicketNumber: 'M-100001',
        employeesCount: null,
        processorsCount: null,
        savedUnits: null,
      },
      {
        productionDate: '2026-06-02',
        strippedProgram: 2,
        strippedNonProgram: 0,
        materialTicketNumber: 'M-100002',
        employeesCount: null,
        processorsCount: null,
        savedUnits: null,
      },
    ]);
  });

  it('leaves employees/processors NULL — the Processed sheet carries no such column', async () => {
    // Documented, not incidental: the real workbook has no headcount columns, so
    // the adapter reports "the workbook did not state one". It never invents a
    // number for a field it could not resolve.
    const res = await parseDailyRows(await buildWoodlandDailyLogWorkbook());
    expect(res.rows.every((r) => r.employeesCount === null && r.processorsCount === null)).toBe(
      true,
    );
  });
});

describe('parseDailyRows — the mock fixture (same shape as the real file)', () => {
  it('parses clean days and counts a mid-edit day separately (3 clean + 1 mid-edit)', async () => {
    const res = await parseDailyRows(await buildFixtureWorkbookBytes());

    expect(res.failure).toBeNull();
    expect(res.rows).toHaveLength(3);
    expect(res.daysSeen).toBe(4);
    expect(res.midEditCount).toBe(1);
    expect(res.skipped).toEqual([
      expect.objectContaining({ label: 'day_4', reason: 'stripped_program_unusable' }),
    ]);
    expect(res.rows[0]).toMatchObject({
      productionDate: '2026-06-01',
      strippedProgram: 150,
      strippedNonProgram: 25,
      materialTicketNumber: 'M-000401',
    });
  });

  it('a mid-edit day is SKIPPED, never written as zero', async () => {
    const res = await parseDailyRows(await buildFixtureWorkbookBytes());
    expect(res.rows.some((r) => r.productionDate === '2026-06-04')).toBe(false);
    expect(res.rows.some((r) => r.strippedProgram === 0)).toBe(false);
  });

  it('a day whose stripped_program is later filled in is no longer mid-edit', async () => {
    const res = await parseDailyRows(
      await buildFixtureWorkbookBytes({
        daily: [
          {
            date: '2026-06-04',
            strippedProgram: 140,
            strippedNonProgram: 0,
            materialTicket: 'M-000404',
          },
        ],
      }),
    );
    expect(res.failure).toBeNull();
    expect(res.midEditCount).toBe(0);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.strippedProgram).toBe(140);
  });

  it('a BLANK stripped_non_program is skipped + counted, not defaulted to 0', async () => {
    // The old adapter wrote `?? 0` here. A zero non-program figure is a billed
    // fact; a blank cell is not that fact.
    const res = await parseDailyRows(
      await buildFixtureWorkbookBytes({
        daily: [
          { date: '2026-06-01', strippedProgram: 150, strippedNonProgram: 25 },
          { date: '2026-06-02', strippedProgram: 175, strippedNonProgram: null },
        ],
      }),
    );
    expect(res.failure).toBeNull();
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.productionDate).toBe('2026-06-01');
    expect(res.midEditCount).toBe(1);
    expect(res.skipped[0]).toMatchObject({
      label: 'day_2',
      reason: 'stripped_non_program_unusable',
    });
  });

  it("reads saved_units from the DAY sheet's own labelled Saved cell", async () => {
    const res = await parseDailyRows(
      await buildFixtureWorkbookBytes({
        daily: [
          { date: '2026-06-01', strippedProgram: 150, strippedNonProgram: 0, savedUnits: 7 },
          { date: '2026-06-02', strippedProgram: 175, strippedNonProgram: 0 },
        ],
      }),
    );
    expect(res.rows[0]!.savedUnits).toBe(7);
    // No "Saved" label on DAY2 ⇒ null, NOT 0.
    expect(res.rows[1]!.savedUnits).toBeNull();
  });
});

describe('parseDailyRows — template generations', () => {
  it('refuses an UNKNOWN generation rather than parsing hopefully', async () => {
    const res = await parseDailyRows(await buildUnrecognizedWorkbook());

    expect(res.templateGeneration).toBe('unknown');
    expect(res.rows).toHaveLength(0);
    expect(res.failure?.kind).toBe('unknown_template_generation');
    expect(res.failure?.message).toMatch(/no Woodland daily-log section resolved/i);
  });

  // The legacy ADR-0039 generations are retro-audit shapes: they carry Summary /
  // Inbound / Outbound figures but NO per-day production section. Pointing the
  // sync at one must fail loudly — it is the wrong kind of workbook, not an
  // empty one.
  it.each(['no_calc', 'calc', 'eod_carryover'] as const)(
    'recognises the %s generation and refuses it for lack of a daily section',
    async (generation) => {
      const res = await parseDailyRows(await buildGenerationWorkbook(generation));

      expect(res.templateGeneration).toBe(generation);
      expect(res.rows).toHaveLength(0);
      expect(res.failure?.kind).toBe('daily_section_unresolved');
      expect(res.failure?.message).toMatch(/"cannot read", not "no production"/);
    },
  );

  it('parses the woodland_daily generation', async () => {
    const res = await parseDailyRows(await buildWoodlandDailyLogWorkbook());
    expect(res.templateGeneration).toBe('woodland_daily');
    expect(res.rows.length).toBeGreaterThan(0);
  });
});

describe('parseDailyRows — cannot-read vs no-data', () => {
  it('refuses a workbook whose Processed sheet is GONE (layout, not emptiness)', async () => {
    const res = await parseDailyRows(
      await buildFixtureWorkbookBytes({
        daily: [{ date: '2026-06-01', strippedProgram: 150, strippedNonProgram: 25 }],
        omitProcessedSheet: true,
      }),
    );
    expect(res.rows).toHaveLength(0);
    expect(res.failure?.kind).toBe('daily_section_unresolved');
    expect(res.failure?.message).toMatch(/Nothing was written/);
  });

  it('refuses a workbook whose Processed tab drifted past recognition', async () => {
    const res = await parseDailyRows(
      await buildFixtureWorkbookBytes({
        daily: [{ date: '2026-06-01', strippedProgram: 150, strippedNonProgram: 25 }],
        processedSheetNameOverride: 'Sheet17',
      }),
    );
    expect(res.rows).toHaveLength(0);
    expect(res.failure?.kind).toBe('daily_section_unresolved');
  });

  it('refuses when the workbook MONTH cannot be derived, and says so', async () => {
    // The Processed sheet is present and recognised, but "Day N" cannot be dated
    // without a dated DAY inbound row, so no daily-close row is ever built.
    const res = await parseDailyRows(
      await buildFixtureWorkbookBytes({
        daily: [{ date: '2026-06-01', strippedProgram: 150, strippedNonProgram: 25 }],
        summary: [{ key: 'processed_units_total', value: 150 }],
        omitDaySheets: true,
      }),
    );
    expect(res.rows).toHaveLength(0);
    expect(res.failure?.kind).toBe('daily_section_unresolved');
    // The parser's own note is carried through so the operator gets the cause.
    expect(res.failure?.message).toMatch(/cannot derive workbook month/i);
  });

  it('a legitimately EMPTY month is not an error — it is zero rows and no failure', async () => {
    const res = await parseDailyRows(
      await buildFixtureWorkbookBytes({ daily: [], month: '2026-07' }),
    );

    expect(res.failure).toBeNull();
    expect(res.rows).toHaveLength(0);
    expect(res.daysSeen).toBe(0);
    expect(res.midEditCount).toBe(0);
  });

  it('refuses when days ARE present but not one is usable', async () => {
    const res = await parseDailyRows(
      await buildFixtureWorkbookBytes({
        daily: [
          { date: '2026-06-01', strippedProgram: null, strippedNonProgram: 0 },
          { date: '2026-06-02', strippedProgram: null, strippedNonProgram: 0 },
        ],
      }),
    );
    expect(res.rows).toHaveLength(0);
    expect(res.daysSeen).toBe(2);
    expect(res.midEditCount).toBe(2);
    expect(res.failure?.kind).toBe('all_days_unusable');
    // The reason names the day and the cell, so the operator can open the file on it.
    expect(res.failure?.message).toMatch(/day_1 stripped_program_unusable @ .+!D\d+/);
  });

  it('refuses when one date appears twice with DIFFERENT figures', async () => {
    const res = await parseDailyRows(
      await buildFixtureWorkbookBytes({
        daily: [
          { date: '2026-06-01', strippedProgram: 150, strippedNonProgram: 25 },
          { date: '2026-06-01', strippedProgram: 151, strippedNonProgram: 25 },
        ],
      }),
    );
    expect(res.rows).toHaveLength(0);
    expect(res.failure?.kind).toBe('conflicting_duplicate_days');
    expect(res.failure?.message).toMatch(/Choosing one would be a guess/);
  });
});

describe('parseDailyRows — wrong-workbook cross-check (site-alias)', () => {
  const woodlandRow = {
    date: '2026-06-01',
    strippedProgram: 150,
    strippedNonProgram: 25,
  } as const;

  it('tolerates site-name DRIFT: an aliased spelling still resolves in-site', async () => {
    const bytes = await buildFixtureWorkbookBytes({
      // The workbook's own spelling drift (Addendum B §B7 shape).
      daily: [{ ...woodlandRow, inboundSite: 'Bass Hil Landfil' }],
    });
    const res = await parseDailyRows(
      bytes,
      scope({
        'Bass Hill Landfill': {
          siteId: SITE,
          canonicalName: 'Bass Hill Landfill',
          isNonProgram: false,
        },
        'Bass Hil Landfil': {
          siteId: SITE,
          canonicalName: 'Bass Hill Landfill',
          isNonProgram: false,
        },
      }),
    );
    expect(res.failure).toBeNull();
    expect(res.rows).toHaveLength(1);
  });

  it('refuses a workbook whose every resolvable source belongs to ANOTHER site', async () => {
    const bytes = await buildFixtureWorkbookBytes({
      daily: [{ ...woodlandRow, inboundSite: 'Yolo Landfill' }],
    });
    const res = await parseDailyRows(
      bytes,
      scope({
        'Yolo Landfill': {
          siteId: 'site-elsewhere',
          canonicalName: 'Yolo Landfill',
          isNonProgram: false,
        },
      }),
    );
    expect(res.rows).toHaveLength(0);
    expect(res.failure?.kind).toBe('wrong_site');
    expect(res.failure?.message).toMatch(/site-elsewhere/);
  });

  it('does not refuse on names it cannot resolve — an unknown name proves nothing', async () => {
    const bytes = await buildFixtureWorkbookBytes({ daily: [{ ...woodlandRow }] });
    const res = await parseDailyRows(bytes, scope({}));
    expect(res.failure).toBeNull();
    expect(res.rows).toHaveLength(1);
  });

  it('one in-site match clears the check even alongside a foreign name', async () => {
    const bytes = await buildFixtureWorkbookBytes({
      daily: [
        { ...woodlandRow, inboundSite: 'Bass Hill Landfill' },
        { date: '2026-06-02', strippedProgram: 10, strippedNonProgram: 0, inboundSite: 'Far Site' },
      ],
    });
    const res = await parseDailyRows(
      bytes,
      scope({
        'Bass Hill Landfill': {
          siteId: SITE,
          canonicalName: 'Bass Hill Landfill',
          isNonProgram: false,
        },
        'Far Site': { siteId: 'site-elsewhere', canonicalName: 'Far Site', isNonProgram: false },
      }),
    );
    expect(res.failure).toBeNull();
    expect(res.rows).toHaveLength(2);
  });
});
