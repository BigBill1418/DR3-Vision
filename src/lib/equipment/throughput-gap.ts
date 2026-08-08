// ADR-0088 — the throughput-gap watchdog: an instrument that reads the silence.
//
// ── What went wrong, and why nothing said so ────────────────────────────────
// Between 2026-07-25 and the 2026-08-07 cutover the Terex sheet went unfilled
// for NINE working days. Nothing in the system was broken. ADR-0079 had already
// made "nobody wrote a number down" a first-class, honest state — an ABSENT row
// in `equipment_daily_throughput`, deliberately never a `0` (ADR-0077 D4) — and
// the trend page drew every one of those days as `not_recorded`, faithfully.
//
// The defect was that the honest answer was only ever WRITTEN DOWN, never SAID.
// The single detector in the whole stack was Bill opening the chart and noticing.
// Post-cutover the manager surface inherits exactly the same silence: the number
// is now typed by JT instead of into a spreadsheet, and if he stops typing it,
// the page will keep drawing "not recorded" and keep telling nobody.
//
// This module is the thing that says it out loud. It is deliberately the
// smallest possible instrument: it asks one question, once a working morning,
// per site — "did yesterday's working day get a number?" — and if the answer is
// no, it sends one email to the people who can do something about it.
//
// ── Why this is a `default`-severity staff nudge, not a page ────────────────
// Graded against the ADR-0037 five-question gate, honestly:
//
//   1. Actionable within 5 minutes? NO. And note the sharp edge: ADR-0079 D4
//      REFUSES a prior-day entry outright (`DailyThroughputAmendmentRequiredError`),
//      so the missed day cannot simply be typed in — it routes to the office.
//      What IS immediately actionable is the habit: enter TODAY's number, and
//      don't let one missed day become nine.
//   2. Customer-visible? NO. It is an internal capture gap.
//   3. Self-heal first? There is nothing to self-heal — the input is a person.
//   4. Deduplicated against root cause? YES, and structurally: ONE alert per
//      SITE per missed day, keyed in the database, never one per machine.
//   5. Useful destination? YES — the site's equipment page, the exact screen
//      carrying the daily-capture form.
//
// Failing (1) and (2) is what makes this `default`, not `high`. A `high` here
// would be a phone buzzing about a spreadsheet field, which is how a fleet
// teaches its operator to ignore alerts. `default` maps to a staff email at
// `importance: normal` and NO push.
//
// ── Why notifyStaff() and not ntfy ─────────────────────────────────────────
// CLAUDE.md hard rule #5: ntfy goes to Bill ONLY and only for SYSTEM-level
// events. A manager who did not enter a number is an operational event about
// people and process — precisely the class rule #5 names as in-app / staff
// signal, never push. So this rides `notifyStaff()` (CLAUDE.md rule 12, the
// ADR-0047 chokepoint) on its own `equipment_throughput_gap` surface, BORN
// PILOT: on deploy the nudge goes to admins with the would-have-sent header, and
// Bill ramps it per-site from /admin/rollout once he has read a few.
//
// The ONE thing that does page `dr3-vision-system` is the nudge itself failing
// to deliver — the alert channel breaking IS a system event, the same carve-out
// `alert-digest.ts` already makes, on the same existing topic. No new topic is
// created here; a new ntfy topic nobody is subscribed to is a silent black hole.
//
// ── The four things it must NEVER fire on ──────────────────────────────────
//   · PRE-CUTOVER days (< TEREX_CAPTURE_CUTOVER_ISO). Before capture began, an
//     absent row is not a gap — it is the sheet era, and ADR-0079 Am.1 says so.
//   · PILOT sites. If `equipment_entry` is not live at a site, nobody there can
//     even reach the form; nudging them to fill in a screen they cannot open is
//     a bug wearing an email.
//   · WEEKENDS — neither as a run day nor as a gap day.
//   · Sites with NO machine. Eugene resolves to null today (ADR-0077's identity
//     rule, site-derived and never hardcoded) and must stay silent.

import { prisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { notifyStaff } from '@/lib/notify/notify-staff';
import { NOTIFY_SURFACE, isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { publishNtfy } from '@/lib/ntfy';
import { pacificDayISO, dayKeyUTCFromISO, dayISO } from '@/lib/time';
import { log } from '@/lib/observability/logger';
import { resolveSiteThroughputMachine } from './daily-throughput';
import { TEREX_CAPTURE_CUTOVER_ISO } from './throughput';

/**
 * How far back the previous-working-day walk may step before giving up.
 *
 * Two weeks is far more than any real holiday run (the longest possible Mon–Fri
 * suppression is a holiday-flanked long weekend), and the cap exists only so a
 * pathological `site_holidays` import — every weekday of a month marked — cannot
 * spin the scan. Returning `null` is the honest outcome there: we could not find
 * a working day to ask about, so we ask about nothing.
 */
const MAX_WORKING_DAY_LOOKBACK = 14;

/**
 * Page cooldown for a NUDGE-DELIVERY failure (system-level; ADR-0037 §3 puts the
 * alert-channel-failing class on an hours-not-minutes cadence). Matches
 * `alert-digest.ts`'s `DIGEST_FAIL_COOLDOWN_MS` deliberately: it is the same
 * failure of the same transport, and two different cooldowns for one fact would
 * only make the pager's behaviour harder to reason about.
 */
const GAP_NOTIFY_FAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function baseUrl(): string {
  return process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
}

// ── Pure calendar helpers ───────────────────────────────────────────────────

/**
 * Is this `YYYY-MM-DD` Pacific calendar day a WORKING day?
 *
 * Mon–Fri, minus the site's own holidays. Reads the weekday in UTC off the day
 * KEY, which is correct precisely because of the `lib/time` storage invariant: a
 * business day's UTC components ARE its Pacific calendar components. Re-shifting
 * a day key through the Pacific zone here would move it back a day and turn
 * every Monday into a Sunday.
 *
 * HOLIDAYS ARE SITE-SCOPED here, unlike `ap/business-clock.ts`'s
 * `fleetWideHolidays`. That module is person-scoped and pauses only on a holiday
 * BOTH sites observe, because pausing on one site's holiday would delay an
 * escalation the other site's staff were working through. This watchdog is
 * site-scoped end to end, so the right calendar is the site's own: Woodland
 * closed for a California holiday did not fail to record anything.
 */
export function isWorkingDayISO(day: string, holidays: ReadonlySet<string> = new Set()): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !holidays.has(day);
}

/**
 * The working day immediately BEFORE `from` — the day this scan is about.
 *
 * Monday looks back to FRIDAY, not Sunday: it steps one calendar day at a time
 * and keeps stepping while the candidate is a weekend or a holiday. A naive
 * "yesterday" would have made every Monday scan a Sunday, find no row (there
 * never is one), and alert every single week — an alert that fires on schedule
 * regardless of the facts, which is the fastest way to train someone to filter
 * the sender.
 *
 * Returns `null` if no working day is found within {@link MAX_WORKING_DAY_LOOKBACK}.
 */
export function previousWorkingDayISO(
  from: string,
  holidays: ReadonlySet<string> = new Set(),
  maxLookback: number = MAX_WORKING_DAY_LOOKBACK,
): string | null {
  const cursor = dayKeyUTCFromISO(from);
  for (let step = 0; step < maxLookback; step++) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const candidate = dayISO(cursor);
    if (isWorkingDayISO(candidate, holidays)) return candidate;
  }
  return null;
}

// ── Outcomes ────────────────────────────────────────────────────────────────

export type GapScanStatus =
  /** The nudge was sent (to the roster in live, to admins in pilot). */
  | 'alerted'
  /** The nudge was attempted and NOBODY received it — this one pages Bill. */
  | 'failed'
  /** A live row exists for the gap day. Includes a recorded ZERO — see below. */
  | 'skipped_recorded'
  /** `equipment_entry` is not live at this site: nobody here can reach the form. */
  | 'skipped_site_pilot'
  /** No machine resolves at this site (Eugene today). */
  | 'skipped_no_machine'
  /** The gap day predates ADR-0079's capture cutover — the sheet era, not a gap. */
  | 'skipped_pre_cutover'
  /** Already nudged about this exact (site, day). */
  | 'skipped_already_alerted'
  /** No working day found within the lookback window. */
  | 'skipped_no_working_day'
  /** M365 unconfigured — fail-open no-op, nothing logged, retried next tick. */
  | 'disabled'
  /** Live with an empty roster, or pilot with no active admins. */
  | 'skipped_no_recipients';

