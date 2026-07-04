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
import { sendSystemEmail } from '@/lib/m365-mail';
import { publishNtfy } from '@/lib/ntfy';
import { appToday } from '@/lib/time';
import { log } from '@/lib/observability/logger';
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

export function renderDigestHtml(
  site: { code: string; name: string },
  findings: readonly DigestFinding[],
): string {
  const auditUrl = `${baseUrl()}/dashboard/${site.code}/audit`;
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

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${SVDP_CREAM}">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${SVDP_CREAM}">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
        <tr><td style="background:${SVDP_RED};padding:18px 24px">
          <div style="color:#ffffff;font-size:17px;font-weight:700;line-height:1.25">${escapeHtml(site.name)} — contract-rate &amp; record alerts</div>
          <div style="color:#f3d7d8;font-size:13px;padding-top:2px">${findings.length} open finding${findings.length === 1 ? '' : 's'} needing review</div>
        </td></tr>
        <tr><td style="height:4px;background:${SVDP_GOLD};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:22px 24px 26px">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">${rows}</table>
          <p style="margin:22px 0 0"><a href="${auditUrl}" style="display:inline-block;background:${SVDP_RED};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px">Open the audit review queue</a></p>
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
      if (findingRows.length === 0) {
        outcomes.push({ siteCode: site.code, status: 'skipped_no_findings' });
        continue;
      }

      const recipients = (
        await prisma.alertRecipient.findMany({
          where: { site_id: site.id, active: true },
          select: { email: true },
        })
      ).map((r) => r.email);
      if (recipients.length === 0) {
        outcomes.push({ siteCode: site.code, status: 'skipped_no_recipients' });
        continue;
      }

      const findings: DigestFinding[] = findingRows.map((f) => ({
        id: f.id,
        checkCode: f.check_code as CheckCode,
        severity: f.severity as Severity,
        windowStartISO: f.window_start.toISOString().slice(0, 10),
        windowEndISO: f.window_end.toISOString().slice(0, 10),
      }));

      const subject = `DR3-Vision alerts — ${site.name} — ${findings.length} open finding${findings.length === 1 ? '' : 's'}`;
      const htmlBody = renderDigestHtml(site, findings);

      // Per-recipient send so one bad address never blocks the others.
      const results = [];
      for (const to of recipients) {
        results.push(await sendSystemEmail({ to, subject, htmlBody, fromDisplayName: 'DR3-Vision Alerts' }));
      }

      // M365 not configured → fail-open no-op: don't log, don't page (retry next tick).
      if (results.some((r) => r.disabled)) {
        log.warn({ siteCode: site.code }, '[alert-digest] M365 disabled — digest not sent (fail-open)');
        outcomes.push({ siteCode: site.code, status: 'disabled', findingCount: findings.length });
        continue;
      }

      const delivered = results.filter((r) => r.delivered).length;
      const lastStatus = results.map((r) => r.lastStatus).filter((v): v is number => v !== undefined).pop() ?? null;
      const messageId = (results.find((r) => r.delivered) ?? results[0])?.messageId ?? null;

      await prisma.alertDigestLog.create({
        data: {
          site_id: site.id,
          digest_date: digestDate,
          finding_count: findings.length,
          recipient_count: recipients.length,
          delivered_count: delivered,
          graph_message_id: messageId,
          last_status: lastStatus,
        },
      });
      log.info(
        { siteCode: site.code, findings: findings.length, recipients: recipients.length, delivered },
        '[alert-digest] digest processed',
      );

      if (delivered === 0) {
        await publishNtfy({
          topic: 'dr3-vision-system',
          title: `Alert digest delivery failed for ${site.code}`,
          body: `0/${recipients.length} recipients received the ${findings.length}-finding alert digest (last status ${lastStatus ?? 'network'}). Retry from the audit surface.`,
          priority: 'high',
          tags: ['error', 'alert-digest', 'dr3-vision'],
          fingerprint: `alert-digest-failed:${site.code}`,
          cooldownMs: DIGEST_FAIL_COOLDOWN_MS,
        });
        outcomes.push({ siteCode: site.code, status: 'failed', findingCount: findings.length, delivered, attempted: recipients.length });
      } else {
        outcomes.push({ siteCode: site.code, status: 'sent', findingCount: findings.length, delivered, attempted: recipients.length });
      }
    } catch (err) {
      log.error({ err, siteCode: site.code }, '[alert-digest] site fire failed (non-fatal)');
      // Continue with the other sites; never throw out of the fire.
    }
  }

  return { outcomes };
}
