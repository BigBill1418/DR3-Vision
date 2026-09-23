// ADR-0136 — the duplicate-invoice key. The subject fixtures are REAL production
// subjects (2026-07..09), because the key is only as good as its reading of what
// vendors and AP actually write.

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeApRequest } from './__testutils__/fake-prisma';
import {
  extractInvoiceNumber,
  findApprovedDuplicates,
  forwardedApprovalSubject,
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
