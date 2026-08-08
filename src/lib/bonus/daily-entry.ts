// ADR-0019 §4/§7 — Bonus daily-entry (mattress-count) data layer (T-105).
//
// This is the write-side + read-side data layer behind the /bonus daily grid.
// Every public function here:
//   - assumes the caller already passed `requireBonusAccess()` (the route /
//     server-component layer enforces the Woodland gate; never trust the
//     client). Callers pass the Woodland `siteId` from the BonusContext and
//     EVERY query is scoped by it (CLAUDE.md hard rule #2 — bonus is
//     Woodland-only in V2).
//   - routes the draft-month lookup through the T-106 state machine
//     (`getOrCreateDraftPayPeriod`) so the month lifecycle stays owned by one
//     module, and gates writes through `assertEntriesEditable` so a count can
//     never be added once the month leaves `draft` (ADR-0019 §7 — totals freeze
//     at signature time).
//   - writes the entry mutation + an AuditLog row in the SAME Prisma
//     transaction so an audit row can never be lost on partial failure
//     (CLAUDE.md hard rule #6). `table_name` is always 'bonus_daily_entries'.
//
// Bonus math is NEVER hardcoded (CLAUDE.md hard rule #3): `resolveActiveRule`
// pulls the `processor_bonus_rules` row effective on the entry date, and the UI
// + this layer both compute through `@/lib/bonus/calculator`. The number on the
// grid, the number on the signed PDF, and the number in the CSV export can never
// diverge because they share that one calculator.

import { Prisma, type AuditAction } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  assertEntriesEditable,
  resolveOpenPayPeriod,
  type BonusMonthDb,
  type BonusMonthRow,
  type BonusPayPeriodState,
} from '@/lib/bonus/state-machine';
import { type BonusRuleParams } from '@/lib/bonus/calculator';
import { dailyBonusCentsFor } from '@/lib/bonus/paid-units';
import { recordSavesMovement } from '@/lib/bonus/saves-inventory';
import { shouldRequireAmendment } from '@/lib/bonus/amendment-requests';

// ────────────────────────────────────────────────────────────────────
// Date helper (UTC, zone-safe for @db.Date)
// ────────────────────────────────────────────────────────────────────

/**
 * Normalize a Date to UTC midnight of its calendar day, matching how the
 * `@db.Date` columns store `entry_date` / `period_start`. Building the key in UTC
 * avoids the local-timezone off-by-one that bites date comparisons in non-UTC
 * envs (same rationale as the state machine's month-boundary helpers).
 */
export function entryDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// ────────────────────────────────────────────────────────────────────
// Active rule resolution (CLAUDE.md hard rule #3)
// ────────────────────────────────────────────────────────────────────

export class NoActiveRuleError extends Error {
  readonly status = 409 as const;
  constructor(siteId: string) {
    super(`no active processor_bonus_rules row for site ${siteId}`);
    this.name = 'NoActiveRuleError';
  }
}

/**
 * Raised when no SEEDED `bonus_pay_periods` row covers `day` for the site
 * (T-203 / ADR-0019.1). Periods are pre-seeded with explicit Tue→Mon boundaries;
 * a day outside every seeded window (before Period 1 / after the last seeded
 * period of the year) has no open period to write into. The daily-entry layer
 * surfaces this instead of fabricating a calendar-month row.
 */
export class NoOpenPayPeriodError extends Error {
  readonly status = 409 as const;
  constructor(siteId: string, day: Date) {
    super(`no seeded bonus pay period covers ${day.toISOString().slice(0, 10)} for site ${siteId}`);
    this.name = 'NoOpenPayPeriodError';
  }
}

/**
 * Resolve the `processor_bonus_rules` row in effect for `siteId` on `onDate`:
 * the row with the latest `effective_date` that is `<= onDate` and whose
 * `end_date` is null or `>= onDate`. Throws {@link NoActiveRuleError} if no rule
 * covers the date — bonus math must never fall back to a hardcoded default.
 */
