// ADR-0132 — the stamped ORIGINAL invoice rides every AP decision email.
//
// The defect these tests exist to keep fixed: `stampOneOriginal` dispatched the
// stamp renderer on a strict `content_type === 'application/pdf'`, so the 15
// production PDFs that a sending mail client labelled `application/octet-stream`
// fell to a one-page cover sheet and accounting received a decision notice with
// NO invoice (9 requests, 2026-07-27 → 2026-09-09).
//
// D7 — every case here asserts the bytes handed to the TRANSPORT contain the
// original document, never that a content type appears in an accepted-types list.
// A type-table pin would stay green forever while the attachment regressed, which
// is exactly how this defect survived seven weeks behind a working preview.
//
// The stamp module is mocked (no Chromium, no pdf-lib) but the mocks ECHO the
// bytes they were handed into the artifact they return, so "the delivered
// attachment contains the original document" is a literal assertion about what
// flowed through the real dispatch — not a stand-in for it. The R2 bytes are real
// magic-byte prefixes, so the ADR-0132 D3 sniff runs for real.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApApprover,
  type FakeApAttachment,
  type FakeApRequest,
  type FakeDb,
  type FakeUser,
} from './__testutils__/fake-prisma';
import { decideRequest } from './approvals';
import { DECISION_MAIL_GRACE_MS, isDecisionMailStuck, isDecisionMailUnsent } from './decision-mail';

const writeAudit = vi.fn();
const sendSystemEmail = vi.fn(async () => ({
  delivered: true,
  disabled: false,
  messageId: 'm',
  retries: 0,
  lastStatus: 202,
}));
const publishNtfy = vi.fn(async (args: unknown) => {
  void args;
  return { ok: true, outcome: 'sent' as const };
});
const notifyStaffSpy = vi.fn();

const stamp = vi.hoisted(() => ({
  // The cover page carries none of the invoice — that is the whole point of it.
  stampApproval: vi.fn(async () => ({
    pdf: Buffer.from('%PDF-cover-page-only'),
    sha256: 'coversha',
  })),
  // The two true-overlay renderers embed the original document. The mocks echo the
  // bytes so a delivered-bytes assertion means what it says.
  stampOntoOriginalPdf: vi.fn(async (bytes: Uint8Array) => ({
    pdf: Buffer.concat([Buffer.from('%PDF-overlay:'), Buffer.from(bytes)]),
    sha256: 'pdfsha',
  })),
  stampImage: vi.fn(async (_input: unknown, bytes: Uint8Array, contentType: string) => {
    void contentType;
    return {
      pdf: Buffer.concat([Buffer.from('%PDF-image:'), Buffer.from(bytes)]),
      sha256: 'imgsha',
    };
  }),
}));
const r2 = vi.hoisted(() => ({
  getApAttachmentBytes: vi.fn(async (): Promise<Uint8Array | null> => null),
  putApDecisionPdf: vi.fn(async (): Promise<string | null> => 'ap/x/decision/y.pdf'),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: () => sendSystemEmail() }));
