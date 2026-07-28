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
