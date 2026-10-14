// ADR-0136 Amendment 2 — an invoice that is ALREADY approved is rejected at intake.
//
// 2026-10-13 15:27–16:13 PT: AP re-forwarded ~28 United Fleet Maintenance invoices
// that had been approved in September. Each became a normal pending request and
// approvers rejected every one by hand ("already approved by X on 09-09"). The
// ADR-0136 guard only ran at Approve time, so the approvers did the matching.
//
// This runs the SAME match (findApprovedDuplicates) right after the request is
// created, but ACTS on a narrower subset of it, and on a hit rejects it through decideRequest
// — the one decision path, so the audit row, the stamped original and the decision
// mail are exactly what a human Reject produces. Bill chose auto-reject over
// flag-and-hold (2026-10-14).
//
// SAFEGUARDS, because the loose key is biased toward false matches by design:
// - AP_AUTO_REJECT_DUPLICATES=false|0 turns it off (default ON).
// - Only two keys can reject on their own: (a) the invoice number with the vendor
//   CONFIRMED on both sides (a blank vendor matches anything in the loose check), or
//   the number corroborated by a byte-identical file; (b) Vision's own approval mail
//   forwarded back. A SAME-FILE-ONLY match never rejects: one PDF can legitimately be
//   two approvals (a statement), so it stays pending for the Approve-time prompt.
// - A subject/body that says it is a correction, resubmission, amendment, credit
//   memo, reissue or replacement stays PENDING for a person: the invoice-6646
//   re-forward "-Note Correction" was a legitimate re-send.
// - Only a TERMINAL `approved` original counts. A `pending_second_approval` original
//   can still be overridden to rejected, and then this copy is the one to keep.
// - The original must have been filed against a DR3 site; the rejection files under
//   that same site (decideRequest refuses a decision without one).
// Every non-rejection leaves the request exactly as a normal pending request.

import type { PrismaClient } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { formatPacificDateTime } from '@/lib/time';
import { decideRequest, type ApMailOutcome } from './approvals';
import {
  AP_DUPLICATE_GUARD_ACTOR,
  findApprovedDuplicates,
  invoiceFileHashes,
  type DuplicateApproval,
  type DuplicateCheck,
} from './duplicate-invoice';

/** Correction / resubmission wording that means "a person should look at this". */
const CORRECTION_LANGUAGE =
  /\b(?:correct(?:ion|ions|ed)|revised|revision|re-?submi(?:t|ts|tted|ssion)|updated\s+invoice|amend(?:ed|ment|ments)?|credit\s*memos?|re-?issue[ds]?|replacement)\b/i;

export function hasCorrectionLanguage(...texts: readonly (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && CORRECTION_LANGUAGE.test(t));
}

type EnvLike = Readonly<Record<string, string | undefined>>;

/** Kill switch: AP_AUTO_REJECT_DUPLICATES=false or 0 disables; anything else is ON. */
export function autoRejectEnabled(env: EnvLike = process.env): boolean {
  const v = (env['AP_AUTO_REJECT_DUPLICATES'] ?? '').trim().toLowerCase();
  return v !== 'false' && v !== '0';
}

export type AutoRejectSkip =
  | 'disabled'
  | 'correction_language'
  | 'no_key'
  | 'no_match'
  | 'original_not_terminal'
  /** Invoice number matched, but the vendor is blank on one side (no file corroboration). */
  | 'vendor_unconfirmed'
  /** Only the invoice FILE matched — may be a statement; left for the Approve-time prompt. */
  | 'file_only_match'
  | 'decide_failed';

export type AutoRejectVerdict =
  | { rejected: true; matchedRequestIds: string[]; mail: ApMailOutcome }
  | { rejected: false; skip: AutoRejectSkip };

export interface AutoRejectArgs {
  requestId: string;
  subject: string | null;
  bodyText: string | null;
  /** Vendor spellings known at intake (the extracted vendor). */
  vendors: readonly (string | null | undefined)[];
}

