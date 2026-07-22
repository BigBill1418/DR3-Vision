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
import { withChromium } from '@/lib/chromium-semaphore';
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
  /**
   * Operator directive 2026-07-15: the site the approver tagged at decision
   * (Woodland/Eugene) must be UNMISSABLE on everything accounting receives —
   * it rides the per-page stamp line and the details block. Null when the
   * approver tagged no site (the tag is optional).
   */
  siteName?: string | null;
  /**
   * ADR-0046 amendment (2026-07-20): the "NOT DR3 — See Reason" disposition. When
   * true, the invoice is NOT for a DR3 location — the stamp/PDF renders "NOT DR3 —
   * see reason" in the location slot (where the site name otherwise goes) so
   * accounting never mistakes it for a DR3-site invoice. The reason rides `note`.
   * Mutually exclusive with `siteName` (an approver picks a site OR marks NOT DR3).
   */
  notDr3?: boolean;
  /**
   * ADR-0046 Amendment 5 (D-M5-3) — the $1,000 second-approval hop. When set (an
   * Approve whose confirmed amount was >= $1,000), the stamp line carries BOTH
   * approvers: `approverName`/`decidedAt` are the FIRST approver + their approval
   * time, and these two are the SECOND approver + confirmation time, appended as
   * "; second approval by [Second] on [T2 PT]". Null on sub-$1K single-action
   * decisions (unchanged single-approver stamp).
   */
  secondApproverName?: string | null;
  secondApprovedAt?: Date | null;
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
 * BLIND-SSRF DEFENSE (audit 2026-07-16 · SSRF). The body-only render path prints
 * attacker-authored email HTML to PDF with headless Chromium. The email sanitizer
 * ALLOWS remote http/https `<img>`, so — left alone — Chromium would fetch those
 * URLs SERVER-SIDE at decision time (cloud metadata, internal hosts, tracking
 * pixels) and a hanging URL would stall the render. This rewrites every `<img>`
 * `src` that is not a `data:` URI to `about:blank`, so the HTML handed to the
 * renderer carries NO live remote reference. (The Playwright renderer additionally
 * intercepts + aborts any non-`data:`/non-`about:` request as belt-and-suspenders.)
 * Pure + deterministic; only touches `<img src=…>`, never other content.
 */
export function neutralizeRemoteImageSrcs(html: string): string {
  return html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi,
    (match, pre: string, quote: string, url: string) =>
      /^\s*data:/i.test(url) ? match : `${pre}${quote}about:blank${quote}`,
  );
}

/**
 * The exact visible stamp line (handoff §1.6e). Note only APPROVED items are
 * "Approved by …"; a rejection reads "Rejected by …" but keeps the same shape.
 */
export function stampText(
  input: Pick<
    StampInput,
    | 'decision'
    | 'approverName'
    | 'decidedAt'
    | 'siteName'
    | 'notDr3'
    | 'secondApproverName'
    | 'secondApprovedAt'
  >,
): string {
  const verb = input.decision === 'approved' ? STAMP_TEXT_PREFIX : 'Rejected by';
  const when = formatPacificDateTime(input.decidedAt);
  // ADR-0046 Amendment 5 (D-M5-3) — a >= $1,000 approval carries BOTH approvers on
  // the stamp line. The leading "Approved by [First] …" is the first approver; the
  // second-approval clause names the site's second approver + their confirmation
  // time. Sub-$1K decisions carry no second approver → the clause is empty and the
  // single-approver line is unchanged.
  const second =
    input.decision === 'approved' && input.secondApproverName && input.secondApprovedAt
      ? `; second approval by ${input.secondApproverName} on ${formatPacificDateTime(
          input.secondApprovedAt,
        )} PT`
      : '';
  // Location rides the stamp line itself so every page of the returned document
  // says where this belongs. NOT-DR3 (2026-07-20) takes the slot with an explicit
  // marker (the full reason rides the note band + email body); otherwise the tagged
  // site name rides here (2026-07-15 operator directive).
  const location = input.notDr3
    ? ' — NOT DR3 (see reason)'
    : input.siteName
      ? ` — Site: ${input.siteName}`
      : '';
  return `${verb} ${input.approverName} on ${when} PT via DR3-Vision${second}${location}`;
}

