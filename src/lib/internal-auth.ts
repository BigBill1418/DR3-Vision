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
import { publishNtfy } from '@/lib/ntfy';

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
 * Page (fail-soft, non-blocking) when an internal cron is refused in production
 * because `INTERNAL_CRON_TOKEN` is unset. This is EXACTLY the 2026-07-16 outage:
 * the guard fail-closed (503) SILENTLY, so every internal cron — including the
 * daily production report — stopped, and nobody noticed until a human spotted a
 * missing report. The 503 stays (fail-closed is correct); this makes it LOUD.
 *
 * - Fire-and-forget: `guardInternalCron` stays synchronous (12 call sites) and
 *   the 503 is never delayed. DR3-Vision is a long-lived Node server, so the
 *   floating publish still runs.
 * - Never throws out of the guard (`publishNtfy` already never throws; the
 *   `.catch` defends against a stubbed/mocked impl that might).
 * - `publishNtfy`'s own fingerprinted cooldown (30 min here) means a request
 *   storm pages ~once per 30 min, not per request (ADR-0037).
 */
function pageInternalCronUnconfigured(): void {
  try {
    // Fire synchronously (so the publish is dispatched immediately) but don't
    // await — the returned promise's rejection is swallowed. `publishNtfy` never
    // throws; the try/catch defends against a synchronous throw from a
    // stubbed/mocked impl so nothing surfaces out of the guard.
    void publishNtfy({
      topic: 'dr3-vision-system',
      title: 'internal cron BLOCKED — INTERNAL_CRON_TOKEN unset in prod',
      body:
        'guardInternalCron refused an internal cron request with 503: INTERNAL_CRON_TOKEN is unset while ' +
        'NODE_ENV=production. Every /api/internal/** cron is fail-closed (daily production report, AP poll, ' +
        'month-close) until the token is provisioned in auth.env and the app redeployed. This is the ' +
        '2026-07-16 missed-report outage — provision the token now.',
      priority: 'high',
      tags: ['cron', 'config', 'dr3-vision'],
      fingerprint: 'dr3-vision-internal-cron-token-unset',
      cooldownMs: 30 * 60 * 1000,
    }).catch(() => {
      /* fail-soft: an async publish rejection must never surface out of the guard */
    });
  } catch {
    /* fail-soft: a synchronous throw must never surface out of the guard */
  }
}

/**
 * Guard for an internal cron route. Returns a `Response` to short-circuit the
 * handler, or `null` to proceed:
 *  - request carries `cf-connecting-ip` (arrived via the public tunnel) → 404
 *  - `INTERNAL_CRON_TOKEN` unset in production → 503 (mandatory in prod) + PAGE
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
      // Fail-closed AND loud: page so an unprovisioned token can't silently
      // strangle every cron again (the 2026-07-16 incident).
      pageInternalCronUnconfigured();
      return NextResponse.json({ error: 'internal_unconfigured' }, { status: 503 });
    }
    return null;
  }
  if (!constantTimeEqual(req.headers.get('authorization'), `Bearer ${requiredToken}`)) {
    return new NextResponse('Not Found', { status: 404 });
  }
  return null;
}
