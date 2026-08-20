// ADR-0122 — the floor pager's contract, asserted against the real helper.
//
// `@/lib/ntfy` is NOT mocked here. The thing worth proving is that the ADR-0036
// headers and the ADR-0037 cooldown come out right at the wire, and a mocked
// publisher would only prove this file passes the arguments it passes. The one
// stub is `globalThis.fetch`, which is the same seam `ntfy.test.ts` uses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testing } from '@/lib/ntfy';
import { publishStageDeadEndAlert, __alertContract } from './dead-end-alert';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let calls: Call[];
const REASONS = {
  photo_capture: 'photo_present',
  photo_add_another: 'not_captured',
  bol_continue: 'no_photo',
} as const;

function alert(over: Partial<Parameters<typeof publishStageDeadEndAlert>[0]> = {}) {
  return publishStageDeadEndAlert({
    siteCode: 'woodland',
    loadId: 'abaf1aae',
    stage: 'bol',
    disableReasons: REASONS,
    ...over,
  });
}

beforeEach(() => {
  calls = [];
  __testing.clearCooldownLedger();
  __testing.setSleep(() => Promise.resolve());
  process.env['NTFY_PUBLISHER_TOKEN'] = 'tk_test_token_value';
  process.env['NTFY_BASE_URL'] = 'https://ntfy.example.invalid';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: String(init.body ?? ''),
      });
      return new Response('ok', { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __testing.resetSleep();
  __testing.clearCooldownLedger();
  delete process.env['NTFY_PUBLISHER_TOKEN'];
  delete process.env['NTFY_BASE_URL'];
});

describe('the ADR-0036 envelope', () => {
  it('publishes to dr3-vision-floor with the title, priority and tier-1 click', async () => {
    const res = await alert();
    expect(res).toEqual({ ok: true, outcome: 'sent' });
    expect(calls).toHaveLength(1);

    const [call] = calls;
    expect(call?.url).toBe('https://ntfy.example.invalid/dr3-vision-floor');
    // The `[DR3-Vision]` prefix is the helper's; writing it here too would double
    // it, which is the class of defect a hand-built title invites.
    expect(call?.headers['X-Title']).toBe(
      '[DR3-Vision] Operator trapped: bol has zero live controls',
    );
    expect(call?.headers['Priority']).toBe('high');
    // ADR-0036 tier 1: the record page. NOT the tier-3 `/status/dr3-vision`
    // default, which would land Bill on a dashboard that says the app is healthy
    // — which it was, all through the 2026-08-20 incident.
    expect(call?.headers['Click']).toBe(
      'https://dr3-vision.svdp.us/operator/woodland/load/abaf1aae',
    );
    expect(call?.headers['Authorization']).toBe('Bearer tk_test_token_value');
  });

  it('carries the disable-reason snapshot in the body', async () => {
    await alert();
    const body = calls[0]?.body ?? '';
    expect(body).toContain('Site: woodland');
    expect(body).toContain('Load: abaf1aae');
    expect(body).toContain('bol_continue=no_photo');
    expect(body).toContain('photo_capture=photo_present');
    expect(body).toContain('photo_add_another=not_captured');
  });

  it('never puts a reason snapshot in a header', async () => {
    // ADR-0093 — headers are a pure-ASCII bytestring and a runaway value there is
    // how a publish becomes a TypeError on every attempt and both transports.
    await alert();
    for (const [key, value] of Object.entries(calls[0]?.headers ?? {})) {
      if (key === 'Authorization') continue;
      expect(value).not.toContain('photo_present');
    }
  });

  it('a site or load id with a slash cannot escape the click path', async () => {
    await alert({ loadId: '../../admin', siteCode: 'a/b' });
    expect(calls[0]?.headers['Click']).toBe(
      'https://dr3-vision.svdp.us/operator/a%2Fb/load/..%2F..%2Fadmin',
    );
  });
});

describe('the ADR-0037 cooldown', () => {
  it('is 15 minutes, per (load, stage)', () => {
    expect(__alertContract.cooldownMs).toBe(15 * 60 * 1000);
  });

  it('suppresses a repeat for the same load and stage', async () => {
    expect((await alert()).outcome).toBe('sent');
    expect((await alert()).outcome).toBe('cooldown-suppressed');
    expect(calls).toHaveLength(1);
  });

  it('does NOT suppress a different stage of the same load', async () => {
    // A load that traps at stage 1 and again at stage 3 is two defects, and
    // folding them into one page would hide the second.
    expect((await alert({ stage: 'bol' })).outcome).toBe('sent');
    expect((await alert({ stage: 'door' })).outcome).toBe('sent');
    expect(calls).toHaveLength(2);
  });

  it('does NOT suppress a different load in the same stage', async () => {
    expect((await alert({ loadId: 'load-a' })).outcome).toBe('sent');
    expect((await alert({ loadId: 'load-b' })).outcome).toBe('sent');
    expect(calls).toHaveLength(2);
  });

  it('does NOT split on the operator — three takeovers of one trap is one page', async () => {
    // The 2026-08-20 shape exactly: three operators took H-137810 over in turn.
    // A per-user fingerprint would have paged three times for one defect, which
    // is how a real signal gets muted.
    for (let i = 0; i < 3; i++) await alert();
    expect(calls).toHaveLength(1);
  });

  it('fires again once the window expires', async () => {
    vi.useFakeTimers();
    try {
      expect((await alert()).outcome).toBe('sent');
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      const second = await alert();
      vi.useRealTimers();
      expect(second.outcome).toBe('sent');
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toHaveLength(2);
  });
});

describe('the fallback path exists', () => {
  it('dr3-vision-floor has a registered obscured fallback topic', () => {
    // A primary failure with no registered fallback is a DROPPED page — the
    // helper logs it and moves on. Registering the topic in `ntfy.ts` is half the
    // job; the other half is the row in noc-master's registry, which nothing at
    // runtime can check. See ADR-0122 §Consequences.
    const fb = __testing.fallbackTopicByPrimary[__alertContract.topic];
    expect(fb, 'no fallback topic registered for the floor pager').toBeDefined();
    expect(fb).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fb!.length).toBeLessThanOrEqual(64);
    expect(fb!.split('-').pop()).toMatch(/^[0-9a-f]{32,}$/);
  });

  it('falls through to ntfy.sh when the primary refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          headers: (init.headers ?? {}) as Record<string, string>,
          body: String(init.body ?? ''),
        });
        // A 403 is the shape that has masked itself as success on this fleet
        // before — the helper must treat it as a primary failure, not a send.
        if (url.startsWith('https://ntfy.example.invalid'))
          return new Response('', { status: 403 });
        return new Response('ok', { status: 200 });
      }),
    );
    const res = await alert();
    expect(res.outcome).toBe('fallback-sent');
    const last = calls.at(-1);
    expect(last?.url).toContain('https://ntfy.sh/');
    expect(last?.headers['X-Title']).toContain('[FALLBACK]');
    // Public ntfy.sh has no auth; sending the bearer there would leak it.
    expect(last?.headers['Authorization']).toBeUndefined();
  });
});

describe('fail-soft', () => {
  it('is a silent no-op when the publisher token is unset', async () => {
    delete process.env['NTFY_PUBLISHER_TOKEN'];
    const res = await alert();
    expect(res).toEqual({ ok: true, outcome: 'unconfigured' });
    expect(calls).toHaveLength(0);
  });
});
