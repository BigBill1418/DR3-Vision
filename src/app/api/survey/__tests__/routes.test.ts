// ADR-0034 — public survey route tests (§14.6).
//
// The token-shape validator is the REAL function (token IS the access — a
// malformed shape must 404 before any DB read). The campaign service is mocked
// so submit/draft error mapping is exercised without a database.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const getInviteByToken = vi.fn();
const saveDraft = vi.fn();
const submitResponse = vi.fn();
vi.mock('@/lib/survey/campaigns', () => {
  class SurveyCampaignError extends Error {
    readonly status: number;
    constructor(
      public readonly reason: string,
      statusCode = 422,
    ) {
      super(`survey-campaign: ${reason}`);
      this.name = 'SurveyCampaignError';
      this.status = statusCode;
    }
  }
  return {
    SurveyCampaignError,
    getInviteByToken: (...a: unknown[]) => getInviteByToken(...a),
    saveDraft: (...a: unknown[]) => saveDraft(...a),
    submitResponse: (...a: unknown[]) => submitResponse(...a),
  };
});

// headers() is read for ip/user-agent in the draft/submit routes.
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9', 'user-agent': 'vitest' }),
}));

import { SurveyCampaignError } from '@/lib/survey/campaigns';
import { GET } from '../[token]/route';
import { PUT } from '../[token]/draft/route';
import { POST } from '../[token]/submit/route';

const VALID_TOKEN = 'AbCd_-90AbCd_-90AbCd_-90AbCd_-90';
const QID = '11111111-1111-1111-1111-111111111111';

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

function putReq(body: unknown) {
  return new Request(`http://127.0.0.1:3000/api/survey/${VALID_TOKEN}/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/survey/:token', () => {
  it('34. returns 404 for malformed token shape', async () => {
    const res = await GET(new Request('http://127.0.0.1/api/survey/bad'), ctx('not-a-valid-token'));
    expect(res.status).toBe(404);
    expect(getInviteByToken).not.toHaveBeenCalled();
  });

  it('404 when the token is well-formed but no invite exists', async () => {
    getInviteByToken.mockResolvedValue(null);
    const res = await GET(new Request('http://127.0.0.1/api/survey/x'), ctx(VALID_TOKEN));
    expect(res.status).toBe(404);
  });

  it('200 returns the public payload (never echoes the token)', async () => {
    getInviteByToken.mockResolvedValue({
      id: 'inv-1',
      recipient_name: 'Rick',
      role_label: 'Eugene',
      status: 'sent',
      submitted_at: null,
      token: VALID_TOKEN,
      campaign: { title: 'T', intro_text: 'x', from_display_name: 'Bill', status: 'open' },
      questions: [],
      responses: [],
    });
    const res = await GET(new Request('http://127.0.0.1/api/survey/x'), ctx(VALID_TOKEN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(VALID_TOKEN);
    expect(body.invite.recipient_name).toBe('Rick');
  });
});

describe('PUT /api/survey/:token/draft', () => {
  it('35. returns 409 after submit', async () => {
    getInviteByToken.mockResolvedValue({ id: 'inv-1' });
    (saveDraft as Mock).mockRejectedValueOnce(new SurveyCampaignError('already_submitted', 409));
    const res = await PUT(
      putReq({ answers: [{ question_id: QID, answer_text: 'a' }] }),
      ctx(VALID_TOKEN),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('already_submitted');
  });

  it('422 on a malformed body (non-uuid question_id)', async () => {
    getInviteByToken.mockResolvedValue({ id: 'inv-1' });
    const res = await PUT(putReq({ answers: [{ question_id: 'not-a-uuid' }] }), ctx(VALID_TOKEN));
    expect(res.status).toBe(422);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('404 on malformed token before any DB read', async () => {
    const res = await PUT(putReq({ answers: [] }), ctx('bad'));
    expect(res.status).toBe(404);
    expect(getInviteByToken).not.toHaveBeenCalled();
  });

  // audit 2026-07-16 · CAPS — free-text / JSON length caps (storage-DoS boundary).
  it('422 when answer_text exceeds the 10k cap (before any DB write)', async () => {
    getInviteByToken.mockResolvedValue({ id: 'inv-1' });
    const res = await PUT(
      putReq({ answers: [{ question_id: QID, answer_text: 'x'.repeat(10_001) }] }),
      ctx(VALID_TOKEN),
    );
    expect(res.status).toBe(422);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('422 when answer_json exceeds the total byte ceiling (each element under the string cap)', async () => {
    getInviteByToken.mockResolvedValue({ id: 'inv-1' });
    // 500 short strings: each well under the 10k string cap and array within the
    // 500-element cap, but the total serialized size blows the 20k byte ceiling.
    const notes = Array.from({ length: 500 }, () => 'x'.repeat(60));
    const res = await PUT(
      putReq({ answers: [{ question_id: QID, answer_json: { notes } }] }),
      ctx(VALID_TOKEN),
    );
    expect(res.status).toBe(422);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('422 when answer_json is nested past the depth cap', async () => {
    getInviteByToken.mockResolvedValue({ id: 'inv-1' });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10; i++) deep = { n: deep };
    const res = await PUT(
      putReq({ answers: [{ question_id: QID, answer_json: deep }] }),
      ctx(VALID_TOKEN),
    );
    expect(res.status).toBe(422);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('200 for a small, well-formed answer_json (bounded schema still accepts real answers)', async () => {
    getInviteByToken.mockResolvedValue({ id: 'inv-1' });
    (saveDraft as Mock).mockResolvedValueOnce(undefined);
    const res = await PUT(
      putReq({ answers: [{ question_id: QID, answer_json: { choices: ['a', 'b'] } }] }),
      ctx(VALID_TOKEN),
    );
    expect(res.status).toBe(200);
    expect(saveDraft).toHaveBeenCalledOnce();
  });
});

describe('POST /api/survey/:token/submit', () => {
  it('36. is idempotent on already-submitted (returns 409 already_submitted)', async () => {
    getInviteByToken.mockResolvedValue({ id: 'inv-1' });
    (submitResponse as Mock).mockRejectedValueOnce(
      new SurveyCampaignError('already_submitted', 409),
    );
    const res = await POST(
      new Request(`http://127.0.0.1/api/survey/${VALID_TOKEN}/submit`, { method: 'POST' }),
      ctx(VALID_TOKEN),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('already_submitted');
  });

  it('200 + submitted_at on success', async () => {
    getInviteByToken.mockResolvedValue({ id: 'inv-1' });
    (submitResponse as Mock).mockResolvedValueOnce({
      submitted_at: new Date('2026-06-25T00:00:00Z'),
    });
    const res = await POST(
      new Request(`http://127.0.0.1/api/survey/${VALID_TOKEN}/submit`, { method: 'POST' }),
      ctx(VALID_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
