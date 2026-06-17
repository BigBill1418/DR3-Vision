import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { NextRequest } from 'next/server';

// --- Mocks --------------------------------------------------------------

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const findUnique = vi.fn();
const logCreate = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    bonusDailyReportConfig: { findUnique: (...a: unknown[]) => findUnique(...a) },
    bonusDailyReportLog: { create: (...a: unknown[]) => logCreate(...a) },
  },
}));

const patchConfig = vi.fn();
const addRecipient = vi.fn();
const removeRecipient = vi.fn();
const listConfigs = vi.fn();
vi.mock('@/lib/bonus/daily-report-config', () => {
  class DailyReportConfigError extends Error {
    readonly status: number;
    constructor(
      public readonly reason: string,
      statusCode = 422,
    ) {
      super(`daily-report-config: ${reason}`);
      this.name = 'DailyReportConfigError';
      this.status = statusCode;
    }
  }
  return {
    patchConfig: (...a: unknown[]) => patchConfig(...a),
    addRecipient: (...a: unknown[]) => addRecipient(...a),
    removeRecipient: (...a: unknown[]) => removeRecipient(...a),
    listConfigs: (...a: unknown[]) => listConfigs(...a),
    DailyReportConfigError,
  };
});

const buildDailyReport = vi.fn();
vi.mock('@/lib/bonus/daily-report', () => ({
  buildDailyReport: (...a: unknown[]) => buildDailyReport(...a),
}));

const sendDailyReport = vi.fn();
vi.mock('@/lib/bonus/daily-report-notifications', () => ({
  sendDailyReport: (...a: unknown[]) => sendDailyReport(...a),
}));

const appToday = vi.fn(() => new Date('2026-06-17T00:00:00.000Z'));
vi.mock('@/lib/time', () => ({
  appToday: () => appToday(),
}));

import { auth } from '@/lib/auth';
import { DailyReportConfigError } from '@/lib/bonus/daily-report-config';
import { PATCH } from '../config/[siteId]/route';
import {
  POST as postRecipient,
  DELETE as deleteRecipient,
} from '../config/[siteId]/recipients/route';
import { POST as testSend } from '../config/[siteId]/test-send/route';

// --- Helpers ------------------------------------------------------------

const BILL = { id: 'user-bill', email: 'bill.barnard@svdp.us', is_super_admin: true };
const KELSEY = { id: 'user-kelsey', email: 'kelsey@svdp.us', is_super_admin: false };
const MANAGER = { id: 'user-mgr', email: 'mgr@svdp.us', is_super_admin: false };

function asUser(user: typeof BILL | typeof KELSEY | typeof MANAGER | null) {
  (auth as unknown as Mock).mockResolvedValue(user ? { user } : null);
}

const ctx = { params: Promise.resolve({ siteId: 'site-1' }) };

function jsonReq(body: unknown, urlSuffix = ''): NextRequest {
  return new Request(`http://127.0.0.1:3000/api/admin/production-report${urlSuffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({
    id: 'cfg-1',
    site_id: 'site-1',
    subject_template: 'DR3 - {site} Automated Production Report',
    include_bonus_dollars: true,
    include_comparisons: true,
  });
  patchConfig.mockResolvedValue({ id: 'cfg-1', enabled: false });
  addRecipient.mockResolvedValue({ id: 'rec-9', email: 'new@svdp.us' });
  removeRecipient.mockResolvedValue(undefined);
  buildDailyReport.mockResolvedValue({ site: 'woodland' });
  sendDailyReport.mockResolvedValue({ attempted: 1, delivered_count: 1 });
});

// --- Tests --------------------------------------------------------------

describe('PATCH /api/admin/production-report/config/[siteId]', () => {
  it('200 + patchConfig called when caller is Bill (is_super_admin=true)', async () => {
    asUser(BILL);
    const res = await PATCH(jsonReq({ enabled: false }), ctx);
    expect(res.status).toBe(200);
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(patchConfig).toHaveBeenCalledWith(
      'cfg-1',
      { enabled: false },
      expect.objectContaining({ userId: 'user-bill' }),
    );
  });

  it('403 when caller is Kelsey (admin role but is_super_admin=false)', async () => {
    asUser(KELSEY);
    const res = await PATCH(jsonReq({ enabled: false }), ctx);
    expect(res.status).toBe(403);
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('403 when caller is a non-admin manager (is_super_admin=false)', async () => {
    asUser(MANAGER);
    const res = await PATCH(jsonReq({ enabled: true }), ctx);
    expect(res.status).toBe(403);
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('403 when unauthenticated (auth returns null)', async () => {
    asUser(null);
    const res = await PATCH(jsonReq({ enabled: true }), ctx);
    expect(res.status).toBe(403);
    expect(patchConfig).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/production-report/config/[siteId]/recipients', () => {
  it('201 + addRecipient called with the email (happy path)', async () => {
    asUser(BILL);
    const res = await postRecipient(
      jsonReq({ email: 'new@svdp.us' }, '/config/site-1/recipients'),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(addRecipient).toHaveBeenCalledWith(
      'cfg-1',
      'new@svdp.us',
      expect.objectContaining({ userId: 'user-bill' }),
    );
  });

  it('409 when the email is a duplicate (DailyReportConfigError)', async () => {
    asUser(BILL);
    addRecipient.mockRejectedValueOnce(new DailyReportConfigError('duplicate_email', 409));
    const res = await postRecipient(
      jsonReq({ email: 'dup@svdp.us' }, '/config/site-1/recipients'),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'duplicate_email' });
  });
});

describe('DELETE /api/admin/production-report/config/[siteId]/recipients', () => {
  it('200 + removeRecipient called (happy path)', async () => {
    asUser(BILL);
    const req = new Request(
      'http://127.0.0.1:3000/api/admin/production-report/config/site-1/recipients?id=rec-9',
      { method: 'DELETE' },
    ) as unknown as NextRequest;
    const res = await deleteRecipient(req);
    expect(res.status).toBe(200);
    expect(removeRecipient).toHaveBeenCalledWith(
      'rec-9',
      expect.objectContaining({ userId: 'user-bill' }),
    );
  });
});

describe('POST /api/admin/production-report/config/[siteId]/test-send', () => {
  it('200, sends to caller email ONLY, and writes no log row', async () => {
    asUser(BILL);
    const res = await testSend(jsonReq({}, '/config/site-1/test-send'), ctx);
    expect(res.status).toBe(200);
    expect(sendDailyReport).toHaveBeenCalledTimes(1);
    expect(sendDailyReport).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: ['bill.barnard@svdp.us'] }),
    );
    expect(logCreate).not.toHaveBeenCalled();
  });
});
