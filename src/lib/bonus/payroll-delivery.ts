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

import { prisma } from '@/lib/prisma';
import { generateBonusPdf } from '@/lib/bonus/pdf';
import { sendPayrollPdf } from '@/lib/m365-mail';
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
      log.error({ requestId, monthId, err }, '[payroll-delivery] PDF generation failed; skipping mail');
      return;
    }
    try {
      const month = await prisma.bonusPayPeriod.findUnique({
        where: { id: monthId },
        select: { pdf_storage_key: true, period_start: true, amended_from_period_id: true },
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
        log.warn({ requestId, monthId }, '[payroll-delivery] R2 not configured; cannot attach pdf for mail');
        return;
      }
      const r2 = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      });
      const obj = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: month.pdf_storage_key }));
      const pdfBuffer = Buffer.from(await obj.Body!.transformToByteArray());
      const ym = `${month.period_start.getUTCFullYear()}-${String(
        month.period_start.getUTCMonth() + 1,
      ).padStart(2, '0')}`;
      const isAmendment = month.amended_from_period_id !== null;
      await sendPayrollPdf({
        monthId,
        pdfBuffer,
        filename: `bonus-${ym}.pdf`,
        subject: `${isAmendment ? '[AMENDED] ' : ''}Woodland processor bonus — ${ym}`,
        htmlBody: `<p>The signed Woodland processor bonus report for ${ym} is attached.</p>`,
        isAmendment,
      });
    } catch (err) {
      log.error({ requestId, monthId, err }, '[payroll-delivery] payroll mail-send failed');
    }
  })();
}
