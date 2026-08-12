// Idempotent upsert of scraped MyMRC hauls into `expected_loads`.
//
// Match key per ADR-0009 + `prisma/schema.prisma`:
//
//   `external_mymrc_haul_id` is `@unique` across the whole table.
//
// MyMRC haul IDs are globally unique (one MRC tenant, monotonic
// sequence) so the (site, haul_id) combo collapses to (haul_id) for
// matching purposes. We still pass `site_id` on insert to satisfy the
// FK + the per-site separation rule (CLAUDE.md hard rule #2).
//
// Source / transporter resolution:
//   - source_name resolved against `sources(name)` scoped by site_id;
//     a name that misses the verbatim map gets a second chance against the
//     site's `source_aliases` + canonical names, normalized (trim/lowercase/
//     collapse-whitespace) — ADR-0037 amendment (rollup §12): MyMRC/workbook
//     customer names drift month-to-month ('SVDP Albany', 'SvdP Albany',
//     'Albany'...), and the OR sources were renamed to canonical MyMRC names
//     with the old live names kept as aliases. Unmatched names persist
//     `source_id = null` + `source_name_at_sync` so a future seed/alias
//     update can backfill the FK without losing data. NEVER guessed.
//   - transporter_name resolved against `transporters(name)` (global,
//     per the schema's `@unique` on name); unmatched persists null.
//
// Stale-haul cleanup (ADR-0009 + T-015 acceptance):
//   - For each site, we identify previously-scraped, currently-active
//     (`cancelled_at IS NULL`) rows whose `external_mymrc_haul_id` is
//     NOT in the latest scrape.
//   - Those rows are NOT deleted — they're flagged with `cancelled_at =
//     now`. Audit trail preserved (CLAUDE.md hard rule #6 spirit) and
//     downstream T-016 reconciliation can still see what we expected.
//   - Cancellation is scoped to rows that fell within the same window
//     the scrape covered (next 7 days from today). A row whose expected
//     date is in the past or > 7d in the future is left alone — the
//     scrape didn't claim authority over those windows.
//
// Audit log: every insert/update/cancel writes one `audit_log` row with
// `actor_label = 'system:mymrc-scrape'` (per the existing audit
// `actor_label` convention used by the migrate wrapper et al.).

import { Prisma, type AuditAction, type PrismaClient } from '@prisma/client';
import type { ScrapedHaul, SiteCode } from './types';
import type { Logger } from './sync';

const SCRAPE_WINDOW_DAYS = 7;
const ACTOR_LABEL = 'system:mymrc-scrape';

/**
 * ADR-0099 — how many CONSECUTIVE scrapes must miss a haul before it is retired.
 *
 * ## Why three, and why this number is not a guess
 *
 * The cron runs hourly on the hour (`scripts/mymrc-cron.mjs` → `msUntilNextHour`),
 * so three consecutive misses means the haul has been absent from the portal for
 * at least ~2 hours of wall clock.
 *
 * Measured against every auto-cancellation in production history at 2026-08-11
 * 22:04 PT (n=69), bucketed by how long until a later scrape un-cancelled the
 * same row:
 *
 *     next scrape (<=70m)   30      <- one miss. Eliminated by N=2.
 *     70m - 3h               2      <- eliminated by N=3.
 *     >24h                  35      <- median 46h. NOT eliminable by any N.
 *     never restored         2      <- the only genuine retirements.
 *
 * The distribution is cleanly bimodal, and N=3 sits in the gap. It removes
 * **32 of 69 cancellations (46%)** — every one that resolved inside a day —
 * while leaving the >24h population untouched, which is correct: a haul absent
 * for two days really has been withdrawn, and cancelling it is the right answer.
 *
 * N=2 would remove 30 of those 32. The extra hour buys the 70m–3h pair and a
 * margin against a single skipped or slow run, and costs at most ~2 extra hours
 * of a stale row remaining VISIBLE — which is the safe direction, because the
 * failure this exists to prevent is a truck on the dock with no row to tap.
 *
 * Re-derive this from `audit_log` before changing it; the query is in ADR-0099.
 */
const CANCEL_AFTER_CONSECUTIVE_MISSES = 3;

