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
// Recipients are resolved from the AUTHORITATIVE `bonus_signature_chains` row for
// the period's site (never hardcoded, never a legacy heuristic) — the SAME source
// the sign route (naturalSlotFor), the month page, and signer-names.ts use:
//   - facility slot ("facility") -> the chain's facility_signer_user_id
//   - ops slot ("ops")           -> the chain's ops_signer_user_id
// then that user is loaded (active, not deleted) for their email.
//
// HISTORY: an earlier heuristic resolved the ops signer as "the active manager
// whose primary_site_id IS NULL". That DISAGREED with the chain whenever a site's
// ops signer has a real primary_site_id (e.g. Woodland's ops signer Morena Gomez,
// whose primary_site_id IS Woodland): the null query returned no one, so the ops
// signer was NEVER emailed their signature request. That contributed to a missed
// payroll deadline (incident 2026-06-22). Resolving from the chain fixes it.
//
// Channel: Microsoft Graph email via sendSystemEmail (ADR-0021) — NOT ntfy (ntfy is
// Bill's incident channel per ADR-0037). FAIL-OPEN: a mail outage (or M365 not yet
// configured) never blocks signing; it logs and returns. Every successful send is
// audited as actor_label 'system:signature-request'. Fires once at the transition
// (no polling), so no de-dup state is needed; reminder re-sends are out of scope for V2.

import { prisma } from '@/lib/prisma';
import { sendSystemEmail } from '@/lib/m365-mail';
import { writeAudit } from '@/lib/audit';
import { publishNtfy } from '@/lib/ntfy';
import { bareSiteName } from '@/lib/bonus/pdf-data';
import { log } from '@/lib/observability/logger';
import { getSignatureChain, type SignatureChainDb } from '@/lib/bonus/signature-chain';
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

/**
 * Minimal Prisma surface this module needs (Prisma client or a test double).
 * Extends `SignatureChainDb` because the signer is now resolved FROM the chain
 * (`bonusSignatureChain.findUnique`) and then loaded from `user`.
 */
export interface SignatureNotificationDb extends SignatureChainDb {
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
  /** Site relation — drives the site-aware email copy (Woodland vs Eugene). */
  site: { name: string };
}

export interface NotifyResult {
  notified: boolean;
  slot?: SignatureSlot;
  reason?: string;
}

/**
 * Resolve the user responsible for a signature slot at a site.
 *
 * Authoritative source: the `bonus_signature_chains` row for `siteId` — the SAME
 * source the sign route (`naturalSlotFor`), the month page, and signer-names.ts
 * use. We read the chain, pick the slot's configured signer UUID, and load that
 * user (active, not deleted). Returns null only when the chain names no signer
 * for the slot, or that user is inactive/deleted/absent.
 */
export async function resolveSlotSigner(
  slot: SignatureSlot,
  siteId: string,
  db: SignatureNotificationDb = prisma as unknown as SignatureNotificationDb,
): Promise<SlotSigner | null> {
  const chain = await getSignatureChain(siteId, db);
  const signerId = slot === 'facility' ? chain.facility_signer_user_id : chain.ops_signer_user_id;
  if (!signerId) return null;
  return db.user.findFirst({
    where: { id: signerId, is_active: true, deleted_at: null },
    select: { id: true, name: true, email: true },
  });
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
  // Site-aware copy: derive the display name from the period's site so Eugene
  // reads "Eugene" and Woodland stays "Woodland". `sites.name` carries the
  // seeded "DR3 " prefix; bareSiteName strips it, then the "DR3 " below restores
  // the same wording Woodland had ("DR3 Woodland …"), matching the T-209 PDF.
  const site = bareSiteName(month.site.name);
  const lead =
    slot === 'facility'
      ? `The ${label} DR3 ${site} processor bonus report is ready for your signature.`
      : `The ${label} DR3 ${site} processor bonus report has its first signature; your signature is now needed to finalize it.`;
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
      site: { select: { name: true } },
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
    // P0-3 (a): a signature is REQUIRED but the responsible signer cannot be
    // resolved (chain names no signer / user inactive) or has no email. This is
    // exactly the silent failure that caused the 2026-06-22 missed payroll
    // deadline — the ops signer was never emailed and nobody knew. Page (high):
    // the period is stuck awaiting a signature that no one is being asked for.
    log.warn(
      { month_id: monthId, slot, signer_id: signer?.id ?? null },
      'signature-request: no email for the responsible signer; skipping',
    );
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Bonus signer cannot be notified — signature stuck',
      body: `Month ${monthId} is awaiting the ${slot} signature, but ${
        signer
          ? `the configured signer has no email on file (signer ${signer.id})`
          : 'no active signer is resolvable from the signature chain'
      }. No signature request was sent, so the period will silently miss its deadline unless someone signs manually. Fix the signer/email in the chain or sign via override.`,
      priority: 'high',
      tags: ['error', 'bonus', 'payroll', 'signature', 'dr3-vision'],
      clickUrl: `${APP_BASE_URL}/bonus/months/${monthId}`,
      fingerprint: `signer-unresolved:${monthId}:${slot}`,
    });
    return { notified: false, slot, reason: 'no_signer_email' };
  }

  const { subject, htmlBody } = buildEmail(slot, month);
  const res = await sendSystemEmail({ to: signer.email, subject, htmlBody, importance: 'high' });

  if (res.disabled) {
    // CONFIG-ABSENT (M365 not configured) is fail-open and stays SILENT — the app
    // must boot/serve without M365 (hard rule #5). Do not page on a config gap.
    log.info(
      { month_id: monthId, slot },
      'signature-request: M365 not configured; skipping (fail-open)',
    );
    return { notified: false, slot, reason: 'mail_disabled' };
  }
  if (!res.delivered) {
    // P0-3 (a): M365 IS configured but the signature-request mail failed to send.
    // A real (not config-absent) failure that leaves the signer un-prompted →
    // page (high). Per-month+slot fingerprint dedupes repeated attempts.
    log.warn(
      { month_id: monthId, slot, last_status: res.lastStatus },
      'signature-request: mail not delivered',
    );
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Bonus signature-request email failed to send',
      body: `Month ${monthId}: the ${slot} signature-request email to ${signer.email} failed (last status ${res.lastStatus ?? 'network'}). The signer was not prompted; the period may miss its signing deadline. Investigate M365/Graph.`,
      priority: 'high',
      tags: ['error', 'bonus', 'payroll', 'signature', 'dr3-vision'],
      clickUrl: `${APP_BASE_URL}/bonus/months/${monthId}`,
      fingerprint: `signer-mail-failed:${monthId}:${slot}`,
    });
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
