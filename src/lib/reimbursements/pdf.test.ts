// ADR-0068 deferred item 1 — the stamped reimbursement decision PDF.
//
// These tests are built around the one thing the artefact exists to do: assert an
// independent second signature. So they check BOTH directions — that a legitimate
// dual-signed row renders both signatures in Pacific, and that every row which
// cannot evidence the claim is REFUSED rather than stamped. A stamper that
// happily prints "approved by two people" over a self-approval would be worse
// than the missing feature it replaces.
//
// No real Chromium: the renderer is injected, as in src/lib/ap/stamp.test.ts.

import { describe, expect, it, vi } from 'vitest';
import {
  assertDualSignature,
  buildReimbursementDecisionHtml,
  pdfBeneficiaryLabel,
  reimbursementDecisionAttachment,
  reimbursementStampLine,
  renderReimbursementDecisionPdf,
  ReimbursementPdfUnprovableError,
  segregationStatementHtml,
  BAND_CONTENT_PT,
  COMPOSED_PDF_BUDGET_BYTES,
  DECISION_BAND_PT,
  fitBox,
  LETTER,
  MIN_EFFECTIVE_DPI,
  PAGE1_RECEIPT_WINDOW,
  receiptPageStampLine,
  receiptProblemSentence,
  SPILL_RECEIPT_WINDOW,
  type ReimbursementDecisionPdfInput,
} from './pdf';

// 2026-07-20 12:15 PDT and 2026-07-21 09:30 PDT — deliberately chosen so the UTC
// instant lands on a DIFFERENT calendar day than Pacific for the first one
// (19:15Z same day) and so a UTC render would show the wrong hour for both.
const SUBMITTED_AT = new Date('2026-07-20T19:15:00Z');
const APPROVED_AT = new Date('2026-07-21T16:30:00Z');

function row(over: Partial<ReimbursementDecisionPdfInput> = {}): ReimbursementDecisionPdfInput {
  return {
    id: 'reimb-7',
    status: 'approved',
    amount_cents: 4285,
    expense_date: new Date('2026-07-18T12:00:00.000Z'),
    category: 'supplies',
    purpose: 'Box cutters and tape for the sort line',
    site: { name: 'Woodland' },
    submitted_by: 'u_jt',
    submitted_at: SUBMITTED_AT,
    submitter: { name: 'Janette Tomas' },
    second_approver_id: 'u_mg',
    second_approver: { name: 'Morena Garcia' },
    second_approved_at: APPROVED_AT,
    employee_user_id: 'u_floor',
    employee_user: { name: 'Alex Rivera' },
    employee_name_freeform: null,
    decision_note: null,
    receipt_file_key: null,
    ...over,
  };
}

/** Deterministic stand-in for the Playwright renderer: the HTML IS the "PDF". */
function stubRenderer() {
  return vi.fn(async (html: string): Promise<Buffer> => Buffer.from(html));
}

describe('reimbursementStampLine — both signatures, both Pacific', () => {
  it('names the submitter as SUBMITTING and only the approver as APPROVING', () => {
    const line = reimbursementStampLine(row());
    expect(line).toMatch(/^Submitted by Janette Tomas on .+ PT · Approved by Morena Garcia on /);
    expect(line).toContain('via DR3-Vision — Site: Woodland');
    // The AP stamper would have rendered "Approved by Janette …" here. That is the
    // manufactured-evidence shape ADR-0068 exists to remove.
    expect(line).not.toMatch(/Approved by Janette/);
  });

  it('renders both timestamps in Pacific, not UTC', () => {
    const line = reimbursementStampLine(row());
    // 19:15Z = 12:15 PM PDT; 16:30Z = 9:30 AM PDT.
    expect(line).toContain('12:15');
    expect(line).toContain('9:30');
    expect(line).not.toContain('19:15');
    expect(line).not.toContain('16:30');
    // Both instants are labelled, so neither can be read as a bare UTC stamp.
    expect(line.match(/ PT/g)?.length).toBe(2);
  });
});

