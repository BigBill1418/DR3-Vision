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
    '/api/internal/bonus/daily-report', // ADR-0030 — daily production-report cron, under the /api/internal/bonus/ exemption
    '/api/internal/survey/reminder-tick', // ADR-0036 — the 2026-07-03 regression
    '/api/internal/audit/sweep', // ADR-0039 — same loopback-guarded cron pattern
    '/api/internal/billing/fuel-fetch', // ADR-0040 D4 — mandatory day-one exemption
    '/api/internal/ap/poll', // ADR-0046 D5 — mandatory day-one exemption for the AP poll cron
    '/api/internal/ap/expiry', // ADR-0046 §3 — AP approver expiry cron (reuses the /ap/ exemption)
    '/api/internal/board-pack/send', // ADR-0045 §3 addendum — board-pack digest cron
    '/api/internal/workbook-sync/poll', // ADR-0049 D2 — mandatory day-one exemption for the workbook-sync poll cron
    '/api/internal/inventory/floor-probe', // ADR-0058 — anchor-safety floor-probe gate for the MyMRC inventory bridges
    '/api/internal/doc-ingest/sweep', // ADR-0067 §3.2 D4 — the delta sweep IS the correctness path; a silent no-op here reproduces the MyMRC failure
    // ADR-0088 — the throughput-gap watchdog. A 307 here would make the watchdog
    // itself the second silent instrument: the daemon logs 200, the ledger stays
    // empty, and an empty ledger is indistinguishable from "no gaps".
    '/api/internal/equipment/throughput-gap',
    '/api/doc-ingest/notifications', // ADR-0067 §3.2 — genuinely internet-facing; clientState is the protection, not a network boundary
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
    '/api/doc-ingestx/notifications', // prefix must match the full segment
    '/admin/doc-ingest', // the OPERATOR surfaces stay admin-gated — only the Graph webhook is public
    '/metricsx',
  ])('does NOT exempt %s', (path) => {
    expect(isPublic(path)).toBe(false);
  });
});
