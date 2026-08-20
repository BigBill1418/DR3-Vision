// ADR-0052 — commodity payment reconciliation (v1, deliberately modest).
//
// One payment record per outbound load (a load with NO record is implicitly
// `awaiting_invoice`). Manual entry by the reconciliation owner (Daven at v1);
// statuses move FORWARD (`awaiting_invoice → invoiced → paid`, `disputed`
// reachable from invoiced and back), corrections are forward transitions with
// provenance — never deletes. Every change is audited (append-only history).
// Money edges are Decimal end-to-end: amounts cross this module as STRINGS.

import { Prisma, type PrismaClient, type CommodityPaymentStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { appTodayISO, dayKeyUTCFromISO, pacificDayISO } from '@/lib/time';

/** Legal forward transitions (self-transition allowed for field-only edits). */
const TRANSITIONS: Record<CommodityPaymentStatus, readonly CommodityPaymentStatus[]> = {
  awaiting_invoice: ['awaiting_invoice', 'invoiced', 'disputed'],
  invoiced: ['invoiced', 'paid', 'disputed'],
  // A dispute resolves back onto the payment track once settled.
  disputed: ['disputed', 'invoiced', 'paid'],
  // Paid is terminal except for a dispute discovered after the fact.
  paid: ['paid', 'disputed'],
};

export class CommodityPaymentTransitionError extends Error {
  readonly status = 400 as const;
  constructor(from: CommodityPaymentStatus, to: CommodityPaymentStatus) {
    super(
      `A load's payment status cannot move ${from} → ${to}. Corrections are forward transitions.`,
    );
    this.name = 'CommodityPaymentTransitionError';
  }
}

export class CommodityLoadNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(loadId: string) {
    super(`Outbound load ${loadId} not found.`);
    this.name = 'CommodityLoadNotFoundError';
  }
}

export class CommodityPaymentInputError extends Error {
  readonly status = 400 as const;
  constructor(msg: string) {
    super(msg);
    this.name = 'CommodityPaymentInputError';
  }
}

export interface PaymentPatch {
  status?: CommodityPaymentStatus;
  buyerInvoiceRef?: string | null;
  /** Decimal-as-string, e.g. "1234.50"; null clears. Never a JS float. */
  expectedAmount?: string | null;
  /** ISO day (YYYY-MM-DD); defaults to today Pacific when a transition requires it. */
  invoicedAtISO?: string | null;
  paidAtISO?: string | null;
  notes?: string | null;
}

const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseAmount(v: string): Prisma.Decimal {
  if (!AMOUNT_RE.test(v)) {
    throw new CommodityPaymentInputError(
      'Expected amount must be a plain decimal like 1234.50 (max 2 decimal places).',
    );
  }
  return new Prisma.Decimal(v);
}

function parseDay(v: string, label: string): Date {
  if (!DAY_RE.test(v)) {
    throw new CommodityPaymentInputError(`${label} must be an ISO day (YYYY-MM-DD).`);
  }
  return dayKeyUTCFromISO(v);
}

export interface UpsertPaymentArgs {
  prisma?: PrismaClient;
  outboundMaterialId: string;
  actorUserId: string;
  patch: PaymentPatch;
}

/**
 * Create-or-update the payment record for one load, validating the status
 * transition and auditing the change (before/after). Returns the stored row.
 */
