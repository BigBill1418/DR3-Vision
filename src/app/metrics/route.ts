// T-109 — Prometheus scrape endpoint (ADR-0022 §4).
//
// GET /metrics → the prom-client registry rendered as Prometheus text exposition
// format. prom-client is Node-only, so this handler forces the Node runtime.
//
// INTERNAL-ONLY: Prometheus scrapes from inside the fleet network. The public
// Cloudflare tunnel must never expose fleet metrics, so any request that arrives
// carrying a `cf-connecting-ip` header (i.e. it came through Cloudflare) gets a
// flat 404 — indistinguishable from a route that does not exist.

import { NextResponse } from 'next/server';
import { registry } from '@/lib/observability/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  // Presence of cf-connecting-ip means the request traversed Cloudflare's edge.
  if (req.headers.get('cf-connecting-ip') !== null) {
    return new NextResponse('Not Found', { status: 404 });
  }

  const body = await registry.metrics();
  return new NextResponse(body, {
    status: 200,
    headers: { 'Content-Type': registry.contentType },
  });
}
