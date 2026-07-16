// ADR-0049 D2/D5 — internal workbook-sync poll endpoint.
//
// Same loopback-guarded internal-route pattern as the ap/survey/audit crons: any
// request carrying a `cf-connecting-ip` header (public Cloudflare tunnel) gets a
// 404; the thin `scripts/workbook-sync-cron.mjs` daemon reaches it over the compose
// network. An optional `INTERNAL_CRON_TOKEN` adds a bearer check. `/api/internal/
// workbook-sync/` is exempted in public-paths.ts (+ regression test) so the auth
// middleware never 307s this session-less POST to /login (the standing ADR-0036
// lesson — mandatory day-one case here).
//
// BUSINESS-HOURS ENFORCEMENT lives HERE (D2): outside the Mon-Fri 06:00–20:00 PT
// window the route returns `{ skipped: 'off_hours' }` WITHOUT touching the drive, so
// a stray off-hours tick (manual curl, restart re-fire) never polls the live source.
// The route does all real work inside the Next app via `runWorkbookSyncPoll`.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { runWorkbookSyncPoll } from '@/lib/workbook-sync/engine';
import { isBusinessHours } from '@/lib/workbook-sync/business-hours';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const now = new Date();
  if (!isBusinessHours(now)) {
    log.info({ op: 'workbook-sync' }, '[workbook-sync] off-hours tick skipped (D2)');
    return NextResponse.json({ skipped: 'off_hours', at: now.toISOString() });
  }

  const result = await runWorkbookSyncPoll({
    log: (level, message) => log[level]({ op: 'workbook-sync' }, message),
  });
  log.info(
    {
      op: 'workbook-sync',
      mode: result.transportMode,
      sources: result.sourcesPolled,
      results: result.results.map((r) => ({
        site: r.siteId,
        status: r.status,
        changed: r.changesDetected,
        up: r.rowsUpserted,
        ow: r.rowsOverwritten,
        mid: r.rowsSkippedMidedit,
      })),
    },
    '[workbook-sync] poll complete',
  );
  return NextResponse.json(result);
}
