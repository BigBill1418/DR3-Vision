// ADR-0046 Amendment 5 (D-M5-2) — SYNTHETIC extraction fixtures. Every vendor
// name, amount, and identifier here is invented for tests: NO real DR3, vendor,
// or haul (H-####) identifiers appear anywhere (hard rule: fixtures are synthetic).
// One fixture per confidence tier plus the edge cases the spec calls out:
// scanned-image (no text), plain-text-email, and multi-page PDF.

import type { NormFileAttachment } from '@/lib/msgraph-mail';

/// HIGH — exactly one canonical Total, and it's the only amount in the document.
export const HIGH_INVOICE = [
  'Invoice from Widget Supply Co',
  'Invoice #WS-0001',
  'Total Due: $1,250.00',
  'Thank you for your business.',
].join('\n');

/// MEDIUM — one canonical Total, but Subtotal/Tax add other distinct candidates
/// (the `\b` guard keeps "Subtotal" from registering as a Total).
export const MEDIUM_INVOICE = [
  'Acme Parts LLC',
  'Subtotal: $1,000.00',
  'Tax: $80.00',
  'Total: $1,080.00',
].join('\n');

/// LOW (disagreement) — two canonical labels name different amounts.
export const LOW_DISAGREE_INVOICE = [
  'Northwind Materials',
  'Total: $500.00',
  'Balance Due: $750.00',
].join('\n');

/// LOW (bare only) — amounts present but no canonical label anchors a total.
export const LOW_BARE_INVOICE = [
  'Payment received for recent order.',
  'Line item A 120.00',
  'Line item B 55.00',
].join('\n');

/// FAILED — no dollar amounts at all (e.g. a cover note).
export const FAILED_INVOICE = 'Please find the attached invoice for last month.';

/// Plain-text email (no attachment) carrying a single canonical Amount Due.
export const PLAIN_TEXT_EMAIL =
  'Hello, our records show an Amount Due: $432.10 for services rendered. Please remit at your earliest convenience.';

/// Multi-page PDF simulated as page texts; the total lands on the last page,
/// with only line detail on page 1.
export const MULTI_PAGE_PDF_PAGES = [
  'Evergreen Logistics\nPage 1 of 2\nService line items follow.',
  'Page 2 of 2\nAmount Due: $3,499.99\nRemit within 30 days.',
];
export const MULTI_PAGE_PDF_TEXT = MULTI_PAGE_PDF_PAGES.join('\n\n');

/// Build a normalized file attachment for pipeline tests. `contentBytesBase64` is
/// a placeholder — the pipeline's pdf/image handling is driven by injected seams,
/// not by decoding these bytes.
export function fileAttachment(
  name: string,
  contentType: string | null,
): NormFileAttachment {
  return {
    kind: 'file',
    id: `att-${name}`,
    name,
    contentType,
    size: 1024,
    contentBytesBase64: 'QUFBQQ==',
  };
}
