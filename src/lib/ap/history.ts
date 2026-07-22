// ADR-0046 Amendment 5 (D-M5-5) — invoice history search.
//
// The read surface behind `/admin/ap/history` (gated by `can_view_ap_history` —
// admins + designated second approvers, NOT the general roster). A UNION of two
// provenances, distinguished by `source`:
//   • 'vision' — Vision-decided invoices (`ap_requests`, terminal approved/rejected)
//   • 'import' — Bill-uploaded historical AP rows (`ap_vendor_baseline_history`
//     WHERE source='bill_upload'). The `vision_approval` history rows are the
//     baseline-freshness feed and are DELIBERATELY excluded here — they mirror the
//     `ap_requests` rows and would double-count the same invoice.
//
// The filter/sort logic is PURE (`filterHistory`) and exhaustively unit-tested;
// `searchApHistory` is the thin fetch that maps DB rows into `HistoryEntry`s
// (resolving site ids → codes and approver ids → names in batched lookups) and
// applies the pure filter. No aggregate dashboards (D-M5-5, "Not exposed").

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { normalizeVendorName } from './variance';

export type HistorySource = 'vision' | 'import';

/// One normalized history row (union of both provenances). Vision-only fields carry
/// the decision context the row modal renders; import rows leave them undefined.
export interface HistoryEntry {
  id: string;
  source: HistorySource;
  vendorName: string;
  vendorNameNormalized: string;
  amountCents: number | null;
  /// YYYY-MM-DD — `received_at` for a Vision row, `invoice_date` for an import row.
  invoiceDate: string;
  /// 'woodland' | 'eugene' | 'not_dr3' | null.
  siteCode: string | null;
  // Vision-only decision context (undefined on import rows).
  status?: string;
  approverId?: string | null;
  approverName?: string | null;
  explanation?: string | null;
  decisionNote?: string | null;
  decisionPdfR2Key?: string | null;
  /// Import-only provenance ('bill_upload').
  importedBy?: string | null;
}

export interface HistoryFilters {
  /// Case-insensitive substring against the normalized vendor name.
  vendor?: string;
  dateFrom?: string; // YYYY-MM-DD inclusive
  dateTo?: string; // YYYY-MM-DD inclusive
  amountMinCents?: number;
  amountMaxCents?: number;
  /// 'woodland' | 'eugene' | 'not_dr3'.
  siteCode?: string;
  /// Vision-only (import rows have no approver → excluded when set).
  approverId?: string;
  source?: HistorySource;
}

/**
 * PURE filter + sort. Applies each supplied filter (all AND-combined) and returns
 * rows newest-first, then by vendor for a stable tie-break. An amount filter with a
 * bound excludes rows whose amount is null (unknown ≠ in-range); an approver filter
 * excludes import rows (they have no approver). No I/O — exhaustively unit-tested.
 */
