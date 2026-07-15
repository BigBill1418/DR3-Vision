// ADR-0046 §3 amendment (handoff §1.6e) — visible approval STAMP on the decision
// PDF. NO cryptography — the "signature" is a visible printed stamp, and the
// tamper record is the sha256 of the GENERATED PDF (persisted to
// ap_requests.decision_pdf_sha256 + an audit row).
//
// ADR-0046 Amendment 4 (2026-07-15) — REVERSES the §C10 no-PDF-lib constraint.
// pdf-lib (pure-JS, MIT) is now an approved dependency: Playwright can only
// print HTML→PDF, it CANNOT composite a stamp onto existing PDF vector bytes, so
// stamping the actual original invoice required a real PDF library. The three
// render paths are now:
//   - BODY-only originals: re-render the (re-)sanitized body HTML inside a
//     branded shell with a visible stamp footer, then print to PDF (Playwright).
//   - PDF ATTACHMENT originals: overlay a visible stamp line + a diagonal
//     APPROVED/REJECTED watermark onto EVERY page of the ORIGINAL PDF with
//     pdf-lib (stampOntoOriginalPdf) — the true overlay. The decision email
//     carries the stamped original; the raw original stays in R2.
//   - IMAGE ATTACHMENT originals: embed the image in a branded HTML page with the
//     stamp overlay and print to PDF (stampImage, Playwright) — a true overlay
//     with no image-decode dependency.
// The stamped-PDF sha256 stays the tamper record; the ORIGINAL bytes' sha256 is
// recorded alongside it (ap_requests.original_attachment_sha256) as the dual-sha
// tamper record. pdf-lib output is made reproducible by pinning the PDF metadata
// dates/producer to the decision instant (see stampOntoOriginalPdf).
//
// The Playwright call is INJECTABLE so unit tests pass a deterministic renderer
// and never launch real Chromium; pdf-lib is pure-JS and runs directly in tests.

import { createHash } from 'node:crypto';
import { sanitizeEmailHtml } from './sanitize';
import { formatPacificDateTime } from '@/lib/time';

export type ApDecisionLabel = 'approved' | 'rejected';

export interface StampInput {
  kind: 'body' | 'attachment';
  requestId: string;
  subject: string;
  approverName: string;
  decision: ApDecisionLabel;
  decidedAt: Date;
  /** ADR-0046 Amendment 3 — the approver's decision note, shown on the stamp. */
  note?: string | null;
  /** kind='body': the C10-sanitized message body HTML (re-sanitized before render). */
  bodyHtmlSanitized?: string | null;
  /** kind='attachment': the original attachment filename (display only). */
  originalFilename?: string | null;
  /**
   * kind='attachment': sha256 (hex) of the ORIGINAL attachment bytes, when the
   * caller has them on hand. Omitted when the bytes live in R2 and were not
   * downloaded inline (documented deviation) — the cover page then notes it.
   */
  originalSha256?: string | null;
}

export interface StampResult {
  pdf: Buffer;
  /** sha256 (hex) of the GENERATED stamped PDF — the tamper record. */
  sha256: string;
}

/** A print-to-PDF renderer: HTML in, PDF bytes out. Injectable for tests. */
export type PdfRenderer = (html: string) => Promise<Buffer>;

const STAMP_TEXT_PREFIX = 'Approved by';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** sha256 (hex) of a buffer — used for the generated PDF and (optionally) originals. */
export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * The exact visible stamp line (handoff §1.6e). Note only APPROVED items are
 * "Approved by …"; a rejection reads "Rejected by …" but keeps the same shape.
 */
export function stampText(
  input: Pick<StampInput, 'decision' | 'approverName' | 'decidedAt'>,
): string {
  const verb = input.decision === 'approved' ? STAMP_TEXT_PREFIX : 'Rejected by';
  const when = formatPacificDateTime(input.decidedAt);
  return `${verb} ${input.approverName} on ${when} PT via DR3-Vision`;
}

