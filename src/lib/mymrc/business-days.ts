// ADR-0130 D6 — the business-day clock the MyMRC freshness guard measures in.
//
// ## Why this exists
//
// `freshness.ts` shipped with `DEFAULT_MAX_AGE_MS = 96h`, justified as "96h clears
// a normal weekend plus a holiday Monday without firing." Measured against the live
// mirror over 2026-07-31 → 2026-09-07, it does not. The MyMRC `processed` feed
// carries exactly ONE row per business day, records for day D are first seen at
// D+1 (and after a weekend at D+3), and `entry_date` is stored noon-anchored —
// so an ordinary Monday peaks at 83–99 h against a 96 h threshold. Whether Bill's
// phone rang on a given Monday was decided by what time on Saturday MyMRC happened
// to post Friday's row: three false pages in thirty-eight days, all on a Monday or
// Tuesday, against one true one.
//
// That is not a tuning problem, it is a units problem. A feed that only advances on
// business days cannot be measured in calendar hours.
//
// ## Zero imports, on purpose
//
// The Pacific-day primitives this needs already exist at `@/lib/time`
// (`pacificDayISO`) and the business-day semantics at `@/lib/ap/business-clock`.
// Neither is reachable: `tsconfig.mymrc.json` has no `@/` alias and pins
// `rootDir: ./src/lib/mymrc`. The `Intl.DateTimeFormat` technique below is the same
// one `src/lib/workbook-sync/naming.ts` and the `.mjs` cron wrappers use for
// exactly this reason — it is the repo's established shape for "read the Pacific
// wall clock without importing the app", not a fourth date library.

const PT_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The Pacific calendar day of `at`, as `YYYY-MM-DD`.
 *
 * `en-CA` because it formats as `YYYY-MM-DD` natively, so there is no part
 * reassembly to get wrong. DST-correct by construction: the offset is resolved by
 * the runtime's tz database per instant, never hardcoded as -7/-8.
 */
export function pacificDayISO(at: Date): string {
  return PT_DAY.format(at);
}

/** Day-of-week for a `YYYY-MM-DD` key. 0 = Sunday. */
function dayOfWeek(dayISO: string): number {
  // The key's UTC components ARE the intended calendar day, so reading the weekday
  // off `T00:00:00Z` is correct — the same invariant `@/lib/time` relies on.
  return new Date(`${dayISO}T00:00:00Z`).getUTCDay();
}

/** Add `n` days to a `YYYY-MM-DD` key. */
function addDays(dayISO: string, n: number): string {
  const d = new Date(`${dayISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * A day on which this feed can advance: Monday–Friday, minus an observed closure.
 *
 * `holidays` is a set of `YYYY-MM-DD` keys sourced from `site_holidays` — the
 * operator-owned list that already backs the AP escalation clock, the throughput-gap
 * watchdog, the audit sweep and the bonus EOD check. It holds the SIX closures Bill
 * confirmed for both sites (charter Q19, `prisma/seed/README.md`), which is the
 * right list here: it is the days the floor is shut, not the federal calendar. A day
 * DR3 actually works must count, or a real freeze takes longer to surface.
 */
export function isBusinessDay(dayISO: string, holidays: ReadonlySet<string>): boolean {
  const d = dayOfWeek(dayISO);
  if (d === 0 || d === 6) return false;
  return !holidays.has(dayISO);
}

/**
 * How many business days have passed since `fromDayISO`, up to and including
 * `toDayISO` — i.e. business days D with `fromDayISO < D <= toDayISO`.
 *
 * Zero when `from` is on or after `to`, which is what makes a FUTURE-dated feed
 * (the `hauls` scheduling date, normally dated forward) count as zero behind rather
 * than as a negative age that has to be special-cased.
 *
 * `maxDays` caps the walk: a corrupt `entry_date` far in the past must not spin the
 * hourly cron. Same guard `@/lib/ap/business-clock.ts` puts on `businessHoursBetween`.
 */
export function businessDaysBetween(
  fromDayISO: string,
  toDayISO: string,
  holidays: ReadonlySet<string>,
  maxDays = 400,
): number {
  if (fromDayISO >= toDayISO) return 0; // ISO keys sort lexicographically as dates
  let count = 0;
  let day = addDays(fromDayISO, 1);
  for (let i = 0; i < maxDays && day <= toDayISO; i++) {
    if (isBusinessDay(day, holidays)) count += 1;
    day = addDays(day, 1);
  }
  return count;
}
