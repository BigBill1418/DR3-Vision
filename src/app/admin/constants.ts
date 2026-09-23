// Pure-data constants shared between client + server admin code.
// MUST stay free of Prisma / argon / Node-only imports so client
// components can pull from it without dragging the server-only
// `admin-users.ts` graph (and its argon2 native binding) into the
// browser bundle.

// Eugene-only enum per `User.processor_role` schema comment.
export const PROCESSOR_ROLES = [
  'Lead',
  'Processor',
  'Machine Operator',
  'Stryo',
  'Floater',
] as const;
export type ProcessorRole = (typeof PROCESSOR_ROLES)[number];

// ADR-0063 — equipment master. Mirrors the Prisma `EquipmentCategory` enum, but
// declared here rather than derived from `@prisma/client` so the equipment
// forms + filter bar can import it without pulling the server-only
// `admin-equipment.ts` graph into the browser bundle. `admin-equipment.ts`
// re-exports it and asserts at compile time that the two stay in step, so
// adding a value to the Prisma enum without adding it here fails the build.
export const EQUIPMENT_CATEGORIES = ['vehicle', 'forklift', 'baler', 'terex', 'other'] as const;
export type EquipmentCategoryValue = (typeof EQUIPMENT_CATEGORIES)[number];

/** Longest `Equipment.display_name` we accept. Seeded names top out near 60. */
export const DISPLAY_NAME_MAX = 200;

// ADR-0135 D — the structured "new asset" form's TYPE list. Client-safe (no
// Prisma). `category` is the registry's coarse `EquipmentCategory` the type
// files under; `unitRequired` is enforced on the SERVER too — a trailer, truck
// or forklift without a unit number is how `trailer 540010`-style names and
// untraceable duplicates got in. The label is what the generated display name
// ends with: `<unit> — <make> <details> <label>` (the seed convention).
export const ASSET_TYPES = [
  { value: 'trailer', label: 'Trailer', category: 'vehicle', unitRequired: true },
  { value: 'semi_truck', label: 'Semi Truck', category: 'vehicle', unitRequired: true },
  { value: 'box_truck', label: 'Box Truck', category: 'vehicle', unitRequired: true },
  { value: 'van', label: 'Van', category: 'vehicle', unitRequired: true },
  { value: 'pickup', label: 'Pickup', category: 'vehicle', unitRequired: true },
  { value: 'forklift', label: 'Forklift', category: 'forklift', unitRequired: true },
  { value: 'baler', label: 'Baler', category: 'baler', unitRequired: false },
  { value: 'shear', label: 'Shear Machine', category: 'terex', unitRequired: false },
  { value: 'other', label: 'Other', category: 'other', unitRequired: false },
] as const satisfies readonly {
  value: string;
  label: string;
  category: EquipmentCategoryValue;
  unitRequired: boolean;
}[];
export type AssetTypeValue = (typeof ASSET_TYPES)[number]['value'];
export type AssetTypeDef = (typeof ASSET_TYPES)[number];

export function assetTypeDef(value: string | null | undefined): AssetTypeDef | undefined {
  return ASSET_TYPES.find((t) => t.value === value);
}

/** Bounds on the structured identifier fields. */
export const UNIT_NUMBER_MAX = 40;
export const MAKE_MAX = 60;
export const DETAILS_MAX = 80;
export const VIN_SERIAL_MAX = 40;
/** An override must say WHY the asset is different; a one-word "new" is not a reason. */
export const OVERRIDE_REASON_MIN = 10;
export const OVERRIDE_REASON_MAX = 500;
