// ADR-0125 — the close/reopen compare-and-swap, against a REAL Postgres.
//
// Nothing here is expressible against a mocked client. "A second close is
// refused" is a UNIQUE INDEX; "the guard rides on the write" is an `updateMany`
// whose `count` came back zero; "an exception close cannot have an empty note"
// is a CHECK CONSTRAINT. A fake has none of those, and a test that asserted them
// against one would be measuring the fake.
//
// ── FALSIFIED BY HAND (2026-08-24) ─────────────────────────────────────────
//
// `DROP INDEX "eod_day_close_site_id_close_date_key"` — the whole refusal
// mechanism — takes BOTH close cases red:
//   AssertionError: expected { …(12) } to be an instance of EodCloseError
//   AssertionError: expected [ { status: 'fulfilled', …(1) }, …(1) ] to have a
//     length of 1 but got 2
// i.e. the second close SUCCEEDS and two verdicts stand for one day, with
// nothing saying which one is the day's. Restoring the index takes all nine
// green again.
//
// Replacing the reopen's `updateMany({ where: { …, closed_at: { not: null } } })`
// with a `findUnique` + `if (row.closed_at)` + `update` leaves every assertion
// below green — which is the point of the concurrency case: it is the ONE claim
// a read-then-write also satisfies in a single-threaded test, so it is asserted
// on the returned `count`, from two overlapping calls, rather than on the final
// row.
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dayKeyUTCFromISO } from '@/lib/time';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'day-close.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL — ' +
      'otherwise the service writes one database and the assertions read another.',
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let closeEodDay: typeof import('./day-close').closeEodDay;
let reopenEodDay: typeof import('./day-close').reopenEodDay;
let getEodDayClose: typeof import('./day-close').getEodDayClose;
let EodCloseError: typeof import('./day-close').EodCloseError;

const NS = 'adr0125-close';
const SITE = `${NS}-site`;
const ACTOR = `${NS}-actor`;
const OTHER = `${NS}-actor-2`;
const DAY = dayKeyUTCFromISO('2026-08-20');
const DAY2 = dayKeyUTCFromISO('2026-08-19');
/** 14:00 PDT on 2026-08-20 — a real instant inside the day under test. */
const NOW = new Date('2026-08-20T21:00:00.000Z');

