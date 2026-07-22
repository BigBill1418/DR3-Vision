// ADR-0057 Addendum A (§A.1 / §A.8) — CA (Woodland) source disambiguation.
//
// Rick's 2026-07-21 reply resolving the 15 residual June-Woodland source names
// (OPEN-ITEMS S-10) into canonical MyMRC sources. This module is the CANONICAL,
// TYPED SUGGESTION SOURCE the reconciliation classifier (ADR-0057 D4) reads when it
// proposes a canonical mapping for an unresolved MyMRC source name.
//
// D4 GATE — these rows are NEVER written to `sources` / `source_aliases` directly.
// A row with `inCatalog:false` becomes a `new_record` candidate the admin approves
// through the reconciliation queue; a row with `inCatalog:true` is an existing
// `Source` and the disambiguation is realized as an alias (see the CA office aliases
// in prisma/seed/addendum-b-data.mjs). Nothing here bypasses the queue.
//
// DUAL-COMPILE — this file ships in the tsconfig.mymrc.json build. It must stay
// dependency-free (no `@/lib/prisma`, no `@prisma/client`): a pure data constant.
//
// COMPLETENESS — §A.1 totals 13 sources (4 mrc_inbound, 5 cvp_retailer, 4
// non_mrc_dropoff). Only the 7 rows below arrived with a confirmed canonical name
// (2 mrc_inbound + 1 cvp_retailer + 4 non_mrc_dropoff); the remaining 6 (2 formal
// mrc_inbound + 4 more retailers) still await Rick's exact canonical names/facility
// picks. Five of those six carry a surviving workbook-nickname hint (see
// CA_SOURCE_DISAMBIGUATION_PENDING); the sixth (a fourth cvp_retailer) has no hint
// at all. Do NOT invent any of them — money-adjacent: a wrong canonical name
// mis-routes billable units at the queue.

/**
 * Rick's disambiguation category for a CA source. Two values map onto the real
 * `SourceSiteType` enum (`mrc_inbound`, `cvp_retailer`); `non_mrc_dropoff` is a
 * disambiguation-only label for SVDP office / consumer drop-off locations that are
 * NOT MRC-approved collection sites — the queue realizes it as a `Source` whose
 * invoice lines are gated by `isProgram` (a non-program office bills nothing).
 */
export type CaCandidateSiteType = 'mrc_inbound' | 'cvp_retailer' | 'non_mrc_dropoff';

/** One CA source disambiguation candidate — the classifier's canonical-mapping suggestion. */
export interface CaSourceSeed {
  /** Verbatim canonical MyMRC source name Rick confirmed (the reconciliation match key). */
  readonly mymrcName: string;
  /** Street, when known from the existing catalog; null for not-yet-catalogued new sources. */
  readonly street: string | null;
  readonly city: string | null;
  /** Always 'CA' — every row is a Woodland (California) source. */
  readonly state: 'CA';
  readonly zip: string | null;
  /** Billing type Rick assigned (drives the queue's proposed invoice-line set). */
  readonly siteType: CaCandidateSiteType;
  /**
   * Whether the source's inbound units bill into the MRC program pool. `mrc_inbound`
   * → program; `cvp_retailer` → non-program (trans/trailer only, no MRC unit rate);
   * `non_mrc_dropoff` → per Rick's explicit per-office flag.
   */
  readonly isProgram: boolean;
  /**
   * True when `mymrcName` already exists as a `Source` in prisma/seed/sources.csv —
   * the disambiguation is an alias, not a new record. False → `new_record` queue
   * candidate.
   */
  readonly inCatalog: boolean;
}

/**
 * The confirmed CA source disambiguations (§A.1). `isProgram` for the mrc_inbound /
 * cvp_retailer rows follows the SourceSiteType semantics (mrc_inbound = MRC program
 * site; cvp_retailer = no MRC unit rate → non-program); the four non_mrc_dropoff
 * offices carry Rick's explicit per-office flag (Go Getter is the sole program office).
 * Addresses are null where the source is not yet in the catalog (no §A.1 address was
 * provided — never fabricated).
 */
