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
  DISPLAY_NAME_MAX,
  EQUIPMENT_CATEGORIES,
  createEquipment,
  listEquipment,
  type CreateEquipmentInput,
  type EquipmentListFilters,
} from '@/lib/admin-equipment';
import { adminMessages as M } from '@/app/admin/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  site_id: z.string().min(1),
  display_name: z.string().min(1).max(DISPLAY_NAME_MAX),
  category: z.enum(EQUIPMENT_CATEGORIES),
  is_active: z.boolean().optional(),
});

const listQuerySchema = z.object({
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

  const input: CreateEquipmentInput = {
    site_id: parsed.data.site_id,
    display_name: parsed.data.display_name,
    category: parsed.data.category,
    is_active: parsed.data.is_active,
  };

  const result = await createEquipment(input, actorFrom(req, ctx.userId));
  if (!result.ok) return reasonToResponse(result.reason);
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
export function reasonToResponse(reason: string): NextResponse {
  switch (reason) {
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
