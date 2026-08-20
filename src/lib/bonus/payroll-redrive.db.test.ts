// ADR-0117 — the payroll delivery re-drive, against a REAL Postgres.
//
// Two claims, and neither is expressible against a mock:
//
//   1. THE ATTEMPT CLAIM IS EXACTLY-ONCE UNDER CONCURRENCY. The guard is a
//      `updateMany({ where: { payroll_attempt_at: null } })` whose `count` is
//      the verdict. Racing N of them, exactly one must see `count === 1`. A
//      hand-rolled fake returns whatever it was written to return and cannot
//      be raced at all; a read-then-write would pass every mocked test ever
//      written for it and still double-send payroll in production. Only
//      Postgres's own row lock decides this, so only Postgres can test it.
//
//   2. THE SWEEP SPLITS ON THE MARKER, NOT ON THE SYMPTOM. A signed period
//      with no confirmed delivery is TWO different situations wearing one
//      appearance, and the whole point of ADR-0117 is that they are now
//      distinguishable. `attempt IS NULL` re-drives; `attempt IS NOT NULL`
//      pages and is never resent.
//
// ── FALSIFIED BY HAND (2026-08-19) ───────────────────────────────────────────
//
// Test 1: replacing the CAS in `claimDeliveryAttempt` with the read-then-write
// it replaced —
//     const row = await prisma.bonusPayPeriod.findUnique({ where: { id } });
//     if (row?.payroll_attempt_at) return false;
//     await prisma.bonusPayPeriod.update({ where: { id }, data: { payroll_attempt_at: new Date() } });
//     return true;
// — turns "exactly 1 winner" into 8, red immediately.
//
// Test 2: deleting the `p.payroll_attempt_at == null` branch in
// `redrivePayrollDeliveries` (so every candidate is re-driven) makes the
// ambiguous period come back `redriven` instead of `ambiguous`, red immediately.
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// The module under test writes through the `@/lib/prisma` singleton, which
// reads DATABASE_URL. The CI lane sets both to the same value on purpose (see
// ci.yml) — if they diverged this suite would write to one database and assert
// against the other, and "exactly one winner" would be true for the boring
// reason that only one database saw any writes at all.
if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'payroll-redrive.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL — ' +
      'otherwise the service writes one database and the assertions read another.',
  );
}

