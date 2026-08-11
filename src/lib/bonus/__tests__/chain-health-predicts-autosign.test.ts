// ADR-0019.4 — the linkage test: a GREEN chain pill must predict a WORKING
// 08:30 PT auto-override, and a RED one must predict a refusal.
//
// This is the assertion that makes the indicator worth having. T-213 in
// `bonus-cycle-e2e.test.ts` already proves the auto-override signs, transitions
// the period, stamps `*_auto_override_at` and audits as `system:bonus-escalation`.
// What it does NOT prove is that the new health check AGREES with it. Two
// independent readings of the same chain that can disagree are worse than one,
// because the dashboard would then be capable of showing green while payroll is
// about to fail — the precise illusion this work exists to remove.
//
// So these tests drive BOTH against the same fixture and assert they move
// together. If someone later loosens `evaluateChainHealth` (say, drops the
// `deleted_at` check) or tightens `tierAutoOverride`, this file fails.
//
// Grounded in real production shapes:
//   PRE-FIX  — auto-override actor = the `operations@svdp.us` alias, seeded
//              is_active=false on purpose. This is what both sites carried on
//              2026-07-07 (P14) and 2026-08-04 (P16). Loki for Aug 4 08:30 PT:
//              `{"tier":"t3","autoSigned":0,"actorUnavailable":1}`.
//   POST-FIX — auto-override actor = the active `bill.barnard@svdp.us` admin,
//              Eugene ops signer = Patrick Dills (ADR-0019.3).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RecordSignatureResult } from '../signatures';
import type { SignatureChain } from '../signature-chain';
import { evaluateChainHealth, type ChainHealthUser } from '../chain-health';

// ── Boundary mocks (same shape as escalation.test.ts) ────────────────
interface NtfyArgs {
  topic: string;
  title: string;
  body: string;
  priority?: string;
  tags?: readonly string[];
  fingerprint?: string;
  cooldownMs?: number;
}
const publishNtfy = vi.fn<(a: NtfyArgs) => Promise<{ ok: boolean; outcome: 'sent' }>>(async () => ({
  ok: true,
  outcome: 'sent' as const,
}));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (a: NtfyArgs) => publishNtfy(a) }));

const triggerPayrollDelivery = vi.fn();
vi.mock('@/lib/bonus/payroll-delivery', () => ({
  triggerPayrollDelivery: (id: string) => triggerPayrollDelivery(id),
}));

const recordSignature = vi.fn<(opts: unknown) => Promise<RecordSignatureResult>>(
  async () =>
    ({
      ok: true,
      slot: 'ops',
      state: 'signed',
    }) as RecordSignatureResult,
);
vi.mock('@/lib/bonus/signatures', () => ({
  recordSignature: (o: unknown) => recordSignature(o),
}));

const getSignatureChain = vi.fn<(siteId: string, db?: unknown) => Promise<SignatureChain>>();
vi.mock('@/lib/bonus/signature-chain', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSignatureChain: (s: string, d?: unknown) => getSignatureChain(s, d),
  };
});

vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { runEscalationTier } from '../escalation';

// ── Fixture ──────────────────────────────────────────────────────────
const EUGENE = 'site-eugene';
const DEAD_ACTOR = 'ops-alias'; // operations@svdp.us — is_active=false by design
const LIVE_ACTOR = 'bill-active'; // bill.barnard@svdp.us

const ACTIVE_USERS: ChainHealthUser[] = [
  { id: LIVE_ACTOR, name: 'Bill Barnard', is_active: true, deleted_at: null },
  { id: 'rick', name: 'Rick Albritton', is_active: true, deleted_at: null },
  { id: 'patrick', name: 'Patrick Dills', is_active: true, deleted_at: null },
];
const WITH_DEAD_ACTOR: ChainHealthUser[] = [
  ...ACTIVE_USERS,
  { id: DEAD_ACTOR, name: 'Bill Barnard', is_active: false, deleted_at: null },
];

function chainWith(autoActor: string): SignatureChain {
  return {
    facility_signer_user_id: 'rick',
    facility_override_actor_user_ids: [autoActor, 'patrick'],
    ops_signer_user_id: 'patrick',
    ops_override_actor_user_ids: [autoActor],
    auto_override_actor_user_id: autoActor,
  };
}

const TODAY = new Date(Date.UTC(2026, 7, 18)); // Tue Aug 18 2026 — the next payroll day
const PERIOD_END = new Date(Date.UTC(2026, 7, 17)); // Mon Aug 17 — P17 close

/** Minimal db double: one Eugene period, unsigned ops slot, plus a user table. */
function makeDb(users: ChainHealthUser[]) {
  const period = {
    id: 'eu-p17',
    site_id: EUGENE,
    site: { code: 'eugene', name: 'Eugene' },
    period_number: 17,
    period_year: 2026,
    period_end: PERIOD_END,
    state: 'partially_signed',
    facility_signed_by_user_id: 'rick',
    ops_signed_by_user_id: null,
  };
  return {
    bonusPayPeriod: {
      findMany: async () => [{ ...period }],
    },
    user: {
      findUnique: async (a: { where: { id: string } }) =>
        users.find((u) => u.id === a.where.id) ?? null,
      findMany: async () => users,
    },
  } as never;
}