/**
 * The location line in a stamped page's meta block (2026-07-20). NOT-DR3 shows the
 * marker + the reason inline (so accounting sees it where the site name would be);
 * otherwise the tagged site name, or nothing when neither is present.
 */
function locationMetaHtml(input: StampInput): string {
  if (input.notDr3) {
    const reason = input.note?.trim();
    return `<div>Location: <b>NOT DR3 — see reason</b>${reason ? `: ${escapeHtml(reason)}` : ''}</div>`;
  }
  return input.siteName ? `<div>Site: <b>${escapeHtml(input.siteName)}</b></div>` : '';
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
    // Then neutralize any remote <img> (blind-SSRF defense): the renderer must
    // never fetch an attacker URL server-side when printing this body to PDF.
    const safeBody = neutralizeRemoteImageSrcs(sanitizeEmailHtml(input.bodyHtmlSanitized ?? ''));
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
    ${locationMetaHtml(input)}
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
  // Serialize against every other Chromium render in this process so overlapping
  // PDF jobs can't OOM the serving container (audit 2026-07-16 RES).
  return withChromium(async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      // Blind-SSRF defense (audit 2026-07-16): abort every sub-resource request that
      // is not a data:/about: scheme, so a remote <img>/asset that slipped past the
      // HTML rewrite can never be fetched server-side. Belt-and-suspenders with
      // neutralizeRemoteImageSrcs; the stamp shell itself references no external asset.
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith('data:') || url.startsWith('about:')) await route.continue();
        else await route.abort();
      });
      // waitUntil:'load' (not 'networkidle') + a bounded timeout so a single hanging
      // URL cannot stall the render for the full budget; with remote fetches blocked
      // the load event fires immediately.
      await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
      const pdf = await page.pdf({
        format: 'Letter',
        printBackground: true,
        margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  });
}

/**
 * Greedy word-wrap against a measured width, capped at maxLines; the last line
 * gets an ellipsis when the text is truncated. A single word wider than the
 * line is hard-cut so one unbroken token can never overflow the band.
 */
export function wrapToWidth(
  text: string,
  measure: (t: string) => number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let truncated = false;
  for (const raw of words) {
    let word = raw;
    while (measure(word) > maxWidth && word.length > 1) {
      word = word.slice(0, -1);
      truncated = true;
    }
    const candidate = cur ? `${cur} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      cur = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) {
      truncated = true;
      break;
    }
    lines.push(cur);
    cur = word;
  }
  if (cur) lines.push(cur);
  if (truncated && lines.length > 0) {
    let last = `${lines[lines.length - 1]!}…`;
    while (measure(last) > maxWidth && last.length > 2) last = `${last.slice(0, -2)}…`;
    lines[lines.length - 1] = last;
  }
  return lines;
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
  const note = input.note?.trim() ?? '';

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    // Bottom stamp band — white text on a dark-green fill, legible over any page.
    // 2026-07-15 operator directive: the approver's NOTE must be visible on the
    // returned invoice itself, so the band grows to carry it (wrapped, capped at
    // 3 lines — the full note always rides the decision-email body regardless).
    const size = 9;
    const noteSize = 8;
    const noteLines = note
      ? wrapToWidth(`Note: ${note}`, (t) => bold.widthOfTextAtSize(t, noteSize), width - 16, 3)
      : [];
    const bandHeight = 22 + (noteLines.length ? noteLines.length * 10 + 3 : 0);
    const lineWidth = bold.widthOfTextAtSize(line, size);
    page.drawRectangle({
      x: 0,
      y: 0,
      width,
      height: bandHeight,
      color: rgb(0, 0.32, 0.3),
      opacity: 0.92,
    });
    page.drawText(line, {
      x: Math.max(8, (width - lineWidth) / 2),
      y: bandHeight - 15,
      size,
      font: bold,
      color: rgb(1, 1, 1),
    });
    noteLines.forEach((nl, i) => {
      page.drawText(nl, {
        x: 8,
        y: bandHeight - 25 - i * 10,
        size: noteSize,
        font: bold,
        color: rgb(1, 1, 1),
      });
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
    ${locationMetaHtml(input)}
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
