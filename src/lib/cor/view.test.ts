import { describe, expect, it } from 'vitest';
import {
  toCorView,
  CorReconcileMismatchError,
  CorJurisdictionError,
  CorHeadcountRequiredError,
  CorImmutableError,
  CorTransitionError,
} from './view';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'cor1',
    site_id: 'site-w',
    cover_month: new Date('2026-06-01T00:00:00Z'),
    version: 1,
    supersedes_id: null,
    status: 'draft',
    inventory_units: 4062,
    inventory_source: { computedTotal: '4062' },
    ft_headcount: null,
    pt_headcount: null,
    headcount_source: { series: [] },
    signer_name: 'Rick Albritton',
    signer_title: 'Transportation Manager',
    prepared_by: 'u1',
    prepared_at: new Date('2026-07-01T00:00:00Z'),
    finalized_by: null,
    finalized_at: null,
    pdf_storage_key: null,
    notes: null,
    ...over,
  };
}

describe('toCorView', () => {
  it('maps a draft row to the camelCase view', () => {
    const v = toCorView(row());
    expect(v.id).toBe('cor1');
    expect(v.siteId).toBe('site-w');
    expect(v.status).toBe('draft');
    expect(v.inventoryUnits).toBe(4062);
    expect(v.ftHeadcount).toBeNull();
    expect(v.signerTitle).toBe('Transportation Manager');
  });

  it('carries the finalized fields + provenance blobs through', () => {
    const v = toCorView(
      row({ status: 'finalized', ft_headcount: 15, pt_headcount: 3, finalized_by: 'mgr', finalized_at: new Date('2026-07-02T00:00:00Z'), pdf_storage_key: 'cor/woodland/2026-06/ab.pdf' }),
    );
    expect(v.status).toBe('finalized');
    expect(v.ftHeadcount).toBe(15);
    expect(v.ptHeadcount).toBe(3);
    expect(v.finalizedBy).toBe('mgr');
    expect(v.pdfStorageKey).toBe('cor/woodland/2026-06/ab.pdf');
    expect(v.inventorySource).toEqual({ computedTotal: '4062' });
  });
});

describe('typed error taxonomy (D5 — errors carry numbers/status)', () => {
  it('CorReconcileMismatchError carries both numbers + a 409 status', () => {
    const e = new CorReconcileMismatchError({ certId: 'cor1', storedUnits: 4062, recomputedUnits: 4100 });
    expect(e.status).toBe(409);
    expect(e.context).toEqual({ certId: 'cor1', storedUnits: 4062, recomputedUnits: 4100 });
    expect(e.message).toContain('4062');
    expect(e.message).toContain('4100');
  });

  it('CorJurisdictionError is a 422 naming the OR jurisdiction', () => {
    const e = new CorJurisdictionError('site-e', 'oregon');
    expect(e.status).toBe(422);
    expect(e.message).toContain('oregon');
    expect(e.message).toContain('California-only');
  });

  it('CorHeadcountRequiredError is a 422', () => {
    expect(new CorHeadcountRequiredError('cor1').status).toBe(422);
  });

  it('CorImmutableError is a 409', () => {
    expect(new CorImmutableError('cor1').status).toBe(409);
  });

  it('CorTransitionError preserves the reason discriminant', () => {
    const e = new CorTransitionError('not_finalized', 'nope');
    expect(e.status).toBe(409);
    expect(e.reason).toBe('not_finalized');
  });
});