describe('the segregation-of-duties statement is checked, not decorative', () => {
  it('roster beneficiary: claims the id comparison it actually made', () => {
    const html = segregationStatementHtml(row());
    expect(html).toContain('Two signatures, two different people.');
    expect(html).toContain('that submission is the first signature and is not an approval');
    expect(html).toContain('reimbursement_second_approver_not_submitter');
    expect(html).toContain('the two ids differ on this record');
  });

  it('free-text beneficiary: does NOT claim an id check that is impossible', () => {
    const html = segregationStatementHtml(
      row({
        employee_user_id: null,
        employee_user: null,
        employee_name_freeform: 'A. Rivera',
      }),
    );
    expect(html).not.toContain('the two ids differ');
    expect(html).toContain('entered as free text');
    expect(html).toContain('enforced at submission by name matching');
  });

  it('escapes a hostile name rather than emitting markup', () => {
    const html = segregationStatementHtml(
      row({ submitter: { name: '<script>alert(1)</script>' } }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('assertDualSignature — REFUSES every unprovable row', () => {
  const cases: Array<[string, Partial<ReimbursementDecisionPdfInput>, RegExp]> = [
    ['not approved (held)', { status: 'held' }, /is held, not approved/],
    ['not approved (rejected)', { status: 'rejected' }, /is rejected, not approved/],
    [
      'approved with no second approver id',
      { second_approver_id: null },
      /carries no second approver/,
    ],
    [
      'approved with no approval instant',
      { second_approved_at: null },
      /carries no second approver/,
    ],
    [
      'approved by its own submitter',
      { second_approver_id: 'u_jt' },
      /approved by its own submitter/,
    ],
    [
      'approved by the beneficiary',
      { second_approver_id: 'u_floor' },
      /approved by the person being reimbursed/,
    ],
  ];
  for (const [label, over, expected] of cases) {
    it(`throws on: ${label}`, () => {
      expect(() => assertDualSignature(row(over))).toThrow(ReimbursementPdfUnprovableError);
      expect(() => assertDualSignature(row(over))).toThrow(expected);
    });
  }

  it('accepts the legitimate case (a constraint that refuses everything is useless)', () => {
    expect(() => assertDualSignature(row())).not.toThrow();
  });

  it('does not refuse a free-text beneficiary whose name resembles the approver', () => {
    // The id comparison is impossible here; refusing would block every free-text
    // reimbursement. The document says so instead — see the statement test above.
    expect(() =>
      assertDualSignature(
        row({ employee_user_id: null, employee_user: null, employee_name_freeform: 'Morena' }),
      ),
    ).not.toThrow();
  });
});

describe('buildReimbursementDecisionHtml — the fields Mary pays from', () => {
  it('carries beneficiary, amount, expense date, category, purpose and site', () => {
    const html = buildReimbursementDecisionHtml(row());
    expect(html).toContain('Alex Rivera');
    expect(html).toContain('$42.85');
    expect(html).toContain('July 18, 2026'); // the expense calendar day, not the decision day
    expect(html).toContain('Supplies');
    expect(html).toContain('Box cutters and tape for the sort line');
    expect(html).toContain('Woodland');
    expect(html).toContain('Employee Reimbursement Approval');
    expect(html).toContain('APPROVED');
  });

  it('labels the two signature rows as first and second', () => {
    const html = buildReimbursementDecisionHtml(row());
    expect(html).toContain('Submitted by (first signature)');
    expect(html).toContain('Approved by (second signature)');
  });

  it('shows the approver note when there is one, and no empty note row when there is not', () => {
    expect(buildReimbursementDecisionHtml(row())).not.toContain('Approver note');
    const withNote = buildReimbursementDecisionHtml(row({ decision_note: 'Split with Eugene.' }));
    expect(withNote).toContain('Approver note');
    expect(withNote).toContain('Split with Eugene.');
  });

  it('references no external asset (the renderer aborts anything not data:/about:)', () => {
    const html = buildReimbursementDecisionHtml(row());
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
  });

  it('uses DR3 green, never SVdP red', () => {
    const html = buildReimbursementDecisionHtml(row());
    expect(html).toContain('#00524C');
    expect(html.toLowerCase()).not.toContain('#c8102e');
  });
});

describe('renderReimbursementDecisionPdf — deterministic sha256 tamper record', () => {
  it('hashes the rendered bytes and names the file after the request', async () => {
    const renderer = stubRenderer();
    const a = await renderReimbursementDecisionPdf(row(), renderer);
    const b = await renderReimbursementDecisionPdf(row(), renderer);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(b.sha256); // same row ⇒ same bytes ⇒ same tamper record
    expect(a.filename).toBe('reimbursement-decision-reimb-7.pdf');
    expect(renderer).toHaveBeenCalledTimes(2);
  });

  it('a different approver produces a different hash', async () => {
    const renderer = stubRenderer();
    const a = await renderReimbursementDecisionPdf(row(), renderer);
    const b = await renderReimbursementDecisionPdf(
      row({ second_approver: { name: 'Rick Alvarez' }, second_approver_id: 'u_rk' }),
      renderer,
    );
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('never calls the renderer on an unprovable row', async () => {
    const renderer = stubRenderer();
    await expect(
      renderReimbursementDecisionPdf(row({ second_approver_id: 'u_jt' }), renderer),
    ).rejects.toThrow(ReimbursementPdfUnprovableError);
    expect(renderer).not.toHaveBeenCalled();
  });
});

describe('reimbursementDecisionAttachment — fail-soft, never fail-silent', () => {
  it('returns the notifyStaff attachment shape on success', async () => {
    // A genuine success now means BOTH halves worked: the document rendered AND
    // the receipt is on it. `row()` files no receipt, so it is deliberately not
    // used here — see the next test for what that case reports.
    const out = await reimbursementDecisionAttachment(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => makePdf(1),
      },
    );
    expect(out.problem).toBeNull();
    expect(out.attachment?.filename).toBe('reimbursement-decision-reimb-7.pdf');
    expect(out.attachment?.contentType).toBe('application/pdf');
    expect(Buffer.isBuffer(out.attachment?.buffer)).toBe(true);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still ATTACHES when no receipt was filed, but reports the control finding', async () => {
    // Two independent failure axes: the document can render fine while the
    // receipt is missing. That must produce an attachment AND a problem — never a
    // clean `problem: null` that reads as "receipt present".
    const out = await reimbursementDecisionAttachment(row(), stubRenderer());
    expect(out.attachment).not.toBeNull();
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.problem).toContain('NO receipt attached to the request');
  });

  it('reports a renderer failure as a problem sentence instead of throwing', async () => {
    const boom = vi.fn(async (): Promise<Buffer> => {
      throw new Error('chromium died');
    });
    const out = await reimbursementDecisionAttachment(row(), boom);
    expect(out.attachment).toBeNull();
    expect(out.sha256).toBeNull();
    expect(out.problem).toContain('chromium died');
    expect(out.problem).toContain('no stamped artefact is attached');
  });

  it('reports an unprovable row as a problem sentence rather than stamping it', async () => {
    const out = await reimbursementDecisionAttachment(
      row({ second_approver_id: 'u_floor' }),
      stubRenderer(),
    );
    expect(out.attachment).toBeNull();
    expect(out.problem).toContain('approved by the person being reimbursed');
  });
});

describe('pdfBeneficiaryLabel', () => {
  it('prefers the roster name, falls back to free text, then to a marker', () => {
    expect(pdfBeneficiaryLabel(row())).toBe('Alex Rivera');
    expect(
      pdfBeneficiaryLabel(
        row({ employee_user: null, employee_user_id: null, employee_name_freeform: 'A. Rivera' }),
      ),
    ).toBe('A. Rivera');
    expect(
      pdfBeneficiaryLabel(
        row({ employee_user: null, employee_user_id: null, employee_name_freeform: null }),
      ),
    ).toBe('(unnamed)');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The receipt on the document (2026-07-30)
// ══════════════════════════════════════════════════════════════════════════
//
// These use REAL pdf-lib against REAL PDF bytes — pdf-lib is pure JS, so the
// composition is fully exercised without Chromium. Only the band render is
// stubbed, and it is stubbed with a genuine one-page Letter PDF rather than a
// string, because composition parses what the renderer returns.

/** A real, minimal, N-page PDF at the given page size. */
async function makePdf(pages: number, w = 594.72, h = 774.72): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([w, h]);
    p.drawText(`receipt page ${i + 1}`, { x: 20, y: h - 40, size: 12, font, color: rgb(0, 0, 0) });
  }
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  return doc.save();
}

/** Stands in for Playwright: returns a genuine blank one-page Letter PDF. */
function pdfRenderer(): ReturnType<typeof vi.fn> {
  return vi.fn(async (): Promise<Buffer> => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([LETTER.width, LETTER.height]);
    doc.setCreationDate(new Date(0));
    doc.setModificationDate(new Date(0));
    return Buffer.from(await doc.save());
  });
}

async function pageCountOf(pdf: Buffer): Promise<number> {
  const { PDFDocument } = await import('pdf-lib');
  return (await PDFDocument.load(pdf)).getPageCount();
}

describe('the composition geometry is internally consistent', () => {
  it('band + receipt window + stamp reserve exactly tile the page, with no overlap', () => {
    // If these ever stop summing, the band would print over the receipt or the
    // receipt would cover the signature stamp — both silent, both wrong.
    expect(PAGE1_RECEIPT_WINDOW.y + PAGE1_RECEIPT_WINDOW.height).toBe(
      LETTER.height - DECISION_BAND_PT,
    );
    expect(PAGE1_RECEIPT_WINDOW.x * 2 + PAGE1_RECEIPT_WINDOW.width).toBe(LETTER.width);
    expect(SPILL_RECEIPT_WINDOW.y + SPILL_RECEIPT_WINDOW.height).toBeLessThanOrEqual(LETTER.height);
    // The band's HTML gets less room than the band itself: the renderer's print
    // margin eats into it. Getting this backwards is what puts text on the receipt.
    expect(BAND_CONTENT_PT).toBeLessThan(DECISION_BAND_PT);
  });

  it('the composed budget stays under what the mail transport will accept', async () => {
    // 1.6 MB raw -> ~2.2 MB base64, which must clear the Graph inline ceiling with
    // room for the body. These two numbers live in different modules and MUST move
    // together; this is the test that notices when only one of them moves.
    const { GRAPH_INLINE_SEND_LIMIT_BYTES } = await import('@/lib/m365-mail');
    const onTheWire = Math.ceil(COMPOSED_PDF_BUDGET_BYTES / 3) * 4;
    expect(onTheWire).toBeLessThan(GRAPH_INLINE_SEND_LIMIT_BYTES);
  });
});

describe('fitBox — every receipt shape fits its window', () => {
  const shapes: Array<[string, { width: number; height: number }]> = [
    ['portrait scan (the live receipts)', { width: 594.72, height: 774.72 }],
    ['US Letter portrait', { width: 612, height: 792 }],
    ['A4 portrait', { width: 595.28, height: 841.89 }],
    ['landscape', { width: 792, height: 612 }],
    ['long thermal roll', { width: 164, height: 1800 }],
    ['wide panorama photo', { width: 4032, height: 1024 }],
    ['square', { width: 800, height: 800 }],
  ];

  for (const [label, shape] of shapes) {
    it(`${label} fits both windows without distortion`, () => {
      for (const box of [PAGE1_RECEIPT_WINDOW, SPILL_RECEIPT_WINDOW]) {
        const fit = fitBox(shape, box);
        // Never spills the window…
        expect(fit.width).toBeLessThanOrEqual(box.width + 0.01);
        expect(fit.height).toBeLessThanOrEqual(box.height + 0.01);
        // …never upscales past the box on the other axis…
        expect(fit.scale).toBeGreaterThan(0);
        // …and the aspect ratio is preserved (uniform scale, never stretched).
        expect(fit.width / fit.height).toBeCloseTo(shape.width / shape.height, 6);
      }
    });
  }

  it('touches at least one edge of the box — it fills the window it is given', () => {
    const fit = fitBox({ width: 594.72, height: 774.72 }, PAGE1_RECEIPT_WINDOW);
    const touchesW = Math.abs(fit.width - PAGE1_RECEIPT_WINDOW.width) < 0.01;
    const touchesH = Math.abs(fit.height - PAGE1_RECEIPT_WINDOW.height) < 0.01;
    expect(touchesW || touchesH).toBe(true);
  });
});

describe('the three receipt states are DISTINCT, never collapsed', () => {
  it('no receipt filed: amber, states it as a fact about the REQUEST', async () => {
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: null }),
      pdfRenderer(),
    );
    expect(out.receipt).toEqual({ kind: 'absent' });
    const html = buildReimbursementDecisionHtml(row({ receipt_file_key: null }), out.receipt);
    expect(html).toContain('NO RECEIPT WAS SUBMITTED WITH THIS REQUEST.');
    expect(html).toContain('receipt-strip warn');
    // A control finding, explicitly not described as a rendering failure.
    const problem = receiptProblemSentence(row(), out.receipt)!;
    expect(problem).toContain('NO receipt attached to the request');
    expect(problem).toContain('not a rendering failure');
  });

  it('receipt exists but is unreadable: amber, names the reason and points at Vision', async () => {
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => new Uint8Array([1, 2, 3, 4]), // not a PDF/JPEG/PNG
      },
    );
    expect(out.receipt.kind).toBe('unavailable');
    const html = buildReimbursementDecisionHtml(row(), out.receipt);
    expect(html).toContain('RECEIPT COULD NOT BE REPRODUCED HERE');
    expect(html).toContain('Open it there before paying.');
    const problem = receiptProblemSentence(row(), out.receipt)!;
    expect(problem).toContain('could not be reproduced');
    // Mary must still be able to pay it — the approval is unaffected.
    expect(problem).toContain('the reimbursement is payable');
  });

  it('reproduced: green, and states the true page count', async () => {
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => makePdf(3),
      },
    );
    expect(out.receipt).toEqual({ kind: 'reproduced', pageCount: 3 });
    const html = buildReimbursementDecisionHtml(row(), out.receipt);
    expect(html).toContain('Receipt as submitted — page 1 of 3.');
    expect(html).toContain('receipt-strip ok');
    // Nothing to report when the receipt really is on the page.
    expect(receiptProblemSentence(row(), out.receipt)).toBeNull();
  });

  it('the absent and unavailable sentences are not interchangeable', () => {
    const absent = receiptProblemSentence(row(), { kind: 'absent' })!;
    const unavailable = receiptProblemSentence(row(), {
      kind: 'unavailable',
      reason: 'the stored file is empty',
    })!;
    expect(absent).not.toBe(unavailable);
    // The absent case must never imply a receipt exists somewhere to go and find.
    expect(absent).not.toContain('open request');
    expect(unavailable).toContain('open request');
  });
});

