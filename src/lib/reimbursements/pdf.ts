// ADR-0068 deferred item 1 — the stamped decision PDF for an APPROVED employee
// reimbursement. Mary receives it attached to the approved-reimbursement mail
// (D6); the sha256 is the tamper record, mirroring the AP decision PDF.
//
// ── Why this is NOT `@/lib/ap/stamp.ts` with extra fields ────────────────────
// The AP stamper is vendor-invoice-shaped in one way that is disqualifying rather
// than merely awkward: `stampText()` renders the FIRST party as
// "Approved by <name> …" and appends the second as "; second approval by …".
// On a reimbursement the first signature is a SUBMISSION, not an approval — so
// reusing that line would print "Approved by Janette" for the person who filed
// the request. That is precisely the manufactured audit evidence ADR-0068 exists
// to eliminate, printed on the artefact an auditor reads. The rest of `StampInput`
// is likewise mailbox-shaped (`subject`, `kind: 'body' | 'attachment'`,
// `bodyHtmlSanitized`, `originalFilename`/`originalSha256`, the `notDr3`
// disposition) and carries no slot for a beneficiary, amount, expense date,
// category or purpose — the substantive reimbursement fields.
//
// What IS genuinely shared is reused rather than duplicated: `PdfRenderer`,
// `defaultPlaywrightRenderer` (the Chromium semaphore + the blind-SSRF
// route-abort + Letter/print-background settings) and `sha256Hex` all come from
// the AP module. So does the visual family — same DR3 green shell, same fixed
// stamp band.
//
// ── What this module GUARANTEES, and why it refuses rather than renders ──────
// The document asserts that two different people signed and that the submitter
// could not have approved it. An assertion printed onto an audit artefact must be
// checked against the row it is printed from, so `renderReimbursementDecisionPdf`
// re-verifies the exclusions from the input and THROWS instead of printing an
// unprovable claim:
//   - the row is `approved`, and carries a second approver + approval instant;
//   - the second approver is not the submitter;
//   - the second approver is not the beneficiary, when the beneficiary is a
//     Vision account (an id comparison).
// When the beneficiary is FREE TEXT there is no id to compare, so the document
// says exactly that instead of claiming an id check that did not happen — the
// beneficiary exclusion was enforced at submission by name matching (routing.ts).
//
// ── The receipt rides the document (2026-07-30) ──────────────────────────────
// Accounting used to be told "the receipt is in Vision, go look" — so paying a
// reimbursement meant leaving the mail, signing in, and finding the request. The
// receipt is now REPRODUCED on the decision PDF itself: page 1 carries the
// decision band across the top and the first receipt page in the window beneath
// it; a multi-page receipt spills to pages 2..N, each stamped so no page can be
// separated from the packet it belongs to.
//
// Two constraints shaped the layout, and both are arithmetic rather than taste:
//
//   1. The band is capped at 172 pt so the receipt window can be 576 pt tall. The
//      live receipts are 594.72 x 774.72 pt scans, which fit that window at 74%
//      — a 9 pt line on the original prints at 6.7 pt. The band's previous 246 pt
//      forced 65%, i.e. 5.8 pt, which is below what a person reads comfortably.
//   2. The composed file is capped at COMPOSED_PDF_BUDGET_BYTES so it survives
//      the Graph inline-attachment ceiling (see `@/lib/m365-mail` — base64
//      inflates by a third, so 1.6 MB raw costs ~2.2 MB on the wire). Over
//      budget, the scanned JPEGs are re-encoded down a fixed ladder; if even the
//      last rung does not fit, the receipt is declared UNREPRODUCIBLE rather than
//      attached at an unreadable resolution or silently truncated.
//
// "A single page" is honoured where it is achievable: a one-page receipt really
// does produce a one-page PDF. A three-page receipt cannot — tiling three scans
// into one window would put that same 9 pt line at 2.8 pt, which is a picture of
// a receipt rather than a readable one. It spills instead.
//
// ── Three DISTINCT receipt outcomes, never collapsed into one ───────────────
// The page ALWAYS carries a receipt strip; only its content varies. "No receipt
// was submitted" is a finding about the REQUEST (a control gap an auditor should
// see). "The receipt exists but could not be drawn here" is a finding about THIS
// RENDER (the receipt is still in Vision and still authoritative). Reporting
// either as the other would misdescribe the record — so they are separate states
// with separate wording, and each pushes its own sentence onto `problems[]`.
// Neither blocks the mail: Mary must be able to pay a properly approved
// reimbursement even when the receipt cannot be drawn.

import { formatPacificDateTime, pacificDateLabel } from '@/lib/time';
import { defaultPlaywrightRenderer, sha256Hex, type PdfRenderer } from '@/lib/ap/stamp';

/**
 * The reimbursement row this document is rendered from. Deliberately a structural
 * subset of the notify-path row so the caller can pass what it already loaded —
 * it must additionally select `second_approver_id`, which is what makes the
 * printed exclusion claims verifiable rather than decorative, and
 * `receipt_file_key`, which is what makes the receipt reproducible.
 */
export interface ReimbursementDecisionPdfInput {
  id: string;
  status: string;
  amount_cents: number;
  /** The EXPENSE date (stored at noon UTC of the expense calendar day). */
  expense_date: Date;
  category: string;
  purpose: string;
  site: { name: string };
  /** Signature one. */
  submitted_by: string;
  submitted_at: Date;
  submitter: { name: string };
  /** Signature two. */
  second_approver_id: string | null;
  second_approver: { name: string } | null;
  second_approved_at: Date | null;
  /** Beneficiary — exactly one of these is set (DB CHECK). */
  employee_user_id: string | null;
  employee_user: { name: string } | null;
  employee_name_freeform: string | null;
  decision_note: string | null;
  /**
   * R2 storage key of the receipt captured at submission. NULL means no receipt
   * was ever filed — a finding about the request, distinct from a receipt that
   * exists but could not be drawn. The upload route makes this REQUIRED for new
   * rows, so a null here is either a legacy row or a control gap; either way the
   * document says so on its face.
   */
  receipt_file_key: string | null;
}

