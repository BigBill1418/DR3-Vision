// ADR-0046 D3/D5/C6 — poll orchestrator: counts, mode self-report, ledger ALWAYS
// (incl. throw paths + ledger-write failure), delta-token persistence, deadman.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeDb, type FakePollRun } from './__testutils__/fake-prisma';
import { mockTransport } from '@/lib/msgraph-mail';
import { checkApDeadman, runApPoll } from './poll';

const publishNtfy = vi.fn(async () => ({ ok: true, outcome: 'sent' as const }));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/r2', () => ({ putApAttachment: vi.fn(async () => null) }));
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: vi.fn(async () => ({ delivered: true, disabled: false, messageId: 'm', retries: 0, lastStatus: 202 })) }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (...a: unknown[]) => publishNtfy(...(a as [])) }));
vi.mock('@/lib/observability/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}

beforeEach(() => {
  publishNtfy.mockClear();
  delete process.env['MSGRAPH_MAIL_TENANT_ID'];
});

describe('runApPoll — success', () => {
  it('processes the fixture mailbox: 5 created + 1 quarantined, moves all, writes an ok ledger row (mode=mock)', async () => {
    const db = newFakeDb();
    const res = await runApPoll({ prisma: fp(db), transport: mockTransport() });
    expect(res.status).toBe('ok');
    expect(res.transportMode).toBe('mock');
    expect(res.messagesListed).toBe(6);
    expect(res.requestsCreated).toBe(5);
    expect(res.quarantined).toBe(1);
    expect(res.moved).toBe(6);
    expect(res.resynced).toBe(true);
    // Ledger ALWAYS written (C6).
    expect(db.pollRuns).toHaveLength(1);
    expect(db.pollRuns[0]!.status).toBe('ok');
    expect(db.pollRuns[0]!.transport_mode).toBe('mock');
    // Delta token persisted for next poll.
    expect(db.deltaTokens).toHaveLength(1);
  });
});

describe('runApPoll — failure still writes the ledger + pages', () => {
  it('drift throw → status error, ledger row written, system page fired', async () => {
    const db = newFakeDb();
    const res = await runApPoll({ prisma: fp(db), transport: mockTransport({ driftOn: 'listDelta' }) });
    expect(res.status).toBe('error');
    expect(res.error).toBeTruthy();
    expect(db.pollRuns).toHaveLength(1);
    expect(db.pollRuns[0]!.status).toBe('error');
    expect(publishNtfy).toHaveBeenCalled();
  });

  it('auth failure → status auth_failed, ledger row written', async () => {
    const db = newFakeDb();
    const res = await runApPoll({ prisma: fp(db), transport: mockTransport({ failAuth: true }) });
    expect(res.status).toBe('auth_failed');
    expect(db.pollRuns[0]!.status).toBe('auth_failed');
  });

  it('a ledger-write failure is swallowed (never throws to the caller)', async () => {
    const db = newFakeDb();
    const prisma = fp(db);
    (prisma as unknown as { apPollRun: { create: () => Promise<never> } }).apPollRun.create = async () => {
      throw new Error('ledger down');
    };
    const res = await runApPoll({ prisma, transport: mockTransport() });
    expect(res.status).toBe('ok'); // resolves despite the ledger write blowing up
  });
});

describe('checkApDeadman', () => {
  const okRun = (startedAt: Date): FakePollRun => ({
    id: 'r',
    status: 'ok',
    transport_mode: 'mock',
    started_at: startedAt,
    messages_listed: 0,
    requests_created: 0,
    quarantined: 0,
    error: null,
    run_id: null,
  });

  it('pages when the last ok run is older than the threshold', async () => {
    const db = newFakeDb({ pollRuns: [okRun(new Date('2026-07-06T00:00:00Z'))] });
    await checkApDeadman(fp(db), 45, new Date('2026-07-06T01:00:00Z')); // 60 min later
    expect(publishNtfy).toHaveBeenCalled();
  });

  it('does NOT page when the last ok run is fresh', async () => {
    const db = newFakeDb({ pollRuns: [okRun(new Date('2026-07-06T00:55:00Z'))] });
    await checkApDeadman(fp(db), 45, new Date('2026-07-06T01:00:00Z')); // 5 min later
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('does NOT page when there is no baseline ok run', async () => {
    const db = newFakeDb();
    await checkApDeadman(fp(db), 45, new Date());
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});
