// ADR-0067 §3.2 D4 — the scheduled delta-sweep endpoint.
//
// Same loopback-guarded internal-route pattern as every other cron here: a
// request carrying `cf-connecting-ip` (the public Cloudflare tunnel) gets a 404,
// and `INTERNAL_CRON_TOKEN` is mandatory in production. The thin
// `scripts/doc-ingest-sweep-cron.mjs` daemon reaches it over the compose network.
//
// `/api/internal/doc-ingest/` MUST be exempted in `public-paths.ts` (there is a
// regression test for the list). Without it the auth middleware 307s this
// session-less POST to /login, the daemon's fetch follows the redirect to a 200
// HTML page, and the sweep silently no-ops WHILE LOGGING SUCCESS — the standing
// ADR-0036 lesson, and doubly unacceptable here because this sweep is the
// correctness guarantee for the whole feature.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { runDocIngestSweep } from '@/lib/doc-ingest/sweep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const result = await runDocIngestSweep(prisma, {
    trigger: 'scheduled',
    log: (level, message) => log[level]({ op: 'doc-ingest-sweep' }, message),
  });

  log.info(
    {
      op: 'doc-ingest-sweep',
      status: result.status,
      discovered: result.sourcesDiscovered,
      applied: result.versionsApplied,
      staged: result.versionsStaged,
      anomalies: result.anomaliesRaised,
    },
    '[doc-ingest-sweep] run complete',
  );

  // 200 even for a `failed` run: the failure is already recorded in the ledger
  // and paged as a `sweep_failed` anomaly. Returning 500 would only make the
  // daemon's own retry logic double-report one event.
  return NextResponse.json(result);
}
