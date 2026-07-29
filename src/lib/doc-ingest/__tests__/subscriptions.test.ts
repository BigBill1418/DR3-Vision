// ADR-0067 §3.2 / §A.9 — change subscriptions.
//
// Two things are being protected here:
//   1. the clientState secret — it IS the authentication on a genuinely
//      internet-facing endpoint, so a wrong or absent one must never verify;
//   2. the posture on failure — §A.9 forbids silently degrading to polling-only,
//      so every failure path has to SAY what happened and what it costs.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clientStateMatches,
  driveSubscriptionResource,
  ensureSubscriptions,
  hashClientState,
  mintClientState,
  recordNotificationDelivery,
  verifyNotification,
  subscriptionRetryDelayMs,
  SUBSCRIPTION_SCOPE_NOTE,
} from '../subscriptions';
import { DocIngestAccessDeniedError, type DocIngestGraph } from '../graph';
import {
  makeFakePrisma,
  resetFakeIds,
  type FakeDocIngestPrisma,
} from '../__testutils__/fake-prisma';

vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true, outcome: 'sent' })) }));

const NOW = new Date('2026-07-29T12:00:00.000Z');

function makeGraph(over: Partial<DocIngestGraph> = {}): DocIngestGraph {
  return {
    listSharedWithMe: async () => [],
    listChildren: async () => [],
    getItem: async () => {
      throw new Error('unused');
    },
    deltaForDrive: async () => ({ items: [], deltaLink: null }),
    downloadItem: async () => new Uint8Array(),
    createSubscription: async () => ({
      id: 'graph-sub-1',
      expirationDateTime: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
      resource: '/drives/drive-A/root',
    }),
    renewSubscription: async () => ({
      id: 'graph-sub-1',
      expirationDateTime: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
      resource: '',
    }),
    deleteSubscription: async () => undefined,
    ...over,
  };
}

let prisma: FakeDocIngestPrisma;
const p = () => prisma as unknown as never;

beforeEach(() => {
  resetFakeIds();
  prisma = makeFakePrisma();
});

async function seedWatchedSource() {
  await prisma.docSource.create({
    data: { drive_id: 'drive-A', item_id: 'item-1', display_name: 'Doc.xlsx' },
  });
}

describe('clientState', () => {
  it('stores ONLY a hash — never a bearer-equivalent secret in every DB backup', () => {
    const { plaintext, hash } = mintClientState();
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(plaintext);
    expect(hash).toBe(hashClientState(plaintext));
  });

  it('mints a distinct high-entropy secret each time', () => {
    const a = mintClientState();
    const b = mintClientState();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.plaintext.length).toBeGreaterThanOrEqual(40);
  });

  it('matches the right secret and rejects everything else', () => {
    const { plaintext, hash } = mintClientState();
    expect(clientStateMatches(plaintext, hash)).toBe(true);
    expect(clientStateMatches('wrong', hash)).toBe(false);
    expect(clientStateMatches('', hash)).toBe(false);
    // A malformed stored hash must not accidentally validate.
    expect(clientStateMatches(plaintext, '')).toBe(false);
    expect(clientStateMatches(plaintext, 'not-hex')).toBe(false);
  });

  it('targets the documented resource path for OneDrive for Business', () => {
    // Verified against learn.microsoft.com: only `/drives/{id}/root` is supported,
    // and it covers the whole hierarchy — which is why a shared FOLDER's later
    // additions are covered too.
    expect(driveSubscriptionResource('drive-A')).toBe('/drives/drive-A/root');
  });
});

describe('verifyNotification', () => {
  it('accepts a notification carrying the right clientState', async () => {
    const { plaintext, hash } = mintClientState();
    await prisma.docIngestSubscription.create({
      data: {
        drive_id: 'drive-A',
        resource: '/drives/drive-A/root',
        notification_url: 'https://x/y',
        subscription_id: 'graph-sub-1',
        client_state_hash: hash,
        state: 'active',
      },
    });
    const row = await verifyNotification(p(), 'graph-sub-1', plaintext);
    expect(row).not.toBeNull();
  });

  it('REJECTS a wrong secret, a missing secret, and an unknown subscription', async () => {
    const { hash } = mintClientState();
    await prisma.docIngestSubscription.create({
      data: {
        drive_id: 'drive-A',
        resource: '/drives/drive-A/root',
        notification_url: 'https://x/y',
        subscription_id: 'graph-sub-1',
        client_state_hash: hash,
        state: 'active',
      },
    });
    expect(await verifyNotification(p(), 'graph-sub-1', 'forged')).toBeNull();
    expect(await verifyNotification(p(), 'graph-sub-1', null)).toBeNull();
    expect(await verifyNotification(p(), 'no-such-sub', 'anything')).toBeNull();
  });

  it('records a delivery — the only honest measure that push actually works', async () => {
    const row = await prisma.docIngestSubscription.create({
      data: {
        drive_id: 'drive-A',
        resource: 'r',
        notification_url: 'u',
        subscription_id: 'graph-sub-1',
        state: 'active',
      },
    });
    await recordNotificationDelivery(p(), row['id'] as string, NOW);
    const after = prisma._stores.subscriptions[0];
    expect(after?.['notifications_received']).toBe(1);
    expect(after?.['last_notification_at']).toEqual(NOW);
  });
});

