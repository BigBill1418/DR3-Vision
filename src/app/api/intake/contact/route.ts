// ADR-0045 D3 — public contact-form intake endpoint.
//
// PUBLIC (the WordPress form plugin POSTs here over the Cloudflare tunnel — this
// is genuinely internet-reachable, unlike the loopback-guarded internal crons),
// so it is guarded by a shared secret + honeypot + per-IP rate limit, and it is
// POST-only. Middleware exempts `/api/intake/` (see src/lib/public-paths.ts).
//
// FAIL-CLOSED: if `INTAKE_TOKEN` is unset in the environment the endpoint returns
// 503 and accepts nothing — an unconfigured secret must never degrade to an open
// endpoint. (Contrast the M365 mail path, which is fail-OPEN by design: a
// missing outbound-mail secret must not break the app, but a missing INBOUND
// auth secret must never open a public write path.)

import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { handleContactIntake } from '@/lib/intake/service';
import { rateLimit } from '@/lib/intake/rate-limit';
import { constantTimeEqual } from '@/lib/internal-auth';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const expected = process.env['INTAKE_TOKEN']?.trim();
  if (!expected) {
    // Fail-closed: no secret configured → refuse, do not accept.
    log.error({ event: 'intake_unconfigured' }, '[intake] INTAKE_TOKEN unset — refusing (503)');
    return NextResponse.json({ error: 'intake_unconfigured' }, { status: 503 });
  }

  const hdrs = await headers();
  if (!constantTimeEqual(hdrs.get('x-intake-token'), expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const ip =
    hdrs.get('cf-connecting-ip') ?? hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = rateLimit(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const result = await handleContactIntake(body);
  switch (result.outcome) {
    case 'invalid':
      return NextResponse.json({ error: 'invalid', fields: result.issues }, { status: 422 });
    case 'honeypot':
      // Silent accept — behave like success so bots learn nothing.
      return NextResponse.json({ ok: true }, { status: 200 });
    case 'accepted':
      return NextResponse.json({ ok: true }, { status: 201 });
  }
}

/** Any non-POST verb is a 405 (POST-only endpoint). */
export async function GET(): Promise<Response> {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
