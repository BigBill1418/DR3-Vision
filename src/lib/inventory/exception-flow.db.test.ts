// ADR-0143 D4/D5 + Bill B4 — the exception flow against a real Postgres:
// four-eyes adjustments, CAS decisions, resolution, and the paging contract (T12).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { dayKeyUTCFromISO, pacificMidnightInstantOfDayISO } from '@/lib/time';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error('exception-flow.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let guard: typeof import('./pool-guard');
let svc: typeof import('./exception-service');
let alerts: typeof import('./exception-alerts');

const NS = `adr0143f-${Date.now().toString(36)}`;
const D = Prisma.Decimal;
const MGR = `${NS}-mgr`;
const BILL = `${NS}-bill`;
let seq = 0;

const noonPT = (day: string) =>
  new Date(pacificMidnightInstantOfDayISO(day).getTime() + 12 * 3600_000);

/** A site whose program pool is -50 from 09-03 on: anchor 10/10, stripped 60 program on 09-03. */
async function negativeSite(): Promise<{ site: string; code: string; exceptionId: string }> {
  seq += 1;
  const site = `${NS}-site-${seq}`;
  const code = `${NS}-${seq}`;
  await db.site.create({
    data: {
      id: site,
      code,
      name: `Probe ${seq}`,
      jurisdiction: 'california',
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
      billing_cadence: 'mid_month_and_end',
    },
  });
  await db.siteInventorySnapshot.create({
    data: {
      site_id: site,
      snapshot_at: pacificMidnightInstantOfDayISO('2026-09-01'),
      snapshot_kind: 'physical',
      source: 'manual',
      units_total: 120,
      units_in_processing: 0,
      program_units: 10,
      non_program_units: 110,
      pool_attribution: 'measured',
    },
  });
  await db.processedUnitsDaily.create({
    data: {
      site_id: site,
      production_date: dayKeyUTCFromISO('2026-09-03'),
      stripped_program: new D(60),
      stripped_non_program: new D(0),
      source: 'import',
    },
  });
  const r = await guard.runPoolCheck(site, 'workbook-sync', noonPT('2026-09-10'));
  return { site, code, exceptionId: r.opened[0]!.id };
}

