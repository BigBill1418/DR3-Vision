// ADR-0136 — an invoice is approved ONCE.
//
// Invoice 6646 (United Fleet Maintenance, $201.84) reached accounting as two
// approved requests three weeks apart: AP forwarded it, the approver approved it
// with another invoice's explanation pasted in, AP re-forwarded it "for approval
// note correction", and it was approved again. Nothing in Vision noticed, because
// the only duplicate guard was `internet_message_id` UNIQUE — and a re-forward is
// a new message. Each approval mails accounting a stamped invoice to pay.
//
// THE KEY. `ap_requests` has no invoice-number column; the number lives in the
// subject line the vendor (or AP) wrote. This module reads it from there, and
// matches on invoice number + a LOOSE vendor comparison, because the typed vendor
// on the same invoice read "United" once and "united fleet maintenance" the next
// time. Loose is the right bias: a false match costs the approver one sentence
// (the audited override), a missed match can cost a second payment.
//
// THE SECOND KEY — Vision's own approval, forwarded back in. The decision mail's
// subject is `DR3-Vision AP decision (approved — <site>) — <original subject>`;
// when that lands in the AP inbox it becomes a new request carrying the SAME
// invoice (production: a $4,005.00 Kelliher invoice approved a second time this
// way on 2026-09-22). The original subject is inside it, so the approved original
// is found by subject, no invoice number needed.
//
// WHAT IT DOES NOT SEE: a re-forward whose subject names no invoice number
// ("Invoices", "Ramos/EFuel") and is not a forwarded decision. ADR-0136 lists
// that residual; the decision mail's duplicate line (approvals.ts) shares these keys.

import type { PrismaClient } from '@prisma/client';

/**
 * `Invoice: 6646`, `Invoice #: T705145`, `Your Invoice IM25013731`, `Inv 12513`,
 * `invoice 13389- 1 of 4`, `Invoice I-52650`, `Invoice U001P255-Review`,
 * `Invoices 0182 & 0183` (first number only). The token must contain a digit (and so
 * must every `-` segment after the first, so `U001P255-Review` stops at the number), so
 * `Invoice from Clark Pest` and `Invoice eFuel Invoice IN-0342625` skip the word
 * and keep looking.
 */
const INVOICE_TOKEN =
  /\binv(?:oice)?s?\b[\s:#.]*(?:(?:no|num|number)\b[\s:#.]*)?([A-Z0-9]+(?:-[A-Z0-9]*\d[A-Z0-9]*)*)/gi;

/** The invoice number a subject names, upper-cased, or null when it names none. */
export function extractInvoiceNumber(subject: string | null | undefined): string | null {
  if (!subject) return null;
  for (const m of subject.matchAll(INVOICE_TOKEN)) {
    const token = (m[1] ?? '').toUpperCase();
    if (token.length >= 3 && /\d/.test(token)) return token;
  }
  return null;
}

const FORWARDED_APPROVAL = /DR3-Vision AP decision \(approved\b[^)]*\)\s*[—-]\s*(.+)$/i;

/** Subject normalised for comparison: no FW:/RE: prefixes, single spaces, lower case. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*(?:(?:fw|fwd|re)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * When `subject` is Vision's own APPROVED decision mail forwarded back into the
 * inbox, the (normalised) subject of the request it approved; otherwise null. A
 * forwarded REJECTION is a resubmission and is deliberately not matched.
 */
export function forwardedApprovalSubject(subject: string | null | undefined): string | null {
  const m = subject ? FORWARDED_APPROVAL.exec(subject) : null;
  const original = m?.[1] ? normalizeSubject(m[1]) : '';
  return original.length >= 8 ? original : null;
}

const VENDOR_STOPWORDS = new Set([
  'inc',
  'llc',
  'corp',
  'company',
  'the',
  'and',
  'service',
  'services',
]);

function vendorWords(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !VENDOR_STOPWORDS.has(w));
}

function vendorPrefix(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 5);
}

/**
 * True when two vendor spellings plausibly name the same vendor: the same first
 * five letters ("United" / "united fleet maintenance", "Inter State oil" /
 * "InterState Oil Co") or a shared significant word ("alied Propane service" /
 * "Allied Propane"). Blank on either side cannot rule a match out.
 */
