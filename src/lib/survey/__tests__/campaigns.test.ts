// ADR-0034 — survey campaign service tests (§14.1).
//
// DB-free: mocks `@/lib/prisma` with vi.fn() spies, including a `$transaction`
// that invokes its callback with the same mock `tx` object (mirrors the
// daily-report-config / daily-entry prisma-mock idiom). Drives the REAL
// campaigns.ts functions and asserts: token shape, lowercase normalization,
// status-gate error taxonomy, and that every mutation writes its audit row
// inside the transaction (CLAUDE.md hard rule #6).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `tx` is referenced inside the hoisted vi.mock factory, so it must itself be
// hoisted (vi.mock lifts above plain const declarations → temporal-dead-zone).
const { tx } = vi.hoisted(() => ({
  tx: {
    surveyCampaign: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    surveyInvite: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    surveyQuestion: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    surveyResponse: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: 'audit-1' })),
    },
  },
}));

function callArg(spy: { mock: { calls: unknown[][] } }, callIndex = 0): unknown {
  return spy.mock.calls[callIndex]?.[0];
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    surveyCampaign: tx.surveyCampaign,
    surveyInvite: tx.surveyInvite,
    surveyQuestion: tx.surveyQuestion,
    surveyResponse: tx.surveyResponse,
    auditLog: tx.auditLog,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  },
}));

import {
  addInvite,
  approveInvite,
  closeCampaign,
  createCampaign,
  markInviteOpened,
  markInviteSent,
  saveDraft,
  submitResponse,
  SurveyCampaignError,
  updateInviteQuestions,
} from '../campaigns';

const ACTOR = { userId: 'user-bill', ip: '127.0.0.1', userAgent: 'vitest' };
const PUBLIC_ACTOR = { ip: '203.0.113.5', userAgent: 'browser' };

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

beforeEach(() => {
  vi.clearAllMocks();
  tx.auditLog.create.mockImplementation(async () => ({ id: 'audit-1' }));
});

// ── createCampaign ──────────────────────────────────────────────────

describe('createCampaign', () => {
  it('1. writes the campaign + an audit_log row (before=null, after=campaign) in the same transaction', async () => {
    const campaignRow = { id: 'camp-1', title: 'T', slug: 's', from_address: 'dr3-vision@svdp.us' };
    tx.surveyCampaign.create.mockResolvedValue(campaignRow);

    const out = await createCampaign(
      { title: 'T', slug: 's', intro_text: 'hello' },
      ACTOR,
    );

    expect(out).toBe(campaignRow);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = callArg(tx.auditLog.create) as { data: Record<string, unknown> };
    expect(audit.data['action']).toBe('insert');
    expect(audit.data['table_name']).toBe('survey_campaigns');
    expect(audit.data['row_id']).toBe('camp-1');
    expect(audit.data['actor_user_id']).toBe('user-bill');
    expect((audit.data['after'] as { id: string }).id).toBe('camp-1');
  });

  it('2. defaults to the SVdP sender identity when not specified', async () => {
    tx.surveyCampaign.create.mockResolvedValue({ id: 'camp-1' });
    await createCampaign({ title: 'T', slug: 's', intro_text: 'x' }, ACTOR);
    const createArg = callArg(tx.surveyCampaign.create) as { data: Record<string, unknown> };
    // No from_* keys are passed → the Prisma column defaults apply.
    expect(createArg.data['from_address']).toBeUndefined();
    expect(createArg.data['from_display_name']).toBeUndefined();
    expect(createArg.data['reply_to']).toBeUndefined();
  });

  it('3. honors per-campaign sender overrides', async () => {
    tx.surveyCampaign.create.mockResolvedValue({ id: 'camp-1' });
    await createCampaign(
      {
        title: 'T',
        slug: 's',
        intro_text: 'x',
        from_address: 'other@svdp.us',
        from_display_name: 'Someone Else',
        reply_to: 'reply@svdp.us',
        subject_template: 'Custom subject',
      },
      ACTOR,
    );
    const createArg = callArg(tx.surveyCampaign.create) as { data: Record<string, unknown> };
    expect(createArg.data['from_address']).toBe('other@svdp.us');
    expect(createArg.data['from_display_name']).toBe('Someone Else');
    expect(createArg.data['reply_to']).toBe('reply@svdp.us');
    expect(createArg.data['subject_template']).toBe('Custom subject');
  });
});

