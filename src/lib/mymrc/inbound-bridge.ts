// ADR-0059 D1/D2/D3 — MyMRC hauls → inventory INBOUND bridge (the second leg).
//
// Aggregates the recycler's received-count feed (`mymrc_hauls_mirror`,
// `status='Delivered'`, `type='General'`) into `inbound_loads` — the `Inbound` leg
// the running balance (`src/lib/inventory/running-balance.ts`) reads. Before this,
// that leg was fed only by manual `paper_bulk` manager entries (#166), so on-hand
// never ROSE from real intake, only fell from processing. This module wires the two
// together as PROVISIONAL (unconfirmed) inbound, honestly labeled in the report,
// upgraded to confirmed later by a manager `paper_bulk` entry or a future iPad
// floor-confirmation.
//
// THE CRITICAL DIVERGENCE FROM THE SIBLING PROCESSED BRIDGE (ADR-0058):
//   - The processed mirror keeps ALL history in its list view (0 disappeared), so
//     ADR-0058 filters `disappeared_at IS NULL`. The HAULS mirror is the OPPOSITE:
//     `Delivered` hauls scroll off the rolling active list within a day, so ~7,191 of
//     7,215 rows are `disappeared_at`-stamped. This bridge therefore filters on
//     `status='Delivered'` and DOES **NOT** exclude `disappeared_at` — excluding it
//     would capture almost nothing. Do NOT "fix" this to match ADR-0058.
//   - Only `status='Delivered'` carries the recycler's real count; `Confirmed`
//     (scheduled) rows count 0 and `Rejected` rows are excluded.
//   - Only `type='General'` (B2B truck inbound) is this leg's source;
//     `type='Consumer Dropoff'` is a SEPARATE leg (`onHand`'s `dropoffUnits`) and is
//     excluded here to avoid double-counting it.
//
// MONEY-SAFE by construction (ADR-0059 D2/D3):
//   - GRAIN is per-(site, delivery day) AGGREGATE, not per-haul. `onHand` sums EVERY
//     verified inbound row for a day regardless of `load_source_type`, so a per-haul
//     MyMRC row plus a manager `paper_bulk` aggregate for the same day would
//     double-count. One aggregate row per site/day + a generalized partial unique index
//     (`(site_id, arrived_at) WHERE load_source_type IN ('paper_bulk','mymrc_haul',
//     'ipad_floor')`, migrations 20260810 + 20260812) makes a second AGGREGATE row
//     physically impossible. That index does NOT bar an aggregate coexisting with per-load
//     (b2b_haul) dock rows for the same day — that latent gap (ADR-0059 §4-C) is CLOSED
//     here by the ADR-0060 D5 per-load guard (`skippedPerLoad`): a day already holding a
//     VERIFIED per-load inbound row is skipped entirely.
//   - PRECEDENCE: it only ever writes rows it OWNS (`load_source_type='mymrc_haul'`)
//     and never a day an office (`paper_bulk`) or floor (`ipad_floor`) confirm already
//     owns. Enforced twice — a JS pre-check (skip guarded days) AND the atomic `ON
//     CONFLICT … DO UPDATE … WHERE load_source_type='mymrc_haul'` guard that is the
//     authoritative backstop against a confirm race. A confirmed row is left byte-
//     identical with no error.
//   - DOUBLE-COUNT-PROOF: the writer SETs ABSOLUTE aggregated values (never increments),
//     so re-running the bridge hourly is inherently idempotent. The `IS DISTINCT FROM`
//     clause additionally suppresses no-op `updated_at` churn.
//   - AUDITED (CLAUDE.md hard rule #6): every real INSERT/UPDATE emits an `audit_log`
//     row (`actor_label='mymrc-inbound-bridge'`) in the SAME transaction; a
//     guard-blocked no-op writes none.
//
// DELIVERY-DAY KEY (ADR-0089 Am.1, superseding the ADR-0059 §0/§8 tradeoff): the key is
// `recycler_reported_delivery_date ?? docking_appointment_date`. The appointment date is
// a SCHEDULING field — null on every collection-network haul (886/886 with a
// Collection_Source__c) and up to a week off the true delivery even when present
// (proven live 2026-08-10). ADR-0059's claim that "every undated haul is historical
// (pre-anchor) and inert" was FALSE: 35 post-anchor deliveries (2,429 units / 67 tons)
// carried no appointment and never reached the floor. Only a haul with NO date on
// either field is skipped now — counted in `haulsUndated` (genuinely dateless) and
// surfaced by `findDatelessDeliveredHauls` so the residual is ALERTABLE, not silent.
//
// SITE-AGNOSTIC: Woodland-only today (Eugene has 0 haul-mirror rows — ADR-0057 C-21
// Switch-Account not built); the code simply writes nothing for a site with no rows.
//
// Bundle constraint (tsconfig.mymrc.json): compiled standalone — NO `@/…` imports.
// Prisma is INJECTED; only its TYPES are imported. `pacificMidnightInstantOfDayISO`
// (from `@/lib/time`) is REPLICATED inline below (byte-identical), because the delivery
// day's `arrived_at` MUST equal exactly what `bulk-inbound.ts` writes and what `onHand`
// keys its inbound window on — a divergent instant would silently mis-window a load. The
// atomic upsert is raw SQL run through the injected client's `$queryRawUnsafe` with
// POSITIONAL parameters (injection-safe — the SQL text is a constant, every value bound).

