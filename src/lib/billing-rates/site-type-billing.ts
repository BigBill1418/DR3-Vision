// ADR-0040 amendment (2026-07-18, rollup §3.2 / §8.2) — per-`site_type` billing
// composition: which invoice-line COMPONENTS a source produces.
//
// The billing TYPE of a collection site (ADR-0037's `Source.site_type`) fixes a default
// set of components; the ADR-0037 per-source `bill_trans` / `bill_trailer` flags then
// override that default. §8.2 composition:
//   - mrc_inbound        : trans + trailer + MRC unit                 (no per-mattress)
//   - cvp_retailer       : trans + trailer                            (no MRC unit, no per-mattress)
//   - collection_site    : trans + trailer + per-mattress + MRC unit
//   - third_party_inbound: MRC unit only                             (no trans/trailer/per-mattress)
//
// OVERRIDE SEMANTICS (a money-safe judgment call, documented for Rick/Mary review):
// `bill_trans`/`bill_trailer` can only SUPPRESS a component the site_type would otherwise
// bill — never ADD one. Effective = `site_type_default AND per_source_flag`. Two reasons:
//   1. The flags DEFAULT TO TRUE in the schema, so a plain AND leaves every unset source
//      at its pure site_type default (a source that never set the flags is NOT silently
//      granted trans/trailer it shouldn't have — critical for `third_party_inbound`,
//      whose default is trans=off: `false AND true = false`, stays off).
//   2. The only documented override in the rollup is Cottage Grove — a `collection_site`
//      with BOTH flags false, which SUPPRESSES trans+trailer while per-mattress + MRC
//      unit still bill (`false` reduces `true` to `false`; per-mattress/MRC-unit have no
//      per-source flag, so they follow the site_type default unchanged).
// `per_mattress` and `mrc_unit` have NO per-source override column, so they are always
// the site_type default.
//
// `active_billing = false` (Roseburg: seeded inactive until they sign MRC) suppresses
// ALL components — a deliberate, explicit full stop, so it returns all-false WITHOUT
// error. A source that IS active-billing but has NO `site_type` (legacy seeds predate the
// taxonomy) cannot be composed and throws {@link SiteTypeUnclassifiedError} — an active
// source with an unknown component set MUST NOT silently bill nothing (ADR-0040 D7).
//
// Pure (no I/O): the caller loads the source's billing fields and passes them in.

import type { SourceSiteType } from '@prisma/client';

/** The four billing components a source can carry (mission §8.2). */
export interface SiteTypeBilling {
  bill_trans: boolean;
  bill_trailer: boolean;
  bill_per_mattress: boolean;
  bill_mrc_unit: boolean;
}

/** The billing-relevant fields of a `Source` (structural subset — the row satisfies it). */
export interface BillingSource {
  id: string;
  site_type: SourceSiteType | null;
  active_billing: boolean;
  bill_trans: boolean;
  bill_trailer: boolean;
}

/** An active-billing source with no `site_type` — cannot determine its component set. */
export class SiteTypeUnclassifiedError extends Error {
  readonly status = 422 as const;
  constructor(readonly sourceId: string) {
    super(
      `source ${sourceId} is active_billing but has no site_type — its billing ` +
        `composition is undetermined (ADR-0040: classify it before invoicing)`,
    );
    this.name = 'SiteTypeUnclassifiedError';
  }
}

/** The site_type DEFAULT component set (before per-source suppression). §8.2. */
const SITE_TYPE_DEFAULTS: Record<SourceSiteType, SiteTypeBilling> = {
  mrc_inbound: { bill_trans: true, bill_trailer: true, bill_per_mattress: false, bill_mrc_unit: true },
  cvp_retailer: { bill_trans: true, bill_trailer: true, bill_per_mattress: false, bill_mrc_unit: false },
  collection_site: { bill_trans: true, bill_trailer: true, bill_per_mattress: true, bill_mrc_unit: true },
  third_party_inbound: { bill_trans: false, bill_trailer: false, bill_per_mattress: false, bill_mrc_unit: true },
};

const NO_BILLING: SiteTypeBilling = {
  bill_trans: false,
  bill_trailer: false,
  bill_per_mattress: false,
  bill_mrc_unit: false,
};

/**
 * Resolve which billing components a source produces. See the module header for the
 * suppress-only override semantics and the `active_billing` / unclassified handling.
 * Throws {@link SiteTypeUnclassifiedError} for an active-billing source with no
 * `site_type`.
 */
export function resolveSiteTypeBilling(source: BillingSource): SiteTypeBilling {
  if (!source.active_billing) return { ...NO_BILLING };
  if (source.site_type == null) throw new SiteTypeUnclassifiedError(source.id);

  const def = SITE_TYPE_DEFAULTS[source.site_type];
  return {
    // AND-only: the per-source flag can suppress a defaulted component, never add one.
    bill_trans: def.bill_trans && source.bill_trans,
    bill_trailer: def.bill_trailer && source.bill_trailer,
    // No per-source override column — follows the site_type default.
    bill_per_mattress: def.bill_per_mattress,
    bill_mrc_unit: def.bill_mrc_unit,
  };
}