export async function resolveActiveRule(
  siteId: string,
  onDate: Date,
): Promise<BonusRuleParams & { id: string; effective_date: Date }> {
  const on = entryDateUTC(onDate);
  const rule = await prisma.processorBonusRule.findFirst({
    where: {
      site_id: siteId,
      effective_date: { lte: on },
      OR: [{ end_date: null }, { end_date: { gte: on } }],
    },
    orderBy: { effective_date: 'desc' },
  });
  if (!rule) throw new NoActiveRuleError(siteId);
  return {
    id: rule.id,
    effective_date: rule.effective_date,
    threshold_low: rule.threshold_low,
    rate_low: rule.rate_low.toString(),
    threshold_high: rule.threshold_high,
    rate_high: rule.rate_high.toString(),
  };
}

/**
 * Resolve a rule for a HISTORICAL period that may predate the earliest
 * `processor_bonus_rules` row. Returns the rule active on `onDate` when one
 * exists; otherwise falls back to the SITE'S EARLIEST rule (oldest
 * `effective_date`). Throws {@link NoActiveRuleError} only when the site has no
 * rule at all.
 *
 * ADR-0023: historical_imported periods (Jan 2025 →) can start before the
 * earliest seeded rule. Their displayed grand total is the stored AS-PAID legacy
 * total (Q1), and the per-employee rows are informational — so a missing
 * date-scoped rule must not hard-fail the read-only render (the PDF page +
 * archive). This mirrors `monthListPayout`'s graceful `NoActiveRuleError`
 * handling. NEVER call this for live/editable periods — those must use the
 * strict {@link resolveActiveRule} so a genuinely missing rule surfaces.
 */
