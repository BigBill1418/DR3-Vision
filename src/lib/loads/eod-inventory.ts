// ADR-0037 Phase 4 (spec §4) — End-of-Day inventory for the ADR-0030 Daily
// Production Report.
//
// SINGLE SOURCE OF TRUTH: every number here comes from `onHand`
// (`src/lib/inventory/running-balance.ts`, the ONE `computeRunningBalance`
// consumer). This module adds no inventory arithmetic of its own — it reads the
// balance at the end of the report day and at the end of the prior day, and
// derives presentation facts (delta, pool split %, anchor freshness). Any change
// to the inventory equation happens in `running-balance.ts` and is inherited here.
//
// FRESHNESS GATE (spec §4): a computed running balance drifts. The healthy block
// only renders when a `measured` physical anchor exists within
// `EOD_INVENTORY_STALE_DAYS` (default 14) of the report day. Otherwise the report
// carries the STALE warning band — "Inventory pending physical count" — with the
// last anchor date and its age. There is deliberately NO path that renders
// healthy-state numbers on a stale anchor: a drifted floor count presented as
// fact is how a mis-billed month starts (MRC is billed on PROGRAM units).
//
// Why `measured` and not merely `physical`: a `legacy` anchor carries no
// program/non-program split (the whole count is attributed to the program pool —
// see `onHand`), so its pool figures are an artifact, not a measurement. The
// billing-relevant split is only trustworthy behind a measured anchor.
//
// ZERO STATE: before the backfill lands, a site has no anchor and no operational
// rows at all. That renders as its own neutral band (no anchor date, no scary
// warning) rather than a stale alarm about data that was never entered.
//
// asOf discipline: the report day is a @db.Date-shaped key (UTC midnight of the
// Pacific calendar day — see src/lib/time.ts). End-of-day is that key's last
// millisecond (23:59:59.999Z). That bound includes every @db.Date operational row
// for the day (daily closes, outbound, landfilled, drop-offs) and every
// paper-bulk inbound row (written at UTC midnight of its day key) while excluding
// the NEXT day's rows — which a Pacific-midnight bound would wrongly pull in on
// any backfilled report. Trade-off: an iPad-captured load whose `arrived_at`
// instant falls after 17:00 PT lands on the following day's report; no unit is
// lost, it is attributed one day later.

import { prisma } from '@/lib/prisma';
import { onHand } from '@/lib/inventory/running-balance';
import { pacificDayKeyUTC } from '@/lib/time';

/** Spec §4 default freshness window, in days, for a `measured` physical anchor. */
export const DEFAULT_EOD_INVENTORY_STALE_DAYS = 14;

/**
 * The configured freshness window. Read at call time (not module load) so the
 * value can be changed by restarting the app with a new env, and so tests can
 * drive every state. A missing/blank/non-positive/non-numeric value falls back to
 * the default — a bad env can never widen the window to infinity.
 */
export function eodInventoryStaleDays(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env['EOD_INVENTORY_STALE_DAYS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_EOD_INVENTORY_STALE_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return DEFAULT_EOD_INVENTORY_STALE_DAYS;
  }
  return n;
}

/**
 * `healthy` — fresh `measured` anchor: render the numbers.
 * `stale`   — anchor missing/legacy/older than the window: render the warning band.
 * `zero`    — no anchor AND no movement at all (pre-backfill): render the neutral band.
 */
export type EodInventoryState = 'healthy' | 'stale' | 'zero';

/** The last physical count that anchors the balance, as far as the report cares. */
export interface EodAnchorInfo {
  /** When the count was taken (a true instant). */
  countedAt: Date;
  /** `measured` = program/non-program pools were entered; `legacy` = unsplit. */
  poolAttribution: string;
  /** Whole days between the anchor's Pacific day and the report day. */
  daysSince: number;
  /** Who recorded it (audit actor name, or the system label). Null when unknown. */
  counter: string | null;
}

export interface EodInventorySnapshot {
  siteId: string;
  /** @db.Date-shaped key of the Pacific calendar day this report covers. */
  reportDate: Date;
  state: EodInventoryState;
  /** Program units on hand at end of day. */
  programOnHand: number;
  nonProgramOnHand: number;
  totalOnHand: number;
  /** Net change vs. the prior day's end-of-day total (inbound − outbound). */
  deltaFromYesterday: number;
  programDelta: number;
  nonProgramDelta: number;
  /** Program share of the total, in percent. Null when the total is ≤ 0. */
  programPct: number | null;
  nonProgramPct: number | null;
  /** Latest physical anchor at/before end of day. Null when none exists. */
  anchor: EodAnchorInfo | null;
  /** The freshness window this snapshot was graded against. */
  staleDays: number;
}

