// ADR-0046 D3 — per-message ingest: taxonomy matrix, quarantine (row id + domain
// ONLY), idempotency, follow-up threading vs new request, sanitize-at-ingest.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ingestMessage, type IngestContext, type IngestNotifier } from './ingest';
import type { SenderPolicy } from './senders';
import { mockTransport } from '@/lib/msgraph-mail';
import type { MailMessage } from '@/lib/msgraph-mail';
import { makeFakePrisma, newFakeDb, type FakeDb } from './__testutils__/fake-prisma';

vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
// R2 unconfigured in tests → placeholder key path (never touches network).
vi.mock('@/lib/r2', () => ({ putApAttachment: vi.fn(async () => null) }));

const policy: SenderPolicy = { mode: 'tenant_wide', internalDomain: 'svdp.us', explicitAllow: new Set() };

function makeCtx(db: FakeDb, notifier: IngestNotifier): IngestContext {
  return {
    prisma: makeFakePrisma(db) as unknown as PrismaClient,
    transport: mockTransport(),
    policy,
    approverEmails: [],
    notifier,
  };
}

function spyNotifier(): IngestNotifier & { quarantineCalls: unknown[]; newRequestCalls: unknown[] } {
  const quarantineCalls: unknown[] = [];
  const newRequestCalls: unknown[] = [];
  return {
    quarantineCalls,
    newRequestCalls,
    quarantine: vi.fn(async (a) => {
      quarantineCalls.push(a);
    }),
    newRequest: vi.fn(async (a) => {
      newRequestCalls.push(a);
    }),
  };
}

async function inboxMessages(): Promise<MailMessage[]> {
  return (await mockTransport().listDelta('inbox', null)).messages;
}

let messages: MailMessage[];
beforeEach(async () => {
  messages = await inboxMessages();
});

function byImid(imid: string): MailMessage {
  const m = messages.find((x) => x.internetMessageId === imid);
  if (!m) throw new Error(`fixture ${imid} missing`);
  return m;
}

describe('ingestMessage — taxonomy matrix (C10)', () => {
  it('PDF fileAttachment (internal) → created, body sanitized (no script), 1 file attachment', async () => {
    const db = newFakeDb();
    const n = spyNotifier();
    const out = await ingestMessage(makeCtx(db, n), byImid('<pdf-invoice-1@svdp.us>'));
    expect(out.kind).toBe('created');
    const req = db.requests[0]!;
    expect(req.status).toBe('pending');
    expect(req.sender_validated).toBe(true);
    expect(req.body_html_sanitized?.toLowerCase()).not.toContain('<script');
    expect(req.body_html_sanitized).toContain('Acme Mattress Co');
    const files = db.attachments.filter((a) => a.request_id === req.id && a.kind === 'file');
    expect(files).toHaveLength(1);
    expect(files[0]!.storage_key).toMatch(/^pending-r2-ap-/); // R2 unconfigured → placeholder
    expect(n.newRequestCalls).toHaveLength(1);
  });

  it('bare forward (no attachment) → created, 0 attachments, fully approvable', async () => {
    const db = newFakeDb();
    const out = await ingestMessage(makeCtx(db, spyNotifier()), byImid('<bare-forward-1@svdp.us>'));
    expect(out.kind).toBe('created');
    expect(db.attachments).toHaveLength(0);
    expect(db.requests[0]!.status).toBe('pending');
  });

  it('one-level itemAttachment → created, a nested_message marker + its unwrapped file', async () => {
    const db = newFakeDb();
    const out = await ingestMessage(makeCtx(db, spyNotifier()), byImid('<nested-forward-1@svdp.us>'));
    expect(out.kind).toBe('created');
    const kinds = db.attachments.map((a) => a.kind).sort();
    expect(kinds).toEqual(['file', 'nested_message']);
  });

  it('deeper nesting → nested_message marker notes further nesting, not recursed', async () => {
    const db = newFakeDb();
    await ingestMessage(makeCtx(db, spyNotifier()), byImid('<deep-nested-1@svdp.us>'));
    const nested = db.attachments.find((a) => a.kind === 'nested_message')!;
    expect(nested.nested_subject).toContain('further nested');
    expect(db.attachments.filter((a) => a.kind === 'file')).toHaveLength(0);
  });

  it('referenceAttachment → recorded with link_url, NEVER fetched', async () => {
    const db = newFakeDb();
    await ingestMessage(makeCtx(db, spyNotifier()), byImid('<reference-link-1@svdp.us>'));
    const ref = db.attachments.find((a) => a.kind === 'reference_link')!;
    expect(ref.link_url).toContain('sharepoint');
    expect(db.attachments.filter((a) => a.kind === 'file')).toHaveLength(0);
  });
});