vi.mock('./stamp', () => stamp);
vi.mock('@/lib/r2', () => r2);
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: async (args: { recipients: ReadonlyArray<string | { address: string }> }) => {
    notifyStaffSpy(args);
    const recips = args.recipients.map((r) => (typeof r === 'string' ? r : r.address));
    const sends = [] as Array<{ delivered: boolean; disabled: boolean }>;
    for (let i = 0; i < recips.length; i++) {
      sends.push((await sendSystemEmail()) as { delivered: boolean; disabled: boolean });
    }
    return {
      mode: 'live' as const,
      disabled: false,
      delivered: sends.filter((s) => s.delivered).length,
      actualRecipients: recips,
      intendedRecipients: recips,
      sends,
      surfaceCode: 'ap_notify',
      siteId: null,
    };
  },
}));
vi.mock('@/lib/notify/rollout', () => ({ NOTIFY_SURFACE: { AP_NOTIFY: 'ap_notify' } }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (a: unknown) => publishNtfy(a) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Real signatures, so the D3 sniff is exercised rather than simulated ──────
function withMagic(head: number[], tail: string): Uint8Array {
  return Uint8Array.from([...head, ...new TextEncoder().encode(tail)]);
}
const PDF_BYTES = withMagic([0x25, 0x50, 0x44, 0x46, 0x2d], '1.4 Ramos Oil invoice IN-0320844');
const JPEG_BYTES = withMagic([0xff, 0xd8, 0xff, 0xe0], 'JFIF scanned invoice');
const PNG_BYTES = withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR scan');
const CSV_BYTES = new TextEncoder().encode('date,vendor,amount\n2026-09-15,Ramos Oil,441.00\n');
const ZIP_BYTES = withMagic([0x50, 0x4b, 0x03, 0x04], 'word/document.xml');

const users: FakeUser[] = [
  {
    id: 'u-morena',
    name: 'Morena',
    email: 'morena@svdp.us',
    role: 'manager',
    all_sites: true,
    is_active: true,
  },
];
const approvers: FakeApApprover[] = [
  { id: 'ap-morena', user_id: 'u-morena', active_until: null, created_by: null },
];
const recips = [{ email: 'mary@svdp.us', active: true }];

function pendingReq(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-1',
    status: 'pending',
    internet_message_id: '<x@svdp.us>',
    conversation_id: null,
    received_at: new Date(),
    sender_address: 'morena@svdp.us',
    sender_validated: true,
    subject: 'Invoice #4471',
    body_html_sanitized: '<p>Please see the attached invoice.</p>',
    body_text: 'Please see the attached invoice.',
    vendor: null,
    amount_cents: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    decision_mail_sent_at: null,
    decision_mail_filed_out_of_band_at: null,
    quarantine_reason: null,
    site_id: null,
    filed_not_dr3: false,
    decision_pdf_sha256: null,
    decision_pdf_r2_key: null,
    original_attachment_sha256: null,
    held_by: null,
    held_at: null,
    hold_note: null,
    ...over,
  };
}

function fileAtt(over: Partial<FakeApAttachment> = {}): FakeApAttachment {
  return {
    id: 'att-a',
    request_id: 'req-1',
    kind: 'file',
    filename: 'invoice.pdf',
    content_type: 'application/pdf',
    byte_size: 120_000,
    storage_key: 'ap/req-1/att-a/invoice.pdf',
    link_url: null,
    nested_subject: null,
    ...over,
  };
}

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}

type MailAttachment = { filename: string; buffer: Buffer; contentType?: string };
function deliveredAttachments(): MailAttachment[] {
  const args = notifyStaffSpy.mock.calls[0]?.[0] as { attachments?: MailAttachment[] } | undefined;
  return args?.attachments ?? [];
}
/** Do the bytes the transport was handed contain this exact document? (D7) */
function deliveredCarries(original: Uint8Array): boolean {
  return deliveredAttachments().some((a) => a.buffer.includes(Buffer.from(original)));
}

async function decideWith(attachments: FakeApAttachment[], bytes: Uint8Array | null, db?: FakeDb) {
  r2.getApAttachmentBytes.mockResolvedValue(bytes);
  const fake =
    db ??
    newFakeDb({
      requests: [pendingReq()],
      users,
      approvers,
      decisionRecipients: recips,
      attachments,
    });
  const res = await decideRequest({
    prisma: fp(fake),
    requestId: 'req-1',
    decision: 'approved',
    actorUserId: 'u-morena',
    siteId: 'site-w',
  });
  return { res, db: fake };
}

beforeEach(() => {
  writeAudit.mockClear();
  sendSystemEmail.mockClear();
  publishNtfy.mockClear();
  notifyStaffSpy.mockClear();
  stamp.stampApproval.mockClear();
  stamp.stampOntoOriginalPdf.mockClear();
  stamp.stampImage.mockClear();
  r2.getApAttachmentBytes.mockReset();
  r2.getApAttachmentBytes.mockResolvedValue(null);
  r2.putApDecisionPdf.mockReset();
  r2.putApDecisionPdf.mockResolvedValue('ap/x/decision/y.pdf');
});

