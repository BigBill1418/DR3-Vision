// ADR-0046 Amendment 6 — shared inline-preview predicates + presign freshness.
// Covers the LIVE-confirmed defect (octet-stream .pdf hidden) and the parameterized
// content-type, plus the negative (non-pdf octet-stream stays download) and the
// stale-URL re-mint decision.
//
// ADR-0132 D3 — plus the magic-byte sniff and the sniff → MIME → extension
// resolution order that the decision-mail stamp path dispatches on.

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
  resolveOverlayType,
  sniffBinaryType,
} from './inline-preview';

/** Bytes that really are what they claim — the leading signature plus filler. */
function magic(...head: number[]): Uint8Array {
  return Uint8Array.from([...head, 0x0a, 0x00, 0x01, 0x02, 0x03, 0x04]);
}
const PDF_BYTES = magic(0x25, 0x50, 0x44, 0x46, 0x2d); // %PDF-
const PNG_BYTES = magic(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG_BYTES = magic(0xff, 0xd8, 0xff, 0xe0);
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]); // RIFF....WEBP
const CSV_BYTES = new TextEncoder().encode('date,vendor,amount\n2026-09-15,Ramos,441.00\n');

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
    expect(effectiveInlineContentType('application/pdf; name="x"', 'x.pdf')).toBe(
      'application/pdf',
    );
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

describe('sniffBinaryType — the bytes outrank the label (ADR-0132 D3)', () => {
  it('reads the four formats the AP module can overlay', () => {
    expect(sniffBinaryType(PDF_BYTES)).toBe('application/pdf');
    expect(sniffBinaryType(PNG_BYTES)).toBe('image/png');
    expect(sniffBinaryType(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffBinaryType(WEBP_BYTES)).toBe('image/webp');
  });
  it('an unknown signature is null — NOT a negative fact about the file', () => {
    expect(sniffBinaryType(CSV_BYTES)).toBeNull();
    expect(sniffBinaryType(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // a zip/docx
  });
  it('absent or truncated bytes are null, never a throw', () => {
    expect(sniffBinaryType(null)).toBeNull();
    expect(sniffBinaryType(undefined)).toBeNull();
    expect(sniffBinaryType(new Uint8Array(0))).toBeNull();
    expect(sniffBinaryType(Uint8Array.from([0x25, 0x50]))).toBeNull(); // "%P" only
    // RIFF with no WEBP fourcc (a .wav) is not an image.
    expect(
      sniffBinaryType(
        Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]),
      ),
    ).toBeNull();
  });
});

describe('resolveOverlayType — sniff → MIME → extension (ADR-0132 D3)', () => {
  it('THE LIVE 9: octet-stream + .PDF name + real PDF bytes → application/pdf', () => {
    expect(
      resolveOverlayType(PDF_BYTES, 'application/octet-stream', 'Invoice_IN-0320844.PDF'),
    ).toBe('application/pdf');
  });
  it('the bytes WIN over a confident wrong label: JPEG bytes labelled application/pdf', () => {
    expect(resolveOverlayType(JPEG_BYTES, 'application/pdf', 'invoice.pdf')).toBe('image/jpeg');
  });
  it('the bytes WIN over a wrong filename too: PDF bytes named .csv', () => {
    expect(resolveOverlayType(PDF_BYTES, 'text/csv', 'export.csv')).toBe('application/pdf');
  });
  it('unknown bytes fall through to the MIME, then the extension', () => {
    expect(resolveOverlayType(CSV_BYTES, 'application/pdf', 'x.pdf')).toBe('application/pdf');
    expect(resolveOverlayType(CSV_BYTES, 'application/octet-stream', 'x.pdf')).toBe(
      'application/pdf',
    );
    expect(resolveOverlayType(CSV_BYTES, 'image/jpg', 'x')).toBe('image/jpeg');
  });
  it('a genuinely non-overlayable original resolves to null (→ cover + original)', () => {
    expect(resolveOverlayType(CSV_BYTES, 'text/csv', 'ledger.csv')).toBeNull();
    expect(resolveOverlayType(CSV_BYTES, 'application/octet-stream', 'ledger.xlsx')).toBeNull();
  });
  it('with no bytes in hand it degrades to the shared preview predicate', () => {
    expect(resolveOverlayType(null, 'application/octet-stream', 'inv.pdf')).toBe('application/pdf');
    expect(resolveOverlayType(null, 'text/csv', 'ledger.csv')).toBeNull();
  });
});
