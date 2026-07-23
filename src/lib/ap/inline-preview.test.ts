// ADR-0046 Amendment 6 — shared inline-preview predicates + presign freshness.
// Covers the LIVE-confirmed defect (octet-stream .pdf hidden) and the parameterized
// content-type, plus the negative (non-pdf octet-stream stays download) and the
// stale-URL re-mint decision.

import { describe, expect, it } from 'vitest';
import {
  AP_ATTACHMENT_URL_TTL_SECONDS,
  PRESIGN_STALE_SKEW_SECONDS,
  effectiveInlineContentType,
  isInlineImage,
  isInlinePdf,
  isInlinePreviewable,
  isPresignStale,
  normalizeMime,
} from './inline-preview';

describe('normalizeMime', () => {
  it('strips parameters, trims, lowercases; null/empty → ""', () => {
    expect(normalizeMime('application/pdf; name="inv.pdf"')).toBe('application/pdf');
    expect(normalizeMime('  APPLICATION/PDF ')).toBe('application/pdf');
    expect(normalizeMime(null)).toBe('');
    expect(normalizeMime(undefined)).toBe('');
    expect(normalizeMime('')).toBe('');
  });
});

describe('isInlinePdf', () => {
  it('LIVE case — octet-stream stored, .pdf filename → inline', () => {
    expect(isInlinePdf('application/octet-stream', 'Invoice-4471.PDF')).toBe(true);
  });
  it('empty content-type + .pdf filename → inline', () => {
    expect(isInlinePdf('', 'scan.pdf')).toBe(true);
    expect(isInlinePdf(null, 'scan.pdf')).toBe(true);
  });
  it('parameterized application/pdf; name="x" → inline', () => {
    expect(isInlinePdf('application/pdf; name="inv.pdf"', 'inv.pdf')).toBe(true);
  });
  it('clean application/pdf → inline regardless of filename', () => {
    expect(isInlinePdf('application/pdf', null)).toBe(true);
  });
  it('octet-stream with a NON-pdf filename (.xlsx) → NOT inline', () => {
    expect(isInlinePdf('application/octet-stream', 'ledger.xlsx')).toBe(false);
  });
  it('octet-stream with no filename → NOT inline', () => {
    expect(isInlinePdf('application/octet-stream', null)).toBe(false);
  });
  it('a real spreadsheet type is never a PDF', () => {
    expect(
      isInlinePdf(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ledger.xlsx',
      ),
    ).toBe(false);
  });
});

describe('isInlineImage', () => {
  it('real image types inline', () => {
    for (const ct of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']) {
      expect(isInlineImage(ct, null)).toBe(true);
    }
  });
  it('octet-stream + image extension → inline; + .pdf → not an image', () => {
    expect(isInlineImage('application/octet-stream', 'photo.JPG')).toBe(true);
    expect(isInlineImage('application/octet-stream', 'scan.pdf')).toBe(false);
  });
});

describe('isInlinePreviewable', () => {
  it('text/csv is never previewable', () => {
    expect(isInlinePreviewable('text/csv', 'data.csv')).toBe(false);
  });
});

describe('effectiveInlineContentType — canonical wire Content-Type', () => {
  it('octet-stream .pdf → application/pdf (so the frame renders, not downloads)', () => {
    expect(effectiveInlineContentType('application/octet-stream', 'inv.pdf')).toBe(
      'application/pdf',
    );
  });
  it('parameterized pdf → application/pdf', () => {
    expect(effectiveInlineContentType('application/pdf; name="x"', 'x.pdf')).toBe('application/pdf');
  });
  it('image/jpg canonicalizes to image/jpeg', () => {
    expect(effectiveInlineContentType('image/jpg', null)).toBe('image/jpeg');
  });
  it('octet-stream image extension → canonical image mime', () => {
    expect(effectiveInlineContentType('application/octet-stream', 'p.jpeg')).toBe('image/jpeg');
    expect(effectiveInlineContentType('application/octet-stream', 'p.png')).toBe('image/png');
  });
  it('real image passes through', () => {
    expect(effectiveInlineContentType('image/png', 'p.png')).toBe('image/png');
  });
  it('non-inline (octet-stream .xlsx, csv) → null', () => {
    expect(effectiveInlineContentType('application/octet-stream', 'ledger.xlsx')).toBeNull();
    expect(effectiveInlineContentType('text/csv', 'data.csv')).toBeNull();
  });
});

describe('isPresignStale — re-mint before expiry', () => {
  const now = 1_000_000_000_000;
  it('fresh URL (just minted) is NOT stale', () => {
    expect(isPresignStale(now, AP_ATTACHMENT_URL_TTL_SECONDS, now)).toBe(false);
  });
  it('within the skew window is NOT stale', () => {
    const ageMs = (AP_ATTACHMENT_URL_TTL_SECONDS - PRESIGN_STALE_SKEW_SECONDS - 1) * 1000;
    expect(isPresignStale(now - ageMs, AP_ATTACHMENT_URL_TTL_SECONDS, now)).toBe(false);
  });
  it('at/after TTL − skew IS stale → resolve() re-mints before reuse', () => {
    const ageMs = (AP_ATTACHMENT_URL_TTL_SECONDS - PRESIGN_STALE_SKEW_SECONDS) * 1000;
    expect(isPresignStale(now - ageMs, AP_ATTACHMENT_URL_TTL_SECONDS, now)).toBe(true);
  });
  it('an expired URL (old 300s TTL cached, 10 min later) IS stale', () => {
    expect(isPresignStale(now - 600_000, 300, now)).toBe(true);
  });
  it('a non-positive/NaN TTL is defensively stale', () => {
    expect(isPresignStale(now, 0, now)).toBe(true);
    expect(isPresignStale(now, Number.NaN, now)).toBe(true);
  });
});
