// ADR-0141 — the submit API's gate: who may submit, for which site, and that the
// submitter and site come from the session and URL, never the request body.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ current: null as unknown }));
const live = vi.hoisted(() => ({ value: false }));
const submit = vi.hoisted(() =>
  vi.fn(async () => ({ requestId: 'req-new', accountantEmail: 'x' })),
);

vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: async ({ where }: { where: { code: string } }) =>
        ({ woodland: { id: 'site-w' }, eugene: { id: 'site-e' } })[where.code] ?? null,
    },
  },
}));
vi.mock('@/lib/notify/rollout', () => ({
  UI_SURFACE: { AP_TEAM_SUBMIT: 'ap_team_submit' },
  NOTIFY_SURFACE: { AP_NOTIFY: 'ap_notify', AP_TEAM_OUTCOME: 'ap_team_outcome' },
  isUiSurfaceLive: async () => live.value,
}));
vi.mock('@/lib/ap/team-submit', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  submitTeamInvoice: submit,
}));

import { POST } from './route';

function as(role: string, primary: string | null) {
  session.current = {
    user: { id: `u-${role}`, role, primary_site_id: primary, email: `${role}@svdp.us` },
  };
}

function req(): Request {
  const fd = new FormData();
  fd.set('vendor', 'ACME');
  fd.set('invoiceNumber', '1001');
  fd.set('amount', '1,240.50');
  fd.set('purpose', 'pest control');
  fd.set('accountantId', 'acct-gloria');
  fd.set('site_id', 'site-e'); // ignored: the site is the URL's
  fd.set('submitted_by', 'u-someone-else'); // ignored: the submitter is the session's
  fd.append(
    'files',
    new File([new Uint8Array([37, 80, 68, 70])], 'inv.pdf', { type: 'application/pdf' }),
  );
  return new Request('http://x/api/dashboard/woodland/ap-submit', { method: 'POST', body: fd });
}
const call = (site: string) => POST(req(), { params: Promise.resolve({ site }) });

beforeEach(() => {
  submit.mockClear();
  live.value = false;
});

describe('POST /api/dashboard/[site]/ap-submit', () => {
  it('401 without a session', async () => {
    session.current = null;
    expect((await call('woodland')).status).toBe(401);
  });

  it('404 for an unknown site', async () => {
    as('admin', null);
    expect((await call('stockton')).status).toBe(404);
  });

  it('403 for an operator', async () => {
    live.value = true;
    as('operator', 'site-w');
    expect((await call('woodland')).status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });

  it('403 for a manager at another site, even when live', async () => {
    live.value = true;
    as('manager', 'site-e');
    const res = await call('woodland');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('forbidden_site');
  });

  it('403 for a manager at their own site while the surface is pilot', async () => {
    as('manager', 'site-w');
    const res = await call('woodland');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('pilot');
  });

  it('a manager at their own site, once live, submits with the session identity and URL site', async () => {
    live.value = true;
    as('manager', 'site-w');
    const res = await call('woodland');
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        submitter: { userId: 'u-manager', email: 'manager@svdp.us' },
        siteId: 'site-w',
        accountantId: 'acct-gloria',
        amountCents: 124050,
      }),
    );
  });

  it('an admin submits for any site while pilot', async () => {
    as('admin', null);
    const res = await call('eugene');
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ siteId: 'site-e' }));
  });
});