// Scrape-ownership marker (source=manual protection — ADR-0038 D2, mission §8).
// Real MyMRC haul ids are "H-<digits>"; the stale-cancel sweep may only cancel
// rows it owns (a MyMRC haul that dropped off the feed). Operator/manual expected
// loads use a non-"H-" id (e.g. "MANUAL-…") and are NEVER auto-cancelled by a
// scrape — Janette's manual morning entries must never be clobbered.
const MYMRC_OWNED_HAUL_ID = /^H-/i;

export interface UpsertSummary {
  inserted: number;
  updated: number;
  cancelled: number;
  /** Per-haul occurrences with no matching `sources` row (a repeated name counts each time). */
  unmatched_source_count: number;
  /** Per-haul occurrences with no matching `transporters` row. */
  unmatched_transporter_count: number;
  /** DEDUPED list of the unmatched source names (drives the once-per-run warn + operator seed fix). */
  unmatched_source_names: string[];
  /** DEDUPED list of the unmatched transporter names. */
  unmatched_transporter_names: string[];
  /**
   * DEDUPED raw names that resolved via `source_aliases` (normalized match)
   * rather than the verbatim `sources.name` map — visibility into name drift
   * (rollup §12). These ARE matched (source_id set); not an error signal.
   */
  alias_resolved_source_names: string[];
}

export interface UpsertContext {
  prisma: PrismaClient;
  site: SiteCode;
  hauls: readonly ScrapedHaul[];
  scrapedAt: Date;
  /** Test seam — defaults to `Date.now()` when caller omits. */
  now?: Date;
  /** Optional structured logger — used to warn (once per run) about unmatched names. */
  log?: Logger;
}

/**
 * Apply a single per-site scrape result to the database. Idempotent:
 * re-running with the same hauls produces the same end state and emits
 * zero net changes.
 *
 * @throws when the site code does not resolve to a Site row, or when
 *   the underlying DB operation fails. Caller (cron wrapper) catches
 *   and routes to ntfy.
 */
