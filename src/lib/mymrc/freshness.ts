// Mirror freshness — the guard that catches a bridge that has stopped moving
// (2026-07-31).
//
// WHY THIS EXISTS. From 2026-07-22 to 2026-07-31 the processed/outbound mirrors
// did not gain a single row, while every hourly run wrote `status='ok'` to
// `mymrc_sync_runs`. Nothing in the system noticed for 9 days. Every existing
// guard was blind to it BY CONSTRUCTION:
//   • the zero-anomaly guard fires on 0 listed — the runs listed 50.
//   • the deadman fires when no run SUCCEEDS in 26h — the runs all succeeded.
//   • the windowed-list warn fires on `hasMoreData` — it fired every hour, and
//     `hasMoreData:true` is a normal state for a large view, so it said nothing.
// Every one of those measures the SCRAPER. None measures the only thing that
// matters: whether what we hold is CURRENT with the source.
//
// So this module measures the mirror itself. It is deliberately independent of
// run status, listed counts, and detail counts — a run can do everything right
// and still leave a stale mirror, and a run can look idle during a genuinely
// quiet hour. Only the age of the newest business record separates those.
//
// GRADING (ADR-0037 five-question gate):
//   1. Actionable in 5 min?      yes — run the bounded catch-up (docs/operator).
//   2. Customer-visible?         no — internal reconciliation input. NOT urgent.
//   3. Self-healed first?        yes — the newest-first sync closes ordinary
//                                gaps hourly; this fires only after `maxAge`.
//   4. Deduplicated?             one fingerprint per site+feed, 24h cooldown.
//   5. Useful click?             tier-2, the MyMRC ingestion admin surface.
//   ⇒ priority `high`, at most one page per site+feed per day.
//
// Bundle constraint: compiles standalone via tsconfig.mymrc.json — no `@/…`.

import type { PrismaClient } from '@prisma/client';
import { businessDaysBetween, pacificDayISO } from './business-days';
import { GRADE_BY_KIND, type Pager } from './ntfy';
import type { FeedName, SiteCode } from './types';

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: Logger = () => undefined;

/**
 * How far behind the newest mirrored record may fall before the mirror is stale,
 * in BUSINESS DAYS (ADR-0130 D6).
 *
 * This was `DEFAULT_MAX_AGE_MS = 96h`, justified as "96h clears a normal weekend
 * plus a holiday Monday without firing." Measured against the live mirror over
 * 2026-07-31 -> 2026-09-07, it does not. The `processed` feed carries exactly ONE
 * row per business day, day D lands at D+1 (D+3 across a weekend) and `entry_date`
 * is noon-anchored, so an ordinary Monday peaks at 83-99 h against a 96 h line.
 * Whether Bill's phone rang on a given Monday was decided by what time on Saturday
 * MyMRC posted Friday's row: THREE false pages in thirty-eight days against one
 * true one. That is a units problem, not a tuning problem.
 *
 * Replayed hour-by-hour against production `first_seen_at` over the same 38 days,
 * ">2 business days" fires exactly ONCE — on the real nine-day freeze — and it is
 * also FASTER on a real freeze: three business days behind is reached on the Friday
 * of a Wednesday freeze, where 96 h waits for the fourth calendar day.
 */
export const DEFAULT_MAX_BUSINESS_DAYS = 2;

/**
 * At or beyond this many business days behind, the page escalates from `default`
 * to `high` (ADR-0130 §6). Nine business days was the real outage; three is a long
 * weekend plus a slow Monday and does not deserve a `high`.
 */
export const ESCALATE_BUSINESS_DAYS = 5;

/**
 * Page at most once per site+feed per day (ADR-0037 Q4).
 *
 * DERIVED from the ADR-0130 §6 grading matrix rather than restated, so the
 * threshold cannot drift away from the grade the ADR records. Before ADR-0130 this
 * number was nominal: the cooldown lived in a per-process `Map` and this module is
 * called from a worker that is a FRESH PROCESS every hour, so 24 h suppressed
 * nothing and this alert paged Bill 24x/day for four days.
 */
export const FRESHNESS_COOLDOWN_MS = GRADE_BY_KIND.stale_mirror.cooldownMs;

