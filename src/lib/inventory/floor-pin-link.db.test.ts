// ADR-0072 Amendment 2 — the manager → operator floor-PIN link, against a REAL
// Postgres and the REAL `verifyPin` (Argon2id, sliding-window lockout).
//
// What a fake cannot show, and this does:
//   1. The migration's constraints exist and behave: one operator backs at most one
//      manager (UNIQUE), no self-link (CHECK), deleting the operator clears the link
//      (ON DELETE SET NULL).
//   2. The PIN typed on the iPad is checked against the LINKED operator row, and the
//      lockout that `verifyPin` keeps lands on that row.
//   3. `verifyPin`'s operator-only rule still bites through the link: a link to a
//      manager account or an inactive operator is just a wrong PIN.
//   4. The four-eyes rule holds by PERSON on both release paths.
//   5. `discardHold` and `releaseHold` racing on one hold: exactly one wins.
//   6. The admin link script refuses what it must and writes link + audit together.
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter), where
// DATABASE_URL (the `@/lib/prisma` singleton `verifyPin` uses) and
// DR3_TEST_DATABASE_URL are the same database.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

const NS = 'adr0072am2';
const SITE = `${NS}-site`;
const OTHER_SITE = `${NS}-site-b`;
const ADMIN = `${NS}-admin`;
const OPERATOR = `${NS}-operator`; // an unrelated floor operator who enters counts
const MORENA_OP = `${NS}-morena-op`; // Morena's operator login (has the PIN)
const MORENA_MGR = `${NS}-morena-mgr`; // Morena's manager login (no PIN)
const JANETTE_MGR = `${NS}-janette-mgr`; // a manager with no link
const OTHER_SITE_OP = `${NS}-op-b`;

const PIN = '4826';

const siteFields = (code: string) => ({
  code,
  name: `DR3 ${code}`,
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
});

let pinHash = '';

async function upsertUser(
  id: string,
  role: 'operator' | 'manager' | 'admin',
  site: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const reset = {
    role,
    is_active: true,
    primary_site_id: site,
    pin_hash: role === 'operator' ? pinHash : null,
    pin_failed_attempts: 0,
    pin_first_failed_at: null,
    pin_locked_until: null,
    last_login_at: null,
    floor_user_id: null,
    ...extra,
  };
  await db.user.upsert({
    where: { id },
    update: reset,
    create: { id, name: id, ...reset },
  });
}

// Operational rows only: the audit log is append-only and FKs to users, so the
// users stay standing (same reasoning as anchor-holds.db.test.ts).
async function cleanup(): Promise<void> {
  await db.$executeRawUnsafe(
    `DELETE FROM "inventory_count_holds" WHERE "site_id" IN ('${SITE}', '${OTHER_SITE}')`,
  );
  await db.$executeRawUnsafe(
    `DELETE FROM "site_inventory_snapshots" WHERE "site_id" IN ('${SITE}', '${OTHER_SITE}')`,
  );
  await db.$executeRawUnsafe(`UPDATE "users" SET "floor_user_id" = NULL WHERE "id" LIKE '${NS}-%'`);
}

async function seed(): Promise<void> {
  await cleanup();
  for (const s of [SITE, OTHER_SITE]) {
    await db.site.upsert({ where: { id: s }, update: {}, create: { id: s, ...siteFields(s) } });
  }
  // Links are cleared above, before any UNIQUE could collide on re-seed.
  await upsertUser(ADMIN, 'admin', SITE);
  await upsertUser(OPERATOR, 'operator', SITE);
  await upsertUser(MORENA_OP, 'operator', SITE);
  await upsertUser(MORENA_MGR, 'manager', SITE, { floor_user_id: MORENA_OP });
  await upsertUser(JANETTE_MGR, 'manager', SITE);
  await upsertUser(OTHER_SITE_OP, 'operator', OTHER_SITE);
}

async function pendingHold(createdBy: string): Promise<string> {
  const hold = await db.inventoryCountHold.create({
    data: {
      site_id: SITE,
      units_total: 2_400,
      units_in_processing: 0,
      program_units: 2_400,
      non_program_units: 0,
      pool_attribution: 'measured',
      prior_total: 1_000,
      new_total: 2_400,
      swing_pct: 140,
      threshold_pct: 25,
      status: 'pending',
      created_by: createdBy,
    },
    select: { id: true },
  });
  return hold.id;
}