beforeEach(() => {
  publishNtfy.mockClear();
  recordSignature.mockClear();
  triggerPayrollDelivery.mockClear();
});

describe('a GREEN chain predicts a working 08:30 PT auto-override', () => {
  it('health says green AND t3 actually signs — the two readings agree', async () => {
    const chain = chainWith(LIVE_ACTOR);
    getSignatureChain.mockResolvedValue(chain);

    // Reading 1 — the standing indicator.
    const health = evaluateChainHealth({
      siteCode: 'eugene',
      siteName: 'Eugene',
      chain,
      users: ACTIVE_USERS,
    });
    expect(health.status).toBe('green');
    expect(health.autoOverrideActorName).toBe('Bill Barnard');

    // Reading 2 — the machinery the indicator is about.
    const t3 = await runEscalationTier({ db: makeDb(ACTIVE_USERS), tier: 't3', now: TODAY });
    expect(t3.actorUnavailable).toBe(0);
    expect(t3.autoSigned).toBe(1);
    expect(recordSignature).toHaveBeenCalledTimes(1);

    // It signs the UNSIGNED slot, as the chain's actor, via the override path.
    const call = recordSignature.mock.calls[0]![0] as {
      onBehalfOf: string;
      autoOverride: boolean;
      actorLabel: string;
      signer: { userId: string };
    };
    expect(call.onBehalfOf).toBe('ops');
    expect(call.signer.userId).toBe(LIVE_ACTOR);
    expect(call.autoOverride).toBe(true);
    expect(call.actorLabel).toBe('system:bonus-escalation');

    // And the payroll side-effects fire, which is what makes the 09:00 deadline.
    expect(triggerPayrollDelivery).toHaveBeenCalledWith('eu-p17');
  });
});

describe('a RED chain predicts a refusal — the 2026-08-04 production shape', () => {
  it('health says red AND t3 refuses to sign — again, the readings agree', async () => {
    const chain = chainWith(DEAD_ACTOR);
    getSignatureChain.mockResolvedValue(chain);

    const health = evaluateChainHealth({
      siteCode: 'eugene',
      siteName: 'Eugene',
      chain,
      users: WITH_DEAD_ACTOR,
    });
    expect(health.status).toBe('red');
    expect(health.findings.some((f) => f.slot === 'auto_override' && f.reason === 'inactive')).toBe(
      true,
    );

    const t3 = await runEscalationTier({ db: makeDb(WITH_DEAD_ACTOR), tier: 't3', now: TODAY });

    // This is the exact counter Loki recorded at 2026-08-04 08:30 PT.
    expect(t3.actorUnavailable).toBe(1);
    expect(t3.autoSigned).toBe(0);
    expect(recordSignature).not.toHaveBeenCalled();
    expect(triggerPayrollDelivery).not.toHaveBeenCalled();
  });

  it('the refusal is loud — an urgent page, not a silent skip', async () => {
    getSignatureChain.mockResolvedValue(chainWith(DEAD_ACTOR));
    await runEscalationTier({ db: makeDb(WITH_DEAD_ACTOR), tier: 't3', now: TODAY });

    const last = publishNtfy.mock.calls.at(-1);
    if (!last) throw new Error('expected an ntfy publish on the refusal path');
    expect(last[0].priority).toBe('urgent');
    expect(last[0].title).toContain('actor unavailable');
  });
});

describe('the indicator is not merely a mirror of the guard', () => {
  it('a SOFT-DELETED actor is red to health but WOULD still be signed as by t3', async () => {
    // Deliberate, documented divergence. `escalation.ts` checks only `is_active`,
    // so a soft-deleted-but-active account passes it and signs payroll. The health
    // check applies the repo's canonical `{is_active, deleted_at: null}` predicate
    // and calls that red.
    //
    // The disagreement is the POINT: the indicator warns about a hole in the guard
    // it watches. If this test ever flips to "both red", the guard was fixed and
    // this test should be updated to match — not deleted.
    const chain = chainWith(LIVE_ACTOR);
    getSignatureChain.mockResolvedValue(chain);
    const softDeleted: ChainHealthUser[] = [
      { id: LIVE_ACTOR, name: 'Bill Barnard', is_active: true, deleted_at: new Date() },
      ...ACTIVE_USERS.filter((u) => u.id !== LIVE_ACTOR),
    ];

    expect(
      evaluateChainHealth({ siteCode: 'eugene', siteName: 'Eugene', chain, users: softDeleted })
        .status,
    ).toBe('red');

    const t3 = await runEscalationTier({ db: makeDb(softDeleted), tier: 't3', now: TODAY });
    expect(t3.autoSigned).toBe(1); // the guard let it through
  });
});
