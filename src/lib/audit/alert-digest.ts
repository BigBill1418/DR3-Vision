// ADR-0043 D3/D5 — the daily alert digest.
//
// Rides the existing daily-report cron tick (no new container): the internal
// daily-report route calls `runAlertDigestFire` after the production report.
// Per site, ONLY when open R/M findings exist, it sends ONE SVdP-shell email to
// the `alert_recipients` roster via `sendSystemEmail` (from dr3-vision@svdp.us),
// idempotent through the `alert_digest_logs` (site, digest_date) unique. A send
// failure pages `dr3-vision-system` (the alert channel itself failing IS a
// system event, hard rule #5-compatible — operational findings still never
// push); a healthy send is silent.
//
// NOTE (deviation from D3's "07:00 PT"): the only existing daily-report tick
// fires at each site's configured `send_time_pt` (18:00 PT today), so the digest
// inherits that tick rather than 07:00 — honouring the binding "no new
// container / piggyback the existing tick" constraint. The dedup ledger keeps it
// to one email per site per day regardless of when the tick lands.

import { prisma } from '@/lib/prisma';
import { notifyStaff } from '@/lib/notify/notify-staff';
import { NOTIFY_SURFACE } from '@/lib/notify/rollout';
import { publishNtfy } from '@/lib/ntfy';
import { appToday, dayISO } from '@/lib/time';
import { log } from '@/lib/observability/logger';
import { dueSummaryForSite } from '@/lib/ops/tasks';
import { pendingApCount } from '@/lib/ap/approvals';
import type { CheckCode, Severity } from './types';

const R_M_CHECKS: CheckCode[] = [
  'r1_recycling_rate',
  'r2_recovery_rate',
  'm1_missing_close',
  'm2_missing_snapshot',
];

// Page cooldown for a digest-delivery failure (system-level; ADR-0037 §3 — the
// alert channel failing is hours-not-minutes cadence).
const DIGEST_FAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function baseUrl(): string {
  return process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
}

export interface DigestFinding {
  id: string;
  checkCode: CheckCode;
  severity: Severity;
  windowStartISO: string;
  windowEndISO: string;
}

export type DigestStatus =
  | 'sent'
  | 'failed'
  | 'disabled'
  | 'skipped_no_findings'
  | 'skipped_no_recipients'
  | 'skipped_already_logged';

export interface DigestOutcome {
  siteCode: string;
  status: DigestStatus;
  findingCount?: number;
  delivered?: number;
  attempted?: number;
}

const CHECK_LABEL: Record<string, string> = {
  r1_recycling_rate: 'Recycling rate below contract floor',
  r2_recovery_rate: 'Recovery rate below contract floor',
  m1_missing_close: 'Missing daily close',
  m2_missing_snapshot: 'Missing physical snapshot',
};

// ── SVdP-shell HTML (self-contained; parallels daily-report-notifications) ──

