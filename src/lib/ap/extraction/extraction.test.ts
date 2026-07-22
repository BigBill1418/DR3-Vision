// ADR-0046 Amendment 5 (D-M5-2) — extraction pipeline tests. Covers the four
// confidence tiers, the scanned-image / plain-text-email / multi-page edge cases,
// the Claude fallback (mocked — no network, no real API key), cost logging, and
// the fail-soft failure modes. All fixtures are SYNTHETIC (no real DR3/vendor/haul
// identifiers). Nothing here touches Prisma, the SDK, or pdf-parse at runtime:
// every I/O seam is injected.

import { describe, expect, it, vi } from 'vitest';
import { parseUsdToCents, scanTextSources, type TextSource } from './local-parser';
import { runClaudeFallback, type ExtractionModelCall } from './claude-fallback';
import { extractFromRequest } from './pipeline';
import {
  FAILED_INVOICE,
  HIGH_INVOICE,
  LOW_BARE_INVOICE,
  LOW_DISAGREE_INVOICE,
  MEDIUM_INVOICE,
  MULTI_PAGE_PDF_TEXT,
  PLAIN_TEXT_EMAIL,
  fileAttachment,
} from './__fixtures__/invoices';

const body = (text: string): TextSource[] => [{ name: 'email body', text }];

describe('parseUsdToCents', () => {
  it('parses $-prefixed, comma-grouped, and bare amounts to integer cents', () => {
    expect(parseUsdToCents('$1,250.00')).toBe(125000);
    expect(parseUsdToCents('1080.00')).toBe(108000);
    expect(parseUsdToCents('432.10')).toBe(43210);
  });
  it('rounds away binary-float drift', () => {
    expect(parseUsdToCents('12.10')).toBe(1210);
  });
  it('rejects non-2-decimal / garbage', () => {
    expect(parseUsdToCents('12.1')).toBeNull();
    expect(parseUsdToCents('abc')).toBeNull();
  });
});

describe('scanTextSources — confidence tiers (D-M5-2 §2)', () => {
  it('HIGH: one canonical total, sole amount in the document', () => {
    const r = scanTextSources(body(HIGH_INVOICE));
    expect(r.confidence).toBe('high');
    expect(r.best_amount_cents).toBe(125000);
  });

  it('MEDIUM: one canonical total amid multiple candidates', () => {
    const r = scanTextSources(body(MEDIUM_INVOICE));
    expect(r.confidence).toBe('medium');
    expect(r.best_amount_cents).toBe(108000);
    // Subtotal must NOT have registered as a canonical Total.
    expect(r.candidates.map((c) => c.amount_cents).sort((a, b) => a - b)).toEqual([
      8000, 100000, 108000,
    ]);
  });

  it('LOW: canonical labels disagree → largest, low confidence', () => {
    const r = scanTextSources(body(LOW_DISAGREE_INVOICE));
    expect(r.confidence).toBe('low');
    expect(r.best_amount_cents).toBe(75000);
  });

  it('LOW: only bare amounts, no canonical anchor → largest, low confidence', () => {
    const r = scanTextSources(body(LOW_BARE_INVOICE));
    expect(r.confidence).toBe('low');
    expect(r.best_amount_cents).toBe(12000);
  });

  it('FAILED: no amounts at all', () => {
    const r = scanTextSources(body(FAILED_INVOICE));
    expect(r.confidence).toBe('failed');
    expect(r.best_amount_cents).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });

  it('multi-page: total on the last page is still found', () => {
    const r = scanTextSources(body(MULTI_PAGE_PDF_TEXT));
    expect(r.confidence).toBe('high');
    expect(r.best_amount_cents).toBe(349999);
  });
});

const noFallback = { fallbackEnabled: () => false, now: () => new Date('2026-07-22T00:00:00Z') };

