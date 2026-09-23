// ADR-0063 — admin equipment master: per-asset mutation endpoint.
//
// PATCH /api/admin/equipment/[id] — discriminated union by `action`:
//   { action: 'update', display_name?, category?, site_id? }
//   { action: 'deactivate' }
//   { action: 'reactivate' }
//
// There is deliberately NO DELETE. `ap_equipment_links.equipment_id` is
// `onDelete: Restrict` and those rows are financial-approval evidence, so a
// hard delete is either impossible (linked) or destroys registry history
// (unlinked). `{ action: 'deactivate' }` is the only removal, and since
// ADR-0046 Amendment 7 made the AP picker fleet-wide it is the ONLY thing that
// scopes that picker at all — `listSiteEquipment()` now filters on
// `is_active: true` and nothing else. The users route exposes DELETE as a
// deactivate alias; that alias is omitted here precisely so no client can form
// a request that *looks* like a delete.
//
// `site_id` is freely updatable, including on rows an approval already cites
// (ADR-0063 D4, reversed the same day Amendment 7 landed — the picker no longer
// reads `site_id`, and the coarse C-28 site data is exactly what this screen
// exists to correct).
//
// Admin-only, re-checked in-handler. The page gate is never trusted.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import {
  DISPLAY_NAME_MAX,
  EQUIPMENT_CATEGORIES,
  deactivateEquipment,
  reactivateEquipment,
  updateEquipment,
  type UpdateEquipmentInput,
} from '@/lib/admin-equipment';
import { adminMessages as M } from '@/app/admin/messages';
import { MAKE_MAX, UNIT_NUMBER_MAX, VIN_SERIAL_MAX } from '@/app/admin/constants';
import { actorFrom, reasonToResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const updateAction = z.object({
  action: z.literal('update'),
  display_name: z.string().min(1).max(DISPLAY_NAME_MAX).optional(),
  category: z.enum(EQUIPMENT_CATEGORIES).optional(),
  /** A `sites.id`, or null to make the asset FLEET-WIDE (ADR-0135). */
  site_id: z.string().min(1).nullable().optional(),
  // ADR-0135 D — correct the structured identity. Empty string clears.
  unit_number: z.string().max(UNIT_NUMBER_MAX).optional(),
  make: z.string().max(MAKE_MAX).optional(),
  vin_serial: z.string().max(VIN_SERIAL_MAX).optional(),
});

const deactivateAction = z.object({ action: z.literal('deactivate') });
const reactivateAction = z.object({ action: z.literal('reactivate') });

const patchSchema = z.discriminatedUnion('action', [
  updateAction,
  deactivateAction,
  reactivateAction,
]);

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, { params }: Params) {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: M.errors.invalidPayload }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: M.errors.invalidPayload, details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const actor = actorFrom(req, ctx.userId);

  switch (parsed.data.action) {
    case 'update': {
      const input: UpdateEquipmentInput = {};
      if (parsed.data.display_name !== undefined) input.display_name = parsed.data.display_name;
      if (parsed.data.category !== undefined) input.category = parsed.data.category;
      if (parsed.data.site_id !== undefined) input.site_id = parsed.data.site_id;
      if (parsed.data.unit_number !== undefined) input.unit_number = parsed.data.unit_number;
      if (parsed.data.make !== undefined) input.make = parsed.data.make;
      if (parsed.data.vin_serial !== undefined) input.vin_serial = parsed.data.vin_serial;

      const r = await updateEquipment(id, input, actor);
      if (!r.ok) return reasonToResponse(r.reason);
      return NextResponse.json({ equipment: r.equipment });
    }
    case 'deactivate': {
      const r = await deactivateEquipment(id, actor);
      if (!r.ok) return reasonToResponse(r.reason);
      return NextResponse.json({ equipment: r.equipment });
    }
    case 'reactivate': {
      const r = await reactivateEquipment(id, actor);
      if (!r.ok) return reasonToResponse(r.reason);
      return NextResponse.json({ equipment: r.equipment });
    }
  }
}
