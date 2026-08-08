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
// renders only for a `measured` physical anchor whose data is CURRENT within
// `EOD_INVENTORY_STALE_DAYS` (default 14) of the report day. Currency is graded by
// FLOW-recency, not anchor age alone (`flowThrough` — the newer of the anchor's day
// and the latest operational flow): a measured anchor kept current by daily flows
// stays fresh past its own age; a measured anchor with no recent flow goes stale on
// schedule. Otherwise the report carries the STALE warning band — "Inventory pending
// physical count" — with the last anchor date and its age. There is deliberately NO
// path that renders healthy-state numbers on a stale anchor: a drifted floor count
// presented as fact is how a mis-billed month starts (MRC is billed on PROGRAM units).
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
import { onHand, VERIFIED_INBOUND_STATUSES, anchorFlowBounds } from '@/lib/inventory/running-balance';
import { NOT_VOIDED } from '@/lib/inventory/snapshot-void';
import { dayISO, dayKeyUTCFromISO, pacificDayKeyUTC } from '@/lib/time';

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
  /**
   * Most recent Pacific calendar day (a @db.Date-shaped key) whose data feeds this
   * balance — the LATER of the anchor's day and the newest operational flow row
   * (verified inbound / processed / renovation-sold / landfilled / drop-off) at/before
   * end of day. This is what makes freshness reflect FLOW-recency, not just anchor age:
   * an old physical count kept current by daily flows still grades fresh. Null when the
   * site has no anchor and no flow at all (the zero state).
   */
  flowThrough: Date | null;
  /**
   * True when the newest data feeding the balance is dated the REPORT day — i.e. real
   * inventory activity happened today (a flow row, or a physical count taken today).
   * Drives the send gate: a day with inventory movement but zero bonus entries still
   * reports.
   */
  movementToday: boolean;
  /**
   * ADR-0059 — true when the balance's inbound since the anchor includes any
   * `load_source_type='mymrc_haul'` row: PROVISIONAL, unconfirmed inbound bridged from
   * MyMRC Delivered-haul counts, not yet floor-confirmed. Derived from the SAME rows
   * `onHand` already sums (one cheap `count`, no arithmetic) — it cannot move a billing
   * figure. Drives the report's provisional label; it goes false automatically once a
   * `paper_bulk` (manager) or iPad confirmation replaces the provisional row for a day.
   */
  inboundProvisional: boolean;
  /** The freshness window this snapshot was graded against. */
  staleDays: number;
}

/** The end-of-day instant for a @db.Date-shaped Pacific day key. */
export function endOfReportDay(reportDate: Date): Date {
  return new Date(reportDate.getTime() + 86_400_000 - 1);
}

/**
 * Whole days between the anchor's count day and a @db.Date report-day key.
 *
 * `snapshot_at` is written by the manager API at Pacific-midnight (00:00 PT = 07:00Z
 * PDT / 08:00Z PST) of the count day (D-3). Its own UTC Y/M/D still ARE the count day
 * (07:00/08:00Z is the same UTC date as 00:00Z), so take the day key from those directly
 * via `dayISO`. Do NOT re-shift the instant through the Pacific zone (`pacificDayKeyUTC`)
 * — that pushes the count back a Pacific day, making a same-day count read as "1 day ago"
 * and tripping the stale band a day early (finding 4). Correct for both the current
 * Pacific-midnight stamp and any legacy UTC-midnight row.
 */
export function daysSinceAnchor(countedAt: Date, reportDate: Date): number {
  const anchorKey = dayKeyUTCFromISO(dayISO(countedAt));
  return Math.round((reportDate.getTime() - anchorKey.getTime()) / 86_400_000);
}

/**
 * The freshness gate, pure. HEALTHY requires a `measured` anchor (the pool split is
 * only trustworthy behind a measured count — MRC is billed on program units) whose
 * data is CURRENT inside the window. Currency is measured by flow-recency, not anchor
 * age alone: `flowDaysSince` (whole days since the newest data feeding the balance —
 * anchor OR flow) tightens the age, so a measured anchor kept current by daily flows
 * stays healthy past its own age. Everything else is stale — except a genuinely empty
 * site (no anchor, no movement), which is `zero`.
 *
 * `flowDaysSince` omitted/null → age from the anchor alone (the pre-flow-recency
 * behavior); it is always ≤ the anchor's own `daysSince`, so flows can only rescue
 * freshness, never worsen it.
 */
export function classifyEodInventory(args: {
  anchor: { poolAttribution: string; daysSince: number } | null;
  totalOnHand: number;
  priorTotal: number;
  staleDays: number;
  flowDaysSince?: number | null;
}): EodInventoryState {
  const { anchor } = args;
  if (anchor !== null) {
    const effectiveDaysSince =
      args.flowDaysSince != null ? Math.min(anchor.daysSince, args.flowDaysSince) : anchor.daysSince;
    return anchor.poolAttribution === 'measured' && effectiveDaysSince <= args.staleDays
      ? 'healthy'
      : 'stale';
  }
  return args.totalOnHand === 0 && args.priorTotal === 0 ? 'zero' : 'stale';
}

/**
 * A compact fingerprint of an EOD inventory for the report resend decision. Captures
 * everything that must trigger a re-send when it changes: the freshness state, BOTH
 * pools (a program/non-program shift with an unchanged total still moves the MRC
 * billing basis), and the flow-recency day. `undefined` inventory (an inventory read
 * failure — the section is dropped) → empty string, so it never forces a resend.
 */
