// ADR-0116 — the audit routes ask the ROLE question, not only the reach one.
//
// Both `/api/audit/[site]/run` (POST) and `/api/audit/[site]/findings/[id]`
// (GET/PATCH) hand-rolled their access check as reach-only:
//
//   const isAdmin = session.user.role === 'admin';
//   const canReach = isAdmin || session.user.all_sites === true
//                 || session.user.primary_site_id === site.id;
//
// The canonical `requireManagerForSite` (`auth-helpers.ts:50-53`) rejects a
// non-manager BEFORE it evaluates reach. These two routes never asked. An
// operator's PIN session is a full session carrying a real `role` and
// `primary_site_id` (`auth.ts:236-240`), and `middleware.ts` gates on
// authentication only — never role — so an operator satisfied `canReach` for
// their own site and could run on-demand audits and transition findings.
// Neither route had any test at all before this file.
//
// The suite asserts BOTH directions. A 403-only test would pass on a route that
// forbids everyone, which is why the manager and admin cases are here: the gate
// has to reject the operator *and* still admit the roles it is for.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SITE_ID = 'site-eugene';

const { authFn, siteFindUnique, auditSiteWindow, buildRunChecksForWindow } = vi.hoisted(() => ({
  authFn: vi.fn(),
  siteFindUnique: vi.fn(async () => ({ id: SITE_ID, code: 'eugene' })),
  auditSiteWindow: vi.fn(async () => ({ findings: [], counts: {} })),
  buildRunChecksForWindow: vi.fn(async () => []),
}));

vi.mock('@/lib/auth', () => ({ auth: authFn }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: { findUnique: siteFindUnique },
    auditRun: { create: vi.fn(async () => ({ id: 'run-1' })) },
  },
}));
vi.mock('@/lib/audit/sweep', () => ({ auditSiteWindow }));
vi.mock('@/lib/audit/leg-fetchers', () => ({ buildRunChecksForWindow }));

import { POST } from './run/route';

/** A session shaped exactly like the real one for the given role. */
function session(role: string, opts: { siteId?: string | null; allSites?: boolean } = {}) {
  return {
    user: {
      id: `u-${role}`,
      role,
      primary_site_id: opts.siteId === undefined ? SITE_ID : opts.siteId,
      all_sites: opts.allSites ?? false,
    },
  };
}

function req(): Request {
  return new Request('http://localhost/api/audit/eugene/run', {
    method: 'POST',
    body: JSON.stringify({ windowStart: '2026-08-01', windowEnd: '2026-08-15' }),
  });
}

const params = Promise.resolve({ site: 'eugene' });

describe('POST /api/audit/[site]/run — role gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    siteFindUnique.mockResolvedValue({ id: SITE_ID, code: 'eugene' });
  });

  it('REFUSES an operator whose primary site matches — reach is not power', async () => {
    authFn.mockResolvedValue(session('operator'));
    const res = await POST(req(), { params });
    expect(res.status).toBe(403);
    // The refusal must land BEFORE the engine runs. A 403 returned after the
    // sweep had already persisted its finding-lifecycle and `audit_runs` rows
    // would be the same status code and none of the protection.
    expect(auditSiteWindow).not.toHaveBeenCalled();
  });

  it('ADMITS a manager whose primary site matches', async () => {
    authFn.mockResolvedValue(session('manager'));
    const res = await POST(req(), { params });
    expect(res.status).not.toBe(403);
    expect(auditSiteWindow).toHaveBeenCalledTimes(1);
  });

  it('ADMITS an admin', async () => {
    authFn.mockResolvedValue(session('admin', { siteId: null }));
    const res = await POST(req(), { params });
    expect(res.status).not.toBe(403);
  });

  it('still REFUSES a manager scoped to another site (reach gate intact)', async () => {
    authFn.mockResolvedValue(session('manager', { siteId: 'site-woodland' }));
    const res = await POST(req(), { params });
    expect(res.status).toBe(403);
    expect(auditSiteWindow).not.toHaveBeenCalled();
  });

  it('ADMITS an all_sites manager on a site that is not their primary (ADR-0024)', async () => {
    authFn.mockResolvedValue(session('manager', { siteId: 'site-woodland', allSites: true }));
    const res = await POST(req(), { params });
    expect(res.status).not.toBe(403);
  });

  it('answers 401 with no session, and never reaches the role check', async () => {
    authFn.mockResolvedValue(null);
    const res = await POST(req(), { params });
    expect(res.status).toBe(401);
  });
});
