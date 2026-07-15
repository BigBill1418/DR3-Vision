// ADR-0046 D3/D5/C6 — poll orchestrator: counts, mode self-report, ledger ALWAYS
// (incl. throw paths + ledger-write failure), delta-token persistence, deadman.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApRequest,
  type FakeDb,
  type FakePollRun,
} from './__testutils__/fake-prisma';
import { AuthFailedError, mockTransport, type MailTransport } from '@/lib/msgraph-mail';
import { checkApDeadman, runApPoll } from './poll';

const publishNtfy = vi.fn(async () => ({ ok: true, outcome: 'sent' as const }));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/r2', () => ({ putApAttachment: vi.fn(async () => null) }));
vi.mock('@/lib/m365-mail', () => ({
  sendSystemEmail: vi.fn(async () => ({
    delivered: true,
    disabled: false,
    messageId: 'm',
    retries: 0,
    lastStatus: 202,
  })),
}));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (...a: unknown[]) => publishNtfy(...(a as [])) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}

/** A minimal already-ingested request, to seed the dup-skip pre-check. */
function seededRequest(internetMessageId: string): FakeApRequest {
  return {
    id: 'seed-req',
    status: 'pending',
    internet_message_id: internetMessageId,
    conversation_id: null,
    received_at: new Date('2026-07-06T00:00:00Z'),
    sender_address: 'morena@svdp.us',
    sender_validated: true,
    subject: 'already ingested',
    body_html_sanitized: '<p>full body</p>',
    body_text: 'full body',
    vendor: null,
    amount_cents: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    decision_mail_sent_at: null,
    quarantine_reason: null,
    site_id: null,
    decision_pdf_sha256: null,
    decision_pdf_r2_key: null,
    original_attachment_sha256: null,
    held_by: null,
    held_at: null,
    hold_note: null,
  };
}

beforeEach(() => {
  publishNtfy.mockClear();
  delete process.env['MSGRAPH_MAIL_TENANT_ID'];
});

describe('runApPoll — success', () => {
  it('processes the fixture mailbox: 5 created + 1 quarantined, moves all, writes an ok ledger row (mode=mock)', async () => {
    const db = newFakeDb();
    const res = await runApPoll({ prisma: fp(db), transport: mockTransport() });
    expect(res.status).toBe('ok');
    expect(res.transportMode).toBe('mock');
    expect(res.messagesListed).toBe(6);
    expect(res.requestsCreated).toBe(5);
    expect(res.quarantined).toBe(1);
    expect(res.moved).toBe(6);
    expect(res.resynced).toBe(true);
    // Ledger ALWAYS written (C6).
    expect(db.pollRuns).toHaveLength(1);
    expect(db.pollRuns[0]!.status).toBe('ok');
    expect(db.pollRuns[0]!.transport_mode).toBe('mock');
    // Delta token persisted for next poll.
    expect(db.deltaTokens).toHaveLength(1);
  });

  it('HYDRATES the full body via getMessage for each new message, persisting the sanitized body (not the preview)', async () => {
    const db = newFakeDb();
    const transport = mockTransport();
    const res = await runApPoll({ prisma: fp(db), transport });
    expect(res.status).toBe('ok');
    // getMessage is called once per new (non-duplicate) delta message. The delta
    // list is body-less (bodyPreview only), so SKIPPING this is exactly the defect
    // that shipped preview-only bodies — assert the hydration happened.
    expect(transport.getMessageCalls.length).toBe(res.messagesListed);
    // The PDF-invoice request stored the FULL hostile body (sanitized). That body
    // lives ONLY in the getMessage response — the delta projection had bodyHtml=null.
    const pdfReq = db.requests.find((r) => r.internet_message_id === '<pdf-invoice-1@svdp.us>')!;
    expect(pdfReq.body_html_sanitized).toContain('Acme Mattress Co');
    expect(pdfReq.body_html_sanitized?.toLowerCase()).not.toContain('<script');
  });

  it('a re-listed DUPLICATE is dup-checked WITHOUT a getMessage round-trip (no per-duplicate Graph call)', async () => {
    const db = newFakeDb({ requests: [seededRequest('<pdf-invoice-1@svdp.us>')] });
    const transport = mockTransport();
    const res = await runApPoll({ prisma: fp(db), transport });
    expect(res.duplicates).toBe(1);
    // The already-seen message is NOT hydrated (cheap DB check, no Graph round-trip)…
    expect(transport.getMessageCalls).not.toContain('msg-pdf-1');
    // …while every OTHER (new) message still is.
    expect(transport.getMessageCalls.length).toBe(res.messagesListed - 1);
  });
});

