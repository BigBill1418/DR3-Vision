// ADR-0046 Amendment 5 (D-M5-2 §1/§2) — local invoice-amount extraction:
// pdf-parse text extraction over PDF attachments + regex heuristics that score a
// best-guess total against the four canonical invoice labels. Pure and
// deterministic: `scanTextSources` takes already-extracted text and returns a
// `LocalExtraction`; the only I/O seam is `extractPdfText` (dynamic-imported so
// the heavy pdfjs dependency never loads until a PDF actually needs parsing, and
// so tests can drive the scorer on plain text without the binary). Confidence
// tiers are the spec's exactly — HIGH / MEDIUM / LOW / FAILED (§2).

import type { ExtractionCandidate, ExtractionConfidence } from './types';

/// One text stream to scan (the email body, or the extracted text of one PDF).
export interface TextSource {
  /// Human label used in candidate `source_hint`s, e.g. "email body" or
  /// "attachment: invoice.pdf".
  name: string;
  text: string;
}

/// Pure local scan result. `best_vendor` is intentionally absent — the local
/// heuristic scores amounts only; vendor inference is the Claude fallback's job.
export interface LocalExtraction {
  best_amount_cents: number | null;
  confidence: ExtractionConfidence;
  candidates: ExtractionCandidate[];
}

/// The four canonical total labels (D-M5-2 §1). `\b` guards against `Subtotal`
/// masquerading as `Total`. Each captures the trailing USD amount in group 1.
const LABEL_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: 'Grand Total', re: /\bGrand Total\b:?\s*(\$?\d[\d,]*\.\d{2})/gi },
  { label: 'Amount Due', re: /\bAmount Due\b:?\s*(\$?\d[\d,]*\.\d{2})/gi },
  { label: 'Balance Due', re: /\bBalance Due\b:?\s*(\$?\d[\d,]*\.\d{2})/gi },
  // `Total` and `Total Due` — must come last so `Grand Total` claims its own
  // label first (both would otherwise match the same amount; the dedupe below
  // makes that harmless, but the more-specific label is the better hint).
  { label: 'Total', re: /\bTotal(?: Due)?\b:?\s*(\$?\d[\d,]*\.\d{2})/gi },
];

/// Any USD-shaped amount anywhere in the text (labeled or bare). `(?!\d)` stops a
/// 2-decimal match from swallowing a longer fraction.
const ANY_AMOUNT_PATTERN = /\$?\d[\d,]*\.\d{2}(?!\d)/g;

/// Parse a USD string ("$1,234.56", "1234.56") to integer cents. Returns null on
/// anything unparseable. Rounds to avoid binary-float drift (12.10 → 1210, never
/// 1209).
export function parseUsdToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^\d+\.\d{2}$/.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

interface LabeledHit {
  cents: number;
  hint: string;
}

/// Scan every source for the four canonical labels. Returns one hit per label
/// occurrence (duplicates across labels are collapsed later by cents value).
function collectLabeled(sources: readonly TextSource[]): LabeledHit[] {
  const hits: LabeledHit[] = [];
  for (const src of sources) {
    for (const { label, re } of LABEL_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src.text)) !== null) {
        const captured = m[1];
        if (captured === undefined) continue;
        const cents = parseUsdToCents(captured);
        if (cents !== null) hits.push({ cents, hint: `${src.name}: ${label} line` });
      }
    }
  }
  return hits;
}

/// Every distinct USD amount in the document, in first-seen order, each keyed to
/// where it was found — the "capture ALL candidates for disambiguation" of §1.
function collectCandidates(sources: readonly TextSource[]): ExtractionCandidate[] {
  const byCents = new Map<number, ExtractionCandidate>();
  for (const src of sources) {
    const re = new RegExp(ANY_AMOUNT_PATTERN.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src.text)) !== null) {
      const cents = parseUsdToCents(m[0]);
      if (cents === null || byCents.has(cents)) continue;
      byCents.set(cents, { amount_cents: cents, source_hint: `${src.name}: amount` });
    }
  }
  return [...byCents.values()];
}

/// Score a best-guess total + confidence tier over the given text sources.
/// D-M5-2 §2, implemented as four disjoint cases:
///   FAILED — no USD amounts at all.
///   HIGH   — exactly one distinct canonical amount AND it's the only distinct
///            amount in the document (nothing to disambiguate against).
///   MEDIUM — exactly one distinct canonical amount, but other distinct amounts
///            also appear (a single match amid multiple candidates).
///   LOW    — canonical amounts disagree (>1 distinct), or none found and only
///            bare amounts were extracted.
/// Best-guess: the canonical amount for HIGH/MEDIUM; the largest amount for the
/// two LOW cases (invoice totals are typically the largest figure — and the
/// Claude fallback fires on LOW regardless, so this is only a pre-fill hint).
export function scanTextSources(sources: readonly TextSource[]): LocalExtraction {
  const candidates = collectCandidates(sources);
  if (candidates.length === 0) {
    return { best_amount_cents: null, confidence: 'failed', candidates: [] };
  }

  const labeled = collectLabeled(sources);
  const distinctLabeled = [...new Set(labeled.map((h) => h.cents))];
  const allCents = candidates.map((c) => c.amount_cents);
  const maxCents = Math.max(...allCents);

  if (distinctLabeled.length === 0) {
    // Only bare amounts — no canonical anchor.
    return { best_amount_cents: maxCents, confidence: 'low', candidates };
  }
  if (distinctLabeled.length === 1) {
    const only = distinctLabeled[0]!;
    const confidence: ExtractionConfidence =
      new Set(allCents).size === 1 ? 'high' : 'medium';
    return { best_amount_cents: only, confidence, candidates };
  }
  // Multiple distinct canonical amounts that disagree.
  return { best_amount_cents: Math.max(...distinctLabeled), confidence: 'low', candidates };
}

/// Extract plain text from a PDF's raw bytes via pdf-parse (v2 `PDFParse` API).
/// Dynamic-imported and fully fail-soft: any parse failure (encrypted, scanned
/// image with no text layer, corrupt bytes) returns '' so the caller degrades to
/// FAILED rather than throwing. Never let this reject.
export async function extractPdfText(bytes: Buffer): Promise<string> {
  try {
    const mod = (await import('pdf-parse')) as {
      PDFParse: new (opts: { data: Buffer }) => {
        getText: () => Promise<{ text: string }>;
        destroy: () => Promise<void>;
      };
    };
    const parser = new mod.PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      return result.text ?? '';
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  } catch {
    return '';
  }
}