export function filterHistory(
  entries: readonly HistoryEntry[],
  filters: HistoryFilters,
): HistoryEntry[] {
  const vendorTerm = filters.vendor ? normalizeVendorName(filters.vendor) : '';
  const out = entries.filter((e) => {
    if (vendorTerm && !e.vendorNameNormalized.includes(vendorTerm)) return false;
    if (filters.dateFrom && e.invoiceDate < filters.dateFrom) return false;
    if (filters.dateTo && e.invoiceDate > filters.dateTo) return false;
    if (filters.amountMinCents !== undefined) {
      if (e.amountCents === null || e.amountCents < filters.amountMinCents) return false;
    }
    if (filters.amountMaxCents !== undefined) {
      if (e.amountCents === null || e.amountCents > filters.amountMaxCents) return false;
    }
    if (filters.siteCode && e.siteCode !== filters.siteCode) return false;
    if (filters.approverId && e.approverId !== filters.approverId) return false;
    if (filters.source && e.source !== filters.source) return false;
    return true;
  });
  return out.sort((a, b) => {
    if (a.invoiceDate !== b.invoiceDate) return a.invoiceDate < b.invoiceDate ? 1 : -1;
    return a.vendorName.localeCompare(b.vendorName);
  });
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const RESULT_CAP = 1000;

/**
 * Fetch + normalize + filter the union history for the given filters. Pulls the
 * Vision-decided requests and the Bill-uploaded history rows, resolves site ids →
 * codes and approver ids → names in two batched lookups, then applies
 * {@link filterHistory}. Capped at {@link RESULT_CAP} rows (this is a search surface,
 * not an export — no aggregate reports, D-M5-5).
 */
export async function searchApHistory(
  prisma: PrismaClient = defaultPrisma,
  filters: HistoryFilters = {},
): Promise<HistoryEntry[]> {
  // Vision rows: terminal decisions only (approved/rejected). vendor/amount fall
  // back to the deprecated columns for pre-Amendment-5 rows.
  const requests =
    filters.source === 'import'
      ? []
      : await prisma.apRequest.findMany({
          where: { status: { in: ['approved', 'rejected'] } },
          select: {
            id: true,
            status: true,
            received_at: true,
            site_id: true,
            filed_not_dr3: true,
            decided_by: true,
            vendor_freeform: true,
            vendor: true,
            confirmed_amount_cents: true,
            amount_cents: true,
            explanation: true,
            decision_note: true,
            decision_pdf_r2_key: true,
          },
        });

  // Import rows: Bill-uploaded historical AP only (exclude the vision_approval feed).
  const imports =
    filters.source === 'vision'
      ? []
      : await prisma.apVendorBaselineHistory.findMany({
          where: { source: 'bill_upload' },
          select: {
            id: true,
            vendor_name: true,
            vendor_name_normalized: true,
            invoice_date: true,
            invoice_amount_cents: true,
            site_id: true,
            imported_by: true,
          },
        });

  // Batched id → label resolutions (site code, approver name).
  const siteIds = new Set<string>();
  const approverIds = new Set<string>();
  for (const r of requests) {
    if (r.site_id) siteIds.add(r.site_id);
    if (r.decided_by) approverIds.add(r.decided_by);
  }
  for (const h of imports) if (h.site_id) siteIds.add(h.site_id);

  const [sites, approvers] = await Promise.all([
    siteIds.size
      ? prisma.site.findMany({ where: { id: { in: [...siteIds] } }, select: { id: true, code: true } })
      : Promise.resolve([]),
    approverIds.size
      ? prisma.user.findMany({ where: { id: { in: [...approverIds] } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const codeById = new Map(sites.map((s) => [s.id, s.code]));
  const nameById = new Map(approvers.map((u) => [u.id, u.name]));

  const entries: HistoryEntry[] = [];
  for (const r of requests) {
    const vendorName = r.vendor_freeform ?? r.vendor ?? '';
    entries.push({
      id: r.id,
      source: 'vision',
      vendorName,
      vendorNameNormalized: normalizeVendorName(vendorName),
      amountCents: r.confirmed_amount_cents ?? r.amount_cents ?? null,
      invoiceDate: toISODate(r.received_at),
      siteCode: r.filed_not_dr3 ? 'not_dr3' : r.site_id ? (codeById.get(r.site_id) ?? null) : null,
      status: r.status,
      approverId: r.decided_by,
      approverName: r.decided_by ? (nameById.get(r.decided_by) ?? null) : null,
      explanation: r.explanation,
      decisionNote: r.decision_note,
      decisionPdfR2Key: r.decision_pdf_r2_key,
    });
  }
  for (const h of imports) {
    entries.push({
      id: h.id,
      source: 'import',
      vendorName: h.vendor_name,
      vendorNameNormalized: h.vendor_name_normalized,
      amountCents: h.invoice_amount_cents,
      invoiceDate: toISODate(h.invoice_date),
      siteCode: h.site_id ? (codeById.get(h.site_id) ?? null) : null,
      importedBy: h.imported_by,
    });
  }

  return filterHistory(entries, filters).slice(0, RESULT_CAP);
}
