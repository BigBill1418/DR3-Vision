// ADR-0071 — the weekly processor-quota digest: compose, decide, send, record.
//
// ── The suppression rule is the feature ─────────────────────────────────────
// No email is sent when nobody flagged. That is not a nicety — it is what makes
// the alert mean something. An "all clear" every Monday trains the recipients to
// archive it unread, and the one week it says something real gets archived with
// the rest. Silence means everyone met quota.
//
// The cost of silence is that "nobody missed twice" and "the cron never ran"
// look identical from the inbox. So a suppressed week still writes a
// `processor_quota_logs` row recording that the week WAS evaluated and what was
// found. This codebase has repeatedly shipped a state meaning "I didn't run"
// disguised as a state meaning "fine"; a suppressed digest is the most natural
// place in this feature for that to happen again, and the log row is the guard.
//
// ── Read-only ───────────────────────────────────────────────────────────────
// The only rows this module writes are `processor_quota_logs`, which it owns.
// No production or bonus table is touched.

import type { PrismaClient } from '@prisma/client';
import { notifyStaff } from '@/lib/notify/notify-staff';
import { log } from '@/lib/observability/logger';
import {
  computeProcessorQuotaWeek,
  latestDueMonFriWeek,
  type ProcessorWeek,
  type QuotaWeek,
} from './processor-quota';

export const PROCESSOR_QUOTA_SURFACE = 'processor_quota_digest';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 'Tuesday 22 Jul' — a weekday name, because "Tue 62" is what a manager needs. */
function dayLabel(dayISO: string): string {
  return new Date(`${dayISO}T12:00:00.000Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
}

/** Trim a Decimal-ish count for display: 49.9 stays, 62.0 becomes 62. */
function units(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function renderQuotaDigestHtml(week: QuotaWeek, siteName: string): string {
  const rows = week.flagged
    .map((p: ProcessorWeek) => {
      const misses = p.misses.map(
        (m) => `${dayLabel(m.dayISO)} — <strong>${units(m.units)}</strong>`,
      );
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e3e6e8;vertical-align:top">
          <strong>${escapeHtml(p.name)}</strong>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e3e6e8;vertical-align:top;text-align:center">
          ${p.misses.length} of ${p.days.length}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e3e6e8;vertical-align:top">
          ${misses.join('<br>')}
        </td>
      </tr>`;
    })
    .join('');

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f7">
<div style="max-width:680px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#12211f">
  <div style="background:#00524C;color:#fff;padding:18px 20px;border-radius:6px 6px 0 0">
    <div style="font-size:18px;font-weight:700">Processor production — weekly exceptions</div>
    <div style="font-size:13px;opacity:.85;margin-top:4px">
      ${escapeHtml(siteName)} · week of ${dayLabel(week.weekStartISO)} to ${dayLabel(week.weekEndISO)}
    </div>
  </div>
  <div style="background:#fff;padding:20px;border:1px solid #e3e6e8;border-top:0;border-radius:0 0 6px 6px">
    <p style="margin:0 0 16px;font-size:14px;line-height:1.55">
      ${week.flagged.length} processor${week.flagged.length === 1 ? '' : 's'} finished
      <strong>${week.minMisses} or more days</strong> below the
      <strong>${units(week.quota)}-unit</strong> daily quota this week.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="background:#f0f3f4;text-align:left">
          <th style="padding:8px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.03em">Processor</th>
          <th style="padding:8px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.03em;text-align:center">Days&nbsp;under</th>
          <th style="padding:8px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.03em">Which days, and the count</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:18px 0 0;font-size:12.5px;line-height:1.6;color:#5b6b68">
      Only days with <strong>recorded production</strong> are counted. A day off, PTO or any day
      with no entry is skipped entirely — it is never a miss. A processor who worked just one day
      and was under quota therefore does not appear here: two strikes needs two worked days.
    </p>
    <p style="margin:10px 0 0;font-size:12.5px;line-height:1.6;color:#5b6b68">
      This email is only sent when someone is flagged. No email means everyone met quota.
    </p>
  </div>