export interface ReimbursementDecisionPdf {
  pdf: Buffer;
  /** sha256 (hex) of the generated PDF — the tamper record. */
  sha256: string;
  filename: string;
  /** What actually happened to the receipt, for the caller to report. */
  receipt: ReceiptPresentation;
}

/**
 * The row cannot support the claims this document makes. Thrown rather than
 * rendered: a stamped PDF asserting an independent second signature that the row
 * does not evidence is worse than no PDF at all.
 */
export class ReimbursementPdfUnprovableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ReimbursementPdfUnprovableError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Composition geometry — points, on the physical Letter page
// ────────────────────────────────────────────────────────────────────────────
//
// Every number below is load-bearing and they must agree with each other, so
// they are declared ONCE here and the band's CSS is generated from them (in `pt`
// units, which Chromium maps exactly onto PDF user space at 72/inch). Writing
// the band in `px` and the window in `pt` is how these two halves silently drift
// apart, so nothing here is expressed in px.

/** US Letter, the format `defaultPlaywrightRenderer` prints. */
export const LETTER = { width: 612, height: 792 } as const;

/**
 * `defaultPlaywrightRenderer` prints with a fixed 0.4in margin on all sides, so
 * the HTML content box starts this far below the physical page top. The band's
 * usable height is therefore BAND minus this, not BAND.
 */
const PRINT_MARGIN_PT = 28.8;

/**
 * The decision band owns the top of page 1. Capped at 172 pt so the receipt
 * window can be 576 pt tall — see the header note for the legibility arithmetic
 * this number comes from.
 */
export const DECISION_BAND_PT = 172;

/** How much vertical room the band's HTML actually has, inside the print margin. */
export const BAND_CONTENT_PT = DECISION_BAND_PT - PRINT_MARGIN_PT;

/**
 * Vertical space reserved at the foot of page 1 for the signature stamp band.
 *
 * Sized for TWO lines of stamp text, not one. The stamp line carries both
 * signatures with full Pacific timestamps and the site, and on real names it sits
 * right on the edge of wrapping — Janette Tomas + Morena Gomez already wraps. The
 * band is CSS-fixed to the bottom and therefore grows UPWARD, so a reserve sized
 * for one line does not clip the text: it lets the band grow into the receipt
 * window, where the receipt is then drawn on top and hides the first line. That
 * is a signature line silently covered by an image, which is worse than a wrap.
 */
const PAGE1_STAMP_RESERVE_PT = 56;

/**
 * Where the first receipt page is drawn on page 1. Left edge and width match the
 * print margin exactly so the receipt aligns with the band text above it rather
 * than sitting a point or two proud of it.
 */
export const PAGE1_RECEIPT_WINDOW = {
  x: PRINT_MARGIN_PT,
  y: PAGE1_STAMP_RESERVE_PT,
  width: LETTER.width - PRINT_MARGIN_PT * 2,
  height: LETTER.height - DECISION_BAND_PT - PAGE1_STAMP_RESERVE_PT,
} as const;

/** Bottom stamp band on the spill pages, drawn by pdf-lib rather than by CSS. */
const SPILL_STAMP_BAND_PT = 34;
const SPILL_MARGIN_PT = 14;

/** Receipt pages 2..N are drawn nearly full-bleed, above their stamp band. */
export const SPILL_RECEIPT_WINDOW = {
  x: SPILL_MARGIN_PT,
  y: SPILL_STAMP_BAND_PT,
  width: LETTER.width - SPILL_MARGIN_PT * 2,
  height: LETTER.height - SPILL_STAMP_BAND_PT - SPILL_MARGIN_PT,
} as const;

/**
 * Raw-byte cap on the composed PDF. Chosen against the Graph inline-attachment
 * ceiling in `@/lib/m365-mail`: base64 costs 4 bytes per 3, so this lands near
 * 2.2 MB on the wire and leaves room for the mail body and envelope under the
 * 3 MB limit. Raising this without re-checking that guard re-opens the exact
 * silent non-delivery the guard exists to close.
 */
export const COMPOSED_PDF_BUDGET_BYTES = Math.round(1.6 * 1024 * 1024);

/**
 * Widths (px) the scanned JPEGs are re-encoded to, in order, when the composed
 * file is over budget. Measured on the live 3-page receipt: 1700 -> ~752 KB,
 * 1400 -> ~518 KB, 1100 -> ~327 KB. Each rung is tried from the ORIGINAL bytes,
 * never from the previous rung's output, so quality loss does not compound.
 */
const DOWNSCALE_LADDER_PX = [1700, 1400, 1100] as const;
const DOWNSCALE_QUALITY = 78;

/**
 * Below this, a scanned receipt stops being readable. A ladder rung is SKIPPED
 * when it would put the image under this many dots per inch at the size it is
 * actually drawn — so the floor is computed against the real drawn width rather
 * than assumed from the pixel count.
 */
export const MIN_EFFECTIVE_DPI = 150;

// ────────────────────────────────────────────────────────────────────────────
// Receipt outcome
// ────────────────────────────────────────────────────────────────────────────

/**
 * What happened to the receipt on this render. Three states that are deliberately
 * NOT collapsible into "there is no receipt on the page": each describes a
 * different fact about a different thing, and only one of them is a defect in
 * this code.
 */
