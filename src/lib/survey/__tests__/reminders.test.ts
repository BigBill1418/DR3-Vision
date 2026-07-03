// ADR-0036 — survey daily-reminder + auto-close orchestration unit tests.
//
// DB-free: injects a small `db` double (only `surveyCampaign.findMany` +
// `surveyInvite.update` are exercised) cast `as unknown as PrismaClient`, and
// mocks the three collaborators — `sendReminder`, `closeCampaign`, `publishNtfy`
// — the same way the bonus escalation tests mock theirs. Drives the REAL
// `runSurveyReminderTick` and asserts candidate selection, the 20h gate (stamp
// only on success), tier classification, the auto-close predicate, and the ntfy
// fingerprint.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const sendReminder = vi.fn();
const closeCampaign = vi.fn();
const publishNtfy = vi.fn<(a: unknown) => Promise<{ ok: boolean; outcome: 'sent' }>>(async () => ({
  ok: true,
  outcome: 'sent' as const,
}));

vi.mock('@/lib/survey/notifications', () => ({
  sendReminder: (a: unknown) => sendReminder(a),
}));
vi.mock('@/lib/survey/campaigns', () => ({
  closeCampaign: (...a: unknown[]) => closeCampaign(...a),
}));
vi.mock('@/lib/ntfy', () => ({
  publishNtfy: (a: unknown) => publishNtfy(a),
}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runSurveyReminderTick } from '../reminders';

const NOW = new Date('2026-07-03T16:00:00Z'); // 09:00 PDT
const BASE = 'https://dr3-vision.svdp.us';

interface InviteSeed {
  id: string;
  status: string;
  last_reminder_at?: Date | null;
  reminder_count?: number;
  responses?: number;
}

function invite(seed: InviteSeed) {
  return {
    id: seed.id,
    status: seed.status,
    last_reminder_at: seed.last_reminder_at ?? null,
    reminder_count: seed.reminder_count ?? 0,
    recipient_name: `Name ${seed.id}`,
    recipient_email: `${seed.id}@svdp.us`,
    role_label: 'Role',
    token: `tok-${seed.id}`,
    _count: { responses: seed.responses ?? 0 },
  };
}

function campaign(id: string, invites: ReturnType<typeof invite>[]) {
  return {
    id,
    title: 'DR3 Operational Intelligence — June 2026',
    intro_text: 'Intro.',
    subject_template: 'Your input requested',
    from_address: 'dr3-vision@svdp.us',
    from_display_name: 'Bill Barnard via DR3-Vision',
    reply_to: 'bill.barnard@svdp.us',
    invites,
  };
}

let updateSpy: ReturnType<typeof vi.fn>;

function makeDb(campaigns: unknown[]): PrismaClient {
  updateSpy = vi.fn(async () => ({}));
  return {
    surveyCampaign: { findMany: vi.fn(async () => campaigns) },
    surveyInvite: { update: updateSpy },
  } as unknown as PrismaClient;
}

function run(campaigns: unknown[]) {
  return runSurveyReminderTick({ db: makeDb(campaigns), now: NOW, baseUrl: BASE });
}

beforeEach(() => {
  vi.clearAllMocks();
  sendReminder.mockResolvedValue({ delivered: true, last_status: 202, graph_message_id: 'g' });
  publishNtfy.mockResolvedValue({ ok: true, outcome: 'sent' });
});

describe('runSurveyReminderTick — no-op', () => {
  it('returns all-zero summary when no campaign is open', async () => {
    const summary = await run([]);
    expect(summary).toEqual({
      campaigns: 0,
      remindersSent: 0,
      remindersFailed: 0,
      remindersSkipped: 0,
      closed: [],
    });
    expect(sendReminder).not.toHaveBeenCalled();
    expect(closeCampaign).not.toHaveBeenCalled();
  });
});

describe('runSurveyReminderTick — candidate selection', () => {
  it('reminds only sent + opened invites; never draft/approved/submitted', async () => {
    const summary = await run([
      campaign('c1', [
        invite({ id: 'draft', status: 'draft' }),
        invite({ id: 'approved', status: 'approved' }),
        invite({ id: 'sent', status: 'sent' }),
        invite({ id: 'opened', status: 'opened', responses: 3 }),
        invite({ id: 'submitted', status: 'submitted' }),
      ]),
    ]);
    expect(sendReminder).toHaveBeenCalledTimes(2);
    const reminded = sendReminder.mock.calls.map(
      (c) => (c[0] as { invite: { token: string } }).invite.token,
    );
    expect(reminded.sort()).toEqual(['tok-opened', 'tok-sent']);
    expect(summary.remindersSent).toBe(2);
    expect(summary.remindersFailed).toBe(0);
    // Outstanding (approved/sent/opened) present → not closed.
    expect(summary.closed).toEqual([]);
    expect(closeCampaign).not.toHaveBeenCalled();
  });
});

describe('runSurveyReminderTick — 20h gate + stamp-on-success', () => {
  it('skips an invite reminded within the last 20h (no send, no stamp)', async () => {
    const recent = new Date(NOW.getTime() - 10 * 60 * 60 * 1000); // 10h ago
    const summary = await run([
      campaign('c1', [invite({ id: 'a', status: 'sent', last_reminder_at: recent })]),
    ]);
    expect(sendReminder).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(summary.remindersSkipped).toBe(1);
    expect(summary.remindersSent).toBe(0);
  });

  it('reminds an invite last reminded > 20h ago and stamps last_reminder_at + increments', async () => {
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000); // 25h ago
    const summary = await run([
      campaign('c1', [invite({ id: 'a', status: 'opened', responses: 0, last_reminder_at: old })]),
    ]);
    expect(sendReminder).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const arg = updateSpy.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where.id).toBe('a');
    expect(arg.data['last_reminder_at']).toBe(NOW);
    expect(arg.data['reminder_count']).toEqual({ increment: 1 });
    expect(summary.remindersSent).toBe(1);
  });

  it('does NOT stamp when the send fails (delivered=false) — retries next tick', async () => {
    sendReminder.mockResolvedValue({
      delivered: false,
      last_status: 500,
      graph_message_id: undefined,
    });
    const summary = await run([campaign('c1', [invite({ id: 'a', status: 'sent' })])]);
    expect(sendReminder).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(summary.remindersFailed).toBe(1);
    expect(summary.remindersSent).toBe(0);
  });

  it('never throws past an individual invite that throws (counts as failed)', async () => {
    sendReminder.mockRejectedValueOnce(new Error('graph boom'));
    sendReminder.mockResolvedValueOnce({
      delivered: true,
      last_status: 202,
      graph_message_id: 'g',
    });
    const summary = await run([
      campaign('c1', [invite({ id: 'a', status: 'sent' }), invite({ id: 'b', status: 'sent' })]),
    ]);
    expect(summary.remindersFailed).toBe(1);
    expect(summary.remindersSent).toBe(1);
  });
});

