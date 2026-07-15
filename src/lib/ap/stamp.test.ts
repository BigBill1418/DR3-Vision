// ADR-0046 §3 amendment (handoff §1.6e) — visible approval STAMP: exact stamp
// text/format, deterministic sha256 (tamper record) via an injected renderer,
// body vs attachment-cover rendering, and NO real Chromium in unit tests (the
// real-Chromium path is a single env-gated, skipped-by-default integration test).

import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  buildImageStampHtml,
  buildStampHtml,
  defaultPlaywrightRenderer,
  sha256Hex,
  stampApproval,
  stampImage,
  stampOntoOriginalPdf,
  stampText,
  type PdfRenderer,
  type StampInput,
} from './stamp';

const DECIDED_AT = new Date('2026-07-09T20:00:00Z'); // 1:00 PM PDT

function bodyInput(over: Partial<StampInput> = {}): StampInput {
  return {
    kind: 'body',
    requestId: 'req-42',
    subject: 'Invoice #4471',
    approverName: 'Morena',
    decision: 'approved',
    decidedAt: DECIDED_AT,
    bodyHtmlSanitized: '<p>Please pay $441.00</p>',
    ...over,
  };
}

describe('stampText — exact visible format', () => {
  it('approved: "Approved by [Name] on [Timestamp PT] via DR3-Vision"', () => {
    const t = stampText({ decision: 'approved', approverName: 'Morena', decidedAt: DECIDED_AT });
    expect(t).toMatch(/^Approved by Morena on .+ PT via DR3-Vision$/);
  });
  it('rejected: keeps the same shape with "Rejected by"', () => {
    const t = stampText({ decision: 'rejected', approverName: 'Rick', decidedAt: DECIDED_AT });
    expect(t).toMatch(/^Rejected by Rick on .+ PT via DR3-Vision$/);
  });
});

