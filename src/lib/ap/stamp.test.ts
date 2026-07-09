// ADR-0046 §3 amendment (handoff §1.6e) — visible approval STAMP: exact stamp
// text/format, deterministic sha256 (tamper record) via an injected renderer,
// body vs attachment-cover rendering, and NO real Chromium in unit tests (the
// real-Chromium path is a single env-gated, skipped-by-default integration test).

import { describe, expect, it, vi } from 'vitest';
import {
  buildStampHtml,
  defaultPlaywrightRenderer,
  sha256Hex,
  stampApproval,
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
    const html = buildStampHtml(bodyInput({ bodyHtmlSanitized: '<p>ok<script>alert(1)</script></p>' }));
    expect(html).toContain('Approved by Morena');
    expect(html).toContain('via DR3-Vision');
    expect(html).toContain('APPROVED');
    expect(html).not.toContain('<script>alert(1)</script>');
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

// Real Chromium is heavy + environment-dependent; run only when explicitly asked.
const RUN_REAL = process.env['AP_STAMP_REAL_CHROMIUM'] === '1';
(RUN_REAL ? it : it.skip)('integration: renders a real PDF via Playwright (env-gated)', async () => {
  const { pdf, sha256 } = await stampApproval(bodyInput(), defaultPlaywrightRenderer);
  expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
  expect(sha256).toHaveLength(64);
}, 60_000);