describe('composition — pages, and the single-page promise', () => {
  it('a ONE-page receipt really does produce a ONE-page document', async () => {
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => makePdf(1),
      },
    );
    expect(await pageCountOf(out.pdf)).toBe(1);
    expect(out.receipt).toEqual({ kind: 'reproduced', pageCount: 1 });
  });

  it('a THREE-page receipt spills to three pages rather than tiling them illegibly', async () => {
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => makePdf(3),
      },
    );
    expect(await pageCountOf(out.pdf)).toBe(3);
  });

  it('every spill page carries a stamp naming its place and the packet', () => {
    const line = receiptPageStampLine({ id: 'reimb-7', amount_cents: 4285 }, 2, 3);
    expect(line).toBe('Receipt page 2 of 3 · reimb-7 · APPROVED $42.85');
  });

  it('renders the band exactly ONCE — Chromium is capped at one concurrent render', async () => {
    const renderer = pdfRenderer();
    await renderReimbursementDecisionPdf(row({ receipt_file_key: 'k' }), renderer, {
      fetchReceipt: async () => makePdf(3),
    });
    // The page count is probed with pdf-lib BEFORE the band is printed, so the
    // strip states the true count without a second render to correct it.
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it('is byte-reproducible: same row + same receipt ⇒ same tamper record', async () => {
    const args = () =>
      renderReimbursementDecisionPdf(row({ receipt_file_key: 'k' }), pdfRenderer(), {
        fetchReceipt: async () => makePdf(2),
      });
    const [a, b] = [await args(), await args()];
    expect(a.sha256).toBe(b.sha256);
  });
});

