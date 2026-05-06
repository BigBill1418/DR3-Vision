// T-014 — admin Audit Log viewer API.
//
// GET /api/admin/audit
//
// Query params:
//   actor   = user id of the actor
//   table   = audit_log.table_name to filter on
//   from    = YYYY-MM-DD lower bound (inclusive, UTC midnight)
//   to      = YYYY-MM-DD upper bound (inclusive, UTC end-of-day)
//   action  = comma-separated AuditAction enum values
//   page    = 1-based page index
//   per_page= 1..200, default 50
//
// Append-only — no POST/PATCH/DELETE on this resource (CLAUDE.md
// hard rule #6, ADR-0007).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { listAuditEntries, AUDIT_ACTIONS } from '@/lib/admin-audit';
import { parseAuditParams, isoDateBounds } from '@/lib/admin-audit-url';
import { adminMessages as M } from '@/app/admin/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// We re-validate per-page server-side; the URL parser tolerates junk
// but the API contract should reject it loudly so callers fix their
// integrations rather than silently fall back to defaults.
const querySchema = z.object({
  actor: z.string().min(1).optional(),
  table: z.string().min(1).max(64).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  action: z.string().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    actor: url.searchParams.get('actor') ?? undefined,
    table: url.searchParams.get('table') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    action: url.searchParams.get('action') ?? undefined,
    page: url.searchParams.get('page') ?? undefined,
    per_page: url.searchParams.get('per_page') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: M.errors.invalidPayload }, { status: 400 });
  }

  const state = parseAuditParams({
    actor: parsed.data.actor,
    table: parsed.data.table,
    from: parsed.data.from,
    to: parsed.data.to,
    action: parsed.data.action,
    page: parsed.data.page,
  });
  const bounds = isoDateBounds(state.from, state.to);

  // Drop unknown action tokens silently — the parser already filtered
  // them. If every token was unknown the array is empty and we treat
  // it as "no action filter". This matches the loads-list behavior
  // (status filter "all" === no filter).
  const validActions = state.actions.filter((a) => (AUDIT_ACTIONS as readonly string[]).includes(a));

  const per_page = parsed.data.per_page ? Number.parseInt(parsed.data.per_page, 10) : 50;

  const result = await listAuditEntries({
    filters: {
      actor_user_id: state.actor ?? undefined,
      table_name: state.table ?? undefined,
      from: bounds.from ?? undefined,
      to: bounds.to ?? undefined,
      actions: validActions.length > 0 ? validActions : undefined,
    },
    page: state.page,
    per_page,
  });

  // The DTO's `actor_user` may be null; the JSON contract preserves
  // that distinction so the client can render "system" rows clearly.
  return NextResponse.json({
    rows: result.rows,
    total: result.total,
    page: result.page,
    per_page: result.per_page,
    total_pages: result.total_pages,
  });
}
