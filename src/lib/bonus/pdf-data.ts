// T-112 — PDF data assembly (ADR-0019 §10).
//
// Pure (DB-free, browser-free) helper that turns an already-fetched bonus month
// — its employees, daily entries, and the Woodland rule — into the per-employee
// rows + totals that the printable PDF page renders. Keeping this pure makes the
// money math unit-testable without a browser, and routes EVERY cent through the
// single `@/lib/bonus/calculator` so the number on the grid, the signed PDF, and
// the CSV export can never diverge (CLAUDE.md hard rule #3 — bonus math is never
// hardcoded; it always flows from a processor_bonus_rules row).

import { randomUUID } from 'node:crypto';
import { calculateDailyBonusCents, type BonusRuleParams } from '@/lib/bonus/calculator';

export interface PdfMonthRow {
  id: string;
  site_id: string;
  period_start: Date;
  period_end: Date;
  state: string;
  total_payout_cents: number | null;
  amended_from_period_id: string | null;
}

export interface PdfEmployee {
  id: string;
  full_name: string;
}

export interface PdfEntry {
  bonus_employee_id: string;
  entry_date: Date;
  mattress_count: number;
}

export interface PdfMonthInput {
  month: PdfMonthRow;
  site: { code: string; name: string };
  employees: PdfEmployee[];
  entries: PdfEntry[];
  rule: BonusRuleParams;
}

export interface PdfEmployeeRow {
  employeeId: string;
  name: string;
  /** Count of distinct days this employee earned a positive bonus. */
  daysQualified: number;
  /** Sum of mattress counts across all the employee's keyed days this month. */
  totalMattresses: number;
  /** Sum of daily bonuses, in integer cents. */
  totalBonusCents: number;
}

export interface PdfData {
  documentId: string;
  monthLabel: string; // e.g. "May 2026"
  isAmended: boolean;
  rows: PdfEmployeeRow[];
  grandTotalCents: number;
  /** total_payout_cents locked at sign time, if set (for reconciliation). */
  lockedTotalCents: number | null;
}

/** UTC YYYY-MM for the document id / key, matching the @db.Date period_start. */
function isoMonth(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Human month label, en-US, in UTC so it matches the stored calendar month. */
function monthLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Assemble the per-employee PDF rows + totals from a fetched month. Only
 * employees with at least one keyed entry this month appear (an employee with no
 * counts contributes nothing to payroll and would clutter the report). Rows are
 * sorted by name for a stable, readable table.
 *
 * The grand total is the sum of every employee's per-day bonus and is therefore
 * identical to `calculateMonthlyBonusCents(allCounts, rule)` — both walk the same
 * calculator over the same per-day counts.
 */
export function assemblePdfRows(input: PdfMonthInput): PdfData {
  const nameById = new Map(input.employees.map((e) => [e.id, e.full_name]));

  interface Acc {
    daysQualified: number;
    totalMattresses: number;
    totalBonusCents: number;
  }
  const byEmployee = new Map<string, Acc>();

  for (const entry of input.entries) {
    // Defend against an entry referencing an employee not in the list (e.g. a
    // since-deactivated processor whose rows still count toward payroll).
    if (!nameById.has(entry.bonus_employee_id)) {
      nameById.set(entry.bonus_employee_id, entry.bonus_employee_id);
    }
    const bonus = calculateDailyBonusCents(entry.mattress_count, input.rule);
    const acc = byEmployee.get(entry.bonus_employee_id) ?? {
      daysQualified: 0,
      totalMattresses: 0,
      totalBonusCents: 0,
    };
    acc.totalMattresses += entry.mattress_count;
    acc.totalBonusCents += bonus;
    if (bonus > 0) acc.daysQualified += 1;
    byEmployee.set(entry.bonus_employee_id, acc);
  }

  const rows: PdfEmployeeRow[] = [...byEmployee.entries()]
    .map(([employeeId, acc]) => ({
      employeeId,
      name: nameById.get(employeeId) ?? employeeId,
      daysQualified: acc.daysQualified,
      totalMattresses: acc.totalMattresses,
      totalBonusCents: acc.totalBonusCents,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const grandTotalCents = rows.reduce((s, r) => s + r.totalBonusCents, 0);
  const ym = isoMonth(input.month.period_start);
  const documentId = `bonus-${input.site.code}-${ym}-${randomUUID().slice(0, 8)}`;

  return {
    documentId,
    monthLabel: monthLabel(input.month.period_start),
    isAmended: input.month.amended_from_period_id !== null,
    rows,
    grandTotalCents,
    lockedTotalCents: input.month.total_payout_cents,
  };
}

/** UTC YYYY-MM for a period_start (shared by pdf.ts for the R2 storage key). */
export function pdfMonthYm(monthStart: Date): string {
  return isoMonth(monthStart);
}
