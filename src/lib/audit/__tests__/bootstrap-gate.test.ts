// ADR-0039 Amendment 1 acceptance (a)/(b) — leg-liveness bootstrap gating.
//   (a) a FRESH site (no data in any leg, no go_live) ⇒ every gated leg is NOT
//       live ⇒ its findings are suppressed;
//   (b) the FIRST data row in a leg makes it live ⇒ real evaluation, no code
//       change (just data existence);
//   plus the admin `go_live_date` override.

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resolveLegLiveness, BOOTSTRAP_GATED_CHECKS } from '../bootstrap-gate';

function fakeDb(opts: {
  invoices?: number;
  closes?: number;
  snapshots?: number;
  payments?: number;
  gates?: Array<{ leg: string; go_live_date: Date | null }>;
}): PrismaClient {
  return {
    invoice: { count: vi.fn(async () => opts.invoices ?? 0) },
    processedUnitsDaily: { count: vi.fn(async () => opts.closes ?? 0) },
    siteInventorySnapshot: { count: vi.fn(async () => opts.snapshots ?? 0) },
    // ADR-0052 — the commodity_payment leg (m3 aging).
    outboundMaterialPayment: { count: vi.fn(async () => opts.payments ?? 0) },
    auditBootstrapGate: { findMany: vi.fn(async () => opts.gates ?? []) },
  } as unknown as PrismaClient;
}

const ASOF = new Date(Date.UTC(2026, 6, 7)); // 2026-07-07

describe('resolveLegLiveness', () => {
  it('(a) fresh site — no data, no go_live: every leg is NOT live (suppress)', async () => {
    const live = await resolveLegLiveness(fakeDb({}), 'site-eugene', ASOF);
    expect(live.isLive('billing')).toBe(false);
    expect(live.isLive('close')).toBe(false);
    expect(live.isLive('snapshot')).toBe(false);
    expect(live.isLive('commodity_payment')).toBe(false);
  });

  it('ADR-0052 — the first commodity payment record makes only that leg live', async () => {
    const live = await resolveLegLiveness(fakeDb({ payments: 1 }), 'site-eugene', ASOF);
    expect(live.isLive('commodity_payment')).toBe(true);
    expect(live.isLive('billing')).toBe(false);
  });

  it('(b) first data row makes only that leg live (no code change)', async () => {
    const live = await resolveLegLiveness(fakeDb({ closes: 1 }), 'site-eugene', ASOF);
    expect(live.isLive('close')).toBe(true); // has a processed-units close
    expect(live.isLive('billing')).toBe(false); // still no invoice
    expect(live.isLive('snapshot')).toBe(false); // still no physical snapshot
  });

  it('a passed go_live_date makes a leg live even with zero data', async () => {
    const live = await resolveLegLiveness(
      fakeDb({ gates: [{ leg: 'billing', go_live_date: new Date(Date.UTC(2026, 6, 1)) }] }),
      'site-eugene',
      ASOF,
    );
    expect(live.isLive('billing')).toBe(true);
  });

  it('a FUTURE go_live_date does not activate a leg (falls back to data existence)', async () => {
    const live = await resolveLegLiveness(
      fakeDb({ gates: [{ leg: 'snapshot', go_live_date: new Date(Date.UTC(2026, 7, 1)) }] }),
      'site-eugene',
      ASOF,
    );
    expect(live.isLive('snapshot')).toBe(false);
  });

  it('the registry maps the three incident checks to their legs', () => {
    expect(BOOTSTRAP_GATED_CHECKS.c4_billing_basis).toBe('billing');
    expect(BOOTSTRAP_GATED_CHECKS.m1_missing_close).toBe('close');
    expect(BOOTSTRAP_GATED_CHECKS.m2_missing_snapshot).toBe('snapshot');
    expect(BOOTSTRAP_GATED_CHECKS.m3_commodity_payment_aging).toBe('commodity_payment');
  });
});
