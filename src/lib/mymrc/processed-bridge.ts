// ADR-0058 D1/D2 — MyMRC processed → inventory bridge.
//
// Aggregates the authoritative daily-processed feed (`mymrc_processed_mirror`,
// `type='Processing'`, not soft-deleted) into `processed_units_daily` — the
// `Stripped` leg the running balance (`src/lib/inventory/running-balance.ts`)
// reads. Before this, that table was EMPTY (0 rows) so inventory on-hand never
// decremented from production. This module wires the two together.
//
// MONEY-SAFE by construction (ADR-0058 D2):
//   - PRECEDENCE: it only ever writes rows it OWNS (`source='mymrc'`) and never a
//     day a human closed. A `manual` (daily-close) or `import` (ADR-0048 workbook)
//     row, or ANY `closed_at`-stamped row, is left byte-identical with no error.
//     Enforced twice — a JS pre-check (skip guarded days) AND the atomic
//     `ON CONFLICT … DO UPDATE … WHERE source='mymrc' AND closed_at IS NULL` guard
//     that is the authoritative backstop against a manager-close race.
//   - DOUBLE-COUNT-PROOF: the writer SETs ABSOLUTE aggregated values (never
//     increments), so re-running the bridge hourly is inherently idempotent. The
//     `IS DISTINCT FROM` clause additionally suppresses no-op `updated_at` churn.
//   - AUDITED (CLAUDE.md hard rule #6): every real INSERT/UPDATE emits an
//     `audit_log` row (`actor_label='mymrc-processed-bridge'`) in the SAME
//     transaction; a guard-blocked no-op writes none.
//
// AGGREGATION is MANDATORY: multiple mirror rows per (site, day) occur historically
// (up to 3), so a 1:1 assumption would drop units. The program/non-program split is
// carried per the mirror's own split (legacy `units` falls back to program-only).
//
// SITE-AGNOSTIC: in practice Woodland-only today (Eugene has 0 mirror rows —
// ADR-0057 C-21 Switch-Account not built); the code simply writes nothing for a
// site with no rows. No special-casing.
//
// Bundle constraint (tsconfig.mymrc.json): compiled standalone — NO `@/…` imports.
// Prisma is INJECTED; only its TYPES are imported. The atomic upsert is raw SQL
// (Prisma's query API cannot express a guarded `ON CONFLICT … WHERE` with an
// `xmax`-discriminated RETURNING), run through the injected client's
// `$queryRawUnsafe` with POSITIONAL parameters (injection-safe — the SQL text is a
// constant, every value is a bound parameter).

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export type BridgeLogger = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface ProcessedBridgeContext {
  prisma: PrismaClient;
  /** Restrict to these site_ids; default = every site present in the mirror. */
  siteIds?: string[];
  /**
   * Lower bound on production_date (a `@db.Date`-shaped UTC-midnight key). When
   * omitted the bridge writes the FULL history (backfill). The hourly path passes a
   * recent floor so a steady-state tick only re-checks the trailing window. The
   * precedence guard makes a wider window harmless (just slower).
   */
  sinceProductionDate?: Date;
  /**
   * When true, compute + classify every affected day but perform NO writes and NO
   * audit rows. `inserted`/`updated` report what WOULD happen. Used by the backfill
   * script's `--dry-run`.
   */
  dryRun?: boolean;
  log?: BridgeLogger;
}

export interface ProcessedBridgeResult {
  daysConsidered: number;
  inserted: number;
  updated: number;
  /** manual/import/closed days left untouched (precedence). */
  skippedGuarded: number;
  /** mymrc days already holding the exact aggregated values (no write). */
  unchanged: number;
}

/** A mirror row shape the aggregation needs (payload/site + the split fields). */
interface MirrorProcessedRow {
  site_id: string | null;
  processed_date: Date | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  units: number | null;
}

/** An existing `processed_units_daily` row shape the precedence pre-check needs. */
interface ExistingProcessedRow {
  site_id: string;
  production_date: Date;
  source: string;
  closed_at: Date | null;
  stripped_program: unknown; // Prisma.Decimal at runtime
  stripped_non_program: unknown;
}

interface DayAggregate {
  siteId: string;
  /** `YYYY-MM-DD` — the Pacific production day key. */
  iso: string;
  program: number;
  nonProgram: number;
}

