// ADR-0057 — MRC-Scrape status route. Verifies: an admin sees credential state
// (NEVER the password), the last sync run, and aggregated per-object mirror
// counts; the empty ledger surfaces `neverRun` honestly; a non-admin is rejected
// before any query.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAdmin = vi.fn(async () => ({ userId: 'admin-1', email: 'a@x', name: 'Admin' }));
const getMymrcCredentialStatus = vi.fn();
const findFirst = vi.fn();
const haulsAgg = vi.fn();
const processedAgg = vi.fn();
const outboundAgg = vi.fn();

vi.mock('@/lib/auth-helpers', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('@/lib/mymrc/credential-store', () => ({
  getMymrcCredentialStatus: () => getMymrcCredentialStatus(),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    mymrcSyncRun: { findFirst: () => findFirst() },
    mymrcHaulsMirror: { aggregate: () => haulsAgg() },
    mymrcProcessedMirror: { aggregate: () => processedAgg() },
    mymrcOutboundMirror: { aggregate: () => outboundAgg() },
  },
}));

import { GET } from './route';

const emptyAgg = { _count: 0, _max: { last_seen_at: null } };

beforeEach(() => {
  requireAdmin.mockReset();
  requireAdmin.mockResolvedValue({ userId: 'admin-1', email: 'a@x', name: 'Admin' });
  getMymrcCredentialStatus.mockReset();
  findFirst.mockReset();
  haulsAgg.mockReset().mockResolvedValue(emptyAgg);
  processedAgg.mockReset().mockResolvedValue(emptyAgg);
  outboundAgg.mockReset().mockResolvedValue(emptyAgg);
});

describe('GET /api/admin/mrc-scrape/status', () => {
  it('returns credential state, last run, and object counts for an admin', async () => {
    getMymrcCredentialStatus.mockResolvedValue({
      configured: true,
      username: 'bill@dr3',
      updatedAt: new Date('2026-07-20T10:00:00.000Z'),
      updatedBy: 'admin-1',
    });
    findFirst.mockResolvedValue({
      status: 'ok',
      feed: 'hauls',
      site_id: 'eugene',
      started_at: new Date('2026-07-21T09:00:00.000Z'),
      finished_at: new Date('2026-07-21T09:02:00.000Z'),
      rows_listed: 12,
      rows_upserted: 12,
      details_fetched: 12,
      error: null,
    });
    haulsAgg.mockResolvedValue({ _count: 12, _max: { last_seen_at: new Date('2026-07-21T09:02:00.000Z') } });
    processedAgg.mockResolvedValue({ _count: 5, _max: { last_seen_at: new Date('2026-07-21T08:00:00.000Z') } });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.credential).toEqual({
      configured: true,
      username: 'bill@dr3',
      updatedAt: '2026-07-20T10:00:00.000Z',
      updatedBy: 'admin-1',
    });
    expect(body.neverRun).toBe(false);
    expect(body.lastRun).toEqual({
      status: 'ok',
      feed: 'hauls',
      siteId: 'eugene',
      startedAt: '2026-07-21T09:00:00.000Z',
      finishedAt: '2026-07-21T09:02:00.000Z',
      rowsListed: 12,
      rowsUpserted: 12,
      detailsFetched: 12,
      error: null,
    });
    expect(body.objectCounts).toEqual([
      { object: 'hauls', count: 12, lastSeenAt: '2026-07-21T09:02:00.000Z' },
      { object: 'processed', count: 5, lastSeenAt: '2026-07-21T08:00:00.000Z' },
      { object: 'outbound', count: 0, lastSeenAt: null },
    ]);
  });

  it('NEVER leaks a password: the payload carries only the 4 safe credential keys', async () => {
    getMymrcCredentialStatus.mockResolvedValue({
      configured: true,
      username: 'bill@dr3',
      updatedAt: new Date('2026-07-20T10:00:00.000Z'),
      updatedBy: 'admin-1',
    });
    findFirst.mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();

    expect(Object.keys(body.credential).sort()).toEqual([
      'configured',
      'updatedAt',
      'updatedBy',
      'username',
    ]);
    // Defense in depth: no password/ciphertext anywhere in the serialized body.
    expect(JSON.stringify(body).toLowerCase()).not.toContain('password');
    expect(JSON.stringify(body).toLowerCase()).not.toContain('ciphertext');
  });

  it('surfaces the never-run state honestly when the ledger is empty', async () => {
    getMymrcCredentialStatus.mockResolvedValue({
      configured: false,
      username: null,
      updatedAt: null,
      updatedBy: null,
    });
    findFirst.mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();

    expect(body.neverRun).toBe(true);
    expect(body.lastRun).toBeNull();
    expect(body.credential.configured).toBe(false);
    expect(body.objectCounts).toEqual([
      { object: 'hauls', count: 0, lastSeenAt: null },
      { object: 'processed', count: 0, lastSeenAt: null },
      { object: 'outbound', count: 0, lastSeenAt: null },
    ]);
  });

  it('reports a run still in progress (finished_at null) without inventing an end time', async () => {
    getMymrcCredentialStatus.mockResolvedValue({
      configured: true,
      username: 'bill@dr3',
      updatedAt: new Date('2026-07-20T10:00:00.000Z'),
      updatedBy: 'admin-1',
    });
    findFirst.mockResolvedValue({
      status: 'auth_failed',
      feed: 'processed',
      site_id: 'eugene',
      started_at: new Date('2026-07-21T09:00:00.000Z'),
      finished_at: null,
      rows_listed: 0,
      rows_upserted: 0,
      details_fetched: 0,
      error: 'login rejected',
    });

    const res = await GET();
    const body = await res.json();
    expect(body.lastRun.finishedAt).toBeNull();
    expect(body.lastRun.status).toBe('auth_failed');
    expect(body.lastRun.error).toBe('login rejected');
  });

  it('rejects a non-admin (403) and never queries the ledger or mirrors', async () => {
    requireAdmin.mockRejectedValueOnce(new Response('forbidden', { status: 403 }));
    const res = await GET();
    expect(res.status).toBe(403);
    expect(getMymrcCredentialStatus).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(haulsAgg).not.toHaveBeenCalled();
  });
});
