// Shared money formatting for invoice surfaces (pure — safe for server pages
// and 'use client' components alike).
//
// One formatter so every surface Mary eyeball-matches renders negatives the
// same way — accountancy parentheses, matching the xlsx numFmt
// `#,##0.00;(#,##0.00)` in render-xlsx.ts. (The repo had grown several ad-hoc
// cents formatters with mixed minus-sign vs parentheses semantics; invoice
// surfaces standardize on this one.)

/** Integer cents → `$1,234.56`, negatives as `($1,234.56)`. */
export function formatUsdCents(cents: number): string {
  const v = (Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return cents < 0 ? `($${v})` : `$${v}`;
}
