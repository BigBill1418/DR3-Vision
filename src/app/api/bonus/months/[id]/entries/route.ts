// T-116 — Month-scoped daily-entry write endpoint (ADR-0019 §6).
//
// POST /api/bonus/months/<id>/entries — upsert a batch of daily mattress-count
// entries for a SPECIFIC month (the one being amended), for a single calendar
// day. Distinct from the T-105 /api/bonus/entries path, which resolves "the
// current month" from the entry date; this targets `id` directly so an old month
// can be corrected while amended without colliding with the live month.
//
// Gates through `requireBonusAccess()` (Woodland scope). Edits are only permitted
// while the month is editable (`draft` or `amended` — the unlock state); a signed
// month returns 409. Admin or either Woodland manager may key the corrected
// counts (matching the T-105 keyer policy); the unlock itself is admin-only.
// Every upsert lands an audit row in the same transaction (hard rule #6).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { prisma } from '@/lib/prisma';
import { isValidMattressCount } from '@/lib/bonus/daily-entry';
import {
  upsertAmendedMonthEntries,
  type AmendmentEntryDb,
  type AmendmentEntryInput,
} from '@/lib/bonus/amendment';
import { dayKeyUTCFromISO } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const entrySchema = z.object({
  bonus_employee_id: z.string().min(1),
  // T-330 follow-up: 0..999 with at most one decimal place (Decimal(5,1)); negatives
  // and >1 decimal place rejected. Single source of truth = isValidMattressCount,
  // mirroring the primary /api/bonus/entries daily-entry path. Historical Eugene
  // half-shift values (23.5/30.5) are corrected through this amendment path.
  mattress_count: z
    .number()
    .refine(isValidMattressCount, 'Count must be 0–999 with at most one decimal place.'),
  note: z
    .union([z.string().max(2000), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

const bodySchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entries: z.array(entrySchema).min(1).max(200),
});

// A calendar-day string → its canonical @db.Date key (UTC midnight). No instant
// is involved here (the day is supplied and bounded to the amended month), so
// there is no UTC-vs-Pacific ambiguity; we reuse the shared helper for one path.
const parseEntryDate = (iso: string): Date => dayKeyUTCFromISO(iso);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let ctx;
  try {
    ctx = await requireBonusAccess(siteFromRequest(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;

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
  const inputs: AmendmentEntryInput[] = parsed.data.entries.map((e) => ({
    bonus_employee_id: e.bonus_employee_id,
    mattress_count: e.mattress_count,
    note: e.note,
  }));

  const result = await upsertAmendedMonthEntries(
    prisma as unknown as AmendmentEntryDb,
    id,
    ctx.siteId,
    date,
    inputs,
    {
      userId: ctx.userId,
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: req.headers.get('user-agent'),
    },
  );

  if (result.ok) {
    return NextResponse.json({ monthId: result.monthId, entries: result.entries }, { status: 200 });
  }
  switch (result.reason) {
    case 'not_found':
      return NextResponse.json({ error: 'Bonus month not found.' }, { status: 404 });
    case 'month_locked':
      return NextResponse.json(
        { error: `This month is ${result.state}; daily entries are locked.`, state: result.state },
        { status: 409 },
      );
    case 'count_out_of_range':
      return NextResponse.json(
        { error: 'Mattress counts must be from 0 to 999, with at most one decimal place.' },
        { status: 422 },
      );
    case 'employee_not_in_site':
      return NextResponse.json(
        { error: 'One or more employees are not Woodland processors.' },
        { status: 422 },
      );
    default:
      return NextResponse.json({ error: 'Server error.' }, { status: 500 });
  }
}
