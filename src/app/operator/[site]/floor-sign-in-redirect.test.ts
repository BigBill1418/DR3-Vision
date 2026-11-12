// ADR-0144 — a signed-out floor page sends the operator to the PIN screen WITH
// the way back.
//
// The keypad has honoured `?next=` since ADR-0078 G8c, but the floor pages'
// own signed-out redirects never supplied one, so an operator whose 5-minute idle
// window lapsed on /hauls signed in and landed on the hub. Only the signed-out
// case (401 — including the session husk) gets `?next=`; a wrong role or a wrong
// site is not fixed by signing in again, so those redirects are unchanged.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const gate = vi.fn();
vi.mock('@/lib/auth-helpers', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth-helpers')>()),
  checkOperatorForSite: (s: string) => gate(s),
}));
const auth = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: () => auth(), signOut: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => null,
}));

const params = Promise.resolve({ site: 'woodland', id: 'load-7' });
const searchParams = Promise.resolve({});

type Page = (p: { params: typeof params; searchParams: typeof searchParams }) => Promise<unknown>;

const GATED: Array<[string, () => Promise<{ default: Page }>, string]> = [
  ['today', () => import('./today/page'), '/operator/woodland/today'],
  ['hauls', () => import('./hauls/page'), '/operator/woodland/hauls'],
  ['count', () => import('./count/page'), '/operator/woodland/count'],
  ['inbound', () => import('./inbound/page'), '/operator/woodland/inbound'],
  ['processed', () => import('./processed/page'), '/operator/woodland/processed'],
  ['dropoff', () => import('./dropoff/page'), '/operator/woodland/dropoff'],
  ['queue/conflicts', () => import('./queue/conflicts/page'), '/operator/woodland/queue/conflicts'],
];
const SESSION: Array<[string, () => Promise<{ default: Page }>, string]> = [
  ['queue', () => import('./queue/page'), '/operator/woodland/queue'],
  ['load/[id]', () => import('./load/[id]/page'), '/operator/woodland/load/load-7'],
];

async function redirectOf(load: () => Promise<{ default: Page }>): Promise<string> {
  const { default: page } = await load();
  const e = await page({ params, searchParams }).then(
    () => null,
    (err: unknown) => err,
  );
  return String((e as Error | null)?.message ?? '');
}

const signIn = (here: string) => `REDIRECT:/operator/woodland?next=${encodeURIComponent(here)}`;

// The page modules pull in large import graphs; load them once up front so a
// cold transform on a loaded host does not eat the first test's 5 s budget.
beforeAll(async () => {
  await Promise.all([...GATED, ...SESSION].map(([, load]) => load()));
}, 120_000);

beforeEach(() => {
  gate.mockReset();
  auth.mockReset();
});

describe.each(GATED)('ADR-0144 — %s page', (_name, load, here) => {
  it('signed out (401) → name picker with ?next= back to this page', async () => {
    gate.mockResolvedValue({ ok: false, status: 401 });
    expect(await redirectOf(load)).toBe(signIn(here));
  });

  it.each([403, 404])('refused (%i) → unchanged bare redirect, no ?next=', async (status) => {
    gate.mockResolvedValue({ ok: false, status });
    expect(await redirectOf(load)).toBe('REDIRECT:/operator/woodland');
  });
});

describe.each(SESSION)('ADR-0144 — %s page', (_name, load, here) => {
  it('the session HUSK → name picker with ?next= back to this page', async () => {
    auth.mockResolvedValue({ user: {} });
    expect(await redirectOf(load)).toBe(signIn(here));
  });

  it('a non-operator is still sent to the home route, not the PIN screen', async () => {
    auth.mockResolvedValue({ user: { id: 'm-1', role: 'manager' } });
    expect(await redirectOf(load)).not.toContain('/operator/woodland');
  });
});