describe('runSurveyReminderTick — tier classification', () => {
  async function tierFor(seed: InviteSeed): Promise<string> {
    await run([campaign('c1', [invite(seed)])]);
    return (sendReminder.mock.calls[0]?.[0] as { tier: string }).tier;
  }

  it('opened + saved answers → saved_progress', async () => {
    expect(await tierFor({ id: 'a', status: 'opened', responses: 10 })).toBe('saved_progress');
  });
  it('opened + zero answers → opened_no_answers', async () => {
    expect(await tierFor({ id: 'a', status: 'opened', responses: 0 })).toBe('opened_no_answers');
  });
  it('sent (never opened) → never_opened', async () => {
    expect(await tierFor({ id: 'a', status: 'sent' })).toBe('never_opened');
  });
});

describe('runSurveyReminderTick — auto-close predicate', () => {
  it('closes when ≥1 submitted and zero approved/sent/opened; fires ntfy with the right fingerprint', async () => {
    const summary = await run([
      campaign('c1', [
        invite({ id: 's1', status: 'submitted' }),
        invite({ id: 's2', status: 'submitted' }),
      ]),
    ]);
    expect(closeCampaign).toHaveBeenCalledTimes(1);
    const [cid, actor] = closeCampaign.mock.calls[0] as [string, { actorLabel: string }];
    expect(cid).toBe('c1');
    expect(actor.actorLabel).toBe('system:survey-reminder-cron');
    expect(summary.closed).toEqual(['c1']);

    expect(publishNtfy).toHaveBeenCalledTimes(1);
    const n = publishNtfy.mock.calls[0]?.[0] as {
      topic: string;
      title: string;
      fingerprint: string;
      clickUrl: string;
      priority: string;
    };
    expect(n.topic).toBe('dr3-vision-system');
    expect(n.title).toBe('Survey campaign complete — auto-closed');
    expect(n.fingerprint).toBe('survey-campaign-autoclosed:c1');
    expect(n.clickUrl).toBe('https://dr3-vision.svdp.us/admin/operations/intel/c1');
    expect(n.priority).toBe('default');
  });

  it('a DRAFT invite does NOT block auto-close (un-sent operator exclusion)', async () => {
    const summary = await run([
      campaign('c1', [
        invite({ id: 's1', status: 'submitted' }),
        invite({ id: 'd1', status: 'draft' }),
      ]),
    ]);
    expect(closeCampaign).toHaveBeenCalledTimes(1);
    expect(summary.closed).toEqual(['c1']);
  });

  it('an APPROVED invite DOES block auto-close (approved-but-unsent respondent pending)', async () => {
    const summary = await run([
      campaign('c1', [
        invite({ id: 's1', status: 'submitted' }),
        invite({ id: 'a1', status: 'approved' }),
      ]),
    ]);
    expect(closeCampaign).not.toHaveBeenCalled();
    expect(publishNtfy).not.toHaveBeenCalled();
    expect(summary.closed).toEqual([]);
  });

  it('does NOT close a campaign with zero submissions', async () => {
    const summary = await run([campaign('c1', [invite({ id: 'd1', status: 'draft' })])]);
    expect(closeCampaign).not.toHaveBeenCalled();
    expect(summary.closed).toEqual([]);
  });
});