describe('the R2 read has two failure shapes, and they are told apart', () => {
  it('a NULL return (storage unconfigured / placeholder key) is not an error', async () => {
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => null,
      },
    );
    expect(out.receipt).toEqual({
      kind: 'unavailable',
      reason: 'it could not be read from file storage',
    });
  });

  it('a THROWN GetObject error is caught and named, not propagated', async () => {
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => {
          throw new Error('AccessDenied');
        },
      },
    );
    expect(out.receipt.kind).toBe('unavailable');
    expect((out.receipt as { reason: string }).reason).toContain('AccessDenied');
  });

  it('an EMPTY object is reported as empty rather than as a broken PDF', async () => {
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => new Uint8Array(0),
      },
    );
    expect(out.receipt).toEqual({ kind: 'unavailable', reason: 'the stored file is empty' });
  });

  it('a truncated / unreadable PDF is named as such', async () => {
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => new Uint8Array(Buffer.from('%PDF-1.4 and then garbage')),
      },
    );
    expect(out.receipt).toEqual({
      kind: 'unavailable',
      reason: 'the stored file is not a readable PDF',
    });
  });

  it('the mail still gets an attachment in EVERY receipt-failure case', async () => {
    // The whole fail-soft contract: Mary can pay a properly approved reimbursement
    // even when the receipt cannot be drawn. The document degrades; it never
    // disappears, and the reason always rides `problem`.
    for (const fetchReceipt of [
      async () => null,
      async () => new Uint8Array(0),
      async () => {
        throw new Error('boom');
      },
    ]) {
      const out = await reimbursementDecisionAttachment(
        row({ receipt_file_key: 'k' }),
        pdfRenderer(),
        {
          fetchReceipt: fetchReceipt as () => Promise<Uint8Array | null>,
        },
      );
      expect(out.attachment).not.toBeNull();
      expect(out.problem).not.toBeNull();
    }
  });
});

