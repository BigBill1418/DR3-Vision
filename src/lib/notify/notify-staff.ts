// ADR-0047 — notifyStaff(): the ONLY sanctioned path to non-admin (staff)
// recipients. Feature code must not import `sendSystemEmail` directly (enforced
// by the repo test `no-direct-mail.test.ts`); it calls notifyStaff, which:
//
//   1. resolves the (surface_code, site) rollout state — an UNREGISTERED surface
//      throws {@link UnregisteredSurfaceError} (never a silent send);
//   2. LIVE  ⇒ delivers to the real intended recipients;
//   3. PILOT ⇒ reroutes to ALL active admins with a `[PILOT — would have sent
//      to: …]` subject prefix + a body banner, so Bill validates BOTH content
//      and targeting before ramp;
//   4. audits + logs the send decision every time (never silent).
//
// This wraps the transport core; it does not re-implement retries/fail-open —
// `sendSystemEmail` owns that (and returns { disabled:true } when M365 is unset).

import { prisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import {
  sendSystemEmail,
  type OversizeAttachmentReport,
  type SystemEmailResult,
} from '@/lib/m365-mail';
import { writeAudit } from '@/lib/audit';
import { log } from '@/lib/observability/logger';
import { getNotificationState, activeAdminRecipients } from './rollout';

export interface StaffRecipient {
  address: string;
  name?: string;
}

export interface NotifyStaffArgs {
  /** Registered notification surface code (see NOTIFY_SURFACE). */
  surfaceCode: string;
  /** Per-site surface: pass the site. Org-wide surface: pass null. */
  site: { id: string; code?: string } | null;
  /** The REAL intended audience (addresses, or address+name). */
  recipients: ReadonlyArray<string | StaffRecipient>;
  subject: string;
  htmlBody: string;
  importance?: 'low' | 'normal' | 'high';
  fromDisplayName?: string;
  replyTo?: string;
  cc?: string[];
  /**
   * Optional file attachments, passed through to the transport (ADR-0046 §3 —
   * the AP decision mail carries a stamped PDF). The chokepoint is preserved:
   * feature code still calls notifyStaff(), never sendSystemEmail() directly.
   */
  attachments?: Array<{ filename: string; buffer: Buffer; contentType?: string }>;
  /** Test seam. */
  db?: PrismaClient;
}

export type NotifyStaffMode = 'live' | 'pilot';

export interface NotifyStaffResult {
  surfaceCode: string;
  siteId: string | null;
  mode: NotifyStaffMode;
  /** The real audience (addresses) — what a live send would target. */
  intendedRecipients: string[];
  /** Who it actually went to (admins in pilot; == intended in live). */
  actualRecipients: string[];
  sends: SystemEmailResult[];
  delivered: number;
  /** True when M365 is unconfigured (fail-open no-op across all sends). */
  disabled: boolean;
  /**
   * Set when the attachments exceeded the Graph inline-send ceiling, so NOTHING
   * was posted for any recipient. The payload is identical for every recipient,
   * so this trips for all of them at once and one report describes the whole
   * send. Distinct from `disabled` (config) and from `delivered === 0` (transport):
   * this is a size refusal, and it is the caller's job to say so out loud rather
   * than let an approved document quietly fail to arrive.
   */
  oversize: OversizeAttachmentReport | null;
}

function normalize(r: string | StaffRecipient): StaffRecipient {
  return typeof r === 'string' ? { address: r } : r;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PILOT_SUBJECT_MAX_NAMES = 6;

function pilotSubjectPrefix(intended: string[]): string {
  const shown = intended.slice(0, PILOT_SUBJECT_MAX_NAMES).join(', ');
  const extra =
    intended.length > PILOT_SUBJECT_MAX_NAMES
      ? `, +${intended.length - PILOT_SUBJECT_MAX_NAMES} more`
      : '';
  const who = intended.length > 0 ? `${shown}${extra}` : 'no active recipients';
  return `[PILOT — would have sent to: ${who}] `;
}

function pilotBanner(
  surfaceCode: string,
  siteCode: string | undefined,
  intended: string[],
): string {
  const siteLabel = siteCode ? ` · site ${escapeHtml(siteCode)}` : ' · org-wide';
  const who =
    intended.length > 0
      ? escapeHtml(intended.join(', '))
      : '<em>no active recipients configured</em>';
  return `<div style="background:#fff3cd;border:2px solid #b8860b;color:#664d03;padding:12px 16px;margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5">
    <strong>PILOT MODE — not sent to staff.</strong> The DR3-Vision surface
    <code>${escapeHtml(surfaceCode)}</code>${siteLabel} is in <strong>pilot</strong> rollout (ADR-0047).
    In live mode this would have gone to: ${who}. You are receiving it as an admin to validate the
    content <em>and</em> the targeting before it is ramped from the admin rollout panel.
  </div>`;
}

/** Inject the pilot banner immediately after the opening <body> tag (or prepend). */
function withBanner(html: string, banner: string): string {
  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, (m) => `${m}${banner}`);
  return `${banner}${html}`;
}

/**
 * Send staff-facing mail through the rollout gate. Returns a structured result;
 * throws only {@link UnregisteredSurfaceError} (the one hard failure — an
 * unregistered surface must never fall through to a raw send).
 */
export async function notifyStaff(args: NotifyStaffArgs): Promise<NotifyStaffResult> {
  const db = args.db ?? prisma;
  const siteId = args.site?.id ?? null;
  const intended = args.recipients.map(normalize);
  const intendedAddrs = intended.map((r) => r.address);

  // Throws UnregisteredSurfaceError if the surface is not registered.
  const state = await getNotificationState(args.surfaceCode, siteId, db);

  let actual: StaffRecipient[];
  let subject: string;
  let htmlBody: string;

  if (state === 'live') {
    actual = intended;
    subject = args.subject;
    htmlBody = args.htmlBody;
  } else {
    actual = await activeAdminRecipients(db);
    subject = `${pilotSubjectPrefix(intendedAddrs)}${args.subject}`;
    htmlBody = withBanner(
      args.htmlBody,
      pilotBanner(args.surfaceCode, args.site?.code, intendedAddrs),
    );
  }

  const sends: SystemEmailResult[] = [];
  for (const to of actual) {
    sends.push(
      await sendSystemEmail({
        to: to.name ? { address: to.address, name: to.name } : to.address,
        subject,
        htmlBody,
        ...(args.importance ? { importance: args.importance } : {}),
        ...(args.fromDisplayName ? { fromDisplayName: args.fromDisplayName } : {}),
        ...(args.replyTo ? { replyTo: args.replyTo } : {}),
        ...(args.cc ? { cc: args.cc } : {}),
        ...(args.attachments && args.attachments.length > 0
          ? { attachments: args.attachments }
          : {}),
      }),
    );
  }

  const delivered = sends.filter((s) => s.delivered).length;
  const disabled = sends.length > 0 && sends.every((s) => s.disabled);
  const oversize = sends.find((s) => s.oversize !== null)?.oversize ?? null;
  const actualAddrs = actual.map((r) => r.address);

  // Audit every send decision (append-only). Addresses recorded for targeting
  // evidence; the mail BODY (which may carry visitor PII, e.g. contact-intake) is
  // never audited or logged here.
  await writeAudit({
    actor_label: 'system:notify-staff',
    action: 'insert',
    table_name: 'notify_staff',
    row_id: `${args.surfaceCode}:${siteId ?? 'org'}`,
    after: {
      surface_code: args.surfaceCode,
      site_id: siteId,
      mode: state,
      intended_count: intendedAddrs.length,
      intended: intendedAddrs,
      actual_count: actualAddrs.length,
      actual: actualAddrs,
      delivered,
      disabled,
      // Recorded on the audit row so "was this ever actually sent?" is answerable
      // from the audit trail alone, without correlating application logs.
      oversize_refused: oversize !== null,
      ...(oversize
        ? {
            oversize_raw_bytes: oversize.rawAttachmentBytes,
            oversize_encoded_bytes: oversize.encodedAttachmentBytes,
            oversize_limit_bytes: oversize.limitBytes,
            oversize_filenames: oversize.filenames,
          }
        : {}),
    },
  });

  log.info(
    {
      surface: args.surfaceCode,
      siteId,
      mode: state,
      intended: intendedAddrs.length,
      actual: actualAddrs.length,
      delivered,
      disabled,
      oversizeRefused: oversize !== null,
    },
    '[notify-staff] send decision',
  );

  return {
    surfaceCode: args.surfaceCode,
    siteId,
    mode: state,
    intendedRecipients: intendedAddrs,
    actualRecipients: actualAddrs,
    sends,
    delivered,
    disabled,
    oversize,
  };
}