export function vendorsCompatible(a: readonly string[], b: readonly string[]): boolean {
  const as = a.map((v) => v.trim()).filter(Boolean);
  const bs = b.map((v) => v.trim()).filter(Boolean);
  if (as.length === 0 || bs.length === 0) return true;
  return as.some((x) =>
    bs.some((y) => {
      const px = vendorPrefix(x);
      if (px.length >= 4 && px === vendorPrefix(y)) return true;
      const wy = new Set(vendorWords(y));
      return vendorWords(x).some((w) => wy.has(w));
    }),
  );
}

/** Statuses that mean "accounting has been, or is about to be, told to pay this". */
export const APPROVED_STATUSES = ['approved', 'pending_second_approval'] as const;

export interface DuplicateApproval {
  requestId: string;
  status: string;
  subject: string | null;
  vendor: string | null;
  amountCents: number | null;
  /** Terminal decision time, or the first approval of a >= $1,000 in flight. */
  approvedAt: Date | null;
  approvedBy: string | null;
}

export interface DuplicateCheck {
  /** The invoice number the subject names, when it names one. */
  invoiceNumber: string | null;
  /** The request is a forwarded copy of Vision's own approval mail. */
  forwardedApproval: boolean;
  matches: DuplicateApproval[];
}

/** `ap_requests.extraction.best_vendor`, when the JSON carries one. */
export function extractionVendor(extraction: unknown): string | null {
  if (!extraction || typeof extraction !== 'object') return null;
  const v = (extraction as { best_vendor?: unknown }).best_vendor;
  return typeof v === 'string' ? v : null;
}

type Reader = Pick<PrismaClient, 'apRequest'>;

/**
 * Every OTHER request already approved (or first-approved) for the same invoice
 * number and a compatible vendor — or, for a forwarded approval mail, the request
 * that mail approved. `null` when the subject gives neither key: the check has
 * nothing to key on, and says so rather than "no match".
 */
export async function findApprovedDuplicates(
  db: Reader,
  args: {
    requestId: string;
    subject: string | null;
    /** The vendor spellings known for THIS request (typed, extracted). */
    vendors: readonly (string | null | undefined)[];
  },
): Promise<DuplicateCheck | null> {
  const invoiceNumber = extractInvoiceNumber(args.subject);
  const echoed = forwardedApprovalSubject(args.subject);
  if (!invoiceNumber && !echoed) return null;
  const mine = args.vendors.filter((v): v is string => typeof v === 'string');
  const candidates = await db.apRequest.findMany({
    where: {
      status: { in: [...APPROVED_STATUSES] },
      OR: [
        ...(invoiceNumber
          ? [{ subject: { contains: invoiceNumber, mode: 'insensitive' as const } }]
          : []),
        // The stored subject may differ in FW: prefix and spacing; its first words
        // are a safe narrowing, the exact comparison happens below.
        ...(echoed
          ? [
              {
                subject: {
                  contains: echoed.split(' ').slice(0, 3).join(' '),
                  mode: 'insensitive' as const,
                },
              },
            ]
          : []),
      ],
    },
    orderBy: { received_at: 'asc' },
    select: {
      id: true,
      status: true,
      subject: true,
      vendor: true,
      vendor_freeform: true,
      extraction: true,
      confirmed_amount_cents: true,
      amount_cents: true,
      decided_at: true,
      decided_by: true,
      first_approved_at: true,
      first_approver_id: true,
    },
  });
  const sameInvoice = (r: (typeof candidates)[number]): boolean =>
    !!invoiceNumber &&
    extractInvoiceNumber(r.subject) === invoiceNumber &&
    vendorsCompatible(mine, [
      r.vendor_freeform ?? '',
      r.vendor ?? '',
      extractionVendor(r.extraction) ?? '',
    ]);
  // The echoed subject may be cut short (the decision subject is capped at 200
  // characters), so the original need only START with it.
  const approvedHere = (r: (typeof candidates)[number]): boolean =>
    !!echoed && !!r.subject && normalizeSubject(r.subject).startsWith(echoed);
  const matches = candidates
    .filter((r) => r.id !== args.requestId && (sameInvoice(r) || approvedHere(r)))
    .map((r) => ({
      requestId: r.id,
      status: r.status,
      subject: r.subject,
      vendor: r.vendor_freeform ?? r.vendor ?? extractionVendor(r.extraction),
      amountCents: r.confirmed_amount_cents ?? r.amount_cents,
      approvedAt: r.decided_at ?? r.first_approved_at,
      approvedBy: r.decided_by ?? r.first_approver_id,
    }));
  return { invoiceNumber, forwardedApproval: !!echoed, matches };
}
