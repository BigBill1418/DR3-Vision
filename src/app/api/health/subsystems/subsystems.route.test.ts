import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryRaw = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => [{ ok: 1 }]);
vi.mock('@/lib/prisma', () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));

// ADR-0057 — MyMRC creds moved from MYMRC_*_ env to the DB store. Mock the status
// reader; `mymrcConfigured` flips the configured/unconfigured cases.
let mymrcConfigured = false;
vi.mock('@/lib/mymrc/credential-store', () => ({
  getMymrcCredentialStatus: async () => ({
    configured: mymrcConfigured,
    username: mymrcConfigured ? 'bill@svdp.us' : null,
    updatedAt: null,
    updatedBy: null,
  }),
}));

// audit 2026-07-16 · HEALTH — the route now requires a manager/admin role. Mock
// auth() so the config-presence assertions run as a manager by default; the
// operator-403 case flips it.
let sessionRole: string | null = 'manager';
vi.mock('@/lib/auth', () => ({
  auth: async () => (sessionRole ? { user: { role: sessionRole } } : null),
}));

import { GET } from './route';

const ENV_KEYS = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'NTFY_PUBLISHER_TOKEN',
  'AUTH_MICROSOFT_ENTRA_ID_ID',
  'AUTH_MICROSOFT_ENTRA_ID_SECRET',
  'M365_MAIL_FROM_ADDRESS',
  'GLITCHTIP_DSN',
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}
function get(subs: { key: string }[], key: string) {
  return subs.find((s) => s.key === key) as { key: string; status: string; detail: string };
}

beforeEach(() => {
  queryRaw.mockClear();
  queryRaw.mockResolvedValue([{ ok: 1 }]);
  sessionRole = 'manager';
  mymrcConfigured = false;
  clearEnv();
});
afterEach(clearEnv);

describe('GET /api/health/subsystems — authz', () => {
  it('403s an operator session (config-presence map is manager/admin only)', async () => {
    sessionRole = 'operator';
    const res = await GET();
    expect(res.status).toBe(403);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('403s an unauthenticated caller', async () => {
    sessionRole = null;
    expect((await GET()).status).toBe(403);
  });

  it('allows an admin session (200)', async () => {
    sessionRole = 'admin';
    expect((await GET()).status).toBe(200);
  });
});

describe('GET /api/health/subsystems', () => {
  it('db green + everything else amber when nothing is configured', async () => {
    const body = await (await GET()).json();
    expect(get(body.subsystems, 'db').status).toBe('green');
    for (const k of ['r2', 'mymrc', 'ntfy', 'graph', 'glitchtip']) {
      expect(get(body.subsystems, k).status).toBe('amber');
    }
    expect(body.overall).toBe('amber'); // worst of green+amber
  });

  it('all green when db is up and everything is configured', async () => {
    process.env['R2_ACCESS_KEY_ID'] = 'x';
    process.env['R2_SECRET_ACCESS_KEY'] = 'x';
    process.env['R2_BUCKET'] = 'b';
    mymrcConfigured = true;
    process.env['NTFY_PUBLISHER_TOKEN'] = 't';
    process.env['AUTH_MICROSOFT_ENTRA_ID_ID'] = 'id';
    process.env['AUTH_MICROSOFT_ENTRA_ID_SECRET'] = 's';
    process.env['M365_MAIL_FROM_ADDRESS'] = 'a@b';
    process.env['GLITCHTIP_DSN'] = 'https://x@y/1';
    const body = await (await GET()).json();
    expect(body.overall).toBe('green');
    expect(body.subsystems.every((s: { status: string }) => s.status === 'green')).toBe(true);
  });

  it('overall red when the database probe throws', async () => {
    queryRaw.mockRejectedValueOnce(new Error('down'));
    const res = await GET();
    const body = await res.json();
    expect(get(body.subsystems, 'db').status).toBe('red');
    expect(body.overall).toBe('red');
  });

  it('mymrc goes green when the DB credential store reports configured', async () => {
    mymrcConfigured = true;
    const body = await (await GET()).json();
    const mymrc = get(body.subsystems, 'mymrc');
    expect(mymrc.status).toBe('green');
    expect(mymrc.detail).toBe('Credentials configured');
  });
});
