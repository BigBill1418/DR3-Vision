// ADR-0063 — admin equipment master: create + list endpoints.
//
// POST /api/admin/equipment   — register an asset
// GET  /api/admin/equipment   — list (filters via query params)
//
// Both gate admin-only. Anonymous -> 401, authenticated non-admin -> 403.
// Each handler re-checks via `requireAdmin()`: the page layer's `checkAdmin()`
// gate covers the UI surface and NOTHING ELSE — the API must never trust it
// (CLAUDE.md hard rule #2 keeps admin POWERS on `role === 'admin'`, and
// `requireAdmin()` is the only thing that enforces that here).
//
// Sibling note: `/api/admin/equipment/import` is the ADR-0048 D3 Terex
// *history* importer and writes `equipment_events` — a different table. Next
// resolves the static `import` segment ahead of `[id]`, so the two coexist.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import {
  EQUIPMENT_CATEGORIES,
  createEquipment,
  listEquipment,
  type EquipmentListFilters,
} from '@/lib/admin-equipment';
import { structuredCreateSchema, toCreateInput } from '@/lib/equipment/structured-create';
import { adminMessages as M } from '@/app/admin/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ADR-0135 D — the create body is STRUCTURED (type, unit #, make, VIN/serial);
// the name is generated. A free-typed `display_name` is no longer accepted here.
// `siteId: null` registers a fleet-wide asset.
const createSchema = structuredCreateSchema.extend({ siteId: z.string().min(1).nullable() });

const listQuerySchema = z.object({
  /** A `sites.id`, or `fleet` for fleet-wide assets only. */
  site: z.string().optional(),
  category: z.enum(EQUIPMENT_CATEGORIES).optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
  q: z.string().max(100).optional(),
});

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: M.errors.invalidPayload }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: M.errors.invalidPayload, details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const result = await createEquipment(
    toCreateInput(parsed.data, parsed.data.siteId),
    actorFrom(req, ctx.userId),
  );
  if (!result.ok) {
    // ADR-0075 D2 / ADR-0135 C — a refusal with candidates carries them, so the
    // form can offer "Use this one" / "It's a different asset".
    if (result.existing && result.existing.length > 0) {
      return NextResponse.json(
        { error: reasonMessage(result.reason), code: result.reason, existing: result.existing },
        { status: 409 },
      );
    }
    return reasonToResponse(result.reason);
  }
  return NextResponse.json({ equipment: result.equipment }, { status: 201 });
}

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse({
    site: url.searchParams.get('site') ?? undefined,
    category: url.searchParams.get('category') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: M.errors.invalidPayload }, { status: 400 });
  }

  // `site` here is a sites.id (the page resolves codes upstream), matching the
  // `/api/admin/users` GET contract.
  const filters: EquipmentListFilters = {
    siteId: parsed.data.site,
    category: parsed.data.category,
    status: parsed.data.status,
    q: parsed.data.q,
  };
  const equipment = await listEquipment(filters);
  return NextResponse.json({ equipment });
}

export function actorFrom(req: Request, actorUserId: string) {
  return {
    actorUserId,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent') ?? null,
  };
}

// Reason -> HTTP status. The model layer's reason taxonomy is the source of
// truth; this file owns the vocabulary shared by both equipment routes.
/** The human sentence for a data-layer reason — ONE vocabulary for both equipment routes. */
export function reasonMessage(reason: string): string {
  switch (reason) {
    case 'name_required':
      return M.equipment.nameRequired;
    case 'name_too_long':
      return M.equipment.nameTooLong;
    case 'name_taken':
      return M.equipment.nameTaken;
    case 'vin_taken':
      return M.equipment.vinTaken;
    case 'probable_duplicate':
      return M.equipment.probableDuplicate;
    case 'override_reason_required':
      return M.equipment.overrideReasonRequired;
    case 'override_incomplete':
      return M.equipment.overrideIncomplete;
    case 'asset_type_invalid':
      return M.equipment.assetTypeRequired;
    case 'unit_number_required':
      return M.equipment.unitNumberRequired;
    case 'unit_number_invalid':
      return M.equipment.unitNumberInvalid;
    case 'field_too_long':
      return M.equipment.fieldTooLong;
    case 'site_not_found':
      return M.errors.siteNotFound;
    case 'not_found':
      return M.equipment.notFound;
    default:
      return M.errors.serverError;
  }
}

export function reasonToResponse(reason: string): NextResponse {
  switch (reason) {
    case 'vin_taken':
    case 'probable_duplicate':
    case 'override_incomplete':
      return NextResponse.json({ error: reasonMessage(reason), code: reason }, { status: 409 });
    case 'override_reason_required':
    case 'asset_type_invalid':
    case 'unit_number_required':
    case 'unit_number_invalid':
    case 'field_too_long':
    case 'category_required':
      return NextResponse.json({ error: reasonMessage(reason), code: reason }, { status: 422 });
    case 'name_required':
      return NextResponse.json({ error: M.equipment.nameRequired }, { status: 422 });
    case 'name_too_long':
      return NextResponse.json({ error: M.equipment.nameTooLong }, { status: 422 });
    case 'name_taken':
      return NextResponse.json({ error: M.equipment.nameTaken }, { status: 409 });
    case 'site_not_found':
      return NextResponse.json({ error: M.errors.siteNotFound }, { status: 422 });
    case 'not_found':
      return NextResponse.json({ error: M.equipment.notFound }, { status: 404 });
    default:
      return NextResponse.json({ error: M.errors.serverError }, { status: 500 });
  }
}