// ── addInvite ───────────────────────────────────────────────────────

describe('addInvite', () => {
  const QUESTIONS = [{ position: 1, kind: 'long_text' as const, prompt: 'Q1' }];

  it('4. writes a draft invite with a 32-char base64url token + audit row in the same transaction', async () => {
    tx.surveyCampaign.findUnique.mockResolvedValue({ id: 'camp-1', status: 'draft' });
    tx.surveyInvite.findUnique.mockResolvedValue(null);
    tx.surveyInvite.create.mockResolvedValue({
      id: 'inv-1',
      recipient_name: 'Rick',
      recipient_email: 'rick@svdp.us',
      role_label: 'Eugene',
      questions: QUESTIONS,
    });

    await addInvite(
      'camp-1',
      { recipient_name: 'Rick', recipient_email: 'Rick@svdp.us', role_label: 'Eugene', questions: QUESTIONS },
      ACTOR,
    );

    const createArg = callArg(tx.surveyInvite.create) as { data: Record<string, unknown> };
    expect(createArg.data['status']).toBe('draft');
    expect(TOKEN_RE.test(createArg.data['token'] as string)).toBe(true);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = callArg(tx.auditLog.create) as { data: Record<string, unknown> };
    expect(audit.data['action']).toBe('insert');
    expect(audit.data['table_name']).toBe('survey_invites');
  });

  it('5. rejects with duplicate_email (409) when the same email is added twice', async () => {
    tx.surveyCampaign.findUnique.mockResolvedValue({ id: 'camp-1', status: 'draft' });
    tx.surveyInvite.findUnique.mockResolvedValue({ id: 'inv-existing' });

    await expect(
      addInvite(
        'camp-1',
        { recipient_name: 'Rick', recipient_email: 'rick@svdp.us', role_label: 'Eugene', questions: QUESTIONS },
        ACTOR,
      ),
    ).rejects.toMatchObject({ reason: 'duplicate_email', status: 409 });
    expect(tx.surveyInvite.create).not.toHaveBeenCalled();
  });

  it('6. is case-insensitive on recipient_email (normalizes to lowercase)', async () => {
    tx.surveyCampaign.findUnique.mockResolvedValue({ id: 'camp-1', status: 'draft' });
    tx.surveyInvite.findUnique.mockResolvedValue(null);
    tx.surveyInvite.create.mockResolvedValue({ id: 'inv-1', recipient_name: 'R', recipient_email: 'rick@svdp.us', role_label: 'E', questions: [] });

    await addInvite(
      'camp-1',
      { recipient_name: 'R', recipient_email: 'RICK@SVDP.US', role_label: 'E', questions: QUESTIONS },
      ACTOR,
    );

    // The duplicate lookup is by the lowercased email.
    const lookupArg = callArg(tx.surveyInvite.findUnique) as {
      where: { campaign_id_recipient_email: { recipient_email: string } };
    };
    expect(lookupArg.where.campaign_id_recipient_email.recipient_email).toBe('rick@svdp.us');
    const createArg = callArg(tx.surveyInvite.create) as { data: { recipient_email: string } };
    expect(createArg.data.recipient_email).toBe('rick@svdp.us');
  });

  it('7. rejects with campaign_locked when the campaign is closed', async () => {
    tx.surveyCampaign.findUnique.mockResolvedValue({ id: 'camp-1', status: 'closed' });
    await expect(
      addInvite(
        'camp-1',
        { recipient_name: 'R', recipient_email: 'r@svdp.us', role_label: 'E', questions: QUESTIONS },
        ACTOR,
      ),
    ).rejects.toMatchObject({ reason: 'campaign_locked', status: 409 });
  });
});

// ── updateInviteQuestions ───────────────────────────────────────────

