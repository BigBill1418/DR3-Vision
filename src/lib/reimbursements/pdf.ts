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
// stamp band, same diagonal watermark.
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

import { formatPacificDateTime, pacificDateLabel } from '@/lib/time';
import { defaultPlaywrightRenderer, sha256Hex, type PdfRenderer } from '@/lib/ap/stamp';

/**
 * The reimbursement row this document is rendered from. Deliberately a structural
 * subset of the notify-path row so the caller can pass what it already loaded —
 * it must additionally select `second_approver_id`, which is what makes the
 * printed exclusion claims verifiable rather than decorative.
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
}

export interface ReimbursementDecisionPdf {
  pdf: Buffer;
  /** sha256 (hex) of the generated PDF — the tamper record. */
  sha256: string;
  filename: string;
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
 * The branded page that gets printed. Self-contained: no external stylesheet,
 * font or image, so the renderer's abort-everything-not-data: route never fires.
 */
export function buildReimbursementDecisionHtml(input: ReimbursementDecisionPdfInput): string {
  const stamp = escapeHtml(reimbursementStampLine(input));
  const note = input.decision_note?.trim();
  const rows: Array<[string, string]> = [
    ['Employee being reimbursed', pdfBeneficiaryLabel(input)],
    ['Amount', usd(input.amount_cents)],
    // The column stores noon UTC of the expense calendar day, so its UTC
    // components ARE the intended day — render them in UTC (see @/lib/time).
    ['Date of expense', pacificDateLabel(input.expense_date)],
    ['Category', titleCase(input.category)],
    ['What it was for', input.purpose],
    ['Site', input.site.name],
    [
      'Submitted by (first signature)',
      `${input.submitter.name} — ${formatPacificDateTime(input.submitted_at)} PT`,
    ],
    [
      'Approved by (second signature)',
      `${input.second_approver?.name ?? ''} — ${
        input.second_approved_at ? formatPacificDateTime(input.second_approved_at) : ''
      } PT`,
    ],
  ];
  if (note) rows.push(['Approver note', note]);

  const table = rows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td><b>${escapeHtml(v)}</b></td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  :root { --dr3-green-deep: #003d38; --dr3-green: #00524C; --dr3-ink: #111; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: var(--dr3-ink); margin: 0; padding: 0 40px 96px; }
  header { border-bottom: 3px solid var(--dr3-green); padding: 24px 0 12px; margin-bottom: 16px; }
  header .brand { color: var(--dr3-green-deep); font-weight: 800; font-size: 18px; letter-spacing: .04em; }
  header .decision { font-size: 13px; color: #444; margin-top: 4px; }
  h2 { font-size: 14px; color: var(--dr3-green-deep); margin: 20px 0 8px; }
  table.detail { border-collapse: collapse; font-size: 12px; width: 100%; }
  table.detail th { text-align: left; color: #555; font-weight: 500; padding: 5px 14px 5px 0; vertical-align: top; width: 220px; }
  table.detail td { padding: 5px 0; vertical-align: top; }
  p.audit { font-size: 12px; line-height: 1.65; border: 1px solid var(--dr3-green); border-left: 5px solid var(--dr3-green); background: #f2f7f6; padding: 10px 12px; margin: 18px 0 0; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }
  .stamp { position: fixed; bottom: 0; left: 0; right: 0; background: var(--dr3-green-deep); color: #fff; font-weight: 700; font-size: 11px; letter-spacing: .02em; padding: 12px 40px; text-align: center; }
  .watermark { position: fixed; top: 44%; left: 0; right: 0; text-align: center; font-size: 40px; font-weight: 800; color: rgba(0,82,76,.10); transform: rotate(-18deg); letter-spacing: .12em; }
</style></head>
<body>
  <header>
    <div class="brand">DR3-Vision · Employee Reimbursement Approval</div>
    <div class="decision">Decision: <b>APPROVED</b> · Request ${escapeHtml(input.id)}</div>
  </header>
  <h2>Reimbursement</h2>
  <table class="detail">${table}</table>
  ${segregationStatementHtml(input)}
  <h2>Receipt</h2>
  <p style="font-size:12px;margin:0">The receipt supplied at submission is held in DR3-Vision against this request. It is not reproduced here.</p>
  <div class="watermark">APPROVED</div>
  <div class="stamp">${stamp}</div>
</body></html>`;
}

/**
 * Render the stamped reimbursement decision PDF. Throws
 * {@link ReimbursementPdfUnprovableError} when the row cannot evidence the dual
 * signature, and propagates renderer failures — callers on the fail-soft notify
 * path should use {@link reimbursementDecisionAttachment} instead of catching
 * these by hand.
 */
export async function renderReimbursementDecisionPdf(
  input: ReimbursementDecisionPdfInput,
  renderer: PdfRenderer = defaultPlaywrightRenderer,
): Promise<ReimbursementDecisionPdf> {
  assertDualSignature(input);
  const pdf = await renderer(buildReimbursementDecisionHtml(input));
  return { pdf, sha256: sha256Hex(pdf), filename: `reimbursement-decision-${input.id}.pdf` };
}

/** Exactly the attachment shape `notifyStaff({ attachments })` accepts. */
export interface ReimbursementPdfAttachment {
  filename: string;
  buffer: Buffer;
  contentType: string;
}

export type ReimbursementAttachmentOutcome =
  | { attachment: ReimbursementPdfAttachment; sha256: string; problem: null }
  | { attachment: null; sha256: null; problem: string };

/**
 * Fail-soft wrapper for the decision-mail path: never throws, and on failure
 * returns a `problem` sentence to push onto the caller's `problems[]` rather
 * than a silent null. A missing PDF must not block Mary's mail — but it must not
 * be invisible either, because "approved, no artefact" is the shape an auditor
 * would later read as a control that produced nothing.
 */
export async function reimbursementDecisionAttachment(
  input: ReimbursementDecisionPdfInput,
  renderer: PdfRenderer = defaultPlaywrightRenderer,
): Promise<ReimbursementAttachmentOutcome> {
  try {
    const { pdf, sha256, filename } = await renderReimbursementDecisionPdf(input, renderer);
    return {
      attachment: { filename, buffer: pdf, contentType: 'application/pdf' },
      sha256,
      problem: null,
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      attachment: null,
      sha256: null,
      problem: `Reimbursement ${input.id}: the stamped decision PDF could not be produced (${why}) — the mail carries the detail in its body, but no stamped artefact is attached.`,
    };
  }
}
