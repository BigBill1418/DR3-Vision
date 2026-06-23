// ADR-0034 — invite email render + send tests (§14.3).
//
// sendSystemEmail is mocked so no network/Graph call fires. The render is a
// pure function; sendInvite must fail-soft (never throw) when M365 is disabled.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendSystemEmail = vi.fn();
vi.mock('@/lib/m365-mail', () => ({
  sendSystemEmail: (...a: unknown[]) => sendSystemEmail(...a),
}));

import { renderInviteHtml, sendInvite, type SendInviteArgs } from '../notifications';

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
