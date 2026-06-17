// ADR-0030 §10.2 — daily-report-config CRUD service tests.
//
// DB-free: mocks `@/lib/prisma` with vi.fn() spies, including a `$transaction`
// that invokes its callback with a mock `tx` object (mirrors the daily-entry
// prisma-mock idiom). Drives the REAL daily-report-config.ts functions and
// asserts: every mutation writes its audit row inside the transaction with the
// right action/table_name/Json-null shape (CLAUDE.md hard rule #6), the email
// is lowercased, time normalized, and the error taxonomy maps to the right
// HTTP status.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ── Mock prisma ─────────────────────────────────────────────────────
// Each model method is a vi.fn() configured per-test. `$transaction` runs the
// callback against the SAME mock client so the audit write inside the tx is
// observable on the same spies.
const tx = {
  bonusDailyReportConfig: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  bonusDailyReportRecipient: {
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  auditLog: {
    create: vi.fn(async () => ({ id: 'audit-1' })),
  },
};

const bonusDailyReportLog = {
  findMany: vi.fn(),
};

// The spies are declared untyped, so `mock.calls[0][0]` is an empty-tuple index
// at the type level. Read the Nth call's first argument through `unknown` and let
// the caller assert the concrete shape.
function callArg(spy: { mock: { calls: unknown[][] } }, callIndex = 0): unknown {
  return spy.mock.calls[callIndex]?.[0];
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    bonusDailyReportConfig: tx.bonusDailyReportConfig,
    bonusDailyReportRecipient: tx.bonusDailyReportRecipient,
    bonusDailyReportLog,
    auditLog: tx.auditLog,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  },
}));

const ACTOR = { userId: 'user-bill', ip: '127.0.0.1', userAgent: 'vitest' };

const CONFIG_ID = 'cfg-woodland';
const baseConfig = {
  id: CONFIG_ID,
  site_id: 'site-woodland',
  enabled: false,
  send_time_pt: new Date('1970-01-01T18:00:00.000Z'),
  subject_template: '[DR3-Vision] {site} processing — {date}',
  skip_if_zero: true,
  skip_weekends: false,
  skip_holidays: false,
  include_bonus_dollars: true,
  include_comparisons: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  tx.auditLog.create.mockImplementation(async () => ({ id: 'audit-1' }));
});

// ── patchConfig ─────────────────────────────────────────────────────

