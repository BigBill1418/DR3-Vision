// ADR-0019 §4/§7 — Bonus daily-entry write endpoint (T-105).
//
// POST /api/bonus/entries — upsert a batch of daily mattress-count entries for a
// single calendar day. Gates through `requireBonusAccess()` (Woodland-scoped):
// anonymous → 401, operator / Eugene manager (Rick) → 403, misseeded site → 404.
// The actor (`entered_by_user_id`) + the site come from the returned
// BonusContext; the client is NEVER trusted for either (CLAUDE.md hard rule #2).
//
// Writes are blocked with 409 once the month leaves `draft` (ADR-0019 §7) via the
// T-106 editability guard inside the data layer. Every upsert lands an audit row
// in the same transaction (CLAUDE.md hard rule #6).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import {
  upsertDailyEntries,
  isValidMattressCount,
  NoOpenPayPeriodError,
  type DailyEntryInput,
} from '@/lib/bonus/daily-entry';
import {
  resolveAmendmentApprover,
  AmendmentWorkflowForbiddenError,
} from '@/lib/bonus/amendment-approvers';
import { prisma } from '@/lib/prisma';
import { appToday, appTodayISO, dayKeyUTCFromISO } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `entry_date` is an optional ISO date (YYYY-MM-DD). Omitted = Pacific "today"
// (NEVER the server's UTC clock — see @/lib/time). Back-dating to any other
// Pacific calendar day is an ADMIN-ONLY action (Bill); a non-admin submitting a
// non-today date is rejected 403 below. The data layer scopes the chosen day to
// that day's draft month (ADR-0019 §7).
const entrySchema = z.object({
  bonus_employee_id: z.string().min(1),
  // T-330: 0..999 with at most one decimal place (Decimal(5,1)); negatives and
  // >1 decimal place rejected. Single source of truth = isValidMattressCount.
  mattress_count: z
    .number()
    .refine(isValidMattressCount, 'Count must be 0–999 with at most one decimal place.'),
  note: z
    .union([z.string().max(2000), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

const bodySchema = z.object({
  entry_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  entries: z.array(entrySchema).min(1).max(200),
});

/** The Pacific calendar day for a client-supplied ISO, or Pacific today if omitted. */
function parseEntryDate(iso: string | undefined): Date {
  if (!iso) return appToday();
  // Build the canonical UTC-midnight @db.Date key from the calendar day.
  return dayKeyUTCFromISO(iso);
}

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireBonusAccess(siteFromRequest(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request payload.' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request payload.', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const date = parseEntryDate(parsed.data.entry_date);

  // ADR-0028: a non-admin may submit for TODAY (direct write) or a PRIOR day
  // (which the data layer routes through the four-eyes amendment workflow). Only
  // a FUTURE date is rejected outright for a non-admin — there is no legitimate
  // path to record a count for a day that has not happened. Admins (Bill) keep
  // unconstrained back-dating (the escape valve). The client is NEVER trusted:
  // the data layer (`upsertDailyEntries` → `shouldRequireAmendment`) re-enforces
  // draft/period/prior-day scoping and returns `requires_amendment` for an
  // in-period prior-day count change/insert; a prior day in a CLOSED period
  // still surfaces `month_locked` (409) and an uncovered day still surfaces
  // `NoOpenPayPeriodError` (409). Comparison is on the UTC-midnight @db.Date key.
  if (!ctx.isAdmin && date.getTime() > appToday().getTime()) {
    return NextResponse.json(
      { error: `Entries cannot be recorded for a future date (today is ${appTodayISO()}).` },
      { status: 403 },
    );
  }

  const inputs: DailyEntryInput[] = parsed.data.entries.map((e) => ({
    bonus_employee_id: e.bonus_employee_id,
    mattress_count: e.mattress_count,
    note: e.note,
  }));

  let result;
  try {
    result = await upsertDailyEntries(ctx.siteId, date, inputs, {
      actorUserId: ctx.userId,
      isAdmin: ctx.isAdmin,
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: req.headers.get('user-agent') ?? null,
    });
  } catch (e) {
    // No seeded pay period covers the chosen day (ADR-0019.1). Surface a clean
    // 409 rather than a 500 — periods are pre-seeded, so this is an out-of-range
    // calendar day, not a server fault.
    if (e instanceof NoOpenPayPeriodError) {
      return NextResponse.json(
        { error: 'There is no open bonus pay period for that date.' },
        { status: 409 },
      );
    }
    throw e;
  }

  if (result.ok === true) {
    return NextResponse.json({ monthId: result.monthId, entries: result.entries }, { status: 200 });
  }

  // ADR-0028: a prior-day count change by a non-admin manager routes through the
  // four-eyes amendment workflow instead of writing directly. Surface a 409 with
  // the pending payload so the client can pivot to the Request Edit modal. We
  // resolve the approver's DISPLAY NAME server-side (the counterpart signer via
  // the signature chain) so the modal can show "sent to X for approval". One
  // approver per requester/site, so it lives top-level on the payload — the
  // client never sees or trusts the requester/approver ids. If the requester is
  // structurally outside the workflow (Patrick / non-chain manager), the
  // amendment submit would itself 403; we surface that here rather than dangling
  // the client on a modal it could never submit.
  if (result.ok === 'requires_amendment') {
    let approverName: string | null = null;
    try {
      const { expectedApproverUserId } = await resolveAmendmentApprover(
        prisma,
        ctx.siteId,
        ctx.userId,
      );
      const approver = await prisma.user.findUnique({
        where: { id: expectedApproverUserId },
        select: { name: true },
      });
      approverName = approver?.name ?? null;
    } catch (e) {
      if (e instanceof AmendmentWorkflowForbiddenError) {
        return NextResponse.json({ error: e.forbiddenReason }, { status: 403 });
      }
      throw e;
    }
    return NextResponse.json(
      {
        error: 'requires_amendment',
        monthId: result.monthId,
        pending: result.pending,
        approverName,
      },
      { status: 409 },
    );
  }

  switch (result.reason) {
    case 'month_locked':
      return NextResponse.json(
        {
          error: `This month is ${result.state}; daily entries are locked.`,
          state: result.state,
        },
        { status: 409 },
      );
    case 'count_out_of_range':
      return NextResponse.json(
        { error: 'Mattress counts must be from 0 to 999, with at most one decimal place.' },
        { status: 422 },
      );
    case 'employee_not_in_site':
    case 'unknown_employee':
      return NextResponse.json(
        { error: 'One or more employees are not active Woodland processors.' },
        { status: 422 },
      );
    default:
      return NextResponse.json({ error: 'Server error.' }, { status: 500 });
  }
}