describe.skipIf(!REAL_DB)('ADR-0143 exception flow — real Postgres', () => {
  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    db = new PrismaClient({ datasources: { db: { url: REAL_DB as string } } });
    guard = await import('./pool-guard');
    svc = await import('./exception-service');
    alerts = await import('./exception-alerts');
    for (const id of [MGR, BILL]) {
      await db.user.upsert({
        where: { id },
        update: {},
        create: { id, name: id, role: 'manager' },
      });
    }
  });
  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('the Woodland repair shape: manager proposes, the SAME person cannot approve, a second person does; total unchanged, exception resolved', async () => {
    const { site, exceptionId } = await negativeSite();
    const rb = await import('./running-balance');
    const before = await rb.computePoolBalance(db, site, { lte: new Date() });
    expect(before.program.toString()).toBe('-50');

    const adj = await svc.proposePoolAdjustment({
      siteId: site,
      exceptionId,
      day: '2026-09-04',
      fromPool: 'non_program',
      toPool: 'program',
      units: 50,
      reason: 'ADR-0143 test: non-program processed as program',
      actorUserId: MGR,
    });
    // A proposal moves nothing.
    expect((await rb.computePoolBalance(db, site, { lte: new Date() })).program.toString()).toBe(
      '-50',
    );

    await expect(
      svc.decidePoolAdjustment({
        siteId: site,
        adjustmentId: adj.id,
        decision: 'approve',
        actorUserId: MGR,
      }),
    ).rejects.toMatchObject({ status: 403, reason: 'four_eyes' });

    const r = await svc.decidePoolAdjustment({
      siteId: site,
      adjustmentId: adj.id,
      decision: 'approve',
      actorUserId: BILL,
    });
    expect(r).toEqual({ adjustmentId: adj.id, status: 'approved', exceptionResolved: true });

    const after = await rb.computePoolBalance(db, site, { lte: new Date() });
    expect(after.program.toString()).toBe('0');
    expect(after.total.toString()).toBe(before.total.toString());

    const ex = await db.inventoryException.findUnique({ where: { id: exceptionId } });
    expect(ex.status).toBe('resolved');
    expect(ex.resolved_by).toBe(BILL);
    // 09-03 stays negative in the history and stays explained by THIS exception.
    expect(ex.last_negative_day.toISOString().slice(0, 10)).toBe('2026-09-03');
    const neg = await db.inventoryPositionDaily.findMany({
      where: { site_id: site, pool: 'program', closing: { lt: 0 } },
    });
    expect(neg.map((p: any) => p.exception_id)).toEqual([exceptionId]);

    // A second decision is a 409, not a second write.
    await expect(
      svc.decidePoolAdjustment({
        siteId: site,
        adjustmentId: adj.id,
        decision: 'reject',
        actorUserId: BILL,
      }),
    ).rejects.toMatchObject({ status: 409 });
    // Every step is audited.
    expect(
      await db.auditLog.count({
        where: { table_name: 'inventory_pool_adjustments', row_id: adj.id },
      }),
    ).toBe(2);
  });

  it('an adjustment too small to clear the pool is applied but leaves the exception OPEN', async () => {
    const { site, exceptionId } = await negativeSite();
    const adj = await svc.proposePoolAdjustment({
      siteId: site,
      exceptionId,
      day: '2026-09-04',
      fromPool: 'non_program',
      toPool: 'program',
      units: 20,
      reason: 'ADR-0143 test: partial correction',
      actorUserId: MGR,
    });
    const r = await svc.decidePoolAdjustment({
      siteId: site,
      adjustmentId: adj.id,
      decision: 'approve',
      actorUserId: BILL,
    });
    expect(r.exceptionResolved).toBe(false);
    expect((await db.inventoryException.findUnique({ where: { id: exceptionId } })).status).toBe(
      'open',
    );
  });

  it('closing without an adjustment: refused while negative; four-eyes once a count reset it', async () => {
    const { site, exceptionId } = await negativeSite();
    await expect(
      svc.proposeExceptionResolution({
        siteId: site,
        exceptionId,
        note: 'it will fix itself somehow',
        actorUserId: MGR,
      }),
    ).rejects.toMatchObject({ status: 409, reason: 'still_negative' });
    // A new count re-seeds the window (the floor holds 60/0).
    await db.siteInventorySnapshot.create({
      data: {
        site_id: site,
        snapshot_at: pacificMidnightInstantOfDayISO('2026-09-05'),
        snapshot_kind: 'physical',
        source: 'manual',
        units_total: 60,
        units_in_processing: 0,
        program_units: 30,
        non_program_units: 30,
        pool_attribution: 'measured',
      },
    });
    await svc.proposeExceptionResolution({
      siteId: site,
      exceptionId,
      note: 'count on 09-05 reset the pool',
      actorUserId: MGR,
    });
    // What the approver's page shows: the proposal text and its instant.
    const seen = (await svc.getInventoryExceptionDetail(site, exceptionId)).exception;
    expect(seen.resolutionProposedNote).toBe('count on 09-05 reset the pool');
    expect(seen.resolutionProposedAt).not.toBeNull();
    await expect(
      svc.approveExceptionResolution({
        siteId: site,
        exceptionId,
        actorUserId: MGR,
        expectedProposedAt: seen.resolutionProposedAt!,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await svc.approveExceptionResolution({
      siteId: site,
      exceptionId,
      actorUserId: BILL,
      expectedProposedAt: seen.resolutionProposedAt!,
    });
    const ex = await db.inventoryException.findUnique({ where: { id: exceptionId } });
    expect(ex.status).toBe('resolved');
    expect(ex.resolution).toBe('count on 09-05 reset the pool');
  });

  it('four-eyes TOCTOU: a re-proposal after the approver loaded the page → 409 stale_proposal, nothing resolves', async () => {
    const { site, exceptionId } = await negativeSite();
    await db.siteInventorySnapshot.create({
      data: {
        site_id: site,
        snapshot_at: pacificMidnightInstantOfDayISO('2026-09-05'),
        snapshot_kind: 'physical',
        source: 'manual',
        units_total: 60,
        units_in_processing: 0,
        program_units: 30,
        non_program_units: 30,
        pool_attribution: 'measured',
      },
    });
    await svc.proposeExceptionResolution({
      siteId: site,
      exceptionId,
      note: 'count on 09-05 reset the pool',
      actorUserId: MGR,
      now: new Date('2026-10-29T16:00:00.000Z'),
    });
    // The approver loads the page and reads the first note...
    const seen = (await svc.getInventoryExceptionDetail(site, exceptionId)).exception;
    // ...then the proposer swaps the text before the approver clicks.
    await svc.proposeExceptionResolution({
      siteId: site,
      exceptionId,
      note: 'a different justification nobody approved',
      actorUserId: MGR,
      now: new Date('2026-10-29T16:00:05.000Z'),
    });
    await expect(
      svc.approveExceptionResolution({
        siteId: site,
        exceptionId,
        actorUserId: BILL,
        expectedProposedAt: seen.resolutionProposedAt!,
      }),
    ).rejects.toMatchObject({ status: 409, reason: 'stale_proposal' });
    const ex = await db.inventoryException.findUnique({ where: { id: exceptionId } });
    expect(ex.status).toBe('open');
    expect(ex.resolved_by).toBeNull();
    // A malformed token is refused before anything is read.
    await expect(
      svc.approveExceptionResolution({
        siteId: site,
        exceptionId,
        actorUserId: BILL,
        expectedProposedAt: 'yesterday',
      }),
    ).rejects.toMatchObject({ status: 422 });
    // Reloading shows the new text; approving THAT works.
    const reloaded = (await svc.getInventoryExceptionDetail(site, exceptionId)).exception;
    expect(reloaded.resolutionProposedNote).toBe('a different justification nobody approved');
    await svc.approveExceptionResolution({
      siteId: site,
      exceptionId,
      actorUserId: BILL,
      expectedProposedAt: reloaded.resolutionProposedAt!,
    });
    expect(
      (await db.inventoryException.findUnique({ where: { id: exceptionId } })).resolution,
    ).toBe('a different justification nobody approved');
  });

  it('adjustments have no TOCTOU: a proposal is immutable, so approving its id approves exactly what was shown', async () => {
    const { site, exceptionId } = await negativeSite();
    const first = await svc.proposePoolAdjustment({
      siteId: site,
      exceptionId,
      day: '2026-09-04',
      fromPool: 'non_program',
      toPool: 'program',
      units: 50,
      reason: 'ADR-0143 test: the proposal the approver saw',
      actorUserId: MGR,
    });
    // The proposer cannot edit it in place (DB trigger)...
    await expect(
      db.inventoryPoolAdjustment.update({ where: { id: first.id }, data: { units: new D(5000) } }),
    ).rejects.toThrow(/only the decision may change/);
    // ...a "re-proposal" is a NEW row with a new id, which the approver has not seen.
    const second = await svc.proposePoolAdjustment({
      siteId: site,
      exceptionId,
      day: '2026-09-04',
      fromPool: 'non_program',
      toPool: 'program',
      units: 49,
      reason: 'ADR-0143 test: a later, different proposal',
      actorUserId: MGR,
    });
    expect(second.id).not.toBe(first.id);
    await svc.decidePoolAdjustment({
      siteId: site,
      adjustmentId: first.id,
      decision: 'approve',
      actorUserId: BILL,
    });
    const rows = await db.inventoryPoolAdjustment.findMany({
      where: { exception_id: exceptionId },
    });
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
    expect(byId[first.id].status).toBe('approved');
    expect(byId[first.id].units.toString()).toBe('50');
    expect(byId[second.id].status).toBe('proposed');
  });

  it('site isolation: another site cannot see or act on the exception', async () => {
    const a = await negativeSite();
    const b = await negativeSite();
    // CH-12 presenter lookup is site-scoped (b has its own; a third, clean site has none).
    expect(await svc.openExceptionForPresenter(a.site)).toEqual({
      id: a.exceptionId,
      pool: 'program',
    });
    expect(await svc.openExceptionForPresenter(b.site)).toEqual({
      id: b.exceptionId,
      pool: 'program',
    });
    expect(await svc.openExceptionForPresenter(`${NS}-no-such-site`)).toBeNull();
    await expect(svc.getInventoryExceptionDetail(b.site, a.exceptionId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      svc.proposePoolAdjustment({
        siteId: b.site,
        exceptionId: a.exceptionId,
        day: '2026-09-04',
        fromPool: 'non_program',
        toPool: 'program',
        units: 5,
        reason: 'cross-site attempt here',
        actorUserId: MGR,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  // ── T12 — page once at onset, once at 7 days, never daily ────────────────
  it('T12 — onset page once; days 1-6 nothing; day 7 one re-page; resolved → nothing', async () => {
    const { exceptionId } = await negativeSite();
    const sent: any[] = [];
    const publish = async (a: any) => {
      sent.push(a);
      return { ok: true, outcome: 'sent' as const };
    };
    const opened = (
      await db.inventoryException.findUnique({ where: { id: exceptionId } })
    ).opened_at.getTime();
    const mine = () => sent.filter((a) => String(a.clickUrl).endsWith(exceptionId));

    await alerts.sweepInventoryExceptionPages({ now: new Date(opened + 60_000), publish });
    expect(mine()).toHaveLength(1);
    const onset = mine()[0];
    expect(onset.priority).toBe('high');
    expect(onset.topic).toBe('dr3-vision-system');
    expect(onset.title).toMatch(/^[\x20-\x7e]+$/); // ADR-0093: pure ASCII
    expect(onset.title).toContain('program inventory went negative (-50)');
    expect(onset.clickUrl).toContain(`/inventory-exceptions/${exceptionId}`);

    for (let day = 1; day <= 6; day += 1) {
      await alerts.sweepInventoryExceptionPages({
        now: new Date(opened + day * 86_400_000),
        publish,
      });
    }
    expect(mine()).toHaveLength(1);
    await alerts.sweepInventoryExceptionPages({
      now: new Date(opened + 7 * 86_400_000 + 60_000),
      publish,
    });
    expect(mine()).toHaveLength(2);
    expect(mine()[1].title).toContain('still open after 7 days');
    await alerts.sweepInventoryExceptionPages({ now: new Date(opened + 9 * 86_400_000), publish });
    expect(mine()).toHaveLength(2);

    // The daily digest names it while open.
    const digests: any[] = [];
    await alerts.publishOpenExceptionsDigest({
      now: new Date(),
      publish: async (a: any) => (digests.push(a), { ok: true, outcome: 'sent' as const }),
    });
    expect(digests[0].priority).toBe('default');
    expect(digests[0].body).toContain(exceptionId);
  });

  it('T12 — a dropped page is NOT stamped, so the next sweep retries (delivered ≠ sent)', async () => {
    const { exceptionId } = await negativeSite();
    const outcomes: string[] = ['dropped', 'sent'];
    const calls: string[] = [];
    const publish = async (a: any) => {
      if (String(a.clickUrl).endsWith(exceptionId)) calls.push(a.fingerprint);
      const outcome = String(a.clickUrl).endsWith(exceptionId)
        ? (outcomes.shift() ?? 'sent')
        : 'sent';
      return { ok: outcome !== 'dropped', outcome: outcome as any };
    };
    await alerts.sweepInventoryExceptionPages({ publish });
    expect(
      (await db.inventoryException.findUnique({ where: { id: exceptionId } })).onset_paged_at,
    ).toBeNull();
    await alerts.sweepInventoryExceptionPages({ publish });
    expect(
      (await db.inventoryException.findUnique({ where: { id: exceptionId } })).onset_paged_at,
    ).not.toBeNull();
    expect(calls).toEqual([
      `inventory-exception:${exceptionId}`,
      `inventory-exception:${exceptionId}`,
    ]);
  });
});