// The sweep pages through ntfy and re-drives through Chromium + Graph. Neither
// belongs in a database test: stub them and assert on what was ASKED of them.
const pages: Array<{ title: string; fingerprint: string; priority: string }> = [];
vi.mock('@/lib/ntfy', () => ({
  publishNtfy: vi.fn(async (opts: { title: string; fingerprint: string; priority: string }) => {
    pages.push({ title: opts.title, fingerprint: opts.fingerprint, priority: opts.priority });
    return { ok: true, via: 'primary' as const };
  }),
}));
const pdfCalls: string[] = [];
vi.mock('@/lib/bonus/pdf', () => ({
  generateBonusPdf: vi.fn(async (monthId: string) => {
    pdfCalls.push(monthId);
    // Stop the re-driven chain here — the assertion is that the re-drive FIRED,
    // and going further would drive R2 and Graph out of a database test.
    throw new Error('stubbed: pdf generation not exercised in the db lane');
  }),
  PayoutReconciliationError: class PayoutReconciliationError extends Error {},
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

// Namespaced so a shared CI database cannot collide with the sibling db.test.ts
// suites, which run `--no-file-parallelism` against it.
const NS = 'adr0117-redrive';
const SITE = `${NS}-site`;
const USER = `${NS}-user`;

const SITE_FIELDS = {
  code: NS,
  name: 'DR3 Redrive Probe',
  jurisdiction: 'oregon' as const,
  mrc_program_code: 'MRC-OR-TEST',
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

// Two hours ago — comfortably outside the sweep's 30-minute grace window, so
// these fixtures are eligible without the test depending on wall-clock luck.
const SIGNED_AT = new Date(Date.now() - 2 * 60 * 60 * 1000);

const dayUTC = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

async function makePeriod(
  d: any,
  id: string,
  periodNumber: number,
  over: Record<string, unknown>,
): Promise<void> {
  await d.bonusPayPeriod.create({
    data: {
      id,
      site_id: SITE,
      period_number: periodNumber,
      period_year: 2026,
      // `(site_id, period_start)` is UNIQUE, so each fixture period gets its own
      // fortnight — one per `periodNumber`, which is what the real cadence does.
      pay_date: dayUTC(2026, 6, 10 + periodNumber * 14),
      period_start: dayUTC(2026, 5, 23 + periodNumber * 14),
      period_end: dayUTC(2026, 6, 6 + periodNumber * 14),
      state: 'signed',
      facility_signed_by_user_id: USER,
      facility_signed_at: SIGNED_AT,
      ops_signed_by_user_id: USER,
      ops_signed_at: SIGNED_AT,
      ...over,
    },
  });
}

async function cleanup(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "bonus_pay_periods" WHERE "site_id" = '${SITE}'`);
}

async function seed(d: any): Promise<void> {
  await cleanup(d);
  await d.site.upsert({ where: { id: SITE }, update: {}, create: { id: SITE, ...SITE_FIELDS } });
  // Hard rule #6 — the audit log is append-only, and `audit_log.actor_user_id`
  // FKs to `users`. Keeping the fixture user alive across teardown is what lets
  // this suite clean up without ever deleting an audit row.
  await d.user.upsert({
    where: { id: USER },
    update: {},
    create: { id: USER, name: 'Redrive Probe Signer', role: 'manager', primary_site_id: SITE },
  });
}

describe.skipIf(!REAL_DB)('ADR-0117 — payroll delivery re-drive', () => {
  beforeEach(async () => {
    if (!db) {
      const { PrismaClient: PC } = (await import('@prisma/client')) as {
        PrismaClient: typeof PrismaClient;
      };
      db = new PC({ datasources: { db: { url: REAL_DB! } } });
    }
    pages.length = 0;
    pdfCalls.length = 0;
    await seed(db);
  });

  afterAll(async () => {
    if (db) {
      await cleanup(db);
      await db.$disconnect();
    }
  });

  it('claims the delivery attempt exactly once across 8 concurrent racers', async () => {
    const ID = `${NS}-race`;
    await makePeriod(db, ID, 1, {});

    // The REAL guard, imported — not a re-typed copy of it. A test that
    // inlines its own `updateMany` here is measuring its own transcription and
    // would stay green against the read-then-write this replaced.
    const { claimDeliveryAttempt } = await import('./payroll-delivery');

    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimDeliveryAttempt(ID)),
    );
    const winners = results.filter(Boolean).length;

    expect(winners, `expected exactly 1 winner, got ${winners}`).toBe(1);

    // Asserted from the database, not from the return values: a claim that
    // reported success without persisting the marker would leave the period
    // re-drivable and is exactly the bug this guards.
    const row = await db.bonusPayPeriod.findUnique({ where: { id: ID } });
    expect(row.payroll_attempt_at).toBeInstanceOf(Date);
  });

  it('re-drives a signed period with NO attempt, and never resends an ambiguous one', async () => {
    const FRESH = `${NS}-no-attempt`;
    const AMBIGUOUS = `${NS}-attempt-no-stamp`;
    const DELIVERED = `${NS}-delivered`;

    await makePeriod(db, FRESH, 2, { payroll_attempt_at: null });
    await makePeriod(db, AMBIGUOUS, 3, { payroll_attempt_at: SIGNED_AT });
    // Delivered periods are `paid`, but a `signed` row WITH a stamp is the
    // shape a half-finished markPaid leaves behind — it must be ignored, not
    // re-driven, and not paged.
    await makePeriod(db, DELIVERED, 4, {
      payroll_attempt_at: SIGNED_AT,
      payroll_sent_at: SIGNED_AT,
      payroll_message_id: 'graph-abc',
    });

    const { redrivePayrollDeliveries } = await import('./payroll-delivery');
    const res = await redrivePayrollDeliveries();

    const byId = new Map(res.findings.map((f) => [f.periodId, f.outcome]));
    expect(byId.get(FRESH)).toBe('redriven');
    expect(byId.get(AMBIGUOUS)).toBe('ambiguous');
    expect(byId.has(DELIVERED), 'a period with a confirmed send must not be scanned').toBe(false);

    // The ambiguous period is PAGED and NOT resent. Both halves matter: a page
    // with a silent resend behind it is the duplicate-payroll defect wearing a
    // notification.
    // Asserted by FINGERPRINT, not by total page count: the re-driven period's
    // chain runs against a stubbed `generateBonusPdf` that throws, which fires
    // its own (correct) PDF-failure page. Counting all pages would couple this
    // assertion to the stub instead of to the behaviour under test.
    const ambiguousPages = pages.filter((p) =>
      p.fingerprint.startsWith('payroll-ambiguous-send:'),
    );
    expect(ambiguousPages).toHaveLength(1);
    expect(ambiguousPages[0]!.priority).toBe('urgent');
    expect(ambiguousPages[0]!.fingerprint).toBe(`payroll-ambiguous-send:${AMBIGUOUS}`);
    expect(ambiguousPages[0]!.title).toContain('AMBIGUOUS');

    // The re-drive fired for FRESH and ONLY for FRESH. `triggerPayrollDelivery`
    // is fire-and-forget, so give its microtask a turn before reading.
    await new Promise((r) => setTimeout(r, 50));
    expect(pdfCalls).toEqual([FRESH]);
  });

  it('leaves a delivery that is still legitimately in flight alone', async () => {
    const INFLIGHT = `${NS}-inflight`;
    // Signed one minute ago: the chain is plausibly still inside PDF
    // generation, which is why the claim is made LATE and why the sweep must
    // not read a not-yet-claimed marker as a lost promise.
    await makePeriod(db, INFLIGHT, 5, {
      facility_signed_at: new Date(Date.now() - 60_000),
      ops_signed_at: new Date(Date.now() - 60_000),
    });

    const { redrivePayrollDeliveries } = await import('./payroll-delivery');
    const res = await redrivePayrollDeliveries();

    expect(res.findings.some((f) => f.periodId === INFLIGHT)).toBe(false);
    expect(pdfCalls).toEqual([]);
    expect(pages).toEqual([]);
  });
});
