// ADR-0019 §9 — Bonus employee management: per-employee mutation endpoint.
//
// PATCH /api/bonus/employees/[id]  — discriminated union by `action`:
//   { action: 'rename', full_name }        — §9b name change (history-preserving)
//   { action: 'set_number', employee_number } — ADR-0026 set/clear 4-digit number
//   { action: 'deactivate' }               — soft delete
//   { action: 'reactivate' }               — rehire (§9a)
//
// Gates through `requireBonusAccess()` (Woodland-scoped). The data layer is
// site-scoped too, so a manager can never mutate an employee at another site
// even by guessing an id (returns not_found → 404).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import {
  deactivateEmployee,
  reactivateEmployee,
  renameEmployee,
  setEmployeeNumber,
} from '@/lib/bonus/employees';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const renameAction = z.object({
  action: z.literal('rename'),
  full_name: z.string().min(1).max(120),
});
// ADR-0026: set/clear the 4-digit employee_number. Empty / null clears it; the
// 4-digit format is enforced at the data layer so it lives in one place.
const setNumberAction = z.object({
  action: z.literal('set_number'),
  employee_number: z.union([z.string().max(8), z.null()]),
});
const deactivateAction = z.object({ action: z.literal('deactivate') });
const reactivateAction = z.object({ action: z.literal('reactivate') });

const patchSchema = z.discriminatedUnion('action', [
  renameAction,
  setNumberAction,
  deactivateAction,
  reactivateAction,
]);

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, { params }: Params) {
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request payload.', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const actor = {
    actorUserId: ctx.userId,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent') ?? null,
  };

  switch (parsed.data.action) {
    case 'rename': {
      const r = await renameEmployee(ctx.siteId, id, parsed.data.full_name, actor);
      if (r.ok) return NextResponse.json({ employee: r.employee });
      if (r.reason === 'not_found')
        return NextResponse.json({ error: 'Employee not found.' }, { status: 404 });
      if (r.reason === 'name_required')
        return NextResponse.json({ error: 'Employee name is required.' }, { status: 422 });
      return NextResponse.json(
        { error: 'An active employee already has this name.' },
        { status: 409 },
      );
    }
    case 'set_number': {
      const r = await setEmployeeNumber(ctx.siteId, id, parsed.data.employee_number, actor);
      if (r.ok) return NextResponse.json({ employee: r.employee });
      if (r.reason === 'not_found')
        return NextResponse.json({ error: 'Employee not found.' }, { status: 404 });
      if (r.reason === 'employee_number_invalid')
        return NextResponse.json(
          { error: 'Employee # must be exactly 4 digits.' },
          { status: 422 },
        );
      return NextResponse.json(
        { error: 'Another active employee already has this Employee #.' },
        { status: 409 },
      );
    }
    case 'deactivate': {
      const r = await deactivateEmployee(ctx.siteId, id, actor);
      if (r.ok) return NextResponse.json({ employee: r.employee });
      if (r.reason === 'not_found')
        return NextResponse.json({ error: 'Employee not found.' }, { status: 404 });
      return NextResponse.json({ error: 'Employee is already inactive.' }, { status: 409 });
    }
    case 'reactivate': {
      const r = await reactivateEmployee(ctx.siteId, id, actor);
      if (r.ok) return NextResponse.json({ employee: r.employee });
      if (r.reason === 'not_found')
        return NextResponse.json({ error: 'Employee not found.' }, { status: 404 });
      return NextResponse.json({ error: 'Employee is already active.' }, { status: 409 });
    }
  }
}
