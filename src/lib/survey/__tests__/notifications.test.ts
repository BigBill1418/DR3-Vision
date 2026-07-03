// ADR-0034 — invite email render + send tests (§14.3).
//
// sendSystemEmail is mocked so no network/Graph call fires. The render is a
// pure function; sendInvite must fail-soft (never throw) when M365 is disabled.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendSystemEmail = vi.fn();
vi.mock('@/lib/m365-mail', () => ({
  sendSystemEmail: (...a: unknown[]) => sendSystemEmail(...a),
}));

import {
  renderInviteHtml,
  renderReminderHtml,
  reminderSubject,
  sendInvite,
  sendReminder,
  type SendInviteArgs,
  type SendReminderArgs,
  type ReminderTier,
} from '../notifications';

const ARGS: SendInviteArgs = {
  campaign: {
    title: 'DR3 Intel',
    intro_text: 'Para one.\n\nPara <two> & more.',
    subject_template: 'Your input requested',
    from_address: 'dr3-vision@svdp.us',
    from_display_name: 'Bill Barnard via DR3-Vision',
    reply_to: 'bill.barnard@svdp.us',
  },
  invite: {
    recipient_name: 'Rick <Albritton>',
    recipient_email: 'rick@svdp.us',
    role_label: 'Eugene Manager',
    token: 'AbCd_-90AbCd_-90AbCd_-90AbCd_-90',
  },
  baseUrl: 'https://dr3-vision.svdp.us/',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('renderInviteHtml', () => {
  it('23. includes the survey URL ${baseUrl}/survey/${token}', () => {
    const html = renderInviteHtml(ARGS);
    expect(html).toContain('https://dr3-vision.svdp.us/survey/AbCd_-90AbCd_-90AbCd_-90AbCd_-90');
    // Trailing slash on baseUrl is normalized (no double slash).
    expect(html).not.toContain('svdp.us//survey');
  });

  it('24. HTML-escapes the recipient name and intro text', () => {
    const html = renderInviteHtml(ARGS);
    expect(html).toContain('Hi Rick &lt;Albritton&gt;,');
    expect(html).toContain('Para &lt;two&gt; &amp; more.');
    // The raw, unescaped form must not appear.
    expect(html).not.toContain('Rick <Albritton>,');
    expect(html).not.toContain('<two>');
  });

  it('25. uses the SVdP red #a3151a masthead color', () => {
    const html = renderInviteHtml(ARGS);
    expect(html).toContain('#a3151a');
    expect(html).toContain('#ffcc69'); // gold accent
    expect(html).toContain('#f7f3ea'); // cream
  });
});

describe('sendInvite', () => {
  it('26. returns delivered=false when M365 is disabled (does NOT throw)', async () => {
    sendSystemEmail.mockResolvedValue({
      delivered: false,
      disabled: true,
      messageId: 'req-1',
      retries: 0,
      lastStatus: undefined,
    });
    const r = await sendInvite(ARGS);
    expect(r.delivered).toBe(false);
    expect(r.last_status).toBeNull();
    expect(r.graph_message_id).toBeUndefined();
  });

  it('returns delivered=true with last_status on a successful send', async () => {
    sendSystemEmail.mockResolvedValue({
      delivered: true,
      disabled: false,
      messageId: 'req-2',
      retries: 0,
      lastStatus: 202,
    });
    const r = await sendInvite(ARGS);
    expect(r.delivered).toBe(true);
    expect(r.last_status).toBe(202);
    expect(r.graph_message_id).toBe('req-2');
    // The campaign sender identity drives the Graph call.
    const callArg = sendSystemEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg['fromDisplayName']).toBe('Bill Barnard via DR3-Vision');
    expect(callArg['replyTo']).toBe('bill.barnard@svdp.us');
  });

  it('fails soft (delivered=false) when sendSystemEmail throws', async () => {
    sendSystemEmail.mockRejectedValue(new Error('boom'));
    const r = await sendInvite(ARGS);
    expect(r.delivered).toBe(false);
  });
});

// ─── ADR-0036 — reminder render + send ─────────────────────────────────

