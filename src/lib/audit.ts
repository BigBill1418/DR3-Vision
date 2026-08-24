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

/**
 * Optional writer client. Pass `{ tx }` to enlist the audit row in an
 * already-open interactive transaction so a state flip and its audit commit (or
 * roll back) atomically — there is no "decision stands but the audit is missing"
 * window (M2). Omit it and the global singleton is used, unchanged, so every
 * existing caller keeps working with no edits.
 */
type AuditOpts = { tx?: Prisma.TransactionClient };

/**
 * The single mapping from caller-shaped args to a stored row.
 *
 * Extracted so {@link writeAudit} and {@link writeAuditMany} cannot produce
 * different rows for the same input. They are two statements, not two formats —
 * a hand-written second mapping is how a batched writer comes to drop
 * `actor_label` or store `null` where the singular writer stores `JsonNull`.
 */
function toAuditRow(args: AuditArgs): Prisma.AuditLogCreateManyInput {
  return {
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
  };
}

export async function writeAudit(args: AuditArgs, opts?: AuditOpts): Promise<void> {
  const client = opts?.tx ?? prisma;
  await client.auditLog.create({ data: toAuditRow(args) });
}

/**
 * ADR-0113 D4 — many audit rows, ONE round trip.
 *
 * `rejectLoad` soft-voids every live stack on the load inside a single
 * interactive transaction, and each voided stack gets its own row so
 * "what happened to stack X" stays answerable through the
 * `([table_name, row_id])` index — the same shape `voidStack` writes, because a
 * stack taken back by a rejection and a stack taken back by hand are the same
 * fact about that stack.
 *
 * A loop of `writeAudit` would be correct and would also be the bug: ledger mode
 * writes one `load_stacks` row per mattress, so a 240-unit load means 240
 * sequential round trips inside an interactive transaction, against Prisma's
 * 5-second default timeout. The whole point of doing this in one transaction is
 * that it cannot half-happen.
 *
 * Empty input is a no-op rather than an empty `createMany`: a rejected load with
 * nothing counted yet is the ordinary case, not an edge one.
 */
export async function writeAuditMany(rows: AuditArgs[], opts?: AuditOpts): Promise<void> {
  if (rows.length === 0) return;
  const client = opts?.tx ?? prisma;
  await client.auditLog.createMany({ data: rows.map(toAuditRow) });
}
