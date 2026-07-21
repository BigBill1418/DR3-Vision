// ADR-0037 amendment (rollup §1/§2/§4) — Addendum-B reference-data constants.
// Extracted from seed.mjs so they are importable + unit-testable (seed.mjs
// self-executes main() on import). These mirror the `20260730b_addendum_b_seeds`
// migration DML EXACTLY — the migration is the prod path; seed.mjs is dev/CI parity.
// If you change a value here, change the migration too (and vice-versa).

/// §4 — the 11 SVDP-run internal stores (site_type=svdp_internal_store,
/// active_billing=false → zero invoice lines). Seeded as base rows from
/// sources.csv, then classified by seedSourceBillingClassification.
export const SVDP_INTERNAL_STORES = [
  'Division', 'Seneca', 'West Eugene', 'Chad Drive', 'Q Street', 'Main Street',
  'Junction City', 'Oakridge', 'Garfield', 'CARS', 'Cleveland WH',
];

/// §4 — billing classification stamped on every SVDP internal store. Applied by
/// seedSourceBillingClassification AND the 20260730b store INSERT (kept in lock-step).
/// - `is_non_program = true`: Rick §4 — these stores "are not Collection sites in
///   conjunction With the MRC", so mattresses they bring are OUTSIDE the MRC program.
///   The verify-gate/promotion DEFAULT split therefore routes their inbound units to
///   the NON-program (non-billable) pool, not the program pool billed at UNITSMO. This
///   is the money-safe default for a non-MRC site (a manager can still override at
///   verify). `is_non_program = false` would silently over-attribute billable units.
/// - `active_billing = false`: zero invoice lines from the store as a source.
export const SVDP_INTERNAL_STORE_CLASSIFICATION = {
  site_type: 'svdp_internal_store',
  active_billing: false,
  is_non_program: true,
};

/// §8/§13 — Mary-confirmed GP per-site billing identifiers (corrects PR #128). Woodland
/// PO suffix "DR3 W" (WITH space, §13); Eugene "DR3 OREGON" (spelled out, §8 Q4); both
/// Customer ID MRCL001 (§8 Q1). Consumed by seedGpSiteBillingConfig (dev/CI) AND
/// mirrored EXACTLY by the gp_site_billing_config upsert in the 20260730b migration
/// (prod path — prod does not re-run seed.mjs). Change both together.
export const GP_SITE_BILLING_IDENTIFIERS = [
  { code: 'woodland', customer_id: 'MRCL001', po_site_suffix: 'DR3 W' },
  { code: 'eugene', customer_id: 'MRCL001', po_site_suffix: 'DR3 OREGON' },
];

/// §1 — canonical MyMRC source names the aliases resolve to (Rick 2026-07-19,
/// incl. MRC's verbatim "Recieving" typo). All are eugene-scoped.
export const CANONICAL_OR_NAMES = [
  'St Vincent De Paul Of Lane County - Salem Thrift Store',
  'ST Vincent De Paul OF Lane County-Albany Thrift Store',
  'St Vincent De Paul Of Lane County - Cottage Grove Store',
  'St Vincent De Paul Of Lane County - Florence Thrift Store',
  'St Vincent De Paul Of Lane County - The Dalles Thrift Store',
  'Glenwood Central Recieving Station',
];

/// §1/§12 — [alias, canonical] pairs: old verbatim seed names + month-to-month
/// customer-name variants. Alias is globally UNIQUE (source_aliases.alias).
export const SOURCE_ALIASES = [
  ['Salem-Keizer Recycling Center', 'St Vincent De Paul Of Lane County - Salem Thrift Store'],
  ['Salem SVDP', 'St Vincent De Paul Of Lane County - Salem Thrift Store'],
  ['SVDP Salem', 'St Vincent De Paul Of Lane County - Salem Thrift Store'],
  ['Albany-Linn County Transfer Station', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'],
  ['Albany SVDP', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'],
  ['SVDP Albany', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'],
  ['SvdP Albany', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'],
  ['Albany', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'],
  ['Cottage Grove Transfer Station', 'St Vincent De Paul Of Lane County - Cottage Grove Store'],
  ['Cottage Grove', 'St Vincent De Paul Of Lane County - Cottage Grove Store'],
  ['SVDP Cottage Grove', 'St Vincent De Paul Of Lane County - Cottage Grove Store'],
  ['Cottage Grove SVDP', 'St Vincent De Paul Of Lane County - Cottage Grove Store'],
  ['Florence Transfer Station', 'St Vincent De Paul Of Lane County - Florence Thrift Store'],
  ['Florence SVDP', 'St Vincent De Paul Of Lane County - Florence Thrift Store'],
  ['SVDP Florence', 'St Vincent De Paul Of Lane County - Florence Thrift Store'],
  ['Glenwood Transfer & Recycling Station', 'Glenwood Central Recieving Station'],
  ['Glenwood Transfer Station', 'Glenwood Central Recieving Station'],
  ['Glenwood TC 143', 'Glenwood Central Recieving Station'],
  ['Glenwood TC 144', 'Glenwood Central Recieving Station'],
  ['The Dalles SVDP', 'St Vincent De Paul Of Lane County - The Dalles Thrift Store'],
  ['SVDP The Dalles', 'St Vincent De Paul Of Lane County - The Dalles Thrift Store'],
  ['The Dalles', 'St Vincent De Paul Of Lane County - The Dalles Thrift Store'],
];

/// §2 — [name, notes] provenance agencies (origin of delivered mattresses; never billed).
export const PROVENANCE_AGENCIES = [
  ['Sponsors', 'Halfway house on Hwy 99 next to Lindholm. Reclassified from a drop-off kind to a provenance agency (rollup §2, Rick 2026-07-19). No billing.'],
  ['Eugene Mattress Company', 'Provenance agency — origin of delivered mattresses (rollup §2). No billing.'],
  ['U-Haul', 'Provenance agency — origin of delivered mattresses (rollup §2). No billing.'],
];
