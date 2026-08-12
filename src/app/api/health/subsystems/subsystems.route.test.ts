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

// ADR-0019.4 — the signature-chain subsystem. `chainStatus` flips the
// healthy/broken cases; the route consumes loadChainHealth's report shape.
let chainStatus: 'green' | 'amber' | 'red' = 'green';
let chainThrows = false;
vi.mock('@/lib/bonus/chain-health', () => ({
  loadChainHealth: async () => {
    if (chainThrows) throw new Error('db down');
    return {
      overall: chainStatus,
      sites: [
        {
          siteCode: 'eugene',
          siteName: 'Eugene',
          status: chainStatus,
          autoOverrideActorName: 'Bill Barnard',
          findings:
            chainStatus === 'green'
              ? []
              : [{ slot: 'auto_override', reason: 'inactive', userId: 'x', detail: 'dead actor' }],
        },
      ],
    };
  },
}));

// ADR-0071 Amendment 1 — the processor-quota monitor subsystem. `quotaStatus`
// flips the three states; the important one is AMBER, which means "the monitor
// is running and is deliberately emailing nobody". Before this probe existed
// that state was invisible, and the operator's "we are supposed to get alerts
// and I have seen nothing" had nowhere to be answered.
let quotaStatus: 'green' | 'amber' | 'red' = 'green';
let quotaThrows = false;
vi.mock('@/lib/bonus/processor-quota-liveness', () => ({
  loadProcessorQuotaHealth: async () => {
    if (quotaThrows) throw new Error('db down');
    return {
      status: quotaStatus,
      detail: quotaStatus === 'green' ? 'Ran 3 hours ago; digest enabled for 1 of 2 sites.' : 'off',
      lastRunAt: new Date('2026-08-12T13:00:00.000Z'),
      configsTotal: 2,
      configsEnabled: quotaStatus === 'green' ? 1 : 0,
    };
  },
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
  chainStatus = 'green';
  chainThrows = false;
  quotaStatus = 'green';
  quotaThrows = false;
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

// ── ADR-0019.4: the chain subsystem ──────────────────────────────────
describe('signature-chain subsystem (ADR-0019.4)', () => {
  async function subsystems() {
    const res = await GET();
    const body = (await res.json()) as {
      overall: string;
      subsystems: { key: string; status: string; detail: string }[];
    };
    return body;
  }

  it('is present in the subsystem list at all — the T-120 gap this closes', async () => {
    const body = await subsystems();
    expect(body.subsystems.map((s) => s.key)).toContain('signature-chain');
  });

  it('green names the resolved override actor, so the pill answers WHO would sign', async () => {
    const body = await subsystems();
    const chain = body.subsystems.find((s) => s.key === 'signature-chain');
    expect(chain?.status).toBe('green');
    expect(chain?.detail).toContain('Bill Barnard');
  });

  it('a RED chain turns the whole pill red — this must not be a quiet sub-status', async () => {
    chainStatus = 'red';
    const body = await subsystems();
    expect(body.subsystems.find((s) => s.key === 'signature-chain')?.status).toBe('red');
    expect(body.overall).toBe('red');
  });

  it('an AMBER chain degrades but does not turn the pill red', async () => {
    chainStatus = 'amber';
    const body = await subsystems();
    expect(body.subsystems.find((s) => s.key === 'signature-chain')?.status).toBe('amber');
  });

  it('a thrown probe degrades to amber, not red — probeDb owns the DB-down signal', async () => {
    chainThrows = true;
    const body = await subsystems();
    const chain = body.subsystems.find((s) => s.key === 'signature-chain');
    expect(chain?.status).toBe('amber');
    expect(chain?.detail).toBe('Unknown');
  });
});

// ── ADR-0071 Amendment 1 ──────────────────────────────────────────────────
//
// The processor-quota digest is a silence-means-fine alert, so "no email" is
// its normal weekly outcome. That reading is only safe while somebody can see
// the monitor is alive. It shipped switched off on 2026-07-31, the cron fired
// daily, nothing anywhere recorded a run, and on 2026-08-11 the operator asked
// why he had seen nothing — a question the system could not answer.
describe('GET /api/health/subsystems — processor-quota monitor', () => {
  async function subsystems() {
    const res = await GET();
    return (await res.json()) as {
      overall: string;
      subsystems: { key: string; status: string; detail: string }[];
    };
  }

  it('is present in the subsystem list at all — the gap that hid the silence', async () => {
    const body = await subsystems();
    expect(body.subsystems.map((s) => s.key)).toContain('processor-quota');
  });

  // The distinction the whole amendment exists for: "switched off" degrades the
  // pill so it is visible, but must never read as an outage, because nothing is
  // broken — a person chose it and a person can unchoose it.
  it('an AMBER monitor (alive, emailing nobody) degrades without turning the pill red', async () => {
    quotaStatus = 'amber';
    const body = await subsystems();
    expect(body.subsystems.find((s) => s.key === 'processor-quota')?.status).toBe('amber');
    expect(body.overall).not.toBe('red');
  });

  // A stopped monitor IS an outage: managers read no-email as "everyone met
  // quota", so a dead cron actively misinforms rather than merely going quiet.
  it('a RED monitor turns the whole pill red — a dead quota cron misinforms', async () => {
    quotaStatus = 'red';
    const body = await subsystems();
    expect(body.subsystems.find((s) => s.key === 'processor-quota')?.status).toBe('red');
    expect(body.overall).toBe('red');
  });

  it('a thrown probe degrades to amber, not red — probeDb owns the DB-down signal', async () => {
    quotaThrows = true;
    const body = await subsystems();
    const quota = body.subsystems.find((s) => s.key === 'processor-quota');
    expect(quota?.status).toBe('amber');
    expect(quota?.detail).toBe('Unknown');
  });
});
