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

interface FakeUser {
  id: string;
  name: string;
  email: string | null;
  /** Set on the row but IRRELEVANT to resolution now — present to prove that. */
  primary_site_id?: string | null;
  is_active?: boolean;
  deleted_at?: Date | null;
}

interface FakeChain {
  facility_signer_user_id: string;
  ops_signer_user_id: string;
}

/**
 * Build a fake Prisma double whose signer resolution mirrors production:
 * `resolveSlotSigner` reads the `bonus_signature_chains` row for the site, picks
 * the slot's signer UUID, then loads that user BY ID (filtered active + not
 * deleted). `users` is the realistic user table keyed by id; `chains` maps a site
 * id to its chain. Each call returns a fresh `db` object so the chain WeakMap
 * cache never bleeds across tests.
 */
function fakeDb(opts: {
  month?: FakeMonth | null;
  users?: FakeUser[];
  chains?: Record<string, FakeChain>;
}) {
  const userWhereSeen: Array<Record<string, unknown>> = [];
  const chainWhereSeen: Array<Record<string, unknown>> = [];
  const users = opts.users ?? [];
  // Default single-site (Woodland) chain: Janette signs facility, Morena ops —
  // and Morena's user row carries a NON-NULL primary_site_id (Woodland). The old
  // `primary_site_id: null` heuristic could never find her; the chain does.
  const chains = opts.chains ?? {
    [WOODLAND]: { facility_signer_user_id: 'u-jan', ops_signer_user_id: 'u-mor' },
  };
  return {
    db: {
      bonusPayPeriod: {
        findUnique: async () => opts.month ?? null,
      },
      bonusSignatureChain: {
        findUnique: async ({ where }: { where: Record<string, unknown> }) => {
          chainWhereSeen.push(where);
          const c = chains[where['site_id'] as string];
          if (!c) return null;
          // Mirror the real row's column set; override columns default to ''.
          return {
            facility_signer_user_id: c.facility_signer_user_id,
            facility_override_actor_ids: '',
            ops_signer_user_id: c.ops_signer_user_id,
            ops_override_actor_ids: '',
            auto_override_actor_user_id: 'u-bill',
          };
        },
      },
      user: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          userWhereSeen.push(where);
          const u = users.find((x) => x.id === where['id']);
          if (!u) return null;
          // Honor the active/not-deleted filter the resolver applies.
          if (where['is_active'] === true && u.is_active === false) return null;
          if (where['deleted_at'] === null && u.deleted_at != null) return null;
          return { id: u.id, name: u.name, email: u.email };
        },
      },
    },
    userWhereSeen,
    chainWhereSeen,
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

// Realistic Woodland users. CRITICAL: Morena (the ops signer) has a NON-NULL
// primary_site_id (Woodland) — exactly the production case the old
// `primary_site_id: null` heuristic failed on (incident 2026-06-22). The chain
// resolves her by id regardless.
const JANETTE: FakeUser = {
  id: 'u-jan',
  name: 'Janette Tomas',
  email: 'janette.tomas@svdp.us',
  primary_site_id: WOODLAND,
};
const MORENA: FakeUser = {
  id: 'u-mor',
  name: 'Morena Gomez',
  email: 'morena.gomez@svdp.us',
  primary_site_id: WOODLAND,
};
/** The bare {id,name,email} a successful resolve returns (no extra columns). */
const slotSignerOf = (u: FakeUser) => ({ id: u.id, name: u.name, email: u.email });

beforeEach(() => {
  auditRows.length = 0;
  sendSystemEmail.mockClear();
});

describe('resolveSlotSigner', () => {
  it('facility slot → the chain’s facility_signer_user_id, loaded by id', async () => {
    const { db, userWhereSeen, chainWhereSeen } = fakeDb({ users: [JANETTE, MORENA] });
    const s = await resolveSlotSigner('facility', WOODLAND, db as never);
    expect(s).toEqual(slotSignerOf(JANETTE));
    // Resolution went through the chain, then loaded the user BY ID (not by a
    // primary_site_id heuristic).
    expect(chainWhereSeen[0]).toMatchObject({ site_id: WOODLAND });
    expect(userWhereSeen[0]).toMatchObject({ id: 'u-jan', is_active: true, deleted_at: null });
  });

  // REGRESSION (incident 2026-06-22): the ops signer (Morena) has a NON-NULL
  // primary_site_id. The old `primary_site_id: null` query returned null → she
  // was never emailed her signature request. Resolving from the chain must still
  // find her by id.
  it('ops slot → the chain’s ops_signer_user_id even when that user has a non-null primary_site_id', async () => {
    expect(MORENA.primary_site_id).toBe(WOODLAND); // guard: the bug’s precondition
    const { db, userWhereSeen } = fakeDb({ users: [JANETTE, MORENA] });
    const s = await resolveSlotSigner('ops', WOODLAND, db as never);
    expect(s).toEqual(slotSignerOf(MORENA));
    expect(userWhereSeen[0]).toMatchObject({ id: 'u-mor' });
    // It must NOT have queried by the legacy null heuristic.
    expect(userWhereSeen[0]).not.toHaveProperty('primary_site_id');
  });

  it('returns null when the chain’s signer is inactive/deleted', async () => {
    const inactiveMorena: FakeUser = { ...MORENA, is_active: false };
    const { db } = fakeDb({ users: [JANETTE, inactiveMorena] });
    const s = await resolveSlotSigner('ops', WOODLAND, db as never);
    expect(s).toBeNull();
  });
});