/**
 * The BUSINESS date each feed is measured on — the date the source assigns to
 * the record, never a column we write (`detail_fetched_at`/`last_seen_at` all
 * refresh when we re-read a record we already hold, so they stay green while the
 * mirror rots — that is precisely how this went unnoticed for 9 days).
 *
 * CORRECTED 2026-07-31. This block used to read: "`hauls` is measured on the
 * docking appointment, which is normally FUTURE-dated; a healthy hauls feed
 * therefore reports a negative age and can never be stale. When the feed stops,
 * the newest appointment recedes into the past and crosses the threshold on its
 * own."
 *
 * **That reasoning was wrong, and it is why the guard could not see the outage it
 * was written for.** The appointment only recedes if the whole feed stops. What
 * actually happened is that the DELIVERED half froze on 2026-07-22 while the
 * SCHEDULED half kept refreshing — and scheduled appointments are dated into the
 * future forever. Measured live mid-outage: max over all hauls = 2026-08-10 (age
 * -9 days, "healthy"); max over DELIVERED = 2026-07-21 (age +10 days, stale).
 *
 * The hauls feeds are therefore measured on DELIVERED hauls only. That is also
 * the status that matters: `inbound_loads` is bridged from delivered hauls, so a
 * frozen delivered feed is what drives the floor negative.
 */
// ADR-0089 D3 (2026-08-10) — the hauls feeds moved off the bare appointment date.
// The appointment is a SCHEDULING field: null on every collection-network haul
// (45% of the mirror) and up to a week from the true delivery even when present.
// The bridge keys inbound on COALESCE(recycler_reported_delivery_date,
// docking_appointment_date); a guard that measures a different column than the
// bridge keys on certifies a feed it cannot see — the ADR-0070 lesson one level
// down (we fixed which ROWS we measure, then had to fix which COLUMN).
export const FRESHNESS_COLUMN: Readonly<Record<FeedName, string>> = {
  hauls: 'coalesce(recycler_reported_delivery_date, docking_appointment_date)',
  haulsCompleted: 'coalesce(recycler_reported_delivery_date, docking_appointment_date)',
  processed: 'entry_date',
  outbound: 'entry_date',
};

export interface FeedFreshness {
  feed: FeedName;
  /** Newest business date held for this feed, or null when the mirror is empty. */
  newest: Date | null;
  /**
   * How far behind `now` that date is, in ms. Negative for future-dated feeds.
   * RETAINED for the operator-facing message and for diagnosis — it is no longer
   * what decides staleness (ADR-0130 D6). Reporting the calendar age next to the
   * business-day count is what lets a reader see "105 h, but one business day".
   */
  ageMs: number | null;
  /**
   * Business days between the newest record's day and today (exclusive of the
   * record's own day, inclusive of today). Null when the mirror is empty. THIS is
   * the number the threshold is applied to.
   */
  businessDaysBehind: number | null;
  stale: boolean;
}

/** Newest business date held for one feed. Concrete Prisma types stay in here. */
async function newestBusinessDate(prisma: PrismaClient, feed: FeedName): Promise<Date | null> {
  if (feed === 'hauls') {
    // ── 2026-07-31: measure DELIVERED hauls, not every haul ──────────────────
    // This guard shipped on 2026-07-30 measuring `max(docking_appointment_date)`
    // across the WHOLE mirror, and it could not have caught the outage it was
    // written for. A haul is `Confirmed` when it is SCHEDULED, and confirmed
    // appointments are dated into the FUTURE — on the day this was found the
    // mirror's overall max was 2026-08-10 while the newest DELIVERED haul was
    // 2026-07-21, nine days stale. The guard read healthy throughout, and would
    // have read healthy forever: future-dated scheduling permanently masks a
    // frozen delivered feed.
    //
    // Delivered is also the status that MATTERS: `inbound_loads` is bridged from
    // delivered hauls, so a frozen delivered feed is exactly what drives the
    // floor negative. Scheduling activity is not evidence anything arrived.
    // ADR-0089 D3 — the SAME key the inbound bridge aggregates on. A raw query
    // because Prisma cannot aggregate a COALESCE; max(COALESCE(a,b)) is NOT
    // GREATEST(max(a), max(b)) — a haul delivered early against a late appointment
    // must count as its COALESCEd (real) day, not its appointment.
    const rows = await prisma.$queryRaw<Array<{ newest: Date | null }>>`
      SELECT max(COALESCE(recycler_reported_delivery_date, docking_appointment_date)) AS newest
        FROM mymrc_hauls_mirror
       WHERE status = 'Delivered'`;
    return rows[0]?.newest ?? null;
  }
  if (feed === 'processed') {
    const r = await prisma.mymrcProcessedMirror.aggregate({ _max: { entry_date: true } });
    return r._max.entry_date;
  }
  const r = await prisma.mymrcOutboundMirror.aggregate({ _max: { entry_date: true } });
  return r._max.entry_date;
}

