// 2026-07-09 rollup §1.2 (ADR-0039/0041 addendum) — the billing-verification
// read model behind `/admin/billing/verify`.
//
// Mary's pain point (survey §1.2): billing errors originate upstream ("miss
// count in units or a location missed — this is in the reporting side that I do
// not see") and she has no way to audit them before typing the invoice into GP.
// This model gives her that check WITHOUT putting her in the pipeline: for each
// site's current + previous billing months, the latest non-void invoice per
// (kind, month) plus the ADR-0039 three-way-audit posture for its window:
//
//   green  — no active findings touch the window; type it into GP.
//   yellow — active findings exist but none block the ADR-0039 trust gate;
//            read them before typing.
//   red    — the trust gate BLOCKS the window (hard variance); loop back to
//            Rick before entering anything.
//
// Read-only by construction: this module exposes no writes, and the page it
// feeds is gated by `can_view_billing_verify` (auth-helpers) which unlocks
// nothing else.

import { prisma } from '@/lib/prisma';
import { evaluateWindowGate, type WindowGateResult } from './gate';
import type { InvoiceKind, InvoiceStatus } from './types';

export type VerifyLight = 'green' | 'yellow' | 'red';

export interface VerifyFindingSummary {
  id: string;
  checkCode: string;
  severity: string;
  status: string;
  findingKind: string;
  windowStartISO: string;
  windowEndISO: string;
}

export interface VerifyInvoiceEntry {
  id: string;
  kind: InvoiceKind;
  billingMonthISO: string;
  windowStartISO: string;
  windowEndISO: string;
  version: number;
  status: InvoiceStatus;
  totalCents: number;
  /** rollup §1.3 — the GP three-line structure for the CA EOM entry. */
  tradeDiscountCents: number | null;
  tradeDiscountReferenceInvoiceId: string | null;
  /** Gross = total − (−trade discount); null when no trade discount applies. */
  grossCents: number | null;
  light: VerifyLight;
  gate: Pick<WindowGateResult, 'blocked' | 'overridden' | 'findingCodes'>;
  activeFindings: VerifyFindingSummary[];
}

export interface VerifySiteModel {
  siteId: string;
  siteCode: string;
  siteName: string;
  invoices: VerifyInvoiceEntry[];
}

function dayISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First-of-month UTC for the month containing `d`, shifted by `deltaMonths`. */
function monthStartUTC(d: Date, deltaMonths: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + deltaMonths, 1));
}

function lightFor(gate: WindowGateResult, activeCount: number): VerifyLight {
  if (gate.blocked) return 'red';
  return activeCount > 0 ? 'yellow' : 'green';
}

/**
 * Build the verification model: per active site, the LATEST non-void invoice of
 * each (kind, billing month) for the current + previous month, with the audit
 * posture of its window. `now` is injectable for tests.
 */
export async function buildBillingVerifyModel(now: Date = new Date()): Promise<VerifySiteModel[]> {
  const months = [monthStartUTC(now, -1), monthStartUTC(now, 0)];
  const sites = await prisma.site.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });

  const out: VerifySiteModel[] = [];
  for (const site of sites) {
    const rows = await prisma.invoice.findMany({
      where: { site_id: site.id, billing_month: { in: months }, status: { not: 'void' } },
      orderBy: [{ billing_month: 'desc' }, { kind: 'asc' }, { version: 'desc' }],
      select: {
        id: true,
        kind: true,
        billing_month: true,
        window_start: true,
        window_end: true,
        version: true,
        status: true,
        total_cents: true,
        trade_discount_cents: true,
        trade_discount_reference_invoice_id: true,
      },
    });

    // Latest non-void version per (kind, month) — rows arrive version-desc.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const key = `${r.kind}:${dayISO(r.billing_month)}`;
      if (!latest.has(key)) latest.set(key, r);
    }

    const invoices: VerifyInvoiceEntry[] = [];
    for (const r of latest.values()) {
      const windowStartISO = dayISO(r.window_start);
      const windowEndISO = dayISO(r.window_end);
      const [gate, findings] = await Promise.all([
        evaluateWindowGate(prisma, site.id, windowStartISO, windowEndISO),
        prisma.auditFinding.findMany({
          where: {
            site_id: site.id,
            status: { in: ['open', 'acknowledged'] },
            window_start: { lte: r.window_end },
            window_end: { gte: r.window_start },
          },
          orderBy: [{ severity: 'desc' }, { first_detected_at: 'asc' }],
          take: 50,
          select: {
            id: true,
            check_code: true,
            severity: true,
            status: true,
            finding_kind: true,
            window_start: true,
            window_end: true,
          },
        }),
      ]);

      invoices.push({
        id: r.id,
        kind: r.kind as InvoiceKind,
        billingMonthISO: dayISO(r.billing_month),
        windowStartISO,
        windowEndISO,
        version: r.version,
        status: r.status as InvoiceStatus,
        totalCents: r.total_cents,
        tradeDiscountCents: r.trade_discount_cents,
        tradeDiscountReferenceInvoiceId: r.trade_discount_reference_invoice_id,
        grossCents: r.trade_discount_cents != null ? r.total_cents + r.trade_discount_cents : null,
        light: lightFor(gate, findings.length),
        gate: {
          blocked: gate.blocked,
          overridden: gate.overridden,
          findingCodes: gate.findingCodes,
        },
        activeFindings: findings.map((f) => ({
          id: f.id,
          checkCode: f.check_code,
          severity: f.severity,
          status: f.status,
          findingKind: f.finding_kind,
          windowStartISO: dayISO(f.window_start),
          windowEndISO: dayISO(f.window_end),
        })),
      });
    }

    // Month desc, then kind — the order Mary works the GP queue in.
    invoices.sort((a, b) =>
      a.billingMonthISO === b.billingMonthISO
        ? a.kind.localeCompare(b.kind)
        : b.billingMonthISO.localeCompare(a.billingMonthISO),
    );
    out.push({ siteId: site.id, siteCode: site.code, siteName: site.name, invoices });
  }
  return out;
}
