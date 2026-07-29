// ADR-0067 Amendment A §A.6 — the `reauth_required` posture.
//
// ⚠ `@/lib/ntfy` is MOCKED for the whole file. These tests exercise a real
// publish path; without the mock a live page would reach Bill's phone from a
// unit-test run. That has happened on this fleet before — the mock is not
// optional politeness, it is the guard.
//
// What is asserted:
//   - the TRANSITION pages immediately (ADR-0057 D9: silence is never acceptable)
//   - repeated calls do NOT re-page inside the 24 h window (the latch is in
//     Postgres, not the per-process ntfy ledger, so a container restart cannot
//     change the answer)
//   - it DOES re-page once the window elapses
//   - `reauth_since` records the ORIGINAL onset, not the latest touch
//   - a transient failure records without latching or paging
//   - the 06:00 digest line persists until resolved

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

type NtfyArgs = Record<string, unknown>;
const publishNtfy = vi.fn((args: NtfyArgs) => {
  // The arg is recorded by `vi.fn` and asserted below; the mock body itself has
  // no use for it. Typed rather than variadic so `mock.calls[n][0]` is typed.
  void args;
  return Promise.resolve({ ok: true, outcome: 'sent' as const });
});
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (args: NtfyArgs) => publishNtfy(args) }));

const {
  docIngestReauthWarning,
  latchReauthRequired,
  recordTransientRefreshFailure,
  REPAGE_INTERVAL_MS,
} = await import('../reauth');

interface Row {
  state: 'connected' | 'reauth_required';
  reauth_paged_at: Date | null;
  reauth_since: Date | null;
  reauth_reason: string | null;
  last_refresh_error: string | null;
  account_upn: string;
}

function stubPrisma(initial: Row | null) {
  let row = initial ? { ...initial } : null;
  const client = {
    docIngestConnection: {
      findUnique: () => Promise.resolve(row),
      update: ({ data }: { data: Partial<Row> }) => {
        if (row) row = { ...row, ...data };
        return Promise.resolve(row);
      },
      updateMany: ({ data }: { data: Partial<Row> }) => {
        if (row) row = { ...row, ...data };
        return Promise.resolve({ count: row ? 1 : 0 });
      },
    },
  };
  return { prisma: client as unknown as PrismaClient, peek: () => row };
}

const CONNECTED: Row = {
  state: 'connected',
  reauth_paged_at: null,
  reauth_since: null,
  reauth_reason: null,
  last_refresh_error: null,
  account_upn: 'docs-dr3@svdp.us',
};

beforeEach(() => {
  publishNtfy.mockClear();
});

