import { describe, expect, it } from 'vitest';
import { makeFakePrisma, newFakeDb, type FakeApRequest } from '@/lib/ap/__testutils__/fake-prisma';

const base = (over: Partial<FakeApRequest>): FakeApRequest =>
  ({
    id: 'r', status: 'pending_second_approval', internet_message_id: 'm', conversation_id: null,
    received_at: new Date('2026-07-01T00:00:00Z'), sender_address: 'a@b', sender_validated: true,
    subject: null, body_html_sanitized: null, body_text: null, vendor: null, amount_cents: null,
    decided_by: null, decided_at: null, decision_note: null, decision_mail_sent_at: null,
    quarantine_reason: null, site_id: null, filed_not_dr3: false, decision_pdf_sha256: null,
    decision_pdf_r2_key: null, original_attachment_sha256: null, held_by: null, held_at: null,
    hold_note: null, ...over,
  }) as FakeApRequest;

describe('fake-prisma probe', () => {
  it('omitted vs explicit-null escalated_at', async () => {
    const db = newFakeDb({
      requests: [base({ id: 'omitted' }), base({ id: 'explicit', escalated_at: null })],
    });
    const p = makeFakePrisma(db);
    const rows = await p.apRequest.findMany({
      where: { status: 'pending_second_approval', escalated_at: null },
      select: { id: true, escalated_at: true },
    });
    console.log('SELECTED:', JSON.stringify(rows));
    console.log('typeof omitted.escalated_at =', typeof (rows[0] as any).escalated_at);
    console.log('typeof explicit.escalated_at =', typeof (rows[1] as any).escalated_at);
    expect(rows).toHaveLength(2);
  });

  it('unmodelled where keys are IGNORED, not applied', async () => {
    const db = newFakeDb({ requests: [base({ id: 'a', site_id: 's-w' }), base({ id: 'b', site_id: 's-e' })] });
    const p = makeFakePrisma(db);
    const rows = await p.apRequest.findMany({
      where: { status: 'pending_second_approval', site_id: 's-w', received_at: { gte: new Date('2030-01-01') } },
      select: { id: true },
    });
    console.log('site_id + received_at filter returned:', JSON.stringify(rows));
    expect(rows).toHaveLength(2); // both, i.e. the filters silently did nothing
  });

  it('updateMany without an id matches NOTHING', async () => {
    const db = newFakeDb({ requests: [base({ id: 'a' })] });
    const p = makeFakePrisma(db);
    const r = await p.apRequest.updateMany({ where: { status: 'pending_second_approval' }, data: { escalated_at: new Date() } });
    console.log('updateMany without id count =', r.count);
    expect(r.count).toBe(0);
  });
});
