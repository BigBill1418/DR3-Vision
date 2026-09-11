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
import { guardInternalCron } from '@/lib/internal-auth';
import { prisma } from '@/lib/prisma';
import { runAuditSweep } from '@/lib/audit/sweep';
import { INVARIANTS } from '@/lib/invariants/registry';
import { notifyInvariantReport } from '@/lib/invariants/notify';
import { runInvariants } from '@/lib/invariants/runner';
import { buildRunChecksForWindow } from '@/lib/audit/leg-fetchers';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  // ADR-0131 D7 — the production data-invariant suite runs here, immediately
  // before the sweep, on this existing container. No new container, no new image,
  // no new cron entry: measured at 28 queries / ~0.5 s against production, against
  // a sweep that already runs for minutes.
  //
  // BEFORE the sweep, not after, and not in parallel: the invariants are statements
  // about the data the sweep is about to reason over, so a reader looking at why a
  // sweep produced what it did wants the invariant verdict to precede it in the log.
  //
  // Isolated. `runInvariants` never throws (a failing check degrades to
  // `indeterminate`), but the notify call reaches the network, and the audit sweep
  // is the load-bearing job on this container. It does not get to fail because a
  // diagnostic could not page.
  let invariants = null;
  try {
    const report = await runInvariants(INVARIANTS, { now: new Date() });
    await notifyInvariantReport(report);
    invariants = report;
    log.info(
      { ...report.counts, blind: report.blind, durationMs: report.durationMs },
      '[invariants] suite complete',
    );
  } catch (err) {
    log.error({ err }, '[invariants] suite failed - continuing to the audit sweep');
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
  return NextResponse.json({ ...summary, invariants });
}