import { randomUUID } from 'node:crypto';
import { lockSiteAgainstPromotion } from '@/lib/audit/promotion-lock';
import type { PrismaClient } from '@prisma/client';

export type BridgeLogger = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface InboundBridgeContext {
  prisma: PrismaClient;
  /** Restrict to these site_ids; default = every site present in the hauls mirror. */
  siteIds?: string[];
  /**
   * Lower bound on the delivery day (`docking_appointment_date`). When omitted the
   * bridge writes the FULL dated history (backfill). The hourly path passes a recent
   * floor so a steady-state tick only re-aggregates the trailing window. The precedence
   * guard + absolute writes make a wider window harmless (just slower).
   */
  sinceDeliveryDate?: Date;
  /**
   * When true, compute + classify every affected day but perform NO writes and NO audit
   * rows. `inserted`/`updated` report what WOULD happen. Used by the backfill script's
   * `--dry-run`.
   */
  dryRun?: boolean;
  log?: BridgeLogger;
}

export interface InboundBridgeResult {
  daysConsidered: number;
  inserted: number;
  updated: number;
  /** paper_bulk-owned (manager/confirmed) days left untouched (precedence). */
  skippedGuarded: number;
  /** mymrc_haul days already holding the exact aggregated values (no write). */
  unchanged: number;
  /**
   * Delivered General hauls with NO date on either field (ADR-0089 Am.1:
   * `recycler_reported_delivery_date ?? docking_appointment_date` both null) —
   * genuinely dateless. Surfaced to the pager via {@link findDatelessDeliveredHauls}.
   */
  haulsUndated: number;
  /**
   * ADR-0060 D5 — days skipped because a VERIFIED per-load (b2b_haul / non-aggregate)
   * inbound row already covers them. `onHand` sums EVERY verified inbound row regardless
   * of source, so writing an aggregate for a day that already has per-load rows would
   * double-count. This closes the latent gap ADR-0059 §4-C flagged: the bridge now skips
   * such days entirely (the floor confirm path does the same, refusing with a 409).
   */
  skippedPerLoad: number;
}

// ── Pacific-midnight instant (inlined replica of @/lib/time — see module header) ──
// The true UTC instant of Pacific local midnight (00:00:00) for a `YYYY-MM-DD` day key.
// DST-correct via Intl (no external deps). MUST stay byte-identical to
// `pacificMidnightInstantOfDayISO` so a bridged `arrived_at` lands on the SAME instant
// `onHand`'s inbound window (gte Pacific-midnight of the day after the anchor) keys on.

const PACIFIC_TZ = 'America/Los_Angeles';

const PACIFIC_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The signed offset (ms) such that `utc = pacificWallClockAsUTC - offset`. */
function pacificOffsetMs(at: Date): number {
  const parts = PACIFIC_PARTS_FMT.formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUTC - at.getTime();
}

