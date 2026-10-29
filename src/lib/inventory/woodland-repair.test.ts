// ADR-0143 item 8 — the Woodland repair planner (pure). The DB path is in
// woodland-repair.db.test.ts. Nothing here touches production.
import { describe, expect, it } from 'vitest';
import {
  parseArgs,
  planRepair,
  RepairRefused,
} from '../../../scripts/propose-woodland-pool-repair.mjs';

describe('planRepair (R-B, Bill 2026-10-29)', () => {
  it('Woodland as measured: -247 / +644 / 397 → program 0, non-program 397, total 397 unchanged', () => {
    expect(planRepair({ program: '-247', nonProgram: '644', total: '397' }, 247)).toEqual({
      units: 247,
      before: { program: -247, nonProgram: 644, total: 397 },
      after: { program: 0, nonProgram: 397, total: 397 },
    });
  });

  it('refuses when the shortfall moved since it was measured (no silent different repair)', () => {
    expect(() =>
      planRepair({ program: '-250', nonProgram: '647', total: '397' }, 247),
    ).toThrowError(/shortfall is 250, expected 247/);
  });

  it('refuses when there is nothing to repair, or the split would push non-program below zero', () => {
    expect(() => planRepair({ program: '0', nonProgram: '397', total: '397' }, 247)).toThrowError(
      RepairRefused,
    );
    expect(() =>
      planRepair({ program: '-247', nonProgram: '100', total: '-147' }, 247),
    ).toThrowError(/non-program pool would go below zero/);
  });

  it('dry run is the default; --apply is explicit', () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      siteCode: 'woodland',
      day: '2026-10-08',
      expectUnits: 247,
    });
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(() => parseArgs(['--force'])).toThrowError(/unknown argument/);
  });
});