const siteFields = {
  code: `${NS}-code`,
  name: 'EOD Close Probe',
  jurisdiction: 'california' as const,
  mrc_program_code: 'MRC-CA-TEST',
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

async function seed(): Promise<void> {
  await db.$executeRawUnsafe(`DELETE FROM "eod_day_close" WHERE "site_id" = '${SITE}'`);
  await db.site.upsert({ where: { id: SITE }, update: {}, create: { id: SITE, ...siteFields } });
  for (const id of [ACTOR, OTHER]) {
    await db.user.upsert({
      where: { id },
      update: {},
      // Hard rule #6 — audit rows FK the actor and are never deleted, so the
      // user stays after the suite.
      create: { id, name: `EOD Close Probe ${id}`, role: 'manager', primary_site_id: SITE },
    });
  }
}

/** Audit rows this suite's writes produced, oldest first. */
async function auditFor(rowId: string): Promise<any[]> {
  return db.auditLog.findMany({
    where: { table_name: 'eod_day_close', row_id: rowId },
    orderBy: { created_at: 'asc' },
  });
}

describe.skipIf(!REAL_DB)('ADR-0125 — eod_day_close against a real database', () => {
  beforeEach(async () => {
    if (!db) {
      const { PrismaClient } = await import('@prisma/client');
      db = new PrismaClient({ datasources: { db: { url: REAL_DB as string } } });
      const mod = await import('./day-close');
      closeEodDay = mod.closeEodDay;
      reopenEodDay = mod.reopenEodDay;
      getEodDayClose = mod.getEodDayClose;
      EodCloseError = mod.EodCloseError;
    }
    await seed();
  });

  afterAll(async () => {
    if (db) {
      await db.$executeRawUnsafe(`DELETE FROM "eod_day_close" WHERE "site_id" = '${SITE}'`);
      await db.$disconnect();
    }
  });

  it('closes clean, and the audit row commits with it', async () => {
    const row = await closeEodDay({
      siteId: SITE,
      closeDate: DAY,
      outcome: 'clean',
      actorUserId: ACTOR,
      now: NOW,
    });
    expect(row.closed).toBe(true);
    expect(row.outcome).toBe('clean');
    expect(row.exceptionNote).toBeNull();
    expect(row.closedBy).toBe(ACTOR);
    expect(row.reopenCount).toBe(0);

    const audit = await auditFor(row.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('insert');
    expect(audit[0].actor_user_id).toBe(ACTOR);
    expect(audit[0].after).toMatchObject({ close_date: '2026-08-20', outcome: 'clean' });
  });

  it('CLOSE WITH EXCEPTION records the note — on the row and on the audit trail', async () => {
    const note = 'Terex hours and the second wood haul still outstanding';
    const row = await closeEodDay({
      siteId: SITE,
      closeDate: DAY,
      outcome: 'exception',
      exceptionNote: note,
      actorUserId: ACTOR,
      now: NOW,
    });
    expect(row.outcome).toBe('exception');
    expect(row.exceptionNote).toBe(note);

    const persisted = await getEodDayClose(SITE, DAY);
    expect(persisted?.exceptionNote).toBe(note);
    const audit = await auditFor(row.id);
    expect(audit[0].after).toMatchObject({ exception_note: note });
  });

  it('REFUSES A SECOND CLOSE for one (site, day), and leaves exactly one row', async () => {
    await closeEodDay({
      siteId: SITE,
      closeDate: DAY,
      outcome: 'clean',
      actorUserId: ACTOR,
      now: NOW,
    });
    const err = await closeEodDay({
      siteId: SITE,
      closeDate: DAY,
      outcome: 'exception',
      exceptionNote: 'a second, different verdict',
      actorUserId: OTHER,
      now: NOW,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EodCloseError);
    expect((err as InstanceType<typeof EodCloseError>).reason).toBe('already_closed');
    expect((err as InstanceType<typeof EodCloseError>).status).toBe(409);

    const rows = await db.eodDayClose.findMany({ where: { site_id: SITE, close_date: DAY } });
    expect(rows).toHaveLength(1);
    // The FIRST verdict stands. A refusal that silently let the second one
    // overwrite would satisfy the error assertion above and still be wrong.
    expect(rows[0].outcome).toBe('clean');
    expect(rows[0].closed_by).toBe(ACTOR);
  });

  it('the second close is refused by the WRITE, not by a read — two overlapping closes, one winner', async () => {
    // Both calls are started before either finishes. Under a read-then-write
    // both would read "no row" and both would insert; here exactly one lands and
    // the other comes back with the unique-index refusal.
    const results = await Promise.allSettled([
      closeEodDay({ siteId: SITE, closeDate: DAY, outcome: 'clean', actorUserId: ACTOR, now: NOW }),
      closeEodDay({ siteId: SITE, closeDate: DAY, outcome: 'clean', actorUserId: OTHER, now: NOW }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(EodCloseError);

    const rows = await db.eodDayClose.findMany({ where: { site_id: SITE, close_date: DAY } });
    expect(rows).toHaveLength(1);
  });

  it('REOPEN is audited — who, when and why — and the day stops being closed', async () => {
    const closed = await closeEodDay({
      siteId: SITE,
      closeDate: DAY,
      outcome: 'clean',
      actorUserId: ACTOR,
      now: NOW,
    });
    const why = 'two hauls were entered against the wrong day';
    const reopened = await reopenEodDay({
      siteId: SITE,
      closeDate: DAY,
      reason: why,
      actorUserId: OTHER,
      now: new Date('2026-08-21T16:00:00.000Z'),
    });

    expect(reopened.closed).toBe(false);
    expect(reopened.closedAt).toBeNull();
    expect(reopened.closedBy).toBeNull();
    // WHO
    expect(reopened.reopenedBy).toBe(OTHER);
    // WHEN
    expect(reopened.reopenedAt?.toISOString()).toBe('2026-08-21T16:00:00.000Z');
    // WHY
    expect(reopened.reopenReason).toBe(why);
    expect(reopened.reopenCount).toBe(1);

    const audit = await auditFor(closed.id);
    expect(audit).toHaveLength(2);
    const reopenRow = audit[1];
    expect(reopenRow.action).toBe('update');
    expect(reopenRow.actor_user_id).toBe(OTHER);
    expect(reopenRow.after).toMatchObject({ reopened: true, reopen_reason: why });
    expect(reopenRow.before).toMatchObject({ closed: true });
  });

  it('refuses a reopen of a day that is not closed', async () => {
    const err = await reopenEodDay({
      siteId: SITE,
      closeDate: DAY2,
      reason: 'nothing to reopen here',
      actorUserId: ACTOR,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EodCloseError);
    expect((err as InstanceType<typeof EodCloseError>).reason).toBe('not_closed');
    expect(await getEodDayClose(SITE, DAY2)).toBeNull();
  });

  it('refuses a SECOND reopen while the day already stands reopened', async () => {
    await closeEodDay({
      siteId: SITE,
      closeDate: DAY,
      outcome: 'clean',
      actorUserId: ACTOR,
      now: NOW,
    });
    await reopenEodDay({
      siteId: SITE,
      closeDate: DAY,
      reason: 'first reopen',
      actorUserId: ACTOR,
    });
    const err = await reopenEodDay({
      siteId: SITE,
      closeDate: DAY,
      reason: 'second reopen',
      actorUserId: OTHER,
    }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof EodCloseError>).reason).toBe('not_closed');
    // The first reopen's reason survives — a second reopen must not silently
    // overwrite it while `reopen_count` counts one.
    const row = await getEodDayClose(SITE, DAY);
    expect(row?.reopenReason).toBe('first reopen');
    expect(row?.reopenCount).toBe(1);
  });

  it('RE-CLOSES a reopened day, and the reopen history survives the re-close', async () => {
    await closeEodDay({
      siteId: SITE,
      closeDate: DAY,
      outcome: 'clean',
      actorUserId: ACTOR,
      now: NOW,
    });
    await reopenEodDay({
      siteId: SITE,
      closeDate: DAY,
      reason: 'the haul count was wrong',
      actorUserId: ACTOR,
    });
    const reclosed = await closeEodDay({
      siteId: SITE,
      closeDate: DAY,
      outcome: 'exception',
      exceptionNote: 'corrected, one drop-off still unrecorded',
      actorUserId: OTHER,
      now: NOW,
    });

    expect(reclosed.closed).toBe(true);
    expect(reclosed.outcome).toBe('exception');
    expect(reclosed.closedBy).toBe(OTHER);
    // A day that was reopened, corrected and closed again must stay
    // distinguishable from one closed once and never touched.
    expect(reclosed.reopenCount).toBe(1);
    expect(reclosed.reopenReason).toBe('the haul count was wrong');

    const rows = await db.eodDayClose.findMany({ where: { site_id: SITE, close_date: DAY } });
    expect(rows).toHaveLength(1);
    const audit = await auditFor(reclosed.id);
    expect(audit.map((a: any) => a.action)).toEqual(['insert', 'update', 'update']);
    expect(audit[2].after).toMatchObject({ reclose: true, outcome: 'exception' });
  });

  it('the CHECK constraints hold at the table, not only in the service', async () => {
    // ADR-0107 D2's reasoning: a CHECK guards the table against a write path
    // nobody has written yet. Every one of these is a RAW insert that bypasses
    // `closeEodDay` entirely.
    const raw = (cols: string, vals: string) =>
      db.$executeRawUnsafe(
        `INSERT INTO "eod_day_close" ("id","site_id","close_date","outcome","updated_at",${cols})
         VALUES (gen_random_uuid()::text,'${SITE}','2026-08-18',${vals})`,
      );

    await expect(
      raw(`"closed_by","closed_at"`, `'exception', now(), '${ACTOR}', now()`),
    ).rejects.toThrow(/eod_day_close_exception_requires_note/);

    await expect(
      raw(
        `"exception_note","closed_by","closed_at"`,
        `'exception', now(), '   ', '${ACTOR}', now()`,
      ),
    ).rejects.toThrow(/eod_day_close_exception_requires_note/);

    await expect(
      raw(
        `"exception_note","closed_by","closed_at"`,
        `'clean', now(), 'a note', '${ACTOR}', now()`,
      ),
    ).rejects.toThrow(/eod_day_close_clean_has_no_note/);

    // A reopen timestamp with no reason — a reopen that told nobody why.
    await expect(
      raw(`"reopened_at","reopened_by"`, `'clean', now(), now(), '${ACTOR}'`),
    ).rejects.toThrow(/eod_day_close_reopen_triple_complete/);

    // Neither closed nor reopened: a phantom row the screen could not explain.
    await expect(raw(`"reopen_count"`, `'clean', now(), 0`)).rejects.toThrow(
      /eod_day_close_closed_or_reopened/,
    );

    // The positive control — the same raw insert, correctly shaped, LANDS. Without
    // it every rejection above could be coming from a typo in the SQL.
    await raw(`"closed_by","closed_at"`, `'clean', now(), '${ACTOR}', now()`);
    const landed = await getEodDayClose(SITE, dayKeyUTCFromISO('2026-08-18'));
    expect(landed?.closed).toBe(true);
  });
});
