// ADR-0046 D4 — AP queue list (org reach: admin or all_sites). AP requests are
// org-level accounting records, NOT site-scoped — the surface reaches admins +
// all_sites managers (hard rule #2 site-reach, never admin powers).

import { NextResponse } from 'next/server';
import { requireApApprover } from '@/lib/ap/approvers';
import {
  isApListFilter,
  listApRequests,
  listReimbursementQueueRows,
  type ApListRow,
} from '@/lib/ap/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    await requireApApprover();
    const statusParam = new URL(req.url).searchParams.get('status');
    const filter = isApListFilter(statusParam) ? statusParam : 'pending';
    const { rows, counts } = await listApRequests(filter);

    // ── ADR-0068 Amendment 3 — reimbursements share this worklist ────────────
    // Only ever added to the views that would show a pending second approval, so
    // a filter like `approved` or `quarantined` is unchanged: those statuses mean
    // something different for a reimbursement and mixing them would misreport
    // both. `pending_second_approval` is the one status the two objects genuinely
    // share.
    //
    // Fail-soft on the reimbursement read specifically: the AP queue is the team's
    // live worklist and must not go dark because the reimbursement table is
    // unreachable. The failure is reported in the payload rather than swallowed.
    let reimbursements: ApListRow[] = [];
    let reimbursementError: string | null = null;
    if (filter === 'all' || filter === 'pending_second_approval') {
      try {
        reimbursements = await listReimbursementQueueRows();
      } catch (err) {
        reimbursementError = err instanceof Error ? err.message : String(err);
      }
    }

    // Newest first across BOTH kinds, so the merged list reads as one queue rather
    // than invoices followed by an appendix.
    const merged = [...rows, ...reimbursements].sort((a, b) =>
      b.receivedAt.localeCompare(a.receivedAt),
    );

    return NextResponse.json({
      rows: merged,
      counts: { ...counts, reimbursements_pending: reimbursements.length },
      filter,
      reimbursementError,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