describe('notifyPendingSigner — who gets prompted', () => {
  it('pending_signatures (none signed) → emails the facility signer (Janette)', async () => {
    const { db } = fakeDb({ month: month(), users: [JANETTE, MORENA] });
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

  // The production failure mode end-to-end: facility signed, the ops signer
  // (Morena, non-null primary_site_id) MUST receive the email. Before the fix
  // this returned no_signer_email and skipped — the missed-deadline path.
  it('partially_signed (Janette signed) → emails the ops signer (Morena) despite her non-null primary_site_id', async () => {
    const { db } = fakeDb({
      month: month({ state: 'partially_signed', facility_signed_by_user_id: 'u-jan' }),
      users: [JANETTE, MORENA],
    });
    const r = await notifyPendingSigner('m1', db as never);
    expect(r).toEqual({ notified: true, slot: 'ops' });
    expect(sendSystemEmail).toHaveBeenCalledTimes(1);
    expect(sendSystemEmail.mock.calls[0]![0]).toMatchObject({ to: MORENA.email });
  });

  it('out-of-order override (ops signed first) → prompts the remaining facility slot', async () => {
    const { db } = fakeDb({
      month: month({ state: 'partially_signed', ops_signed_by_user_id: 'u-bill' }),
      users: [JANETTE, MORENA],
    });
    const r = await notifyPendingSigner('m1', db as never);
    expect(r.slot).toBe('facility');
    expect(sendSystemEmail.mock.calls[0]![0]).toMatchObject({ to: JANETTE.email });
  });
});

describe('notifyPendingSigner — site-aware email copy', () => {
  it('Woodland period → email body says "DR3 Woodland", not Eugene', async () => {
    const { db } = fakeDb({ month: month(), users: [JANETTE, MORENA] });
    await notifyPendingSigner('m1', db as never);
    const body = (sendSystemEmail.mock.calls[0]![0] as { htmlBody: string }).htmlBody;
    expect(body).toContain('DR3 Woodland processor bonus report');
    expect(body).not.toContain('Eugene');
  });

  it('Eugene period → email body says "DR3 Eugene", not Woodland (chain-sourced, no hardcoding)', async () => {
    // Eugene's own chain + users. Rick signs facility, Kelsey ops.
    const RICK: FakeUser = {
      id: 'u-rick',
      name: 'Rick Albritton',
      email: 'rick.albritton@svdp.us',
      primary_site_id: EUGENE,
    };
    const KELSEY: FakeUser = {
      id: 'u-kel',
      name: 'Kelsey Ruhland',
      email: 'kelsey.ruhland@svdp.us',
      primary_site_id: EUGENE,
    };
    const { db } = fakeDb({
      month: month({ site_id: EUGENE, site: { name: 'DR3 Eugene' } }),
      users: [RICK, KELSEY],
      chains: { [EUGENE]: { facility_signer_user_id: 'u-rick', ops_signer_user_id: 'u-kel' } },
    });
    const r = await notifyPendingSigner('m1', db as never);
    expect(r).toEqual({ notified: true, slot: 'facility' });
    expect(sendSystemEmail.mock.calls[0]![0]).toMatchObject({ to: RICK.email });
    const body = (sendSystemEmail.mock.calls[0]![0] as { htmlBody: string }).htmlBody;
    expect(body).toContain('DR3 Eugene processor bonus report');
    expect(body).not.toContain('Woodland');
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
    const { db } = fakeDb({ month: month(), users: [JANETTE, MORENA] });
    const r = await notifyPendingSigner('m1', db as never);
    expect(r).toEqual({ notified: false, slot: 'facility', reason: 'mail_disabled' });
    expect(auditRows).toHaveLength(0);
  });

  it('skips (no throw) when the responsible signer has no email', async () => {
    // The facility signer (chain default u-jan) exists but has no email on file.
    const noEmailJanette: FakeUser = { ...JANETTE, email: null };
    const { db } = fakeDb({ month: month(), users: [noEmailJanette, MORENA] });
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
