// ADR-0019.6 — the 2026-10-13 rate-change migration against a REAL Postgres.
//
// Claims a mock cannot carry:
//   1. The migration SQL, run on a database shaped like production (one open
//      2026-01-01 rule per site), leaves each site with exactly two rows: the
//      old rule windowed to 2026-10-12 with its rates untouched, and the new
//      60/$1.00/100/$0.25 rule from 2026-10-13 with no end date.
//   2. It is idempotent: a second run changes nothing (no third row, no second
//      "Closed ..." note).
//   3. The real `resolveActiveRule` (Prisma → Postgres DATE columns → rule book)
//      returns the old rule for 2026-10-12 and the new rule for 2026-10-13.
//   4. An overlapping window aborts the whole migration (fail closed).
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter). The
// CI database has migrations applied but no seed, so this suite creates the
// `woodland` / `eugene` sites the migration keys on, and removes only what it
// created.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { calculateDailyBonusCents } from '@/lib/bonus/calculator';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'processor-bonus-rate-change.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL',
  );
}

const MIGRATION = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    'prisma/migrations/20260867_adr0019_6_bonus_rate_change_20261013/migration.sql',
  ),
  'utf8',
);

const SITE_FIELDS = {
  mrc_program_code: 'MRC-TEST',
  customer_service_open: '08:00',
  customer_service_close: '16:00',
  recycling_rate_target_pct: 75,
  records_retention_years: 4,
  inbound_processing_deadline_days: 45,
  mymrc_inbound_submission_business_days: 3,
  mymrc_processed_submission_business_days: 1,
  dock_sla_minutes: 60,
  reconciliation_target_pct: 97,
  billing_cadence: 'end_of_month_only' as const,
};
const SITES = [
  { code: 'woodland', jurisdiction: 'california' as const, old: ['0.5', 74, 1650] as const },
  { code: 'eugene', jurisdiction: 'oregon' as const, old: ['1', 100, 3000] as const },
];
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
const created: string[] = [];
const siteIds = new Map<string, string>();

describe.skipIf(!REAL_DB)('ADR-0019.6 migration on a real database', () => {
  beforeEach(async () => {
    if (!db) {
      const { PrismaClient } = await import('@prisma/client');
      db = new PrismaClient({ datasources: { db: { url: REAL_DB! } } }) as PrismaClient;
      for (const s of SITES) {
        const existing = await db.site.findUnique({ where: { code: s.code } });
        const row =
          existing ??
          (await db.site.create({
            data: {
              ...SITE_FIELDS,
              code: s.code,
              name: `ADR-0019.6 ${s.code}`,
              jurisdiction: s.jurisdiction,
            },
          }));
        if (!existing) created.push(row.id);
        siteIds.set(s.code, row.id);
      }
    }
    const ids = [...siteIds.values()];
    await db.processorBonusRule.deleteMany({ where: { site_id: { in: ids } } });
    for (const s of SITES) {
      await db.processorBonusRule.create({
        data: {
          site_id: siteIds.get(s.code),
          threshold_low: 50,
          rate_low: s.old[0],
          threshold_high: s.old[1],
          rate_high: '0.25',
          effective_date: day('2026-01-01'),
          end_date: null,
          notes: 'pre-change',
        },
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    const ids = [...siteIds.values()];
    await db.processorBonusRule.deleteMany({ where: { site_id: { in: ids } } });
    if (created.length) await db.site.deleteMany({ where: { id: { in: created } } });
    await db.$disconnect();
  });

  const rows = (code: string) =>
    db.processorBonusRule.findMany({
      where: { site_id: siteIds.get(code) },
      orderBy: { effective_date: 'asc' },
    });

  it('windows the old rule and opens the new one, rates untouched, idempotently', async () => {
    await db.$executeRawUnsafe(MIGRATION);
    await db.$executeRawUnsafe(MIGRATION);
    for (const s of SITES) {
      const r = await rows(s.code);
      expect(r).toHaveLength(2);
      expect(r[0]).toMatchObject({ threshold_low: 50, threshold_high: s.old[1] });
      expect(r[0].rate_low.toString()).toBe(s.old[0]);
      expect(r[0].end_date).toEqual(day('2026-10-12'));
      expect(r[0].notes.match(/Closed 2026-10-12/g)).toHaveLength(1);
      expect(r[1]).toMatchObject({ threshold_low: 60, threshold_high: 100, end_date: null });
      expect(r[1].rate_low.toString()).toBe('1');
      expect(r[1].rate_high.toString()).toBe('0.25');
      expect(r[1].effective_date).toEqual(day('2026-10-13'));
    }
  });

  it('the real resolver prices 80 units by date: old on 10/12, $20.00 on 10/13', async () => {
    await db.$executeRawUnsafe(MIGRATION);
    const { resolveActiveRule } = await import('@/lib/bonus/daily-entry');
    for (const s of SITES) {
      const id = siteIds.get(s.code)!;
      const before = await resolveActiveRule(id, day('2026-10-12'));
      const after = await resolveActiveRule(id, day('2026-10-13'));
      expect(calculateDailyBonusCents(80, before)).toBe(s.old[2]);
      expect(calculateDailyBonusCents(80, after)).toBe(2000);
      // Deploying early is safe: every day before 10/13 still resolves the old row.
      const today = await resolveActiveRule(id, day('2026-10-07'));
      expect(today.id).toBe(before.id);
    }
  });

  it('aborts the whole migration when a window would overlap', async () => {
    await db.processorBonusRule.create({
      data: {
        site_id: siteIds.get('eugene'),
        threshold_low: 1,
        rate_low: '9',
        threshold_high: 2,
        rate_high: '9',
        effective_date: day('2026-10-20'),
        end_date: day('2026-10-21'),
      },
    });
    await expect(db.$executeRawUnsafe(MIGRATION)).rejects.toThrow(/overlapping/);
    // Rolled back: woodland's open rule was not closed either.
    const w = await rows('woodland');
    expect(w).toHaveLength(1);
    expect(w[0].end_date).toBeNull();
  });
});