describe('ingestMessage — quarantine (C3/C9-D4)', () => {
  it('external sender → quarantined, unapprovable, notify carries ONLY requestId + domain + reason', async () => {
    const db = newFakeDb();
    const n = spyNotifier();
    const out = await ingestMessage(makeCtx(db, n), byImid('<external-sender-1@vendor.example>'));
    expect(out.kind).toBe('quarantined');
    expect(out.reason).toBe('external_sender');
    const req = db.requests[0]!;
    expect(req.status).toBe('quarantined');
    expect(req.sender_validated).toBe(false);
    // No attachments downloaded from an untrusted sender.
    expect(db.attachments).toHaveLength(0);
    // PII discipline: the notification payload is row id + domain + reason ONLY.
    expect(n.quarantineCalls).toHaveLength(1);
    const call = n.quarantineCalls[0] as Record<string, unknown>;
    expect(Object.keys(call).sort()).toEqual(['reason', 'requestId', 'senderDomain']);
    expect(call['senderDomain']).toBe('vendor.example');
    expect(JSON.stringify(call)).not.toContain('Wire $9,900'); // no body content leaks
  });
});

describe('ingestMessage — idempotency + follow-ups (C4)', () => {
  it('re-ingesting the same message is a duplicate (internet_message_id UNIQUE)', async () => {
    const db = newFakeDb();
    const msg = byImid('<pdf-invoice-1@svdp.us>');
    expect((await ingestMessage(makeCtx(db, spyNotifier()), msg)).kind).toBe('created');
    expect((await ingestMessage(makeCtx(db, spyNotifier()), msg)).kind).toBe('duplicate');
    expect(db.requests).toHaveLength(1);
  });

  it('a same-conversation message while a request is OPEN → follow-up, never a second request', async () => {
    const db = newFakeDb({
      requests: [
        {
          id: 'req-open',
          status: 'pending',
          internet_message_id: '<orig@svdp.us>',
          conversation_id: 'conv-thread',
          received_at: new Date('2026-07-06T10:00:00Z'),
          sender_address: 'morena@svdp.us',
          sender_validated: true,
          subject: 'orig',
          body_html_sanitized: null,
          body_text: null,
          vendor: null,
          amount_cents: null,
          decided_by: null,
          decided_at: null,
          decision_note: null,
          decision_mail_sent_at: null,
          quarantine_reason: null,
          site_id: null,
          decision_pdf_sha256: null,
        },
      ],
    });
    const followup: MailMessage = {
      id: 'msg-fu',
      internetMessageId: '<fu-1@svdp.us>',
      conversationId: 'conv-thread',
      receivedDateTime: '2026-07-06T11:00:00.000Z',
      from: 'morena@svdp.us',
      fromName: 'Morena',
      subject: 'RE: orig',
      bodyHtml: '<p>one more note</p>',
      bodyText: 'one more note',
      hasAttachments: false,
    };
    const out = await ingestMessage(makeCtx(db, spyNotifier()), followup);
    expect(out.kind).toBe('followup');
    expect(out.requestId).toBe('req-open');
    expect(db.requests).toHaveLength(1); // no new request
    expect(db.followups).toHaveLength(1);
  });
});