/** The branded HTML shell + visible stamp footer/watermark that gets printed. */
export function buildStampHtml(input: StampInput): string {
  const stamp = escapeHtml(stampText(input));
  const subject = escapeHtml(input.subject || '(no subject)');
  const reqId = escapeHtml(input.requestId);
  const decisionUpper = input.decision.toUpperCase();

  let inner: string;
  if (input.kind === 'body') {
    // Re-sanitize defensively (C10) even though the stored body is already
    // allowlist-sanitized at ingest — never introduce script into the render.
    const safeBody = sanitizeEmailHtml(input.bodyHtmlSanitized ?? '');
    inner = `<section class="original"><h2>Original message</h2><div class="body">${safeBody || '<em>(no body)</em>'}</div></section>`;
  } else {
    const fname = escapeHtml(input.originalFilename ?? '(unnamed attachment)');
    const origHash = input.originalSha256
      ? `<li>Original SHA-256: <code>${escapeHtml(input.originalSha256)}</code></li>`
      : `<li>Original SHA-256: <em>not computed inline — retrieve the original from the AP queue</em></li>`;
    inner = `<section class="cover">
        <h2>Approval cover page</h2>
        <p>This stamped cover accompanies the original attachment, which is not modified. Retrieve the original via the DR3-Vision AP queue.</p>
        <ul>
          <li>Original attachment: <b>${fname}</b></li>
          ${origHash}
        </ul>
      </section>`;
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  :root { --dr3-green-deep: #003d38; --dr3-green: #00524C; --dr3-ink: #111; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: var(--dr3-ink); margin: 0; padding: 0 40px 96px; }
  header { border-bottom: 3px solid var(--dr3-green); padding: 24px 0 12px; margin-bottom: 16px; }
  header .brand { color: var(--dr3-green-deep); font-weight: 800; font-size: 18px; letter-spacing: .04em; }
  header .decision { font-size: 13px; color: #444; margin-top: 4px; }
  h2 { font-size: 14px; color: var(--dr3-green-deep); margin: 20px 0 8px; }
  ul { font-size: 12px; line-height: 1.6; padding-left: 18px; }
  .meta { font-size: 12px; color: #333; line-height: 1.6; }
  .body { border: 1px solid #ddd; padding: 12px; font-size: 12px; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }
  .stamp { position: fixed; bottom: 0; left: 0; right: 0; background: var(--dr3-green-deep); color: #fff; font-weight: 700; font-size: 12px; letter-spacing: .03em; padding: 12px 40px; text-align: center; }
  .watermark { position: fixed; top: 44%; left: 0; right: 0; text-align: center; font-size: 40px; font-weight: 800; color: rgba(0,82,76,.10); transform: rotate(-18deg); letter-spacing: .12em; }
</style></head>
<body>
  <header>
    <div class="brand">DR3-Vision · Vendor Invoice Approval</div>
    <div class="decision">Decision: <b>${decisionUpper}</b> · Request ${reqId}</div>
  </header>
  <div class="meta">
    <div>Subject: <b>${subject}</b></div>
    <div>Approver: ${escapeHtml(input.approverName)}</div>
    <div>Decided: ${escapeHtml(formatPacificDateTime(input.decidedAt))} PT</div>
    ${input.note && input.note.trim() ? `<div>Note: ${escapeHtml(input.note.trim())}</div>` : ''}
  </div>
  ${inner}
  <div class="watermark">${decisionUpper}</div>
  <div class="stamp">${stamp}</div>
</body></html>`;
}

/**
 * Render the stamped decision PDF and return it plus its sha256. Uses the
 * injected `renderer` (tests) or the default Playwright print-to-PDF (prod).
 */
export async function stampApproval(
  input: StampInput,
  renderer: PdfRenderer = defaultPlaywrightRenderer,
): Promise<StampResult> {
  const html = buildStampHtml(input);
  const pdf = await renderer(html);
  return { pdf, sha256: sha256Hex(pdf) };
}

/**
 * Default renderer: headless Chromium via Playwright, print-to-PDF from set HTML
 * (mirrors src/lib/bonus/pdf.ts renderPdfBuffer, but from `setContent` rather
 * than navigating to a URL). Always closes the browser, even on failure.
 */
export async function defaultPlaywrightRenderer(html: string): Promise<Buffer> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 30_000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

/**
 * ADR-0046 Amendment 4 — overlay a visible stamp onto EVERY page of the ORIGINAL
 * PDF using pdf-lib (a TRUE overlay, not a cover page): a bottom stamp band with
 * the exact stamp line + a diagonal APPROVED/REJECTED watermark across the page.
 * Returns the stamped PDF + its sha256 (the tamper record). Deterministic: the
 * PDF metadata dates + producer are pinned to the decision instant so the sha is
 * reproducible for a given (original bytes, decision, approver, decidedAt).
 * pdf-lib is dynamically imported (edge-safe, lazy — mirrors the Playwright import).
 */
export async function stampOntoOriginalPdf(
  pdfBytes: Uint8Array,
  input: StampInput,
): Promise<StampResult> {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdfBytes);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const line = stampText(input);
  const mark = input.decision.toUpperCase();
  const markColor = input.decision === 'approved' ? rgb(0, 0.32, 0.3) : rgb(0.72, 0.11, 0.11);

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    // Bottom stamp band — white text on a dark-green fill, legible over any page.
    const size = 9;
    const lineWidth = bold.widthOfTextAtSize(line, size);
    page.drawRectangle({ x: 0, y: 0, width, height: 22, color: rgb(0, 0.32, 0.3), opacity: 0.92 });
    page.drawText(line, {
      x: Math.max(8, (width - lineWidth) / 2),
      y: 7,
      size,
      font: bold,
      color: rgb(1, 1, 1),
    });
    // Diagonal watermark sized to ~80% of page width, low opacity, rotated up-right.
    const w10 = bold.widthOfTextAtSize(mark, 10) || 1;
    const markSize = Math.min(90, ((width * 0.8) / w10) * 10);
    page.drawText(mark, {
      x: width * 0.08,
      y: height * 0.32,
      size: markSize,
      font: bold,
      color: markColor,
      opacity: 0.16,
      rotate: degrees(30),
    });
  }

  // Pin metadata so the tamper-record sha256 is reproducible (not clock-dependent).
  doc.setProducer('DR3-Vision');
  doc.setCreationDate(input.decidedAt);
  doc.setModificationDate(input.decidedAt);
  const out = Buffer.from(await doc.save());
  return { pdf: out, sha256: sha256Hex(out) };
}

/**
 * ADR-0046 Amendment 4 — the branded HTML page for an IMAGE original: the image
 * embedded full-width with the same visible stamp footer + watermark, printed to
 * PDF via Playwright (a true overlay with no image-decode dependency).
 */
export function buildImageStampHtml(input: StampInput, imageDataUri: string): string {
  const stamp = escapeHtml(stampText(input));
  const subject = escapeHtml(input.subject || '(no subject)');
  const reqId = escapeHtml(input.requestId);
  const decisionUpper = input.decision.toUpperCase();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  :root { --dr3-green-deep: #003d38; --dr3-green: #00524C; --dr3-ink: #111; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: var(--dr3-ink); margin: 0; padding: 0 40px 96px; }
  header { border-bottom: 3px solid var(--dr3-green); padding: 24px 0 12px; margin-bottom: 16px; }
  header .brand { color: var(--dr3-green-deep); font-weight: 800; font-size: 18px; letter-spacing: .04em; }
  header .decision { font-size: 13px; color: #444; margin-top: 4px; }
  .meta { font-size: 12px; color: #333; line-height: 1.6; }
  .invoice-img { max-width: 100%; height: auto; display: block; margin: 12px auto; border: 1px solid #ddd; }
  .stamp { position: fixed; bottom: 0; left: 0; right: 0; background: var(--dr3-green-deep); color: #fff; font-weight: 700; font-size: 12px; letter-spacing: .03em; padding: 12px 40px; text-align: center; }
  .watermark { position: fixed; top: 44%; left: 0; right: 0; text-align: center; font-size: 40px; font-weight: 800; color: rgba(0,82,76,.12); transform: rotate(-18deg); letter-spacing: .12em; }
</style></head>
<body>
  <header>
    <div class="brand">DR3-Vision · Vendor Invoice Approval</div>
    <div class="decision">Decision: <b>${decisionUpper}</b> · Request ${reqId}</div>
  </header>
  <div class="meta">
    <div>Subject: <b>${subject}</b></div>
    <div>Approver: ${escapeHtml(input.approverName)}</div>
    <div>Decided: ${escapeHtml(formatPacificDateTime(input.decidedAt))} PT</div>
    ${input.note && input.note.trim() ? `<div>Note: ${escapeHtml(input.note.trim())}</div>` : ''}
  </div>
  <img class="invoice-img" src="${imageDataUri}" alt="original invoice image" />
  <div class="watermark">${decisionUpper}</div>
  <div class="stamp">${stamp}</div>
</body></html>`;
}

/**
 * ADR-0046 Amendment 4 — stamp an IMAGE original: embed the bytes as a data URI in
 * {@link buildImageStampHtml} and print to PDF via the injected renderer. Returns
 * the stamped PDF + its sha256.
 */
export async function stampImage(
  input: StampInput,
  imageBytes: Uint8Array,
  contentType: string,
  renderer: PdfRenderer = defaultPlaywrightRenderer,
): Promise<StampResult> {
  const dataUri = `data:${contentType};base64,${Buffer.from(imageBytes).toString('base64')}`;
  const pdf = await renderer(buildImageStampHtml(input, dataUri));
  return { pdf, sha256: sha256Hex(pdf) };
}