/**
 * Decide staleness from an already-measured date. Pure, so the threshold logic
 * is unit-tested without a database.
 *
 * An EMPTY mirror (`newest === null`) is NOT stale here: "we hold nothing" is a
 * first-run/bootstrap state, and the zero-anomaly + deadman guards already own
 * it. Treating it as stale would page every fresh environment on boot.
 */
export function assessFreshness(
  feed: FeedName,
  newest: Date | null,
  now: Date,
  holidays: ReadonlySet<string>,
  maxBusinessDays: number = DEFAULT_MAX_BUSINESS_DAYS,
): FeedFreshness {
  if (newest === null) {
    return { feed, newest: null, ageMs: null, businessDaysBehind: null, stale: false };
  }
  const ageMs = now.getTime() - newest.getTime();
  // Both sides reduced to a Pacific calendar day before counting. `entry_date` is
  // stored noon-anchored precisely so its day is unambiguous in either zone.
  const businessDaysBehind = businessDaysBetween(
    pacificDayISO(newest),
    pacificDayISO(now),
    holidays,
  );
  return { feed, newest, ageMs, businessDaysBehind, stale: businessDaysBehind > maxBusinessDays };
}

/** Measure one feed's freshness against the live mirror. */
export async function measureFeedFreshness(args: {
  prisma: PrismaClient;
  feed: FeedName;
  now?: Date;
  holidays?: ReadonlySet<string>;
  maxBusinessDays?: number;
}): Promise<FeedFreshness> {
  const now = args.now ?? new Date();
  const holidays = args.holidays ?? (await fleetWideHolidays(args.prisma));
  const newest = await newestBusinessDate(args.prisma, args.feed);
  return assessFreshness(
    args.feed,
    newest,
    now,
    holidays,
    args.maxBusinessDays ?? DEFAULT_MAX_BUSINESS_DAYS,
  );
}

/**
 * The Pacific day keys on which EVERY active site is closed (ADR-0130 D6).
 *
 * `site_holidays` is the operator-owned closure list that already backs the AP
 * escalation clock, the throughput-gap watchdog, the audit sweep and the bonus EOD
 * check — so this guard gets the operator's calendar for free rather than inventing
 * a second one. It holds the SIX closures Bill confirmed for both sites (charter
 * Q19, `prisma/seed/README.md`): New Year's, Memorial, Independence, Labor,
 * Thanksgiving, Christmas. That is deliberately NOT the eleven US federal holidays
 * — it is the days DR3 is shut. A day the floor works must count as a business day,
 * or a real freeze takes an extra day to surface.
 *
 * FLEET-WIDE (observed at every site), matching `@/lib/ap/business-clock.ts`'s rule
 * and for the same reason in the same direction: skipping a day only when nobody is
 * working is the conservative choice, because marking a day closed makes this guard
 * QUIETER. Both sites currently carry identical rows, so this is a no-op today and
 * a safeguard if they ever diverge.
 *
 * Fails OPEN to an empty set: if the query throws, every weekday counts and the
 * guard is merely more eager — never silently disabled.
 */
export async function fleetWideHolidays(prisma: PrismaClient): Promise<ReadonlySet<string>> {
  try {
    const siteCount = await prisma.site.count();
    if (siteCount === 0) return new Set();
    const rows = await prisma.siteHoliday.findMany({
      select: { holiday_date: true, site_id: true },
    });
    const bySite = new Map<string, Set<string>>();
    for (const r of rows) {
      // `holiday_date` is a `@db.Date`; its UTC components ARE the calendar day.
      const key = r.holiday_date.toISOString().slice(0, 10);
      if (!bySite.has(key)) bySite.set(key, new Set());
      bySite.get(key)!.add(r.site_id);
    }
    const out = new Set<string>();
    for (const [day, sites] of bySite) if (sites.size >= siteCount) out.add(day);
    return out;
  } catch {
    return new Set();
  }
}

function describeAge(f: FeedFreshness): string {
  if (f.newest === null || f.ageMs === null) return 'mirror empty';
  const days = f.ageMs / 86_400_000;
  // BOTH numbers. The business-day count is what DECIDED; the calendar age is what a
  // reader would otherwise compute in their head and get a different answer from —
  // "105 h behind" and "1 business day behind" are the same Monday.
  return (
    `newest ${FRESHNESS_COLUMN[f.feed]}=${f.newest.toISOString().slice(0, 10)} ` +
    `(${f.businessDaysBehind ?? '?'} business day(s) behind, ${days.toFixed(1)}d calendar)`
  );
}