/** The end-of-day instant for a @db.Date-shaped Pacific day key. */
export function endOfReportDay(reportDate: Date): Date {
  return new Date(reportDate.getTime() + 86_400_000 - 1);
}

/** Whole days between an anchor instant's Pacific day and a @db.Date day key. */
export function daysSinceAnchor(countedAt: Date, reportDate: Date): number {
  const anchorKey = pacificDayKeyUTC(countedAt);
  return Math.round((reportDate.getTime() - anchorKey.getTime()) / 86_400_000);
}

/**
 * The freshness gate, pure. HEALTHY requires a `measured` anchor inside the
 * window; everything else is stale — except a genuinely empty site (no anchor,
 * no movement), which is `zero`.
 */
export function classifyEodInventory(args: {
  anchor: { poolAttribution: string; daysSince: number } | null;
  totalOnHand: number;
  priorTotal: number;
  staleDays: number;
}): EodInventoryState {
  const { anchor } = args;
  if (anchor !== null) {
    return anchor.poolAttribution === 'measured' && anchor.daysSince <= args.staleDays
      ? 'healthy'
      : 'stale';
  }
  return args.totalOnHand === 0 && args.priorTotal === 0 ? 'zero' : 'stale';
}

/** Percent of `total` represented by `part`, one decimal. Null when total ≤ 0. */
function pctOf(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Who took the physical count. Snapshots carry no counter column, so the actor
 * comes from the append-only audit row `reconcilePhysicalCount` writes in the
 * same transaction (CLAUDE.md hard rule #6) — the audit log IS the provenance
 * record, so reading it here keeps one truth rather than denormalising a name.
 */
async function resolveCounter(snapshotId: string): Promise<string | null> {
  const entry = await prisma.auditLog.findFirst({
    where: { table_name: 'site_inventory_snapshots', row_id: snapshotId, action: 'insert' },
    orderBy: { created_at: 'asc' },
    select: { actor_label: true, actor: { select: { name: true } } },
  });
  if (!entry) return null;
  return entry.actor?.name ?? entry.actor_label ?? null;
}

/**
 * End-of-day inventory for one site on one Pacific calendar day (spec §4).
 *
 * Site-scoped (CLAUDE.md hard rule #2). Read-only: it records nothing and can
 * never move a billing figure — it reports the same ledger the manager surface
 * shows. `reportDate` is the @db.Date-shaped day key the daily report is built for.
 */
export async function getEodInventorySnapshot(
  siteId: string,
  reportDate: Date,
): Promise<EodInventorySnapshot> {
  const staleDays = eodInventoryStaleDays();
  const endOfDay = endOfReportDay(reportDate);
  const endOfPriorDay = endOfReportDay(new Date(reportDate.getTime() - 86_400_000));

  const [balance, priorBalance, anchorRow] = await Promise.all([
    onHand(siteId, endOfDay),
    onHand(siteId, endOfPriorDay),
    prisma.siteInventorySnapshot.findFirst({
      where: { site_id: siteId, snapshot_kind: 'physical', snapshot_at: { lte: endOfDay } },
      orderBy: { snapshot_at: 'desc' },
      select: { id: true, snapshot_at: true, pool_attribution: true },
    }),
  ]);

  const anchor: EodAnchorInfo | null = anchorRow
    ? {
        countedAt: anchorRow.snapshot_at,
        poolAttribution: anchorRow.pool_attribution,
        daysSince: daysSinceAnchor(anchorRow.snapshot_at, reportDate),
        counter: await resolveCounter(anchorRow.id),
      }
    : null;

  const programOnHand = balance.program.toNumber();
  const nonProgramOnHand = balance.nonProgram.toNumber();
  const totalOnHand = balance.total.toNumber();

  return {
    siteId,
    reportDate,
    state: classifyEodInventory({
      anchor,
      totalOnHand,
      priorTotal: priorBalance.total.toNumber(),
      staleDays,
    }),
    programOnHand,
    nonProgramOnHand,
    totalOnHand,
    deltaFromYesterday: balance.total.minus(priorBalance.total).toNumber(),
    programDelta: balance.program.minus(priorBalance.program).toNumber(),
    nonProgramDelta: balance.nonProgram.minus(priorBalance.nonProgram).toNumber(),
    programPct: pctOf(programOnHand, totalOnHand),
    nonProgramPct: pctOf(nonProgramOnHand, totalOnHand),
    anchor,
    staleDays,
  };
}
