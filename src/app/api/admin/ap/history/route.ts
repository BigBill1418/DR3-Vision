// ADR-0046 Amendment 5 (D-M5-5) — invoice history search (client refresh).
//
// Gated by `requireApHistoryRead` — admins + designated second approvers only (the
// general ap_approvers roster is excluded, hard rule #2). Reads the union of
// Vision-decided invoices + Bill-uploaded historical AP rows through
// `searchApHistory`, applying the query-string filters (vendor typeahead, date
// range, amount range, site, approver, source). No aggregate reports (D-M5-5).

import { NextResponse } from 'next/server';
import { requireApHistoryRead } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { searchApHistory, type HistoryFilters, type HistorySource } from '@/lib/ap/history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function intParam(v: string | null): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireApHistoryRead();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const q = url.searchParams;
  const sourceRaw = q.get('source');
  const source: HistorySource | undefined =
    sourceRaw === 'vision' || sourceRaw === 'import' ? sourceRaw : undefined;

  // Dollar bounds arrive as whole dollars from the UI; convert to cents.
  const minDollars = intParam(q.get('amountMin'));
  const maxDollars = intParam(q.get('amountMax'));

  const filters: HistoryFilters = {
    ...(q.get('vendor') ? { vendor: q.get('vendor')! } : {}),
    ...(q.get('dateFrom') ? { dateFrom: q.get('dateFrom')! } : {}),
    ...(q.get('dateTo') ? { dateTo: q.get('dateTo')! } : {}),
    ...(minDollars !== undefined ? { amountMinCents: minDollars * 100 } : {}),
    ...(maxDollars !== undefined ? { amountMaxCents: maxDollars * 100 } : {}),
    ...(q.get('site') ? { siteCode: q.get('site')! } : {}),
    ...(q.get('approverId') ? { approverId: q.get('approverId')! } : {}),
    ...(source ? { source } : {}),
  };

  const rows = await searchApHistory(prisma, filters);
  return NextResponse.json({ rows, count: rows.length });
}