describe('latchReauthRequired', () => {
  it('latches and pages IMMEDIATELY on the transition', async () => {
    const { prisma, peek } = stubPrisma(CONNECTED);
    const now = new Date('2026-08-01T12:00:00Z');

    const result = await latchReauthRequired(prisma, 'invalid_grant: token expired', now);

    expect(result).toEqual({ transitioned: true, paged: true });
    expect(peek()?.state).toBe('reauth_required');
    expect(peek()?.reauth_since).toEqual(now);
    expect(publishNtfy).toHaveBeenCalledTimes(1);
  });

  it('pages on dr3-vision-system at high priority, clicking through to the connect page', async () => {
    const { prisma } = stubPrisma(CONNECTED);
    await latchReauthRequired(prisma, 'invalid_grant', new Date());

    const args = publishNtfy.mock.calls[0]?.[0] ?? {};
    expect(args['topic']).toBe('dr3-vision-system');
    expect(args['priority']).toBe('high');
    expect(String(args['clickUrl'])).toContain('/admin/doc-ingest/connect');
    // This module owns dedup via reauth_paged_at; the in-process ntfy ledger
    // must not also suppress, or a restart changes behaviour.
    expect(args['cooldownMs']).toBe(0);
  });

  it('names the service account so the fix is unambiguous', async () => {
    const { prisma } = stubPrisma(CONNECTED);
    await latchReauthRequired(prisma, 'invalid_grant', new Date());
    const args = publishNtfy.mock.calls[0]?.[0] ?? {};
    expect(String(args['body'])).toContain('docs-dr3@svdp.us');
    expect(String(args['body'])).toContain('HALTED');
  });

  it('does NOT re-page inside the 24 h window', async () => {
    const t0 = new Date('2026-08-01T12:00:00Z');
    const { prisma } = stubPrisma(CONNECTED);
    await latchReauthRequired(prisma, 'invalid_grant', t0);
    publishNtfy.mockClear();

    const again = await latchReauthRequired(
      prisma,
      'invalid_grant',
      new Date(t0.getTime() + REPAGE_INTERVAL_MS - 1),
    );

    expect(again).toEqual({ transitioned: false, paged: false });
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('re-pages once the window elapses — an unresolved outage must not go quiet', async () => {
    const t0 = new Date('2026-08-01T12:00:00Z');
    const { prisma } = stubPrisma(CONNECTED);
    await latchReauthRequired(prisma, 'invalid_grant', t0);
    publishNtfy.mockClear();

    const again = await latchReauthRequired(
      prisma,
      'invalid_grant',
      new Date(t0.getTime() + REPAGE_INTERVAL_MS),
    );

    expect(again).toEqual({ transitioned: false, paged: true });
    expect(publishNtfy).toHaveBeenCalledTimes(1);
  });

  it('preserves the ORIGINAL onset across repeated calls', async () => {
    const t0 = new Date('2026-08-01T12:00:00Z');
    const { prisma, peek } = stubPrisma(CONNECTED);
    await latchReauthRequired(prisma, 'invalid_grant', t0);
    await latchReauthRequired(prisma, 'invalid_grant', new Date(t0.getTime() + 5 * 86_400_000));
    // "Since when" is what tells Bill whether this is new or has been rotting.
    expect(peek()?.reauth_since).toEqual(t0);
  });

  it('does nothing when nothing was ever connected — no false alarm on a fresh install', async () => {
    const { prisma } = stubPrisma(null);
    expect(await latchReauthRequired(prisma, 'invalid_grant', new Date())).toEqual({
      transitioned: false,
      paged: false,
    });
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});

describe('recordTransientRefreshFailure', () => {
  it('records the error WITHOUT latching or paging', async () => {
    // A network blip must never become a human-action page — that is how an
    // operator learns to ignore the page that actually matters.
    const { prisma, peek } = stubPrisma(CONNECTED);
    await recordTransientRefreshFailure(prisma, 'token endpoint unreachable: ECONNRESET');
    expect(peek()?.state).toBe('connected');
    expect(peek()?.last_refresh_error).toContain('ECONNRESET');
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});

describe('docIngestReauthWarning — the 06:00 digest line', () => {
  it('is null while connected', async () => {
    const { prisma } = stubPrisma(CONNECTED);
    expect(await docIngestReauthWarning(prisma, new Date())).toBeNull();
  });

  it('is null when nothing is connected at all', async () => {
    const { prisma } = stubPrisma(null);
    expect(await docIngestReauthWarning(prisma, new Date())).toBeNull();
  });

  it('names the account, the age, and the fix once latched', async () => {
    const t0 = new Date('2026-08-01T12:00:00Z');
    const { prisma } = stubPrisma(CONNECTED);
    await latchReauthRequired(prisma, 'invalid_grant: expired', t0);

    const line = await docIngestReauthWarning(prisma, new Date(t0.getTime() + 3 * 86_400_000));

    expect(line).toContain('DISCONNECTED');
    expect(line).toContain('(3d)');
    expect(line).toContain('docs-dr3@svdp.us');
    expect(line).toContain('/admin/doc-ingest/connect');
  });

  it('reads "since today" on day zero rather than a bare 0d', async () => {
    const t0 = new Date('2026-08-01T12:00:00Z');
    const { prisma } = stubPrisma(CONNECTED);
    await latchReauthRequired(prisma, 'invalid_grant', t0);
    expect(await docIngestReauthWarning(prisma, t0)).toContain('since today');
  });
});
