// ADR-0042 D3 — COR PDF generator (the proven bonus-PDF house path).
//
// `generateCorPdf(certId)` launches headless Chromium (Playwright), navigates to
// the INTERNAL print route (`/internal/cor-pdf/<certId>`), prints it to a PDF
// buffer, uploads the buffer to Cloudflare R2 under the `cor/` prefix, and
// persists `pdf_storage_key` on the cor_certificates row.
//
// RECONCILE TRIPWIRE (D2.1/D3, ADR-0033 style): BEFORE rendering or uploading, the
// stored `inventory_units` must still reconcile to the freshly-recomputed running
// balance. A mismatch refuses generation (no PDF is rendered, nothing is stored)
// via `assertCorInventoryReconciles`, which throws `CorReconcileMismatchError` with
// both numbers. A certificate whose inventory figure disagrees with the ledger can
// never reach R2.
//
// SIGNING BOUNDARY (D3): the internal print page renders the signature block EMPTY —
// Vision NEVER renders a signature or an "e-signed" mark. Rick prints, signs, and
// submits per the current MRC process.
//
// AUTH: the internal page is session-less, protected only by its own loopback /
// cf-connecting-ip guard, so we navigate over localhost (no Cloudflare edge in the
// path => no cf-connecting-ip header => the guard lets us render).

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { r2UploadSuccess } from '@/lib/observability/metrics';
import { log } from '@/lib/observability/logger';
import { assertCorInventoryReconciles } from './service';
import { CorNotFoundError } from './view';

export interface GenerateCorPdfResult {
  storageKey: string;
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
 * Render the certificate print page to a PDF buffer with headless Chromium.
 * Isolated so the browser is always closed even on a navigation/print failure.
 */
async function renderPdfBuffer(certId: string): Promise<Buffer> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = `${internalBaseUrl()}/internal/cor-pdf/${encodeURIComponent(certId)}`;
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    if (!resp || !resp.ok()) {
      throw new Error(`internal cor pdf page returned ${resp ? resp.status() : 'no response'}`);
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

/** `YYYY-MM` for a @db.Date cover-month value (UTC components = the cover month). */
function coverYm(coverMonth: Date): string {
  const y = coverMonth.getUTCFullYear();
  const m = String(coverMonth.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Generate, upload, and persist a certificate's PDF. Refuses on a reconcile
 * mismatch (nothing rendered/stored). Rethrows on failure so a foreground caller
 * (a manual re-trigger route) surfaces it; the finalize path calls this WITHOUT
 * awaiting so it never blocks the freeze.
 */
export async function generateCorPdf(certId: string): Promise<GenerateCorPdfResult> {
  const cert = await prisma.corCertificate.findUnique({
    where: { id: certId },
    select: { id: true, site_id: true, cover_month: true },
  });
  if (!cert) throw new CorNotFoundError(certId);
  const site = await prisma.site.findUnique({ where: { id: cert.site_id }, select: { code: true } });
  if (!site) throw new CorNotFoundError(certId);

  // D2.1/D3 reconcile tripwire — throws CorReconcileMismatchError on drift.
  await assertCorInventoryReconciles(certId);

  const short = randomUUID().slice(0, 8);
  const storageKey = `cor/${site.code}/${coverYm(cert.cover_month)}/${short}.pdf`;

  try {
    const buffer = await renderPdfBuffer(certId);

    const bucket = process.env['R2_BUCKET'];
    if (!bucket) throw new Error('R2 not configured');
    await r2Client().send(
      new PutObjectCommand({ Bucket: bucket, Key: storageKey, Body: buffer, ContentType: 'application/pdf' }),
    );

    await prisma.corCertificate.update({ where: { id: certId }, data: { pdf_storage_key: storageKey } });

    r2UploadSuccess.inc({ kind: 'cor_pdf', outcome: 'success' });
    log.info({ op: 'cor.pdf', cert_id: certId, storage_key: storageKey }, '[cor] pdf generated and uploaded');
    return { storageKey };
  } catch (err) {
    r2UploadSuccess.inc({ kind: 'cor_pdf', outcome: 'failure' });
    log.error(
      { op: 'cor.pdf', cert_id: certId, err: err instanceof Error ? err.message : String(err) },
      '[cor] pdf generation failed',
    );
    throw err;
  }
}

/**
 * Mint a short-lived presigned GET URL for a stored certificate PDF (office
 * download). Returns null when the certificate has no rendered PDF yet.
 */
export async function corPdfDownloadUrl(certId: string): Promise<string | null> {
  const cert = await prisma.corCertificate.findUnique({
    where: { id: certId },
    select: { pdf_storage_key: true },
  });
  if (!cert?.pdf_storage_key) return null;
  const bucket = process.env['R2_BUCKET'];
  if (!bucket) throw new Error('R2 not configured');
  return getSignedUrl(
    r2Client(),
    new GetObjectCommand({ Bucket: bucket, Key: cert.pdf_storage_key }),
    { expiresIn: 300 },
  );
}