describe('extractFromRequest — local-only paths', () => {
  it('plain-text email, fallback disabled → local HIGH', async () => {
    const r = await extractFromRequest(
      { bodyText: PLAIN_TEXT_EMAIL, attachments: [] },
      noFallback,
    );
    expect(r).toMatchObject({
      confidence: 'high',
      source: 'local',
      best_amount_cents: 43210,
      attempted_at: '2026-07-22T00:00:00.000Z',
    });
    expect(r.cost_cents).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it('FAILED local + fallback disabled → failed, null, no error', async () => {
    const r = await extractFromRequest(
      { bodyText: FAILED_INVOICE, attachments: [] },
      noFallback,
    );
    expect(r).toMatchObject({ confidence: 'failed', source: 'local', best_amount_cents: null });
    expect(r.error).toBeUndefined();
  });

  it('scanned image (no text layer) + fallback disabled → FAILED', async () => {
    const r = await extractFromRequest(
      { bodyText: '', attachments: [fileAttachment('scan.png', 'image/png')] },
      // Image bytes never reach pdfText; body is empty → no amounts.
      noFallback,
    );
    expect(r.confidence).toBe('failed');
    expect(r.best_amount_cents).toBeNull();
  });

  it('PDF attachment text is scanned (injected pdfText)', async () => {
    const r = await extractFromRequest(
      { bodyText: '', attachments: [fileAttachment('invoice.pdf', 'application/pdf')] },
      { ...noFallback, pdfText: async () => HIGH_INVOICE },
    );
    expect(r.confidence).toBe('high');
    expect(r.best_amount_cents).toBe(125000);
  });

  it('never populates extracted_haul_numbers (Phase-2 hook only)', async () => {
    const r = await extractFromRequest({ bodyText: HIGH_INVOICE, attachments: [] }, noFallback);
    expect(Object.keys(r)).not.toContain('extracted_haul_numbers');
  });
});

describe('extractFromRequest — Claude fallback (mocked)', () => {
  const withFallback = (
    runFallback: typeof runClaudeFallback,
    logCost?: (c: number, m: string) => void,
  ) => ({
    fallbackEnabled: () => true,
    now: () => new Date('2026-07-22T00:00:00Z'),
    runFallback,
    ...(logCost ? { logCost } : {}),
  });

  it('LOW local → fallback success rewrites the result and logs cost', async () => {
    const logCost = vi.fn();
    const runFallback = vi.fn(async () => ({
      amount_cents: 75000,
      vendor: 'Northwind Materials',
      confidence: 'high' as const,
      reasoning: 'Balance Due is the payable total.',
      model: 'claude-sonnet-4-6',
      cost_cents: 1.05,
    }));
    const r = await extractFromRequest(
      { bodyText: LOW_DISAGREE_INVOICE, attachments: [] },
      withFallback(runFallback, logCost),
    );
    expect(runFallback).toHaveBeenCalledOnce();
    expect(r).toMatchObject({
      source: 'claude_api',
      confidence: 'high',
      best_amount_cents: 75000,
      best_vendor: 'Northwind Materials',
      model: 'claude-sonnet-4-6',
      cost_cents: 1.05,
    });
    // Local candidates are retained for approver context.
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(logCost).toHaveBeenCalledWith(1.05, 'claude-sonnet-4-6');
  });

  it('HIGH local → fallback NOT invoked', async () => {
    const runFallback = vi.fn(async () => ({ error: 'should not run' }));
    const r = await extractFromRequest(
      { bodyText: HIGH_INVOICE, attachments: [] },
      withFallback(runFallback),
    );
    expect(runFallback).not.toHaveBeenCalled();
    expect(r.source).toBe('local');
  });

  it('LOW local + fallback error → keep local low, attach error', async () => {
    const r = await extractFromRequest(
      { bodyText: LOW_DISAGREE_INVOICE, attachments: [] },
      withFallback(async () => ({ error: 'claude_fallback_failed: timeout' })),
    );
    expect(r).toMatchObject({
      source: 'local',
      confidence: 'low',
      best_amount_cents: 75000,
      error: 'claude_fallback_failed: timeout',
    });
  });

  it('FAILED local + fallback error → failed, null, error (spec failure mode)', async () => {
    const r = await extractFromRequest(
      { bodyText: FAILED_INVOICE, attachments: [] },
      withFallback(async () => ({ error: 'claude_fallback_failed: transport' })),
    );
    expect(r).toMatchObject({
      source: 'local',
      confidence: 'failed',
      best_amount_cents: null,
      error: 'claude_fallback_failed: transport',
    });
  });
});

describe('runClaudeFallback — model-call seam (mocked, no network)', () => {
  it('parses structured JSON and prices the call from token usage', async () => {
    const modelCall: ExtractionModelCall = async () => ({
      text: '{"amount_cents": 43210, "vendor": "Widget Supply Co", "confidence": "high", "reasoning": "single clear total"}',
      inputTokens: 1000,
      outputTokens: 500,
    });
    const r = await runClaudeFallback(
      { bodyText: PLAIN_TEXT_EMAIL, attachmentTexts: [], images: [] },
      modelCall,
    );
    expect(r).toMatchObject({ amount_cents: 43210, vendor: 'Widget Supply Co', confidence: 'high' });
    // 1000 * 0.0003 + 500 * 0.0015 = 0.3 + 0.75 = 1.05 cents.
    if ('cost_cents' in r) expect(r.cost_cents).toBeCloseTo(1.05, 4);
  });

  it('tolerates prose around the JSON object', async () => {
    const modelCall: ExtractionModelCall = async () => ({
      text: 'Here is the extraction:\n{"amount_cents": 108000, "vendor": "Acme", "confidence": "medium", "reasoning": "x"}\nDone.',
      inputTokens: 10,
      outputTokens: 10,
    });
    const r = await runClaudeFallback({ bodyText: '', attachmentTexts: [], images: [] }, modelCall);
    expect(r).toMatchObject({ amount_cents: 108000, confidence: 'medium' });
  });

  it('unparseable response → error, never thrown', async () => {
    const modelCall: ExtractionModelCall = async () => ({
      text: 'I could not read the invoice.',
      inputTokens: 5,
      outputTokens: 5,
    });
    const r = await runClaudeFallback({ bodyText: '', attachmentTexts: [], images: [] }, modelCall);
    expect(r).toEqual({ error: 'claude_fallback_unparseable_response' });
  });

  it('model-call throw (timeout/transport) → error, never thrown', async () => {
    const modelCall: ExtractionModelCall = async () => {
      throw new Error('Request timed out');
    };
    const r = await runClaudeFallback({ bodyText: '', attachmentTexts: [], images: [] }, modelCall);
    expect(r).toEqual({ error: 'claude_fallback_failed: Request timed out' });
  });
});
