// Shared by the admin equipment routes (create/list, [id], merge, duplicates).
//
// Lives OUTSIDE `route.ts` because Next.js type-checks a route module's exports:
// any export that is not a handler or a route config field
// (`"actorFrom" is not a valid Route export field`) fails `next build`.

import { NextResponse } from 'next/server';
import { adminMessages as M } from '@/app/admin/messages';

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
