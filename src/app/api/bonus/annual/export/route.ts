// ADR-0019 §8 — Annual aggregate CSV export endpoint (T-118).
//
// GET /api/bonus/annual/export?year=YYYY — streams the per-employee year-to-date
// totals as a CSV attachment. Gated through `requireBonusAccess()` (Woodland-
// scoped): anonymous → 401, operator / Eugene manager (Rick) → 403, misseeded
// site → 404. The site comes from the returned BonusContext; the client is NEVER
// trusted for scope (CLAUDE.md hard rule #2). Every cent flows through the single
// `@/lib/bonus/calculator` via `annualTotals`, so the CSV can never diverge from
// the on-screen totals or the signed PDF (CLAUDE.md hard rule #3).

import { requireBonusAccess } from '@/lib/bonus/access';
import { annualTotals, csvForAnnual } from '@/lib/bonus/aggregates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Parse ?year= to a sane 4-digit year; default to the current UTC year. */
function parseYear(raw: string | null): number {
  const now = new Date().getUTCFullYear();
  if (!raw) return now;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2000 || n > now + 1) return now;
  return n;
}

export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await requireBonusAccess();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const year = parseYear(url.searchParams.get('year'));

  const rows = await annualTotals(ctx.siteId, year);
  const csv = csvForAnnual(rows);

  const filename = `bonus-${ctx.siteCode}-annual-${year}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