export const CA_SOURCE_DISAMBIGUATION: readonly CaSourceSeed[] = [
  // ── mrc_inbound ────────────────────────────────────────────────────────────
  {
    mymrcName: 'Recology SF',
    street: null,
    city: null,
    state: 'CA',
    zip: null,
    siteType: 'mrc_inbound',
    isProgram: true,
    inCatalog: false, // "Recology San Francisco" — not in catalog (S-10), new source
  },
  {
    // Resolves the S-10 "Humboldt Moving (Crescent City vs Eureka)" ambiguity to the
    // EXISTING Crescent City yard source — an alias resolution, not a new record.
    mymrcName: 'Humboldt Moving and Storage Co. - Crescent City yard',
    street: '1528 Northcrest Drive',
    city: 'Crescent City',
    state: 'CA',
    zip: '95531',
    siteType: 'mrc_inbound',
    isProgram: true,
    inCatalog: true,
  },
  // ── cvp_retailer ───────────────────────────────────────────────────────────
  {
    mymrcName: 'Ikea w sac',
    street: null,
    city: null,
    state: 'CA',
    zip: null,
    siteType: 'cvp_retailer',
    isProgram: false,
    inCatalog: false,
  },
  // ── non_mrc_dropoff (SVDP office / consumer drop-off — Rick's explicit flags) ─
  {
    mymrcName: 'Golden Bear',
    street: null,
    city: null,
    state: 'CA',
    zip: null,
    siteType: 'non_mrc_dropoff',
    isProgram: false,
    inCatalog: false,
  },
  {
    mymrcName: 'Recology Healdsburg',
    street: null,
    city: null,
    state: 'CA',
    zip: null,
    siteType: 'non_mrc_dropoff',
    isProgram: false,
    inCatalog: false,
  },
  {
    mymrcName: 'Go Getter Company',
    street: null,
    city: null,
    state: 'CA',
    zip: null,
    siteType: 'non_mrc_dropoff',
    isProgram: true, // the sole program office (Rick §A.1)
    inCatalog: false,
  },
  {
    mymrcName: 'Recology Sonoma',
    street: null,
    city: null,
    state: 'CA',
    zip: null,
    siteType: 'non_mrc_dropoff',
    isProgram: false,
    inCatalog: false,
  },
] as const;

/**
 * The unresolved §A.1 rows that still carry a surviving workbook-nickname hint
 * (OPEN-ITEMS S-10): the 2 formal mrc_inbound Rick had to pick a facility for, plus
 * 3 of the 4 remaining cvp_retailer. (The 4th unresolved cvp_retailer has no
 * surviving hint and is intentionally absent.) Held so the classifier can FLAG these
 * for operator review instead of silently mis-mapping — they are NOT suggestion
 * rows; the classifier must not propose a canonical name from a hint. Remove a hint
 * here and add the confirmed row above only when Rick supplies the exact canonical name.
 */
export const CA_SOURCE_DISAMBIGUATION_PENDING: readonly {
  readonly hint: string;
  readonly siteType: CaCandidateSiteType;
  readonly note: string;
}[] = [
  { hint: 'Western Placerville', siteType: 'mrc_inbound', note: 'formal facility unpicked: Western Placer WMA Lincoln vs El Dorado Disposal (S-10)' },
  { hint: 'Lake County', siteType: 'mrc_inbound', note: 'formal facility unpicked: Lake County Waste Solutions vs Eastlake Landfill (S-10)' },
  { hint: 'Ikea Palo Alto', siteType: 'cvp_retailer', note: 'canonical MyMRC name unconfirmed (S-10)' },
  { hint: 'Ikea Emeryville', siteType: 'cvp_retailer', note: 'canonical MyMRC name unconfirmed (S-10)' },
  { hint: 'Sleep Number', siteType: 'cvp_retailer', note: 'store unpicked: Redding vs Sacramento (S-10)' },
] as const;
