// ADR-0068 §4 — submit a reimbursement.
//
// Multipart, because the receipt is REQUIRED (D2) and the whole point of this
// route is that intake is structured rather than a scanned PDF forwarded by
// email. The receipt goes to R2 and never into the app database.
//
// AUTHORIZATION: `requireManagerForSite` — manager or admin, and a plain manager
// is hard-scoped to their own site. The submitter's identity and the site come
// from the SESSION, never from the request body: `site` is auto-filled and not
// user-editable (D2), and `submitted_by` is the first signature, so accepting
// either from the client would hand away the control this feature exists to
// enforce.

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { putFileDrop } from '@/lib/r2';
import {
  submitReimbursement,
  ReimbursementNotEligibleError,
  ReimbursementNoteRequiredError,
} from '@/lib/reimbursements/service';
import { notifyReimbursementSubmitted } from '@/lib/reimbursements/notify';
import type { ReimbursementCategory } from '@prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CATEGORIES: readonly ReimbursementCategory[] = [
  'mileage',
  'fuel',
  'supplies',
  'meals',
  'tools',
  'other',
];

/** 15 MB — a phone photo of a receipt, with room to spare. */
const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ site: string }> },
): Promise<Response> {
  const { site } = await ctx.params;

  let auth;
  try {
    auth = await requireManagerForSite(site);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const str = (k: string): string => {
    const v = form.get(k);
    return typeof v === 'string' ? v.trim() : '';
  };

  const category = str('category') as ReimbursementCategory;
  if (!CATEGORIES.includes(category)) {
    return NextResponse.json({ error: 'invalid_category' }, { status: 400 });
  }

  const amountRaw = str('amount');
  // Accept "40", "40.00", "$40.00", "1,240.50" — a manager typing on a phone
  // should not have to guess the format.
  const amountCents = Math.round(Number(amountRaw.replace(/[$,\s]/g, '')) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return NextResponse.json(
      { error: 'invalid_amount', message: 'Enter the amount, for example 40.00.' },
      { status: 400 },
    );
  }

  const expenseDate = str('expenseDate');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) {
    return NextResponse.json(
      { error: 'invalid_expense_date', message: 'Pick the date the expense happened.' },
      { status: 400 },
    );
  }

  const purpose = str('purpose');
  if (!purpose) {
    return NextResponse.json(
      { error: 'purpose_required', message: 'Say what the expense was for.' },
      { status: 400 },
    );
  }

  const employeeUserId = str('employeeUserId') || null;
  const employeeNameFreeform = str('employeeNameFreeform') || null;
  if ((employeeUserId === null) === (employeeNameFreeform === null)) {
    return NextResponse.json(
      {
        error: 'beneficiary_required',
        message: 'Choose the employee being reimbursed, or type their name — one or the other.',
      },
      { status: 400 },
    );
  }

  // ── Receipt (REQUIRED, D2) ────────────────────────────────────────────────
  const receipt = form.get('receipt');
  if (!(receipt instanceof File) || receipt.size === 0) {
    return NextResponse.json(
      { error: 'receipt_required', message: 'Attach a photo or file of the receipt.' },
      { status: 400 },
    );
  }
  if (receipt.size > MAX_RECEIPT_BYTES) {
    return NextResponse.json(
      { error: 'receipt_too_large', message: 'That receipt is over 15 MB — try a photo instead.' },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await receipt.arrayBuffer());
  const receiptKey = await putFileDrop({
    id: `reimbursement-${auth.siteId}-${Date.now()}`,
    filename: receipt.name || 'receipt',
    contentType: receipt.type || null,
    bytes,
  });
  if (!receiptKey) {
    // R2 unconfigured. Refuse rather than storing a row whose REQUIRED receipt
    // does not exist — a reimbursement without its receipt is not payable, and a
    // row that looks complete but is not is worse than a clear failure.
    return NextResponse.json(
      {
        error: 'receipt_storage_unavailable',
        message: 'Receipt storage is not available right now. Nothing was submitted — try again.',
      },
      { status: 503 },
    );
  }

  try {
    const result = await submitReimbursement({
      prisma,
      submittedBy: auth.userId,
      siteId: auth.siteId, // from the session, never the client
      employeeUserId,
      employeeNameFreeform,
      amountCents,
      expenseDate,
      category,
      purpose,
      receiptFileKey: receiptKey,
      receiptContentType: receipt.type || 'application/octet-stream',
    });

    // Fail-soft on the notification, loud on the problems: a paging failure must
    // never roll back a filed reimbursement, but an EMPTY recipient set is
    // indistinguishable from success and that is exactly the AP outage shape.
    const notified = await notifyReimbursementSubmitted(prisma, result.id).catch(() => null);

    return NextResponse.json({
      ok: true,
      id: result.id,
      routedTo: result.routing.routedTo?.name ?? null,
      escalated: result.routing.escalateImmediately,
      escalationReason: result.routing.escalationReason,
      problems: result.routing.problems,
      notified: notified?.mode ?? 'not_sent',
    });
  } catch (e) {
    if (e instanceof ReimbursementNotEligibleError || e instanceof ReimbursementNoteRequiredError) {
      return NextResponse.json({ error: 'refused', message: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
