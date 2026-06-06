// Signature-request emails (ADR-0019 §5a, T-125).
//
// Actively prompt the next signer by email when their signature is required, so
// they don't have to remember to check the portal:
//   1. Month closes (draft -> pending_signatures, incl. amendment re-open) -> email
//      the facility-manager signer (the "facility" slot).
//   2. First signature lands (pending_signatures -> partially_signed) -> email the
//      still-unsigned slot's signer (normally the "ops" slot; if a slot was
//      filled out of order via override, this targets whichever slot remains).
//
// Recipients are resolved DYNAMICALLY from the users table (never hardcoded):
//   - facility-manager slot ("facility") -> active manager whose primary_site_id is
//     the bonus site (Woodland)
//   - operations-manager slot ("ops") -> active manager whose primary_site_id is
//     null (the both-sites ops manager)
//
// Channel: Microsoft Graph email via sendSystemEmail (ADR-0021) — NOT ntfy (ntfy is
// Bill's incident channel per ADR-0037). FAIL-OPEN: a mail outage (or M365 not yet
// configured) never blocks signing; it logs and returns. Every successful send is
// audited as actor_label 'system:signature-request'. Fires once at the transition
// (no polling), so no de-dup state is needed; reminder re-sends are out of scope for V2.

import { prisma } from '@/lib/prisma';
import { sendSystemEmail } from '@/lib/m365-mail';
import { writeAudit } from '@/lib/audit';
import { log } from '@/lib/observability/logger';
import type { SignatureSlot } from './signatures';

const APP_BASE_URL = (process.env['APP_BASE_URL'] ?? 'https://dr3-vision.svdp.us').replace(
  /\/+$/,
  '',
);

export interface SlotSigner {
  id: string;
  name: string;
  email: string | null;
}

/** Minimal `bonusPayPeriod` surface this module needs (Prisma client or a test double). */
export interface SignatureNotificationDb {
  bonusPayPeriod: {
    findUnique: (args: {
      where: { id: string };
      select?: unknown;
    }) => Promise<SignatureMonthRow | null>;
  };
  user: {
    findFirst: (args: { where: unknown; select?: unknown }) => Promise<SlotSigner | null>;
  };
}

export interface SignatureMonthRow {
  id: string;
  site_id: string;
  period_start: Date;
  state: string;
  facility_signed_by_user_id: string | null;
  ops_signed_by_user_id: string | null;
}

export interface NotifyResult {
  notified: boolean;
  slot?: SignatureSlot;
  reason?: string;
}

/** Resolve the user responsible for a signature slot from the users table. */
export async function resolveSlotSigner(
  slot: SignatureSlot,
  siteId: string,
  db: SignatureNotificationDb = prisma as unknown as SignatureNotificationDb,
): Promise<SlotSigner | null> {
  const base = { role: 'manager', is_active: true, deleted_at: null } as const;
  const where =
    slot === 'facility'
      ? { ...base, primary_site_id: siteId } // facility manager (Woodland)
      : { ...base, primary_site_id: null }; // both-sites operations manager
  return db.user.findFirst({ where, select: { id: true, name: true, email: true } });
}

/** The first still-unsigned slot, in signing order (facility first). Null if both signed. */
function unsignedSlot(month: SignatureMonthRow): SignatureSlot | null {
  if (!month.facility_signed_by_user_id) return 'facility';
  if (!month.ops_signed_by_user_id) return 'ops';
  return null;
}

function monthLabel(monthStart: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(monthStart);
}

function buildEmail(slot: SignatureSlot, month: SignatureMonthRow) {
  const label = monthLabel(month.period_start);
  const url = `${APP_BASE_URL}/bonus/months/${month.id}`;
  const lead =
    slot === 'facility'
      ? `The ${label} DR3 Woodland processor bonus report is ready for your signature.`
      : `The ${label} DR3 Woodland processor bonus report has its first signature; your signature is now needed to finalize it.`;
  return {
    subject: `[DR3 Bonus] Signature needed — ${label}`,
    htmlBody:
      `<p>${lead}</p>` +
      `<p><a href="${url}">Open the ${label} bonus report to review and sign</a>.</p>` +
      `<p>Once both signatures are in, the signed PDF is generated and delivered to payroll automatically.</p>` +
      `<hr/><p style="color:#667">This is an automated message from DR3 Vision. Do not reply to this address.</p>`,
  };
}

/**
 * Email the next required signer for a month, if it is awaiting signatures.
 * Fail-open: returns { notified:false, reason } rather than throwing on any
 * non-signable state, missing signer, missing email, or disabled/failed mail.
 */
export async function notifyPendingSigner(
  monthId: string,
  db: SignatureNotificationDb = prisma as unknown as SignatureNotificationDb,
): Promise<NotifyResult> {
  const month = await db.bonusPayPeriod.findUnique({
    where: { id: monthId },
    select: {
      id: true,
      site_id: true,
      period_start: true,
      state: true,
      facility_signed_by_user_id: true,
      ops_signed_by_user_id: true,
    },
  });
  if (!month) return { notified: false, reason: 'month_not_found' };
  if (month.state !== 'pending_signatures' && month.state !== 'partially_signed') {
    return { notified: false, reason: 'not_awaiting_signatures' };
  }

  const slot = unsignedSlot(month);
  if (!slot) return { notified: false, reason: 'fully_signed' };

  const signer = await resolveSlotSigner(slot, month.site_id, db);
  if (!signer?.email) {
    log.warn(
      { month_id: monthId, slot, signer_id: signer?.id ?? null },
      'signature-request: no email for the responsible signer; skipping',
    );
    return { notified: false, slot, reason: 'no_signer_email' };
  }

  const { subject, htmlBody } = buildEmail(slot, month);
  const res = await sendSystemEmail({ to: signer.email, subject, htmlBody, importance: 'high' });

  if (res.disabled) {
    log.info(
      { month_id: monthId, slot },
      'signature-request: M365 not configured; skipping (fail-open)',
    );
    return { notified: false, slot, reason: 'mail_disabled' };
  }
  if (!res.delivered) {
    log.warn(
      { month_id: monthId, slot, last_status: res.lastStatus },
      'signature-request: mail not delivered',
    );
    return { notified: false, slot, reason: 'mail_failed' };
  }

  await writeAudit({
    actor_label: 'system:signature-request',
    action: 'insert',
    table_name: 'bonus_pay_periods',
    row_id: monthId,
    after: { slot, to: signer.email, message_id: res.messageId, subject },
  });
  log.info({ month_id: monthId, slot, to: signer.email }, 'signature-request email sent');
  return { notified: true, slot };
}
