// ADR-0042 — service + lifecycle gating tests (CA-only guard, the pre-render
// reconcile tripwire, and the finalize matrix). Mocked prisma + a mocked balance
// function so the gates are exercised without a DB or Playwright.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const D = (n: number | string) => new Prisma.Decimal(n);

const store = {
  siteJurisdiction: 'california' as string,
  balanceTotal: 4062,
  cert: null as null | Record<string, unknown>,
  updated: null as null | Record<string, unknown>,
  audits: [] as unknown[],
};

vi.mock('@/lib/inventory/running-balance', () => ({
  onHand: async () => ({ program: D(store.balanceTotal), nonProgram: D(0), total: D(store.balanceTotal) }),
  snapshotTotalUnits: () => 0,
}));

// generateCorPdf is fired fire-and-forget by finalize; stub it so no Playwright.
vi.mock('./pdf', () => ({ generateCorPdf: async () => ({ storageKey: 'cor/x.pdf' }) }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: { findUnique: async () => ({ jurisdiction: store.siteJurisdiction }) },
    corCertificate: {
      findUnique: async () => store.cert,
      findFirst: async () => store.cert,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        store.updated = { ...(store.cert ?? {}), ...data };
        return store.updated;
      },
    },
    auditLog: { create: async ({ data }: { data: unknown }) => void store.audits.push(data) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        corCertificate: {
          update: async ({ data }: { data: Record<string, unknown> }) => {
            store.updated = { ...(store.cert ?? {}), ...data };
            return store.updated;
          },
        },
        auditLog: { create: async ({ data }: { data: unknown }) => void store.audits.push(data) },
      }),
  },
}));

import { assertSiteIsCalifornia, assertCorInventoryReconciles } from './service';
import { finalizeCor, type FinalizerContext } from './lifecycle';
import {
  CorJurisdictionError,
  CorReconcileMismatchError,
  CorHeadcountRequiredError,
  CorFinalizeForbiddenError,
  CorImmutableError,
} from './view';

function draftCert(over: Record<string, unknown> = {}) {
  return {
    id: 'cor1',
    site_id: 'site-w',
    cover_month: new Date('2026-06-01T00:00:00Z'),
    version: 1,
    status: 'draft',
    inventory_units: 4062,
    ft_headcount: 15,
    pt_headcount: 3,
    ...over,
  };
}

function mgr(over: Partial<FinalizerContext> = {}): FinalizerContext {
  return { userId: 'mgr', role: 'manager', managesSite: true, ...over };
}

beforeEach(() => {
  store.siteJurisdiction = 'california';
  store.balanceTotal = 4062;
  store.cert = draftCert();
  store.updated = null;
  store.audits = [];
});

describe('assertSiteIsCalifornia (D1 — CA-only)', () => {
  it('passes for a California site', async () => {
    store.siteJurisdiction = 'california';
    await expect(assertSiteIsCalifornia('site-w')).resolves.toBeUndefined();
  });

  it('throws CorJurisdictionError for an Oregon site', async () => {
    store.siteJurisdiction = 'oregon';
    await expect(assertSiteIsCalifornia('site-e')).rejects.toBeInstanceOf(CorJurisdictionError);
  });
});

describe('assertCorInventoryReconciles (D2.1/D3 tripwire)', () => {
  it('passes when the recomputed balance equals the stored figure', async () => {
    store.balanceTotal = 4062;
    const r = await assertCorInventoryReconciles('cor1');
    expect(r).toEqual({ pass: true, storedUnits: 4062, recomputedUnits: 4062 });
  });

  it('throws CorReconcileMismatchError with both numbers on drift', async () => {
    store.balanceTotal = 4100;
    await expect(assertCorInventoryReconciles('cor1')).rejects.toMatchObject({
      name: 'CorReconcileMismatchError',
      context: { certId: 'cor1', storedUnits: 4062, recomputedUnits: 4100 },
    });
  });
});

describe('finalizeCor (D3 freeze)', () => {
  it('rejects an off-site manager', async () => {
    await expect(finalizeCor({ siteId: 'site-w', certId: 'cor1', finalizer: mgr({ managesSite: false }) })).rejects.toBeInstanceOf(
      CorFinalizeForbiddenError,
    );
  });

  it('rejects when the FT/PT split has not been entered', async () => {
    store.cert = draftCert({ ft_headcount: null, pt_headcount: null });
    await expect(finalizeCor({ siteId: 'site-w', certId: 'cor1', finalizer: mgr() })).rejects.toBeInstanceOf(
      CorHeadcountRequiredError,
    );
  });

  it('rejects when the inventory figure no longer reconciles', async () => {
    store.balanceTotal = 4100; // drifted since the draft
    await expect(finalizeCor({ siteId: 'site-w', certId: 'cor1', finalizer: mgr() })).rejects.toBeInstanceOf(
      CorReconcileMismatchError,
    );
  });

  it('rejects finalizing an already-finalized certificate (immutable)', async () => {
    store.cert = draftCert({ status: 'finalized' });
    await expect(finalizeCor({ siteId: 'site-w', certId: 'cor1', finalizer: mgr() })).rejects.toBeInstanceOf(
      CorImmutableError,
    );
  });

  it('freezes a clean draft: status → finalized, sets finalized_by, writes an audit row', async () => {
    const view = await finalizeCor({ siteId: 'site-w', certId: 'cor1', finalizer: mgr() });
    expect(view.status).toBe('finalized');
    expect(store.updated).toMatchObject({ status: 'finalized', finalized_by: 'mgr' });
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({ table_name: 'cor_certificates', after: { status: 'finalized' } });
  });
});
