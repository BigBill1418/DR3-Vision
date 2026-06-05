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
import { requireBonusAccess } from '@/lib/bonus/access';
import { upsertDailyEntries, type DailyEntryInput } from '@/lib/bonus/daily-entry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `entry_date` is an optional ISO date (YYYY-MM-DD). Omitted = today (server
// clock). Past days are editable while the month is draft (ADR-0019 §7), so the
// client may submit a back-dated day; the data layer scopes it to that day's
// draft month.
const entrySchema = z.object({
  bonus_employee_id: z.string().min(1),
  mattress_count: z.number().int().min(0).max(999),
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

function parseEntryDate(iso: string | undefined): Date {
  if (!iso) return new Date();
  // Build a UTC-midnight date from the calendar day; the data layer normalizes
  // again, but parsing as UTC here avoids a local-zone shift on the boundary.
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireBonusAccess();
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
  const inputs: DailyEntryInput[] = parsed.data.entries.map((e) => ({
    bonus_employee_id: e.bonus_employee_id,
    mattress_count: e.mattress_count,
    note: e.note,
  }));

  const result = await upsertDailyEntries(ctx.siteId, date, inputs, {
    actorUserId: ctx.userId,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent') ?? null,
  });

  if (result.ok) {
    return NextResponse.json({ monthId: result.monthId, entries: result.entries }, { status: 200 });
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
        { error: 'Mattress counts must be whole numbers from 0 to 999.' },
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
