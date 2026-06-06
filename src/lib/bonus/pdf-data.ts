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
  // ─── Bi-weekly period identity (ADR-0019.1 §1) ─────────────────────
  period_number: number;
  period_year: number;
  pay_date: Date;
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

// ────────────────────────────────────────────────────────────────────
// T-209 — bi-weekly title + attestation language (ADR-0019.1 §1, §4)
// ────────────────────────────────────────────────────────────────────

/**
 * Short month/day label for a @db.Date boundary (e.g. "Jun 9"). @db.Date values
 * carry their Pacific calendar day in their UTC components, so we format in UTC
 * — re-shifting through the Pacific zone would move them back a day (see the
 * storage invariant in `@/lib/time`).
 */
function shortMonthDay(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Strip the seeded "DR3 " site-name prefix so the title reads
 * "DR3 Woodland Bonus Report" (not "DR3 DR3 Woodland ..."). `sites.name` is
 * seeded as "DR3 Woodland" / "DR3 Eugene"; the title template owns the "DR3 "
 * prefix per ADR-0019.1.
 */
export function bareSiteName(siteName: string): string {
  return siteName.replace(/^DR3\s+/i, '').trim();
}

export interface PeriodTitleInput {
  siteName: string; // raw sites.name (may carry the "DR3 " prefix)
  periodNumber: number;
  periodYear: number;
  periodStart: Date; // @db.Date Tuesday
  periodEnd: Date; // @db.Date Monday
  payDate: Date; // @db.Date Friday
}

export interface PeriodTitle {
  /** e.g. "DR3 Woodland Bonus Report — Period 13: Jun 9 – Jun 22, 2026" */
  title: string;
  /** e.g. "Pay date: Jun 26, 2026" */
  payDateLine: string;
}

/**
 * Build the bonus-PDF title block strings for a bi-weekly period (ADR-0019.1).
 * Site-name driven (works for Woodland and Eugene with no hardcoding); labels
 * use UTC-component short month/day for the @db.Date boundaries.
 */
export function formatPeriodTitle(input: PeriodTitleInput): PeriodTitle {
  const site = bareSiteName(input.siteName);
  const startLabel = shortMonthDay(input.periodStart);
  const endLabel = shortMonthDay(input.periodEnd);
  const payLabel = shortMonthDay(input.payDate);
  return {
    title: `DR3 ${site} Bonus Report — Period ${input.periodNumber}: ${startLabel} – ${endLabel}, ${input.periodYear}`,
    payDateLine: `Pay date: ${payLabel}, ${input.periodYear}`,
  };
}

/** How a signature slot came to be filled (drives attestation wording). */
export type AttestationSource = 'unsigned' | 'primary' | 'manual_override' | 'auto_override';

/**
 * Raw per-slot inputs the attestation builder needs. All names are already
 * resolved (the caller resolves user UUIDs → display names and the site's
 * natural signer from the signature chain); this keeps the builder pure.
 */
export interface AttestationSlotInput {
  /** Human role label for this slot, e.g. "Facility Manager". */
  slotRole: string;
  /** Name of the person who actually signed primary (slot signer), if any. */
  primarySignerName: string | null;
  /** Set when a human override actor filled the slot. */
  overrideActorName: string | null;
  /** Free-text manual-override reason. */
  overrideReason: string | null;
  /** Set when the system auto-signed the slot (ADR-0019.1 §4). NULL = human. */
  autoOverrideAt: Date | null;
  /** Name of who auto-signed (the configured auto-override actor, e.g. Bill). */
  autoOverrideActorName: string | null;
  /**
   * The slot's NATURAL signer — who SHOULD have signed (resolved from the
   * signature chain). Used in override wording ("on behalf of <natural signer>").
   */
  naturalSignerName: string | null;
}

export interface AttestationResult {
  source: AttestationSource;
  /** The one or two attestation lines to print, in order. */
  lines: string[];
}

/**
 * Tuesday-date label for the auto-override deadline message, e.g. "Tue Jun 9,
 * 2026" — assembled from Pacific-zone parts so the weekday/month/day reflect
 * Bill's wall clock for this true instant (08:30 AM PT). Built by hand rather
 * than via a single Intl format string because en-US inserts a comma after the
 * weekday ("Tue, Jun 9"); the ADR-0019.1 wording has no such comma.
 */
function autoOverrideDeadlineLabel(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('month')} ${get('day')}, ${get('year')}`;
}

/**
 * Build the attestation lines for one signature slot, branching on slot source
 * (ADR-0019.1 §4 / T-209):
 *
 *  - primary          → the standard attestation passed by the caller.
 *  - manual_override  → "Signed by <actor>, <role>, on behalf of <natural>, <slot role>. Reason: <reason>"
 *  - auto_override    → same lead line + the ADR-0019.1 escalation sentence.
 *
 * Distinguished by: auto when `autoOverrideAt` set; else manual when
 * `overrideActorName` set; else primary when a `primarySignerName` is present.
 */
export function buildAttestation(
  slot: AttestationSlotInput,
  standardAttestation: string,
  overrideActorRole = 'Administrator',
): AttestationResult {
  const natural = slot.naturalSignerName ?? slot.slotRole;

  // Auto override (system-applied) takes precedence — it is a kind of override
  // and always carries an autoOverrideAt timestamp.
  if (slot.autoOverrideAt) {
    const actor = slot.autoOverrideActorName ?? slot.overrideActorName ?? 'an administrator';
    const deadline = autoOverrideDeadlineLabel(slot.autoOverrideAt);
    return {
      source: 'auto_override',
      lines: [
        `Signed by ${actor}, ${overrideActorRole}, on behalf of ${natural}, ${slot.slotRole}.`,
        `System-applied admin override per ADR-0019.1 escalation policy. ${natural} did not sign by 08:30 AM PT on ${deadline}.`,
      ],
    };
  }

  // Manual human override.
  if (slot.overrideActorName) {
    const reason = slot.overrideReason?.trim();
    return {
      source: 'manual_override',
      lines: [
        `Signed by ${slot.overrideActorName}, ${overrideActorRole}, on behalf of ${natural}, ${slot.slotRole}.`,
        reason ? `Reason: ${reason}` : 'Reason: (not recorded)',
      ],
    };
  }

  // Primary signed.
  if (slot.primarySignerName) {
    return { source: 'primary', lines: [standardAttestation] };
  }

  // Not signed at all.
  return { source: 'unsigned', lines: [standardAttestation] };
}