</div></body></html>`;
}

export interface QuotaDigestOutcome {
  siteId: string;
  siteCode: string;
  weekStartISO: string;
  weekEndISO: string;
  processorsSeen: number;
  flaggedCount: number;
  /** True when nobody flagged and the digest deliberately stayed silent. */
  suppressed: boolean;
  /** True when a log row already existed for this (site, week). */
  alreadyEvaluated: boolean;
  mode: 'live' | 'pilot' | null;
  delivered: number;
  error: string | null;
  /**
   * ADR-0071 Amendment 1. Set when the site was evaluated but deliberately not
   * acted on. `'disabled'` is the only value today and it is the one that
   * matters: previously a disabled site produced no outcome at all, so the
   * cron's own log line read `{"outcomes":[]}` — the same thing it prints when
   * the feature has been deleted. An evaluated-but-skipped site says so.
   */
  skipped: 'disabled' | null;
}

export interface RunQuotaDigestOptions {
  db: PrismaClient;
  now?: Date;
  /** Force a specific week instead of the last complete one (admin re-run). */
  weekStartISO?: string;
  /** Evaluate and compose but never send or log — the dry run. */
  dryRun?: boolean;
}

/**
 * Evaluate the most recent DUE Mon-Fri week (Friday 20:00 PT send moment passed;
 * ADR-0071 Am.2) for every ENABLED site config and send the digest where someone flagged.
 *
 * Idempotent per (site, week): the unique index on `processor_quota_logs` is what
 * stops a cron that fires twice — or a container restarted at 06:01 — from
 * mailing the same week's flags to three people a second time.
 */
export async function runProcessorQuotaDigest(
  opts: RunQuotaDigestOptions,
): Promise<QuotaDigestOutcome[]> {
  const db = opts.db;
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;

  // `enabled` gates SENDING, not evaluating — and as of ADR-0071 Amendment 1 it
  // does not gate the QUERY either.
  //
  // It used to: the live run selected `where: { enabled: true }`, so with the
  // feature shipped disabled it matched zero rows, skipped the loop entirely and
  // returned `{"outcomes":[]}` having written nothing. That is byte-identical to
  // what a run produces when the config table has been dropped, and
  // indistinguishable from a dead cron. Twelve days of daily fires (2026-07-31 →
  // 2026-08-11) left no trace, and the operator's question "why have I seen
  // nothing" had no answer in the database.
  //
  // Now every config is read and EVALUATED — evaluation is read-only and costs
  // one indexed query — and `enabled` is checked at the one place it means
  // something: immediately before anything irreversible. A disabled site
  // therefore contributes an honest outcome and a heartbeat line saying what the
  // digest WOULD have said, without a single email leaving the building.
  const configs = await db.processorQuotaConfig.findMany({
    include: { site: true, recipients: true },
    orderBy: { site: { code: 'asc' } },
  });

  const outcomes: QuotaDigestOutcome[] = [];
  let runError: string | null = null;

  try {
    for (const cfg of configs) {
      // ADR-0071 Amendment 2: Friday 20:00 PT, reporting the CURRENT Mon–Fri
      // week. The selector returns the most recent week whose send moment has
      // passed, so weekend/Monday catch-up ticks still target that Friday's
      // week and the idempotency claim no-ops the already-sent case.
      const bounds = opts.weekStartISO
        ? { weekStartISO: opts.weekStartISO, weekEndISO: '' }
        : latestDueMonFriWeek(now);

      const week = await computeProcessorQuotaWeek(db, {
        siteId: cfg.site_id,
        weekStartISO: bounds.weekStartISO,
        ...(bounds.weekEndISO ? { weekEndISO: bounds.weekEndISO } : {}),
        quota: Number(cfg.quota_units),
        minMisses: cfg.min_misses,
      });

      const base = {
        siteId: cfg.site_id,
        siteCode: cfg.site.code,
        weekStartISO: week.weekStartISO,
        weekEndISO: week.weekEndISO,
        processorsSeen: week.rows.length,
        flaggedCount: week.flagged.length,
      };

      if (dryRun) {
        outcomes.push({
          ...base,
          suppressed: week.flagged.length === 0,
          alreadyEvaluated: false,
          mode: null,
          delivered: 0,
          error: null,
          skipped: null,
        });
        continue;
      }

      // ── The `enabled` gate, at the last possible moment ────────────────────
      //
      // Deliberately placed AFTER evaluation and BEFORE anything irreversible.
      // Evaluating costs one indexed read and buys the heartbeat a truthful line —
      // "Woodland: 21 processors, 18 would flag, not sent (disabled)" — which is
      // what makes a switched-off monitor legible instead of silent.
      //
      // No `processor_quota_logs` row is written here, and that is not an
      // oversight: that table is keyed unique on (site, week) and the digest
      // treats an existing row as "already sent, do not send again". Recording a
      // disabled evaluation there would claim every week it skipped, so the
      // morning Bill enables the alert it would find the week already claimed and
      // stay silent — the guard would have eaten the thing it guards. Disabled
      // runs belong in `processor_quota_runs`, which has no such key.
      if (!cfg.enabled) {
        log.info(
          {
            site: cfg.site.code,
            week: week.weekStartISO,
            processors: week.rows.length,
            wouldFlag: week.flagged.length,
          },
          '[processor-quota] site disabled — evaluated, nothing sent',
        );
        outcomes.push({
          ...base,
          suppressed: false,
          alreadyEvaluated: false,
          mode: null,
          delivered: 0,
          error: null,
          skipped: 'disabled',
        });
        continue;
      }

      // Idempotency. Claim the (site, week) BEFORE sending: if the send throws we
      // still hold a row recording the attempt, and a retry is an explicit
      // operator action rather than an accidental second mail.
      const weekStartDate = new Date(`${week.weekStartISO}T00:00:00.000Z`);
      const existing = await db.processorQuotaLog.findUnique({
        where: { site_id_week_start: { site_id: cfg.site_id, week_start: weekStartDate } },
      });
      if (existing) {
        log.info(
          { site: cfg.site.code, week: week.weekStartISO },
          '[processor-quota] week already evaluated — no second send',
        );
        outcomes.push({
          ...base,
          suppressed: existing.suppressed,
          alreadyEvaluated: true,
          mode: null,
          delivered: 0,
          error: null,
          skipped: null,
        });
        continue;
      }

      // ── The suppression decision ──────────────────────────────────────────
      if (week.flagged.length === 0) {
        await db.processorQuotaLog.create({
          data: {
            site_id: cfg.site_id,
            week_start: weekStartDate,
            week_end: new Date(`${week.weekEndISO}T00:00:00.000Z`),
            processors_seen: week.rows.length,
            flagged_count: 0,
            suppressed: true,
            recipient_count: 0,
          },
        });
        log.info(
          { site: cfg.site.code, week: week.weekStartISO, processors: week.rows.length },
          '[processor-quota] nobody flagged — digest suppressed (evaluated, recorded)',
        );
        outcomes.push({
          ...base,
          suppressed: true,
          alreadyEvaluated: false,
          mode: null,
          delivered: 0,
          error: null,
          skipped: null,
        });
        continue;
      }

      const recipients = cfg.recipients.map((r) => r.email).filter((e) => e.trim() !== '');
      let mode: 'live' | 'pilot' | null = null;
      let delivered = 0;
      let error: string | null = null;

      try {
        const res = await notifyStaff({
          surfaceCode: PROCESSOR_QUOTA_SURFACE,
          site: { id: cfg.site_id, code: cfg.site.code },
          recipients,
          subject: `Processor production — ${week.flagged.length} flagged — week of ${week.weekStartISO}`,
          htmlBody: renderQuotaDigestHtml(week, cfg.site.name),
          db,
        });
        mode = res.mode;
        delivered = res.delivered;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        log.error({ err, site: cfg.site.code }, '[processor-quota] digest send failed');
      }

      await db.processorQuotaLog.create({
        data: {
          site_id: cfg.site_id,
          week_start: weekStartDate,
          week_end: new Date(`${week.weekEndISO}T00:00:00.000Z`),
          processors_seen: week.rows.length,
          flagged_count: week.flagged.length,
          suppressed: false,
          recipient_count: recipients.length,
          // Only stamped when something was really delivered — an attempted send
          // that reached nobody must not read as "they were told".
          sent_at: delivered > 0 ? new Date() : null,
          error_text: error,
        },
      });

      outcomes.push({
        ...base,
        suppressed: false,
        alreadyEvaluated: false,
        mode,
        delivered,
        error,
        skipped: null,
      });
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    // ── The heartbeat ──────────────────────────────────────────────────────
    //
    // Written on EVERY live run, including the run that evaluated nothing
    // because every site is switched off, and including the run that threw.
    // That unconditionality is the entire fix: a monitor whose only output is an
    // event is indistinguishable from a dead one until the day it fires, and
    // this one was silent for twelve days without anybody being able to tell.
    //
    // `dryRun` is excluded deliberately. Its contract is "evaluate and change
    // nothing", and an operator poking thresholds from /admin must not be able
    // to forge a heartbeat for a cron that is not running.
    if (!dryRun) {
      try {
        await db.processorQuotaRun.create({
          data: {
            configs_total: configs.length,
            configs_enabled: configs.filter((c) => c.enabled).length,
            sites_evaluated: outcomes.length,
            processors_seen: outcomes.reduce((n, o) => n + o.processorsSeen, 0),
            flagged_total: outcomes.reduce((n, o) => n + o.flaggedCount, 0),
            // Delivered, never attempted (ADR-0095).
            digests_sent: outcomes.filter((o) => o.delivered > 0).length,
            detail: outcomes.map((o) => ({
              siteCode: o.siteCode,
              weekStartISO: o.weekStartISO,
              processorsSeen: o.processorsSeen,
              flaggedCount: o.flaggedCount,
              suppressed: o.suppressed,
              alreadyEvaluated: o.alreadyEvaluated,
              delivered: o.delivered,
              skipped: o.skipped,
              error: o.error,
            })),
            error_text: runError,
          },
        });
      } catch (err) {
        // A heartbeat that cannot be written must not take down the digest that
        // was about to be sent — the email matters more than the record of it.
        log.error({ err }, '[processor-quota] heartbeat write failed');
      }
    }
  }

  return outcomes;
}
