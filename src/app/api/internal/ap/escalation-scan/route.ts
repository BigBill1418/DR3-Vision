// ADR-0066 §1.5 — internal AP second-approval escalation-scan endpoint.
//
// Same loopback-guarded internal-route pattern as the AP poll / expiry routes:
// any request carrying a `cf-connecting-ip` header (public Cloudflare tunnel)
// gets a 404; the thin `scripts/ap-escalation-scan.mjs` daemon reaches it over
// the compose network hourly. `INTERNAL_CRON_TOKEN` is a MANDATORY bearer in
// production — `guardInternalCron` REFUSES with 503 (and pages) when it is unset,
// because fail-open here once let any WG peer trigger internal crons. It is
// fail-open only in non-prod, where the loopback guard is the boundary. `/api/internal/ap/` is already exempted in
// public-paths.ts so the auth middleware never 307s this session-less POST.
//
// A failing scan is NOT swallowed here: `runApEscalationScan` pages
// `dr3-vision-system` and re-throws, and this route lets that surface as a 500
// the daemon logs. Returning 200 on a broken scan would recreate the silent
// failure this ADR exists to remove.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { runApEscalationScan } from '@/lib/ap/escalation-scan';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const result = await runApEscalationScan();
  log.info(
    { op: 'ap-escalation-scan', scanned: result.scanned, escalated: result.escalated },
    '[ap-escalation-scan] run complete',
  );
  return NextResponse.json(result);
}
