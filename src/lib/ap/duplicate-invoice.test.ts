// ADR-0136 — the duplicate-invoice key. The subject fixtures are REAL production
// subjects (2026-07..09), because the key is only as good as its reading of what
// vendors and AP actually write.

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApAttachment,
  type FakeApRequest,
} from './__testutils__/fake-prisma';
import {
  extractInvoiceNumber,
  findApprovedDuplicates,
  forwardedApprovalSubject,
  invoiceFileHashes,
  isInvoiceFile,
  vendorsCompatible,
} from './duplicate-invoice';

describe('extractInvoiceNumber — real subjects', () => {
  it.each([
    [
      'FW: Invoice: 6646 | Service Order: 7415 | Unit #161053 | United Fleet Maintenance Woodland, CA',
      '6646',
    ],
    ['FW: Acct #: 41-0071121 Acct Name: ST. VICENT DE PAUL Invoice #: T705145', 'T705145'],
    [
      'FW: Acct No. 78910: Your Invoice IM25013731 from Total Industries is Attached PO No. MORENA GOMEZ',
      'IM25013731',
    ],
    [
      'FW: Acct No. 78910: Your Invoice R2100051-21 from Total Industries is Attached PO No. TMAC102324',
      'R2100051-21',
    ],
    ['Fastenal Invoice CAST2113042 to be reviewed and approved', 'CAST2113042'],
    ['FW: Inv 12513', '12513'],
    ['FW: New payment request from Xtraction, Inc. - invoice 13389- 1 of 4', '13389'],
    ['FW: Invoice # 117075 Vulcan Wire', '117075'],
    [
      'FW: St. Vincent de Paul - Invoice I-52650 from Safe Side Security, Inc. for Review',
      'I-52650',
    ],
    ['FW: Allied Propane Invoice U001P255-Review and Approve', 'U001P255'],
    ['FW: Invoice eFuel Invoice IN-0342625', 'IN-0342625'],
    ['FW: Invoice: INV-206931 ', 'INV-206931'],
    ['FW: Invoice Kelliher Machine Invoices 0182 & 0183', '0182'],
    ['FW: Ramos/EFuel Invoices IN-0320844', 'IN-0320844'],
  ])('%s → %s', (subject, expected) => {
    expect(extractInvoiceNumber(subject)).toBe(expected);
  });

  it.each([
    'FW: Invoices',
    'FW: Here is your Invoice from North Valley Commercial Branch',
    'FW: Invoice(s) Posted',
    'FW: Kelliher Machine Invoice-Green Baler',
    "FW: Janette Tomas' Reimbursement form 07-14-2026",
    'FW: Invoice for order number: S-516366-United Truck & Trailer',
    '',
  ])('names no invoice number: %j', (subject) => {
    expect(extractInvoiceNumber(subject)).toBeNull();
  });

  it('is case-insensitive and upper-cases the token', () => {
    expect(extractInvoiceNumber('fw: invoice u047m205 needs review')).toBe('U047M205');
  });
});

describe('vendorsCompatible', () => {
  it.each([
    [['United'], ['united fleet maintenance']],
    [['Inter State oil Company'], ['InterState Oil Co']],
    [['alied Propane service'], ['Allied Propane']],
    [['Ramos oil'], ['eFuel Ramos Oil Company']],
    [['Grainer'], ['Grainger-Woodland']],
  ])('%j ~ %j', (a, b) => {
    expect(vendorsCompatible(a, b)).toBe(true);
  });

  it('keeps genuinely different vendors apart', () => {
    expect(vendorsCompatible(['Xtraction'], ['Woodland Truck scales INC'])).toBe(false);
    expect(vendorsCompatible(['Fastenal'], ['Total Industries'])).toBe(false);
  });

  it('a blank side cannot rule a match out', () => {
    expect(vendorsCompatible([], ['Fastenal'])).toBe(true);
    expect(vendorsCompatible(['  '], ['Fastenal'])).toBe(true);
  });
});

