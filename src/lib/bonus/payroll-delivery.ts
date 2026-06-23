// Post-signature payroll delivery (ADR-0019 §5, ADR-0021).
//
// Extracted from the sign route (T-110) so BOTH the manual 2nd-signature path
// (`/api/bonus/months/[id]/sign`) and the system auto-override path (T-205
// escalation cron) fire the IDENTICAL post-signature side-effect chain: render
// the bonus PDF (Playwright → R2) then send it to payroll via Microsoft Graph.
//
// Background-safe: the caller never awaits this — the signing user (or the cron
// fire) must not block on Chromium / Graph. Both steps are individually
// fail-safe: generateBonusPdf rethrows on failure (swallowed + logged here so a
// PDF/mail failure never crashes the process), and sendPayrollPdf is fail-open.
// Mail only runs if the PDF succeeded — there is nothing to attach otherwise.
//
// signed -> paid (T-211 step 5): on a CONFIRMED Graph delivery (sendPayrollPdf
// returns `delivered: true` — a real 202 with a message id), this advances the
// period `signed -> paid` through the state-machine (audited). The transition
// fires ONLY after the mail actually succeeds and ONLY when the period is still
// `signed` — never on a fail-open no-op (`disabled: true`, M365/R2 unconfigured)
// and never on an exhausted/failed send. Leaving a genuinely-undelivered period
// `signed` is load-bearing: it lets the T-206 t4 09:00 PT deadline-miss check
// (which keys off `state != 'paid'`) alert on a REAL miss while staying silent
// for a period that did deliver.

import { prisma } from '@/lib/prisma';
import { generateBonusPdf, PayoutReconciliationError } from '@/lib/bonus/pdf';
import { bareSiteName } from '@/lib/bonus/pdf-data';
import { sendPayrollPdf } from '@/lib/m365-mail';
import { transitionMonth, TransitionError } from '@/lib/bonus/state-machine';
import { assertPayoutReconciles, assertNotSuspectedWrongZero } from '@/lib/bonus/reconcile-fetch';
import { publishNtfy } from '@/lib/ntfy';
import { log, newRequestId } from '@/lib/observability/logger';

const APP_BASE_URL = (process.env['APP_BASE_URL'] ?? 'https://dr3-vision.svdp.us').replace(
  /\/+$/,
  '',
);

/** P0-3: page the operator on an otherwise-silent payroll-delivery failure. */
async function pagePayrollFailure(opts: {
  monthId: string;
  title: string;
  body: string;
  fingerprint: string;
  priority: 'high' | 'urgent';
}): Promise<void> {
  await publishNtfy({
    topic: 'dr3-vision-system',
    title: opts.title,
    body: opts.body,
    priority: opts.priority,
    tags: ['error', 'bonus', 'payroll', 'dr3-vision'],
    clickUrl: `${APP_BASE_URL}/bonus/months/${opts.monthId}`,
    fingerprint: opts.fingerprint,
  });
}

/**
 * Fire the post-signature payroll delivery for `monthId` WITHOUT blocking the
 * caller. Generates the signed PDF, fetches it from R2, and mails it to payroll.
 * Never throws; logs each failure stage.
 */