export type ReceiptPresentation =
  /** `receipt_file_key IS NULL` — nothing was ever filed. About the REQUEST. */
  | { kind: 'absent' }
  /** A receipt exists but this render could not reproduce it. About the RENDER. */
  | { kind: 'unavailable'; reason: string }
  /** Drawn onto the document, across `pageCount` receipt pages. */
  | { kind: 'reproduced'; pageCount: number };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function titleCase(s: string): string {
  return s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

/** Roster name, or the free text typed at submission. */
export function pdfBeneficiaryLabel(input: ReimbursementDecisionPdfInput): string {
  return input.employee_user?.name ?? input.employee_name_freeform ?? '(unnamed)';
}

/**
 * The visible stamp line that rides the bottom band of every page. Both
 * signatures, both in Pacific — the fleet rule, and the whole point of the
 * artefact. Note the verbs: the submitter SUBMITTED, only the second approver
 * APPROVED.
 */
export function reimbursementStampLine(input: {
  submitter: { name: string };
  submitted_at: Date;
  second_approver: { name: string } | null;
  second_approved_at: Date | null;
  site: { name: string };
}): string {
  const submitted = `Submitted by ${input.submitter.name} on ${formatPacificDateTime(
    input.submitted_at,
  )} PT`;
  const approved =
    input.second_approver && input.second_approved_at
      ? ` · Approved by ${input.second_approver.name} on ${formatPacificDateTime(
          input.second_approved_at,
        )} PT`
      : '';
  return `${submitted}${approved} · via DR3-Vision — Site: ${input.site.name}`;
}

/**
 * The stamp line on receipt pages 2..N. Names the page's place in the receipt AND
 * the packet it belongs to, so a page that gets separated from the rest is still
 * traceable back to the approved request it evidences.
 */
export function receiptPageStampLine(
  input: Pick<ReimbursementDecisionPdfInput, 'id' | 'amount_cents'>,
  pageNumber: number,
  pageCount: number,
): string {
  return `Receipt page ${pageNumber} of ${pageCount} · ${input.id} · APPROVED ${usd(
    input.amount_cents,
  )}`;
}

/**
 * The audit fact the whole feature exists to produce, stated on the document.
 *
 * Every sentence is checked: the submitter/approver split is verified by id in
 * {@link assertDualSignature} before this renders, and the DB CHECK named here is
 * `reimbursement_second_approver_not_submitter` (ADR-0068 D4, layer 2 of 3 —
 * see the Verification table: a self-approval INSERT is refused by the database).
 * The beneficiary sentence is deliberately different for a free-text beneficiary,
 * where no id comparison is possible.
 */
export function segregationStatementHtml(input: ReimbursementDecisionPdfInput): string {
  const submitter = escapeHtml(input.submitter.name);
  const approver = escapeHtml(input.second_approver?.name ?? '');
  const beneficiary =
    input.employee_user_id !== null
      ? `The approver is also not the person being reimbursed — both are Vision accounts and the two ids differ on this record.`
      : `The person being reimbursed was entered as free text rather than a Vision account, so the beneficiary exclusion was enforced at submission by name matching (an ambiguous name escalates instead of routing) and cannot be re-checked by account id here.`;
  return (
    `<p class="audit"><b>Two signatures, two different people.</b> ${submitter} submitted this ` +
    `request — that submission is the first signature and is not an approval. ` +
    `${approver} approved it, and is a different person: DR3-Vision cannot record a ` +
    `reimbursement approved by its own submitter, because the database rejects that write ` +
    `(CHECK <code>reimbursement_second_approver_not_submitter</code>). ${beneficiary}</p>`
  );
}

/**
 * Verify the row can support the document's claims. Returns nothing; throws
 * {@link ReimbursementPdfUnprovableError} naming the first failure.
 */
export function assertDualSignature(input: ReimbursementDecisionPdfInput): void {
  if (input.status !== 'approved') {
    throw new ReimbursementPdfUnprovableError(
      `Reimbursement ${input.id} is ${input.status}, not approved — there is no approval to stamp.`,
    );
  }
  if (!input.second_approver_id || !input.second_approver || !input.second_approved_at) {
    throw new ReimbursementPdfUnprovableError(
      `Reimbursement ${input.id} is approved but carries no second approver + approval time — the second signature cannot be evidenced.`,
    );
  }
  if (input.second_approver_id === input.submitted_by) {
    throw new ReimbursementPdfUnprovableError(
      `Reimbursement ${input.id} was approved by its own submitter — refusing to stamp it as independently approved.`,
    );
  }
  if (input.employee_user_id !== null && input.second_approver_id === input.employee_user_id) {
    throw new ReimbursementPdfUnprovableError(
      `Reimbursement ${input.id} was approved by the person being reimbursed — refusing to stamp it as independently approved.`,
    );
  }
}

/**
 * The receipt strip that always rides the bottom of the band. Green when the
 * receipt is on the document, amber when it is not — and the amber wording says
 * WHICH of the two amber cases this is, because "no receipt exists" and "the
 * receipt exists but is not drawn here" call for different actions from Mary.
 */
export function receiptStripHtml(
  input: ReimbursementDecisionPdfInput,
  receipt: ReceiptPresentation,
): string {
  if (receipt.kind === 'reproduced') {
    return `<div class="receipt-strip ok">Receipt as submitted — page 1 of ${receipt.pageCount}.</div>`;
  }
  if (receipt.kind === 'absent') {
    return `<div class="receipt-strip warn">NO RECEIPT WAS SUBMITTED WITH THIS REQUEST.</div>`;
  }
  return `<div class="receipt-strip warn">RECEIPT COULD NOT BE REPRODUCED HERE (${escapeHtml(
    receipt.reason,
  )}) — it is held in Vision against request ${escapeHtml(
    input.id,
  )}. Open it there before paying.</div>`;
}

/**
 * The sentence the caller pushes onto `problems[]`, or null when the receipt is
 * on the document and there is nothing to report. Distinct wording per state: the
 * absent case is a control finding about the request, the unavailable case is a
 * render failure that leaves Vision as the authority.
 */
export function receiptProblemSentence(
  input: Pick<ReimbursementDecisionPdfInput, 'id'>,
  receipt: ReceiptPresentation,
): string | null {
  if (receipt.kind === 'reproduced') return null;
  if (receipt.kind === 'absent') {
    return `Reimbursement ${input.id} was approved with NO receipt attached to the request — the decision PDF says so on its face, and there is nothing to reproduce. This is a control finding about the request, not a rendering failure.`;
  }
  return `Reimbursement ${input.id}: the receipt exists but could not be reproduced on the decision PDF (${receipt.reason}) — the PDF says so on its face and points to Vision. The approval itself is unaffected and the reimbursement is payable; open request ${input.id} in Vision to view the receipt.`;
}

/**
 * The branded page that gets printed. Self-contained: no external stylesheet,
 * font or image, so the renderer's abort-everything-not-data: route never fires.
 *
 * The layout is a fixed-height band (see {@link BAND_CONTENT_PT}) so the receipt
 * window below it is guaranteed clear. Within that height only the audit
 * paragraph flexes; every other row is sized, and the two unbounded fields
 * (purpose, approver note) are line-clamped so a long one ellipsizes visibly
 * instead of pushing the band into the receipt.
 */
export function buildReimbursementDecisionHtml(
  input: ReimbursementDecisionPdfInput,
  receipt: ReceiptPresentation = { kind: 'absent' },
): string {
  const stamp = escapeHtml(reimbursementStampLine(input));
  const note = input.decision_note?.trim();

  const cell = (label: string, value: string): string =>
    `<div class="cell"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;

  const sigCard = (label: string, who: string, when: string): string =>
    `<div class="card"><span>${escapeHtml(label)}</span><div class="line"><b>${escapeHtml(
      who,
    )}</b> <i>${escapeHtml(when)}</i></div></div>`;

  const noteRow = note
    ? `<div class="note"><span>Approver note</span><b>${escapeHtml(note)}</b></div>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  :root {
    --dr3-green-deep: #003d38; --dr3-green: #00524C; --dr3-ink: #111;
    --amber-ink: #6b4400; --amber-edge: #b8860b; --amber-bg: #fff6e0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    color: var(--dr3-ink);
    font-size: 8pt;
  }
  /* The whole decision band. Fixed height so the receipt window beneath it is
     guaranteed clear; the receipt is drawn into that space by pdf-lib after this
     page is printed, and any ink that escaped here would land on top of it. */
  .band { height: ${BAND_CONTENT_PT}pt; overflow: hidden; display: flex; flex-direction: column; }

  /* Every band row is rigid EXCEPT .audit. Without this, flex-shrink defaults to
     1 and an over-long statement would squeeze the receipt strip — the one line
     that tells Mary whether the receipt is on the page — instead of clipping the
     prose. The strip must never be the thing that gives way. */
  .topline, .strip, .sigs, .note, .receipt-strip { flex: 0 0 auto; }

  .topline { display: flex; align-items: flex-start; justify-content: space-between;
             border-bottom: 1.5pt solid var(--dr3-green); padding-bottom: 2pt; }
  .brand { color: var(--dr3-green-deep); font-weight: 800; font-size: 10pt; letter-spacing: .03em; }
  .req { font-size: 7pt; color: #444; margin-top: 1.5pt; }
  /* Amount + beneficiary are the visual anchor: what is owed, and to whom. */
  .anchor { text-align: right; }
  .amt { font-size: 16pt; font-weight: 800; color: var(--dr3-green-deep); line-height: 1; }
  .ben { font-size: 8.5pt; font-weight: 700; margin-top: 1pt; }

  .strip { display: flex; gap: 6pt; padding: 3pt 0 2pt; }
  .cell { flex: 1 1 0; min-width: 0; }
  .cell span, .card span, .note span { display: block; font-size: 6pt; color: #666;
    text-transform: uppercase; letter-spacing: .05em; }
  .cell b { display: block; font-size: 7.5pt; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

  .sigs { display: flex; gap: 6pt; }
  .card { flex: 1 1 0; min-width: 0; border: .5pt solid #cfdcda; background: #f6faf9;
    border-left: 2pt solid var(--dr3-green); padding: 2pt 4pt; }
  /* Name and timestamp share ONE line. Stacking them cost a whole line per card
     — two lines of band height — that the audit statement needs more. */
  .card b { font-size: 8.5pt; }
  .card i { font-size: 7pt; font-style: normal; color: #444; }
  .card .line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Label and note share ONE line — a stacked label cost a full line of band
     height that the audit statement needs, and the note is a short aside. */
  .note { padding-top: 2pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .note span { display: inline; }
  .note b { font-size: 7.5pt; }

  /* Flexes to absorb whatever the rows above leave, so the band always fills its
     fixed height exactly and the receipt strip stays pinned to the bottom.
     7pt (not 8) because this statement is the audit fact the whole document
     exists to make, and it must render COMPLETE on every variant — the free-text
     wording is materially longer than the roster wording, and a statement that
     stops mid-clause is worse than a smaller one that finishes. */
  .audit { flex: 1 1 auto; overflow: hidden; font-size: 7pt; line-height: 1.26;
    border-left: 2pt solid var(--dr3-green); background: #f2f7f6;
    padding: 2.5pt 5pt; margin-top: 2pt; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 6.5pt; }

  .receipt-strip { font-size: 7.5pt; font-weight: 700; padding: 2.5pt 5pt; margin-top: 2pt;
    border-left: 2.5pt solid; overflow: hidden; }
  .receipt-strip.ok { color: var(--dr3-green-deep); background: #eef5f3; border-left-color: var(--dr3-green); }
  .receipt-strip.warn { color: var(--amber-ink); background: var(--amber-bg); border-left-color: var(--amber-edge); }

  /* Sits in the bottom ${LETTER.height - DECISION_BAND_PT - PAGE1_RECEIPT_WINDOW.height}pt
     of the page, below the receipt window. Kept short so it cannot grow into it. */
  .stamp { position: fixed; bottom: 0; left: 0; right: 0; background: var(--dr3-green-deep);
    color: #fff; font-weight: 700; font-size: 7pt; letter-spacing: .01em;
    padding: 2.5pt 6pt; text-align: center; }
</style></head>
<body>
  <div class="band">
    <div class="topline">
      <div>
        <div class="brand">DR3-Vision · Employee Reimbursement Approval</div>
        <div class="req">Request ${escapeHtml(input.id)} · Decision <b>APPROVED</b></div>
      </div>
      <div class="anchor">
        <div class="amt">${escapeHtml(usd(input.amount_cents))}</div>
        <div class="ben">${escapeHtml(pdfBeneficiaryLabel(input))}</div>
      </div>
    </div>
    <div class="strip">
      ${cell('Date of expense', pacificDateLabel(input.expense_date))}
      ${cell('Category', titleCase(input.category))}
      ${cell('Site', input.site.name)}
      ${cell('What it was for', input.purpose)}
    </div>
    <div class="sigs">
      ${sigCard(
        'Submitted by (first signature)',
        input.submitter.name,
        `${formatPacificDateTime(input.submitted_at)} PT`,
      )}
      ${sigCard(
        'Approved by (second signature)',
        input.second_approver?.name ?? '',
        input.second_approved_at ? `${formatPacificDateTime(input.second_approved_at)} PT` : '',
      )}
    </div>
    ${noteRow}
    ${segregationStatementHtml(input)}
    ${receiptStripHtml(input, receipt)}
  </div>
  <div class="stamp">${stamp}</div>
</body></html>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Receipt loading
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read the receipt bytes for a storage key. `getFileDropBytes` has two failure
 * shapes that must not be conflated: it RETURNS NULL when R2 is unconfigured or
 * the key is a non-fetchable placeholder, and it THROWS when the GetObject call
 * itself fails. Both end up as `unavailable`, but with different reasons, so the
 * PDF can say which one happened.
 */
export type ReceiptFetcher = (storageKey: string) => Promise<Uint8Array | null>;

const defaultReceiptFetcher: ReceiptFetcher = async (storageKey) => {
  const { getFileDropBytes } = await import('@/lib/r2');
  return getFileDropBytes(storageKey);
};

/** What the receipt bytes actually are, sniffed rather than trusted from metadata. */
type ReceiptFormat = 'pdf' | 'jpeg' | 'png' | 'unknown';

function sniffFormat(bytes: Uint8Array): ReceiptFormat {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return 'pdf'; // %PDF
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  return 'unknown';
}

// ────────────────────────────────────────────────────────────────────────────
// Composition
// ────────────────────────────────────────────────────────────────────────────

/**
 * pdf-lib's standard fonts are WinAnsi-encoded and THROW on any character outside
 * that set, so one accented or non-Latin character in a name would take down the
 * whole spill-page stamp. Substituting the unencodable few keeps the page — and
 * its 'receipt page N of M' traceability — rather than losing a document to a
 * name. Kept: printable ASCII, the Latin-1 supplement, and the WinAnsi
 * punctuation the stamp lines actually use.
 */
function winAnsi(s: string): string {
  return s.replace(/[^ -~ -ÿ‘’“”–—…•]/g, '?');
}

/** Trim to fit a measured width, ellipsizing rather than overflowing the band. */
function fitText(text: string, measure: (t: string) => number, maxWidth: number): string {
  if (measure(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && measure(`${t}…`) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** Uniform scale-to-fit — the aspect ratio is preserved for every receipt shape. */
export function fitBox(
  content: { width: number; height: number },
  box: { width: number; height: number },
): { width: number; height: number; scale: number } {
  const scale = Math.min(box.width / content.width, box.height / content.height);
  return { width: content.width * scale, height: content.height * scale, scale };
}

/** Centre the fitted content inside its window. */
function placeInBox(
  fitted: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  return {
    x: box.x + (box.width - fitted.width) / 2,
    y: box.y + (box.height - fitted.height) / 2,
  };
}

/** A receipt page, either an embedded PDF page or an embedded raster image. */
type Drawable = {
  width: number;
  height: number;
  draw: (page: PdfLibPage, at: { x: number; y: number; width: number; height: number }) => void;
};

// pdf-lib is dynamically imported (edge-safe, lazy — mirrors the Playwright
// import in @/lib/ap/stamp), so its types are referenced structurally here rather
// than imported at module scope.
interface PdfLibPage {
  drawRectangle(o: Record<string, unknown>): void;
  drawText(t: string, o: Record<string, unknown>): void;
}

/**
 * Why the receipt could not be drawn, as a sentence fragment that reads correctly
 * inside "RECEIPT COULD NOT BE REPRODUCED HERE (…)".
 */
class ReceiptUnavailable extends Error {}

/**
 * What the stored bytes turn out to be, and how many pages they will occupy.
 *
 * Probed BEFORE the band is rendered, because the receipt strip on page 1 has to
 * state the true page count — printing "page 1 of 1" on a 3-page packet would be
 * a claim the document itself disproves. Probing first also means the band is
 * rendered exactly ONCE on every path, including the failure paths: Chromium is
 * capped at one concurrent render, so a second one is real contention on the
 * money path rather than a rounding error.
 */
type ReceiptProbe =
  | { format: 'pdf'; pageCount: number; bytes: Uint8Array }
  | { format: 'jpeg' | 'png'; pageCount: 1; bytes: Uint8Array };

/**
 * Decide what the receipt is and how many pages it needs. Pure pdf-lib, no
 * Chromium. Throws {@link ReceiptUnavailable} naming the reason.
 */
async function probeReceipt(receiptBytes: Uint8Array): Promise<ReceiptProbe> {
  const format = sniffFormat(receiptBytes);
  if (format === 'jpeg' || format === 'png') {
    return { format, pageCount: 1, bytes: receiptBytes };
  }
  if (format !== 'pdf') {
    throw new ReceiptUnavailable('the stored file is not a PDF, JPEG or PNG');
  }
  const { PDFDocument } = await import('pdf-lib');
  let pageCount: number;
  try {
    // Garbage, truncated, or password-protected input throws here — pdf-lib
    // cannot decrypt, and we would rather say so than emit blank pages.
    pageCount = (await PDFDocument.load(receiptBytes)).getPageCount();
  } catch {
    throw new ReceiptUnavailable('the stored file is not a readable PDF');
  }
  if (pageCount === 0) throw new ReceiptUnavailable('the stored PDF has no pages');
  return { format: 'pdf', pageCount, bytes: receiptBytes };
}

/**
 * Compose the receipt into the rendered decision band and return the finished
 * document. Pure pdf-lib + sharp — no Chromium — so it runs outside the render
 * semaphore and is unit-testable without a browser.
 *
 * Throws {@link ReceiptUnavailable} when the receipt cannot be reproduced; the
 * caller re-renders the band with the amber strip rather than shipping a document
 * whose strip claims a receipt that is not on the page.
 */
async function composeReceipt(
  bandPdf: Buffer,
  probe: ReceiptProbe,
  input: ReimbursementDecisionPdfInput,
  decidedAt: Date,
): Promise<{ pdf: Buffer; pageCount: number }> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

  const out = await PDFDocument.load(bandPdf);
  if (out.getPageCount() !== 1) {
    // The band is a fixed-height, overflow-hidden block, so this is unreachable by
    // data. If it ever fires, the layout is broken in a way that would silently
    // put band text on top of the receipt — refuse rather than compose.
    throw new ReceiptUnavailable(
      `the decision band rendered to ${out.getPageCount()} pages instead of 1`,
    );
  }

  const drawables: Drawable[] = [];

  if (probe.format === 'pdf') {
    const src = await PDFDocument.load(probe.bytes);
    const embedded = await out.embedPages(src.getPages());
    for (const e of embedded) {
      drawables.push({
        width: e.width,
        height: e.height,
        draw: (page, at) =>
          (page as unknown as { drawPage: (p: unknown, o: unknown) => void }).drawPage(e, at),
      });
    }
  } else {
    // A phone photo of a receipt is the common case, and pdf-lib embeds JPEG and
    // PNG natively — no decode dependency.
    const img =
      probe.format === 'jpeg' ? await out.embedJpg(probe.bytes) : await out.embedPng(probe.bytes);
    drawables.push({
      width: img.width,
      height: img.height,
      draw: (page, at) =>
        (page as unknown as { drawImage: (i: unknown, o: unknown) => void }).drawImage(img, at),
    });
  }

  const pageCount = drawables.length;
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const bandColor = rgb(0, 0x3d / 255, 0x38 / 255);

  // Page 1: the first receipt page in the window beneath the decision band.
  const first = drawables[0]!;
  const firstFit = fitBox(first, PAGE1_RECEIPT_WINDOW);
  const firstAt = placeInBox(firstFit, PAGE1_RECEIPT_WINDOW);
  first.draw(out.getPage(0) as unknown as PdfLibPage, {
    x: firstAt.x,
    y: firstAt.y,
    width: firstFit.width,
    height: firstFit.height,
  });

  // Pages 2..N: one receipt page each, nearly full-bleed, each stamped with its
  // place in the receipt so no page is orphanable.
  for (let i = 1; i < drawables.length; i++) {
    const d = drawables[i]!;
    const page = out.addPage([LETTER.width, LETTER.height]);
    const fit = fitBox(d, SPILL_RECEIPT_WINDOW);
    const at = placeInBox(fit, SPILL_RECEIPT_WINDOW);
    d.draw(page as unknown as PdfLibPage, {
      x: at.x,
      y: at.y,
      width: fit.width,
      height: fit.height,
    });

    page.drawRectangle({
      x: 0,
      y: 0,
      width: LETTER.width,
      height: SPILL_STAMP_BAND_PT,
      color: bandColor,
    });
    const size = 9;
    const line = fitText(
      winAnsi(receiptPageStampLine(input, i + 1, pageCount)),
      (t) => bold.widthOfTextAtSize(t, size),
      LETTER.width - 32,
    );
    page.drawText(line, {
      x: (LETTER.width - bold.widthOfTextAtSize(line, size)) / 2,
      y: SPILL_STAMP_BAND_PT / 2 - size / 2 + 1,
      size,
      font: bold,
      color: rgb(1, 1, 1),
    });
  }

  // Pin metadata so the tamper-record sha256 is reproducible for a given
  // (row, receipt bytes) pair rather than moving with the clock — mirrors
  // @/lib/ap/stamp.ts.
  pinMetadata(out, decidedAt);
  const bytes = await savePdf(out, decidedAt);
  if (bytes.length <= COMPOSED_PDF_BUDGET_BYTES) return { pdf: bytes, pageCount };

  // Over budget. Re-encode the scanned JPEGs down the ladder, always from the
  // ORIGINAL bytes so quality loss does not compound across rungs.
  return { pdf: await shrinkToBudget(out, drawables.length, decidedAt, bytes), pageCount };
}

/**
 * Pin the metadata and serialize. `PDFDocument.save()` yields a Uint8Array over
 * an ArrayBufferLike; the copy through `new Uint8Array` narrows it to a plain
 * ArrayBuffer so the result is a `Buffer<ArrayBuffer>`, which is what the
 * attachment and sha256 contracts are typed against.
 */
async function savePdf(
  doc: { save: () => Promise<Uint8Array> } & Parameters<typeof pinMetadata>[0],
  decidedAt: Date,
): Promise<Buffer> {
  pinMetadata(doc, decidedAt);
  return Buffer.from(new Uint8Array(await doc.save()));
}

function pinMetadata(
  doc: {
    setProducer: (s: string) => void;
    setCreationDate: (d: Date) => void;
    setModificationDate: (d: Date) => void;
  },
  decidedAt: Date,
): void {
  doc.setProducer('DR3-Vision');
  doc.setCreationDate(decidedAt);
  doc.setModificationDate(decidedAt);
}

/**
 * The widest any single receipt page is drawn in this document, in inches — the
 * size the {@link MIN_EFFECTIVE_DPI} floor is measured against. A one-page
 * receipt only ever appears in the (smaller) page-1 window, so it tolerates a
 * lower pixel count than a multi-page receipt drawn nearly full-bleed.
 */
function widestDrawnInches(pageCount: number): number {
  const box = pageCount > 1 ? SPILL_RECEIPT_WINDOW : PAGE1_RECEIPT_WINDOW;
  return box.width / 72;
}

/**
 * Walk the document's image XObjects, re-encode the `/DCTDecode` (scanned JPEG)
 * streams at successively smaller widths, and stop at the first rung that fits
 * the budget. VECTOR receipts are untouched by construction — only DCTDecode
 * streams are candidates — so a crisp digital receipt is never rasterised.
 *
 * Throws {@link ReceiptUnavailable} when no rung fits, rather than returning an
 * over-budget document: an attachment the transport will refuse is exactly the
 * silent non-delivery this whole feature is trying not to produce.
 */
async function shrinkToBudget(
  doc: Awaited<ReturnType<typeof import('pdf-lib').PDFDocument.load>>,
  pageCount: number,
  decidedAt: Date,
  originalOutput: Buffer,
): Promise<Buffer> {
  const { PDFRawStream, PDFName, PDFNumber } = await import('pdf-lib');

  let sharpLib: typeof import('sharp');
  try {
    sharpLib = (await import('sharp')).default as unknown as typeof import('sharp');
  } catch {
    throw new ReceiptUnavailable(
      `it is ${Math.round(originalOutput.length / 1024)} KB, over the ${Math.round(
        COMPOSED_PDF_BUDGET_BYTES / 1024,
      )} KB attachment budget, and the image resizer is unavailable to shrink it`,
    );
  }

  interface JpegSlot {
    ref: unknown;
    dict: {
      get: (k: unknown) => unknown;
      set: (k: unknown, v: unknown) => void;
      delete: (k: unknown) => void;
    };
    original: Uint8Array;
  }

  const slots: JpegSlot[] = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (String(dict.get(PDFName.of('Subtype'))) !== '/Image') continue;
    if (String(dict.get(PDFName.of('Filter'))) !== '/DCTDecode') continue;
    // An alpha channel or a CMYK/indexed colour space cannot survive a naive JPEG
    // round-trip without risking an inverted or mis-mapped image. Leave those
    // alone — a receipt that is the wrong colour is worse than one that is large.
    if (dict.get(PDFName.of('SMask')) !== undefined) continue;
    const cs = String(dict.get(PDFName.of('ColorSpace')));
    if (cs !== '/DeviceRGB' && cs !== '/DeviceGray') continue;
    slots.push({ ref, dict: dict as unknown as JpegSlot['dict'], original: obj.getContents() });
  }

  const overBudgetBy = `${Math.round(originalOutput.length / 1024)} KB against a ${Math.round(
    COMPOSED_PDF_BUDGET_BYTES / 1024,
  )} KB budget`;

  if (slots.length === 0) {
    throw new ReceiptUnavailable(
      `it is ${overBudgetBy} and carries no re-encodable scanned image to shrink`,
    );
  }

  const maxInches = widestDrawnInches(pageCount);

  for (const targetWidth of DOWNSCALE_LADDER_PX) {
    // The readability floor is measured against the size the page is actually
    // drawn at, not against the pixel count in isolation.
    if (targetWidth / maxInches < MIN_EFFECTIVE_DPI) continue;

    for (const slot of slots) {
      const encoded = await sharpLib(Buffer.from(slot.original))
        .resize({ width: targetWidth, withoutEnlargement: true })
        .jpeg({ quality: DOWNSCALE_QUALITY })
        .toBuffer({ resolveWithObject: true });

      slot.dict.set(PDFName.of('Width'), PDFNumber.of(encoded.info.width));
      slot.dict.set(PDFName.of('Height'), PDFNumber.of(encoded.info.height));
      slot.dict.set(
        PDFName.of('ColorSpace'),
        PDFName.of(encoded.info.channels === 1 ? 'DeviceGray' : 'DeviceRGB'),
      );
      slot.dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      slot.dict.delete(PDFName.of('DecodeParms'));
      slot.dict.delete(PDFName.of('Decode'));
      doc.context.assign(
        slot.ref as Parameters<typeof doc.context.assign>[0],
        PDFRawStream.of(slot.dict as never, new Uint8Array(encoded.data)),
      );
    }

    const candidate = await savePdf(doc, decidedAt);
    if (candidate.length <= COMPOSED_PDF_BUDGET_BYTES) return candidate;
  }

  // Every rung either overshot the budget or would have gone under the DPI floor.
  // Surfaced, never shipped.
  throw new ReceiptUnavailable(
    `it is ${overBudgetBy} and cannot be shrunk further without dropping below ${MIN_EFFECTIVE_DPI} DPI`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export interface ReimbursementPdfDeps {
  /** Injectable so composition is testable without Chromium. */
  renderer?: PdfRenderer;
  /** Injectable so composition is testable without R2. */
  fetchReceipt?: ReceiptFetcher;
}

/**
 * Render the stamped reimbursement decision PDF with the receipt composed onto
 * it. Throws {@link ReimbursementPdfUnprovableError} when the row cannot evidence
 * the dual signature, and propagates renderer failures — callers on the fail-soft
 * notify path should use {@link reimbursementDecisionAttachment} instead of
 * catching these by hand.
 *
 * A receipt that cannot be reproduced NEVER fails the render: the band is
 * re-rendered with the amber strip naming the reason, and the reason comes back
 * on `receipt` for the caller to report.
 */
export async function renderReimbursementDecisionPdf(
  input: ReimbursementDecisionPdfInput,
  renderer: PdfRenderer = defaultPlaywrightRenderer,
  deps: ReimbursementPdfDeps = {},
): Promise<ReimbursementDecisionPdf> {
  assertDualSignature(input);
  // Guaranteed non-null by assertDualSignature; pinned so the sha256 is a function
  // of the record rather than of the clock.
  const decidedAt = input.second_approved_at!;
  const fetchReceipt = deps.fetchReceipt ?? defaultReceiptFetcher;
  const filename = `reimbursement-decision-${input.id}.pdf`;

  const finish = (pdf: Buffer, receipt: ReceiptPresentation): ReimbursementDecisionPdf => ({
    pdf,
    sha256: sha256Hex(pdf),
    filename,
    receipt,
  });

  if (!input.receipt_file_key) {
    const pdf = await renderer(buildReimbursementDecisionHtml(input, { kind: 'absent' }));
    return finish(pdf, { kind: 'absent' });
  }

  // Fetch and PROBE before rendering: the strip on page 1 has to state the true
  // page count, so the band cannot be printed until the receipt is understood.
  // Everything up to here is pure pdf-lib, which keeps the Chromium render to
  // exactly one on every path — success and failure alike.
  let probe: ReceiptProbe | null = null;
  let unavailable: string | null = null;
  try {
    const bytes = await fetchReceipt(input.receipt_file_key);
    // A null here is R2 unconfigured or a non-fetchable placeholder key — not an
    // error, but not a receipt either.
    if (bytes === null) unavailable = 'it could not be read from file storage';
    else if (bytes.length === 0) unavailable = 'the stored file is empty';
    else probe = await probeReceipt(bytes);
  } catch (e) {
    // getFileDropBytes THROWS on a GetObject failure, unlike its null return;
    // probeReceipt throws ReceiptUnavailable with its own wording.
    unavailable =
      e instanceof ReceiptUnavailable
        ? e.message
        : `file storage returned an error (${e instanceof Error ? e.message : String(e)})`;
  }

  if (probe && unavailable === null) {
    const band = await renderer(
      buildReimbursementDecisionHtml(input, {
        kind: 'reproduced',
        pageCount: probe.pageCount,
      }),
    );
    try {
      const { pdf, pageCount } = await composeReceipt(band, probe, input, decidedAt);
      return finish(pdf, { kind: 'reproduced', pageCount });
    } catch (e) {
      // Composition failed AFTER the band claimed the receipt was on the page.
      // The band must be re-rendered rather than shipped — a green strip over a
      // blank window is exactly the false statement this module refuses to print.
      unavailable =
        e instanceof ReceiptUnavailable ? e.message : e instanceof Error ? e.message : String(e);
    }
  }

  const receipt: ReceiptPresentation = {
    kind: 'unavailable',
    reason: unavailable ?? 'the receipt could not be reproduced',
  };
  const pdf = await renderer(buildReimbursementDecisionHtml(input, receipt));
  return finish(pdf, receipt);
}

/** Exactly the attachment shape `notifyStaff({ attachments })` accepts. */
export interface ReimbursementPdfAttachment {
  filename: string;
  buffer: Buffer;
  contentType: string;
}

export type ReimbursementAttachmentOutcome =
  | {
      attachment: ReimbursementPdfAttachment;
      sha256: string;
      receipt: ReceiptPresentation;
      problem: string | null;
    }
  | { attachment: null; sha256: null; receipt: null; problem: string };

/**
 * Fail-soft wrapper for the decision-mail path: never throws, and on failure
 * returns a `problem` sentence to push onto the caller's `problems[]` rather
 * than a silent null. A missing PDF must not block Mary's mail — but it must not
 * be invisible either, because "approved, no artefact" is the shape an auditor
 * would later read as a control that produced nothing.
 *
 * Note the two independent failure axes: the PDF itself may fail to render (no
 * attachment at all), or it may render fine while the RECEIPT on it could not be
 * reproduced (attachment present, `problem` set). Both are reported; only the
 * first loses the document.
 */
export async function reimbursementDecisionAttachment(
  input: ReimbursementDecisionPdfInput,
  renderer: PdfRenderer = defaultPlaywrightRenderer,
  deps: ReimbursementPdfDeps = {},
): Promise<ReimbursementAttachmentOutcome> {
  try {
    const { pdf, sha256, filename, receipt } = await renderReimbursementDecisionPdf(
      input,
      renderer,
      deps,
    );
    return {
      attachment: { filename, buffer: pdf, contentType: 'application/pdf' },
      sha256,
      receipt,
      problem: receiptProblemSentence(input, receipt),
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      attachment: null,
      sha256: null,
      receipt: null,
      problem: `Reimbursement ${input.id}: the stamped decision PDF could not be produced (${why}) — the mail carries the detail in its body, but no stamped artefact is attached.`,
    };
  }
}
