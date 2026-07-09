// ADR-0046 §3 amendment (handoff §1.6f) — internal AP-approver expiry endpoint.
//
// Same loopback-guarded internal-route pattern as the AP poll route: any request
// carrying a `cf-connecting-ip` header (public Cloudflare tunnel) gets a 404; the
// thin `scripts/ap-approver-expiry-cron.mjs` daemon reaches it over the compose
// network at 00:05 America/Los_Angeles daily. An optional `INTERNAL_CRON_TOKEN`
// adds a bearer check (defense in depth). `/api/internal/ap/` is exempted in
// public-paths.ts so the auth middleware never 307s this session-less POST.

import { NextResponse } from 'next/server';
import { runApApproverExpiry } from '@/lib/ap/expiry';
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

  const result = await runApApproverExpiry();
  log.info({ op: 'ap-approver-expiry', expired: result.expired }, '[ap-approver-expiry] run complete');
  return NextResponse.json(result);
}
