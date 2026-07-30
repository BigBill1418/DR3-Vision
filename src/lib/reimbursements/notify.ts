// ADR-0068 D6 — who hears about a reimbursement, and who does not.
// (This header cited a draft-numbering "D8/D10" that the ADR never had; see
// ADR-0068 Amendment 1 F.3. The decision of record is D6.)
//
// ── The routing rule that is easy to get backwards ──────────────────────────
// Vendor invoices send the decision back to the SVdP forwarder with Mary CC'd,
// because a forwarder exists. Reimbursements have NO forwarder — the manager
// submits directly through the form. So:
//
//   approved  → MARY, sole primary recipient. She pays it.
//               NOT the submitter: they already know they submitted it.
//   rejected  → the SUBMITTING MANAGER, with the note. They are the one who must
//               act. Mary is NOT told; nothing is owed.
//   held      → likewise the submitting manager, with the note.
//   needs     → ONLY the routed second approver (or the admin on escalation).
//   approval    Never a broadcast.
//
// ── Fail-soft, never fail-silent ────────────────────────────────────────────
// A paging failure must not roll back a filed or decided reimbursement. But
// fail-soft over an EMPTY recipient set is indistinguishable from success, and
// that indistinguishability is precisely what let >= $1,000 AP invoices sit
// unapproved and invisible for days. So every function here returns its
// `problems`, and an empty audience is reported rather than shrugged off.

import type { PrismaClient } from '@prisma/client';
import { notifyStaff, type NotifyStaffResult } from '@/lib/notify/notify-staff';
import { resolveReimbursementApproval } from './routing';
import { beneficiaryLabel } from './service';

const SURFACE = 'reimbursement_notify';

/** Where approved reimbursements go to be paid. */
export const ACCOUNTING_RECIPIENT = 'mary.scott@svdp.us';

const APP_BASE = 'https://dr3-vision.svdp.us';

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Pacific, always — the fleet rule. A bare UTC timestamp is the defect. */
function pacific(d: Date): string {
  return `${d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  })} PT`;
}

interface FullRow {
  id: string;
  submitted_by: string;
  employee_user_id: string | null;
  amount_cents: number;
  expense_date: Date;
  category: string;
  purpose: string;
  status: string;
  submitted_at: Date;
  second_approved_at: Date | null;
  decision_note: string | null;
  employee_name_freeform: string | null;
  employee_user: { name: string } | null;
  submitter: { name: string; email: string | null };
  second_approver: { name: string } | null;
  routed_to: { name: string; email: string | null };
  site: { id: string; code: string; name: string };
  escalation_reason: string | null;
}

async function load(prisma: PrismaClient, id: string): Promise<FullRow | null> {
  return (await prisma.reimbursementRequest.findUnique({
    where: { id },
    select: {
      id: true,
      submitted_by: true,
      employee_user_id: true,
      amount_cents: true,
      expense_date: true,
      category: true,
      purpose: true,
      status: true,
      submitted_at: true,
      second_approved_at: true,
      decision_note: true,
      employee_name_freeform: true,
      escalation_reason: true,
      employee_user: { select: { name: true } },
      submitter: { select: { name: true, email: true } },
      second_approver: { select: { name: true } },
      routed_to: { select: { name: true, email: true } },
      site: { select: { id: true, code: true, name: true } },
    },
  })) as FullRow | null;
}

function detailTable(row: FullRow): string {
  const rows: Array<[string, string]> = [
    ['Employee being reimbursed', beneficiaryLabel(row)],
    ['Amount', usd(row.amount_cents)],
    ['Date of expense', row.expense_date.toISOString().slice(0, 10)],
    ['Category', row.category],
    ['What it was for', row.purpose],
    ['Site', row.site.name],
    ['Submitted by', `${row.submitter.name} — ${pacific(row.submitted_at)}`],
  ];
  if (row.second_approver && row.second_approved_at) {
    rows.push([
      'Second approval',
      `${row.second_approver.name} — ${pacific(row.second_approved_at)}`,
    ]);
  }
  if (row.decision_note) rows.push(['Note', row.decision_note]);

  return `<table style="border-collapse:collapse;font-size:14px">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`,
    )
    .join('')}</table>`;
}

function shell(heading: string, intro: string, row: FullRow, cta?: string): string {
  return `<html><body style="margin:0"><div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111;padding:20px;max-width:640px">
    <h2 style="color:#00524C;margin:0 0 10px">${esc(heading)}</h2>
    <p style="margin:0 0 14px">${intro}</p>
    ${detailTable(row)}
    ${cta ? `<p style="margin:18px 0 0">${cta}</p>` : ''}
    <p style="font-size:12px;color:#666;border-top:1px solid #ddd;padding-top:8px;margin-top:20px">
      DR3-Vision · employee reimbursements · times Pacific
    </p>
  </div></body></html>`;
}

export interface ReimbursementNotifyOutcome {
  mode: NotifyStaffResult['mode'] | 'not_sent';
  intended: string[];
  problems: string[];
}

/**
 * Tell the routed second approver — and ONLY them — that a reimbursement needs
 * their signature. Never a broadcast (D6).
 */
export async function notifyReimbursementSubmitted(
  prisma: PrismaClient,
  id: string,
): Promise<ReimbursementNotifyOutcome> {
  const row = await load(prisma, id);
  if (!row) return { mode: 'not_sent', intended: [], problems: [`No reimbursement ${id}.`] };

  const routed = await resolveReimbursementApproval(prisma, {
    submittedBy: row.submitted_by,
    employeeUserId: row.employee_user_id,
    employeeNameFreeform: row.employee_name_freeform,
  });

  const problems = [...routed.problems];
  const recipients = routed.recipients.map((r) => ({ address: r.email, name: r.name }));

  if (recipients.length === 0) {
    // The outage shape. Say it out loud rather than returning quietly.
    problems.push(
      `Reimbursement ${usd(row.amount_cents)} for ${beneficiaryLabel(row)} has NO reachable second approver — it is filed but nobody has been asked to sign it.`,
    );
    return { mode: 'not_sent', intended: [], problems };
  }

  const escalatedNote = routed.escalateImmediately
    ? `<br><strong style="color:#8a4b00">This was escalated immediately</strong> — ${esc(
        routed.escalationReason === 'beneficiary_conflict'
          ? 'the usual second approver is the person being reimbursed, so they cannot approve it.'
          : routed.escalationReason === 'ambiguous_beneficiary'
            ? 'the beneficiary name could not be matched unambiguously, so it was routed to an admin rather than risking a self-approval.'
            : 'no approval routing is configured for the submitter.',
      )}`
    : '';

  const res = await notifyStaff({
    surfaceCode: SURFACE,
    site: { id: row.site.id, code: row.site.code },
    recipients,
    subject: `Reimbursement needs your approval — ${usd(row.amount_cents)}, ${beneficiaryLabel(row)}`,
    htmlBody: shell(
      'A reimbursement needs your second signature',
      `${esc(row.submitter.name)} submitted this reimbursement. Their submission is the first signature — <strong>they cannot approve it themselves</strong>, so it needs yours.${escalatedNote}`,
      row,
      `<a href="${APP_BASE}/dashboard/ops/ap" style="background:#00524C;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Review it in Vision</a>`,
    ),
    importance: 'high',
    db: prisma,
  });

  return { mode: res.mode, intended: res.intendedRecipients, problems };
}