describe('ensureSubscriptions', () => {
  it('creates one subscription per watched drive and marks it validated', async () => {
    await seedWatchedSource();
    const result = await ensureSubscriptions(p(), makeGraph(), NOW);

    expect(result.created).toBe(1);
    const row = prisma._stores.subscriptions[0];
    expect(row?.['state']).toBe('active');
    expect(row?.['subscription_id']).toBe('graph-sub-1');
    // Graph only issues an id AFTER our endpoint echoed its validationToken, so
    // a successful create IS the empirical proof the handshake worked (§A.9).
    expect(row?.['validated_at']).toEqual(NOW);
  });

  it('does not touch a subscription that is not near expiry', async () => {
    await seedWatchedSource();
    await ensureSubscriptions(p(), makeGraph(), NOW);
    const renew = vi.fn();
    const result = await ensureSubscriptions(p(), makeGraph({ renewSubscription: renew }), NOW);
    expect(renew).not.toHaveBeenCalled();
    expect(result.renewed).toBe(0);
  });

  it('auto-renews AHEAD of expiry, so one failed renewal is not an outage', async () => {
    await seedWatchedSource();
    await ensureSubscriptions(p(), makeGraph(), NOW);

    // 12 hours from expiry — inside the 24h renewal lead.
    const row = prisma._stores.subscriptions[0];
    if (row) row['expires_at'] = new Date(NOW.getTime() + 12 * 3_600_000);

    const result = await ensureSubscriptions(p(), makeGraph(), NOW);
    expect(result.renewed).toBe(1);
    expect(prisma._stores.subscriptions[0]?.['state']).toBe('active');
  });

  it('§A.9 — a failed VALIDATION handshake is reported, never silently downgraded', async () => {
    await seedWatchedSource();
    const graph = makeGraph({
      createSubscription: async () => {
        throw new Error(
          'Subscription validation request failed. Response must exactly match validationToken.',
        );
      },
    });

    const result = await ensureSubscriptions(p(), graph, NOW);

    expect(result.validationFailures).toBe(1);
    const anomaly = prisma._stores.anomalies.find((a) => a['kind'] === 'webhook_validation_failed');
    expect(anomaly).toBeDefined();
    // The exact posture the directive demands: correctness intact, latency worse,
    // and the operator told which of those they are living with.
    expect(String(anomaly?.['detail'])).toContain('NOT silently fallen back to polling-only');
    expect(String(anomaly?.['detail'])).toContain('sweep');
  });

  it('explains a 403 as a STRUCTURAL limit — and never as a permission to grant', async () => {
    // CORRECTED 2026-07-29. This test previously asserted the note told Bill that
    // granting Files.ReadWrite.All would buy back push latency, and that the
    // choice was "a decision for Bill". Both were false: Microsoft documents
    // delegated **Files.Read.All** for driveItem subscriptions on OneDrive for
    // Business — which Vision already holds — and states that subscriptions do
    // not accept write permissions where read permissions suffice. The blocker is
    // the RESOURCE (root-folder-only, never an individual file), so no grant
    // fixes it. A test that pins a wrong recommendation in place is worse than no
    // test: it makes the wrong answer look load-bearing.
    await seedWatchedSource();
    const graph = makeGraph({
      createSubscription: async () => {
        throw new Error('graph POST /subscriptions → HTTP 403: Forbidden');
      },
    });

    await ensureSubscriptions(p(), graph, NOW);

    const anomaly = prisma._stores.anomalies.find((a) => a['kind'] === 'subscription_renew_failed');
    expect(anomaly).toBeDefined();
    expect(anomaly?.['context']).toMatchObject({ scopeRelated: true });
    expect(String(anomaly?.['detail'])).toContain('STRUCTURAL limit');
    expect(SUBSCRIPTION_SCOPE_NOTE).toContain('Files.Read.All');
    expect(SUBSCRIPTION_SCOPE_NOTE).toContain('DRIVE ROOT');
    // It must actively warn AGAINST the grant it used to recommend.
    expect(SUBSCRIPTION_SCOPE_NOTE).toContain('Do not grant Files.ReadWrite.All');
    // And it must not still be telling him this is his call to make.
    expect(SUBSCRIPTION_SCOPE_NOTE).not.toContain('decision for Bill');
  });

  it('detects the scope case from the ERROR TYPE, not from its message text', async () => {
    // The superseded check was `/403|forbidden|accessDenied/i.test(reason)` where
    // `reason` is `DocIngestAccessDeniedError.message` — "access denied for POST
    // /subscriptions". No status code, no "forbidden", and `accessDenied` ≠
    // `access denied`. It could never match the one error it was written for.
    await seedWatchedSource();
    const graph = makeGraph({
      createSubscription: async () => {
        throw new DocIngestAccessDeniedError('POST /subscriptions');
      },
    });

    await ensureSubscriptions(p(), graph, NOW);

    const anomaly = prisma._stores.anomalies.find((a) => a['kind'] === 'subscription_renew_failed');
    expect(anomaly?.['context']).toMatchObject({ scopeRelated: true });
    expect(String(anomaly?.['detail'])).toContain('STRUCTURAL limit');
  });

  it('keeps ONE subscription row per drive across repeated failures', async () => {
    // The leak: `findFirst` matched only pending/active, so a `failed` row matched
    // nothing and every sweep INSERTED another — 96 rows/drive/day, and `sweep.ts`
    // runs a delta pass per row, so Graph call volume grew with uptime. Found live
    // with 2 rows for one drive after 2 sweeps.
    await seedWatchedSource();
    const graph = makeGraph({
      createSubscription: async () => {
        throw new DocIngestAccessDeniedError('POST /subscriptions');
      },
    });

    await ensureSubscriptions(p(), graph, NOW);
    expect(prisma._stores.subscriptions).toHaveLength(1);

    // Far enough past the backoff that the retry is genuinely due.
    await ensureSubscriptions(p(), graph, new Date(NOW.getTime() + 86_400_000));
    await ensureSubscriptions(p(), graph, new Date(NOW.getTime() + 2 * 86_400_000));
    expect(prisma._stores.subscriptions).toHaveLength(1);
    expect(prisma._stores.subscriptions[0]?.['failure_count']).toBe(3);
  });

  it('backs off a permanently-refused drive instead of retrying every sweep', async () => {
    await seedWatchedSource();
    let attempts = 0;
    const graph = makeGraph({
      createSubscription: async () => {
        attempts += 1;
        throw new DocIngestAccessDeniedError('POST /subscriptions');
      },
    });

    await ensureSubscriptions(p(), graph, NOW);
    expect(attempts).toBe(1);

    // The next sweep, one interval later, must NOT re-attempt.
    await ensureSubscriptions(p(), graph, new Date(NOW.getTime() + 60_000));
    expect(attempts).toBe(1);

    // A day later it does — so the day the share becomes a drive-root grant,
    // push starts working with no code change and no operator action.
    await ensureSubscriptions(p(), graph, new Date(NOW.getTime() + 86_400_000));
    expect(attempts).toBe(2);
  });

  it('caps the retry backoff at one day', () => {
    expect(subscriptionRetryDelayMs(1)).toBe(15 * 60_000);
    expect(subscriptionRetryDelayMs(2)).toBe(30 * 60_000);
    expect(subscriptionRetryDelayMs(99)).toBe(24 * 60 * 60_000);
  });

  it('records a renewal failure without pretending push still works', async () => {
    await seedWatchedSource();
    await ensureSubscriptions(p(), makeGraph(), NOW);
    const row = prisma._stores.subscriptions[0];
    if (row) row['expires_at'] = new Date(NOW.getTime() + 3_600_000);

    const graph = makeGraph({
      renewSubscription: async () => {
        throw new Error('500 Internal Server Error');
      },
    });
    const result = await ensureSubscriptions(p(), graph, NOW);

    expect(result.failed).toBe(1);
    expect(prisma._stores.subscriptions[0]?.['state']).toBe('failed');
    const anomaly = prisma._stores.anomalies.find((a) => a['kind'] === 'subscription_renew_failed');
    expect(String(anomaly?.['detail'])).toContain('only latency degrades');
  });

  it('clears the stale id when a renewal 404s, so the next pass creates a fresh one', async () => {
    await seedWatchedSource();
    await ensureSubscriptions(p(), makeGraph(), NOW);
    const row = prisma._stores.subscriptions[0];
    if (row) row['expires_at'] = new Date(NOW.getTime() + 3_600_000);

    await ensureSubscriptions(
      p(),
      makeGraph({
        renewSubscription: async () => {
          throw new Error('graph PATCH → HTTP 404 not found');
        },
      }),
      NOW,
    );

    // Retrying a PATCH against something that no longer exists is a dead end.
    expect(prisma._stores.subscriptions[0]?.['subscription_id']).toBeNull();
    expect(prisma._stores.subscriptions[0]?.['state']).toBe('expired');
  });

  it('revokes subscriptions for drives nothing is shared from any more', async () => {
    await seedWatchedSource();
    await ensureSubscriptions(p(), makeGraph(), NOW);

    // The share is withdrawn.
    const source = prisma._stores.sources[0];
    if (source) source['state'] = 'disappeared';

    const del = vi.fn(async () => undefined);
    await ensureSubscriptions(p(), makeGraph({ deleteSubscription: del }), NOW);

    expect(del).toHaveBeenCalledWith('graph-sub-1');
    expect(prisma._stores.subscriptions[0]?.['state']).toBe('revoked');
  });

  it('does not subscribe on behalf of a source Bill disabled', async () => {
    await prisma.docSource.create({
      data: { drive_id: 'drive-A', item_id: 'item-1', display_name: 'x', enabled: false },
    });
    const create = vi.fn();
    await ensureSubscriptions(p(), makeGraph({ createSubscription: create }), NOW);
    expect(create).not.toHaveBeenCalled();
  });
});
