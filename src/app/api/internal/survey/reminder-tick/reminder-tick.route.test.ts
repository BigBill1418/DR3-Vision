// ADR-0036 — internal reminder-tick route guard test.
//
// Mirrors the escalation-check route test: the loopback/cf-connecting-ip guard
// and the optional INTERNAL_CRON_TOKEN bearer. `runSurveyReminderTick` is mocked
// so no DB/Graph/ntfy fires — we only assert the guard behavior and that the
// runner's summary is returned.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runSurveyReminderTick = vi.fn(async () => ({
  campaigns: 1,
  remindersSent: 2,
  remindersFailed: 0,
  remindersSkipped: 1,
  closed: [],
}));

vi.mock('@/lib/survey/reminders', () => ({
  runSurveyReminderTick: (...a: unknown[]) => runSurveyReminderTick(...(a as [])),
}));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/survey/reminder-tick', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  runSurveyReminderTick.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/survey/reminder-tick', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without running', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(runSurveyReminderTick).not.toHaveBeenCalled();
  });

  it('runs the tick and returns the summary (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      campaigns: 1,
      remindersSent: 2,
      remindersFailed: 0,
      remindersSkipped: 1,
      closed: [],
    });
    expect(runSurveyReminderTick).toHaveBeenCalledTimes(1);
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
    expect(runSurveyReminderTick).toHaveBeenCalledTimes(1); // only the valid call ran
  });
});