export interface GapScanOutcome {
  siteCode: string;
  status: GapScanStatus;
  /** The working day examined. Null when no working day could be resolved. */
  gapDateISO: string | null;
  delivered?: number;
  attempted?: number;
}

export interface GapScanSummary {
  /** The Pacific day the scan ran. */
  scanDateISO: string;
  /** True when the run day was itself a weekend and the whole scan was skipped. */
  skippedWeekend: boolean;
  outcomes: GapScanOutcome[];
}

// ── Mail body ───────────────────────────────────────────────────────────────

const SVDP_RED = '#a3151a';
const SVDP_GOLD = '#ffcc69';
const SVDP_CREAM = '#f7f3ea';
const INK = '#2b2b2b';
const MUTED = '#6b6b6b';
const HAIRLINE = '#e6ddca';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The nudge. Deliberately says three things and stops: WHICH day, WHAT to do
 * today, and WHERE the missed day has to go instead.
 *
 * The third is the part a generic "you missed an entry" email would get wrong.
 * ADR-0079 D4 refuses a backdated entry — the form will not accept it — so an
 * email that just says "please enter it" sends the manager to a screen that will
 * tell them no. Naming the office as the route for the missed day is the
 * difference between an actionable message and a frustrating one.
 */
export function renderThroughputGapHtml(
  site: { code: string; name: string },
  machineName: string,
  gapDateLabel: string,
): string {
  const entryUrl = `${baseUrl()}/dashboard/${site.code}/equipment`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${SVDP_CREAM}">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${SVDP_CREAM}">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
        <tr><td style="background:${SVDP_RED};padding:18px 24px">
          <div style="color:#ffffff;font-size:17px;font-weight:700;line-height:1.25">${escapeHtml(site.name)} — no ${escapeHtml(machineName)} numbers for ${escapeHtml(gapDateLabel)}</div>
          <div style="color:#f3d7d8;font-size:13px;padding-top:2px">daily throughput was not recorded</div>
        </td></tr>
        <tr><td style="height:4px;background:${SVDP_GOLD};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:22px 24px 26px">
          <p style="margin:0 0 14px;font-size:14px;color:${INK};line-height:1.55">
            <strong>${escapeHtml(gapDateLabel)}</strong> was a working day, and no units-processed / run-hours
            entry was recorded for <strong>${escapeHtml(machineName)}</strong> at ${escapeHtml(site.name)}.
          </p>
          <p style="margin:0 0 14px;font-size:14px;color:${INK};line-height:1.55">
            <strong>What to do today:</strong> enter today's numbers on the equipment page. Today's entry can
            still be made and corrected freely.
          </p>
          <p style="margin:0 0 18px;font-size:14px;color:${INK};line-height:1.55">
            <strong>The missed day:</strong> it cannot be typed in after the fact — the form refuses a prior
            date on purpose. Contact the office to have ${escapeHtml(gapDateLabel)} corrected on the record.
          </p>
          <p style="margin:0">
            <a href="${entryUrl}" style="display:inline-block;background:${SVDP_RED};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px">Open the equipment page</a>
          </p>
          <p style="color:${MUTED};font-size:11px;line-height:1.5;margin:18px 0 0;border-top:1px solid ${HAIRLINE};padding-top:16px">
            You are receiving this once, for this one day. DR3-Vision sends it on working mornings only, and
            a day that was recorded — including a recorded zero — never triggers it.<br>
            St. Vincent de Paul Society of Lane County
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── The scan ────────────────────────────────────────────────────────────────

/**
 * One working-morning pass: for every site whose capture surface is live and
 * which has a machine, was the previous working day recorded?
 *
 * `now` is injectable so every calendar boundary in the test suite is exercised
 * without mocking the clock. `db` is the test seam, matching the repo's other
 * scan modules.
 *
 * NEVER throws out of the per-site loop: one site's failure must not silence the
 * other's nudge.
 */
export async function runThroughputGapScan(
  now: Date = new Date(),
  db: PrismaClient = prisma,
): Promise<GapScanSummary> {
  const scanDateISO = pacificDayISO(now);

  // Run-day weekend suppression. Distinct from gap-day weekend suppression
  // (which `previousWorkingDayISO` handles): a Saturday pass would look back to
  // Friday, whose entry window only just closed, and address a nudge to a floor
  // nobody is standing on. Monday's pass covers Friday anyway. The ledger would
  // also catch the duplicate, but a scan that never runs cannot mis-fire at all.
  if (!isWorkingDayISO(scanDateISO)) {
    log.info({ scanDateISO }, '[throughput-gap] weekend — scan skipped');
    return { scanDateISO, skippedWeekend: true, outcomes: [] };
  }

  const sites = await db.site.findMany({ select: { id: true, code: true, name: true } });
  const outcomes: GapScanOutcome[] = [];

  for (const site of sites) {
    let gapDateISO: string | null = null;
    try {
      // Site-scoped holiday calendar over the lookback window (see
      // `isWorkingDayISO` for why site-scoped rather than fleet-wide).
      const windowStart = dayKeyUTCFromISO(scanDateISO);
      windowStart.setUTCDate(windowStart.getUTCDate() - MAX_WORKING_DAY_LOOKBACK);
      const holidays = new Set(
        (
          await db.siteHoliday.findMany({
            where: {
              site_id: site.id,
              holiday_date: { gte: windowStart, lte: dayKeyUTCFromISO(scanDateISO) },
            },
            select: { holiday_date: true },
          })
        ).map((h) => dayISO(h.holiday_date)),
      );

      gapDateISO = previousWorkingDayISO(scanDateISO, holidays);
      if (!gapDateISO) {
        outcomes.push({ siteCode: site.code, status: 'skipped_no_working_day', gapDateISO: null });
        continue;
      }

      // Pre-cutover: the sheet era. An absent row there is not a gap (ADR-0079
      // Am.1) and never becomes one — the boundary is a stored constant about
      // when the process changed, not a fact derived from the table's contents.
      if (gapDateISO < TEREX_CAPTURE_CUTOVER_ISO) {
        outcomes.push({ siteCode: site.code, status: 'skipped_pre_cutover', gapDateISO });
        continue;
      }

      // The machine, resolved from the registry by evidence (ADR-0077 D1) — never
      // a literal id. Eugene honestly resolves to null and stays silent; a Terex
      // arriving there tomorrow is picked up with no code change.
      const machine = await resolveSiteThroughputMachine(site.id);
      if (!machine) {
        outcomes.push({ siteCode: site.code, status: 'skipped_no_machine', gapDateISO });
        continue;
      }

      // Pilot-site suppression. `equipment_entry` gates the screen carrying the
      // daily-capture form; where it is pilot, the only people who can reach the
      // form are admins, and the site's managers cannot act on this at all.
      if (!(await isUiSurfaceLive(UI_SURFACE.EQUIPMENT_ENTRY, site.id, db))) {
        outcomes.push({ siteCode: site.code, status: 'skipped_site_pilot', gapDateISO });
        continue;
      }

      const gapDateKey = dayKeyUTCFromISO(gapDateISO);

      // Idempotency, checked BEFORE the read that costs anything. One nudge per
      // (site, missed day), ever.
      const already = await db.equipmentThroughputGapAlert.findUnique({
        where: { site_id_gap_date: { site_id: site.id, gap_date: gapDateKey } },
        select: { id: true },
      });
      if (already) {
        outcomes.push({ siteCode: site.code, status: 'skipped_already_alerted', gapDateISO });
        continue;
      }

      // THE QUESTION. Note what is deliberately NOT here: no test on
      // `units_processed`. A recorded day with 0 units is a RECORDED day — the
      // machine ran and produced nothing, which is a measurement (ADR-0079's
      // `assertDailyThroughputShape` admits it explicitly). Treating 0 as missing
      // would nudge a manager who did exactly what was asked, which is the fastest
      // possible way to lose them.
      //
      // `voided_at: null` is equally load-bearing in the other direction: a day
      // whose only row was soft-voided is genuinely re-enterable and genuinely
      // NOT recorded, and the ADR-0079 partial unique index agrees — it does not
      // hold the slot.
      const recorded = await db.equipmentDailyThroughput.findFirst({
        where: {
          site_id: site.id,
          equipment_id: machine.id,
          throughput_date: gapDateKey,
          voided_at: null,
        },
        select: { id: true },
      });
      if (recorded) {
        outcomes.push({ siteCode: site.code, status: 'skipped_recorded', gapDateISO });
        continue;
      }

      // The audience is the ESTABLISHED per-site roster (`alert_recipients`:
      // Morena + Janette at Woodland, Rick at Eugene) — the site managers, which
      // is exactly who types this number. A second roster table for one nudge
      // would be a second thing to keep current and a second thing to get wrong.
      // Under ADR-0047 pilot the roster is IGNORED and the mail goes to admins
      // with the would-have-sent header, so Bill sees the targeting before it
      // reaches anyone.
      const roster = (
        await db.alertRecipient.findMany({
          where: { site_id: site.id, active: true },
          select: { email: true },
        })
      ).map((r) => r.email);

      const notified = await notifyStaff({
        surfaceCode: NOTIFY_SURFACE.EQUIPMENT_THROUGHPUT_GAP,
        site: { id: site.id, code: site.code },
        recipients: roster,
        subject: `DR3-Vision — ${site.name}: no ${machine.displayName} throughput recorded for ${gapDateISO}`,
        htmlBody: renderThroughputGapHtml(site, machine.displayName, gapDateISO),
        // ADR-0037 `default` severity. NOT `high`: this fails the
        // 5-minute-actionable and customer-visible tests, and an email flagged
        // high-importance for a spreadsheet field teaches its reader to filter
        // the sender.
        importance: 'normal',
        fromDisplayName: 'DR3-Vision Alerts',
        db,
      });

      // M365 unconfigured → fail-open no-op. No ledger row, so the nudge is still
      // OWED once the operator closes the config gap (mirrors alert-digest).
      if (notified.disabled) {
        log.warn(
          { siteCode: site.code, gapDateISO },
          '[throughput-gap] M365 disabled — nudge not sent (fail-open)',
        );
        outcomes.push({ siteCode: site.code, status: 'disabled', gapDateISO });
        continue;
      }

      // Nobody to send to (live with an empty roster, or pilot with no active
      // admins) — a config gap the operator fixes, not a delivery failure. No
      // ledger row, for the same reason as above.
      if (notified.actualRecipients.length === 0) {
        outcomes.push({ siteCode: site.code, status: 'skipped_no_recipients', gapDateISO });
        continue;
      }

      const attempted = notified.actualRecipients.length;
      const delivered = notified.delivered;
      const lastStatus =
        notified.sends
          .map((s) => s.lastStatus)
          .filter((v): v is number => v !== undefined)
          .pop() ?? null;

      await db.equipmentThroughputGapAlert.create({
        data: {
          site_id: site.id,
          gap_date: gapDateKey,
          equipment_id: machine.id,
          scanned_on: dayKeyUTCFromISO(scanDateISO),
          notify_mode: notified.mode,
          recipient_count: attempted,
          delivered_count: delivered,
          last_status: lastStatus,
        },
      });

      log.info(
        { siteCode: site.code, gapDateISO, mode: notified.mode, attempted, delivered },
        '[throughput-gap] nudge processed',
      );

      if (delivered === 0) {
        // The nudge itself failing to arrive IS a system event — the same
        // carve-out `alert-digest.ts` makes, on the SAME existing topic. No new
        // topic: an unsubscribed topic is a silent black hole.
        await publishNtfy({
          topic: 'dr3-vision-system',
          title: `Throughput-gap nudge delivery failed for ${site.code}`,
          body: `0/${attempted} recipients received the ${gapDateISO} throughput-gap nudge (${notified.mode} mode; last status ${lastStatus ?? 'network'}). The capture gap itself is unconfirmed until someone reads it.`,
          priority: 'high',
          tags: ['error', 'throughput-gap', 'dr3-vision'],
          fingerprint: `throughput-gap-failed:${site.code}`,
          cooldownMs: GAP_NOTIFY_FAIL_COOLDOWN_MS,
        });
        outcomes.push({ siteCode: site.code, status: 'failed', gapDateISO, delivered, attempted });
      } else {
        outcomes.push({ siteCode: site.code, status: 'alerted', gapDateISO, delivered, attempted });
      }
    } catch (err) {
      // One site's failure must never silence the other's nudge.
      log.error(
        { err, siteCode: site.code, gapDateISO },
        '[throughput-gap] site scan failed (non-fatal)',
      );
    }
  }

  return { scanDateISO, skippedWeekend: false, outcomes };
}
