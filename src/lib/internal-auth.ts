// Shared auth for the internal cron routes (audit 2026-07-16 · CRON + TIME).
//
// Every `/api/internal/**` route is reached only by the in-cluster cron daemons
// over the compose network; the full app is also WG-published on 10.99.0.2:9469,
// so a bearer token gates these session-less POSTs as defense-in-depth. Two
// hardenings live here so all 12 routes stay consistent:
//
//   1. MANDATORY-IN-PROD: when `INTERNAL_CRON_TOKEN` is unset the check used to be
//      SKIPPED (fail-open) — any WG peer could then POST AP-poll / month-close /
//      report blasts. In production an unset token now REFUSES (503); fail-open is
//      kept only for non-prod/dev where the loopback/cf-connecting-ip guard is the
//      boundary and no token is provisioned.
//   2. CONSTANT-TIME compare: the bearer is checked with `timingSafeEqual`
//      (length-safe) instead of `!==`, matching the contact-intake endpoint.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. Returns false for a null/undefined or
 * different-length `provided` (timingSafeEqual throws on unequal lengths).
 * Shared by the internal cron routes and the public contact-intake endpoint.
 */
export function constantTimeEqual(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Guard for an internal cron route. Returns a `Response` to short-circuit the
 * handler, or `null` to proceed:
 *  - request carries `cf-connecting-ip` (arrived via the public tunnel) → 404
 *  - `INTERNAL_CRON_TOKEN` unset in production → 503 (mandatory in prod)
 *  - `INTERNAL_CRON_TOKEN` unset in non-prod → allowed (dev/test convenience)
 *  - token set but the `Authorization: Bearer …` header mismatches → 404
 */
export function guardInternalCron(req: Request): Response | null {
  if (req.headers.get('cf-connecting-ip')) {
    return new NextResponse('Not Found', { status: 404 });
  }
  const requiredToken = process.env['INTERNAL_CRON_TOKEN']?.trim();
  if (!requiredToken) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'internal_unconfigured' }, { status: 503 });
    }
    return null;
  }
  if (!constantTimeEqual(req.headers.get('authorization'), `Bearer ${requiredToken}`)) {
    return new NextResponse('Not Found', { status: 404 });
  }
  return null;
}
