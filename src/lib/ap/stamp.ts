// ADR-0046 §3 amendment (handoff §1.6e) — visible approval STAMP on the decision
// PDF. NO cryptography — the "signature" is a visible printed stamp, and the
// tamper record is the sha256 of the GENERATED PDF (persisted to
// ap_requests.decision_pdf_sha256 + an audit row).
//
// DELIBERATE DEVIATION (no-dependency constraint): the repo has NO PDF-
// manipulation library (no pdf-lib / pdfkit) and one MUST NOT be added
// (node_modules is symlinked to the main repo; an absent module is unresolvable
// by tsc and forbidden by policy). The repo's ONLY PDF mechanism is
// Playwright → Chromium print-to-PDF of an HTML page (see src/lib/bonus/pdf.ts).
// Therefore we CANNOT overlay a stamp onto existing PDF vector bytes in place.
// Instead:
//   - BODY-only originals: re-render the (re-)sanitized body HTML inside a
//     branded shell with a visible stamp footer, then print to PDF.
//   - PDF/file ATTACHMENT originals: render a stamped APPROVAL COVER PAGE
//     carrying the same visible stamp + request/subject/approver/decision/
//     timestamp + the original filename + (when the caller supplies the bytes)
//     the sha256 of the ORIGINAL attachment. The decision email carries this
//     stamped PDF; the original stays retrievable via the AP queue attachment
//     route. (Inline re-download + re-attach of the R2 original is NOT wired in
//     this build — documented deviation.)
//
// The Playwright call is INJECTABLE so unit tests pass a deterministic renderer
// and never launch real Chromium.

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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** sha256 (hex) of a buffer — used for the generated PDF and (optionally) originals. */
export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * The exact visible stamp line (handoff §1.6e). Note only APPROVED items are
 * "Approved by …"; a rejection reads "Rejected by …" but keeps the same shape.
 */
export function stampText(input: Pick<StampInput, 'decision' | 'approverName' | 'decidedAt'>): string {
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