export function eodInventorySignature(eod: EodInventorySnapshot | undefined): string {
  if (!eod) return '';
  // ADR-0059 — include `inboundProvisional`: a provisional→confirmed flip (a manager
  // paper_bulk entry replacing the mymrc_haul row) can leave the pools unchanged yet
  // drops the "provisional" label, so the resend must fire on that transition too.
  return `${eod.state}:${eod.programOnHand}:${eod.nonProgramOnHand}:${eod.flowThrough?.getTime() ?? ''}:${eod.inboundProvisional ? 'p' : 'c'}`;
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
 * The newest Pacific calendar day (a @db.Date-shaped key) with data feeding the
 * balance at/before `endOfDay`: the latest of every operational flow row's date. The
 * anchor's own day is folded in by the caller. Each source's max date is mapped to its
 * Pacific day key — @db.Date columns already ARE that key (UTC-midnight of the Pacific
 * day); `arrived_at` is a true instant, so it is shifted through the Pacific zone.
 * Null when the site has no flow at all.
 */
async function latestFlowDayKey(siteId: string, endOfDay: Date): Promise<Date | null> {
  const [inbound, dropoff, processed, renovation, landfilled] = await Promise.all([
    prisma.inboundLoad.aggregate({
      _max: { arrived_at: true },
      where: {
        site_id: siteId,
        status: { in: [...VERIFIED_INBOUND_STATUSES] },
        arrived_at: { lte: endOfDay },
      },
    }),
    prisma.consumerDropoff.aggregate({
      _max: { dropoff_date: true },
      where: { site_id: siteId, dropoff_date: { lte: endOfDay } },
    }),
    prisma.processedUnitsDaily.aggregate({
      _max: { production_date: true },
      where: { site_id: siteId, production_date: { lte: endOfDay } },
    }),
    prisma.outboundMaterial.aggregate({
      _max: { ship_date: true },
      where: { site_id: siteId, sub_category: 'renovation', ship_date: { lte: endOfDay } },
    }),
    prisma.landfilledUnit.aggregate({
      _max: { disposal_date: true },
      where: { site_id: siteId, disposal_date: { lte: endOfDay } },
    }),
  ]);
  const keys: Date[] = [];
  if (inbound._max.arrived_at) keys.push(pacificDayKeyUTC(inbound._max.arrived_at));
  if (dropoff._max.dropoff_date) keys.push(dropoff._max.dropoff_date);
  if (processed._max.production_date) keys.push(processed._max.production_date);
  if (renovation._max.ship_date) keys.push(renovation._max.ship_date);
  if (landfilled._max.disposal_date) keys.push(landfilled._max.disposal_date);
  if (keys.length === 0) return null;
  return new Date(Math.max(...keys.map((d) => d.getTime())));
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

  const [balance, priorBalance, anchorRow, latestFlow] = await Promise.all([
    onHand(siteId, endOfDay),
    onHand(siteId, endOfPriorDay),
    prisma.siteInventorySnapshot.findFirst({
      // ADR-0084 — this row drives the daily report's "counted by X, N days ago"
      // freshness line. A voided count left visible reports the floor as freshly
      // counted at the exact moment it stopped being counted at all.
      where: {
        ...NOT_VOIDED,
        site_id: siteId,
        snapshot_kind: 'physical',
        snapshot_at: { lte: endOfDay },
      },
      // PRE-EXISTING: no ADR-0078 D1 `created_at DESC` tiebreak (see ADR-0084).
      orderBy: { snapshot_at: 'desc' },
      select: { id: true, snapshot_at: true, pool_attribution: true },
    }),
    latestFlowDayKey(siteId, endOfDay),
  ]);

  const anchor: EodAnchorInfo | null = anchorRow
    ? {
        countedAt: anchorRow.snapshot_at,
        poolAttribution: anchorRow.pool_attribution,
        daysSince: daysSinceAnchor(anchorRow.snapshot_at, reportDate),
        counter: await resolveCounter(anchorRow.id),
      }
    : null;

  // flowThrough = the LATER of the anchor's Pacific day and the newest flow day. This
  // is the recency that grades freshness and that movementToday keys on.
  const anchorDayKey = anchorRow ? dayKeyUTCFromISO(dayISO(anchorRow.snapshot_at)) : null;
  const flowThrough = mostRecentDay(anchorDayKey, latestFlow);
  const flowDaysSince =
    flowThrough != null
      ? Math.round((reportDate.getTime() - flowThrough.getTime()) / 86_400_000)
      : null;
  const movementToday = flowThrough != null && flowThrough.getTime() === reportDate.getTime();

  const programOnHand = balance.program.toNumber();
  const nonProgramOnHand = balance.nonProgram.toNumber();
  const totalOnHand = balance.total.toNumber();

  // ADR-0059 — is any of the inbound `onHand` summed for this balance PROVISIONAL
  // (`mymrc_haul`)? Uses the exact inbound window `onHand` keys on (gte Pacific-midnight
  // of the day after the anchor's Pacific day), so it reflects the same rows the balance
  // summed — a read of already-counted rows, never new arithmetic.
  const { inboundSince } = anchorFlowBounds(anchorRow ? anchorRow.snapshot_at : null);
  const provisionalInboundCount = await prisma.inboundLoad.count({
    where: {
      site_id: siteId,
      load_source_type: 'mymrc_haul',
      status: { in: [...VERIFIED_INBOUND_STATUSES] },
      arrived_at: { gte: inboundSince, lte: endOfDay },
    },
  });

  return {
    siteId,
    reportDate,
    state: classifyEodInventory({
      anchor,
      totalOnHand,
      priorTotal: priorBalance.total.toNumber(),
      staleDays,
      flowDaysSince,
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
    flowThrough,
    movementToday,
    inboundProvisional: provisionalInboundCount > 0,
    staleDays,
  };
}

/** The later of two @db.Date-shaped day keys; passes through a lone non-null; null if both null. */
function mostRecentDay(a: Date | null, b: Date | null): Date | null {
  if (a == null) return b;
  if (b == null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
