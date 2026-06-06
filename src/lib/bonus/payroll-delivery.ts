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
import { generateBonusPdf } from '@/lib/bonus/pdf';
import { bareSiteName } from '@/lib/bonus/pdf-data';
import { sendPayrollPdf } from '@/lib/m365-mail';
import { transitionMonth, TransitionError } from '@/lib/bonus/state-machine';
import { log, newRequestId } from '@/lib/observability/logger';

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
      log.error(
        { requestId, monthId, err },
        '[payroll-delivery] PDF generation failed; skipping mail',
      );
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
        log.error(
          { requestId, monthId },
          '[payroll-delivery] no pdf_storage_key after generation; skipping mail',
        );
        return;
      }
      const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
      const accountId = process.env['R2_ACCOUNT_ID'];
      const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
      const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];
      const bucket = process.env['R2_BUCKET'];
      if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
        log.warn(
          { requestId, monthId },
          '[payroll-delivery] R2 not configured; cannot attach pdf for mail',
        );
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
