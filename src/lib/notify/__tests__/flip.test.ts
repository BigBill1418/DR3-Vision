// ADR-0047 acceptance (d) — a rollout flip is audited + immediate, and requires
// a criteria note (directive §8 standing rule 2).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const writeAudit = vi.fn(async () => undefined);
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

/** Read positional arg `i` of mock call `n` without the empty-tuple type noise. */
function callArg<T>(m: { mock: { calls: unknown[] } }, n: number, i: number): T {
  return (m.mock.calls[n] as unknown[])[i] as T;
}
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...(a as [])) }));

import { flipRolloutSurface, RolloutFlipError } from '../flip';

const surfaceFindUnique = vi.fn();
const surfaceUpdate = vi.fn();

function db(): PrismaClient {
  return {
    rolloutSurface: {
      findUnique: (...a: unknown[]) => surfaceFindUnique(...a),
      update: (...a: unknown[]) => surfaceUpdate(...a),
    },
  } as unknown as PrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  surfaceFindUnique.mockResolvedValue({
    id: 's1',
    surface_code: 'alert_digest',
    site_id: 'site-w',
    rollout_state: 'pilot',
  });
  surfaceUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 's1',
    surface_code: 'alert_digest',
    ...data,
  }));
});

describe('flipRolloutSurface', () => {
  it('flips pilot→live, records who/when + criteria note, and audits it', async () => {
    const updated = await flipRolloutSurface({
      surfaceId: 's1',
      toState: 'live',
      criteriaNote: '5 clean pilot digests, 1 true finding handled end-to-end',
      actorUserId: 'u-admin',
      db: db(),
    });
    expect(updated.rollout_state).toBe('live');
    const updateArg = surfaceUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updateArg.data['rollout_state']).toBe('live');
    expect(updateArg.data['flipped_by']).toBe('u-admin');
    expect(updateArg.data['flipped_at']).toBeInstanceOf(Date);
    expect(updateArg.data['criteria_note']).toContain('5 clean pilot digests');
    // Audited (append-only) with before/after state.
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const auditArg = callArg<{
      table_name: string;
      before?: { rollout_state?: string };
      after?: { rollout_state?: string };
    }>(writeAudit, 0, 0);
    expect(auditArg.table_name).toBe('rollout_surfaces');
    expect(auditArg.before?.rollout_state).toBe('pilot');
    expect(auditArg.after?.rollout_state).toBe('live');
  });

  it('refuses a flip without a criteria note (422)', async () => {
    await expect(
      flipRolloutSurface({ surfaceId: 's1', toState: 'live', criteriaNote: '  ', actorUserId: 'u', db: db() }),
    ).rejects.toMatchObject({ reason: 'criteria_note_required', status: 422 });
    expect(surfaceUpdate).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('404s a flip of a nonexistent surface', async () => {
    surfaceFindUnique.mockResolvedValue(null);
    await expect(
      flipRolloutSurface({ surfaceId: 'nope', toState: 'live', criteriaNote: 'valid note', actorUserId: 'u', db: db() }),
    ).rejects.toBeInstanceOf(RolloutFlipError);
  });

  it('rollback: live→pilot is the same audited, immediate operation', async () => {
    surfaceFindUnique.mockResolvedValue({
      id: 's1',
      surface_code: 'alert_digest',
      site_id: 'site-w',
      rollout_state: 'live',
    });
    const updated = await flipRolloutSurface({
      surfaceId: 's1',
      toState: 'pilot',
      criteriaNote: 'confused-recipient escalation — rolling back',
      actorUserId: 'u-admin',
      db: db(),
    });
    expect(updated.rollout_state).toBe('pilot');
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });
});
