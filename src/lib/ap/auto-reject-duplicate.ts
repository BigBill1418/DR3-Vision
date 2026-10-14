// ADR-0136 Amendment 2 — an invoice that is ALREADY approved is rejected at intake.
//
// 2026-10-13 15:27–16:13 PT: AP re-forwarded ~28 United Fleet Maintenance invoices
// that had been approved in September. Each became a normal pending request and
// approvers rejected every one by hand ("already approved by X on 09-09"). The
// ADR-0136 guard only ran at Approve time, so the approvers did the matching.
//
// This runs the SAME match (findApprovedDuplicates: invoice number + compatible
// vendor, byte-identical invoice file, or Vision's own approval mail forwarded back)
// right after the request is created, and on a hit rejects it through decideRequest
// — the one decision path, so the audit row, the stamped original and the decision
// mail are exactly what a human Reject produces. Bill chose auto-reject over
// flag-and-hold (2026-10-14).
//
// SAFEGUARDS, because the loose key is biased toward false matches by design:
// - AP_AUTO_REJECT_DUPLICATES=false|0 turns it off (default ON).
// - A subject/body that says it is a correction or resubmission stays PENDING for a
//   person: the invoice-6646 re-forward "-Note Correction" was a legitimate re-send.
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
  type DuplicateCheck,
} from './duplicate-invoice';

/** Correction / resubmission wording that means "a person should look at this". */
const CORRECTION_LANGUAGE =
  /\b(?:correct(?:ion|ions|ed)|revised|revision|re-?submi(?:t|ts|tted|ssion)|updated\s+invoice)\b/i;

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
  let decided: { original: string; dup: DuplicateCheck; mail: ApMailOutcome };
  try {
    // Intake records each file's sha256 as it is stored, so nothing is re-read here;
    // a file stored without bytes has no hash and simply narrows the check.
    const files = await invoiceFileHashes(prisma, args.requestId, async () => null);
    const dup = await findApprovedDuplicates(prisma, {
      requestId: args.requestId,
      subject: args.subject,
      vendors: args.vendors,
      fileHashes: files.hashes,
    });
    if (!dup) return { rejected: false, skip: 'no_key' };
    if (dup.matches.length === 0) return { rejected: false, skip: 'no_match' };
    const original = dup.matches.find((m) => m.status === 'approved' && !!m.siteId);
    if (!original?.siteId) return { rejected: false, skip: 'original_not_terminal' };

    const approverName = original.approvedBy
      ? ((
          await prisma.user.findUnique({
            where: { id: original.approvedBy },
            select: { name: true },
          })
        )?.name ?? 'an approver')
      : 'an approver';
    const invoice = dup.invoiceNumber
      ? `invoice ${dup.invoiceNumber}`
      : original.sameFile
        ? 'the same invoice file'
        : 'the same invoice';
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
    decided = { original: original.requestId, dup, mail: res.mail };
  } catch (e) {
    log('warn', `[ap-ingest] duplicate auto-reject failed for ${args.requestId} (${describe(e)})`);
    return { rejected: false, skip: 'decide_failed' };
  }

  // The rejection is committed (with decideRequest's own `won` audit row). This row
  // names WHY; a failure to write it is logged, never reported as "not rejected".
  const { dup } = decided;
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
        rejected_against: decided.original,
        mail: decided.mail,
      },
    });
  } catch (e) {
    log(
      'error',
      `[ap-ingest] auto-reject audit write failed for ${args.requestId}: ${describe(e)}`,
    );
  }
  return { rejected: true, matchedRequestIds, mail: decided.mail };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