/** The true UTC instant of Pacific local midnight for a `YYYY-MM-DD` day KEY. */
function pacificMidnightInstantOfDayISO(dayIso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dayIso);
  if (!m) throw new Error(`pacificMidnightInstantOfDayISO: not a YYYY-MM-DD day key: ${dayIso}`);
  const approx = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0));
  return new Date(approx.getTime() - pacificOffsetMs(approx));
}

/** The Pacific calendar day (`YYYY-MM-DD`) of a true instant — for the D5 per-load guard. */
function pacificDayIsoOf(at: Date): string {
  const parts = PACIFIC_PARTS_FMT.formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ADR-0060 D5 — the three aggregate provenances the day-slot uniqueness spans. A per-load
// (b2b_haul / anything NOT in this set) verified row is what onHand would double-count
// against a bridged aggregate on the same Pacific day, so days with such rows are skipped.
const AGGREGATE_SOURCE_TYPES = ['paper_bulk', 'mymrc_haul', 'ipad_floor'] as const;
// Statuses onHand treats as "verified inbound" (byte-identical to VERIFIED_INBOUND_STATUSES
// in running-balance.ts; replicated here because this module compiles standalone with no
// `@/…` imports — see the module header's bundle constraint).
const VERIFIED_INBOUND_STATUSES = ['verified', 'submitted_to_mymrc', 'processed'] as const;

// ── mirror + existing-row shapes the bridge needs ──

/** A hauls-mirror row shape the aggregation needs. */
interface HaulMirrorRow {
  site_id: string | null;
  docking_appointment_date: Date | null;
  /** ADR-0089 Am.1 — the true delivery date; the primary key when present. */
  recycler_reported_delivery_date: Date | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
}

/** An existing aggregate `inbound_loads` row shape the precedence pre-check needs. */
interface ExistingInboundRow {
  site_id: string;
  arrived_at: Date | null;
  load_source_type: string;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
}

interface DayAggregate {
  siteId: string;
  /** `YYYY-MM-DD` — the delivery day key (UTC components of the noon-stamped date). */
  iso: string;
  /** The Pacific-midnight instant of `iso` — the `arrived_at` value written/matched. */
  arrivedAt: Date;
  program: number;
  nonProgram: number;
}

/**
 * `docking_appointment_date` is a noon-stamped `timestamp without time zone` (mappers
 * anchor Salesforce date-only fields at 12:00 UTC). Noon is TZ-stable, so the UTC
 * calendar day equals the delivery day the recycler recorded — take the day key from the
 * UTC components directly. `docking_appointment_date::date` (the R1 reconciliation SQL)
 * yields the same day.
 */
function deliveryDayIso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Coerce a number | string | null to a JS number for equality. */
function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number((v as { toString(): string }).toString());
}

// The atomic, precedence-guarded, double-count-proof upsert (ADR-0059 D3). Absolute
// SETs; the WHERE guard means the statement is a silent no-op (0 rows returned) for a
// paper_bulk row OR an already-equal mymrc_haul row. `(xmax = 0)` in the RETURNING
// discriminates the INSERT path (xmax=0 ⇒ true) from the ON CONFLICT UPDATE path
// (xmax≠0 ⇒ false). The `ON CONFLICT … WHERE` predicate names the GENERALIZED partial
// unique index (migration 20260810) so both paper_bulk and mymrc_haul rows arbitrate on
// the same (site_id, arrived_at) slot — a paper_bulk row on the day blocks the insert,
// then the DO UPDATE guard (`load_source_type='mymrc_haul'`) refuses to touch it. Params:
// $1 id, $2 site_id, $3 arrived_at (ISO instant), $4 total, $5 program, $6 non_program.
const UPSERT_SQL = `
INSERT INTO inbound_loads
  (id, site_id, load_source_type, status, count_mode, arrived_at,
   total_units, program_unit_count, non_program_unit_count, submitted_at, created_at, updated_at)
VALUES
  ($1, $2, 'mymrc_haul', 'verified', 'total', $3::timestamptz,
   $4::int, $5::int, $6::int, now(), now(), now())
ON CONFLICT (site_id, arrived_at) WHERE load_source_type IN ('paper_bulk', 'mymrc_haul')
DO UPDATE
  SET total_units            = EXCLUDED.total_units,
      program_unit_count     = EXCLUDED.program_unit_count,
      non_program_unit_count = EXCLUDED.non_program_unit_count,
      updated_at             = now()
  WHERE inbound_loads.load_source_type = 'mymrc_haul'
    AND ( inbound_loads.total_units            IS DISTINCT FROM EXCLUDED.total_units
       OR inbound_loads.program_unit_count     IS DISTINCT FROM EXCLUDED.program_unit_count
       OR inbound_loads.non_program_unit_count IS DISTINCT FROM EXCLUDED.non_program_unit_count )
RETURNING id, (xmax = 0) AS inserted
`;