describe('an image receipt (a phone photo) is embedded natively', () => {
  it('accepts a JPEG and treats it as a single receipt page', async () => {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 1200, height: 1600, channels: 3, background: '#ffffff' },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => new Uint8Array(jpeg),
      },
    );
    expect(out.receipt).toEqual({ kind: 'reproduced', pageCount: 1 });
    expect(await pageCountOf(out.pdf)).toBe(1);
  });

  it('accepts a PNG', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 800, height: 1000, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => new Uint8Array(png),
      },
    );
    expect(out.receipt).toEqual({ kind: 'reproduced', pageCount: 1 });
  });

  it('refuses a format it cannot embed rather than emitting a blank window', async () => {
    // A HEIC/TIFF/whatever must not silently produce an empty receipt area.
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
      },
    );
    expect(out.receipt).toEqual({
      kind: 'unavailable',
      reason: 'the stored file is not a PDF, JPEG or PNG',
    });
  });
});

describe('the size budget is enforced, and failing it is VISIBLE', () => {
  it('a heavy scanned receipt is shrunk down the ladder and lands under budget', async () => {
    const sharp = (await import('sharp')).default;
    const { PDFDocument } = await import('pdf-lib');
    // Three full-page photographic scans — noise defeats JPEG, as a real scan does.
    const noise = Buffer.alloc(2400 * 3200 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 251;
    const jpeg = await sharp(noise, { raw: { width: 2400, height: 3200, channels: 3 } })
      .jpeg({ quality: 92 })
      .toBuffer();
    const doc = await PDFDocument.create();
    const img = await doc.embedJpg(jpeg);
    for (let i = 0; i < 3; i++) {
      const p = doc.addPage([594.72, 774.72]);
      p.drawImage(img, { x: 0, y: 0, width: 594.72, height: 774.72 });
    }
    const heavy = await doc.save();
    expect(heavy.length).toBeGreaterThan(COMPOSED_PDF_BUDGET_BYTES);

    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => heavy,
      },
    );
    expect(out.receipt).toEqual({ kind: 'reproduced', pageCount: 3 });
    expect(out.pdf.length).toBeLessThanOrEqual(COMPOSED_PDF_BUDGET_BYTES);
  }, 120_000);

  it('a VECTOR receipt is never rasterised — there is no scan to re-encode', async () => {
    // A crisp digital receipt has no /DCTDecode stream, so the ladder has nothing
    // to shrink. It must say so rather than degrade a vector document.
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // Bulk it past the budget with vector text only.
    for (let i = 0; i < 40; i++) {
      const p = doc.addPage([594.72, 774.72]);
      for (let y = 20; y < 760; y += 8) {
        p.drawText('x'.repeat(180), { x: 4, y, size: 5, font });
      }
    }
    const vector = await doc.save();
    const out = await renderReimbursementDecisionPdf(
      row({ receipt_file_key: 'k' }),
      pdfRenderer(),
      {
        fetchReceipt: async () => vector,
      },
    );
    if (vector.length > COMPOSED_PDF_BUDGET_BYTES) {
      // Over budget with nothing shrinkable ⇒ surfaced, never a truncated file.
      expect(out.receipt.kind).toBe('unavailable');
      expect((out.receipt as { reason: string }).reason).toContain('no re-encodable scanned image');
    } else {
      expect(out.receipt.kind).toBe('reproduced');
    }
    expect(out.pdf.length).toBeLessThanOrEqual(COMPOSED_PDF_BUDGET_BYTES);
  }, 120_000);

  it('the readability floor is measured against the drawn size, not the pixel count', () => {
    // 150 DPI is the floor; the ladder rungs are gated on it, which is why a
    // multi-page receipt (drawn nearly full-bleed) tolerates less shrinking than a
    // single-page one (drawn into the smaller page-1 window).
    const spillInches = SPILL_RECEIPT_WINDOW.width / 72;
    expect(1400 / spillInches).toBeGreaterThanOrEqual(MIN_EFFECTIVE_DPI);
    expect(1100 / spillInches).toBeLessThan(MIN_EFFECTIVE_DPI);
  });
});
