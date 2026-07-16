// ADR-0052 — payment record service: forward-only transitions, date stamping,
// Decimal-string money edges, audit provenance, implicit awaiting_invoice, CSV.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  CommodityLoadNotFoundError,
  CommodityPaymentInputError,
  CommodityPaymentTransitionError,
  listCommodityPayments,
  paymentsToCsv,
  upsertPaymentRecord,
  type PaymentListRow,
} from './payments';

const writeAudit = vi.fn();
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

interface StubPayment {
  id: string;
  status: 'awaiting_invoice' | 'invoiced' | 'paid' | 'disputed';
  buyer_invoice_ref: string | null;
  expected_amount: Prisma.Decimal | null;
  invoiced_at: Date | null;
  paid_at: Date | null;
  notes: string | null;
}

function stubDb(payment: StubPayment | null) {
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...payment!,
    ...data,
  }));
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'pay-new',
    status: 'awaiting_invoice',
    buyer_invoice_ref: null,
    expected_amount: null,
    invoiced_at: null,
    paid_at: null,
    notes: null,
    ...data,
  }));
  const db = {
    outboundMaterial: {
      findUnique: vi.fn(async () => ({ id: 'load-1', site_id: 'site-w', payment })),
    },
    outboundMaterialPayment: { update, create },
  };
  return { db: db as unknown as PrismaClient, update, create };
}

beforeEach(() => writeAudit.mockClear());