describe('updateInviteQuestions', () => {
  const NEW_Q = [{ position: 1, kind: 'long_text' as const, prompt: 'New Q' }];

  it('8. clears approved → draft and resets approval fields when questions change after approval', async () => {
    tx.surveyInvite.findUnique.mockResolvedValue({ id: 'inv-1', status: 'approved' });
    tx.surveyQuestion.findMany.mockResolvedValue([{ id: 'q1' }, { id: 'q2' }]);

    await updateInviteQuestions('inv-1', NEW_Q, ACTOR);

    expect(tx.surveyInvite.update).toHaveBeenCalledTimes(1);
    const upd = callArg(tx.surveyInvite.update) as { data: Record<string, unknown> };
    expect(upd.data['status']).toBe('draft');
    expect(upd.data['approved_by_user_id']).toBeNull();
    expect(upd.data['approved_at']).toBeNull();
    const audit = callArg(tx.auditLog.create) as { data: Record<string, unknown> };
    expect((audit.data['after'] as { status_reset: boolean }).status_reset).toBe(true);
  });

  it('9. rejects with invalid_status when the invite has been sent or beyond', async () => {
    tx.surveyInvite.findUnique.mockResolvedValue({ id: 'inv-1', status: 'sent' });
    await expect(updateInviteQuestions('inv-1', NEW_Q, ACTOR)).rejects.toMatchObject({
      reason: 'invalid_status',
      status: 409,
    });
    expect(tx.surveyQuestion.deleteMany).not.toHaveBeenCalled();
  });
});

// ── approveInvite ───────────────────────────────────────────────────

describe('approveInvite', () => {
  it('10. flips draft → approved, records approved_by_user_id, writes audit', async () => {
    tx.surveyInvite.findUnique.mockResolvedValue({ id: 'inv-1', status: 'draft' });
    tx.surveyInvite.update.mockResolvedValue({ id: 'inv-1', status: 'approved', approved_at: new Date() });

    await approveInvite('inv-1', ACTOR);

    const upd = callArg(tx.surveyInvite.update) as { data: Record<string, unknown> };
    expect(upd.data['status']).toBe('approved');
    expect(upd.data['approved_by_user_id']).toBe('user-bill');
    const audit = callArg(tx.auditLog.create) as { data: Record<string, unknown> };
    expect(audit.data['action']).toBe('update');
    expect((audit.data['after'] as { status: string }).status).toBe('approved');
  });

  it('11. rejects with invalid_status when the invite is not in draft', async () => {
    tx.surveyInvite.findUnique.mockResolvedValue({ id: 'inv-1', status: 'sent' });
    await expect(approveInvite('inv-1', ACTOR)).rejects.toMatchObject({
      reason: 'invalid_status',
      status: 409,
    });
    expect(tx.surveyInvite.update).not.toHaveBeenCalled();
  });
});

// ── markInviteSent ──────────────────────────────────────────────────

describe('markInviteSent', () => {
  it('12. flips approved → sent and writes audit', async () => {
    tx.surveyInvite.findUnique.mockResolvedValue({ id: 'inv-1', status: 'approved' });
    tx.surveyInvite.update.mockResolvedValue({ id: 'inv-1', status: 'sent', sent_at: new Date() });

    await markInviteSent('inv-1', 202, ACTOR);

    const upd = callArg(tx.surveyInvite.update) as { data: Record<string, unknown> };
    expect(upd.data['status']).toBe('sent');
    expect(upd.data['last_status']).toBe(202);
    const audit = callArg(tx.auditLog.create) as { data: Record<string, unknown> };
    expect((audit.data['after'] as { status: string }).status).toBe('sent');
  });
});

// ── submitResponse ──────────────────────────────────────────────────

describe('submitResponse', () => {
  it('13. rejects with already_submitted when called twice', async () => {
    tx.surveyInvite.findUnique.mockResolvedValue({
      id: 'inv-1',
      status: 'submitted',
      submitted_at: new Date(),
      responses: [],
      questions: [],
    });
    await expect(submitResponse('inv-1', PUBLIC_ACTOR)).rejects.toMatchObject({
      reason: 'already_submitted',
      status: 409,
    });
  });

  it('14. rejects with invalid_input when a required question has no answer', async () => {
    tx.surveyInvite.findUnique.mockResolvedValue({
      id: 'inv-1',
      status: 'opened',
      submitted_at: null,
      responses: [], // no answer for the required question
      questions: [{ id: 'q1', is_required: true }],
    });
    await expect(submitResponse('inv-1', PUBLIC_ACTOR)).rejects.toMatchObject({
      reason: 'invalid_input',
      status: 422,
    });
    expect(tx.surveyResponse.updateMany).not.toHaveBeenCalled();
  });

  it('15. flips all responses is_draft to false on success', async () => {
    tx.surveyInvite.findUnique.mockResolvedValue({
      id: 'inv-1',
      status: 'opened',
      submitted_at: null,
      responses: [{ question_id: 'q1', answer_text: 'an answer', answer_json: null }],
      questions: [{ id: 'q1', is_required: true }],
    });
    tx.surveyInvite.update.mockResolvedValue({ id: 'inv-1', status: 'submitted', submitted_at: new Date() });

    await submitResponse('inv-1', PUBLIC_ACTOR);

    expect(tx.surveyResponse.updateMany).toHaveBeenCalledTimes(1);
    const upd = callArg(tx.surveyResponse.updateMany) as { data: { is_draft: boolean } };
    expect(upd.data.is_draft).toBe(false);
    const inviteUpd = callArg(tx.surveyInvite.update) as { data: { status: string } };
    expect(inviteUpd.data.status).toBe('submitted');
  });
});