/**
 * Bridge `mymrc_hauls_mirror` (Delivered, General) → `inbound_loads`, aggregated per
 * (site, delivery day). Idempotent + precedence-guarded (see module header). Never
 * writes an operational table other than `inbound_loads`; never touches a paper_bulk /
 * manager row.
 */
export async function bridgeInboundHaulsToInventory(
  ctx: InboundBridgeContext,
): Promise<InboundBridgeResult> {
  const log = ctx.log ?? ((): void => undefined);
  const { prisma } = ctx;
  const dryRun = ctx.dryRun === true;
  const sinceIso = ctx.sinceDeliveryDate ? deliveryDayIso(ctx.sinceDeliveryDate) : null;

  const result: InboundBridgeResult = {
    daysConsidered: 0,
    inserted: 0,
    updated: 0,
    skippedGuarded: 0,
    unchanged: 0,
    haulsUndated: 0,
    skippedPerLoad: 0,
  };

  // 1. Pull the received (Delivered) B2B (General) haul rows. `disappeared_at` is
  //    DELIBERATELY not filtered (the inverse of the processed bridge — see header).
  //    An undated haul is NOT excluded by the query so it can be COUNTED as haulsUndated
  //    (an honest completeness signal), then skipped in aggregation.
  const mirrorRows = (await prisma.mymrcHaulsMirror.findMany({
    where: {
      status: 'Delivered',
      type: 'General',
      site_id: { not: null },
      ...(ctx.siteIds && ctx.siteIds.length > 0 ? { site_id: { in: ctx.siteIds } } : {}),
    },
    select: {
      site_id: true,
      docking_appointment_date: true,
      recycler_reported_delivery_date: true,
      program_unit_count: true,
      non_program_unit_count: true,
    },
  })) as HaulMirrorRow[];

  // 2. Aggregate (SUM) per (site, delivery day). Undated hauls are tallied + skipped;
  //    windowed by sinceDeliveryDate on the derived delivery day.
  const byKey = new Map<string, DayAggregate>();
  for (const r of mirrorRows) {
    if (r.site_id == null) continue; // belt-and-suspenders (query already excludes null)
    // ADR-0089 Am.1 — the recycler-reported delivery date is the key; the appointment
    // date is the fallback. Only a haul with NEITHER is dateless.
    const deliveryDate = r.recycler_reported_delivery_date ?? r.docking_appointment_date;
    if (deliveryDate == null) {
      result.haulsUndated += 1;
      continue;
    }
    const iso = deliveryDayIso(deliveryDate);
    if (sinceIso != null && iso < sinceIso) continue;
    const key = `${r.site_id}|${iso}`;
    const agg =
      byKey.get(key) ??
      ({
        siteId: r.site_id,
        iso,
        arrivedAt: pacificMidnightInstantOfDayISO(iso),
        program: 0,
        nonProgram: 0,
      } satisfies DayAggregate);
    agg.program += r.program_unit_count ?? 0;
    agg.nonProgram += r.non_program_unit_count ?? 0;
    byKey.set(key, agg);
  }

  const aggregates = [...byKey.values()];
  result.daysConsidered = aggregates.length;
  if (aggregates.length === 0) {
    log(
      'info',
      `inbound-bridge: no dated Delivered General hauls to bridge${sinceIso ? ` (since ${sinceIso})` : ''} ` +
        `(undated skipped: ${result.haulsUndated})`,
    );
    return result;
  }

  // 3. Preload the existing AGGREGATE rows (paper_bulk|mymrc_haul) for exactly the
  //    candidate (site, arrived_at) set — ONE query — so the JS pre-check classifies
  //    skippedGuarded / unchanged deterministically (the SQL guard remains the
  //    authoritative race backstop). Per-load (b2b_haul) rows are NOT aggregate rows and
  //    do not participate in the day-slot uniqueness, so they are excluded here.
  const siteIds = [...new Set(aggregates.map((a) => a.siteId))];
  const arrivedAts = [
    ...new Map(aggregates.map((a) => [a.arrivedAt.getTime(), a.arrivedAt])).values(),
  ];
  const existingRows = (await prisma.inboundLoad.findMany({
    where: {
      site_id: { in: siteIds },
      arrived_at: { in: arrivedAts },
      load_source_type: { in: ['paper_bulk', 'mymrc_haul'] },
    },
    select: {
      site_id: true,
      arrived_at: true,
      load_source_type: true,
      program_unit_count: true,
      non_program_unit_count: true,
    },
  })) as ExistingInboundRow[];
  const existingByKey = new Map<string, ExistingInboundRow>();
  for (const e of existingRows) {
    if (e.arrived_at == null) continue;
    existingByKey.set(`${e.site_id}|${e.arrived_at.getTime()}`, e);
  }

  // 3b. ADR-0060 D5 — preload VERIFIED per-load (non-aggregate) inbound rows overlapping
  //     the candidate window, keyed by `${site}|${Pacific-day}`. A day that already has a
  //     per-load dock capture must NOT also get an aggregate row (onHand sums both →
  //     double-count). One bounded query across the min→max arrived-at span (per-load
  //     arrived_at is a real dock instant, so it is matched on its Pacific calendar day).
  const arrivedTimes = arrivedAts.map((d) => d.getTime());
  const windowStart = new Date(Math.min(...arrivedTimes));
  const windowEnd = new Date(Math.max(...arrivedTimes) + 86_400_000); // +1 day, exclusive upper
  const perLoadRows = (await prisma.inboundLoad.findMany({
    where: {
      site_id: { in: siteIds },
      status: { in: [...VERIFIED_INBOUND_STATUSES] },
      load_source_type: { notIn: [...AGGREGATE_SOURCE_TYPES] },
      arrived_at: { gte: windowStart, lt: windowEnd },
    },
    select: { site_id: true, arrived_at: true },
  })) as Array<{ site_id: string; arrived_at: Date | null }>;
  const perLoadDays = new Set<string>();
  for (const r of perLoadRows) {
    if (r.arrived_at) perLoadDays.add(`${r.site_id}|${pacificDayIsoOf(r.arrived_at)}`);
  }

  // 4. Per affected day: pre-check precedence, then the guarded upsert + audit in a
  //    per-day transaction.
  for (const agg of aggregates) {
    const existing = existingByKey.get(`${agg.siteId}|${agg.arrivedAt.getTime()}`);

    // PER-LOAD GUARD (ADR-0060 D5): a verified per-load dock capture already covers this
    // Pacific day — writing an aggregate would double-count in onHand. Skip entirely.
    if (perLoadDays.has(`${agg.siteId}|${agg.iso}`)) {
      result.skippedPerLoad += 1;
      continue;
    }

    // PRECEDENCE: a paper_bulk (manager/confirmed) OR ipad_floor (operator-confirmed) row
    // owns the day — never touch it. The bridge only ever writes rows it owns (mymrc_haul).
    if (existing && existing.load_source_type !== 'mymrc_haul') {
      result.skippedGuarded += 1;
      continue;
    }
    // UNCHANGED: a mymrc_haul row already holding these exact values.
    if (
      existing &&
      toNumber(existing.program_unit_count) === agg.program &&
      toNumber(existing.non_program_unit_count) === agg.nonProgram
    ) {
      result.unchanged += 1;
      continue;
    }
    if (dryRun) {
      if (existing) result.updated += 1;
      else result.inserted += 1;
      continue;
    }

    const total = agg.program + agg.nonProgram;
    await prisma.$transaction(async (tx) => {
      // ADR-0120 — serialise against workbook promotion at this site. NB this
      // transaction is opened once PER AGGREGATED DAY inside the loop, so the
      // lock is taken and released once per day rather than once per run. That
      // is deliberate: holding it across a whole backfill would block the floor
      // for the length of the backfill, and each day's upsert is independently
      // correct.
      await lockSiteAgainstPromotion(tx, agg.siteId);
      const rows = (await tx.$queryRawUnsafe(
        UPSERT_SQL,
        randomUUID(),
        agg.siteId,
        agg.arrivedAt.toISOString(),
        total,
        agg.program,
        agg.nonProgram,
      )) as Array<{ id: string; inserted: boolean }>;

      // 0 rows ⇒ the WHERE guard blocked the write. Given the pre-check already excluded
      // the known guarded/unchanged cases, reaching here with 0 rows means the row
      // changed ownership/values UNDER us (a manager paper_bulk entry, or a concurrent
      // identical mymrc_haul write, landed between preload and this statement). Either
      // way we did NOT write and must NOT audit — the guard held. Count it as guarded (a
      // manager row was protected) rather than as a phantom write.
      if (rows.length === 0) {
        result.skippedGuarded += 1;
        return;
      }
      const rec = rows[0] as { id: string; inserted: boolean };
      if (rec.inserted) result.inserted += 1;
      else result.updated += 1;

      await tx.auditLog.create({
        data: {
          actor_user_id: null,
          actor_label: 'mymrc-inbound-bridge',
          action: rec.inserted ? 'insert' : 'update',
          table_name: 'inbound_loads',
          row_id: rec.id,
          after: {
            arrived_at: agg.iso,
            total_units: total,
            program_unit_count: agg.program,
            non_program_unit_count: agg.nonProgram,
            load_source_type: 'mymrc_haul',
          },
        },
      });
    });
  }

  log(
    'info',
    `inbound-bridge${dryRun ? ' (dry-run)' : ''}: days=${result.daysConsidered} ` +
      `ins=${result.inserted} upd=${result.updated} skip=${result.skippedGuarded} ` +
      `perload=${result.skippedPerLoad} same=${result.unchanged} undated=${result.haulsUndated}`,
  );
  return result;
}

