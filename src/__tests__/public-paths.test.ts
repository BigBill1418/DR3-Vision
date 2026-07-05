// Regression tests for the auth-middleware public-path exemption list
// (src/lib/public-paths.ts, consumed by src/middleware.ts).
//
// Why this file exists: a session-less internal cron route that is MISSING from
// the exemption list is 307'd to /login. The caller's fetch follows the redirect
// to a 200 HTML page, so the call "succeeds" while doing nothing. This bit
// ADR-0036's /api/internal/survey/reminder-tick on its first 09:00 PT fire
// (2026-07-03) — the daemon logged the login page as a successful tick.

import { describe, expect, it } from 'vitest';
import { isPublic } from '@/lib/public-paths';

describe('middleware public-path exemptions', () => {
  it.each([
    '/login',
    '/healthz',
    '/metrics',
    '/api/auth/callback/microsoft-entra-id',
    '/internal/bonus-pdf/abc123',
    '/internal/cor-pdf/abc123', // ADR-0042 — COR print source, same loopback-guarded pattern
    '/api/internal/bonus/close-months',
    '/api/internal/bonus/escalation-check',
    '/api/internal/survey/reminder-tick', // ADR-0036 — the 2026-07-03 regression
    '/api/internal/audit/sweep', // ADR-0039 — same loopback-guarded cron pattern
    '/api/internal/billing/fuel-fetch', // ADR-0040 D4 — mandatory day-one exemption
    '/api/intake/contact', // ADR-0045 D3 — public token-guarded contact intake
    '/operator',
    '/operator/site',
    '/survey/sometoken',
    '/api/survey/sometoken/submit',
  ])('exempts %s', (path) => {
    expect(isPublic(path)).toBe(true);
  });

  it.each([
    '/',
    '/dashboard',
    '/dashboard/eugene',
    '/admin/users',
    '/admin/operations/intel/abc',
    '/api/internal/surveyx/whatever', // prefix must match the full segment
    '/api/internal', // bare prefix without a route is NOT public
    '/api/exports/bonus',
    '/metricsx',
  ])('does NOT exempt %s', (path) => {
    expect(isPublic(path)).toBe(false);
  });
});