// ── saveDraft ───────────────────────────────────────────────────────

describe('saveDraft', () => {
  it('16. is idempotent on (invite_id, question_id) via upsert', async () => {
    tx.surveyInvite.findUnique.mockResolvedValue({ id: 'inv-1', submitted_at: null });
    await saveDraft(
      'inv-1',
      [{ question_id: '11111111-1111-1111-1111-111111111111', answer_text: 'a' }],
      PUBLIC_ACTOR,
    );
    expect(tx.surveyResponse.upsert).toHaveBeenCalledTimes(1);
    const arg = callArg(tx.surveyResponse.upsert) as {
      where: { invite_id_question_id: { invite_id: string; question_id: string } };
    };
    expect(arg.where.invite_id_question_id.invite_id).toBe('inv-1');
    expect(arg.where.invite_id_question_id.question_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('17. rejects with already_submitted after submit', async () => {
    tx.surveyInvite.findUnique.mockResolvedValue({ id: 'inv-1', submitted_at: new Date() });
    await expect(
      saveDraft('inv-1', [{ question_id: 'q1', answer_text: 'a' }], PUBLIC_ACTOR),
    ).rejects.toMatchObject({ reason: 'already_submitted', status: 409 });
    expect(tx.surveyResponse.upsert).not.toHaveBeenCalled();
  });
});

// ── markInviteOpened ────────────────────────────────────────────────

describe('markInviteOpened', () => {
  it('18. flips sent → opened on first call, no-op on subsequent calls', async () => {
    tx.surveyInvite.findUnique.mockResolvedValueOnce({ id: 'inv-1', status: 'sent' });
    await markInviteOpened('inv-1', PUBLIC_ACTOR);
    expect(tx.surveyInvite.update).toHaveBeenCalledTimes(1);
    const upd = callArg(tx.surveyInvite.update) as { data: { status: string } };
    expect(upd.data.status).toBe('opened');

    // Second call: already opened → no update, no audit.
    vi.clearAllMocks();
    tx.surveyInvite.findUnique.mockResolvedValueOnce({ id: 'inv-1', status: 'opened' });
    await markInviteOpened('inv-1', PUBLIC_ACTOR);
    expect(tx.surveyInvite.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ── closeCampaign ───────────────────────────────────────────────────

describe('closeCampaign', () => {
  it('19. flips status to closed and writes audit; idempotent re-close throws invalid_status', async () => {
    tx.surveyCampaign.findUnique.mockResolvedValueOnce({ id: 'camp-1', status: 'open' });
    tx.surveyCampaign.update.mockResolvedValue({ id: 'camp-1', status: 'closed', closed_at: new Date() });

    await closeCampaign('camp-1', ACTOR);
    const upd = callArg(tx.surveyCampaign.update) as { data: { status: string } };
    expect(upd.data.status).toBe('closed');
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    // Re-close on an already-closed campaign throws.
    vi.clearAllMocks();
    tx.surveyCampaign.findUnique.mockResolvedValueOnce({ id: 'camp-1', status: 'closed' });
    await expect(closeCampaign('camp-1', ACTOR)).rejects.toMatchObject({
      reason: 'invalid_status',
      status: 409,
    });
    expect(tx.surveyCampaign.update).not.toHaveBeenCalled();
  });
});

// Sanity: SurveyCampaignError carries status.
describe('SurveyCampaignError', () => {
  it('defaults to status 422 and exposes the reason', () => {
    const e = new SurveyCampaignError('invalid_input');
    expect(e.status).toBe(422);
    expect(e.reason).toBe('invalid_input');
  });
});
