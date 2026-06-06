import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryRaw = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => [{ ok: 1 }]);
vi.mock('@/lib/prisma', () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));

import { GET } from './route';

const ENV_KEYS = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'MYMRC_WOODLAND_USERNAME',
  'MYMRC_WOODLAND_PASSWORD',
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
  clearEnv();
});
afterEach(clearEnv);

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
    process.env['MYMRC_WOODLAND_USERNAME'] = 'u';
    process.env['MYMRC_WOODLAND_PASSWORD'] = 'p';
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
});
