import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mail double ──────────────────────────────────────────────────
const sendSystemEmail = vi.fn<
  (args: unknown) => Promise<{
    delivered: boolean;
    disabled: boolean;
    messageId: string;
    retries: number;
    lastStatus: number | undefined;
  }>
>(async () => ({
  delivered: true,
  disabled: false,
  messageId: 'req-1',
  retries: 0,
  lastStatus: undefined as number | undefined,
}));
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: (a: unknown) => sendSystemEmail(a) }));

// ── audit double ─────────────────────────────────────────────────
const auditRows: Array<Record<string, unknown>> = [];
vi.mock('@/lib/audit', () => ({
  writeAudit: vi.fn(async (a: Record<string, unknown>) => {
    auditRows.push(a);
  }),
}));

// ── prisma default (unused — we inject a fake db) ────────────────
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { notifyPendingSigner, resolveSlotSigner } from './signature-notifications';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

interface FakeMonth {
  id: string;
  site_id: string;
  period_start: Date;
  state: string;
  facility_signed_by_user_id: string | null;
  ops_signed_by_user_id: string | null;
  site: { name: string };
}

function fakeDb(opts: {
  month?: FakeMonth | null;
  janette?: { id: string; name: string; email: string | null } | null;
  morena?: { id: string; name: string; email: string | null } | null;
}) {
  const userWhereSeen: unknown[] = [];
  return {
    db: {
      bonusPayPeriod: {
        findUnique: async () => opts.month ?? null,
      },
      user: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          userWhereSeen.push(where);
          // janette slot resolves by primary_site_id === site; morena slot by null
          if (where['primary_site_id'] === WOODLAND) return opts.janette ?? null;
          if (where['primary_site_id'] === null) return opts.morena ?? null;
          return null;
        },
      },
    },
    userWhereSeen,
  };
}

const month = (over: Partial<FakeMonth> = {}): FakeMonth => ({
  id: 'm1',
  site_id: WOODLAND,
  period_start: new Date(Date.UTC(2026, 8, 1)), // September 2026
  state: 'pending_signatures',
  facility_signed_by_user_id: null,
  ops_signed_by_user_id: null,
  site: { name: 'DR3 Woodland' },
  ...over,
});

const JANETTE = { id: 'u-jan', name: 'Janette Tomas', email: 'janette.tomas@svdp.us' };
const MORENA = { id: 'u-mor', name: 'Morena Gomez', email: 'morena.gomez@svdp.us' };

beforeEach(() => {
  auditRows.length = 0;
  sendSystemEmail.mockClear();
});

describe('resolveSlotSigner', () => {
  it('janette slot → manager scoped to the Woodland site', async () => {
    const { db, userWhereSeen } = fakeDb({ janette: JANETTE });
    const s = await resolveSlotSigner('facility', WOODLAND, db as never);
    expect(s).toEqual(JANETTE);
    expect(userWhereSeen[0]).toMatchObject({ role: 'manager', primary_site_id: WOODLAND });
  });

  it('morena slot → manager with null primary_site_id (both-sites ops)', async () => {
    const { db, userWhereSeen } = fakeDb({ morena: MORENA });
    const s = await resolveSlotSigner('ops', WOODLAND, db as never);
    expect(s).toEqual(MORENA);
    expect(userWhereSeen[0]).toMatchObject({ role: 'manager', primary_site_id: null });
  });
});

describe('notifyPendingSigner — who gets prompted', () => {
  it('pending_signatures (none signed) → emails the facility manager (Janette)', async () => {
    const { db } = fakeDb({ month: month(), janette: JANETTE, morena: MORENA });
    const r = await notifyPendingSigner('m1', db as never);
    expect(r).toEqual({ notified: true, slot: 'facility' });
    expect(sendSystemEmail).toHaveBeenCalledTimes(1);
    expect(sendSystemEmail.mock.calls[0]![0]).toMatchObject({
      to: JANETTE.email,
      importance: 'high',
    });
    expect(auditRows[0]).toMatchObject({
      actor_label: 'system:signature-request',
      table_name: 'bonus_pay_periods',
      row_id: 'm1',
    });
  });

  it('partially_signed (Janette signed) → emails the ops manager (Morena)', async () => {
    const { db } = fakeDb({
      month: month({ state: 'partially_signed', facility_signed_by_user_id: 'u-jan' }),
      janette: JANETTE,
      morena: MORENA,
    });
    const r = await notifyPendingSigner('m1', db as never);
    expect(r).toEqual({ notified: true, slot: 'ops' });
    expect(sendSystemEmail.mock.calls[0]![0]).toMatchObject({ to: MORENA.email });
  });

  it('out-of-order override (Morena signed first) → prompts the remaining Janette slot', async () => {
    const { db } = fakeDb({
      month: month({ state: 'partially_signed', ops_signed_by_user_id: 'u-bill' }),
      janette: JANETTE,
      morena: MORENA,
    });
    const r = await notifyPendingSigner('m1', db as never);
    expect(r.slot).toBe('facility');
    expect(sendSystemEmail.mock.calls[0]![0]).toMatchObject({ to: JANETTE.email });
  });
});

