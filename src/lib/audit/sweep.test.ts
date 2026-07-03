import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { PublishNtfyArgs, PublishNtfyResult } from '@/lib/ntfy';
import { runAuditSweep } from './sweep';

const okPublish: (a: PublishNtfyArgs) => Promise<PublishNtfyResult> = () =>
  Promise.resolve({ ok: true, outcome: 'sent' });

function fakeDb(over: { createImpl?: () => unknown } = {}) {
  const auditRunCreate = vi.fn(async () => (over.createImpl ? over.createImpl() : { id: 'run' }));
  const db = {
    site: { findMany: vi.fn(async () => [{ id: 's1', code: 'eugene' }, { id: 's2', code: 'woodland' }]) },
    auditRun: { create: auditRunCreate },
  } as unknown as PrismaClient;
  return { db, auditRunCreate };
}

describe('runAuditSweep', () => {
  it('is a clean no-op that still writes one ok run record per site (no ntfy)', async () => {
    const { db, auditRunCreate } = fakeDb();
    const publish = vi.fn(okPublish);
    const summary = await runAuditSweep({ db, nowISO: '2026-07-03', publish });

    expect(summary.failures).toBe(0);
    expect(summary.runs).toHaveLength(2);
    expect(summary.runs.every((r) => r.status === 'ok' && r.checksRun.length === 0)).toBe(true);
    expect(auditRunCreate).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it('computes a trailing 14-day window ending at the anchor day', async () => {
    const { db } = fakeDb();
    const summary = await runAuditSweep({ db, nowISO: '2026-07-03', publish: vi.fn(async () => ({ ok: true, outcome: 'sent' as const })) });
    expect(summary.runs[0]!.windowStartISO).toBe('2026-06-19');
    expect(summary.runs[0]!.windowEndISO).toBe('2026-07-03');
  });

  it('pages ntfy (fingerprinted) and records an error run when a site check throws', async () => {
    const { db } = fakeDb();
    const publish = vi.fn(okPublish);
    const runChecks = vi.fn(async () => {
      throw new Error('leg fetch exploded');
    });
    const summary = await runAuditSweep({ db, nowISO: '2026-07-03', publish, runChecks });

    expect(summary.failures).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
    const firstCall = publish.mock.calls[0]![0];
    expect(firstCall.fingerprint).toBe('audit-sweep-failed:eugene');
    expect(firstCall.topic).toBe('dr3-vision-system');
    expect(firstCall.priority).toBe('high');
  });
});