/**
 * `processed_date` is a noon-stamped `timestamp without time zone`; Prisma returns
 * it as a Date whose UTC calendar components ARE the stored wall clock. Noon is
 * TZ-stable, so the UTC calendar day equals the Pacific production day the bonus
 * system keys on (proven by the live reconciliation). Take the day key from the UTC
 * components directly — matches `productionDateUTC` in `src/lib/loads/processed-units.ts`.
 */
function productionDayIso(processedDate: Date): string {
  const y = processedDate.getUTCFullYear();
  const m = String(processedDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(processedDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The `@db.Date`-shaped UTC-midnight key for a `YYYY-MM-DD` day. */
function dayKeyUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Coerce a Prisma.Decimal | number | string | null to a JS number for equality. */
function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number((v as { toString(): string }).toString());
}

// The atomic, precedence-guarded, double-count-proof upsert (ADR-0058 D2). Absolute
// SETs; the WHERE guard means the statement is a silent no-op (0 rows returned) for
// a manual/import/closed row OR an already-equal mymrc row. `(xmax = 0)` in the
// RETURNING discriminates the INSERT path (xmax=0 ⇒ true) from the ON CONFLICT
// UPDATE path (xmax≠0 ⇒ false). Params: $1 id, $2 site_id, $3 production_date (ISO
// date), $4 stripped_program, $5 stripped_non_program.
const UPSERT_SQL = `
INSERT INTO processed_units_daily
  (id, site_id, production_date, stripped_program, stripped_non_program, source, created_at, updated_at)
VALUES ($1, $2, $3::date, $4::numeric, $5::numeric, 'mymrc', now(), now())
ON CONFLICT (site_id, production_date) DO UPDATE
  SET stripped_program     = EXCLUDED.stripped_program,
      stripped_non_program = EXCLUDED.stripped_non_program,
      updated_at           = now()
  WHERE processed_units_daily.source = 'mymrc'
    AND processed_units_daily.closed_at IS NULL
    AND ( processed_units_daily.stripped_program     IS DISTINCT FROM EXCLUDED.stripped_program
       OR processed_units_daily.stripped_non_program IS DISTINCT FROM EXCLUDED.stripped_non_program )
RETURNING id, (xmax = 0) AS inserted
`;

/**
 * Bridge `mymrc_processed_mirror` → `processed_units_daily`, aggregated per
 * (site, day). Idempotent + precedence-guarded (see module header). Never writes an
 * operational table other than `processed_units_daily`; never touches a human row.
 */
export async function bridgeProcessedToInventory(
  ctx: ProcessedBridgeContext,
): Promise<ProcessedBridgeResult> {
  const log = ctx.log ?? ((): void => undefined);
  const { prisma } = ctx;
  const dryRun = ctx.dryRun === true;
  const sinceIso = ctx.sinceProductionDate ? productionDayIso(ctx.sinceProductionDate) : null;

  // 1. Pull the active Processing mirror rows (the 2 stray type/site-NULL rows are
  //    excluded by the filter). `program_unit_count`/`non_program_unit_count`/`units`
  //    carry the split; `processed_date::date` is the day key.
  const mirrorRows = (await prisma.mymrcProcessedMirror.findMany({
    where: {
      type: 'Processing',
      disappeared_at: null,
      site_id: { not: null },
      processed_date:
        ctx.sinceProductionDate != null
          ? { not: null, gte: ctx.sinceProductionDate }
          : { not: null },
      ...(ctx.siteIds && ctx.siteIds.length > 0 ? { site_id: { in: ctx.siteIds } } : {}),
    },
    select: {
      site_id: true,
      processed_date: true,
      program_unit_count: true,
      non_program_unit_count: true,
      units: true,
    },
  })) as MirrorProcessedRow[];

  // 2. Aggregate (SUM) per (site, day). The CASE prefers the explicit split when
  //    present (always, today) and falls back to legacy `units` as program-only when
  //    program_unit_count is null — the two branches are mutually exclusive, so this
  //    can never double-count.
  const byKey = new Map<string, DayAggregate>();
  for (const r of mirrorRows) {
    if (r.site_id == null || r.processed_date == null) continue; // belt-and-suspenders
    const iso = productionDayIso(r.processed_date);
    // Exact re-filter on the derived production day (defends against any hypothetical
    // non-noon row that the coarse `processed_date >= since` prefilter let through).
    if (sinceIso != null && iso < sinceIso) continue;
    const hasSplit = r.program_unit_count != null;
    const program = hasSplit ? (r.program_unit_count as number) : (r.units ?? 0);
    const nonProgram = hasSplit ? (r.non_program_unit_count ?? 0) : 0;
    const key = `${r.site_id}|${iso}`;
    const agg = byKey.get(key) ?? { siteId: r.site_id, iso, program: 0, nonProgram: 0 };
    agg.program += program;
    agg.nonProgram += nonProgram;
    byKey.set(key, agg);
  }

  const aggregates = [...byKey.values()];
  const result: ProcessedBridgeResult = {
    daysConsidered: aggregates.length,
    inserted: 0,
    updated: 0,
    skippedGuarded: 0,
    unchanged: 0,
  };
  if (aggregates.length === 0) {
    log('info', `processed-bridge: no mirror rows to bridge${sinceIso ? ` (since ${sinceIso})` : ''}`);
    return result;
  }

  // 3. Preload the existing rows for exactly the candidate (site, day) set — ONE
  //    query — so the JS pre-check can classify skippedGuarded / unchanged
  //    deterministically (the SQL guard remains the authoritative race backstop).
  const siteIds = [...new Set(aggregates.map((a) => a.siteId))];
  const productionDates = [...new Set(aggregates.map((a) => a.iso))].map(dayKeyUtc);
  const existingRows = (await prisma.processedUnitsDaily.findMany({
    where: { site_id: { in: siteIds }, production_date: { in: productionDates } },
    select: {
      site_id: true,
      production_date: true,
      source: true,
      closed_at: true,
      stripped_program: true,
      stripped_non_program: true,
    },
  })) as ExistingProcessedRow[];
  const existingByKey = new Map<string, ExistingProcessedRow>();
  for (const e of existingRows) {
    existingByKey.set(`${e.site_id}|${productionDayIso(e.production_date)}`, e);
  }

  // 4. Per affected day: pre-check precedence, then the guarded upsert + audit in a
  //    per-day transaction.
  for (const agg of aggregates) {
    const existing = existingByKey.get(`${agg.siteId}|${agg.iso}`);

    // PRECEDENCE: never touch a manual/import row or a closed day.
    if (existing && (existing.source !== 'mymrc' || existing.closed_at !== null)) {
      result.skippedGuarded += 1;
      continue;
    }
    // UNCHANGED: a mymrc, non-closed row already holding these exact values.
    if (
      existing &&
      toNumber(existing.stripped_program) === agg.program &&
      toNumber(existing.stripped_non_program) === agg.nonProgram
    ) {
      result.unchanged += 1;
      continue;
    }
    if (dryRun) {
      if (existing) result.updated += 1;
      else result.inserted += 1;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        UPSERT_SQL,
        randomUUID(),
        agg.siteId,
        agg.iso,
        agg.program,
        agg.nonProgram,
      )) as Array<{ id: string; inserted: boolean }>;

      // 0 rows ⇒ the WHERE guard blocked the write. Given the pre-check already
      // excluded the known guarded/unchanged cases, reaching here with 0 rows means
      // the row changed ownership/values UNDER us (a manager close, or a concurrent
      // identical mymrc write, landed between preload and this statement). Either
      // way we did NOT write and must NOT audit — the guard held. Count it as
      // guarded (a human row was protected) rather than as a phantom write.
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
          actor_label: 'mymrc-processed-bridge',
          action: rec.inserted ? 'insert' : 'update',
          table_name: 'processed_units_daily',
          row_id: rec.id,
          after: {
            production_date: agg.iso,
            stripped_program: agg.program,
            stripped_non_program: agg.nonProgram,
            source: 'mymrc',
          },
        },
      });
    });
  }

  log(
    'info',
    `processed-bridge${dryRun ? ' (dry-run)' : ''}: days=${result.daysConsidered} ` +
      `ins=${result.inserted} upd=${result.updated} skip=${result.skippedGuarded} same=${result.unchanged}`,
  );
  return result;
}
