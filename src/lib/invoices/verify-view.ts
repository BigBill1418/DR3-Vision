// 2026-07-09 rollup §1.2 (ADR-0039/0041 addendum) — the billing-verification
// read model behind `/admin/billing/verify`.
//
// Mary's pain point (survey §1.2): billing errors originate upstream ("miss
// count in units or a location missed — this is in the reporting side that I do
// not see") and she has no way to audit them before typing the invoice into GP.
// This model gives her that check WITHOUT putting her in the pipeline: for the
// caller-reachable sites' current + previous Pacific billing months, the latest
// non-void invoice per (kind, month) plus the ADR-0039 three-way-audit posture
// for its window:
//
//   green  — APPROVED invoice, no active findings touch the window; type it
//            into GP.
//   yellow — active findings exist (but none block the trust gate), OR the
//            invoice is still a draft — read/wait before typing. A draft is
//            never green: drafts regenerate freely (D1), so their numbers are
//            not GP-safe even on a clean window.
//   red    — the trust gate BLOCKS the window (hard variance); loop back to
//            Rick before entering anything.
//
// Site scoping (CLAUDE.md hard rule #2): the model takes an explicit
// `siteScope` — 'all' only for admins / all-sites managers; a single-site
// manager's reach is their primary site. The page derives the scope from
// `requireBillingVerifyRead`; this module never widens it.
//
// Months are PACIFIC calendar months (`appCurrentMonthStart`), not raw UTC —
// at 5:30 PM PDT on July 31, UTC is already August 1, and a UTC-derived month
// pair would drop June exactly when Mary reconciles it (the src/lib/time.ts
// documented defect class).
//
// One findings fetch per site feeds BOTH the pure trust-gate evaluation and the
// rendered finding list, so the light and the list can never disagree (two
// separate reads could interleave with a concurrent resolve).

import { prisma } from '@/lib/prisma';
import { appCurrentMonthStart, dayISO } from '@/lib/time';
import { resolveCheckConfigs, type CheckConfigRow } from '@/lib/audit/config';
import { gateForWindow, type GateFinding } from '@/lib/audit/billing-gate';
import type { CheckCode, Severity } from '@/lib/audit/types';
import type { FindingStatus } from '@/lib/audit/lifecycle';
import { OVERRIDE_LABEL, overrideRowId } from './gate';
import type { InvoiceKind, InvoiceStatus } from './types';

export type VerifyLight = 'green' | 'yellow' | 'red';

/** The caller's site reach, derived from the auth gate — never widened here. */
export type VerifySiteScope = { kind: 'all' } | { kind: 'site'; siteId: string };

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
  /** Gross = total + trade discount; null when no trade discount applies. */
  grossCents: number | null;
  light: VerifyLight;
  gate: { blocked: boolean; overridden: boolean; findingCodes: CheckCode[] };
  activeFindings: VerifyFindingSummary[];
}

export interface VerifySiteModel {
  siteId: string;
  siteCode: string;
  siteName: string;
  invoices: VerifyInvoiceEntry[];
}

/** First-of-month UTC @db.Date key, shifted by `deltaMonths` from a month start. */
function shiftMonthStart(monthStart: Date, deltaMonths: number): Date {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + deltaMonths, 1));
}

function lightFor(blocked: boolean, activeCount: number, status: InvoiceStatus): VerifyLight {
  if (blocked) return 'red';
  if (activeCount > 0) return 'yellow';
  // A clean window is still not GP-safe until the numbers are frozen (D1).
  return status === 'approved' ? 'green' : 'yellow';
}

interface SiteRow {
  id: string;
  code: string;
  name: string;
}

interface FindingRow {
  id: string;
  check_code: string;
  severity: string;
  status: string;
  finding_kind: string;
  window_start: Date;
  window_end: Date;
}

/**
 * Build the verification model for the caller's reach. Per site this runs a
 * constant FOUR queries (invoices, findings, check configs, override rows) —
 * the trust gate is then evaluated in memory via the pure `gateForWindow` over
 * the SAME finding rows the page renders. `now` is injectable for tests.
 */