export async function resolveRuleForHistorical(
  siteId: string,
  onDate: Date,
): Promise<BonusRuleParams & { id: string; effective_date: Date }> {
  try {
    return await resolveActiveRule(siteId, onDate);
  } catch (e) {
    if (!(e instanceof NoActiveRuleError)) throw e;
    const earliest = await prisma.processorBonusRule.findFirst({
      where: { site_id: siteId },
      orderBy: { effective_date: 'asc' },
    });
    if (!earliest) throw new NoActiveRuleError(siteId);
    return {
      id: earliest.id,
      effective_date: earliest.effective_date,
      threshold_low: earliest.threshold_low,
      rate_low: earliest.rate_low.toString(),
      threshold_high: earliest.threshold_high,
      rate_high: earliest.rate_high.toString(),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Today's grid (read side)
// ────────────────────────────────────────────────────────────────────

export interface DailyGridEntryRow {
  bonus_employee_id: string;
  full_name: string;
  /** Existing count for `entry_date`, or null if not yet keyed today. */
  mattress_count: number | null;
  /**
   * ADR-0083 — mattresses SAVED for resale on `entry_date`. Null iff the row has
   * not been keyed at all (mirrors `mattress_count`); a keyed row always carries
   * a number, because the column is NOT NULL DEFAULT 0.
   */
  saves: number | null;
  note: string | null;
  /**
   * Live bonus for the existing entry, in integer cents (0 if not yet keyed).
   * ADR-0083: computed on PAID units — processed + saves — tiered once.
   */
  bonus_cents: number;
}

export interface DailyGridData {
  monthId: string;
  monthState: BonusPayPeriodState;
  /** Whether daily entries can be written (true iff the period is `draft`). */
  editable: boolean;
  /** UTC-midnight calendar day this grid represents. */
  entryDate: Date;
  /** Bi-weekly pay-period number (1..26) within {@link periodYear}. */
  periodNumber: number;
  /** Calendar year the pay period belongs to. */
  periodYear: number;
  /** Pay-period window (UTC-midnight @db.Date keys), for the period label. */
  periodStart: Date;
  periodEnd: Date;
  /** Rule params for client-side live calculation (NEVER hardcoded). */
  rule: BonusRuleParams;
  /** Active employees, alphabetical, with today's entry pre-loaded. */
  rows: DailyGridEntryRow[];
  /** Grand total of today's bonus across all rows, in integer cents. */
  totalCents: number;
}

/**
 * Build the daily grid for `date`: ensure the month draft exists, list ACTIVE
 * Woodland employees alphabetically, and pre-load each one's entry for
 * `entry_date` (if already keyed). The active rule is resolved for the date so
 * the client can tick live bonuses as the operator types.
 */
export async function getDailyGrid(siteId: string, date: Date): Promise<DailyGridData> {
  const entryDate = entryDateUTC(date);
  const month = await resolvePeriodOrThrow(siteId, entryDate);
  // BonusMonthRow (the lifecycle abstraction) carries id/site/window/state but not
  // the period number/year; read them by PK for the human pay-period label.
  const meta = await prisma.bonusPayPeriod.findUniqueOrThrow({
    where: { id: month.id },
    select: { period_number: true, period_year: true },
  });
  const rule = await resolveActiveRule(siteId, entryDate);

  const employees = await prisma.bonusEmployee.findMany({
    where: { site_id: siteId, is_active: true },
    orderBy: { full_name: 'asc' },
  });

  const existing = await prisma.bonusDailyEntry.findMany({
    where: { bonus_pay_period_id: month.id, entry_date: entryDate },
  });
  const byEmployee = new Map(existing.map((e) => [e.bonus_employee_id, e]));

  const ruleParams: BonusRuleParams = {
    threshold_low: rule.threshold_low,
    rate_low: rule.rate_low,
    threshold_high: rule.threshold_high,
    rate_high: rule.rate_high,
  };

  let totalCents = 0;
  const rows: DailyGridEntryRow[] = employees.map((emp) => {
    const entry = byEmployee.get(emp.id);
    const count = entry ? entry.mattress_count.toNumber() : null;
    const saves = entry ? entry.saves.toNumber() : null;
    // ADR-0083 — the row's bonus is tiered ONCE over processed + saves, through
    // the shared `paid-units` funnel. Same call the sign-time lock and the PDF
    // make, so the grid cannot show a number the signature would contradict.
    const bonus_cents = entry ? dailyBonusCentsFor(entry, ruleParams) : 0;
    totalCents += bonus_cents;
    return {
      bonus_employee_id: emp.id,
      full_name: emp.full_name,
      mattress_count: count,
      saves,
      note: entry?.note ?? null,
      bonus_cents,
    };
  });

  return {
    monthId: month.id,
    monthState: month.state,
    editable: month.state === 'draft',
    entryDate,
    periodNumber: meta.period_number,
    periodYear: meta.period_year,
    periodStart: month.period_start,
    periodEnd: month.period_end,
    rule: ruleParams,
    rows,
    totalCents,
  };
}

// ────────────────────────────────────────────────────────────────────
// Upsert (write side)
// ────────────────────────────────────────────────────────────────────

export interface DailyEntryInput {
  bonus_employee_id: string;
  mattress_count: number;
  /**
   * ADR-0083 — mattresses saved for resale.
   *
   * Optional on the wire for one reason only: a browser tab opened before this
   * deploy posts a body without it. ABSENT MEANS UNCHANGED, never zero:
   *   • insert → 0 (the column default; nothing was keyed, nobody is owed)
   *   • update → the existing stored value is preserved
   *
   * The other reading — absent ⇒ write 0 — is the destructive one and was
   * rejected: a manager on a stale tab correcting somebody's NOTE would silently
   * zero that processor's saves for the day and underpay them, with the write
   * looking entirely routine in the audit log. "Not supplied" and "zero" are
   * different claims and payroll is where that distinction has to hold. Clearing
   * saves is still possible — a current client sends an explicit `0`.
   */
  saves?: number | undefined;
  note?: string | null;
}

interface ActorContext {
  actorUserId: string;
  actorLabel?: string | null;
  ip: string | null;
  userAgent: string | null;
  isAdmin?: boolean;
}

export interface UpsertedEntry {
  id: string;
  bonus_employee_id: string;
  mattress_count: number;
  saves: number;
  note: string | null;
  entered_by_user_id: string;
}

export type UpsertDailyEntriesResult =
  | { ok: true; monthId: string; entries: UpsertedEntry[] }
  | { ok: false; reason: 'month_locked'; state: BonusPayPeriodState }
  | {
      ok: false;
      reason:
        | 'count_out_of_range'
        | 'saves_out_of_range'
        | 'employee_not_in_site'
        | 'unknown_employee';
    }
  | {
      ok: 'requires_amendment';
      monthId: string;
      pending: Array<{
        bonus_employee_id: string;
        change_type: 'update' | 'insert';
        existing: { mattress_count: number; saves: number; note: string | null } | null;
        proposed: { mattress_count: number; saves: number; note: string | null };
      }>;
    };

const MAX_MATTRESS_COUNT = 999;

/**
 * A keyed mattress count is valid iff it is finite, in 0..999, and has at most
 * one decimal place (the Decimal(5,1) column resolution — T-330). Negatives and
 * two-or-more-decimal values (e.g. 23.55) are rejected. The integer-floor of the
 * value drives the bonus math; the fractional tenth is stored verbatim.
 */
export function isValidMattressCount(n: number): boolean {
  if (!Number.isFinite(n) || n < 0 || n > MAX_MATTRESS_COUNT) return false;
  // One decimal place: scaling by 10 must yield a whole number. Round first to
  // absorb binary-float noise (23.5 * 10 === 235 exactly, but guard regardless).
  const scaled = n * 10;
  return Math.abs(scaled - Math.round(scaled)) < 1e-9;
}

// Audit serializer. Mirrors `writeAudit()` / `employees.ts`: Date instances
// ISO-stringify via the JSON round-trip, matching the audit-table behavior.
function serializeForAudit(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

/**
 * The state machine declares `BonusMonthDb` as a narrow structural client so it
 * can compose with both the singleton and an interactive `tx`. The real
 * `PrismaClient` satisfies every method `resolveOpenPayPeriod` actually calls
 * (`bonusPayPeriod.findFirst`), but its `$transaction` has a wider overload set
 * than the structural type, so a direct pass trips variance. We only ever hand the
 * singleton to `resolveOpenPayPeriod` (which never calls `$transaction`), so this
 * narrowing is sound. Documented cast, not a silent one.
 */
function monthDb(): BonusMonthDb {
  return prisma as unknown as BonusMonthDb;
}

/**
 * Resolve the seeded pay period covering `day` for `siteId`, or throw
 * {@link NoOpenPayPeriodError} (409) when none does. Used by both the read
 * (`getDailyGrid`) and write (`upsertDailyEntries`) paths so neither fabricates a
 * period row (T-203 / ADR-0019.1).
 */
async function resolvePeriodOrThrow(siteId: string, day: Date): Promise<BonusMonthRow> {
  const period = await resolveOpenPayPeriod(monthDb(), siteId, day);
  if (!period) throw new NoOpenPayPeriodError(siteId, day);
  return period;
}

/**
 * Upsert a batch of daily mattress-count entries for `date`, keyed by the
 * `(bonus_employee_id, entry_date)` UNIQUE constraint. Each entry is created or
 * updated, `entered_by_user_id` is stamped from the actor (Janette / Morena /
 * Bill can all key — ADR-0019 §4), and an audit row lands in the SAME
 * transaction as every write.
 *
 * Writes are refused (409 `month_locked`) once the month leaves `draft`
 * (ADR-0019 §7), via the T-106 `assertEntriesEditable` guard. The `note` field
 * is free text and never affects bonus math.
 *
 * Validation: counts are in 0..999 with at most ONE decimal place (T-330 —
 * `mattress_count` is Decimal(5,1)). Negatives and >1 decimal place are rejected;
 * >200 is a soft UI warning, NOT a hard reject — the operator can confirm a
 * legitimately high day. Each employee must be an ACTIVE Woodland row.
 */
export async function upsertDailyEntries(
  siteId: string,
  date: Date,
  inputs: DailyEntryInput[],
  actor: ActorContext,
): Promise<UpsertDailyEntriesResult> {
  const entryDate = entryDateUTC(date);

  // Validate counts up front (cheap, no DB) so a bad batch never opens a tx.
  // T-330: at most one decimal place, 0..999, no negatives. The Decimal(5,1)
  // column stores the fractional value verbatim; the calculator floors it.
  for (const i of inputs) {
    if (!isValidMattressCount(i.mattress_count)) {
      return { ok: false, reason: 'count_out_of_range' };
    }
    // ADR-0083 — `saves` is the same shape as `mattress_count` (Decimal(5,1),
    // 0..999, one decimal place), so it reuses the same validator rather than a
    // parallel one that could drift from it. A distinct reason code so the
    // operator is told WHICH box is wrong.
    if (i.saves !== undefined && !isValidMattressCount(i.saves)) {
      return { ok: false, reason: 'saves_out_of_range' };
    }
  }

  // Resolve the seeded pay period covering this day (NEVER fabricated — T-203 /
  // ADR-0019.1) and confirm it is still editable BEFORE opening the write
  // transaction. A `skipped` (or any non-draft) period is locked here; an
  // uncovered day throws NoOpenPayPeriodError up to the route.
  const month = await resolvePeriodOrThrow(siteId, entryDate);
  if (month.state !== 'draft') {
    return { ok: false, reason: 'month_locked', state: month.state };
  }

  // Confirm every employee belongs to this site and is active. Scoping by
  // site_id here is the Woodland-only guard at the data layer (hard rule #2);
  // a client that forges another site's employee id is rejected, not written.
  const ids = inputs.map((i) => i.bonus_employee_id);
  const employees = await prisma.bonusEmployee.findMany({
    where: { id: { in: ids }, site_id: siteId, is_active: true },
    select: { id: true },
  });
  const validIds = new Set(employees.map((e) => e.id));
  for (const i of inputs) {
    if (!validIds.has(i.bonus_employee_id)) {
      return { ok: false, reason: 'employee_not_in_site' };
    }
  }

  // ADR-0028: route prior-day count changes through the amendment workflow.
  // We load existing entries for the day, run shouldRequireAmendment per input,
  // and if ANY input requires the workflow, surface the requires_amendment
  // shape so the route layer can pivot to the modal flow. The direct path
  // remains for same-day edits, note-only edits, inserts on today, and admin.
  const existingRows = await prisma.bonusDailyEntry.findMany({
    where: { bonus_employee_id: { in: ids }, entry_date: entryDate },
    // ADR-0083 — `saves` is selected because it is an AMENDABLE payroll value:
    // the four-eyes routing predicate below compares it, and the pending payload
    // must show the approver the value being changed FROM.
    select: { bonus_employee_id: true, mattress_count: true, saves: true, note: true },
  });
  const existingByEmployee = new Map(
    existingRows.map((r) => [
      r.bonus_employee_id,
      { mattress_count: r.mattress_count.toNumber(), saves: r.saves.toNumber(), note: r.note },
    ]),
  );

  // ADR-0083 — `saves` absent on the wire means UNCHANGED, not zero (see
  // `DailyEntryInput.saves`). Resolve the effective proposed value ONCE here so
  // the routing predicate, the amendment payload and the write all agree about
  // what is being proposed. If they disagreed, a change could route 'direct'
  // against one value and be written as another.
  const effectiveSaves = (input: DailyEntryInput, existingSaves: number | null): number =>
    input.saves ?? existingSaves ?? 0;

  const routingDecisions = inputs.map((input) => {
    const existing = existingByEmployee.get(input.bonus_employee_id) ?? null;
    const decision = shouldRequireAmendment(
      {
        periodState: month.state,
        entryDate,
        newCount: input.mattress_count,
        existingCount: existing?.mattress_count ?? null,
        // ADR-0083 — the four-eyes gate must see BOTH payroll quantities.
        // Before saves existed the predicate compared one number and that was
        // the whole payroll value of the row; now a prior-day edit that changes
        // ONLY saves changes what the processor is paid just as much as one that
        // changes only the processed count, and must be approved identically.
        newSaves: effectiveSaves(input, existing?.saves ?? null),
        existingSaves: existing?.saves ?? null,
        actorIsAdmin: actor.isAdmin === true,
      },
      existing?.note ?? null,
    );
    return { input, existing, decision };
  });

  const anyAmendment = routingDecisions.some((r) => r.decision.route === 'amendment');
  if (anyAmendment) {
    return {
      ok: 'requires_amendment',
      monthId: month.id,
      pending: routingDecisions
        .filter((r) => r.decision.route === 'amendment')
        .map((r) => ({
          bonus_employee_id: r.input.bonus_employee_id,
          change_type: (r.decision as { changeType: 'update' | 'insert' }).changeType,
          existing: r.existing,
          proposed: {
            mattress_count: r.input.mattress_count,
            saves: effectiveSaves(r.input, r.existing?.saves ?? null),
            note: r.input.note ?? null,
          },
        })),
    };
  }

  const entries = await prisma.$transaction(async (tx) => {
    // Re-assert editability inside the tx as a backstop against a concurrent
    // transition between the pre-check and the write (ADR-0019 §7).
    const fresh = await tx.bonusPayPeriod.findUnique({ where: { id: month.id } });
    if (fresh) assertEntriesEditable({ id: fresh.id, state: fresh.state });

    const out: UpsertedEntry[] = [];
    for (const input of inputs) {
      const before = await tx.bonusDailyEntry.findUnique({
        where: {
          bonus_employee_id_entry_date: {
            bonus_employee_id: input.bonus_employee_id,
            entry_date: entryDate,
          },
        },
      });

      const note = input.note && input.note.trim().length > 0 ? input.note.trim() : null;

      // ADR-0083 — absent `saves` means UNCHANGED (stale-tab safety), so on an
      // update we omit the field entirely rather than writing a zero over a real
      // value; on an insert the column default (0) applies.
      const savesBefore = before ? before.saves.toNumber() : null;

      const row = await tx.bonusDailyEntry.upsert({
        where: {
          bonus_employee_id_entry_date: {
            bonus_employee_id: input.bonus_employee_id,
            entry_date: entryDate,
          },
        },
        create: {
          bonus_employee_id: input.bonus_employee_id,
          bonus_pay_period_id: month.id,
          entry_date: entryDate,
          mattress_count: input.mattress_count,
          saves: input.saves ?? 0,
          note,
          entered_by_user_id: actor.actorUserId,
        },
        update: {
          mattress_count: input.mattress_count,
          // Omitted entirely when not supplied, so an update leaves the stored
          // value alone. Written as a direct `=== undefined` comparison rather
          // than via a boolean: TypeScript narrows on the former, and under
          // `exactOptionalPropertyTypes` a non-narrowed spread would smuggle
          // `saves: undefined` into the Prisma update input.
          ...(input.saves === undefined ? {} : { saves: input.saves }),
          note,
          // Re-stamp the keyer: the last person to touch the row owns it
          // (ADR-0019 §4 — Janette/Morena/Bill can each key; audit differentiates).
          entered_by_user_id: actor.actorUserId,
        },
      });

      // ADR-0083 inventory leg — a save is resale stock. Recorded as an
      // `on_floor → saved` movement on the aggregate ledger, in THIS transaction
      // so a paid save can never exist without its inventory movement. It
      // deliberately does NOT decrement the live floor balance and writes nothing
      // to `processed_units_daily`; see `saves-inventory.ts` for why.
      await recordSavesMovement(tx, {
        siteId,
        movementDate: entryDate,
        previousSaves: savesBefore,
        currentSaves: row.saves.toNumber(),
        entryId: row.id,
        actorUserId: actor.actorUserId,
      });

      await tx.auditLog.create({
        data: {
          actor_user_id: actor.actorUserId,
          actor_label: actor.actorLabel ?? null,
          action: (before ? 'update' : 'insert') satisfies AuditAction,
          table_name: 'bonus_daily_entries',
          row_id: row.id,
          before: before
            ? serializeForAudit({
                mattress_count: before.mattress_count,
                saves: before.saves,
                note: before.note,
                entered_by_user_id: before.entered_by_user_id,
              })
            : Prisma.JsonNull,
          after: serializeForAudit({
            mattress_count: row.mattress_count,
            saves: row.saves,
            note: row.note,
            entered_by_user_id: row.entered_by_user_id,
          }),
          ip: actor.ip,
          user_agent: actor.userAgent,
        },
      });

      out.push({
        id: row.id,
        bonus_employee_id: row.bonus_employee_id,
        mattress_count: row.mattress_count.toNumber(),
        saves: row.saves.toNumber(),
        note: row.note,
        entered_by_user_id: row.entered_by_user_id,
      });
    }
    return out;
  });

  return { ok: true, monthId: month.id, entries };
}

// Re-export internals tests need to drive without a DB.
export const __testing = { serializeForAudit, entryDateUTC };