export async function upsertPaymentRecord(args: UpsertPaymentArgs) {
  const prisma = args.prisma ?? defaultPrisma;
  const load = await prisma.outboundMaterial.findUnique({
    where: { id: args.outboundMaterialId },
    select: { id: true, site_id: true, payment: true },
  });
  if (!load) throw new CommodityLoadNotFoundError(args.outboundMaterialId);

  const before = load.payment;
  const fromStatus: CommodityPaymentStatus = before?.status ?? 'awaiting_invoice';
  const toStatus: CommodityPaymentStatus = args.patch.status ?? fromStatus;
  if (!TRANSITIONS[fromStatus].includes(toStatus)) {
    throw new CommodityPaymentTransitionError(fromStatus, toStatus);
  }

  const data: Prisma.OutboundMaterialPaymentUncheckedUpdateInput = { updated_by: args.actorUserId };
  if (args.patch.status !== undefined) data.status = toStatus;
  if (args.patch.buyerInvoiceRef !== undefined) {
    data.buyer_invoice_ref = args.patch.buyerInvoiceRef?.trim() || null;
  }
  if (args.patch.expectedAmount !== undefined) {
    data.expected_amount =
      args.patch.expectedAmount === null ? null : parseAmount(args.patch.expectedAmount);
  }
  if (args.patch.invoicedAtISO !== undefined) {
    data.invoiced_at =
      args.patch.invoicedAtISO === null
        ? null
        : parseDay(args.patch.invoicedAtISO, 'Invoiced date');
  }
  if (args.patch.paidAtISO !== undefined) {
    data.paid_at =
      args.patch.paidAtISO === null ? null : parseDay(args.patch.paidAtISO, 'Paid date');
  }
  if (args.patch.notes !== undefined) data.notes = args.patch.notes?.trim() || null;

  // A transition ONTO invoiced/paid stamps its date when the caller didn't.
  if (
    toStatus === 'invoiced' &&
    fromStatus !== 'invoiced' &&
    data.invoiced_at === undefined &&
    !before?.invoiced_at
  ) {
    data.invoiced_at = dayKeyUTCFromISO(appTodayISO());
  }
  if (
    toStatus === 'paid' &&
    fromStatus !== 'paid' &&
    data.paid_at === undefined &&
    !before?.paid_at
  ) {
    data.paid_at = dayKeyUTCFromISO(appTodayISO());
  }

  // ── ADR-0118 — the money flip is guarded, and its audit row rides with it ───
  //
  // `TRANSITIONS[fromStatus]` is checked forty lines above against `before`,
  // read on the shared client. The write that followed was an unguarded
  // `update({ where: { id } })` — it succeeds whatever the row's status is now —
  // and the audit row was written afterwards, separately.
  //
  // Two managers marking the same commodity load `paid` in the AP queue both
  // read `invoiced`, both passed the transition table, and both wrote. Neither
  // is refused, `paid_at` ends up stamped by whichever landed second, and the
  // audit log gains TWO rows each claiming to be the `invoiced->paid`
  // transition — so the record of who moved this money, and from what, is
  // ambiguous forever. Worse in the reverse direction: a concurrent
  // `paid -> invoiced` correction and a `invoiced -> paid` flip can interleave
  // so the surviving status disagrees with the surviving date.
  //
  // The guard restates the status the transition was authorised FROM. On an
  // insert there is no prior row to guard, and the unique key on
  // `outbound_material_id` is what refuses a second one.
  const row = await prisma.$transaction(async (tx) => {
    let written;
    if (before) {
      const { count } = await tx.outboundMaterialPayment.updateMany({
        where: { id: before.id, status: fromStatus },
        data,
      });
      if (count === 0) {
        const now = await tx.outboundMaterialPayment.findUniqueOrThrow({
          where: { id: before.id },
          select: { status: true },
        });
        throw new CommodityPaymentTransitionError(now.status, toStatus);
      }
      written = await tx.outboundMaterialPayment.findUniqueOrThrow({ where: { id: before.id } });
    } else {
      written = await tx.outboundMaterialPayment.create({
        data: {
          ...(data as Prisma.OutboundMaterialPaymentUncheckedCreateInput),
          outbound_material_id: load.id,
          created_by: args.actorUserId,
        },
      });
    }

    // Audit uses the shared insert/update actions; the reconciliation-specific
    // transition (e.g. invoiced->paid) is carried in the `after` payload.
    // Hard rule #6 — written on the SAME transaction, so a money-status change
    // can never stand without the row that records it.
    await writeAudit(
      {
        actor_user_id: args.actorUserId,
        action: before ? 'update' : 'insert',
        table_name: 'outbound_material_payments',
        row_id: written.id,
        before: before ?? undefined,
        after: { ...written, transition: `${fromStatus}->${toStatus}` },
      },
      { tx },
    );
    return written;
  });
  return row;
}