export async function buildBillingVerifyModel(
  siteScope: VerifySiteScope,
  now: Date = new Date(),
): Promise<VerifySiteModel[]> {
  const currentMonth = appCurrentMonthStart(now);
  const months = [shiftMonthStart(currentMonth, -1), currentMonth];

  const sites: SiteRow[] = await prisma.site.findMany({
    ...(siteScope.kind === 'site' ? { where: { id: siteScope.siteId } } : {}),
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });

  return Promise.all(sites.map((site) => buildSiteModel(site, months)));
}

async function buildSiteModel(site: SiteRow, months: Date[]): Promise<VerifySiteModel> {
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
  const invoiceRows = [...latest.values()];
  if (invoiceRows.length === 0) {
    return { siteId: site.id, siteCode: site.code, siteName: site.name, invoices: [] };
  }

  // ONE findings fetch covering every window on the page (the windows all fall
  // inside the two billing months, so their union bounds the overlap query),
  // plus the site's check configs and any exact-window overrides — 3 queries,
  // then the pure gate per invoice in memory.
  const spanStart = new Date(Math.min(...invoiceRows.map((r) => r.window_start.getTime())));
  const spanEnd = new Date(Math.max(...invoiceRows.map((r) => r.window_end.getTime())));
  const [findingRows, configRows, overrideRows] = await Promise.all([
    prisma.auditFinding.findMany({
      where: {
        site_id: site.id,
        status: { in: ['open', 'acknowledged'] },
        window_start: { lte: spanEnd },
        window_end: { gte: spanStart },
      },
      orderBy: [{ severity: 'desc' }, { first_detected_at: 'asc' }],
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
    prisma.auditCheckConfig.findMany({ where: { OR: [{ site_id: null }, { site_id: site.id }] } }),
    prisma.auditLog.findMany({
      where: {
        actor_label: OVERRIDE_LABEL,
        table_name: 'audit_findings',
        row_id: {
          in: invoiceRows.map((r) =>
            overrideRowId(site.id, dayISO(r.window_start), dayISO(r.window_end)),
          ),
        },
      },
      select: { row_id: true },
    }),
  ]);

  const configs = resolveCheckConfigs(site.id, configRows as unknown as CheckConfigRow[]);
  const overriddenWindows = new Set(overrideRows.map((o) => o.row_id));

  const invoices = invoiceRows.map((r) => {
    const windowStartISO = dayISO(r.window_start);
    const windowEndISO = dayISO(r.window_end);
    const windowFindings = (findingRows as FindingRow[]).filter(
      (f) => f.window_start <= r.window_end && f.window_end >= r.window_start,
    );
    const gateFindings: GateFinding[] = windowFindings.map((f) => ({
      id: f.id,
      checkCode: f.check_code as CheckCode,
      severity: f.severity as Severity,
      status: f.status as FindingStatus,
    }));
    const gate = gateForWindow(gateFindings, configs);
    const overridden = overriddenWindows.has(overrideRowId(site.id, windowStartISO, windowEndISO));
    const blocked = gate.blocked && !overridden;
    const findingCodes = [...new Set(gate.blockingFindings.map((f) => f.checkCode))];

    return {
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
      light: lightFor(blocked, windowFindings.length, r.status as InvoiceStatus),
      gate: { blocked, overridden, findingCodes },
      activeFindings: windowFindings.map((f) => ({
        id: f.id,
        checkCode: f.check_code,
        severity: f.severity,
        status: f.status,
        findingKind: f.finding_kind,
        windowStartISO: dayISO(f.window_start),
        windowEndISO: dayISO(f.window_end),
      })),
    };
  });

  // Month desc, then kind — the order Mary works the GP queue in.
  invoices.sort((a, b) =>
    a.billingMonthISO === b.billingMonthISO
      ? a.kind.localeCompare(b.kind)
      : b.billingMonthISO.localeCompare(a.billingMonthISO),
  );
  return { siteId: site.id, siteCode: site.code, siteName: site.name, invoices };
}
