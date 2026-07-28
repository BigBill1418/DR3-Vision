// ADR-0063 — display labels for the `EquipmentCategory` enum.
//
// Shared by the list, the filter bar and both forms so the five categories
// read identically everywhere. Every literal still lives in
// `@/app/admin/messages` (ADR-0017: "no hard-coded strings in any /admin
// component"); this is only the enum→key mapping.
//
// A `Record<EquipmentCategory, string>` rather than a lookup with a fallback:
// adding a value to the Prisma enum then fails the build here instead of
// silently rendering a raw `terex` to an admin.

import type { EquipmentCategory } from '@prisma/client';
import { adminMessages as M } from '@/app/admin/messages';

export const CATEGORY_LABEL: Record<EquipmentCategory, string> = {
  vehicle: M.equipment.categoryVehicle,
  forklift: M.equipment.categoryForklift,
  baler: M.equipment.categoryBaler,
  terex: M.equipment.categoryTerex,
  other: M.equipment.categoryOther,
};
