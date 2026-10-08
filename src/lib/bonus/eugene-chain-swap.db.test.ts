// ADR-0019.7 — the Eugene chain slot-swap migration against a REAL Postgres.
//
//   1. From the exact production pre-state (facility Rick, ops Patrick, facility
//      override Bill+Patrick, ops override Bill) it produces facility Patrick,
//      ops Rick, facility override Bill+Rick, ops override Bill, and writes ONE
//      audit_log row with before/after.
//   2. A second run is a no-op (no second audit row).
//   3. From any other state it changes nothing (it never overwrites a seat
//      someone else has filled since).
//   4. The Woodland chain is never touched.
//
// Runs in the ADR-0078 real-database lane (`db.test.ts` path filter). Creates the
// sites/users the migration keys on when absent and removes only what it created.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error('eugene-chain-swap.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL');
}

const MIGRATION = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    'prisma/migrations/20260868_adr0019_7_eugene_chain_slot_swap/migration.sql',
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
const EMAILS = {
  rick: 'rick.albritton@svdp.us',
  pat: 'patrick.dills@svdp.us',
  bill: 'bill.barnard@svdp.us',
  janette: 'janette.tomas@svdp.us',
  morena: 'morena.gomez@svdp.us',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
const createdSites: string[] = [];
const createdUsers: string[] = [];
const site: Record<string, string> = {};
const user: Record<keyof typeof EMAILS, string> = {} as never;

async function chainOf(code: 'eugene' | 'woodland') {
  return db.bonusSignatureChain.findUnique({ where: { site_id: site[code] } });
}
const auditCount = (rowId: string) =>
  db.auditLog.count({
    where: {
      table_name: 'bonus_signature_chains',
      row_id: rowId,
      actor_label: { contains: 'ADR-0019.7' },
    },
  });

describe.skipIf(!REAL_DB)('ADR-0019.7 migration on a real database', () => {
  beforeEach(async () => {
    if (!db) {
      const { PrismaClient } = await import('@prisma/client');
      db = new PrismaClient({ datasources: { db: { url: REAL_DB! } } }) as PrismaClient;
      for (const [code, jurisdiction] of [
        ['eugene', 'oregon'],
        ['woodland', 'california'],
      ] as const) {
        const existing = await db.site.findUnique({ where: { code } });
        const row =
          existing ??
          (await db.site.create({
            data: { ...SITE_FIELDS, code, name: `ADR-0019.7 ${code}`, jurisdiction },
          }));
        if (!existing) createdSites.push(row.id);
        site[code] = row.id;
      }
      for (const [k, email] of Object.entries(EMAILS) as [keyof typeof EMAILS, string][]) {
        const existing = await db.user.findUnique({ where: { email } });
        const row =
          existing ??
          (await db.user.create({
            data: { email, name: `ADR-0019.7 ${k}`, role: k === 'bill' ? 'admin' : 'manager' },
          }));
        if (!existing) createdUsers.push(row.id);
        user[k] = row.id;
      }
    }
    await db.bonusSignatureChain.deleteMany({ where: { site_id: { in: Object.values(site) } } });
    await db.bonusSignatureChain.create({
      data: {
        site_id: site['eugene'],
        facility_signer_user_id: user.rick,
        facility_override_actor_ids: `${user.bill},${user.pat}`,
        ops_signer_user_id: user.pat,
        ops_override_actor_ids: user.bill,
        auto_override_actor_user_id: user.bill,
      },
    });
    await db.bonusSignatureChain.create({
      data: {
        site_id: site['woodland'],
        facility_signer_user_id: user.janette,
        facility_override_actor_ids: `${user.bill},${user.morena}`,
        ops_signer_user_id: user.morena,
        ops_override_actor_ids: user.bill,
        auto_override_actor_user_id: user.bill,
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.bonusSignatureChain.deleteMany({ where: { site_id: { in: Object.values(site) } } });
    // audit_log rows are left in place (append-only, hard rule #6); they hold
    // user ids only inside JSON, so they do not block removing the test users.
    if (createdUsers.length) await db.user.deleteMany({ where: { id: { in: createdUsers } } });
    if (createdSites.length) await db.site.deleteMany({ where: { id: { in: createdSites } } });
    await db.$disconnect();
  });

  it('swaps the slots from the production pre-state, audits once, and is idempotent', async () => {
    const before = await chainOf('eugene');
    const auditsBefore = await auditCount(before.id);
    const woodlandBefore = await chainOf('woodland');

    await db.$executeRawUnsafe(MIGRATION);
    await db.$executeRawUnsafe(MIGRATION);

    expect(await chainOf('eugene')).toMatchObject({
      facility_signer_user_id: user.pat,
      facility_override_actor_ids: `${user.bill},${user.rick}`,
      ops_signer_user_id: user.rick,
      ops_override_actor_ids: user.bill,
      auto_override_actor_user_id: user.bill,
    });
    expect((await auditCount(before.id)) - auditsBefore).toBe(1);
    expect(await chainOf('woodland')).toEqual(woodlandBefore);
  });

  it('changes nothing when the Eugene chain is not in the expected pre-swap state', async () => {
    const before = await chainOf('eugene');
    await db.bonusSignatureChain.update({
      where: { id: before.id },
      data: { ops_signer_user_id: user.janette },
    });
    const drifted = await chainOf('eugene');
    const auditsBefore = await auditCount(before.id);

    await db.$executeRawUnsafe(MIGRATION);

    expect(await chainOf('eugene')).toEqual(drifted);
    expect(await auditCount(before.id)).toBe(auditsBefore);
  });
});