describe('buildStampHtml', () => {
  it('body mode embeds the visible stamp + the (re-sanitized) body, never a script', () => {
    const html = buildStampHtml(
      bodyInput({ bodyHtmlSanitized: '<p>ok<script>alert(1)</script></p>' }),
    );
    expect(html).toContain('Approved by Morena');
    expect(html).toContain('via DR3-Vision');
    expect(html).toContain('APPROVED');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
  it('ADR-0046 Amendment 4 — the stamped PDF still carries the GP matching keys (request id + subject)', () => {
    // The email body strips id + subject; the stamped decision PDF is where they
    // must survive for Great Plains matching. Assert both ride the stamp HTML.
    const html = buildStampHtml(bodyInput());
    expect(html).toContain('Request req-42');
    expect(html).toContain('Invoice #4471');
  });

  it('attachment mode renders a cover page with the original filename', () => {
    const html = buildStampHtml({
      kind: 'attachment',
      requestId: 'req-42',
      subject: 'Invoice',
      approverName: 'Morena',
      decision: 'approved',
      decidedAt: DECIDED_AT,
      originalFilename: 'invoice-4471.pdf',
      originalSha256: 'abc123',
    });
    expect(html).toContain('Approval cover page');
    expect(html).toContain('invoice-4471.pdf');
    expect(html).toContain('abc123');
  });
});

describe('stampApproval — injected renderer, deterministic sha256', () => {
  it('returns the rendered PDF + its sha256 (stable, = sha256 of the bytes)', async () => {
    const bytes = Buffer.from('%PDF-FIXED-BYTES');
    const renderer: PdfRenderer = vi.fn(async () => bytes);
    const a = await stampApproval(bodyInput(), renderer);
    const b = await stampApproval(bodyInput(), renderer);
    expect(a.sha256).toBe(sha256Hex(bytes));
    expect(a.sha256).toBe(b.sha256); // deterministic
    expect(a.pdf.equals(bytes)).toBe(true);
  });

  it('feeds the renderer HTML that carries the visible stamp text', async () => {
    let captured = '';
    const renderer: PdfRenderer = async (html) => {
      captured = html;
      return Buffer.from('x');
    };
    await stampApproval(bodyInput(), renderer);
    expect(captured).toMatch(/Approved by Morena on .+ PT via DR3-Vision/);
  });
});

// ADR-0046 Amendment 4 — pdf-lib TRUE overlay onto the original PDF (real pdf-lib,
// no Chromium). Deterministic tamper record, watermark on every page, both decisions.
describe('stampOntoOriginalPdf — pdf-lib overlay', () => {
  async function makeOriginal(pages = 1): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setCreationDate(new Date(0));
    doc.setModificationDate(new Date(0));
    for (let i = 0; i < pages; i++) {
      doc.addPage([612, 792]).drawText(`invoice page ${i + 1}`, { x: 40, y: 700, size: 14 });
    }
    return doc.save();
  }

  it('returns a real %PDF with a 64-hex sha, preserving the original page count', async () => {
    const original = await makeOriginal(2);
    const { pdf, sha256 } = await stampOntoOriginalPdf(original, {
      kind: 'attachment',
      requestId: 'req-42',
      subject: 'Invoice #4471',
      approverName: 'Morena',
      decision: 'approved',
      decidedAt: DECIDED_AT,
      originalFilename: 'invoice-4471.pdf',
    });
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(sha256).toHaveLength(64);
    const reloaded = await PDFDocument.load(pdf);
    expect(reloaded.getPageCount()).toBe(2); // overlay, not a new cover page
  });

  it('is DETERMINISTIC — same original + decision instant ⇒ identical sha (tamper record)', async () => {
    const original = await makeOriginal();
    const input: StampInput = {
      kind: 'attachment',
      requestId: 'req-42',
      subject: 'Invoice',
      approverName: 'Rick',
      decision: 'approved',
      decidedAt: DECIDED_AT,
    };
    const a = await stampOntoOriginalPdf(original, input);
    const b = await stampOntoOriginalPdf(original, input);
    expect(a.sha256).toBe(b.sha256);
  });

  it('a rejection stamps a different overlay than an approval', async () => {
    const original = await makeOriginal();
    const base = {
      kind: 'attachment' as const,
      requestId: 'req-42',
      subject: 'Invoice',
      approverName: 'Rick',
      decidedAt: DECIDED_AT,
    };
    const approved = await stampOntoOriginalPdf(original, { ...base, decision: 'approved' });
    const rejected = await stampOntoOriginalPdf(original, { ...base, decision: 'rejected' });
    expect(approved.sha256).not.toBe(rejected.sha256);
  });
});

describe('stampImage — image original overlay (injected renderer)', () => {
  it('embeds the image as a data URI with the visible stamp + decision watermark', async () => {
    let captured = '';
    const renderer: PdfRenderer = async (html) => {
      captured = html;
      return Buffer.from('%PDF-img');
    };
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const { pdf, sha256 } = await stampImage(
      {
        kind: 'attachment',
        requestId: 'req-42',
        subject: 'Invoice #4471',
        approverName: 'Morena',
        decision: 'approved',
        decidedAt: DECIDED_AT,
        originalFilename: 'scan.png',
      },
      bytes,
      'image/png',
      renderer,
    );
    expect(captured).toContain('data:image/png;base64,');
    expect(captured).toMatch(/Approved by Morena on .+ PT via DR3-Vision/);
    expect(captured).toContain('Invoice #4471');
    expect(sha256).toBe(sha256Hex(pdf));
  });

  it('buildImageStampHtml carries the GP keys (request id + subject) + watermark', () => {
    const html = buildImageStampHtml(
      {
        kind: 'attachment',
        requestId: 'req-99',
        subject: 'Invoice #9',
        approverName: 'Rick',
        decision: 'rejected',
        decidedAt: DECIDED_AT,
      },
      'data:image/png;base64,AAAA',
    );
    expect(html).toContain('Request req-99');
    expect(html).toContain('Invoice #9');
    expect(html).toContain('REJECTED');
  });
});

// Real Chromium is heavy + environment-dependent; run only when explicitly asked.
const RUN_REAL = process.env['AP_STAMP_REAL_CHROMIUM'] === '1';
(RUN_REAL ? it : it.skip)(
  'integration: renders a real PDF via Playwright (env-gated)',
  async () => {
    const { pdf, sha256 } = await stampApproval(bodyInput(), defaultPlaywrightRenderer);
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(sha256).toHaveLength(64);
  },
  60_000,
);