describe('runApPoll — poison message never stalls the delta token (defect: token-not-saved loop)', () => {
  it('an unexpected per-message failure (getMessage throw) quarantines as ingest_error; the run still saves its token', async () => {
    const db = newFakeDb();
    // driftOn:getMessage makes EVERY hydration throw — the worst case. Each message
    // must be quarantined (ingest_error) rather than aborting the loop before the
    // token save (which would re-fail the same message on the next poll forever).
    const transport = mockTransport({ driftOn: 'getMessage' });
    const res = await runApPoll({ prisma: fp(db), transport });
    expect(res.status).toBe('ok'); // the run completes cleanly…
    expect(res.quarantined).toBe(res.messagesListed); // …every message quarantined…
    expect(db.requests.every((r) => r.status === 'quarantined')).toBe(true);
    expect(db.requests.every((r) => r.quarantine_reason === 'ingest_error')).toBe(true);
    expect(db.deltaTokens).toHaveLength(1); // …and the token IS saved (loop didn't abort)
  });

  it('rethrows (token NOT saved) when the quarantine write itself fails — the message is re-listed, never lost', async () => {
    const db = newFakeDb();
    const prisma = fp(db);
    // Force BOTH the ingest path and the quarantine fallback to throw: every
    // apRequest.create blows up. The loop can neither ingest nor quarantine, so it
    // must rethrow — leaving the token unsaved so the message re-lists next poll.
    (prisma as unknown as { apRequest: { create: () => Promise<never> } }).apRequest.create =
      async () => {
        throw new Error('db down');
      };
    const transport = mockTransport();
    const res = await runApPoll({ prisma, transport });
    expect(res.status).toBe('error'); // the throw surfaced as a failed run
    expect(db.deltaTokens).toHaveLength(0); // token NOT saved — message is never silently lost
    expect(publishNtfy).toHaveBeenCalled(); // run-failure page fired
  });

  it('an AuthFailedError during hydration fails the run CLOSED (auth_failed) — never mass-quarantines the folder', async () => {
    const db = newFakeDb();
    const base = mockTransport();
    // A mid-run 401 on getMessage is a session-fatal error, NOT a per-message
    // poison: it must abort as auth_failed (and page), not quarantine every good
    // invoice in the folder while masking the auth outage.
    const transport = {
      ...base,
      getMessage: async () => {
        throw new AuthFailedError('mock: 401 mid-run on getMessage');
      },
    } as unknown as MailTransport;
    const res = await runApPoll({ prisma: fp(db), transport });
    expect(res.status).toBe('auth_failed');
    expect(db.requests).toHaveLength(0); // nothing quarantined
    expect(db.deltaTokens).toHaveLength(0); // token not saved
  });
});

describe('runApPoll — failure still writes the ledger + pages', () => {
  it('drift throw → status error, ledger row written, system page fired', async () => {
    const db = newFakeDb();
    const res = await runApPoll({
      prisma: fp(db),
      transport: mockTransport({ driftOn: 'listDelta' }),
    });
    expect(res.status).toBe('error');
    expect(res.error).toBeTruthy();
    expect(db.pollRuns).toHaveLength(1);
    expect(db.pollRuns[0]!.status).toBe('error');
    expect(publishNtfy).toHaveBeenCalled();
  });

  it('auth failure → status auth_failed, ledger row written', async () => {
    const db = newFakeDb();
    const res = await runApPoll({ prisma: fp(db), transport: mockTransport({ failAuth: true }) });
    expect(res.status).toBe('auth_failed');
    expect(db.pollRuns[0]!.status).toBe('auth_failed');
  });

  it('a ledger-write failure is swallowed (never throws to the caller)', async () => {
    const db = newFakeDb();
    const prisma = fp(db);
    (prisma as unknown as { apPollRun: { create: () => Promise<never> } }).apPollRun.create =
      async () => {
        throw new Error('ledger down');
      };
    const res = await runApPoll({ prisma, transport: mockTransport() });
    expect(res.status).toBe('ok'); // resolves despite the ledger write blowing up
  });
});

describe('checkApDeadman', () => {
  const okRun = (startedAt: Date): FakePollRun => ({
    id: 'r',
    status: 'ok',
    transport_mode: 'mock',
    started_at: startedAt,
    messages_listed: 0,
    requests_created: 0,
    quarantined: 0,
    error: null,
    run_id: null,
  });

  it('pages when the last ok run is older than the threshold', async () => {
    const db = newFakeDb({ pollRuns: [okRun(new Date('2026-07-06T00:00:00Z'))] });
    await checkApDeadman(fp(db), 45, new Date('2026-07-06T01:00:00Z')); // 60 min later
    expect(publishNtfy).toHaveBeenCalled();
  });

  it('does NOT page when the last ok run is fresh', async () => {
    const db = newFakeDb({ pollRuns: [okRun(new Date('2026-07-06T00:55:00Z'))] });
    await checkApDeadman(fp(db), 45, new Date('2026-07-06T01:00:00Z')); // 5 min later
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('does NOT page when there is no baseline ok run', async () => {
    const db = newFakeDb();
    await checkApDeadman(fp(db), 45, new Date());
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});
