// ADR-0052 — M3 commodity payment aging: D1 thresholds (30/45), D3 per-buyer
// rollup, disputed/paid exclusion, live-run-only semantics.

import { describe, expect, it } from 'vitest';
import {
  m3CommodityPaymentAging,
  UNKNOWN_BUYER,
  type M3PaymentRow,
} from './m3-commodity-payment-aging';
import { toCheckConfig, DEFAULT_CHECK_CONFIGS } from '../config';
import type { AuditWindow, CheckConfig } from '../types';

const CONFIG: CheckConfig = toCheckConfig(
  DEFAULT_CHECK_CONFIGS.find((c) => c.checkCode === 'm3_commodity_payment_aging')!,
);

function win(asOfISO?: string): AuditWindow {
  return {
    siteId: 'woodland',
    startISO: '2026-06-01',
    endISO: '2026-07-16',
    ...(asOfISO !== undefined ? { asOfISO } : {}),
  };
}

const row = (over: Partial<M3PaymentRow> = {}): M3PaymentRow => ({
  loadId: 'load-1',
  buyer: 'SA Recycling',
  shipDateISO: '2026-06-01',
  status: 'awaiting_invoice',
  invoicedAtISO: null,
  ticketNumber: 'T-100',
  ...over,
});

describe('m3CommodityPaymentAging', () => {
  it('flags a load uninvoiced past aging_ship_days (D1: 30)', () => {
    // shipped 06-01, asOf 07-16 = 45 days > 30
    const findings = m3CommodityPaymentAging(win('2026-07-16'), { rows: [row()] }, CONFIG);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.checkCode).toBe('m3_commodity_payment_aging');
    const detail = findings[0]!.detail as { loads: Array<{ kind: string; days: number }> };
    expect(detail.loads[0]!.kind).toBe('uninvoiced');
    expect(detail.loads[0]!.days).toBe(45);
  });

  it('does not flag inside the ship threshold', () => {
    const findings = m3CommodityPaymentAging(
      win('2026-07-16'),
      { rows: [row({ shipDateISO: '2026-07-01' })] }, // 15 days
      CONFIG,
    );
    expect(findings).toHaveLength(0);
  });

  it('flags an invoiced load unpaid past aging_invoice_days (D1: 45)', () => {
    const findings = m3CommodityPaymentAging(
      win('2026-07-16'),
      { rows: [row({ status: 'invoiced', invoicedAtISO: '2026-05-01' })] }, // 76 days
      CONFIG,
    );
    expect(findings).toHaveLength(1);
    const detail = findings[0]!.detail as { loads: Array<{ kind: string }> };
    expect(detail.loads[0]!.kind).toBe('unpaid');
  });

  it('invoiced inside 45 days is quiet even when ship age is large', () => {
    const findings = m3CommodityPaymentAging(
      win('2026-07-16'),
      {
        rows: [row({ status: 'invoiced', shipDateISO: '2026-01-01', invoicedAtISO: '2026-07-01' })],
      },
      CONFIG,
    );
    expect(findings).toHaveLength(0);
  });

  it('D3 — rolls up PER BUYER: one finding per buyer, fingerprint keyed [site, buyer]', () => {
    const rows = [
      row({ loadId: 'a', buyer: 'SA Recycling' }),
      row({ loadId: 'b', buyer: 'SA Recycling', status: 'invoiced', invoicedAtISO: '2026-05-01' }),
      row({ loadId: 'c', buyer: 'Miller Waste Mills' }),
    ];
    const findings = m3CommodityPaymentAging(win('2026-07-16'), { rows }, CONFIG);
    expect(findings).toHaveLength(2);
    const sa = findings.find((f) => f.legARef === 'SA Recycling')!;
    expect((sa.detail as { loads: unknown[] }).loads).toHaveLength(2);
    expect((sa.actual as { uninvoiced: number; unpaid: number }).uninvoiced).toBe(1);
    expect((sa.actual as { uninvoiced: number; unpaid: number }).unpaid).toBe(1);
    expect(sa.fingerprint).toBe(
      'm3_commodity_payment_aging|missing_counterpart|woodland|sa recycling',
    );
  });

  it('a load with no buyer groups under UNKNOWN_BUYER', () => {
    const findings = m3CommodityPaymentAging(
      win('2026-07-16'),
      { rows: [row({ buyer: null })] },
      CONFIG,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.legARef).toBe(UNKNOWN_BUYER);
  });

  it('disputed and paid loads never age', () => {
    const rows = [row({ loadId: 'a', status: 'disputed' }), row({ loadId: 'b', status: 'paid' })];
    expect(m3CommodityPaymentAging(win('2026-07-16'), { rows }, CONFIG)).toHaveLength(0);
  });

  it('a historical run (no asOf) evaluates nothing — aging is a now-question', () => {
    expect(m3CommodityPaymentAging(win(undefined), { rows: [row()] }, CONFIG)).toHaveLength(0);
  });

  it('respects enabled=false', () => {
    expect(
      m3CommodityPaymentAging(win('2026-07-16'), { rows: [row()] }, { ...CONFIG, enabled: false }),
    ).toHaveLength(0);
  });

  it('thresholds come from params (data, not code)', () => {
    const tight = { ...CONFIG, params: { aging_ship_days: 5, aging_invoice_days: 5 } };
    const findings = m3CommodityPaymentAging(
      win('2026-07-16'),
      { rows: [row({ shipDateISO: '2026-07-08' })] }, // 8 days > 5
      tight,
    );
    expect(findings).toHaveLength(1);
  });
});
