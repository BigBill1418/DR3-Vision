// ADR-0143 D2 / D5 — the pool-check sweep.
//
// POST /api/internal/inventory/pool-check   (loopback, INTERNAL_CRON_TOKEN)
//
// Two jobs, in order:
//   1. Run the pool guard for every site in its OWN transaction. This is how the
//      MyMRC bridges are checked: they run in the standalone scraper process
//      (tsconfig.mymrc.json) and cannot import the guard. The scraper is NOT given
//      the internal cron token (it is the hardened Chromium container, ADR-0053
//      addendum), so this sweep — every 10 minutes from the workbook-sync daemon —
//      finds a bridge-driven negative within 10 minutes of the hourly bridge and
//      names the door from the day's rows (`sweep:processed=mymrc`). It is also the
//      backstop for any writer whose in-transaction check failed and was swallowed
//      (guardPoolsInTx never refuses a write): here a failure is NOT swallowed.
//   2. Page every exception that is due (onset `high`, 7-day `high`). Called every
//      10 minutes by the workbook-sync daemon, so an onset page lands within one
//      sync tick of the write that opened the exception.
//
// The response carries counts and exception ids only — never a pool figure.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardInternalCron } from '@/lib/internal-auth';
import { prisma } from '@/lib/prisma';
import { runPoolCheck } from '@/lib/inventory/pool-guard';
import { sweepInventoryExceptionPages } from '@/lib/inventory/exception-alerts';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  writer: z.enum(['mymrc-processed-bridge', 'mymrc-inbound-bridge', 'sweep']).optional(),
  /** Skip the paging step (an operator reading state without spending a page). */
  page: z.boolean().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;
  const parsed = Body.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const writer = parsed.data.writer ?? 'sweep';
  const sites = await prisma.site.findMany({
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });

  const checked: Array<{
    site: string;
    opened: string[];
    negativeDays: number;
    rowsWritten: number;
  }> = [];
  const failed: Array<{ site: string; error: string }> = [];
  for (const s of sites) {
    try {
      const r = await runPoolCheck(s.id, writer);
      checked.push({
        site: s.code,
        opened: r.opened.map((o) => o.id),
        negativeDays: r.negativeDays,
        rowsWritten: r.rowsWritten,
      });
    } catch (err) {
      log.error(
        { err, site: s.code, writer, op: 'inventory.pool_check.failed' },
        '[pool-check] guard failed',
      );
      failed.push({ site: s.code, error: (err as Error).name });
    }
  }

  const pages = parsed.data.page === false ? null : await sweepInventoryExceptionPages();
  return NextResponse.json(
    { writer, checked, failed, pages },
    { status: failed.length > 0 ? 500 : 200 },
  );
}
