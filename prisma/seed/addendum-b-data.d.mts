// Type declarations for the runtime ESM seed-data module (addendum-b-data.mjs).
// seed.mjs is plain node ESM (no build step), so the data lives in .mjs; this .d.mts
// lets TypeScript tests import it type-safely under moduleResolution "bundler".
export const SVDP_INTERNAL_STORES: readonly string[];
export const CANONICAL_OR_NAMES: readonly string[];
export const SOURCE_ALIASES: readonly (readonly [alias: string, canonical: string])[];
export const PROVENANCE_AGENCIES: readonly (readonly [name: string, notes: string])[];