const SVDP_RED = '#a3151a';
const SVDP_GOLD = '#ffcc69';
const SVDP_CREAM = '#f7f3ea';
const INK = '#2b2b2b';
const MUTED = '#6b6b6b';
const HAIRLINE = '#e6ddca';
const SEV_COLOR: Record<Severity, string> = {
  critical: '#a3151a',
  high: '#c1440e',
  medium: '#b8860b',
  low: '#6b6b6b',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ADR-0045 D1 — a due/overdue task line for the digest's second section.
export interface DigestTaskLine {
  id: string;
  title: string;
  dueISO: string | null;
  overdue: boolean;
}

export function renderDigestHtml(
  site: { code: string; name: string },
  findings: readonly DigestFinding[],
  dueTasks: readonly DigestTaskLine[] = [],
  // ADR-0046 D4 — org-wide pending vendor-invoice approvals. A COUNT (not rows),
  // so showing the same org number in both sites' digests is harmless (unlike the
  // task rows, which are deliberately not duplicated). Rides the digest when it
  // sends; it does not itself trigger a send.
  pendingAp = 0,
): string {
  const auditUrl = `${baseUrl()}/dashboard/${site.code}/audit`;
  const opsUrl = `${baseUrl()}/dashboard/${site.code}/ops`;
  const apUrl = `${baseUrl()}/dashboard/ops/ap`;
  const rows = findings
    .map((f, i) => {
      const border = i === 0 ? '' : `border-top:1px solid ${HAIRLINE};`;
      const cell = `padding:8px 0;${border}font-size:14px;color:${INK}`;
      const label = escapeHtml(CHECK_LABEL[f.checkCode] ?? f.checkCode);
      const link = `${auditUrl}?tab=findings&status=open&check=${encodeURIComponent(f.checkCode)}`;
      return `<tr>
        <td style="${cell}"><span style="display:inline-block;min-width:60px;color:${SEV_COLOR[f.severity]};font-weight:700;text-transform:uppercase;font-size:11px">${f.severity}</span></td>
        <td style="${cell}"><a href="${link}" style="color:${SVDP_RED};text-decoration:none">${label}</a><div style="color:${MUTED};font-size:12px">window ${escapeHtml(f.windowStartISO)} → ${escapeHtml(f.windowEndISO)}</div></td>
      </tr>`;
    })
    .join('');

  // ADR-0045 D1 — second section: overdue / due-today ops tasks for this site.
  const taskRows = dueTasks
    .map((t, i) => {
      const border = i === 0 ? '' : `border-top:1px solid ${HAIRLINE};`;
      const cell = `padding:8px 0;${border}font-size:14px;color:${INK}`;
      const tag = t.overdue ? 'OVERDUE' : 'DUE TODAY';
      const tagColor = t.overdue ? SVDP_RED : '#b8860b';
      const due = t.dueISO ? `due ${escapeHtml(t.dueISO)}` : 'no due date';
      return `<tr>
        <td style="${cell}"><span style="display:inline-block;min-width:72px;color:${tagColor};font-weight:700;text-transform:uppercase;font-size:11px">${tag}</span></td>
        <td style="${cell}">${escapeHtml(t.title)}<div style="color:${MUTED};font-size:12px">${due}</div></td>
      </tr>`;
    })
    .join('');

  const findingsBlock =
    findings.length === 0
      ? ''
      : `<h2 style="color:${SVDP_RED};font-size:15px;margin:0 0 8px">Contract-rate &amp; record alerts</h2>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">${rows}</table>
          <p style="margin:14px 0 0"><a href="${auditUrl}" style="display:inline-block;background:${SVDP_RED};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px">Open the audit review queue</a></p>`;

  const tasksBlock =
    dueTasks.length === 0
      ? ''
      : `<h2 style="color:${SVDP_RED};font-size:15px;margin:${findings.length === 0 ? '0' : '24px'} 0 8px">Follow-ups due</h2>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">${taskRows}</table>
          <p style="margin:14px 0 0"><a href="${opsUrl}" style="display:inline-block;background:${SVDP_RED};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px">Open the ops ledger</a></p>`;

  const apBlock =
    pendingAp === 0
      ? ''
      : `<h2 style="color:${SVDP_RED};font-size:15px;margin:${findings.length === 0 && dueTasks.length === 0 ? '0' : '24px'} 0 8px">Accounting</h2>
          <p style="margin:0;font-size:14px;color:${INK}">${pendingAp} vendor-invoice approval${pendingAp === 1 ? '' : 's'} pending (org-wide).</p>
          <p style="margin:10px 0 0"><a href="${apUrl}" style="display:inline-block;background:${SVDP_RED};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px">Open the AP approval queue</a></p>`;

  const summaryParts: string[] = [];
  if (findings.length > 0)
    summaryParts.push(`${findings.length} open finding${findings.length === 1 ? '' : 's'}`);
  if (dueTasks.length > 0)
    summaryParts.push(`${dueTasks.length} follow-up${dueTasks.length === 1 ? '' : 's'} due`);
  if (pendingAp > 0)
    summaryParts.push(`${pendingAp} AP approval${pendingAp === 1 ? '' : 's'} pending`);
  const summary = summaryParts.join(' · ') || 'items needing review';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${SVDP_CREAM}">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${SVDP_CREAM}">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
        <tr><td style="background:${SVDP_RED};padding:18px 24px">
          <div style="color:#ffffff;font-size:17px;font-weight:700;line-height:1.25">${escapeHtml(site.name)} — daily digest</div>
          <div style="color:#f3d7d8;font-size:13px;padding-top:2px">${summary}</div>
        </td></tr>
        <tr><td style="height:4px;background:${SVDP_GOLD};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:22px 24px 26px">
          ${findingsBlock}
          ${tasksBlock}
          ${apBlock}
          <p style="color:${MUTED};font-size:11px;line-height:1.5;margin:18px 0 0;border-top:1px solid ${HAIRLINE};padding-top:14px">
            Early-warning from DR3-Vision — before MRC computes the official rate. A low rate that coincides with a missing-record finding is likely a data gap; open the finding for its linked cause.<br>
            St. Vincent de Paul Society of Lane County
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── Fire ────────────────────────────────────────────────────────────────

export async function runAlertDigestFire(now: Date = new Date()): Promise<{ outcomes: DigestOutcome[] }> {
  const digestDate = appToday(now);
  const sites = await prisma.site.findMany({ select: { id: true, code: true, name: true } });
  const outcomes: DigestOutcome[] = [];
  // ADR-0046 D4 — org-wide pending AP count, computed once (same for every site).
  const pendingAp = await pendingApCount();

  for (const site of sites) {
    try {
      // Idempotency: one digest per site per day.
      const existing = await prisma.alertDigestLog.findUnique({
        where: { site_id_digest_date: { site_id: site.id, digest_date: digestDate } },
        select: { id: true },
      });
      if (existing) {
        outcomes.push({ siteCode: site.code, status: 'skipped_already_logged' });
        continue;
      }

      const findingRows = await prisma.auditFinding.findMany({
        where: { site_id: site.id, check_code: { in: R_M_CHECKS }, status: 'open' },
        orderBy: [{ severity: 'desc' }, { last_seen_at: 'desc' }],
        select: { id: true, check_code: true, severity: true, window_start: true, window_end: true },
      });

      // ADR-0045 D1 — overdue / due-today ops tasks for this site (site-scoped
      // only; org-wide follow-ups live on the dashboard tile, not per-site email,
      // so they are never duplicated across both sites' digests).
      const due = await dueSummaryForSite(site.id, digestDate, false);
      const dueTasks: DigestTaskLine[] = [...due.overdue, ...due.dueToday].map((t) => ({
        id: t.id,
        title: t.title,
        dueISO: t.dueDate ? dayISO(t.dueDate) : null,
        overdue: t.overdue,
      }));

      // The digest still sends ONLY when there is something to report: open
      // findings OR due tasks. A quiet day sends nothing (ADR-0043 invariant,
      // extended by ADR-0045 D1).
      if (findingRows.length === 0 && dueTasks.length === 0) {
        outcomes.push({ siteCode: site.code, status: 'skipped_no_findings' });
        continue;
      }

      // The roster is the LIVE-state recipient list. Under ADR-0047 the digest
      // routes through notifyStaff(): in `pilot` (the incident default) the
      // roster is IGNORED — output goes to admins with the would-have-sent
      // header — so the digest still fires for admin validation even while the
      // roster is muted. In `live` it goes to the active roster.
      const rosterEmails = (
        await prisma.alertRecipient.findMany({
          where: { site_id: site.id, active: true },
          select: { email: true },
        })
      ).map((r) => r.email);

      const findings: DigestFinding[] = findingRows.map((f) => ({
        id: f.id,
        checkCode: f.check_code as CheckCode,
        severity: f.severity as Severity,
        windowStartISO: f.window_start.toISOString().slice(0, 10),
        windowEndISO: f.window_end.toISOString().slice(0, 10),
      }));

      const subjParts: string[] = [];
      if (findings.length > 0)
        subjParts.push(`${findings.length} open finding${findings.length === 1 ? '' : 's'}`);
      if (dueTasks.length > 0)
        subjParts.push(`${dueTasks.length} follow-up${dueTasks.length === 1 ? '' : 's'} due`);
      const subject = `DR3-Vision daily digest — ${site.name} — ${subjParts.join(' · ')}`;
      const htmlBody = renderDigestHtml(site, findings, dueTasks, pendingAp);

      const notified = await notifyStaff({
        surfaceCode: NOTIFY_SURFACE.ALERT_DIGEST,
        site: { id: site.id, code: site.code },
        recipients: rosterEmails,
        subject,
        htmlBody,
        fromDisplayName: 'DR3-Vision Alerts',
      });

      // M365 not configured → fail-open no-op: don't log, don't page (retry next tick).
      if (notified.disabled) {
        log.warn({ siteCode: site.code }, '[alert-digest] M365 disabled — digest not sent (fail-open)');
        outcomes.push({ siteCode: site.code, status: 'disabled', findingCount: findings.length });
        continue;
      }

      // Nobody to send to (live with an empty roster, or no admins in pilot) —
      // a config gap the operator fixes; not a delivery failure, no ledger row.
      if (notified.actualRecipients.length === 0) {
        outcomes.push({ siteCode: site.code, status: 'skipped_no_recipients' });
        continue;
      }

      const delivered = notified.delivered;
      const lastStatus = notified.sends.map((r) => r.lastStatus).filter((v): v is number => v !== undefined).pop() ?? null;
      const messageId = (notified.sends.find((r) => r.delivered) ?? notified.sends[0])?.messageId ?? null;

      await prisma.alertDigestLog.create({
        data: {
          site_id: site.id,
          digest_date: digestDate,
          finding_count: findings.length,
          recipient_count: notified.actualRecipients.length,
          delivered_count: delivered,
          graph_message_id: messageId,
          last_status: lastStatus,
        },
      });
      const attempted = notified.actualRecipients.length;
      log.info(
        { siteCode: site.code, findings: findings.length, mode: notified.mode, recipients: attempted, delivered },
        '[alert-digest] digest processed',
      );

      if (delivered === 0) {
        await publishNtfy({
          topic: 'dr3-vision-system',
          title: `Alert digest delivery failed for ${site.code}`,
          body: `0/${attempted} recipients received the ${findings.length}-finding alert digest (${notified.mode} mode; last status ${lastStatus ?? 'network'}). Retry from the audit surface.`,
          priority: 'high',
          tags: ['error', 'alert-digest', 'dr3-vision'],
          fingerprint: `alert-digest-failed:${site.code}`,
          cooldownMs: DIGEST_FAIL_COOLDOWN_MS,
        });
        outcomes.push({ siteCode: site.code, status: 'failed', findingCount: findings.length, delivered, attempted });
      } else {
        outcomes.push({ siteCode: site.code, status: 'sent', findingCount: findings.length, delivered, attempted });
      }
    } catch (err) {
      log.error({ err, siteCode: site.code }, '[alert-digest] site fire failed (non-fatal)');
      // Continue with the other sites; never throw out of the fire.
    }
  }

  return { outcomes };
}