// ─── Listing + aging (the Daven view + CSV share this) ─────────────────────

export interface PaymentListFilters {
  siteId?: string;
  status?: CommodityPaymentStatus | 'all';
}

export interface PaymentListRow {
  loadId: string;
  siteId: string;
  siteName: string;
  shipDateISO: string;
  commodity: string;
  subCategory: string;
  weightLbs: number;
  buyer: string | null;
  ticketNumber: string | null;
  status: CommodityPaymentStatus;
  buyerInvoiceRef: string | null;
  /** Decimal-as-string or null. */
  expectedAmount: string | null;
  invoicedAtISO: string | null;
  paidAtISO: string | null;
  notes: string | null;
  /** Days since ship (Pacific-day arithmetic). */
  daysSinceShip: number;
  /** Days since invoiced; null until invoiced. */
  daysSinceInvoiced: number | null;
}

function isoOfDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function daysBetweenISO(fromISO: string, toISO: string): number {
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  const to = Date.parse(`${toISO}T00:00:00Z`);
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * Every outbound load with its (implicit or stored) payment state + aging,
 * newest ship date first. A load with no record shows as `awaiting_invoice`.
 */
export async function listCommodityPayments(
  filters: PaymentListFilters = {},
  db: PrismaClient = defaultPrisma,
  todayISO: string = pacificDayISO(),
): Promise<PaymentListRow[]> {
  const loads = await db.outboundMaterial.findMany({
    where: { ...(filters.siteId ? { site_id: filters.siteId } : {}) },
    select: {
      id: true,
      site_id: true,
      site: { select: { name: true } },
      ship_date: true,
      commodity: true,
      sub_category: true,
      weight_lbs: true,
      buyer: true,
      ticket_number: true,
      payment: true,
    },
    orderBy: { ship_date: 'desc' },
  });

  const rows = loads.map((l): PaymentListRow => {
    const shipISO = l.ship_date.toISOString().slice(0, 10);
    const invoicedISO = isoOfDay(l.payment?.invoiced_at ?? null);
    return {
      loadId: l.id,
      siteId: l.site_id,
      siteName: l.site.name,
      shipDateISO: shipISO,
      commodity: String(l.commodity),
      subCategory: String(l.sub_category),
      weightLbs: l.weight_lbs,
      buyer: l.buyer,
      ticketNumber: l.ticket_number,
      status: l.payment?.status ?? 'awaiting_invoice',
      buyerInvoiceRef: l.payment?.buyer_invoice_ref ?? null,
      expectedAmount: l.payment?.expected_amount ? l.payment.expected_amount.toFixed(2) : null,
      invoicedAtISO: invoicedISO,
      paidAtISO: isoOfDay(l.payment?.paid_at ?? null),
      notes: l.payment?.notes ?? null,
      daysSinceShip: daysBetweenISO(shipISO, todayISO),
      daysSinceInvoiced: invoicedISO ? daysBetweenISO(invoicedISO, todayISO) : null,
    };
  });

  if (filters.status && filters.status !== 'all') {
    return rows.filter((r) => r.status === filters.status);
  }
  return rows;
}

/** CSV of the current (filtered) view — Excel-safe quoting, Decimal strings. */
export function paymentsToCsv(rows: readonly PaymentListRow[]): string {
  const header = [
    'site',
    'ship_date',
    'commodity',
    'sub_category',
    'weight_lbs',
    'buyer',
    'ticket_number',
    'status',
    'buyer_invoice_ref',
    'expected_amount',
    'invoiced_at',
    'paid_at',
    'days_since_ship',
    'days_since_invoiced',
    'notes',
  ];
  const esc = (v: string | number | null): string => {
    if (v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r.siteName,
      r.shipDateISO,
      r.commodity,
      r.subCategory,
      r.weightLbs,
      r.buyer,
      r.ticketNumber,
      r.status,
      r.buyerInvoiceRef,
      r.expectedAmount,
      r.invoicedAtISO,
      r.paidAtISO,
      r.daysSinceShip,
      r.daysSinceInvoiced,
      r.notes,
    ]
      .map(esc)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}
