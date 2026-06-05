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
//     (`getOrCreateDraftMonth`) so the month lifecycle stays owned by one
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
  getOrCreateDraftMonth,
  type BonusMonthDb,
  type BonusMonthState,
} from '@/lib/bonus/state-machine';
import { calculateDailyBonusCents, type BonusRuleParams } from '@/lib/bonus/calculator';

// ────────────────────────────────────────────────────────────────────
// Date helper (UTC, zone-safe for @db.Date)
// ────────────────────────────────────────────────────────────────────

/**
 * Normalize a Date to UTC midnight of its calendar day, matching how the
 * `@db.Date` columns store `entry_date` / `month_start`. Building the key in UTC
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

// ────────────────────────────────────────────────────────────────────
// Today's grid (read side)
// ────────────────────────────────────────────────────────────────────

export interface DailyGridEntryRow {
  bonus_employee_id: string;
  full_name: string;
  /** Existing count for `entry_date`, or null if not yet keyed today. */
  mattress_count: number | null;
  note: string | null;
  /** Live bonus for the existing count, in integer cents (0 if no count yet). */
  bonus_cents: number;
}

export interface DailyGridData {
  monthId: string;
  monthState: BonusMonthState;
  /** Whether daily entries can be written (true iff the month is `draft`). */
  editable: boolean;
  /** UTC-midnight calendar day this grid represents. */
  entryDate: Date;
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
  const month = await getOrCreateDraftMonth(monthDb(), siteId, entryDate);
  const rule = await resolveActiveRule(siteId, entryDate);

  const employees = await prisma.bonusEmployee.findMany({
    where: { site_id: siteId, is_active: true },
    orderBy: { full_name: 'asc' },
  });

  const existing = await prisma.bonusDailyEntry.findMany({
    where: { bonus_month_id: month.id, entry_date: entryDate },
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
    const count = entry ? entry.mattress_count : null;
    const bonus_cents = count != null ? calculateDailyBonusCents(count, ruleParams) : 0;
    totalCents += bonus_cents;
    return {
      bonus_employee_id: emp.id,
      full_name: emp.full_name,
      mattress_count: count,
      note: entry?.note ?? null,
      bonus_cents,
    };
  });

  return {
    monthId: month.id,
    monthState: month.state,
    editable: month.state === 'draft',
    entryDate,
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
  note?: string | null;
}

interface ActorContext {
  actorUserId: string;
  actorLabel?: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface UpsertedEntry {
  id: string;
  bonus_employee_id: string;
  mattress_count: number;
  note: string | null;
  entered_by_user_id: string;
}

export type UpsertDailyEntriesResult =
  | { ok: true; monthId: string; entries: UpsertedEntry[] }
  | { ok: false; reason: 'month_locked'; state: BonusMonthState }
  | { ok: false; reason: 'count_out_of_range' | 'employee_not_in_site' | 'unknown_employee' };

const MAX_MATTRESS_COUNT = 999;

// Audit serializer. Mirrors `writeAudit()` / `employees.ts`: Date instances
// ISO-stringify via the JSON round-trip, matching the audit-table behavior.
function serializeForAudit(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

/**
 * The state machine declares `BonusMonthDb` as a narrow structural client so it
 * can compose with both the singleton and an interactive `tx`. The real
 * `PrismaClient` satisfies every method `getOrCreateDraftMonth` actually calls
 * (`bonusMonth.findUnique` / `.create`), but its `$transaction` has a wider
 * overload set than the structural type, so a direct pass trips variance. We
 * only ever hand the singleton to `getOrCreateDraftMonth` (which never calls
 * `$transaction`), so this narrowing is sound. Documented cast, not a silent one.
 */
function monthDb(): BonusMonthDb {
  return prisma as unknown as BonusMonthDb;
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
 * Validation: counts must be integers in 0..999 (the schema's documented range;
 * >200 is a soft UI warning, NOT a hard reject — the operator can confirm a
 * legitimately high day). Each employee must be an ACTIVE Woodland row.
 */
export async function upsertDailyEntries(
  siteId: string,
  date: Date,
  inputs: DailyEntryInput[],
  actor: ActorContext,
): Promise<UpsertDailyEntriesResult> {
  const entryDate = entryDateUTC(date);

  // Validate counts up front (cheap, no DB) so a bad batch never opens a tx.
  for (const i of inputs) {
    if (
      !Number.isInteger(i.mattress_count) ||
      i.mattress_count < 0 ||
      i.mattress_count > MAX_MATTRESS_COUNT
    ) {
      return { ok: false, reason: 'count_out_of_range' };
    }
  }

  // Resolve the draft month (creating it on first key of the month) and confirm
  // it is still editable BEFORE opening the write transaction.
  const month = await getOrCreateDraftMonth(monthDb(), siteId, entryDate);
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

  const entries = await prisma.$transaction(async (tx) => {
    // Re-assert editability inside the tx as a backstop against a concurrent
    // transition between the pre-check and the write (ADR-0019 §7).
    const fresh = await tx.bonusMonth.findUnique({ where: { id: month.id } });
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

      const row = await tx.bonusDailyEntry.upsert({
        where: {
          bonus_employee_id_entry_date: {
            bonus_employee_id: input.bonus_employee_id,
            entry_date: entryDate,
          },
        },
        create: {
          bonus_employee_id: input.bonus_employee_id,
          bonus_month_id: month.id,
          entry_date: entryDate,
          mattress_count: input.mattress_count,
          note,
          entered_by_user_id: actor.actorUserId,
        },
        update: {
          mattress_count: input.mattress_count,
          note,
          // Re-stamp the keyer: the last person to touch the row owns it
          // (ADR-0019 §4 — Janette/Morena/Bill can each key; audit differentiates).
          entered_by_user_id: actor.actorUserId,
        },
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
                note: before.note,
                entered_by_user_id: before.entered_by_user_id,
              })
            : Prisma.JsonNull,
          after: serializeForAudit({
            mattress_count: row.mattress_count,
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
        mattress_count: row.mattress_count,
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
