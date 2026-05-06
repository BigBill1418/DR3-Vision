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
