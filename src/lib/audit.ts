import { Prisma, type AuditAction } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// Append-only audit log helper (ADR-0007). Every mutation that an
// operator, manager, admin, or system process performs on a
// load-related row should leave a trail here. Callers pass the
// `before`/`after` shapes they have on hand; the helper writes
// nothing to PII columns. Never deletes or updates audit rows —
// CLAUDE.md hard rule #6.

type AuditArgs = {
  actor_user_id?: string | null;
  actor_label?: string | null; // e.g. "system:bootstrap-cli", "system:r2-purge"
  action: AuditAction;
  table_name: string;
  row_id: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  user_agent?: string | null;
};

export async function writeAudit(args: AuditArgs): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actor_user_id: args.actor_user_id ?? null,
      actor_label: args.actor_label ?? null,
      action: args.action,
      table_name: args.table_name,
      row_id: args.row_id,
      // Cast to satisfy Prisma's Json input type. Stringifying then
      // re-parsing is the cheapest portable serializer for "anything
      // serializable that I have on hand."
      before:
        args.before === undefined
          ? Prisma.JsonNull
          : (JSON.parse(JSON.stringify(args.before)) as Prisma.InputJsonValue),
      after:
        args.after === undefined
          ? Prisma.JsonNull
          : (JSON.parse(JSON.stringify(args.after)) as Prisma.InputJsonValue),
      ip: args.ip ?? null,
      user_agent: args.user_agent ?? null,
    },
  });
}