export interface AutoRejectOptions {
  env?: EnvLike;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Reject a just-created request when it duplicates an already-approved invoice.
 * Never throws: any failure leaves the request pending (the decision-time guard
 * still stands in front of an Approve).
 */
export async function autoRejectIfDuplicate(
  prisma: PrismaClient,
  args: AutoRejectArgs,
  opts: AutoRejectOptions = {},
): Promise<AutoRejectVerdict> {
  const log = opts.log ?? ((): void => undefined);
  if (!autoRejectEnabled(opts.env)) return { rejected: false, skip: 'disabled' };
  if (hasCorrectionLanguage(args.subject, args.bodyText)) {
    return { rejected: false, skip: 'correction_language' };
  }
  let dup: DuplicateCheck | null = null;
  let original: DuplicateApproval | null = null;
  let mail: ApMailOutcome;
  try {
    // Intake records each file's sha256 as it is stored, so nothing is re-read here;
    // a file stored without bytes has no hash and simply narrows the check.
    const files = await invoiceFileHashes(prisma, args.requestId, async () => null);
    dup = await findApprovedDuplicates(prisma, {
      requestId: args.requestId,
      subject: args.subject,
      vendors: args.vendors,
      fileHashes: files.hashes,
    });
    if (!dup) return { rejected: false, skip: 'no_key' };
    if (dup.matches.length === 0) return { rejected: false, skip: 'no_match' };
    const terminal = dup.matches.filter((m) => m.status === 'approved' && !!m.siteId);
    if (terminal.length === 0) return { rejected: false, skip: 'original_not_terminal' };
    original = terminal.find(canAutoReject) ?? null;
    if (!original?.siteId) {
      return {
        rejected: false,
        skip: terminal.some((m) => m.sameInvoiceNumber) ? 'vendor_unconfirmed' : 'file_only_match',
      };
    }

    const approverName = original.approvedBy
      ? ((
          await prisma.user.findUnique({
            where: { id: original.approvedBy },
            select: { name: true },
          })
        )?.name ?? 'an approver')
      : 'an approver';
    const invoice =
      dup.invoiceNumber && original.sameInvoiceNumber
        ? `invoice ${dup.invoiceNumber}`
        : 'its own approval mail, forwarded back';
    const when = original.approvedAt
      ? `${formatPacificDateTime(original.approvedAt)} PT`
      : 'date unknown';
    const note = `Auto-rejected: duplicate of already-approved request ${original.requestId} (${invoice}, approved ${when} by ${approverName}).`;

    const res = await decideRequest({
      prisma,
      requestId: args.requestId,
      decision: 'rejected',
      actorUserId: AP_DUPLICATE_GUARD_ACTOR,
      siteId: original.siteId,
      note,
    });
    mail = res.mail;
  } catch (e) {
    // decideRequest commits the flip + its audit row BEFORE the decision mail is
    // built and sent; a throw from that post-commit work must not be reported as
    // "not rejected" (ingest would then announce an already-rejected request as new
    // work). Read the row back and believe it, not the exception.
    log('warn', `[ap-ingest] duplicate auto-reject threw for ${args.requestId} (${describe(e)})`);
    const committed =
      dup && original
        ? await prisma.apRequest
            .findUnique({
              where: { id: args.requestId },
              select: { status: true, decided_by: true },
            })
            .catch(() => null)
        : null;
    if (committed?.status !== 'rejected' || committed.decided_by !== AP_DUPLICATE_GUARD_ACTOR) {
      return { rejected: false, skip: 'decide_failed' };
    }
    // Committed, mail not confirmed: the ADR-0126 sweep sees decision_mail_sent_at
    // NULL and the existing Re-send button is the repair.
    mail = 'failed';
  }
  if (!dup || !original) return { rejected: false, skip: 'decide_failed' };

  // The rejection is committed (with decideRequest's own `won` audit row). This row
  // names WHY; a failure to write it is logged, never reported as "not rejected".
  const matchedRequestIds = dup.matches.map((m) => m.requestId);
  try {
    await writeAudit({
      actor_label: AP_DUPLICATE_GUARD_ACTOR,
      action: 'update',
      table_name: 'ap_requests',
      row_id: args.requestId,
      after: {
        outcome: 'auto_rejected_duplicate',
        status: 'rejected',
        invoice_number: dup.invoiceNumber,
        forwarded_approval: dup.forwardedApproval,
        matched_request_ids: matchedRequestIds,
        same_file_request_ids: dup.matches.filter((m) => m.sameFile).map((m) => m.requestId),
        rejected_against: original.requestId,
        rejected_on: original.forwardedApproval ? 'forwarded_approval' : 'invoice_number',
        mail,
      },
    });
  } catch (e) {
    log(
      'error',
      `[ap-ingest] auto-reject audit write failed for ${args.requestId}: ${describe(e)}`,
    );
  }
  return { rejected: true, matchedRequestIds, mail };
}

/**
 * The keys strong enough to reject without a person: Vision's own approval mail
 * forwarded back, or the invoice number with the vendor confirmed on both sides or
 * corroborated by the same file. A file-only match is never enough (statements).
 */
function canAutoReject(m: DuplicateApproval): boolean {
  if (m.forwardedApproval) return true;
  return m.sameInvoiceNumber && (m.vendorConfirmed || m.sameFile);
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
