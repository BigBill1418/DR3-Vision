// P0-3 / P0-1 / P0-2 — payroll-delivery guard + loud-failure tests (ADR-0033).
//
// Drives the REAL `triggerPayrollDelivery` (a fire-and-forget background IIFE)
// with every external boundary mocked, mirroring the e2e suite's convention:
//   - @/lib/bonus/pdf            → generateBonusPdf (controllable: succeed/throw)
//   - @/lib/bonus/reconcile-fetch → the P0-1/P0-2 gates (controllable pass/block)
//   - @/lib/m365-mail            → sendPayrollPdf captured
//   - @/lib/ntfy                 → publishNtfy captured (assert P0-3 pages)
//   - @/lib/prisma               → in-memory month lookup
//   - @aws-sdk/client-s3         → R2 GetObject stubbed
// We `await vi.waitFor(...)` for the background work to settle.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── pdf double ──────────────────────────────────────────────────
const generateBonusPdf = vi.fn<(id: string) => Promise<{ storageKey: string }>>();
vi.mock('@/lib/bonus/pdf', () => ({
  generateBonusPdf: (id: string) => generateBonusPdf(id),
  PayoutReconciliationError: class PayoutReconciliationError extends Error {
    constructor(monthId: string) {
      super(`reconcile refused ${monthId}`);
      this.name = 'PayoutReconciliationError';
    }
  },
}));

// ── reconcile-fetch gates (P0-1/P0-2) — controllable ────────────
const assertPayoutReconciles = vi.fn<(monthId: string) => Promise<Record<string, unknown>>>(
  async (monthId: string) => ({
    pass: true,
    verdict: { ok: true, reconciled: true },
    period: { monthId, state: 'signed', lockedTotalCents: 100, recomputedTotalCents: 100 },
  }),
);
const assertNotSuspectedWrongZero = vi.fn<
  (monthId: string, prefetched?: unknown) => Promise<Record<string, unknown>>
>(async (monthId: string) => ({
  pass: true,
  period: { monthId, state: 'signed', lockedTotalCents: 100, recomputedTotalCents: 100 },
}));
vi.mock('@/lib/bonus/reconcile-fetch', () => ({
  assertPayoutReconciles: (id: string) => assertPayoutReconciles(id),
  assertNotSuspectedWrongZero: (id: string, p?: unknown) => assertNotSuspectedWrongZero(id, p),
}));

// ── m365 double ─────────────────────────────────────────────────
const sendPayrollPdf = vi.fn<(a: unknown) => Promise<{ delivered: boolean; disabled: boolean }>>(
  async () => ({ delivered: false, disabled: true }),
);
vi.mock('@/lib/m365-mail', () => ({ sendPayrollPdf: (a: unknown) => sendPayrollPdf(a) }));

// ── ntfy double (assert P0-3 pages) ─────────────────────────────
const publishNtfy = vi.fn<
  (a: Record<string, unknown>) => Promise<{ ok: boolean; outcome: 'sent' }>
>(async () => ({ ok: true, outcome: 'sent' as const }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (a: Record<string, unknown>) => publishNtfy(a) }));

// ── state-machine double (markPaid path) ────────────────────────
vi.mock('@/lib/bonus/state-machine', () => ({
  transitionMonth: vi.fn(async () => undefined),
  TransitionError: class TransitionError extends Error {
    from = 'signed';
  },
}));

// ── prisma double ───────────────────────────────────────────────
interface MonthRow {
  id: string;
  pdf_storage_key: string | null;
  period_start: Date;
  amended_from_period_id: string | null;
  site: { name: string };
}
let monthRow: MonthRow | null = null;
vi.mock('@/lib/prisma', () => ({
  prisma: { bonusPayPeriod: { findUnique: vi.fn(async () => monthRow) } },
}));

