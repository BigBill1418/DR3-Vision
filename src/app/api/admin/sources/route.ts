// ADR-0125 (Phase 0 gap G-3) — the collection-source classifier API.
//
// GET   -> list sources with their four classifiers
// PATCH -> update one source's classifiers (body carries the id)
//
// ADMIN POWER, not site reach (CLAUDE.md hard rule #2): `is_trans_charge`,
// `is_non_program`, `canonical_mileage` and `haul_assignment` decide which
// invoice lines a source produces and which POOL its units are billed in, so the
// gate is `requireAdmin` — `all_sites` never unlocks it.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { RecordValidationError } from '@/lib/loads/record-guards';
import { listSourceClassifications, updateSourceClassification } from '@/lib/sources/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Patch = z.object({
  sourceId: z.string().uuid(),
  isNonProgram: z.boolean().optional(),
  isTransCharge: z.boolean().optional(),
  canonicalMileage: z.number().int().nonnegative().max(10_000).nullable().optional(),
  haulAssignment: z.enum(['primary', 'secondary', 'tertiary']).nullable().optional(),
});

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const url = new URL(req.url);
  const rows = await listSourceClassifications({
    siteId: url.searchParams.get('siteId') ?? undefined,
    search: url.searchParams.get('q') ?? undefined,
  });
  return NextResponse.json({ rows });
}

export async function PATCH(req: Request) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', issues: parsed.error.issues },
      { status: 422 },
    );
  }
  try {
    const row = await updateSourceClassification({ ...parsed.data, actorUserId: admin.userId });
    return NextResponse.json({ row });
  } catch (e) {
    if (e instanceof RecordValidationError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
