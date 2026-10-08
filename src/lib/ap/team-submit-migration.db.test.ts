// ADR-0141 — migration 20260869 against a REAL Postgres (the ADR-0078 lane).
//
//   1. The accounting list is seeded with exactly Gloria Salpino, Mary Scott and
//      Yvonne Stephens (Bill, 2026-10-08 08:56 + 09:05 PDT), active, each with an
//      audit_log row.
//   2. Re-running the seed is a no-op: no duplicate contact, no second audit row.
//   3. The CHECKs hold: a team row must name its submitter/site/accountant, a
//      mailbox row may not carry an accountant, a contact must be @svdp.us.
//   4. Existing rows read as `mailbox` (the column default).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'team-submit-migration.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL',
  );
}

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    'prisma/migrations/20260869_adr0141_ap_team_submit/migration.sql',
  ),
  'utf8',
);
/** Section 4 only: the single seed statement (one WITH … INSERT … SELECT). */
const SEED = SQL.slice(SQL.indexOf('WITH seeded AS ('), SQL.indexOf('-- ── 5.')).trim();

const SEEDED = [
  ['Gloria Salpino', 'gloria.salpino@svdp.us'],
  ['Mary Scott', 'mary.scott@svdp.us'],
  ['Yvonne Stephens', 'yvonne.stephens@svdp.us'],
] as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
const createdRequests: string[] = [];

describe.skipIf(!REAL_DB)('ADR-0141 migration on a real database', () => {
  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    db = new PrismaClient({ datasources: { db: { url: REAL_DB! } } }) as PrismaClient;
  });
  afterAll(async () => {
    if (createdRequests.length > 0) {
      await db.$executeRawUnsafe(
        `DELETE FROM "ap_requests" WHERE "id" = ANY($1::text[])`,
        createdRequests,
      );
    }
    await db?.$disconnect();
  });

  it('seeds the three accountants, active, each audited once', async () => {
    const rows = await db.apAccountingContact.findMany({
      where: { email: { in: SEEDED.map(([, e]) => e) } },
      select: { id: true, display_name: true, email: true, active: true },
      orderBy: { email: 'asc' },
    });
    expect(rows.map((r: any) => [r.display_name, r.email, r.active])).toEqual(
      SEEDED.map(([n, e]) => [n, e, true]),
    );
    const audits = await db.auditLog.count({
      where: { table_name: 'ap_accounting_contacts', row_id: { in: rows.map((r: any) => r.id) } },
    });
    expect(audits).toBe(3);
  });

  it('re-running the seed changes nothing', async () => {
    const before = await db.auditLog.count({ where: { table_name: 'ap_accounting_contacts' } });
    await db.$executeRawUnsafe(SEED);
    expect(
      await db.apAccountingContact.count({ where: { email: { in: SEEDED.map(([, e]) => e) } } }),
    ).toBe(3);
    expect(await db.auditLog.count({ where: { table_name: 'ap_accounting_contacts' } })).toBe(
      before,
    );
  });

  it('refuses a non-@svdp.us or mixed-case accountant address', async () => {
    for (const email of ['someone@gmail.com', 'Someone@svdp.us', 'x@svdp.us.evil.com']) {
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "ap_accounting_contacts" ("id","display_name","email") VALUES (gen_random_uuid()::text,'X',$1)`,
          email,
        ),
      ).rejects.toThrow(/ap_accounting_contacts_email_svdp_chk/);
    }
  });

  /** `extra` = a column list and its SQL literals (test constants only). */
  async function insertRequest(cols = '', literals = ''): Promise<void> {
    const id = `adr0141-${Math.random().toString(36).slice(2)}`;
    createdRequests.push(id);
    await db.$executeRawUnsafe(
      `INSERT INTO "ap_requests" ("id","internet_message_id","received_at","sender_address","sender_validated","updated_at"${cols ? `,${cols}` : ''})
       VALUES ($1,$1,now(),'x@svdp.us',true,now()${literals ? `,${literals}` : ''})`,
      id,
    );
  }

  it('an existing-style row defaults to mailbox; a mailbox row may not carry an accountant', async () => {
    await insertRequest();
    const id = createdRequests.at(-1)!;
    const row = await db.apRequest.findUnique({ where: { id }, select: { intake_channel: true } });
    expect(row.intake_channel).toBe('mailbox');
    await expect(
      insertRequest('"outcome_recipient_email"', "'gloria.salpino@svdp.us'"),
    ).rejects.toThrow(/ap_requests_team_submit_shape_chk/);
  });

  it('a team row without its submitter, site or accountant is refused', async () => {
    await expect(
      insertRequest('"intake_channel"', '\'team_submit\'::"ApIntakeChannel"'),
    ).rejects.toThrow(/ap_requests_team_submit_shape_chk/);
  });
});