describe('ADR-0132 D7 — every production attachment shape delivers the original document', () => {
  const cases: Array<{
    label: string;
    content_type: string | null;
    filename: string;
    bytes: Uint8Array;
    overlaid: boolean;
  }> = [
    {
      label: 'application/pdf (155 rows)',
      content_type: 'application/pdf',
      filename: 'invoice.pdf',
      bytes: PDF_BYTES,
      overlaid: true,
    },
    {
      label: 'application/pdf; name="x.pdf" (parameterized — not yet seen, but will be)',
      content_type: 'application/pdf; name="Invoice # 117075.pdf"',
      filename: 'Invoice # 117075.pdf',
      bytes: PDF_BYTES,
      overlaid: true,
    },
    {
      label: 'application/octet-stream + .PDF (15 rows — THE DEFECT)',
      content_type: 'application/octet-stream',
      filename: 'Invoice_IN-0320844.PDF',
      bytes: PDF_BYTES,
      overlaid: true,
    },
    {
      label: 'image/jpeg (116 rows)',
      content_type: 'image/jpeg',
      filename: 'scan.jpg',
      bytes: JPEG_BYTES,
      overlaid: true,
    },
    {
      label: 'image/png (48 rows)',
      content_type: 'image/png',
      filename: 'scan.png',
      bytes: PNG_BYTES,
      overlaid: true,
    },
    {
      label: 'text/csv (8 rows — cover page + the original beside it)',
      content_type: 'text/csv',
      filename: 'ledger.csv',
      bytes: CSV_BYTES,
      overlaid: false,
    },
    {
      label: 'unknown binary (a mislabelled Office file)',
      content_type: 'application/octet-stream',
      filename: 'statement.docx',
      bytes: ZIP_BYTES,
      overlaid: false,
    },
  ];

  for (const c of cases) {
    it(`${c.label} → the mail carries the original document's bytes`, async () => {
      const { res } = await decideWith(
        [fileAtt({ content_type: c.content_type, filename: c.filename, byte_size: 250_000 })],
        c.bytes,
      );
      expect(res.mail).toBe('sent');
      expect(deliveredCarries(c.bytes)).toBe(true);
      if (c.overlaid) {
        // A true overlay: one attachment, and the cover page was never rendered.
        expect(deliveredAttachments()).toHaveLength(1);
        expect(stamp.stampApproval).not.toHaveBeenCalled();
      } else {
        // D4 — a cover page never travels alone.
        expect(deliveredAttachments()).toHaveLength(2);
        expect(stamp.stampApproval).toHaveBeenCalledTimes(1);
      }
    });
  }
});

describe('ADR-0132 D2/D3 — the dispatch reads the bytes, then the shared predicate', () => {
  it('REGRESSION PIN (the exact shape of the 9): octet-stream .PDF + a sub-50 KB image001.jpg ⇒ ONE attachment, a true PDF overlay, not a cover page', async () => {
    const { res, db } = await decideWith(
      [
        fileAtt({
          id: 'att-inv',
          filename: 'Invoice_IN-0312251.PDF',
          content_type: 'application/octet-stream',
          byte_size: 98_755,
          storage_key: 'ap/req-1/att-inv/Invoice_IN-0312251.PDF',
        }),
        // The Outlook signature logo that rode all nine of them.
        fileAtt({
          id: 'att-sig',
          filename: 'image001.jpg',
          content_type: 'image/jpeg',
          byte_size: 4_210,
          storage_key: 'ap/req-1/att-sig/image001.jpg',
        }),
      ],
      PDF_BYTES,
    );
    expect(res.mail).toBe('sent');
    expect(stamp.stampOntoOriginalPdf).toHaveBeenCalledTimes(1);
    expect(stamp.stampApproval).not.toHaveBeenCalled();
    expect(deliveredAttachments()).toHaveLength(1);
    expect(deliveredCarries(PDF_BYTES)).toBe(true);
    expect(db.requests[0]!.decision_pdf_sha256).toBe('pdfsha');
  });

  it('the BYTES outrank a confident wrong label: JPEG bytes stored as application/pdf take the image path', async () => {
    const { res } = await decideWith(
      [fileAtt({ filename: 'invoice.pdf', content_type: 'application/pdf', byte_size: 300_000 })],
      JPEG_BYTES,
    );
    expect(res.mail).toBe('sent');
    expect(stamp.stampImage).toHaveBeenCalledTimes(1);
    expect(stamp.stampOntoOriginalPdf).not.toHaveBeenCalled();
    expect(deliveredCarries(JPEG_BYTES)).toBe(true);
  });

  it('stampImage receives the CANONICAL type, not the stored one (image/jpg → image/jpeg)', async () => {
    await decideWith(
      [fileAtt({ filename: 'scan.jpg', content_type: 'image/jpg', byte_size: 300_000 })],
      JPEG_BYTES,
    );
    expect(stamp.stampImage.mock.calls[0]![2]).toBe('image/jpeg');
  });

  it('the inline-image filter survives a padded/parameterized type ( image/jpeg; name="sig.jpg")', async () => {
    const { res } = await decideWith(
      [
        fileAtt({
          id: 'att-inv',
          filename: 'invoice.pdf',
          content_type: 'application/pdf',
          byte_size: 120_000,
          storage_key: 'ap/req-1/att-inv/invoice.pdf',
        }),
        fileAtt({
          id: 'att-sig',
          filename: 'sig.jpg',
          // A header value the old `.toLowerCase()` filter did not recognize as an
          // image at all, so the signature logo would have been stamped and mailed
          // as if it were a second invoice.
          content_type: ' image/jpeg; name="sig.jpg"',
          byte_size: 6_000,
          storage_key: 'ap/req-1/att-sig/sig.jpg',
        }),
      ],
      PDF_BYTES,
    );
    expect(res.mail).toBe('sent');
    expect(deliveredAttachments()).toHaveLength(1); // the logo was filtered, not stamped
    expect(stamp.stampImage).not.toHaveBeenCalled();
  });
});