// ── ADR-0089 D2 — the genuinely-dateless residual is ALERTABLE, not just counted ──

/** A Delivered haul carrying units but no date on any field — a data-quality question for MRC. */
export interface DatelessDeliveredHaul {
  id: string;
  external_haul_id: string | null;
  site_id: string | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  first_seen_at: Date;
}

/**
 * Find Delivered General hauls with NO date on either key field. Two deliberate
 * narrowings keep this from storming:
 *   - `detail_fetched_at NOT NULL` — a row not yet detailed simply hasn't been
 *     ASKED for its delivery date; the pre-Am.1 backlog awaiting the D4 re-detail
 *     sweep is work-in-progress, not an anomaly.
 *   - `first_seen_at >= seenSince` — the alert covers the live/forward path (new
 *     arrivals are detailed within the hour); history is D4's job.
 * A haul that passes BOTH filters was asked and MRC had no date on any field —
 * the one remaining case where "ask MRC" is the right move (ADR-0089 D2).
 */
export async function findDatelessDeliveredHauls(args: {
  prisma: PrismaClient;
  seenSince: Date;
  siteIds?: string[];
}): Promise<DatelessDeliveredHaul[]> {
  const rows = await args.prisma.mymrcHaulsMirror.findMany({
    where: {
      status: 'Delivered',
      type: 'General',
      docking_appointment_date: null,
      recycler_reported_delivery_date: null,
      detail_fetched_at: { not: null },
      first_seen_at: { gte: args.seenSince },
      ...(args.siteIds && args.siteIds.length > 0
        ? { site_id: { in: args.siteIds } }
        : { site_id: { not: null } }),
    },
    select: {
      id: true,
      external_haul_id: true,
      site_id: true,
      program_unit_count: true,
      non_program_unit_count: true,
      first_seen_at: true,
    },
  });
  return rows as DatelessDeliveredHaul[];
}
