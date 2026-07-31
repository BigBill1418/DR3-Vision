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
  previousCompleteWeek,
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
 * Evaluate the most recent complete week for every ENABLED site config and send
 * the digest where someone flagged.
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

  const configs = await db.processorQuotaConfig.findMany({
    where: { enabled: true },
    include: { site: true, recipients: true },
  });

  const outcomes: QuotaDigestOutcome[] = [];

  for (const cfg of configs) {
    const bounds = opts.weekStartISO
      ? { weekStartISO: opts.weekStartISO, weekEndISO: '' }
      : previousCompleteWeek(now);

    const week = await computeProcessorQuotaWeek(db, {
      siteId: cfg.site_id,
      weekStartISO: bounds.weekStartISO,
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
    });
  }

  return outcomes;
}