describe('ADR-0132 D4 — a cover page never travels alone', () => {
  it('a CSV original: the cover AND the byte-identical original are both attached, with its own content type', async () => {
    const { res } = await decideWith(
      [
        fileAtt({
          filename: 'ledger.csv',
          content_type: 'text/csv',
          byte_size: 2_400,
          storage_key: 'ap/req-1/att-a/ledger.csv',
        }),
      ],
      CSV_BYTES,
    );
    expect(res.mail).toBe('sent');
    const atts = deliveredAttachments();
    expect(atts).toHaveLength(2);
    const cover = atts.find((a) => a.filename.endsWith('.pdf'))!;
    const original = atts.find((a) => a.filename === 'ledger.csv')!;
    expect(cover.contentType).toBe('application/pdf');
    expect(original.contentType).toBe('text/csv');
    // Byte-identical: the vendor's own file, untouched.
    expect(Buffer.compare(original.buffer, Buffer.from(CSV_BYTES))).toBe(0);
  });

  it('an unknown binary gets its CORRECTED content type, not the stored octet-stream', async () => {
    await decideWith(
      [
        fileAtt({
          filename: 'scan.bin',
          content_type: null,
          byte_size: 400_000,
          storage_key: 'ap/req-1/att-a/scan.bin',
        }),
      ],
      ZIP_BYTES,
    );
    const original = deliveredAttachments().find((a) => a.filename === 'scan.bin')!;
    expect(original.contentType).toBe('application/octet-stream');
    expect(Buffer.compare(original.buffer, Buffer.from(ZIP_BYTES))).toBe(0);
  });

  it('a hostile filename cannot ride out as-is: path segments and control characters are stripped', async () => {
    // `filename` is the same untrusted, sender-written field the content type came
    // from, and it becomes the name a recipient's mail client offers to save.
    await decideWith(
      [
        fileAtt({
          filename: '../../..\\Startup\\ledger\r\n.csv',
          content_type: 'text/csv',
          byte_size: 2_400,
          storage_key: 'ap/req-1/att-a/x.csv',
        }),
      ],
      CSV_BYTES,
    );
    const names = deliveredAttachments().map((a) => a.filename);
    // No path separators and no control characters in ANY part — neither the cover
    // (`stampedAttachmentName`, which already did this) nor the original (new).
    expect(names.some((n) => /[\\/\r\n\t]/.test(n))).toBe(false);
    expect(names).toContain('ledger__.csv');
  });

  it('an overlay that THROWS still delivers the original beside the cover', async () => {
    stamp.stampOntoOriginalPdf.mockRejectedValueOnce(new Error('pdf-lib: corrupt xref'));
    const { res } = await decideWith([fileAtt({ byte_size: 120_000 })], PDF_BYTES);
    expect(res.mail).toBe('sent');
    expect(deliveredAttachments()).toHaveLength(2);
    expect(deliveredCarries(PDF_BYTES)).toBe(true);
  });

  it('a cover and its original never collide in the MIME part list', async () => {
    // Two CSVs sharing one name: 4 parts, 4 distinct filenames.
    const { res } = await decideWith(
      [
        fileAtt({
          id: 'att-a',
          filename: 'ledger.csv',
          content_type: 'text/csv',
          byte_size: 2_400,
          storage_key: 'ap/req-1/att-a/ledger.csv',
        }),
        fileAtt({
          id: 'att-b',
          filename: 'ledger.csv',
          content_type: 'text/csv',
          byte_size: 2_400,
          storage_key: 'ap/req-1/att-b/ledger.csv',
        }),
      ],
      CSV_BYTES,
    );
    expect(res.mail).toBe('sent');
    const names = deliveredAttachments().map((a) => a.filename);
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    expect(names).toContain('ledger.csv');
    expect(names).toContain('ledger-2.csv'); // extension preserved on the de-dupe
  });
});