export function triggerPayrollDelivery(monthId: string): void {
  const requestId = newRequestId();
  void (async () => {
    try {
      await generateBonusPdf(monthId);
    } catch (err) {
      // P0-1: a reconciliation refusal already fired its own urgent page in
      // generateBonusPdf — do NOT double-page here; just log and stop.
      if (err instanceof PayoutReconciliationError) {
        log.error(
          { requestId, monthId },
          '[payroll-delivery] PDF generation refused by reconciliation tripwire; skipping mail (already paged)',
        );
        return;
      }
      // P0-3: PDF generation failed for a signed period → an unsigned-but-due
      // payroll report will silently never ship. Page the operator (urgent — a
      // signed period missing its PDF blocks payroll) then stop.
      log.error(
        { requestId, monthId, err },
        '[payroll-delivery] PDF generation failed; skipping mail',
      );
      await pagePayrollFailure({
        monthId,
        title: 'Bonus PDF generation failed for a signed period',
        body: `generateBonusPdf threw for month ${monthId}. The period is signed but no payroll PDF was produced, so nothing will be delivered to payroll. Re-trigger from the manager portal. Error: ${
          err instanceof Error ? err.message : String(err)
        }`,
        fingerprint: `payroll-pdf-failed:${monthId}`,
        priority: 'urgent',
      });
      return;
    }
    try {
      const month = await prisma.bonusPayPeriod.findUnique({
        where: { id: monthId },
        select: {
          pdf_storage_key: true,
          period_start: true,
          amended_from_period_id: true,
          // Site-aware subject/body (Eugene must read "Eugene", not "Woodland").
          // `sites.name` is seeded with the "DR3 " prefix; bareSiteName strips it
          // so the copy reads the bare site name, matching the T-209 PDF title.
          site: { select: { name: true } },
        },
      });
      if (!month?.pdf_storage_key) {
        // P0-3: PDF gen reported success but the key never persisted — payroll
        // would silently get nothing. Page (urgent — signed period, no artifact).
        log.error(
          { requestId, monthId },
          '[payroll-delivery] no pdf_storage_key after generation; skipping mail',
        );
        await pagePayrollFailure({
          monthId,
          title: 'Bonus PDF missing after generation (no storage key)',
          body: `Month ${monthId} reported successful PDF generation but has no pdf_storage_key, so the signed payroll PDF cannot be attached or delivered. Re-trigger generation from the manager portal.`,
          fingerprint: `payroll-pdf-missing-key:${monthId}`,
          priority: 'urgent',
        });
        return;
      }
      const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
      const accountId = process.env['R2_ACCOUNT_ID'];
      const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
      const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];
      const bucket = process.env['R2_BUCKET'];
      if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
        // P0-3: R2 unconfigured. This is a CONFIG-ABSENT state, not a transient
        // failure — but a signed period DID generate a key (we passed the check
        // above), so reaching here means R2 creds went missing AFTER the PDF was
        // stored. That blocks delivery and is operator-actionable → page (high).
        log.warn(
          { requestId, monthId },
          '[payroll-delivery] R2 not configured; cannot attach pdf for mail',
        );
        await pagePayrollFailure({
          monthId,
          title: 'R2 not configured — cannot deliver signed bonus PDF',
          body: `Month ${monthId} is signed with a stored PDF, but R2 credentials are not configured in this process, so the PDF cannot be fetched to mail to payroll. Check the R2_* env on the app host.`,
          fingerprint: `payroll-r2-unconfigured:${monthId}`,
          priority: 'high',
        });
        return;
      }
      const r2 = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      });
      const obj = await r2.send(
        new GetObjectCommand({ Bucket: bucket, Key: month.pdf_storage_key }),
      );
      const pdfBuffer = Buffer.from(await obj.Body!.transformToByteArray());

      // P0-1 + P0-2 pre-send gates (ADR-0033), defense-in-depth on top of the
      // tripwire in generateBonusPdf. Recompute ONCE and run both:
      //   - reconciliation: the locked total must match the recompute (refuse +
      //     urgent page on a disagreement; the page was already fired inside).
      //   - zero-guard: a locked $0 that DISAGREES with the entries is a suspected
      //     wrong $0 → block + urgent page. A locked $0 that agrees (genuinely
      //     sub-threshold) is allowed.
      // A refused PDF must NEVER be mailed to payroll.
      const reconcile = await assertPayoutReconciles(monthId);
      if (!reconcile.pass) {
        log.error(
          { requestId, monthId },
          '[payroll-delivery] reconciliation failed at send time; refusing to mail (already paged)',
        );
        return;
      }
      const zeroGuard = await assertNotSuspectedWrongZero(monthId, reconcile.period);
      if (!zeroGuard.pass) {
        log.error(
          { requestId, monthId },
          '[payroll-delivery] suspected wrong $0 payout; blocking mail (already paged)',
        );
        return;
      }

      const ym = `${month.period_start.getUTCFullYear()}-${String(
        month.period_start.getUTCMonth() + 1,
      ).padStart(2, '0')}`;
      const site = bareSiteName(month.site.name);
      const isAmendment = month.amended_from_period_id !== null;
      const sendResult = await sendPayrollPdf({
        monthId,
        pdfBuffer,
        filename: `bonus-${ym}.pdf`,
        subject: `${isAmendment ? '[AMENDED] ' : ''}${site} processor bonus — ${ym}`,
        htmlBody: `<p>The signed ${site} processor bonus report for ${ym} is attached.</p>`,
        isAmendment,
      });

      // Confirmed Graph delivery (202 + message id) is the ONLY trigger for
      // signed -> paid. A fail-open no-op (disabled: M365/R2 unconfigured) or an
      // exhausted/failed send leaves the period `signed` so the t4 09:00 PT
      // deadline-miss check alerts on a real miss. sendPayrollPdf already
      // persisted payroll_sent_at + payroll_message_id on success.
      if (sendResult.delivered) {
        await markPaid(monthId, requestId);
      }
    } catch (err) {
      log.error({ requestId, monthId, err }, '[payroll-delivery] payroll mail-send failed');
    }
  })();
}

/**
 * Advance the period `signed -> paid` through the audited state machine after a
 * confirmed payroll delivery. Idempotent against re-fires: if the period is
 * already `paid` (a prior delivery, or a retry), the illegal-transition guard
 * rejects `paid -> paid` and we swallow it as a no-op. Any other transition
 * failure is logged but never rethrown — the mail already shipped; failing to
 * flip the state must not crash the background task (it degrades to a t4 alert,
 * which is the safe direction).
 */
async function markPaid(monthId: string, requestId: string): Promise<void> {
  try {
    await transitionMonth({
      db: prisma as never,
      monthId,
      to: 'paid',
      actor: { label: 'system:payroll-delivered' },
    });
  } catch (err) {
    if (err instanceof TransitionError) {
      // Period was not `signed` (e.g. already `paid` from a prior delivery, or
      // it was amended out from under us). Not an error — the delivery stands.
      log.info(
        { requestId, monthId, from: err.from },
        '[payroll-delivery] skipped signed -> paid (period not in signed state)',
      );
      return;
    }
    log.error(
      { requestId, monthId, err },
      '[payroll-delivery] mail delivered but signed -> paid transition failed',
    );
  }
}
