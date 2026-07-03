// Internal audit-sweep cron endpoint (ADR-0039 D3).
//
// The thin Pacific-aware daemon `scripts/audit-sweep-cron.mjs` POSTs here once a
// day at 02:30 America/Los_Angeles (the quiet window after the day's entries).
// The real work runs compiled inside the Next app via `runAuditSweep` — the
// daemon imports no TS.
//
// INTERNAL-ONLY: mirrors /api/internal/bonus/escalation-check verbatim. Any
// request carrying a `cf-connecting-ip` header (public Cloudflare tunnel) gets a
// 404. The cron reaches it over the compose network. An optional
// `INTERNAL_CRON_TOKEN` adds a bearer check when set (defense in depth). The
// middleware exemption for `/api/internal/audit/` (src/lib/public-paths.ts) is
// the ADR-0036 lesson applied on day 1.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { runAuditSweep } from '@/lib/audit/sweep';
import { buildRunChecksForWindow } from '@/lib/audit/leg-fetchers';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get('cf-connecting-ip')) {
    return new NextResponse('Not Found', { status: 404 });
  }
  const requiredToken = process.env['INTERNAL_CRON_TOKEN'];
  if (requiredToken) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${requiredToken}`) {
      return new NextResponse('Not Found', { status: 404 });
    }
  }

  const summary = await runAuditSweep({ db: prisma, runChecks: buildRunChecksForWindow(prisma) });
  log.info(
    {
      runs: summary.runs.length,
      failures: summary.failures,
      opened: summary.runs.reduce((s, r) => s + r.opened, 0),
      resolved: summary.runs.reduce((s, r) => s + r.resolved, 0),
    },
    '[audit-sweep] sweep complete',
  );
  return NextResponse.json(summary);
}
