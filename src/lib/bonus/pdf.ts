// T-112 — Bonus PDF generator (ADR-0019 §10).
//
// `generateBonusPdf(monthId)` launches headless Chromium (Playwright),
// navigates to the INTERNAL co-branded report page
// (`/internal/bonus-pdf/<monthId>`), prints it to a PDF buffer, uploads the
// buffer to Cloudflare R2, and persists `pdf_storage_key` + `pdf_generated_at`
// on the bonus_pay_periods row.
//
// CALLED AS A SIDE-EFFECT of the 2nd signature (T-110): it MUST be background-
// safe — it never throws into the signing request. The caller fires it without
// awaiting the result on the request path; on failure here the row simply keeps
// a null pdf_storage_key and the operator can re-trigger generation.
//
// AUTH: the internal page is session-less and protected only by its own
// loopback / cf-connecting-ip guard, so we navigate over localhost (no Cloudflare
// edge in the path => no cf-connecting-ip header => the guard lets us render).

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { r2UploadSuccess } from '@/lib/observability/metrics';
import { log } from '@/lib/observability/logger';
import { pdfMonthYm } from '@/lib/bonus/pdf-data';
import { assertPayoutReconciles } from '@/lib/bonus/reconcile-fetch';

export interface GenerateBonusPdfResult {
  storageKey: string;
}

/**
 * Thrown when the P0-1 reconciliation tripwire (ADR-0033) refuses generation
 * because the locked total disagrees with the recomputed grand total. Distinct
 * from a render/R2 failure: nothing was rendered or uploaded, and the urgent
 * `payout-reconcile-mismatch` page has already fired. The caller must NOT mail.
 */
export class PayoutReconciliationError extends Error {
  constructor(monthId: string) {
    super(`bonus month ${monthId} failed payout reconciliation; PDF generation refused`);
    this.name = 'PayoutReconciliationError';
  }
}

function r2Client(): S3Client {
  const accountId = process.env['R2_ACCOUNT_ID'];
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 not configured');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

/** Base URL for the internal render. Defaults to loopback (no CF edge). */
function internalBaseUrl(): string {
  const explicit = process.env['INTERNAL_PDF_BASE_URL'];
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = process.env['PORT'] ?? '3000';
  return `http://127.0.0.1:${port}`;
}

/**
 * Render the month's report page to a PDF buffer with headless Chromium.
 * Isolated so the browser is always closed even on a navigation/print failure.
 */
async function renderPdfBuffer(monthId: string): Promise<Buffer> {
  // Lazy import: Playwright is heavy and Node-only; keep it out of any bundle
  // that merely imports this module's types.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = `${internalBaseUrl()}/internal/bonus-pdf/${encodeURIComponent(monthId)}`;
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    if (!resp || !resp.ok()) {
      throw new Error(`internal pdf page returned ${resp ? resp.status() : 'no response'}`);
    }
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

/**
 * Generate, upload, and persist the signed month's PDF. Background-safe: any
 * failure is logged and the R2 metric is marked `failure`; the error is rethrown
 * so a foreground caller (e.g. a manual re-trigger route) can surface it, but
 * the signing path must call this WITHOUT awaiting so it never blocks signing.
 */
export async function generateBonusPdf(monthId: string): Promise<GenerateBonusPdfResult> {
  const month = await prisma.bonusPayPeriod.findUnique({
    where: { id: monthId },
    include: { site: { select: { code: true } } },
  });
  if (!month) throw new Error(`bonus month ${monthId} not found`);

  // P0-1 reconciliation tripwire (ADR-0033): BEFORE rendering or uploading, the
  // locked total_payout_cents must match the freshly-recomputed grand total for a
  // reconciled-state (signed/paid) period. A mismatch refuses generation (no PDF
  // is rendered, nothing is stored) and fires an urgent page, so a payroll PDF
  // whose total disagrees with the lock can never reach R2 or payroll.
  const reconcile = await assertPayoutReconciles(monthId);
  if (!reconcile.pass) throw new PayoutReconciliationError(monthId);

  const ym = pdfMonthYm(month.period_start);
  const short = randomUUID().slice(0, 8);
  const storageKey = `pdfs/bonus/${month.site.code}/${ym}/${short}.pdf`;

  try {
    const buffer = await renderPdfBuffer(monthId);

    const bucket = process.env['R2_BUCKET'];
    if (!bucket) throw new Error('R2 not configured');
    await r2Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: buffer,
        ContentType: 'application/pdf',
      }),
    );

    await prisma.bonusPayPeriod.update({
      where: { id: monthId },
      data: { pdf_storage_key: storageKey, pdf_generated_at: new Date() },
    });

    r2UploadSuccess.inc({ kind: 'bonus_pdf', outcome: 'success' });
    log.info({ monthId, storageKey }, 'bonus pdf generated and uploaded');
    return { storageKey };
  } catch (err) {
    r2UploadSuccess.inc({ kind: 'bonus_pdf', outcome: 'failure' });
    log.error(
      { monthId, err: err instanceof Error ? err.message : String(err) },
      'bonus pdf generation failed',
    );
    throw err;
  }
}