/**
 * Check every feed's mirror freshness and page (deduped, `high`, 24h cooldown)
 * for each stale one. Never throws — a freshness check must not fail a sync.
 * Returns the measurements so the caller can log/ledger them.
 */
export async function checkMirrorFreshness(args: {
  prisma: PrismaClient;
  sites: readonly SiteCode[];
  feeds?: readonly FeedName[];
  pager: Pager;
  now?: Date;
  holidays?: ReadonlySet<string>;
  maxBusinessDays?: number;
  log?: Logger;
}): Promise<FeedFreshness[]> {
  const log = args.log ?? noopLog;
  const now = args.now ?? new Date();
  const feeds = args.feeds ?? (['hauls', 'processed', 'outbound'] as const);
  const maxBusinessDays = args.maxBusinessDays ?? DEFAULT_MAX_BUSINESS_DAYS;
  // Read ONCE per check, not once per feed per site — the closure list is the same
  // for every measurement in this run.
  const holidays = args.holidays ?? (await fleetWideHolidays(args.prisma));
  const out: FeedFreshness[] = [];

  for (const feed of feeds) {
    const f = await measureFeedFreshness({
      prisma: args.prisma,
      feed,
      now,
      holidays,
      maxBusinessDays,
    });
    out.push(f);
    log(
      f.stale ? 'error' : 'info',
      `mymrc-freshness: ${feed} ${f.stale ? 'STALE' : 'ok'} — ${describeAge(f)}`,
    );
  }

  // ── ADR-0130 D8 — one condition pages once ────────────────────────────────
  //
  // This used to page per site AND per feed. `processed` and `outbound` freeze
  // together because they are ONE upstream stoppage — the same person stops posting
  // to the same portal — so the per-feed fingerprint turned one condition into two
  // identical `high` pages an hour. ADR-0037 Q4 is "deduplicated against root
  // cause"; the root cause is the site's mirror, not each feed in it.
  //
  // The `feed` field is deliberately LEFT OFF the alert envelope: it drives the
  // ` [<feed>]` title suffix, and a combined page that named one feed would be
  // lying about the other. The stale feeds are named in the message instead.
  const stale = out.filter((f) => f.stale);
  if (stale.length === 0) return out;

  const worst = Math.max(...stale.map((f) => f.businessDaysBehind ?? 0));
  const feedList = stale.map((f) => f.feed).join(', ');
  const detail = stale.map((f) => `${f.feed}: ${describeAge(f)}`).join('; ');

  // The mirror is global (the list pass is not login-scoped), but the alert envelope
  // is per-site so the fingerprint matches the rest of ADR-0038.
  for (const site of args.sites) {
    await args.pager
      .page({
        kind: 'stale_mirror',
        site,
        message:
          `The MyMRC mirror has stopped advancing for: ${feedList}. ${detail}. ` +
          `Measured in BUSINESS DAYS (Mon-Fri minus the site_holidays closures), not ` +
          `calendar hours — a feed that only advances on business days cannot be ` +
          `measured in calendar time, and the calendar rule false-paged on three ` +
          `ordinary Mondays. Threshold is more than ${maxBusinessDays} business days ` +
          `behind. Hourly runs may still be reporting ok — freshness is measured on ` +
          `the record's own business date, not on the sync's status. Run the bounded ` +
          `catch-up (docs/operator/mymrc-ingestion.md) if this does not clear.`,
        fingerprint: freshnessFingerprint(site),
        cooldownMs: FRESHNESS_COOLDOWN_MS,
        // §6 — `default` normally; `high` once this is unmistakably an outage
        // rather than a slow week. `exactOptionalPropertyTypes` forbids passing
        // `undefined` explicitly, hence the spread.
        ...(worst >= ESCALATE_BUSINESS_DAYS ? { priority: 'high' as const } : {}),
      })
      .catch(() => undefined);
  }
  return out;
}

/**
 * Canonical fingerprint for the staleness page — one per SITE (ADR-0130 D8).
 *
 * Was `mymrc-stale-mirror:<site>:<feed>`. Changing the shape orphans the old keys in
 * `alert_cooldowns`; that needs no migration, because the ADR-0130 reaper deletes
 * rows more than seven days past expiry and nothing ever reads them again. The first
 * page under the new key fires immediately rather than inheriting the old window,
 * which is the behaviour we want: one clean page, then daily.
 */
export function freshnessFingerprint(site: string): string {
  return `mymrc-stale-mirror:${site}`;
}