describe('notifyPendingSigner — site-aware email copy', () => {
  it('Woodland period → email body says "DR3 Woodland", not Eugene', async () => {
    const { db } = fakeDb({ month: month(), janette: JANETTE, morena: MORENA });
    await notifyPendingSigner('m1', db as never);
    const body = (sendSystemEmail.mock.calls[0]![0] as { htmlBody: string }).htmlBody;
    expect(body).toContain('DR3 Woodland processor bonus report');
    expect(body).not.toContain('Eugene');
  });

  it('Eugene period → email body says "DR3 Eugene", not Woodland (no hardcoding)', async () => {
    const { db } = fakeDb({
      month: month({ site_id: EUGENE, site: { name: 'DR3 Eugene' } }),
      // facility slot for Eugene resolves by primary_site_id === EUGENE
      janette: null,
      morena: null,
    });
    // Override the user resolver via a fresh db that matches the Eugene site id.
    const eugeneDb = {
      bonusPayPeriod: {
        findUnique: async () => month({ site_id: EUGENE, site: { name: 'DR3 Eugene' } }),
      },
      user: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          where['primary_site_id'] === EUGENE
            ? { id: 'u-rick', name: 'Rick Allen', email: 'rick.allen@svdp.us' }
            : null,
      },
    };
    const r = await notifyPendingSigner('m1', eugeneDb as never);
    expect(r).toEqual({ notified: true, slot: 'facility' });
    const body = (sendSystemEmail.mock.calls[0]![0] as { htmlBody: string }).htmlBody;
    expect(body).toContain('DR3 Eugene processor bonus report');
    expect(body).not.toContain('Woodland');
    void db; // fakeDb call above documents the Eugene fixture shape
  });
});

describe('notifyPendingSigner — no-op cases', () => {
  it('does nothing for a fully signed month', async () => {
    const { db } = fakeDb({
      month: month({
        state: 'signed',
        facility_signed_by_user_id: 'a',
        ops_signed_by_user_id: 'b',
      }),
    });
    const r = await notifyPendingSigner('m1', db as never);
    // A `signed` month is caught by the state guard before the slot check.
    expect(r).toEqual({ notified: false, reason: 'not_awaiting_signatures' });
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('does nothing for a draft month', async () => {
    const { db } = fakeDb({ month: month({ state: 'draft' }) });
    const r = await notifyPendingSigner('m1', db as never);
    expect(r.reason).toBe('not_awaiting_signatures');
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('fail-open when mail is disabled (M365 unconfigured): no audit, no throw', async () => {
    sendSystemEmail.mockResolvedValueOnce({
      delivered: false,
      disabled: true,
      messageId: '',
      retries: 0,
      lastStatus: undefined,
    });
    const { db } = fakeDb({ month: month(), janette: JANETTE });
    const r = await notifyPendingSigner('m1', db as never);
    expect(r).toEqual({ notified: false, slot: 'facility', reason: 'mail_disabled' });
    expect(auditRows).toHaveLength(0);
  });

  it('skips (no throw) when the responsible signer has no email', async () => {
    const { db } = fakeDb({ month: month(), janette: { id: 'x', name: 'No Email', email: null } });
    const r = await notifyPendingSigner('m1', db as never);
    expect(r).toMatchObject({ notified: false, slot: 'facility', reason: 'no_signer_email' });
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('returns month_not_found when the month is missing', async () => {
    const { db } = fakeDb({ month: null });
    const r = await notifyPendingSigner('nope', db as never);
    expect(r.reason).toBe('month_not_found');
  });
});