describe.skipIf(!REAL_DB)('ADR-0072 Am.2 — floor PIN link (real Postgres)', () => {
  beforeAll(async () => {
    const { PrismaClient: PC } = (await import('@prisma/client')) as {
      PrismaClient: typeof PrismaClient;
    };
    db = new PC({ datasources: { db: { url: REAL_DB! } } });
    const { hashPassword } = await import('@/lib/argon');
    pinHash = await hashPassword(PIN);
  });

  beforeEach(seed);

  afterAll(async () => {
    if (db) {
      await cleanup();
      await db.$disconnect();
    }
    const { prisma } = await import('@/lib/prisma');
    await prisma.$disconnect();
  });

  // ── 1. The migration ─────────────────────────────────────────────────────
  describe('migration constraints', () => {
    it('one operator account backs at most one manager account (UNIQUE)', async () => {
      await expect(
        db.user.update({ where: { id: JANETTE_MGR }, data: { floor_user_id: MORENA_OP } }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('an account cannot link to itself (CHECK)', async () => {
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "users" SET "floor_user_id" = '${JANETTE_MGR}' WHERE "id" = '${JANETTE_MGR}'`,
        ),
      ).rejects.toThrow(/users_floor_user_id_not_self/);
    });

    it('deleting the operator row clears the link (ON DELETE SET NULL)', async () => {
      // A throwaway operator with no audit rows, so the delete is not blocked.
      const temp = `${NS}-temp-${randomUUID()}`;
      await upsertUser(temp, 'operator', SITE);
      await db.user.update({ where: { id: JANETTE_MGR }, data: { floor_user_id: temp } });
      await db.user.delete({ where: { id: temp } });
      const row = await db.user.findUnique({ where: { id: JANETTE_MGR } });
      expect(row.floor_user_id).toBeNull();
    });
  });

  // ── 2–3. PIN verification through the link ───────────────────────────────
  describe('PIN path', () => {
    it("releases with the LINKED operator account's PIN", async () => {
      const holdId = await pendingHold(OPERATOR);
      const { releaseHold } = await import('./anchor-holds');
      const out = await releaseHold(db, {
        holdId,
        approverUserId: MORENA_MGR,
        path: 'pin',
        pin: PIN,
      });
      expect(out.snapshotId).toBeTruthy();
      const hold = await db.inventoryCountHold.findUnique({ where: { id: holdId } });
      expect(hold.status).toBe('approved');
      expect(hold.approved_by).toBe(MORENA_MGR);
      const audit = await db.auditLog.findFirst({
        where: { table_name: 'inventory_count_holds', row_id: holdId, action: 'update' },
      });
      expect(audit.after.pin_verified_user_id).toBe(MORENA_OP);
    });

    it('an unlinked manager gets NoFloorPinError and nothing is counted against any PIN', async () => {
      const holdId = await pendingHold(OPERATOR);
      const { releaseHold, NoFloorPinError } = await import('./anchor-holds');
      await expect(
        releaseHold(db, { holdId, approverUserId: JANETTE_MGR, path: 'pin', pin: PIN }),
      ).rejects.toBeInstanceOf(NoFloorPinError);
      const hold = await db.inventoryCountHold.findUnique({ where: { id: holdId } });
      expect(hold.status).toBe('pending');
    });

    it('a link to a MANAGER account is refused as no_floor_pin (never reaches verifyPin)', async () => {
      await db.user.update({ where: { id: JANETTE_MGR }, data: { floor_user_id: ADMIN } });
      const holdId = await pendingHold(OPERATOR);
      const { releaseHold, NoFloorPinError } = await import('./anchor-holds');
      await expect(
        releaseHold(db, { holdId, approverUserId: JANETTE_MGR, path: 'pin', pin: PIN }),
      ).rejects.toBeInstanceOf(NoFloorPinError);
    });

    it('a link to an INACTIVE operator is refused as no_floor_pin', async () => {
      await db.user.update({ where: { id: MORENA_OP }, data: { is_active: false } });
      const holdId = await pendingHold(OPERATOR);
      const { releaseHold, NoFloorPinError } = await import('./anchor-holds');
      await expect(
        releaseHold(db, { holdId, approverUserId: MORENA_MGR, path: 'pin', pin: PIN }),
      ).rejects.toBeInstanceOf(NoFloorPinError);
    });

    it('wrong PINs lock the LINKED operator account; the right PIN then fails too', async () => {
      const holdId = await pendingHold(OPERATOR);
      const { releaseHold, BadPinError, PinLockedError } = await import('./anchor-holds');
      // Four wrong PINs read as wrong; the fifth trips the lockout and says so.
      for (let i = 0; i < 5; i++) {
        await expect(
          releaseHold(db, { holdId, approverUserId: MORENA_MGR, path: 'pin', pin: '9157' }),
        ).rejects.toBeInstanceOf(i < 4 ? BadPinError : PinLockedError);
      }
      const op = await db.user.findUnique({ where: { id: MORENA_OP } });
      expect(op.pin_locked_until).not.toBeNull();
      expect(op.pin_locked_until.getTime()).toBeGreaterThan(Date.now());
      // The manager row carries no PIN state at all.
      const mgr = await db.user.findUnique({ where: { id: MORENA_MGR } });
      expect(mgr.pin_failed_attempts).toBe(0);
      expect(mgr.pin_hash).toBeNull();
      await expect(
        releaseHold(db, { holdId, approverUserId: MORENA_MGR, path: 'pin', pin: PIN }),
      ).rejects.toBeInstanceOf(PinLockedError);
      const hold = await db.inventoryCountHold.findUnique({ where: { id: holdId } });
      expect(hold.status).toBe('pending');
    });
  });

  // ── 4. Four-eyes by person ───────────────────────────────────────────────
  describe('self-release is refused by PERSON', () => {
    it.each(['pin', 'remote'] as const)(
      '%s: a count entered on the operator login cannot be released by the linked manager',
      async (path) => {
        const holdId = await pendingHold(MORENA_OP);
        const { releaseHold, SelfReleaseRefusedError } = await import('./anchor-holds');
        await expect(
          releaseHold(db, { holdId, approverUserId: MORENA_MGR, path, pin: PIN }),
        ).rejects.toBeInstanceOf(SelfReleaseRefusedError);
        // Checked before the PIN: no attempt was recorded against the operator.
        const op = await db.user.findUnique({ where: { id: MORENA_OP } });
        expect(op.pin_failed_attempts).toBe(0);
        expect(op.last_login_at).toBeNull();
      },
    );

    it.each(['pin', 'remote'] as const)(
      '%s: a count entered on the manager login cannot be released by that manager',
      async (path) => {
        const holdId = await pendingHold(MORENA_MGR);
        const { releaseHold, SelfReleaseRefusedError } = await import('./anchor-holds');
        await expect(
          releaseHold(db, { holdId, approverUserId: MORENA_MGR, path, pin: PIN }),
        ).rejects.toBeInstanceOf(SelfReleaseRefusedError);
      },
    );

    it("another manager may release the linked person's count", async () => {
      const holdId = await pendingHold(MORENA_OP);
      const { releaseHold } = await import('./anchor-holds');
      await releaseHold(db, { holdId, approverUserId: JANETTE_MGR, path: 'remote' });
      const hold = await db.inventoryCountHold.findUnique({ where: { id: holdId } });
      expect(hold.status).toBe('approved');
    });
  });

  // ── 5. discard vs release ────────────────────────────────────────────────
  it('a discard racing a release on one hold: exactly one wins, and the record agrees', async () => {
    const holdId = await pendingHold(OPERATOR);
    const { releaseHold, discardHold, HoldNotPendingError } = await import('./anchor-holds');
    const settled = await Promise.allSettled([
      releaseHold(db, { holdId, approverUserId: JANETTE_MGR, path: 'remote' }),
      discardHold(db, { holdId, userId: OPERATOR, reason: 'race' }),
    ]);
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(HoldNotPendingError);

    const hold = await db.inventoryCountHold.findUnique({ where: { id: holdId } });
    const anchors = await db.siteInventorySnapshot.count({
      where: { site_id: SITE, snapshot_kind: 'physical', voided_at: null },
    });
    const audits = await db.auditLog.count({
      where: { table_name: 'inventory_count_holds', row_id: holdId, action: 'update' },
    });
    // Pre-fix, an unguarded discard could stamp `discarded` over a release whose
    // anchor stood: status discarded AND one anchor. This race does not force an
    // ordering (the release does more reads before its CAS, so the discard usually
    // lands first); it pins the invariant. The two-discards test below is the one
    // that FAILS against the unguarded update (falsified 2026-11-06: 2 audit rows).
    expect(anchors).toBe(hold.status === 'approved' ? 1 : 0);
    expect(audits).toBe(1);
  });

  it('two discards of one hold: one wins, one audit row', async () => {
    const holdId = await pendingHold(OPERATOR);
    const { discardHold } = await import('./anchor-holds');
    const settled = await Promise.allSettled([
      discardHold(db, { holdId, userId: OPERATOR, reason: 'a' }),
      discardHold(db, { holdId, userId: JANETTE_MGR, reason: 'b' }),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const audits = await db.auditLog.count({
      where: { table_name: 'inventory_count_holds', row_id: holdId, action: 'update' },
    });
    expect(audits).toBe(1);
  });

  // ── 6. The admin link script ─────────────────────────────────────────────
  describe('scripts/link-floor-pin.mjs', () => {
    const base = {
      apply: false,
      clear: false,
      actor: ADMIN,
      manager: JANETTE_MGR,
      operator: OPERATOR,
    };

    it('dry run writes nothing; --apply writes the link and its audit row', async () => {
      const { linkFloorPin } = await import('../../../scripts/link-floor-pin.mjs');
      const dry = await linkFloorPin(db, base);
      expect(dry.action).toBe('link');
      expect((await db.user.findUnique({ where: { id: JANETTE_MGR } })).floor_user_id).toBeNull();

      const auditsBefore = await db.auditLog.count({
        where: { table_name: 'users', row_id: JANETTE_MGR },
      });
      await linkFloorPin(db, { ...base, apply: true });
      expect((await db.user.findUnique({ where: { id: JANETTE_MGR } })).floor_user_id).toBe(
        OPERATOR,
      );
      const audit = await db.auditLog.findFirst({
        where: { table_name: 'users', row_id: JANETTE_MGR },
        orderBy: { created_at: 'desc' },
      });
      expect(audit.actor_user_id).toBe(ADMIN);
      expect(audit.after.floor_user_id).toBe(OPERATOR);
      expect(await db.auditLog.count({ where: { table_name: 'users', row_id: JANETTE_MGR } })).toBe(
        auditsBefore + 1,
      );

      // Re-running is a no-op; --clear removes it.
      expect((await linkFloorPin(db, { ...base, apply: true })).action).toBe('none');
      await linkFloorPin(db, { ...base, operator: '', clear: true, apply: true });
      expect((await db.user.findUnique({ where: { id: JANETTE_MGR } })).floor_user_id).toBeNull();
    });

    it.each([
      ['a non-admin actor', { actor: MORENA_MGR }, /active admin/],
      ['an operator from another site', { operator: OTHER_SITE_OP }, /same primary site/],
      ['a target that is not an operator', { operator: ADMIN }, /active operator/],
      ['an operator already linked from someone else', { operator: MORENA_OP }, /already linked/],
      [
        'a manager account that is an operator',
        { manager: OPERATOR, operator: MORENA_OP },
        /active manager/,
      ],
    ])('refuses %s', async (_label, over, msg) => {
      const { linkFloorPin, LinkRefused } = await import('../../../scripts/link-floor-pin.mjs');
      const p = linkFloorPin(db, { ...base, ...over, apply: true });
      await expect(p).rejects.toBeInstanceOf(LinkRefused);
      await expect(linkFloorPin(db, { ...base, ...over, apply: true })).rejects.toThrow(msg);
      expect((await db.user.findUnique({ where: { id: JANETTE_MGR } })).floor_user_id).toBeNull();
    });
  });
});