// ── R2 fetch stub ───────────────────────────────────────────────
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = async () => ({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { triggerPayrollDelivery } from '@/lib/bonus/payroll-delivery';

function aMonth(over: Partial<MonthRow> = {}): MonthRow {
  return {
    id: 'm1',
    pdf_storage_key: 'pdfs/bonus/WOOD/2026-06/abcd1234.pdf',
    period_start: new Date('2026-06-09'),
    amended_from_period_id: null,
    site: { name: 'DR3 Woodland' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  monthRow = aMonth();
  process.env['R2_ACCOUNT_ID'] = 'acct';
  process.env['R2_ACCESS_KEY_ID'] = 'ak';
  process.env['R2_SECRET_ACCESS_KEY'] = 'sk';
  process.env['R2_BUCKET'] = 'bucket';
  generateBonusPdf.mockResolvedValue({ storageKey: 'k' });
  assertPayoutReconciles.mockResolvedValue({
    pass: true,
    verdict: { ok: true, reconciled: true },
    period: { monthId: 'm1', state: 'signed', lockedTotalCents: 100, recomputedTotalCents: 100 },
  });
  assertNotSuspectedWrongZero.mockResolvedValue({
    pass: true,
    period: { monthId: 'm1', state: 'signed', lockedTotalCents: 100, recomputedTotalCents: 100 },
  });
});

describe('triggerPayrollDelivery — happy path', () => {
  it('reconciles, passes the zero-guard, then mails', async () => {
    triggerPayrollDelivery('m1');
    await vi.waitFor(() => expect(sendPayrollPdf).toHaveBeenCalled());
    expect(assertPayoutReconciles).toHaveBeenCalledWith('m1');
    expect(assertNotSuspectedWrongZero).toHaveBeenCalled();
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});

describe('triggerPayrollDelivery — P0-3 loud failures', () => {
  it('pages urgent + does NOT mail when PDF generation throws (generic failure)', async () => {
    generateBonusPdf.mockRejectedValueOnce(new Error('Chromium crashed'));
    triggerPayrollDelivery('m1');
    await vi.waitFor(() => expect(publishNtfy).toHaveBeenCalled());
    const arg = publishNtfy.mock.calls[0]![0];
    expect(arg['priority']).toBe('urgent');
    expect(arg['fingerprint']).toBe('payroll-pdf-failed:m1');
    expect(sendPayrollPdf).not.toHaveBeenCalled();
  });

  it('does NOT double-page when generation is refused by the reconciliation tripwire', async () => {
    // The PdfPayoutReconciliationError already fired its own urgent page inside
    // generateBonusPdf; payroll-delivery must stay silent here.
    const { PayoutReconciliationError } = await import('@/lib/bonus/pdf');
    generateBonusPdf.mockRejectedValueOnce(new PayoutReconciliationError('m1'));
    triggerPayrollDelivery('m1');
    // give the background task a tick to settle
    await new Promise((r) => setTimeout(r, 20));
    expect(publishNtfy).not.toHaveBeenCalled();
    expect(sendPayrollPdf).not.toHaveBeenCalled();
  });

  it('pages urgent when pdf_storage_key is missing after generation', async () => {
    monthRow = aMonth({ pdf_storage_key: null });
    triggerPayrollDelivery('m1');
    await vi.waitFor(() => expect(publishNtfy).toHaveBeenCalled());
    const arg = publishNtfy.mock.calls[0]![0];
    expect(arg['fingerprint']).toBe('payroll-pdf-missing-key:m1');
    expect(sendPayrollPdf).not.toHaveBeenCalled();
  });

  it('pages high when R2 is not configured for the fetch', async () => {
    delete process.env['R2_BUCKET'];
    triggerPayrollDelivery('m1');
    await vi.waitFor(() => expect(publishNtfy).toHaveBeenCalled());
    const arg = publishNtfy.mock.calls[0]![0];
    expect(arg['priority']).toBe('high');
    expect(arg['fingerprint']).toBe('payroll-r2-unconfigured:m1');
    expect(sendPayrollPdf).not.toHaveBeenCalled();
  });
});

describe('triggerPayrollDelivery — P0-1/P0-2 pre-send gates block mail', () => {
  it('does NOT mail when reconciliation fails at send time (already paged inside)', async () => {
    assertPayoutReconciles.mockResolvedValueOnce({
      pass: false,
      verdict: {
        ok: false,
        reason: 'total_mismatch',
        lockedTotalCents: 0,
        recomputedTotalCents: 212550,
      },
      period: { monthId: 'm1', state: 'signed', lockedTotalCents: 0, recomputedTotalCents: 212550 },
    });
    triggerPayrollDelivery('m1');
    await vi.waitFor(() => expect(assertPayoutReconciles).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(sendPayrollPdf).not.toHaveBeenCalled();
    // payroll-delivery itself does not re-page (the gate already did).
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('does NOT mail when the zero-guard blocks a suspected wrong $0', async () => {
    assertNotSuspectedWrongZero.mockResolvedValueOnce({
      pass: false,
      period: { monthId: 'm1', state: 'signed', lockedTotalCents: 0, recomputedTotalCents: 212550 },
    });
    triggerPayrollDelivery('m1');
    await vi.waitFor(() => expect(assertNotSuspectedWrongZero).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(sendPayrollPdf).not.toHaveBeenCalled();
  });
});