function reminderArgs(tier: ReminderTier): SendReminderArgs {
  return {
    campaign: {
      intro_text: 'Original intro para.\n\nSecond para with the sign-off.',
      subject_template: 'Your input requested',
      from_address: 'dr3-vision@svdp.us',
      from_display_name: 'Bill Barnard via DR3-Vision',
      reply_to: 'bill.barnard@svdp.us',
    },
    invite: {
      recipient_name: 'Rick <Albritton>',
      recipient_email: 'rick@svdp.us',
      role_label: 'Eugene Manager',
      token: 'AbCd_-90AbCd_-90AbCd_-90AbCd_-90',
    },
    tier,
    baseUrl: 'https://dr3-vision.svdp.us/',
  };
}

describe('reminderSubject', () => {
  it('prefixes "Reminder:" for saved_progress and opened_no_answers', () => {
    expect(reminderSubject('saved_progress', 'Your input requested')).toBe(
      'Reminder: Your input requested',
    );
    expect(reminderSubject('opened_no_answers', 'Your input requested')).toBe(
      'Reminder: Your input requested',
    );
  });

  it('keeps the ORIGINAL subject (no prefix) for never_opened', () => {
    expect(reminderSubject('never_opened', 'Your input requested')).toBe('Your input requested');
  });
});

describe('renderReminderHtml', () => {
  it('shares the branded shell (masthead colors) and includes the token link, normalized', () => {
    const html = renderReminderHtml(reminderArgs('saved_progress'));
    expect(html).toContain('#a3151a'); // masthead
    expect(html).toContain('#ffcc69'); // gold accent
    expect(html).toContain('#f7f3ea'); // cream
    expect(html).toContain('https://dr3-vision.svdp.us/survey/AbCd_-90AbCd_-90AbCd_-90AbCd_-90');
    expect(html).not.toContain('svdp.us//survey');
    // Recipient name is HTML-escaped in the shared shell.
    expect(html).toContain('Hi Rick &lt;Albritton&gt;,');
  });

  it('tier saved_progress: "Finish your survey" button + Bill sign-off', () => {
    const html = renderReminderHtml(reminderArgs('saved_progress'));
    expect(html).toContain('>Finish your survey<');
    expect(html).toContain('progress is saved');
    expect(html).toContain('— Bill Barnard, Director of Operations');
  });

  it('tier opened_no_answers: "Open your survey" button + nudge + Bill sign-off', () => {
    const html = renderReminderHtml(reminderArgs('opened_no_answers'));
    expect(html).toContain('>Open your survey<');
    expect(html).toContain('save as you type');
    expect(html).toContain('— Bill Barnard, Director of Operations');
    // Not the finish-and-submit tier.
    expect(html).not.toContain('>Finish your survey<');
  });

  it('tier never_opened: resend line + the original intro, no injected sign-off', () => {
    const html = renderReminderHtml(reminderArgs('never_opened'));
    expect(html).toContain('>Open your survey<');
    expect(html).toContain('Resending this in case an earlier copy');
    expect(html).toContain('Original intro para.');
    // The intro carries its own sign-off; we do NOT append Bill's a/b sign-off.
    expect(html).not.toContain('— Bill Barnard, Director of Operations');
  });
});

describe('sendReminder', () => {
  it('sends with the tier subject + campaign sender identity on success', async () => {
    sendSystemEmail.mockResolvedValue({
      delivered: true,
      disabled: false,
      messageId: 'req-9',
      retries: 0,
      lastStatus: 202,
    });
    const r = await sendReminder(reminderArgs('saved_progress'));
    expect(r.delivered).toBe(true);
    expect(r.last_status).toBe(202);
    const callArg = sendSystemEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg['subject']).toBe('Reminder: Your input requested');
    expect(callArg['fromDisplayName']).toBe('Bill Barnard via DR3-Vision');
    expect(callArg['replyTo']).toBe('bill.barnard@svdp.us');
  });

  it('uses the ORIGINAL subject for the never_opened tier', async () => {
    sendSystemEmail.mockResolvedValue({
      delivered: true,
      disabled: false,
      messageId: 'req-10',
      retries: 0,
      lastStatus: 202,
    });
    await sendReminder(reminderArgs('never_opened'));
    const callArg = sendSystemEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg['subject']).toBe('Your input requested');
  });

  it('fails soft (delivered=false) when M365 is disabled and when it throws', async () => {
    sendSystemEmail.mockResolvedValue({ delivered: false, disabled: true });
    expect((await sendReminder(reminderArgs('opened_no_answers'))).delivered).toBe(false);
    sendSystemEmail.mockRejectedValue(new Error('boom'));
    expect((await sendReminder(reminderArgs('opened_no_answers'))).delivered).toBe(false);
  });
});