/**
 * Deliver the decision. Approved → Mary, and only Mary. Rejected/held → the
 * submitting manager.
 */
export async function notifyReimbursementDecided(
  prisma: PrismaClient,
  id: string,
): Promise<ReimbursementNotifyOutcome> {
  const row = await load(prisma, id);
  if (!row) return { mode: 'not_sent', intended: [], problems: [`No reimbursement ${id}.`] };

  const problems: string[] = [];

  if (row.status === 'approved') {
    // D6 — Mary is the SOLE primary recipient. Deliberately NOT the submitter.
    const res = await notifyStaff({
      surfaceCode: SURFACE,
      site: { id: row.site.id, code: row.site.code },
      recipients: [{ address: ACCOUNTING_RECIPIENT, name: 'Mary Scott' }],
      subject: `Approved reimbursement — ${usd(row.amount_cents)}, ${beneficiaryLabel(row)}`,
      htmlBody: shell(
        'Approved reimbursement — ready to pay',
        `This reimbursement carries <strong>two signatures from two different people</strong>: it was submitted by ${esc(
          row.submitter.name,
        )} and approved by ${esc(row.second_approver?.name ?? 'a second approver')}. Neither the submitter nor the person being reimbursed could have approved it.`,
        row,
        `The receipt is attached to the request in Vision: <a href="${APP_BASE}/dashboard/${esc(row.site.code)}/reimbursements">open reimbursements</a>. You no longer need to forward these in.`,
      ),
      db: prisma,
    });
    if (res.intendedRecipients.length === 0) {
      problems.push('Approved reimbursement had no accounting recipient — it will not get paid.');
    }
    if (res.disabled) {
      problems.push(
        'Approved reimbursement mail could not be sent — the email transport is disabled (M365 unconfigured). Mary has NOT been told to pay it.',
      );
    }
    // `sent_to_accounting_at` is an AUDIT field: it must record that accounting
    // was really told, not that we tried. Stamping it unconditionally made an
    // empty audience and a dead transport both read as a completed hand-off —
    // the same fail-soft-looks-like-success shape this module exists to refuse.
    if (res.intendedRecipients.length > 0 && !res.disabled) {
      await prisma.reimbursementRequest.update({
        where: { id },
        data: { sent_to_accounting_at: new Date() },
      });
    }
    return { mode: res.mode, intended: res.intendedRecipients, problems };
  }

  // Rejected or held → the submitting manager, with the note. Mary is NOT told:
  // nothing is owed, so telling her would be noise on a queue she pays from.
  const to = row.submitter.email;
  if (!to) {
    problems.push(
      `Reimbursement was ${row.status} but the submitter ${row.submitter.name} has no email address — they have not been told.`,
    );
    return { mode: 'not_sent', intended: [], problems };
  }

  const verb = row.status === 'rejected' ? 'was not approved' : 'is on hold';
  const res = await notifyStaff({
    surfaceCode: SURFACE,
    site: { id: row.site.id, code: row.site.code },
    recipients: [{ address: to, name: row.submitter.name }],
    subject: `Reimbursement ${row.status} — ${usd(row.amount_cents)}, ${beneficiaryLabel(row)}`,
    htmlBody: shell(
      `Your reimbursement submission ${verb}`,
      `${esc(row.second_approver?.name ?? 'The second approver')} ${esc(verb)} this reimbursement. Accounting has not been asked to pay it.`,
      row,
      `<a href="${APP_BASE}/dashboard/${esc(row.site.code)}/reimbursements">See your submissions</a>`,
    ),
    db: prisma,
  });

  if (res.disabled) {
    problems.push(
      `Reimbursement ${row.status} but the mail could not be sent — the email transport is disabled (M365 unconfigured). ${row.submitter.name} has NOT been told.`,
    );
  }

  return { mode: res.mode, intended: res.intendedRecipients, problems };
}