export async function upsertScrapedHauls(ctx: UpsertContext): Promise<UpsertSummary> {
  const now = ctx.now ?? new Date();
  const site = await ctx.prisma.site.findUnique({
    where: { code: ctx.site },
    select: { id: true },
  });
  if (!site) {
    throw new Error(`mymrc-upsert: site code "${ctx.site}" not found in sites table`);
  }
  const siteId = site.id;

  // Pre-resolve source + transporter FKs in two queries (one per
  // table) to avoid an N+1 across the haul list.
  const sourceNames = [...new Set(ctx.hauls.map((h) => h.source_name))];
  const transporterNames = [
    ...new Set(ctx.hauls.map((h) => h.transporter_name).filter((n): n is string => n !== null)),
  ];
  const [sourceRows, transporterRows] = await Promise.all([
    sourceNames.length > 0
      ? ctx.prisma.source.findMany({
          where: { site_id: siteId, name: { in: sourceNames } },
          select: { id: true, name: true },
        })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    transporterNames.length > 0
      ? ctx.prisma.transporter.findMany({
          where: { name: { in: transporterNames } },
          select: { id: true, name: true },
        })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ]);
  const sourceByName = new Map(sourceRows.map((r) => [r.name, r.id]));
  const transporterByName = new Map(transporterRows.map((r) => [r.name, r.id]));

  // Alias fallback (rollup §12) — built ONLY when at least one scraped name
  // missed the verbatim map. One extra site-scoped query: every source + its
  // source_aliases rows, indexed by normalized name. Aliases first, canonical
  // names overlaid, so a canonical name wins a normalized-key collision
  // (mirrors src/lib/audit/workbook/site-alias.ts, which this module cannot
  // import — tsconfig.mymrc.json compiles src/lib/mymrc standalone).
  let sourceByNormalized: Map<string, string> | null = null;
  if (sourceNames.some((n) => !sourceByName.has(n))) {
    const allSiteSources = await ctx.prisma.source.findMany({
      where: { site_id: siteId },
      select: { id: true, name: true, aliases: { select: { alias: true } } },
    });
    const idx = new Map<string, string>();
    for (const s of allSiteSources) {
      for (const a of s.aliases ?? []) idx.set(normalizeSourceName(a.alias), s.id);
    }
    for (const s of allSiteSources) idx.set(normalizeSourceName(s.name), s.id);
    sourceByNormalized = idx;
  }

  // Batch-load every existing expected_loads row for the scraped haul ids in ONE
  // query (kills the per-haul findUnique N+1). Keyed by external_mymrc_haul_id;
  // the map is kept live below (re-insert after a create) so a duplicated id in a
  // single batch behaves exactly like the old per-iteration findUnique.
  const haulIds = ctx.hauls.map((h) => h.external_mymrc_haul_id);
  const existingRows =
    haulIds.length > 0
      ? await ctx.prisma.expectedLoad.findMany({
          where: { external_mymrc_haul_id: { in: haulIds } },
          select: {
            id: true,
            site_id: true,
            external_mymrc_haul_id: true,
            expected_arrival_at: true,
            source_id: true,
            source_name_at_sync: true,
            transporter_id: true,
            transporter_name_at_sync: true,
            expected_unit_count: true,
            bol_number: true,
            scheduled_at_mymrc: true,
            cancelled_at: true,
          },
        })
      : [];
  const existingByHaulId = new Map(existingRows.map((r) => [r.external_mymrc_haul_id, r]));

  let inserted = 0;
  let updated = 0;
  let cancelled = 0;
  let unmatchedSources = 0;
  let unmatchedTransporters = 0;
  const unmatchedSourceNames = new Set<string>();
  const unmatchedTransporterNames = new Set<string>();
  const aliasResolvedSourceNames = new Set<string>();

  for (const haul of ctx.hauls) {
    let sourceId = sourceByName.get(haul.source_name) ?? null;
    if (sourceId === null && sourceByNormalized !== null) {
      const viaAlias = sourceByNormalized.get(normalizeSourceName(haul.source_name)) ?? null;
      if (viaAlias !== null) {
        sourceId = viaAlias;
        aliasResolvedSourceNames.add(haul.source_name);
      }
    }
    if (sourceId === null) {
      unmatchedSources += 1;
      unmatchedSourceNames.add(haul.source_name);
    }
    const transporterId = haul.transporter_name
      ? (transporterByName.get(haul.transporter_name) ?? null)
      : null;
    if (haul.transporter_name && transporterId === null) {
      unmatchedTransporters += 1;
      unmatchedTransporterNames.add(haul.transporter_name);
    }

    const existing = existingByHaulId.get(haul.external_mymrc_haul_id) ?? null;

    const nextData = {
      site_id: siteId,
      external_mymrc_haul_id: haul.external_mymrc_haul_id,
      expected_arrival_at: haul.expected_arrival_at,
      source_id: sourceId,
      source_name_at_sync: haul.source_name,
      transporter_id: transporterId,
      transporter_name_at_sync: haul.transporter_name,
      expected_unit_count: haul.expected_unit_count,
      bol_number: haul.bol_number,
      scheduled_at_mymrc: haul.scheduled_at_mymrc,
      last_synced_at: ctx.scrapedAt,
      // Re-appearing haul → un-cancel. MyMRC sometimes drops then
      // re-adds a haul during operator edits; preserve the row identity.
      //
      // ADR-0099 — this un-cancel ALREADY WORKED, and measuring it is what
      // produced the threshold below: 67 of 69 auto-cancellations were undone
      // here by a later pass. So the resurrection path is not new, it is the
      // evidence. What is new is the streak reset: a haul present in THIS pass
      // has a miss streak of zero by definition, and without the reset the
      // count would be cumulative rather than consecutive — three scattered
      // misses over three weeks would retire a haul that appeared in the ninety
      // passes between them.
      cancelled_at: null,
      missed_scrape_count: 0,
      first_missed_at: null,
    };

    if (!existing) {
      const row = await ctx.prisma.expectedLoad.create({ data: nextData });
      inserted += 1;
      // Keep the batch map live so a duplicated id later in THIS scrape resolves
      // to the row we just created (mirrors the old per-haul findUnique exactly).
      existingByHaulId.set(haul.external_mymrc_haul_id, {
        id: row.id,
        site_id: siteId,
        external_mymrc_haul_id: haul.external_mymrc_haul_id,
        expected_arrival_at: nextData.expected_arrival_at,
        source_id: nextData.source_id,
        source_name_at_sync: nextData.source_name_at_sync,
        transporter_id: nextData.transporter_id,
        transporter_name_at_sync: nextData.transporter_name_at_sync,
        expected_unit_count: nextData.expected_unit_count,
        bol_number: nextData.bol_number,
        scheduled_at_mymrc: nextData.scheduled_at_mymrc,
        cancelled_at: null,
      });
      await writeAudit(ctx.prisma, {
        actor_label: ACTOR_LABEL,
        action: 'insert',
        table_name: 'expected_loads',
        row_id: row.id,
        before: null,
        after: nextData,
      });
      continue;
    }

    if (!hasMaterialChange(existing, nextData)) {
      // Touch last_synced_at without writing an audit row — pure
      // freshness signal, not a value change.
      await ctx.prisma.expectedLoad.update({
        where: { id: existing.id },
        // ADR-0099 — the streak reset rides the freshness touch too. This is the
        // path taken by an UNCHANGED haul, which is the overwhelmingly common
        // case: without it, a haul that is present every hour but never edited
        // would keep whatever streak a single earlier miss left behind, and the
        // count would stop meaning "consecutive".
        data: {
          last_synced_at: ctx.scrapedAt,
          cancelled_at: null,
          missed_scrape_count: 0,
          first_missed_at: null,
        },
      });
      continue;
    }

    const updatedRow = await ctx.prisma.expectedLoad.update({
      where: { id: existing.id },
      data: nextData,
    });
    updated += 1;
    await writeAudit(ctx.prisma, {
      actor_label: ACTOR_LABEL,
      action: 'update',
      table_name: 'expected_loads',
      row_id: updatedRow.id,
      before: existing,
      after: nextData,
    });
  }

  // ── Stale-haul cancellation (ADR-0099) ──────────────────────────────────
  //
  // Scrape window is "today through +7 days" (matches the runbook); only rows
  // whose expected arrival falls in that window AND are absent from the latest
  // scrape are candidates. Past-arrival rows are owned by the load workflow.
  //
  // WHAT CHANGED: this used to cancel on ONE missing pass. It now requires
  // `CANCEL_AFTER_CONSECUTIVE_MISSES` of them. The comment two blocks up has
  // always said the input is unreliable — "MyMRC sometimes drops then re-adds a
  // haul during operator edits" — and production proved how unreliable at
  // 2026-08-11 22:04 PT: 69 auto-cancellations, **67 later un-cancelled by a
  // subsequent scrape**, 30 of them by the very next hourly pass. Two were
  // genuine. The sweep was flapping, and each flap hid a slot from the queue
  // (`cancelled_at: null` filter) and reduced its hauls card to "View only" —
  // 16 of those firings landed BEFORE the appointment, while the truck could
  // still turn up.
  const windowStart = startOfPacificDay(now);
  const windowEnd = new Date(windowStart.getTime() + SCRAPE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const scrapedIds = new Set(ctx.hauls.map((h) => h.external_mymrc_haul_id));

  // FENCE: a scrape that saw NOTHING must never retire everything.
  //
  // `sync.ts` has a zero-anomaly gate on the LIST pass, and `markDisappeared`
  // runs only on a proven-complete list — but neither guards THIS function,
  // which is fed from the mirror by `feedExpectedLoads` and can legitimately be
  // reached with an empty array if the mirror query returns nothing for a site.
  // With a one-miss rule that was a whole-site wipe on a single bad read; with a
  // three-miss rule it is a whole-site wipe after three. Cheaper to state the
  // invariant than to rely on two callers upstream continuing to hold.
  if (ctx.hauls.length === 0) {
    ctx.log?.(
      'warn',
      `mymrc-upsert: ${ctx.site} — 0 hauls in this pass; stale-cancel sweep SKIPPED (a pass that saw nothing cannot prove anything is gone)`,
    );
  } else {
    const stale = await ctx.prisma.expectedLoad.findMany({
      where: {
        site_id: siteId,
        cancelled_at: null,
        expected_arrival_at: { gte: windowStart, lte: windowEnd },
      },
      select: {
        id: true,
        external_mymrc_haul_id: true,
        cancelled_at: true,
        missed_scrape_count: true,
        first_missed_at: true,
      },
    });
    for (const row of stale) {
      if (scrapedIds.has(row.external_mymrc_haul_id)) continue;
      // Never cancel a manually-entered row (source=manual protection).
      if (!MYMRC_OWNED_HAUL_ID.test(row.external_mymrc_haul_id)) continue;

      const misses = row.missed_scrape_count + 1;
      const firstMissedAt = row.first_missed_at ?? now;

      if (misses < CANCEL_AFTER_CONSECUTIVE_MISSES) {
        // Count it and leave it ALIVE. No audit row: a miss is not a change to
        // the haul, it is a fact about this pass, and `audit_log` is append-only
        // and retained indefinitely (hard rule #6) — writing one per miss per
        // row per hour would bury the cancellations that matter in noise.
        await ctx.prisma.expectedLoad.update({
          where: { id: row.id },
          data: { missed_scrape_count: misses, first_missed_at: firstMissedAt },
        });
        continue;
      }

      await ctx.prisma.expectedLoad.update({
        where: { id: row.id },
        data: { cancelled_at: now, missed_scrape_count: misses, first_missed_at: firstMissedAt },
      });
      cancelled += 1;
      await writeAudit(ctx.prisma, {
        actor_label: ACTOR_LABEL,
        action: 'soft_delete',
        table_name: 'expected_loads',
        row_id: row.id,
        before: { cancelled_at: null, missed_scrape_count: row.missed_scrape_count },
        after: {
          cancelled_at: now,
          // ADR-0099 — the evidence the cancellation was earned, carried on the
          // audit row so "was three the right number?" is answerable from the
          // ledger rather than from an argument.
          missed_scrape_count: misses,
          first_missed_at: firstMissedAt,
        },
      });
    }
  }

  // One warn per run naming the deduped unmatched names — an unmatched name means
  // a `sources`/`transporters` seed row is missing, so the FK stays null and the
  // load is unattributed until an operator adds the seed. Counts alone hid WHICH
  // name; the names are the actionable signal.
  const sourceNamesList = [...unmatchedSourceNames];
  const transporterNamesList = [...unmatchedTransporterNames];
  const aliasResolvedList = [...aliasResolvedSourceNames];
  if (ctx.log && aliasResolvedList.length > 0) {
    ctx.log(
      'info',
      `mymrc-upsert: ${ctx.site} — ${aliasResolvedList.length} source name(s) resolved via source_aliases (name drift, FK set): ${aliasResolvedList.join(', ')}`,
    );
  }
  if (ctx.log && sourceNamesList.length > 0) {
    ctx.log(
      'warn',
      `mymrc-upsert: ${ctx.site} — ${sourceNamesList.length} unmatched source name(s) (source_id=null, name_at_sync retained): ${sourceNamesList.join(', ')}`,
    );
  }
  if (ctx.log && transporterNamesList.length > 0) {
    ctx.log(
      'warn',
      `mymrc-upsert: ${ctx.site} — ${transporterNamesList.length} unmatched transporter name(s): ${transporterNamesList.join(', ')}`,
    );
  }

  return {
    inserted,
    updated,
    cancelled,
    unmatched_source_count: unmatchedSources,
    unmatched_transporter_count: unmatchedTransporters,
    unmatched_source_names: sourceNamesList,
    unmatched_transporter_names: transporterNamesList,
    alias_resolved_source_names: aliasResolvedList,
  };
}

/**
 * Normalization for the alias fallback — trim, lowercase, collapse internal
 * whitespace. MUST stay in lock-step with `normalizeName` in
 * `src/lib/audit/workbook/site-alias.ts` (not importable here; see the
 * tsconfig.mymrc.json standalone-compilation note above `writeAudit`).
 */
function normalizeSourceName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

interface ExistingRow {
  expected_arrival_at: Date;
  source_id: string | null;
  source_name_at_sync: string;
  transporter_id: string | null;
  transporter_name_at_sync: string | null;
  expected_unit_count: number | null;
  bol_number: string | null;
  scheduled_at_mymrc: Date | null;
  cancelled_at: Date | null;
}

interface NextRow {
  expected_arrival_at: Date;
  source_id: string | null;
  source_name_at_sync: string;
  transporter_id: string | null;
  transporter_name_at_sync: string | null;
  expected_unit_count: number | null;
  bol_number: string | null;
  scheduled_at_mymrc: Date | null;
  cancelled_at: Date | null;
}

function hasMaterialChange(existing: ExistingRow, next: NextRow): boolean {
  if (existing.expected_arrival_at.getTime() !== next.expected_arrival_at.getTime()) return true;
  if ((existing.source_id ?? null) !== (next.source_id ?? null)) return true;
  if ((existing.source_name_at_sync ?? null) !== (next.source_name_at_sync ?? null)) return true;
  if ((existing.transporter_id ?? null) !== (next.transporter_id ?? null)) return true;
  if ((existing.transporter_name_at_sync ?? null) !== (next.transporter_name_at_sync ?? null))
    return true;
  if ((existing.expected_unit_count ?? null) !== (next.expected_unit_count ?? null)) return true;
  if ((existing.bol_number ?? null) !== (next.bol_number ?? null)) return true;
  const exScheduled = existing.scheduled_at_mymrc?.getTime() ?? null;
  const nxScheduled = next.scheduled_at_mymrc?.getTime() ?? null;
  if (exScheduled !== nxScheduled) return true;
  if (existing.cancelled_at !== null && next.cancelled_at === null) return true;
  return false;
}

/**
 * Midnight at the start of the current PACIFIC day, as a true instant.
 *
 * ## Why this replaced `startOfUtcDay` (ADR-0099, audit D-2 secondary defect)
 *
 * The sweep bounded its window on `startOfUtcDay(now)` while every READ surface
 * bounds on the Pacific day (`currentPacificDayWindow` in `@/lib/time`). Between
 * 17:00 PT and Pacific midnight the UTC day has already rolled, so the sweep's
 * "today" was the operator's TOMORROW — and the window's lower edge had walked
 * past the slots still on the queue. That is the exact UTC/Pacific class ADR-0065
 * was written to eliminate, still live in the write path a month later.
 *
 * ## Why it is duplicated instead of imported
 *
 * `src/lib/mymrc` compiles standalone via `tsconfig.mymrc.json`, whose rootDir
 * forbids importing from above it — the same constraint that already forces the
 * local `writeAudit` above and `header-safe.ts` beside this file. The read-side
 * helper stays authoritative; this one must agree with it.
 *
 * DST-correct in both directions because the offset is asked of `Intl` for the
 * instant in question rather than assumed: `en-CA` yields `YYYY-MM-DD`, and
 * re-parsing that day at the zone's own offset gives the true midnight instant.
 * The fall-back ambiguity (two 01:00s on 2026-11-01) cannot produce a zero-width
 * or inverted window here, because only the START of the day is derived and the
 * end is a fixed +7d offset from it.
 */
const PACIFIC_TZ = 'America/Los_Angeles';

export function startOfPacificDay(d: Date): Date {
  // The Pacific calendar day `d` falls on. `en-CA` is the locale that yields
  // `YYYY-MM-DD` rather than a US-ordered date.
  const dayISO = new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC_TZ }).format(d);

  // The zone's UTC offset ON THAT DAY, read rather than assumed. Probed at noon
  // UTC so the probe itself can never land on a 01:00–03:00 DST transition.
  const probe = new Date(`${dayISO}T12:00:00Z`);
  const localHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: PACIFIC_TZ,
      hour: 'numeric',
      hour12: false,
    })
      .formatToParts(probe)
      .find((x) => x.type === 'hour')?.value ?? '12',
  );
  // Pacific is BEHIND UTC, so 12:00Z reads as 05:00 (PDT) or 04:00 (PST) and the
  // offset is 7 or 8. Midnight Pacific is therefore that many hours AFTER the
  // day's 00:00Z.
  const offsetHours = 12 - localHour;
  return new Date(new Date(`${dayISO}T00:00:00Z`).getTime() + offsetHours * 3_600_000);
}

// Local audit writer — accepts the caller's PrismaClient so the cron
// worker doesn't have to share the singleton from `src/lib/prisma.ts`
// (which the in-app code uses). Mirrors the shape of the canonical
// `writeAudit` in `src/lib/audit.ts`; the duplication here is
// intentional so this module compiles standalone via
// `tsconfig.mymrc.json` without dragging the `@/` path alias into the
// cron-worker bundle.
interface AuditArgs {
  actor_user_id?: string | null;
  actor_label?: string | null;
  action: AuditAction;
  table_name: string;
  row_id: string;
  before?: unknown;
  after?: unknown;
}

async function writeAudit(client: PrismaClient, args: AuditArgs): Promise<void> {
  await client.auditLog.create({
    data: {
      actor_user_id: args.actor_user_id ?? null,
      actor_label: args.actor_label ?? null,
      action: args.action,
      table_name: args.table_name,
      row_id: args.row_id,
      before:
        args.before === undefined
          ? Prisma.JsonNull
          : (JSON.parse(JSON.stringify(args.before)) as Prisma.InputJsonValue),
      after:
        args.after === undefined
          ? Prisma.JsonNull
          : (JSON.parse(JSON.stringify(args.after)) as Prisma.InputJsonValue),
    },
  });
}
