// ADR-0059 — the one-shot INBOUND backfill runner: arg parsing + the MANDATORY
// floor-invariance gate. Collaborators (bridge, prisma, probe) are injected, so this
// exercises the real gate flow with no DB, no `dist/`, no HTTP.

import { describe, expect, it, vi } from 'vitest';
import {
  parseArgs,
  floorsEqual,
  runInboundBridgeBackfill,
  toTenths,
  expectedFloorMove,
} from '../../scripts/mymrc-inbound-bridge-backfill.mjs';

const noopLog = () => undefined;
const floor = (program: string, nonProgram: string, total: string) => ({
  program,
  nonProgram,
  total,
});
const bridgeResult = (over = {}) => ({
  daysConsidered: 0,
  inserted: 0,
  updated: 0,
  skippedGuarded: 0,
  unchanged: 0,
  haulsUndated: 0,
  ...over,
});

describe('parseArgs', () => {
  it('defaults to full history, no dry-run, all sites', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, siteCodes: null, since: null });
    expect(parseArgs(['--backfill'])).toEqual({ dryRun: false, siteCodes: null, since: null });
  });
  it('parses --dry-run, --since, --site', () => {
    expect(parseArgs(['--dry-run', '--since=2026-07-01', '--site=woodland'])).toEqual({
      dryRun: true,
      since: '2026-07-01',
      siteCodes: ['woodland'],
    });
  });
  it('rejects a bad --since and an unknown flag and a bad --site', () => {
    expect(() => parseArgs(['--since=2026/07/01'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--site=portland'])).toThrow(/woodland\|eugene/);
  });
});

describe('floorsEqual', () => {
  it('is byte-identical on all three pools', () => {
    expect(floorsEqual(floor('1', '2', '3'), floor('1', '2', '3'))).toBe(true);
    expect(floorsEqual(floor('1', '2', '3'), floor('1', '2', '4'))).toBe(false);
    expect(floorsEqual(floor('1597', '886', '2483'), floor('1597', '886', '2483'))).toBe(true);
  });
});

describe('runInboundBridgeBackfill — floor-invariance gate', () => {
  it('dry-run: never probes, never writes, returns 0', async () => {
    const bridge = vi.fn(async () =>
      bridgeResult({ daysConsidered: 610, inserted: 610, haulsUndated: 2301 }),
    );
    const probe = vi.fn();
    const code = await runInboundBridgeBackfill({
      mymrc: { bridgeInboundHaulsToInventory: bridge },
      prisma: {},
      probe,
      opts: { dryRun: true, siteCodes: null, since: null },
      log: noopLog,
    });
    expect(code).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('PASSES (exit 0) when the live floor is byte-identical before/after (anchor-safety Δ0)', async () => {
    const stable = floor('1597', '886', '2483');
    const probe = vi.fn<(siteCode: string, asOf: string) => Promise<typeof stable>>(
      async () => stable,
    );
    const bridge = vi.fn(async () =>
      bridgeResult({ daysConsidered: 610, inserted: 610, haulsUndated: 2301 }),
    );
    const code = await runInboundBridgeBackfill({
      mymrc: { bridgeInboundHaulsToInventory: bridge },
      prisma: {},
      probe,
      opts: { dryRun: false, siteCodes: null, since: null },
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
    const after = floor('2124', '886', '3010'); // program moved (a post-anchor row leaked) — a bug
    let n = 0;
    const probe = vi.fn(async () => (n++ === 0 ? before : after)); // woodland: before, then after
    const page = vi.fn(async () => undefined);
    const code = await runInboundBridgeBackfill({
      mymrc: {
        bridgeInboundHaulsToInventory: async () => bridgeResult({ daysConsidered: 1, inserted: 1 }),
        ntfyPager: { page },
      },
      prisma: { site: { findMany: async () => [{ id: 'site-wood', code: 'woodland' }] } },
      probe,
      opts: { dryRun: false, siteCodes: ['woodland'], since: null },
      log: noopLog,
    });
    expect(code).toBe(1);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('resolves --site codes to ids and restricts the bridge', async () => {
    const bridge = vi.fn(async () => bridgeResult({ daysConsidered: 1, inserted: 1 }));
    const prisma = { site: { findMany: async () => [{ id: 'site-wood', code: 'woodland' }] } };
    const stable = floor('1', '0', '1');
    await runInboundBridgeBackfill({
      mymrc: { bridgeInboundHaulsToInventory: bridge },
      prisma,
      probe: async () => stable,
      opts: { dryRun: false, siteCodes: ['woodland'], since: null },
      log: noopLog,
    });
    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ siteIds: ['site-wood'] }));
  });
});

// ── OPEN-ITEMS 0.CA (2026-09-25) ──────────────────────────────────────────────
// The 0.BZ re-bridge of Woodland 09-01.. rewrote 09-15 (one haul MRC had since
// given its units, +107) — a day AFTER the 09-14 anchor. The floor moved 168 -> 275
// exactly as it should, and the gate paged "MyMRC sync error … anchor-safety gate
// FAILED" because it only knew "the floor must not move". These tests pin the
// replacement: the move must equal what was written on counted days, no more, no less.

const wood = { site: { findMany: async () => [{ id: 'site-wood', code: 'woodland' }] } };
type Snap = { program: string; nonProgram: string; total: string; inboundSinceDay?: string | null };
const probeSeq = (...snaps: Snap[]) => {
  let n = 0;
  return vi.fn(async (...args: [string, string]): Promise<Snap> => {
    void args;
    return snaps[Math.min(n++, snaps.length - 1)]!;
  });
};
const w = (day: string, before: [number, number] | null, after: [number, number]) => ({
  siteId: 'site-wood',
  day,
  before: before ? { program: before[0], nonProgram: before[1] } : null,
  after: { program: after[0], nonProgram: after[1] },
});

describe('toTenths', () => {
  it('parses Decimal strings to exact tenths and refuses finer precision', () => {
    expect(toTenths('275')).toBe(2750);
    expect(toTenths('1305.0')).toBe(13050);
    expect(toTenths('-3.5')).toBe(-35);
    expect(toTenths('1.50')).toBe(15);
    expect(Number.isNaN(toTenths('1.05'))).toBe(true);
    expect(Number.isNaN(toTenths('abc'))).toBe(true);
  });
});

describe('expectedFloorMove', () => {
  it('sums only days on/after the first counted day, per pool', () => {
    const writes = [w('2026-09-04', [6547, 0], [663, 0]), w('2026-09-15', [1305, 0], [1412, 0])];
    expect(expectedFloorMove(writes, 'site-wood', '2026-09-15')).toMatchObject({
      program: 1070,
      nonProgram: 0,
    });
    expect(expectedFloorMove(writes, 'site-wood', '2026-09-16')).toMatchObject({ program: 0 });
  });
  it('null sinceDay (no anchor) counts every day; undefined (probe silent) expects zero', () => {
    const writes = [w('2026-09-04', null, [10, 2])];
    expect(expectedFloorMove(writes, 'site-wood', null)).toMatchObject({
      program: 100,
      nonProgram: 20,
    });
    expect(expectedFloorMove(writes, 'site-wood', undefined)).toMatchObject({
      program: 0,
      nonProgram: 0,
    });
  });
  it('an unknown prior value poisons the expectation (NaN), never reads as zero', () => {
    const writes = [
      { ...w('2026-09-15', null, [5, 0]), before: { program: NaN, nonProgram: NaN } },
    ];
    expect(Number.isNaN(expectedFloorMove(writes, 'site-wood', '2026-09-15').program)).toBe(true);
  });
});

describe('runInboundBridgeBackfill — explained vs unexplained floor move (0.CA)', () => {
  const since = '2026-09-15';
  const run = (
    probe: ReturnType<typeof probeSeq>,
    writes: unknown[],
    page = vi.fn(async () => undefined),
  ) =>
    runInboundBridgeBackfill({
      mymrc: {
        bridgeInboundHaulsToInventory: async () =>
          bridgeResult({ daysConsidered: 21, updated: writes.length, writes }),
        ntfyPager: { page },
      },
      prisma: wood,
      probe,
      opts: { dryRun: false, siteCodes: ['woodland'], since: '2026-09-01' },
      log: noopLog,
    });

  it('the 2026-09-25 re-bridge: +107 on post-anchor 09-15 moves the floor 168 -> 275 — PASSES, no page', async () => {
    const page = vi.fn(async () => undefined);
    const probe = probeSeq(
      { ...floor('168', '1339', '1507'), inboundSinceDay: since },
      { ...floor('275', '1339', '1614'), inboundSinceDay: since },
    );
    const writes = [
      w('2026-09-03', [618, 342], [731, 342]),
      w('2026-09-04', [6547, 0], [663, 0]),
      w('2026-09-09', [5989, 0], [1237, 0]),
      w('2026-09-10', [912, 0], [970, 0]),
      w('2026-09-15', [1305, 0], [1412, 0]),
    ];
    expect(await run(probe, writes, page)).toBe(0);
    expect(page).not.toHaveBeenCalled();
  });

  it('FAILS + pages bridge_gate when a pre-anchor rewrite moves the floor (the encoding bug)', async () => {
    const page = vi.fn(async (a: Record<string, unknown>) => void a);
    const probe = probeSeq(
      { ...floor('168', '1339', '1507'), inboundSinceDay: since },
      { ...floor('281', '1339', '1620'), inboundSinceDay: since }, // moved +113 …
    );
    // … but the only write was 09-03, BEFORE the counted window: nothing should move.
    expect(await run(probe, [w('2026-09-03', [618, 342], [731, 342])], page)).toBe(1);
    expect(page).toHaveBeenCalledTimes(1);
    const alert = page.mock.calls[0]![0];
    expect(alert).toMatchObject({
      kind: 'bridge_gate',
      site: 'woodland',
      fingerprint: 'inbound-bridge-floor-drift',
    });
    expect(alert['kind']).not.toBe('error');
  });

  it('FAILS when the floor moves by a DIFFERENT amount than the counted writes explain', async () => {
    const page = vi.fn(async () => undefined);
    const probe = probeSeq(
      { ...floor('168', '1339', '1507'), inboundSinceDay: since },
      { ...floor('276', '1339', '1615'), inboundSinceDay: since }, // +108, writes explain +107
    );
    expect(await run(probe, [w('2026-09-15', [1305, 0], [1412, 0])], page)).toBe(1);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('FAILS when a counted write did NOT reach the floor (expected +107, actual 0)', async () => {
    const page = vi.fn(async () => undefined);
    const stable = { ...floor('168', '1339', '1507'), inboundSinceDay: since };
    expect(await run(probeSeq(stable, stable), [w('2026-09-15', [1305, 0], [1412, 0])], page)).toBe(
      1,
    );
  });

  it('FAILS on a pool shift the writes do not explain even when the TOTAL is unchanged', async () => {
    // H-139247 shape: MRC moved 100 units program -> non-program on a pre-anchor day.
    // If that leaked into the floor, the total would not move — only the pools would.
    const page = vi.fn(async () => undefined);
    const probe = probeSeq(
      { ...floor('168', '1339', '1507'), inboundSinceDay: since },
      { ...floor('68', '1439', '1507'), inboundSinceDay: since },
    );
    expect(await run(probe, [w('2026-08-31', [100, 0], [0, 100])], page)).toBe(1);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('a probe that does not report inboundSinceDay keeps the ORIGINAL strict gate', async () => {
    const page = vi.fn(async () => undefined);
    const probe = probeSeq(floor('168', '1339', '1507'), floor('275', '1339', '1614'));
    expect(await run(probe, [w('2026-09-15', [1305, 0], [1412, 0])], page)).toBe(1);
    expect(page).toHaveBeenCalledTimes(1);
  });
});
