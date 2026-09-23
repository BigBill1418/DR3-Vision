// ADR-0135 D — the ONE wire contract for "register a new asset", shared by the
// admin create route and the equipment-request resolve route, so the two cannot
// drift on what a structured create is.
//
// People no longer send a name: they send what the asset IS (type, unit number,
// make, optional VIN/serial) and the server generates `<unit> — <make> <type>`.
// `siteId: null` registers a FLEET-WIDE asset (no home yard).

import { z } from 'zod';
import {
  ASSET_TYPES,
  DETAILS_MAX,
  MAKE_MAX,
  OVERRIDE_REASON_MAX,
  UNIT_NUMBER_MAX,
  VIN_SERIAL_MAX,
} from '@/app/admin/constants';
import type { CreateEquipmentInput } from '@/lib/admin-equipment';

const assetTypeValues = ASSET_TYPES.map((t) => t.value) as [string, ...string[]];

export const structuredCreateSchema = z.object({
  /** A `sites.id`, or null = fleet-wide. Absent = the caller's default. */
  siteId: z.string().min(1).nullable().optional(),
  assetType: z.enum(assetTypeValues),
  unitNumber: z.string().max(UNIT_NUMBER_MAX).optional(),
  make: z.string().max(MAKE_MAX).optional(),
  details: z.string().max(DETAILS_MAX).optional(),
  vinSerial: z.string().max(VIN_SERIAL_MAX).optional(),
  confirmDistinct: z
    .object({
      reason: z.string().max(OVERRIDE_REASON_MAX),
      distinctFromIds: z.array(z.string().min(1)).max(50),
    })
    .optional(),
});

export type StructuredCreateBody = z.infer<typeof structuredCreateSchema>;

/** Map the wire body onto the data layer's input. `siteId` is resolved by the caller. */
export function toCreateInput(
  body: StructuredCreateBody,
  siteId: string | null,
): CreateEquipmentInput {
  return {
    site_id: siteId,
    asset_type: body.assetType,
    unit_number: body.unitNumber,
    make: body.make,
    details: body.details,
    vin_serial: body.vinSerial,
    ...(body.confirmDistinct
      ? {
          confirm_distinct: {
            reason: body.confirmDistinct.reason,
            distinct_from_ids: body.confirmDistinct.distinctFromIds,
          },
        }
      : {}),
  };
}
