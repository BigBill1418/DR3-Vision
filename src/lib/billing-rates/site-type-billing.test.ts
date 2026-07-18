// ADR-0040 amendment (§3.2/§8.2) — per-site_type billing composition. Pure: exercises each
// site_type default, the Cottage Grove suppress-only override, active_billing=false full
// suppression, and the unclassified fail-loud path.

import { describe, it, expect } from 'vitest';
import {
  resolveSiteTypeBilling,
  SiteTypeUnclassifiedError,
  type BillingSource,
} from './site-type-billing';

// A source at its schema defaults (bill_trans/bill_trailer both true, active_billing true).
function src(over: Partial<BillingSource>): BillingSource {
  return {
    id: 'src-1',
    site_type: null,
    active_billing: true,
    bill_trans: true,
    bill_trailer: true,
    ...over,
  };
}

describe('resolveSiteTypeBilling — site_type defaults (§8.2)', () => {
  it('mrc_inbound: trans + trailer + MRC unit, no per-mattress', () => {
    expect(resolveSiteTypeBilling(src({ site_type: 'mrc_inbound' }))).toEqual({
      bill_trans: true,
      bill_trailer: true,
      bill_per_mattress: false,
      bill_mrc_unit: true,
    });
  });

  it('cvp_retailer: trans + trailer only', () => {
    expect(resolveSiteTypeBilling(src({ site_type: 'cvp_retailer' }))).toEqual({
      bill_trans: true,
      bill_trailer: true,
      bill_per_mattress: false,
      bill_mrc_unit: false,
    });
  });

  it('collection_site: trans + trailer + per-mattress + MRC unit', () => {
    expect(resolveSiteTypeBilling(src({ site_type: 'collection_site' }))).toEqual({
      bill_trans: true,
      bill_trailer: true,
      bill_per_mattress: true,
      bill_mrc_unit: true,
    });
  });

  it('third_party_inbound: MRC unit only', () => {
    expect(resolveSiteTypeBilling(src({ site_type: 'third_party_inbound' }))).toEqual({
      bill_trans: false,
      bill_trailer: false,
      bill_per_mattress: false,
      bill_mrc_unit: true,
    });
  });
});

describe('resolveSiteTypeBilling — per-source overrides (suppress-only)', () => {
  it('Cottage Grove: collection_site with bill_trans=false, bill_trailer=false — per-mattress + MRC unit still bill', () => {
    expect(
      resolveSiteTypeBilling(
        src({ site_type: 'collection_site', bill_trans: false, bill_trailer: false }),
      ),
    ).toEqual({
      bill_trans: false,
      bill_trailer: false,
      bill_per_mattress: true,
      bill_mrc_unit: true,
    });
  });

  it('a per-source flag can only suppress — it cannot ADD trans to third_party_inbound', () => {
    // bill_trans defaults true; third_party_inbound default trans=false → stays false.
    expect(
      resolveSiteTypeBilling(src({ site_type: 'third_party_inbound', bill_trans: true })).bill_trans,
    ).toBe(false);
  });

  it('suppressing only trailer leaves trans on', () => {
    const r = resolveSiteTypeBilling(src({ site_type: 'mrc_inbound', bill_trailer: false }));
    expect(r.bill_trans).toBe(true);
    expect(r.bill_trailer).toBe(false);
  });
});

describe('resolveSiteTypeBilling — active_billing + unclassified', () => {
  it('active_billing=false suppresses ALL components (Roseburg), regardless of site_type', () => {
    expect(
      resolveSiteTypeBilling(src({ site_type: 'collection_site', active_billing: false })),
    ).toEqual({
      bill_trans: false,
      bill_trailer: false,
      bill_per_mattress: false,
      bill_mrc_unit: false,
    });
  });

  it('active_billing=false with a null site_type is still all-false (no error — deliberate stop)', () => {
    expect(resolveSiteTypeBilling(src({ site_type: null, active_billing: false }))).toEqual({
      bill_trans: false,
      bill_trailer: false,
      bill_per_mattress: false,
      bill_mrc_unit: false,
    });
  });

  it('throws SiteTypeUnclassifiedError for an active-billing source with no site_type', () => {
    try {
      resolveSiteTypeBilling(src({ site_type: null, active_billing: true, id: 'legacy-src' }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SiteTypeUnclassifiedError);
      expect((e as SiteTypeUnclassifiedError).sourceId).toBe('legacy-src');
    }
  });
});