function req(over: Partial<FakeApRequest>): FakeApRequest {
  return {
    id: 'r',
    status: 'approved',
    internet_message_id: `<${over.id ?? 'r'}@svdp.us>`,
    conversation_id: null,
    received_at: new Date('2026-08-10T21:40:47Z'),
    sender_address: 'gloria.salpino@svdp.us',
    sender_validated: true,
    subject: null,
    body_html_sanitized: null,
    body_text: null,
    vendor: null,
    amount_cents: null,
    decided_by: 'u-morena',
    decided_at: new Date('2026-08-13T12:32:37Z'),
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

const INV_6646 =
  'FW: Invoice: 6646 | Service Order: 7415 | Unit #161053 | United Fleet Maintenance';

describe('findApprovedDuplicates', () => {
  function db(rows: FakeApRequest[]): PrismaClient {
    return makeFakePrisma(newFakeDb({ requests: rows })) as unknown as PrismaClient;
  }

  it('finds the 6646 pair: same number, vendor typed differently, never itself', async () => {
    const prisma = db([
      req({
        id: 'first',
        subject: `${INV_6646} Woodland, CA`,
        vendor_freeform: 'United',
      } as Partial<FakeApRequest>),
      req({ id: 'second', status: 'pending', subject: `${INV_6646} -Note Correction` }),
    ]);
    const r = await findApprovedDuplicates(prisma, {
      requestId: 'second',
      subject: `${INV_6646} -Note Correction`,
      vendors: ['united fleet maintenance'],
    });
    expect(r?.invoiceNumber).toBe('6646');
    expect(r?.matches.map((m) => m.requestId)).toEqual(['first']);
    expect(r?.matches[0]?.approvedBy).toBe('u-morena');
  });

  it('counts a first-approved (>= $1,000, awaiting the second signer) request', async () => {
    const prisma = db([
      req({
        id: 'big',
        status: 'pending_second_approval',
        subject: 'FW: Invoice # 117075 Vulcan Wire',
        decided_by: null,
        decided_at: null,
        first_approver_id: 'u-janette',
        first_approved_at: new Date('2026-09-01T16:00:00Z'),
      } as Partial<FakeApRequest>),
    ]);
    const r = await findApprovedDuplicates(prisma, {
      requestId: 'again',
      subject: 'FW: Invoice # 117075 Vulcan Wire',
      vendors: ['Vulcan Incorporated'],
    });
    expect(r?.matches.map((m) => [m.requestId, m.approvedBy])).toEqual([['big', 'u-janette']]);
  });

  it('ignores rejected / pending rows, other numbers, and a different vendor', async () => {
    const prisma = db([
      req({ id: 'rej', status: 'rejected', subject: 'FW: Invoice: 6646' }),
      req({ id: 'pend', status: 'pending', subject: 'FW: Invoice: 6646' }),
      req({ id: 'other-number', subject: 'FW: Invoice: 66460' }),
      req({
        id: 'other-vendor',
        subject: 'FW: Invoice: 6646',
        vendor_freeform: 'Fastenal',
      } as Partial<FakeApRequest>),
    ]);
    const r = await findApprovedDuplicates(prisma, {
      requestId: 'x',
      subject: 'FW: Invoice: 6646',
      vendors: ['United Fleet Maintenance'],
    });
    expect(r).toEqual({ invoiceNumber: '6646', forwardedApproval: false, matches: [] });
  });

  it('returns null — not "no match" — when the subject names no invoice number', async () => {
    const prisma = db([req({ id: 'a', subject: 'FW: Invoices' })]);
    expect(
      await findApprovedDuplicates(prisma, {
        requestId: 'b',
        subject: 'FW: Invoices',
        vendors: [],
      }),
    ).toBeNull();
  });
});

describe('forwarded approval mail (the second key)', () => {
  it.each([
    [
      'FW: DR3-Vision AP decision (approved — DR3 Eugene) — FW: Kelliher Machine Invoice-Green Baler',
      'kelliher machine invoice-green baler',
    ],
    [
      'FW: DR3-Vision AP decision (approved — DR3 Woodland) — FW: Invoice Request for U047M248',
      'invoice request for u047m248',
    ],
    [
      'DR3-Vision AP decision (approved) — Re:  Fastenal   Invoice Notice',
      'fastenal invoice notice',
    ],
  ])('%s → %s', (subject, original) => {
    expect(forwardedApprovalSubject(subject)).toBe(original);
  });

  it('a forwarded REJECTION is a resubmission, not a duplicate', () => {
    expect(
      forwardedApprovalSubject(
        'FW: DR3-Vision AP decision (rejected — DR3 Woodland) — FW: Invoices/Inspections 6-11',
      ),
    ).toBeNull();
    expect(forwardedApprovalSubject('FW: Kelliher Machine Invoice-Green Baler')).toBeNull();
  });

  it('finds the approved original (and a longer re-forward of it), ignoring vendor spelling', async () => {
    const prisma = makeFakePrisma(
      newFakeDb({
        requests: [
          req({ id: 'orig', subject: 'FW: Kelliher Machine Invoice-Green Baler' }),
          req({ id: 'again', subject: 'FW: Kelliher Machine Invoice-Green Baler Invoice 0174' }),
          req({ id: 'other', subject: 'FW: HYd cyl invoice-Kelliher Machine' }),
        ],
      }),
    ) as unknown as PrismaClient;
    const r = await findApprovedDuplicates(prisma, {
      requestId: 'echo',
      subject:
        'FW: DR3-Vision AP decision (approved — DR3 Eugene) — FW: Kelliher Machine Invoice-Green Baler',
      vendors: ['Somebody Else Entirely'],
    });
    expect(r?.forwardedApproval).toBe(true);
    expect(r?.invoiceNumber).toBeNull();
    expect(r?.matches.map((m) => m.requestId)).toEqual(['orig', 'again']);
  });
});

// ── ADR-0136 addendum — the third key: the same invoice FILE ─────────────────
//
// Production, 2026-07..09: five approved doubles carried a byte-identical PDF under
// a subject the number key cannot read ("FW: Invoice(s) Posted", "FW: Ramos/EFuel",
// "Inter State Oil", "…Green Baler Invoice 0174" vs "…Green Baler", and invoice
// 13423 whose PDF is 13422's). The attachment shapes below are real ones.

function att(over: Partial<FakeApAttachment>): FakeApAttachment {
  return {
    id: 'a',
    request_id: 'r',
    kind: 'file',
    filename: 'Invoice_IN-0312251.PDF',
    content_type: 'application/octet-stream',
    byte_size: 98755,
    storage_key: `ap/${over.request_id ?? 'r'}/${over.id ?? 'a'}`,
    link_url: null,
    nested_subject: null,
    ...over,
  };
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const PDF = sha('ramos invoice(s) posted pdf');
const LOGO = sha("gloria's signature logo");

describe('isInvoiceFile — which files are a key', () => {
  it.each([
    ['Invoice_IN-0312251.PDF', 'application/octet-stream', 98755],
    ['invoice_6646.pdf', 'application/pdf', 5568],
    ['5312.jpg', 'image/jpeg', 1185684],
    ['Service_Order_Attachment_1_image.jpg', 'image/jpeg', 512943],
  ])('%s (%s, %d B) is a document', (filename, content_type, byte_size) => {
    expect(isInvoiceFile(att({ filename, content_type, byte_size }))).toBe(true);
  });

  it.each([
    // Outlook body images above the 50 KB size rule — on 12 and 7 approved requests.
    ['image002.jpg', 'image/jpeg', 69918],
    ['image001.jpg', 'image/jpeg', 80204],
    ['image001.png', 'image/png', 1284],
    ['image.png', 'image/png', 8228],
  ])('%s (%s, %d B) is a signature image, never a key', (filename, content_type, byte_size) => {
    expect(isInvoiceFile(att({ filename, content_type, byte_size }))).toBe(false);
  });

  it('a link or an unstored file is not a key', () => {
    expect(isInvoiceFile(att({ kind: 'reference_link' }))).toBe(false);
    expect(isInvoiceFile(att({ storage_key: null }))).toBe(false);
  });
});

describe('invoiceFileHashes', () => {
  it('hashes invoice files from their bytes, records each once, skips the logo', async () => {
    const db = newFakeDb({
      attachments: [
        att({ id: 'pdf', request_id: 'r1' }),
        att({
          id: 'logo',
          request_id: 'r1',
          filename: 'image002.jpg',
          content_type: 'image/jpeg',
          byte_size: 69918,
        }),
        att({ id: 'other', request_id: 'r2' }),
      ],
    });
    const read = async (key: string): Promise<Uint8Array> =>
      new TextEncoder().encode(`bytes of ${key}`);
    const reads: string[] = [];
    const prisma = makeFakePrisma(db) as unknown as PrismaClient;
    const first = await invoiceFileHashes(prisma, 'r1', async (k) => (reads.push(k), read(k)));
    expect(first).toEqual({ hashes: [sha('bytes of ap/r1/pdf')], unreadable: 0 });
    expect(reads).toEqual(['ap/r1/pdf']); // the logo's bytes are never fetched
    expect(db.attachments.find((a) => a.id === 'pdf')!.sha256).toBe(sha('bytes of ap/r1/pdf'));
    expect(db.attachments.find((a) => a.id === 'logo')!.sha256).toBeUndefined();
    // Second call reuses the recorded hash — no second read.
    const again = await invoiceFileHashes(prisma, 'r1', async (k) => (reads.push(k), read(k)));
    expect(again.hashes).toEqual(first.hashes);
    expect(reads).toHaveLength(1);
  });

  it('counts an unreadable file instead of inventing a hash for it', async () => {
    const db = newFakeDb({ attachments: [att({ id: 'pdf', request_id: 'r1' })] });
    const r = await invoiceFileHashes(
      makeFakePrisma(db) as unknown as PrismaClient,
      'r1',
      async () => {
        throw new Error('R2 down');
      },
    );
    expect(r).toEqual({ hashes: [], unreadable: 1 });
    expect(db.attachments[0]!.sha256).toBeUndefined();
  });
});

describe('findApprovedDuplicates — the same file', () => {
  function db(rows: FakeApRequest[], attachments: FakeApAttachment[]): PrismaClient {
    return makeFakePrisma(newFakeDb({ requests: rows, attachments })) as unknown as PrismaClient;
  }

  it('catches the "Invoice(s) Posted" re-forward the number key cannot read', async () => {
    const prisma = db(
      [
        req({ id: 'first', subject: 'FW: Invoice(s) Posted' }),
        req({ id: 'second', status: 'pending' }),
      ],
      [att({ id: 'f1', request_id: 'first', sha256: PDF })],
    );
    const subject = 'FW: Invoice(s) Posted-Ramos/E-fuel';
    expect(extractInvoiceNumber(subject)).toBeNull(); // the number key has nothing
    const r = await findApprovedDuplicates(prisma, {
      requestId: 'second',
      subject,
      vendors: ['Ramos oil'],
      fileHashes: [PDF],
    });
    expect(r).not.toBeNull();
    expect(r!.matches).toEqual([
      expect.objectContaining({ requestId: 'first', sameFile: true, sameInvoiceNumber: false }),
    ]);
  });

  it('without the file hashes the same pair is invisible (the pre-addendum behaviour)', async () => {
    const prisma = db(
      [
        req({ id: 'first', subject: 'FW: Invoice(s) Posted' }),
        req({ id: 'second', status: 'pending' }),
      ],
      [att({ id: 'f1', request_id: 'first', sha256: PDF })],
    );
    expect(
      await findApprovedDuplicates(prisma, {
        requestId: 'second',
        subject: 'FW: Invoice(s) Posted-Ramos/E-fuel',
        vendors: [],
      }),
    ).toBeNull();
  });

  it('13423 carrying 13422’s PDF is a same-file match, NOT an invoice-number match', async () => {
    const prisma = db(
      [
        req({
          id: '13422',
          subject: 'FW: New payment request from Xtraction, Inc. - invoice 13422',
        }),
        req({ id: '13423', status: 'pending' }),
      ],
      [
        att({
          id: 'x',
          request_id: '13422',
          filename: '08_07_2026.pdf',
          content_type: 'application/pdf',
          sha256: PDF,
        }),
      ],
    );
    const r = await findApprovedDuplicates(prisma, {
      requestId: '13423',
      subject: 'FW: New payment request from Xtraction, Inc. - invoice 13423',
      vendors: ['Xtraction'],
      fileHashes: [PDF],
    });
    expect(r!.invoiceNumber).toBe('13423');
    expect(r!.matches).toEqual([
      expect.objectContaining({ requestId: '13422', sameFile: true, sameInvoiceNumber: false }),
    ]);
  });

  it('falls back to the stamp’s original_attachment_sha256 for an approval never hashed', async () => {
    const prisma = db(
      [
        req({ id: 'first', subject: 'Interstate Oil', original_attachment_sha256: PDF }),
        req({ id: 'second', status: 'pending' }),
      ],
      [],
    );
    const r = await findApprovedDuplicates(prisma, {
      requestId: 'second',
      subject: 'Inter State Oil',
      vendors: [],
      fileHashes: [PDF],
    });
    expect(r!.matches.map((m) => [m.requestId, m.sameFile])).toEqual([['first', true]]);
  });

  it('counts a first-approved (awaiting the second signer) request with the same file', async () => {
    const prisma = db(
      [
        req({ id: 'first', status: 'pending_second_approval', decided_at: null }),
        req({ id: 'second', status: 'pending' }),
      ],
      [att({ id: 'f1', request_id: 'first', sha256: PDF })],
    );
    const r = await findApprovedDuplicates(prisma, {
      requestId: 'second',
      subject: null,
      vendors: [],
      fileHashes: [PDF],
    });
    expect(r!.matches.map((m) => m.status)).toEqual(['pending_second_approval']);
  });

  it('a shared signature logo, a rejected twin, and the request itself are not matches', async () => {
    const prisma = db(
      [
        req({ id: 'logo-only', subject: 'FW: Invoice from someone else' }),
        req({ id: 'rejected', status: 'rejected' }),
        req({ id: 'self', status: 'pending' }),
      ],
      [
        // Recorded hashes on logo rows can only come from a backfill of EVERY file;
        // the match still refuses them.
        att({
          id: 'l',
          request_id: 'logo-only',
          filename: 'image002.jpg',
          content_type: 'image/jpeg',
          byte_size: 69918,
          sha256: LOGO,
        }),
        att({ id: 'rj', request_id: 'rejected', sha256: PDF }),
        att({ id: 's', request_id: 'self', sha256: PDF }),
      ],
    );
    const r = await findApprovedDuplicates(prisma, {
      requestId: 'self',
      subject: null,
      vendors: [],
      fileHashes: [PDF, LOGO],
    });
    expect(r!.matches).toEqual([]);
  });
});