describe('upsertPaymentRecord — transitions', () => {
  it('creates the record on first touch and audits it', async () => {
    const { db, create } = stubDb(null);
    const row = await upsertPaymentRecord({
      prisma: db,
      outboundMaterialId: 'load-1',
      actorUserId: 'u-daven',
      patch: { status: 'invoiced', buyerInvoiceRef: 'INV-1001', expectedAmount: '1234.50' },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('invoiced');
    // transition ONTO invoiced with no explicit date stamps today
    expect(
      (create.mock.calls[0]![0] as { data: { invoiced_at: Date } }).data.invoiced_at,
    ).toBeInstanceOf(Date);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const audit = writeAudit.mock.calls[0]![0] as { action: string; after: { transition: string } };
    expect(audit.action).toBe('insert');
    expect(audit.after.transition).toBe('awaiting_invoice->invoiced');
  });

  it('refuses an illegal transition with NO write and NO audit', async () => {
    const paid: StubPayment = {
      id: 'pay-1',
      status: 'paid',
      buyer_invoice_ref: null,
      expected_amount: null,
      invoiced_at: new Date(),
      paid_at: new Date(),
      notes: null,
    };
    const { db, update } = stubDb(paid);
    await expect(
      upsertPaymentRecord({
        prisma: db,
        outboundMaterialId: 'load-1',
        actorUserId: 'u-daven',
        patch: { status: 'awaiting_invoice' },
      }),
    ).rejects.toBeInstanceOf(CommodityPaymentTransitionError);
    expect(update).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('paid → disputed is allowed (dispute discovered after the fact)', async () => {
    const paid: StubPayment = {
      id: 'pay-1',
      status: 'paid',
      buyer_invoice_ref: 'INV-1',
      expected_amount: null,
      invoiced_at: new Date(),
      paid_at: new Date(),
      notes: null,
    };
    const { db, update } = stubDb(paid);
    await upsertPaymentRecord({
      prisma: db,
      outboundMaterialId: 'load-1',
      actorUserId: 'u-daven',
      patch: { status: 'disputed', notes: 'short-paid by $200' },
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('field-only edit (no status) keeps the current status and audits an update', async () => {
    const inv: StubPayment = {
      id: 'pay-1',
      status: 'invoiced',
      buyer_invoice_ref: null,
      expected_amount: null,
      invoiced_at: new Date(),
      paid_at: null,
      notes: null,
    };
    const { db, update } = stubDb(inv);
    await upsertPaymentRecord({
      prisma: db,
      outboundMaterialId: 'load-1',
      actorUserId: 'u-daven',
      patch: { buyerInvoiceRef: 'INV-77' },
    });
    expect(update).toHaveBeenCalledTimes(1);
    const audit = writeAudit.mock.calls[0]![0] as { action: string };
    expect(audit.action).toBe('update');
  });

  it('rejects a float-ish / malformed amount (Decimal edge, D2 semantics)', async () => {
    const { db } = stubDb(null);
    for (const bad of ['12.345', '1,234.50', 'abc', '-5']) {
      await expect(
        upsertPaymentRecord({
          prisma: db,
          outboundMaterialId: 'load-1',
          actorUserId: 'u-daven',
          patch: { expectedAmount: bad },
        }),
      ).rejects.toBeInstanceOf(CommodityPaymentInputError);
    }
  });

  it('404s an unknown load', async () => {
    const db = {
      outboundMaterial: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    await expect(
      upsertPaymentRecord({
        prisma: db,
        outboundMaterialId: 'nope',
        actorUserId: 'u-daven',
        patch: {},
      }),
    ).rejects.toBeInstanceOf(CommodityLoadNotFoundError);
  });
});

describe('listCommodityPayments — implicit status + aging', () => {
  it('a load with no record lists as awaiting_invoice with ship aging', async () => {
    const db = {
      outboundMaterial: {
        findMany: vi.fn(async () => [
          {
            id: 'load-1',
            site_id: 'site-w',
            site: { name: 'Woodland' },
            ship_date: new Date('2026-07-01T00:00:00Z'),
            commodity: 'metal',
            sub_category: 'shredded',
            weight_lbs: 40_000,
            buyer: 'SA Recycling',
            ticket_number: 'T-9',
            payment: null,
          },
        ]),
      },
    } as unknown as PrismaClient;
    const rows = await listCommodityPayments({}, db, '2026-07-16');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('awaiting_invoice');
    expect(rows[0]!.daysSinceShip).toBe(15);
    expect(rows[0]!.daysSinceInvoiced).toBeNull();
    expect(rows[0]!.expectedAmount).toBeNull();
  });

  it('amounts surface as Decimal STRINGS, aging since invoice computed', async () => {
    const db = {
      outboundMaterial: {
        findMany: vi.fn(async () => [
          {
            id: 'load-1',
            site_id: 'site-w',
            site: { name: 'Woodland' },
            ship_date: new Date('2026-06-01T00:00:00Z'),
            commodity: 'foam',
            sub_category: 'baled',
            weight_lbs: 12_000,
            buyer: 'Miller Waste Mills',
            ticket_number: null,
            payment: {
              status: 'invoiced',
              buyer_invoice_ref: 'INV-5',
              expected_amount: new Prisma.Decimal('1234.5'),
              invoiced_at: new Date('2026-07-01T00:00:00Z'),
              paid_at: null,
              notes: null,
            },
          },
        ]),
      },
    } as unknown as PrismaClient;
    const rows = await listCommodityPayments({}, db, '2026-07-16');
    expect(rows[0]!.expectedAmount).toBe('1234.50');
    expect(rows[0]!.daysSinceInvoiced).toBe(15);
  });
});

describe('paymentsToCsv', () => {
  const row: PaymentListRow = {
    loadId: 'l1',
    siteId: 's1',
    siteName: 'Woodland',
    shipDateISO: '2026-07-01',
    commodity: 'metal',
    subCategory: 'shredded',
    weightLbs: 40000,
    buyer: 'SA, Recycling "West"',
    ticketNumber: null,
    status: 'invoiced',
    buyerInvoiceRef: 'INV-1',
    expectedAmount: '1234.50',
    invoicedAtISO: '2026-07-02',
    paidAtISO: null,
    notes: 'line1\nline2',
    daysSinceShip: 15,
    daysSinceInvoiced: 14,
  };

  it('quotes commas/quotes/newlines and keeps Decimal strings verbatim', () => {
    const csv = paymentsToCsv([row]);
    const [header, line] = csv.trim().split('\n', 2);
    expect(header).toContain('expected_amount');
    expect(line).toContain('"SA, Recycling ""West"""');
    expect(line).toContain('1234.50');
    expect(csv).toContain('"line1\nline2"');
  });
});
