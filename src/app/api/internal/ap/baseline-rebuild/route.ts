// ADR-0046 Amendment 5 (D-M5-4) — internal nightly vendor-baseline rebuild.
//
// Same loopback-guarded internal-route pattern as the AP poll + expiry routes: a
// request carrying a `cf-connecting-ip` header (public Cloudflare tunnel) → 404;
// the thin `scripts/ap-baseline-rebuild-cron.mjs` daemon reaches it over the
// compose network at 01:30 America/Los_Angeles daily. An optional
// `INTERNAL_CRON_TOKEN` adds a bearer check. `/api/internal/ap/` is exempted in
// public-paths.ts so the auth middleware never 307s this session-less POST.
//
// The work — recompute every vendor baseline from ap_vendor_baseline_history,
// preserving admin overrides — is idempotent: two runs in a row produce the same
// table. A rebuild failure is NOT paged (ADR-0037: not actionable-within-5-min);
// the aggregates just stay one cycle stale and the next run heals them.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { rebuildVendorBaselines } from '@/lib/ap/baselines';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const result = await rebuildVendorBaselines();
  log.info(
    { op: 'ap-baseline-rebuild', ...result },
    '[ap-baseline-rebuild] run complete',
  );
  return NextResponse.json(result);
}