describe('ADR-0132 D5 — if the original cannot be attached, the mail does not go', () => {
  it('R2 cannot serve the original: NOTHING is sent, the outcome is refused_no_original, the stamp stays NULL', async () => {
    const { res, db } = await decideWith([fileAtt()], null);
    expect(res.mail).toBe('refused_no_original');
    expect(notifyStaffSpy).not.toHaveBeenCalled(); // no decision notice left the building
    expect(sendSystemEmail).not.toHaveBeenCalled();
    const row = db.requests[0]!;
    expect(row.status).toBe('approved'); // the DECISION still stands
    expect(row.decision_mail_sent_at).toBeNull();
  });

  it('the refusal pages at the ADR-0037 grade, per request, with no vendor/amount/filename in the body', async () => {
    await decideWith(
      [fileAtt({ filename: 'Ramos-Oil-Invoice_IN-0320844.PDF' })],
      null,
      newFakeDb({
        requests: [pendingReq({ vendor: 'Ramos Oil', amount_cents: 44_100 })],
        users,
        approvers,
        decisionRecipients: recips,
        attachments: [fileAtt({ filename: 'Ramos-Oil-Invoice_IN-0320844.PDF' })],
      }),
    );
    const page = publishNtfy.mock.calls.at(-1)![0] as {
      topic: string;
      priority: string;
      tags: string[];
      clickUrl: string;
      fingerprint: string;
      cooldownMs: number;
      body: string;
    };
    expect(page.topic).toBe('dr3-vision-system');
    expect(page.priority).toBe('high'); // not urgent — ADR-0037 rubric, see D5
    expect(page.tags).toEqual(expect.arrayContaining(['error', 'ap', 'dr3-vision']));
    expect(page.fingerprint).toBe('ap-decision-mail-no-original:req-1');
    expect(page.cooldownMs).toBe(6 * 60 * 60 * 1000);
    expect(page.clickUrl).toContain('req-1'); // tier-1 click target (ADR-0036)
    // ADR-0045 — row id + status only.
    expect(page.body).not.toContain('Ramos Oil');
    expect(page.body).not.toContain('441');
    expect(page.body).not.toContain('IN-0320844');
  });

  it('a refused row is caught by the ADR-0126 sweep and the queue badge — the repair is Re-send', async () => {
    const { db } = await decideWith([fileAtt()], null);
    const row = db.requests[0]!;
    expect(isDecisionMailUnsent(row)).toBe(true); // queue badge
    expect(isDecisionMailStuck(row, new Date(Date.now() + DECISION_MAIL_GRACE_MS + 1_000))).toBe(
      true,
    ); // 06:00 digest
  });

  it('a BODY-ONLY invoice is unaffected: no file attachments, so it still sends', async () => {
    const { res } = await decideWith(
      [],
      null,
      newFakeDb({
        requests: [pendingReq({ body_html_sanitized: '<p>Invoice details inline.</p>' })],
        users,
        approvers,
        decisionRecipients: recips,
        attachments: [],
      }),
    );
    expect(res.mail).toBe('sent');
    expect(deliveredAttachments()).toHaveLength(1);
    expect(stamp.stampApproval).toHaveBeenCalledTimes(1); // the body render
  });
});

describe('ADR-0132 — original_attachment_sha256 is NOT evidence of stamping', () => {
  it('is set identically on a true overlay and on a cover-page fallback (hashed BEFORE the overlay is attempted)', async () => {
    const overlay = await decideWith([fileAtt({ byte_size: 120_000 })], PDF_BYTES);
    const overlaySha = overlay.db.requests[0]!.original_attachment_sha256;

    notifyStaffSpy.mockClear();
    stamp.stampApproval.mockClear();
    const cover = await decideWith(
      [
        fileAtt({
          filename: 'ledger.csv',
          content_type: 'text/csv',
          byte_size: 2_400,
          storage_key: 'ap/req-1/att-a/ledger.csv',
        }),
      ],
      CSV_BYTES,
    );
    const coverSha = cover.db.requests[0]!.original_attachment_sha256;

    // Both non-null, both merely proving the bytes were FETCHED. Anyone auditing
    // this column for "was the invoice stamped?" is reading it wrong — the proof
    // is the delivered attachment set, which is what every test above asserts.
    expect(overlaySha).not.toBeNull();
    expect(coverSha).not.toBeNull();
    expect(stamp.stampApproval).toHaveBeenCalledTimes(1); // the cover case really was a cover
  });
});
