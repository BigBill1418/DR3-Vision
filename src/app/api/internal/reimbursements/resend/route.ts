// ADR-0068 Amendment 5 — re-send an approved reimbursement's decision mail.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// AP invoices have had a Re-send since ADR-0046; reimbursements did not, so the
// only recovery from a failed decision mail was to re-approve — which is
// impossible, because the request is already terminal. That gap is real
// independent of today: a `too_large` refusal or an M365 outage leaves an
// approved reimbursement that accounting was never told about, and until now
// nothing could tell them.
//
// ── What it does NOT do ────────────────────────────────────────────────────
// It changes no decision state. No status moves, no signature is re-recorded, and
// `sent_to_accounting_at` is NOT re-stamped — that column records when accounting
// was FIRST really told, and overwriting it would destroy the audit answer to
// "when did Mary learn about this?". It composes the current PDF and sends. If
// the original send never happened, the column is filled for the first time;
// otherwise it is left exactly as it was.
//
// ── `additionalRecipients` is audited, deliberately ─────────────────────────
// The standing rule (D6) is that an approved reimbursement goes to accounting as
// the SOLE primary recipient — reimbursements name an employee and an amount they
// are personally owed. This route can widen that for a specific send (Bill,
// 2026-07-30: *"for today only you will send this to Mary & Myself so I can verify
// everything worked correctly"*), and every widened send writes an audit row
// naming exactly who else received it. A widening nobody can later see is how a
// one-off becomes an undocumented standing practice.
//
// Loopback-guarded and `INTERNAL_CRON_TOKEN`-bearing like every other internal
// route — it is not reachable from the public tunnel.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { notifyReimbursementDecided } from '@/lib/reimbursements/notify';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as {
    ids?: unknown;
    additionalRecipients?: unknown;
    reason?: unknown;
  } | null;

  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids_required' }, { status: 400 });
  }
  const additionalRecipients = Array.isArray(body?.additionalRecipients)
    ? body.additionalRecipients.filter((v): v is string => typeof v === 'string')
    : [];
  const reason = typeof body?.reason === 'string' ? body.reason : 'operator re-send';

  const results: Array<Record<string, unknown>> = [];

  for (const id of ids) {
    const row = await prisma.reimbursementRequest.findUnique({
      where: { id },
      select: { id: true, status: true, amount_cents: true, sent_to_accounting_at: true },
    });

    if (!row) {
      results.push({ id, ok: false, reason: 'not_found' });
      continue;
    }
    // A re-send is ONLY ever a re-send. Refuse anything that is not a completed,
    // dual-signed approval — this route must never become a way to notify
    // accounting about something nobody finished signing.
    if (row.status !== 'approved') {
      results.push({ id, ok: false, reason: `status_${row.status}` });
      continue;
    }

    const outcome = await notifyReimbursementDecided(prisma, id, {
      additionalRecipients,
      // Preserve the FIRST-told timestamp; see the header.
      preserveSentAt: row.sent_to_accounting_at !== null,
    });

    await writeAudit({
      actor_label: 'system:reimbursement-resend',
      action: 'update',
      table_name: 'reimbursement_requests',
      row_id: id,
      after: {
        resend: true,
        reason,
        mode: outcome.mode,
        intended_recipients: outcome.intended,
        // The widening, named, so it is visible forever rather than being a thing
        // that happened once and left no trace.
        additional_recipients: additionalRecipients,
        problems: outcome.problems,
        first_sent_at: row.sent_to_accounting_at?.toISOString() ?? null,
      },
    });

    results.push({
      id,
      ok: outcome.mode !== 'not_sent',
      mode: outcome.mode,
      intended: outcome.intended,
      problems: outcome.problems,
    });
  }

  log.info({ op: 'reimbursement-resend', count: results.length }, '[reimbursement-resend] done');
  return NextResponse.json({ results });
}
