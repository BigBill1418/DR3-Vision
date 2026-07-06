// ADR-0046 D1 — transport contract tests against the mock + the pure normalizers.
// Delta paging, token loss → resync, auth-fail, drift, and the full attachment
// taxonomy (file / one-level item / deeper / reference / unknown).

import { describe, expect, it } from 'vitest';
import { mockTransport } from './mock-transport';
import { DEFAULT_MOCK_FIXTURES } from './__fixtures__/messages';
import { normalizeAttachment, normalizeMessage, UnsupportedAttachmentError } from './normalize';
import { AuthFailedError, GraphContractDriftError } from './transport';

describe('mockTransport — delta contract', () => {
  it('lists the full fixture set from inbox (first poll = resync)', async () => {
    const t = mockTransport();
    const r = await t.listDelta('inbox', null);
    expect(r.resynced).toBe(true);
    expect(r.messages).toHaveLength(DEFAULT_MOCK_FIXTURES.length);
    expect(r.deltaToken).toBeTruthy();
  });

  it('aggregates across pages when pageSize < folder size (delta paging)', async () => {
    const t = mockTransport({ pageSize: 2 });
    const r = await t.listDelta('inbox', null);
    expect(r.messages).toHaveLength(DEFAULT_MOCK_FIXTURES.length);
    expect(t.lastPageCount).toBeGreaterThan(1);
  });

  it('token loss → full resync (resynced=true even with a token)', async () => {
    const t = mockTransport({ rejectDeltaToken: true });
    const r = await t.listDelta('inbox', 'some-old-token');
    expect(r.resynced).toBe(true);
    expect(r.messages.length).toBeGreaterThan(0);
  });

  it('auth failure throws AuthFailedError', async () => {
    const t = mockTransport({ failAuth: true });
    await expect(t.listDelta('inbox', null)).rejects.toBeInstanceOf(AuthFailedError);
  });

  it('drift throws GraphContractDriftError on the named op', async () => {
    await expect(mockTransport({ driftOn: 'listDelta' }).listDelta('inbox', null)).rejects.toBeInstanceOf(
      GraphContractDriftError,
    );
    await expect(mockTransport({ driftOn: 'getMessage' }).getMessage('msg-pdf-1')).rejects.toBeInstanceOf(
      GraphContractDriftError,
    );
  });

  it('moveMessage relocates the message so a re-poll of inbox cannot re-list it', async () => {
    const t = mockTransport();
    const first = await t.listDelta('inbox', null);
    const imid = first.messages[0]!.internetMessageId;
    await t.moveMessage(first.messages[0]!.id, 'Processed');
    expect(t.folderOf(imid)).toBe('Processed');
    const again = await t.listDelta('inbox', first.deltaToken);
    expect(again.messages.some((m) => m.internetMessageId === imid)).toBe(false);
  });

  it('self-reports mode = mock', () => {
    expect(mockTransport().mode).toBe('mock');
  });
});

describe('normalizeAttachment — full Graph taxonomy (C10.3)', () => {
  it('normalizes a fileAttachment', () => {
    const a = normalizeAttachment({
      '@odata.type': '#microsoft.graph.fileAttachment',
      id: 'a1',
      name: 'inv.pdf',
      contentType: 'application/pdf',
      size: 100,
      contentBytes: 'AAAA',
    });
    expect(a).toMatchObject({ kind: 'file', name: 'inv.pdf', contentType: 'application/pdf', size: 100 });
  });

  it('unwraps an itemAttachment ONE level (subject + its files)', () => {
    const a = normalizeAttachment({
      '@odata.type': '#microsoft.graph.itemAttachment',
      id: 'i1',
      name: 'fwd',
      item: {
        subject: 'inner',
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'f1', name: 'x.pdf' }],
      },
    });
    expect(a.kind).toBe('nested_message');
    if (a.kind === 'nested_message') {
      expect(a.nestedSubject).toBe('inner');
      expect(a.nestedFiles).toHaveLength(1);
      expect(a.hasDeeperNesting).toBe(false);
    }
  });

  it('marks deeper nesting (item within item) without recursing', () => {
    const a = normalizeAttachment({
      '@odata.type': '#microsoft.graph.itemAttachment',
      id: 'i1',
      item: { subject: 'outer', attachments: [{ '@odata.type': '#microsoft.graph.itemAttachment', id: 'i2' }] },
    });
    expect(a.kind).toBe('nested_message');
    if (a.kind === 'nested_message') {
      expect(a.hasDeeperNesting).toBe(true);
      expect(a.nestedFiles).toHaveLength(0);
    }
  });

  it('records a referenceAttachment link (never fetched)', () => {
    const a = normalizeAttachment({
      '@odata.type': '#microsoft.graph.referenceAttachment',
      id: 'r1',
      name: 'doc',
      sourceUrl: 'https://sharepoint.example/doc',
    });
    expect(a).toMatchObject({ kind: 'reference_link', sourceUrl: 'https://sharepoint.example/doc' });
  });

  it('throws UnsupportedAttachmentError for an unknown @odata.type', () => {
    expect(() => normalizeAttachment({ '@odata.type': '#microsoft.graph.somethingNew', id: 'z' })).toThrow(
      UnsupportedAttachmentError,
    );
  });
});

describe('normalizeMessage — authenticated sender (C10.4)', () => {
  it('lowercases the envelope from-address (the auth subject, never the display name)', () => {
    const m = normalizeMessage({
      id: 'm1',
      internetMessageId: '<x@svdp.us>',
      from: { emailAddress: { address: 'Morena@SVDP.us', name: 'Morena' } },
      subject: 'FW: vendor invoice from billing@vendor.example',
      body: { contentType: 'html', content: '<p>hi</p>' },
      receivedDateTime: '2026-07-06T00:00:00.000Z',
    });
    expect(m.from).toBe('morena@svdp.us');
    expect(m.fromName).toBe('Morena');
    expect(m.bodyHtml).toBe('<p>hi</p>');
  });
});
