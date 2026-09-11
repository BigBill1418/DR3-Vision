// ADR-0058 — the one-shot backfill runner: arg parsing + the MANDATORY
// floor-invariance gate. Collaborators (bridge, prisma, probe) are injected, so
// this exercises the real gate flow with no DB, no `dist/`, no HTTP.

import { describe, expect, it, vi } from 'vitest';
import {
  parseArgs,
  floorsEqual,
  runProcessedBridgeBackfill,
} from '../../scripts/mymrc-processed-bridge-backfill.mjs';

const noopLog = () => undefined;
const floor = (program: string, nonProgram: string, total: string) => ({
  program,
  nonProgram,
  total,
});

describe('parseArgs', () => {
  it('defaults to full history, no dry-run, all sites', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, siteCodes: null, since: null, days: null });
    expect(parseArgs(['--backfill'])).toEqual({
      dryRun: false,
      siteCodes: null,
      since: null,
      days: null,
    });
  });
  it('parses --dry-run, --since, --site', () => {
    expect(parseArgs(['--dry-run', '--since=2026-07-01', '--site=woodland'])).toEqual({
      dryRun: true,
      since: '2026-07-01',
      siteCodes: ['woodland'],
      days: null,
    });
  });
  it('rejects a bad --since and an unknown flag and a bad --site', () => {
    expect(() => parseArgs(['--since=2026/07/01'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--site=portland'])).toThrow(/woodland\|eugene/);
  });
});

// BS-5 — `--days`, the narrow-blast-radius flag.
//
// `--since` is a LOWER BOUND. Repairing two 2025 rows with it re-bridges every
// production day from that date forward — 402 days against production tonight —
// and the verification ADR-0102 taught us to run ("did `updated_at` move on the
// two rows?") stops discriminating, because it moved on everything. `--days`
// names the exact set, so the write touches what the repair is about and the
// audit trail says so.
describe('parseArgs --days', () => {
  it('parses a comma list into sorted, de-duplicated ISO days', () => {
    expect(parseArgs(['--days=2025-05-15,2025-02-27,2025-05-15']).days).toEqual([
      '2025-02-27',
      '2025-05-15',
    ]);
  });
  it('rejects a malformed day', () => {
    expect(() => parseArgs(['--days=2025-02-27,15/05/2025'])).toThrow(/YYYY-MM-DD/);
  });
  it('rejects an empty list rather than silently meaning "everything"', () => {
    // The dangerous failure: `--days=` parsing to null would widen a targeted
    // repair into a full-history rewrite with no visible difference in the command.
    expect(() => parseArgs(['--days='])).toThrow(/at least one/i);
  });
  it('refuses --days together with --since', () => {
    expect(() => parseArgs(['--days=2025-02-27', '--since=2025-01-01'])).toThrow(
      /--days and --since/,
    );
  });
});

describe('floorsEqual', () => {
  it('is byte-identical on all three pools', () => {
    expect(floorsEqual(floor('1', '2', '3'), floor('1', '2', '3'))).toBe(true);
    expect(floorsEqual(floor('1', '2', '3'), floor('1', '2', '4'))).toBe(false);
    expect(floorsEqual(floor('1597', '886', '2483'), floor('1597', '886', '2483'))).toBe(true);
  });
});

describe('runProcessedBridgeBackfill — floor-invariance gate', () => {
  it('dry-run: never probes, never writes, returns 0', async () => {
    const bridge = vi.fn(async () => ({
      daysConsidered: 5,
      inserted: 5,
      updated: 0,
      skippedGuarded: 0,
      unchanged: 0,
    }));
    const probe = vi.fn();
    const code = await runProcessedBridgeBackfill({
      mymrc: { bridgeProcessedToInventory: bridge },
      prisma: {},
      probe,
      opts: { dryRun: true, siteCodes: null, since: null, days: null },
      log: noopLog,
    });
    expect(code).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('PASSES (exit 0) when the live floor is byte-identical before/after', async () => {
    const stable = floor('1597', '886', '2483');
    const probe = vi.fn<(siteCode: string, asOf: string) => Promise<typeof stable>>(
      async () => stable,
    );
    const bridge = vi.fn(async () => ({
      daysConsidered: 976,
      inserted: 976,
      updated: 0,
      skippedGuarded: 0,
      unchanged: 0,
    }));
    const code = await runProcessedBridgeBackfill({
      mymrc: { bridgeProcessedToInventory: bridge },
      prisma: {},
      probe,
      opts: { dryRun: false, siteCodes: null, since: null, days: null },
      log: noopLog,
    });
    expect(code).toBe(0);
    // probed both sites, before AND after (4 calls), same asOf both times.
    expect(probe).toHaveBeenCalledTimes(4);
    const asOfs = probe.mock.calls.map((c) => c[1]);
    expect(new Set(asOfs).size).toBe(1);
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it('ABORTS (exit 1) + pages when the floor drifts', async () => {
    const before = floor('1597', '886', '2483');
    const after = floor('797', '886', '1683'); // program moved — a bug
    let n = 0;
    const probe = vi.fn(async () => (n++ === 0 ? before : after)); // woodland: before, then after
    const page = vi.fn(async () => undefined);
    const code = await runProcessedBridgeBackfill({
      mymrc: {
        bridgeProcessedToInventory: async () => ({
          daysConsidered: 1,
          inserted: 1,
          updated: 0,
          skippedGuarded: 0,
          unchanged: 0,
        }),
        ntfyPager: { page },
      },
      prisma: { site: { findMany: async () => [{ id: 'site-wood', code: 'woodland' }] } },
      probe,
      opts: { dryRun: false, siteCodes: ['woodland'], since: null, days: null },
      log: noopLog,
    });
    expect(code).toBe(1);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('passes --days through to the bridge as onlyProductionDays', async () => {
    const calls: Record<string, unknown>[] = [];
    const bridge = vi.fn(async (ctx: Record<string, unknown>) => {
      calls.push(ctx);
      return { daysConsidered: 2, inserted: 0, updated: 2, skippedGuarded: 0, unchanged: 0 };
    });
    const code = await runProcessedBridgeBackfill({
      mymrc: { bridgeProcessedToInventory: bridge },
      prisma: {},
      probe: vi.fn(),
      opts: { dryRun: true, siteCodes: null, since: null, days: ['2025-02-27', '2025-05-15'] },
      log: noopLog,
    });
    expect(code).toBe(0);
    expect(calls[0]!['onlyProductionDays']).toEqual(['2025-02-27', '2025-05-15']);
    expect(calls[0]!['sinceProductionDate']).toBeUndefined();
  });

  it('resolves --site codes to ids and restricts the bridge', async () => {
    const bridge = vi.fn(async () => ({
      daysConsidered: 1,
      inserted: 1,
      updated: 0,
      skippedGuarded: 0,
      unchanged: 0,
    }));
    const prisma = { site: { findMany: async () => [{ id: 'site-wood', code: 'woodland' }] } };
    const stable = floor('1', '0', '1');
    await runProcessedBridgeBackfill({
      mymrc: { bridgeProcessedToInventory: bridge },
      prisma,
      probe: async () => stable,
      opts: { dryRun: false, siteCodes: ['woodland'], since: null, days: null },
      log: noopLog,
    });
    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ siteIds: ['site-wood'] }));
  });
});
