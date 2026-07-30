// ADR-0049 D11/D12 — daily-production adapter tests (mid-edit tolerance).

import { describe, expect, it } from 'vitest';
import { buildFixtureWorkbookBytes } from '@/lib/msgraph-files';
import { parseDailyRows } from './daily-adapter';

describe('parseDailyRows', () => {
  it('parses clean rows and counts a mid-edit row separately (default fixture: 3 clean + 1 mid-edit)', async () => {
    const bytes = await buildFixtureWorkbookBytes();
    const { rows, midEditCount } = await parseDailyRows(bytes);
    expect(rows).toHaveLength(3);
    expect(midEditCount).toBe(1);
    expect(rows[0]).toMatchObject({
      productionDate: '2026-06-01',
      strippedProgram: 150,
      strippedNonProgram: 25,
    });
  });

  it('a row whose stripped_program is later filled in is no longer mid-edit', async () => {
    const bytes = await buildFixtureWorkbookBytes({
      daily: [{ date: '2026-06-04', strippedProgram: 140, materialTicket: 'M-000404' }],
    });
    const { rows, midEditCount } = await parseDailyRows(bytes);
    expect(midEditCount).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strippedProgram).toBe(140);
  });

  it('returns nothing (no rows, no mid-edit) when the Daily sheet is absent', async () => {
    const bytes = await buildFixtureWorkbookBytes({ daily: [], summary: [{ key: 'x', value: 1 }] });
    const { rows, midEditCount } = await parseDailyRows(bytes);
    expect(rows).toHaveLength(0);
    expect(midEditCount).toBe(0);
  });
});