describe('patchConfig', () => {
  it('happy path: toggles enabled, normalizes HH:MM → HH:MM:00, writes audit row in the tx', async () => {
    const { patchConfig } = await import('../daily-report-config');
    tx.bonusDailyReportConfig.findUnique.mockResolvedValue({ ...baseConfig });
    tx.bonusDailyReportConfig.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...baseConfig,
        ...data,
      }),
    );

    const updated = await patchConfig(CONFIG_ID, { enabled: true, sendTimePt: '17:30' }, ACTOR);

    // enabled toggled.
    expect((updated as { enabled: boolean }).enabled).toBe(true);

    // send_time normalized HH:MM → HH:MM:00 → 1970 anchor at 17:30:00.
    const updateArg = callArg(tx.bonusDailyReportConfig.update) as {
      where: { id: string };
      data: { send_time_pt: Date };
    };
    expect(updateArg.where.id).toBe(CONFIG_ID);
    expect(updateArg.data.send_time_pt.toISOString()).toBe('1970-01-01T17:30:00.000Z');

    // Audit row written, correct action + table.
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = callArg(tx.auditLog.create) as { data: Record<string, unknown> };
    expect(auditArg.data['action']).toBe('update');
    expect(auditArg.data['table_name']).toBe('bonus_daily_report_config');
    expect(auditArg.data['row_id']).toBe(CONFIG_ID);
    expect(auditArg.data['actor_user_id']).toBe('user-bill');
    // before/after are serialized snapshots (objects, not null) on an update.
    expect((auditArg.data['after'] as { enabled: boolean }).enabled).toBe(true);
    expect((auditArg.data['before'] as { enabled: boolean }).enabled).toBe(false);
  });

  it('invalid time → DailyReportConfigError reason invalid_time, status 422, no tx run', async () => {
    const { patchConfig, DailyReportConfigError } = await import('../daily-report-config');
    await expect(patchConfig(CONFIG_ID, { sendTimePt: '25:00' }, ACTOR)).rejects.toMatchObject({
      reason: 'invalid_time',
      status: 422,
    });
    await expect(patchConfig(CONFIG_ID, { sendTimePt: '9:5' }, ACTOR)).rejects.toBeInstanceOf(
      DailyReportConfigError,
    );
    // Time is validated before the transaction, so nothing is written.
    expect(tx.bonusDailyReportConfig.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('config not found → DailyReportConfigError reason not_found, status 404, no update/audit', async () => {
    const { patchConfig } = await import('../daily-report-config');
    tx.bonusDailyReportConfig.findUnique.mockResolvedValue(null);

    await expect(patchConfig('cfg-missing', { enabled: true }, ACTOR)).rejects.toMatchObject({
      reason: 'not_found',
      status: 404,
    });
    expect(tx.bonusDailyReportConfig.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ── addRecipient ────────────────────────────────────────────────────

describe('addRecipient', () => {
  it('happy path: lowercases email, creates row, writes audit insert with Prisma.JsonNull before', async () => {
    const { addRecipient } = await import('../daily-report-config');
    tx.bonusDailyReportRecipient.findUnique.mockResolvedValue(null);
    tx.bonusDailyReportRecipient.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ id: 'rcpt-1', ...data }),
    );

    const created = await addRecipient(CONFIG_ID, '  Bill.Barnard@SVdP.US ', ACTOR);

    // Email trimmed + lowercased on the created row.
    expect((created as { email: string }).email).toBe('bill.barnard@svdp.us');
    const createArg = callArg(tx.bonusDailyReportRecipient.create) as {
      data: { email: string; config_id: string; added_by_user_id: string };
    };
    expect(createArg.data.email).toBe('bill.barnard@svdp.us');
    expect(createArg.data.config_id).toBe(CONFIG_ID);
    expect(createArg.data.added_by_user_id).toBe('user-bill');

    // Audit row: insert, JsonNull before, serialized after.
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = callArg(tx.auditLog.create) as { data: Record<string, unknown> };
    expect(auditArg.data['action']).toBe('insert');
    expect(auditArg.data['table_name']).toBe('bonus_daily_report_recipients');
    expect(auditArg.data['before']).toBe(Prisma.JsonNull);
    expect((auditArg.data['after'] as { email: string }).email).toBe('bill.barnard@svdp.us');
  });

  it('invalid email → DailyReportConfigError reason invalid_email, status 422, no tx run', async () => {
    const { addRecipient } = await import('../daily-report-config');
    await expect(addRecipient(CONFIG_ID, 'not-an-email', ACTOR)).rejects.toMatchObject({
      reason: 'invalid_email',
      status: 422,
    });
    expect(tx.bonusDailyReportRecipient.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('duplicate email → DailyReportConfigError reason duplicate_email, status 409, no create/audit', async () => {
    const { addRecipient } = await import('../daily-report-config');
    tx.bonusDailyReportRecipient.findUnique.mockResolvedValue({
      id: 'rcpt-existing',
      config_id: CONFIG_ID,
      email: 'bill.barnard@svdp.us',
    });

    await expect(addRecipient(CONFIG_ID, 'bill.barnard@svdp.us', ACTOR)).rejects.toMatchObject({
      reason: 'duplicate_email',
      status: 409,
    });
    // Lookup uses the composite-unique key config_id_email.
    const findArg = callArg(tx.bonusDailyReportRecipient.findUnique) as {
      where: { config_id_email: { config_id: string; email: string } };
    };
    expect(findArg.where.config_id_email).toEqual({
      config_id: CONFIG_ID,
      email: 'bill.barnard@svdp.us',
    });
    expect(tx.bonusDailyReportRecipient.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ── removeRecipient ─────────────────────────────────────────────────

describe('removeRecipient', () => {
  it('happy path: deletes row, writes audit delete with serialized before snapshot + JsonNull after', async () => {
    const { removeRecipient } = await import('../daily-report-config');
    tx.bonusDailyReportRecipient.findUnique.mockResolvedValue({
      id: 'rcpt-1',
      config_id: CONFIG_ID,
      email: 'bill.barnard@svdp.us',
    });
    tx.bonusDailyReportRecipient.delete.mockResolvedValue({ id: 'rcpt-1' });

    await removeRecipient('rcpt-1', ACTOR);

    expect(tx.bonusDailyReportRecipient.delete).toHaveBeenCalledWith({ where: { id: 'rcpt-1' } });

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = callArg(tx.auditLog.create) as { data: Record<string, unknown> };
    expect(auditArg.data['action']).toBe('delete');
    expect(auditArg.data['table_name']).toBe('bonus_daily_report_recipients');
    expect(auditArg.data['row_id']).toBe('rcpt-1');
    // before is the deleted-row snapshot; after is JsonNull.
    expect(auditArg.data['before']).toEqual({
      config_id: CONFIG_ID,
      email: 'bill.barnard@svdp.us',
    });
    expect(auditArg.data['after']).toBe(Prisma.JsonNull);
  });

  it('recipient not found → DailyReportConfigError reason not_found, status 404, no delete/audit', async () => {
    const { removeRecipient } = await import('../daily-report-config');
    tx.bonusDailyReportRecipient.findUnique.mockResolvedValue(null);

    await expect(removeRecipient('rcpt-missing', ACTOR)).rejects.toMatchObject({
      reason: 'not_found',
      status: 404,
    });
    expect(tx.bonusDailyReportRecipient.delete).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ── listRecentSends ─────────────────────────────────────────────────

describe('listRecentSends', () => {
  it('orders by sent_at desc and applies the default limit', async () => {
    const { listRecentSends } = await import('../daily-report-config');
    bonusDailyReportLog.findMany.mockResolvedValue([]);

    await listRecentSends(null);

    const arg = callArg(bonusDailyReportLog.findMany) as {
      orderBy: { sent_at: string };
      take: number;
      where: Record<string, unknown>;
    };
    expect(arg.orderBy).toEqual({ sent_at: 'desc' });
    expect(arg.take).toBe(30);
    // null siteId → unfiltered.
    expect(arg.where).toEqual({});
  });

  it('siteId filter narrows the where clause to that site', async () => {
    const { listRecentSends } = await import('../daily-report-config');
    bonusDailyReportLog.findMany.mockResolvedValue([]);

    await listRecentSends('site-eugene', 10);

    const arg = callArg(bonusDailyReportLog.findMany) as {
      where: { site_id: string };
      take: number;
    };
    expect(arg.where).toEqual({ site_id: 'site-eugene' });
    expect(arg.take).toBe(10);
  });
});
