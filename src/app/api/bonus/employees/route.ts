// ADR-0019 §9 — Bonus employee management: collection endpoints.
//
// POST /api/bonus/employees   — create an employee (rehire-aware, §9a)
// GET  /api/bonus/employees   — list Woodland employees (filters via query)
//
// Both gate through `requireBonusAccess()` (Woodland-scoped): anonymous → 401,
// operator / Eugene manager (Rick) → 403, misseeded site → 404. The actor +
// site come from the returned BonusContext; the client is never trusted for
// either (CLAUDE.md hard rule #2).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireBonusAccess } from '@/lib/bonus/access';
import { createEmployee, listEmployees, type ListEmployeesFilters } from '@/lib/bonus/employees';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  full_name: z.string().min(1).max(120),
  notes: z
    .union([z.string().max(2000), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

const listQuerySchema = z.object({
  status: z.enum(['active', 'inactive', 'all']).optional(),
  sort: z.enum(['name', 'status']).optional(),
});

function actorFrom(req: Request, userId: string) {
  return {
    actorUserId: userId,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent') ?? null,
  };
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

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request payload.', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const result = await createEmployee(
    ctx.siteId,
    { full_name: parsed.data.full_name, notes: parsed.data.notes },
    actorFrom(req, ctx.userId),
  );

  if (result.ok) return NextResponse.json({ employee: result.employee }, { status: 201 });

  switch (result.reason) {
    case 'name_required':
      return NextResponse.json({ error: 'Employee name is required.' }, { status: 422 });
    case 'name_taken':
      return NextResponse.json(
        { error: 'An active employee already has this name.', employee: result.employee },
        { status: 409 },
      );
    case 'rehire_candidate':
      // §9a: not an error to the operator — the UI prompts to reactivate. We
      // return 409 (conflict) with a discriminator + the existing row so the
      // client can offer "Reactivate {name} (deactivated {date})?".
      return NextResponse.json(
        { rehire_candidate: true, employee: result.employee },
        { status: 409 },
      );
    default:
      return NextResponse.json({ error: 'Server error.' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await requireBonusAccess();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    sort: url.searchParams.get('sort') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  }

  const filters: ListEmployeesFilters = { status: parsed.data.status, sort: parsed.data.sort };
  const employees = await listEmployees(ctx.siteId, filters);
  return NextResponse.json({ employees });
}
