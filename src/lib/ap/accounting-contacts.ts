// ADR-0141 D3 — the accounting-staff list a team submission picks its outcome
// recipient from. Admin-managed at /admin/ap/config; every create, edit and
// deactivate is audited (CLAUDE.md hard rule #6). Rows are never deleted: a
// decided team request keeps a foreign key to the contact it was routed to.

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { internalDomain } from './senders';

const TABLE = 'ap_accounting_contacts';

export interface AccountingContactDto {
  id: string;
  displayName: string;
  email: string;
  active: boolean;
}

export type ContactInputReason =
  | 'name_required'
  | 'email_not_internal'
  | 'email_taken'
  | 'not_found';

export type ContactResult =
  | { ok: true; contact: AccountingContactDto }
  | { ok: false; reason: ContactInputReason };

/** Lower-cased address when it is a plain @<internal domain> mailbox, else null. */
export function normalizeInternalEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  const domain = internalDomain().replace(/\./g, '\\.');
  return new RegExp(`^[^@\\s]+@${domain}$`).test(email) ? email : null;
}

function toDto(r: {
  id: string;
  display_name: string;
  email: string;
  active: boolean;
}): AccountingContactDto {
  return { id: r.id, displayName: r.display_name, email: r.email, active: r.active };
}

const SELECT = { id: true, display_name: true, email: true, active: true } as const;

export async function listAccountingContacts(
  opts: { activeOnly?: boolean } = {},
  prisma: PrismaClient = defaultPrisma,
): Promise<AccountingContactDto[]> {
  const rows = await prisma.apAccountingContact.findMany({
    where: opts.activeOnly ? { active: true } : {},
    select: SELECT,
    orderBy: { display_name: 'asc' },
  });
  return rows.map(toDto);
}

export async function createAccountingContact(
  input: { displayName: string; email: string; actorUserId: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<ContactResult> {
  const displayName = input.displayName.trim();
  if (!displayName) return { ok: false, reason: 'name_required' };
  const email = normalizeInternalEmail(input.email);
  if (!email) return { ok: false, reason: 'email_not_internal' };
  const clash = await prisma.apAccountingContact.findUnique({ where: { email }, select: SELECT });
  if (clash) return { ok: false, reason: 'email_taken' };
  const row = await prisma.apAccountingContact.create({
    data: {
      display_name: displayName,
      email,
      active: true,
      created_by: input.actorUserId,
      updated_by: input.actorUserId,
    },
    select: SELECT,
  });
  await writeAudit({
    actor_user_id: input.actorUserId,
    action: 'insert',
    table_name: TABLE,
    row_id: row.id,
    after: { display_name: row.display_name, email: row.email, active: true },
  });
  return { ok: true, contact: toDto(row) };
}

export async function updateAccountingContact(
  input: {
    id: string;
    displayName?: string;
    email?: string;
    active?: boolean;
    actorUserId: string;
  },
  prisma: PrismaClient = defaultPrisma,
): Promise<ContactResult> {
  const before = await prisma.apAccountingContact.findUnique({
    where: { id: input.id },
    select: SELECT,
  });
  if (!before) return { ok: false, reason: 'not_found' };
  const data: { display_name?: string; email?: string; active?: boolean } = {};
  if (input.displayName !== undefined) {
    const name = input.displayName.trim();
    if (!name) return { ok: false, reason: 'name_required' };
    data.display_name = name;
  }
  if (input.email !== undefined) {
    const email = normalizeInternalEmail(input.email);
    if (!email) return { ok: false, reason: 'email_not_internal' };
    if (email !== before.email) {
      const clash = await prisma.apAccountingContact.findUnique({
        where: { email },
        select: SELECT,
      });
      if (clash) return { ok: false, reason: 'email_taken' };
    }
    data.email = email;
  }
  if (input.active !== undefined) data.active = input.active;
  const row = await prisma.apAccountingContact.update({
    where: { id: input.id },
    data: { ...data, updated_by: input.actorUserId },
    select: SELECT,
  });
  await writeAudit({
    actor_user_id: input.actorUserId,
    action: 'update',
    table_name: TABLE,
    row_id: row.id,
    before: { display_name: before.display_name, email: before.email, active: before.active },
    after: { display_name: row.display_name, email: row.email, active: row.active },
  });
  return { ok: true, contact: toDto(row) };
}
