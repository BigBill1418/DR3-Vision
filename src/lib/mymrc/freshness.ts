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
import type { Pager } from './ntfy';
import type { FeedName, SiteCode } from './types';

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: Logger = () => undefined;

/**
 * How far the newest mirrored record may lag before the mirror is stale.
 * 96h clears a normal weekend plus a holiday Monday without firing, while still
 * catching the 9-day freeze on day 4 rather than never.
 */
export const DEFAULT_MAX_AGE_MS = 96 * 60 * 60 * 1000;

/** Page at most once per site+feed per day (ADR-0037 Q4). */
export const FRESHNESS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * The BUSINESS date each feed is measured on — the date the source assigns to
 * the record, never a column we write (`detail_fetched_at`/`last_seen_at` all
 * refresh when we re-read a record we already hold, so they stay green while the
 * mirror rots — that is precisely how this went unnoticed for 9 days).
 *
 * `hauls` is measured on the docking appointment, which is normally FUTURE-dated;
 * a healthy hauls feed therefore reports a negative age and can never be stale.
 * When the feed stops, the newest appointment recedes into the past and crosses
 * the threshold on its own.
 */
export const FRESHNESS_COLUMN: Readonly<Record<FeedName, string>> = {
  hauls: 'docking_appointment_date',
  processed: 'entry_date',
  outbound: 'entry_date',
};

export interface FeedFreshness {
  feed: FeedName;
  /** Newest business date held for this feed, or null when the mirror is empty. */
  newest: Date | null;
  /** How far behind `now` that date is, in ms. Negative for future-dated feeds. */
  ageMs: number | null;
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
    const r = await prisma.mymrcHaulsMirror.aggregate({
      where: { status: 'Delivered' },
      _max: { docking_appointment_date: true },
    });
    return r._max.docking_appointment_date;
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
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): FeedFreshness {
  if (newest === null) return { feed, newest: null, ageMs: null, stale: false };
  const ageMs = now.getTime() - newest.getTime();
  return { feed, newest, ageMs, stale: ageMs > maxAgeMs };
}

/** Measure one feed's freshness against the live mirror. */
export async function measureFeedFreshness(args: {
  prisma: PrismaClient;
  feed: FeedName;
  now?: Date;
  maxAgeMs?: number;
}): Promise<FeedFreshness> {
  const now = args.now ?? new Date();
  const newest = await newestBusinessDate(args.prisma, args.feed);
  return assessFreshness(args.feed, newest, now, args.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
}

function describeAge(f: FeedFreshness): string {
  if (f.newest === null || f.ageMs === null) return 'mirror empty';
  const days = f.ageMs / 86_400_000;
  return `newest ${FRESHNESS_COLUMN[f.feed]}=${f.newest.toISOString().slice(0, 10)} (${days.toFixed(1)}d behind)`;
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
  maxAgeMs?: number;
  log?: Logger;
}): Promise<FeedFreshness[]> {
  const log = args.log ?? noopLog;
  const now = args.now ?? new Date();
  const feeds = args.feeds ?? (['hauls', 'processed', 'outbound'] as const);
  const out: FeedFreshness[] = [];

  for (const feed of feeds) {
    const f = await measureFeedFreshness({
      prisma: args.prisma,
      feed,
      now,
      ...(args.maxAgeMs === undefined ? {} : { maxAgeMs: args.maxAgeMs }),
    });
    out.push(f);
    if (!f.stale) {
      log('info', `mymrc-freshness: ${feed} ok — ${describeAge(f)}`);
      continue;
    }
    log('error', `mymrc-freshness: ${feed} STALE — ${describeAge(f)}`);
    // The mirror is global (the list pass is not login-scoped), but the alert
    // envelope is per-site so the fingerprint matches the rest of ADR-0038.
    for (const site of args.sites) {
      await args.pager
        .page({
          kind: 'stale_mirror',
          site,
          feed,
          message:
            `The MyMRC ${feed} mirror has stopped advancing: ${describeAge(f)}. ` +
            `Hourly runs may still be reporting ok — freshness is measured on the ` +
            `record's own ${FRESHNESS_COLUMN[feed]}, not on the sync's status. ` +
            `Run the bounded catch-up (docs/operator/mymrc-ingestion.md) if this does not clear.`,
          fingerprint: freshnessFingerprint(site, feed),
          cooldownMs: FRESHNESS_COOLDOWN_MS,
        })
        .catch(() => undefined);
    }
  }
  return out;
}

/** Canonical fingerprint for the staleness page (one per site+feed). */
export function freshnessFingerprint(site: string, feed: FeedName): string {
  return `mymrc-stale-mirror:${site}:${feed}`;
}
