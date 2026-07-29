// ADR-0066 §1.7 — internal AP morning-digest endpoint.
//
// Same loopback-guarded internal-route pattern as the AP poll / expiry routes:
// any request carrying a `cf-connecting-ip` header (i.e. it arrived through the
// public Cloudflare tunnel) gets a 404; the thin `scripts/ap-morning-digest.mjs`
// daemon reaches it over the compose network at 06:00 America/Los_Angeles daily.
// `INTERNAL_CRON_TOKEN` is a MANDATORY bearer in production — `guardInternalCron`
// REFUSES with 503 (and pages) when unset; fail-open applies only in non-prod.
// `/api/internal/ap/` is already exempted in `public-paths.ts`, so the auth
// middleware never 307s this session-less POST.
//
// The daemon fires EVERY day; this route decides whether to send. The weekday /
// fleet-holiday gate (`isBusinessDayNow`) and the empty-state suppression both
// live in `runApMorningDigest`, where the DB they need is available.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { runApMorningDigest } from '@/lib/ap/morning-digest';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const result = await runApMorningDigest();
  log.info(
    { op: 'ap-morning-digest', sent: result.sent, reason: result.reason, ...result.counts },
    '[ap-morning-digest] run complete',
  );
  return NextResponse.json(result);
}
