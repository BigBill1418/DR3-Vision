// ADR-0067 §3.2 D5 — the document classifier.
//
// ── Classify ONCE, confirm ONCE, then LOCKED ────────────────────────────────
// The classifier PROPOSES. A human CONFIRMS. After that the kind is registered
// and stable and is never asked about again — that is an explicit DO-NOT, and it
// is what makes the feature usable: a system that re-asks "what is this?" every
// time a workbook changes is a system Bill stops answering.
//
// The only thing that reopens a registered classification is a MATERIAL
// STRUCTURE change, and even then it surfaces as a D7 anomaly (`parse_broken`)
// rather than as a fresh question.
//
// ── The hybrid, ordered (mirrors AP Amendment 5, D-M5-2) ────────────────────
// Local heuristics first — filename, sheet names, header vocabulary. They are
// free, instant, offline, and they are RIGHT for the documents this system
// actually receives, which have stable names and stable column headers. The
// Claude API is consulted only when local confidence is weak, and only when a
// key is configured.
//
// ── `unknown` is a first-class outcome, not a failure ───────────────────────
// Bill pre-registers nothing. A newly shared document Vision has never seen is
// the NORMAL case, so `unknown` must be graceful: it waits for him. It does not
// error, it does not page, and above all it does not guess wildly — a confident
// wrong classification is far worse than an honest "I don't know", because the
// wrong one gets auto-applied afterwards under D6.

import type Anthropic from '@anthropic-ai/sdk';
import {
  apExtractionClaudeModel,
  apExtractionClaudeTimeoutMs,
  apExtractionFallbackEnabled,
} from '@/lib/ap/extraction/config';
import type { ParseSummary } from './parse';

/**
 * The document vocabulary (D5).
 *
 * `vendor_invoice` is in the list precisely so it can be RECOGNIZED and
 * REFUSED. It is not routed here — ADR-0046's AP mailbox is its address — and
 * detecting it lets Vision say where it should have gone instead of silently
 * filing a payable as a data source.
 */
export const DOC_KINDS = [
  'daily_log_workbook',
  'ap_history_report',
  'equipment_inventory',
  'rate_table',
  'mrc_invoice',
  'vendor_invoice',
  'unknown',
] as const;

export type DocKind = (typeof DOC_KINDS)[number];

export function isDocKind(v: string): v is DocKind {
  return (DOC_KINDS as readonly string[]).includes(v);
}

/** Where a misdirected vendor invoice actually belongs. Stated, never implied. */
export const VENDOR_INVOICE_CORRECT_ADDRESS = 'ap@svdp.us';

export interface Classification {
  kind: DocKind;
  /** 0..1. Below {@link CONFIRM_CONFIDENCE_FLOOR} the local pass defers to Claude. */
  confidence: number;
  /** Site NAME as detected ('Eugene' | 'Woodland'), resolved to an id by the caller. */
  site: string | null;
  /** Reporting period, e.g. `2026-07`. Null when the document does not name one. */
  period: string | null;
  reasoning: string;
  source: 'local' | 'claude';
}

/** Below this, the local pass is not trusted on its own and Claude is consulted. */
export const CONFIRM_CONFIDENCE_FLOOR = 0.7;

export interface ClassifierInput {
  filename: string;
  /** Folder path, if any. A file's location is often the strongest signal. */
  pathHint: string | null;
  contentType: string | null;
  summary: ParseSummary | null;
}

// ── Local heuristics ────────────────────────────────────────────────────────

interface Rule {
  kind: DocKind;
  /** Signals in the filename/path. A path match is deliberately weighted equally. */
  name: RegExp[];
  /** Signals in sheet names and column headers. */
  structure: RegExp[];
}

/**
 * The rules are intentionally narrow. A loose rule that matches a lot produces
 * confident wrong answers, and under D6 a confident wrong answer flows straight
 * through to downstream numbers. `unknown` costs Bill one click; a wrong
 * `daily_log_workbook` costs a reconciliation.
 */
const RULES: Rule[] = [
  {
    kind: 'daily_log_workbook',
    name: [/daily[\s_-]*log/i, /\bdaily\b.*\b(log|sheet|workbook)\b/i],
    structure: [/\binbound\b/i, /\boutbound\b/i, /\bmattress(es)?\b/i, /\bunits\b/i, /\beod\b/i],
  },
  {
    kind: 'ap_history_report',
    name: [/\bap\b.*\bhistory\b/i, /accounts?[\s_-]*payable/i, /\bvendor\b.*\bhistory\b/i],
    structure: [/\bvendor\b/i, /\binvoice[\s_]*(number|date|amount)\b/i, /\bpaid\b/i],
  },
  {
    kind: 'equipment_inventory',
    name: [/\bequipment\b/i, /\basset\b.*\b(list|register|inventory)\b/i, /\bfleet\b.*\blist\b/i],
    structure: [
      /\bserial\b/i,
      /\bmake\b/i,
      /\bmodel\b/i,
      /\basset[\s_]*(id|tag)\b/i,
      /\bhour[s]?\b/i,
    ],
  },
  {
    kind: 'rate_table',
    name: [/\brate[s]?\b/i, /\bpricing\b/i, /\btariff\b/i, /\bfee[s]?[\s_-]*schedule\b/i],
    structure: [/\brate\b/i, /\bper[\s_]*(unit|ton|lb|mile)\b/i, /\beffective[\s_]*date\b/i],
  },
  {
    kind: 'mrc_invoice',
    name: [
      /\bmrc\b/i,
      /mattress[\s_]*recycling[\s_]*council/i,
      /\bbye[\s_-]*bye[\s_-]*mattress\b/i,
    ],
    structure: [/\bmrc\b/i, /\bhaul\b/i, /\bclaim\b/i],
  },
  {
    kind: 'vendor_invoice',
    name: [/\binvoice\b/i, /\bbill\b/i, /\bstatement\b/i],
    structure: [
      /\bamount[\s_]*due\b/i,
      /\bremit[\s_]*to\b/i,
      /\bnet[\s_]*\d+\b/i,
      /\bpo[\s_]*(number|#)/i,
    ],
  },
];

/** Eugene and Woodland only. Stockton is excluded from V2 entirely (hard rule #1). */
const SITE_PATTERNS: { site: string; pattern: RegExp }[] = [
  { site: 'Eugene', pattern: /\beugene\b|\beug\b/i },
  { site: 'Woodland', pattern: /\bwoodland\b|\bwdl\b/i },
];

/** `2026-07`, `July 2026`, `07-2026`, `FY26 Q3` → normalized `YYYY-MM` where possible. */
export function detectPeriod(haystack: string): string | null {
  const iso = haystack.match(/\b(20\d{2})[-_/](0[1-9]|1[0-2])\b/);
  if (iso?.[1] && iso[2]) return `${iso[1]}-${iso[2]}`;

  const months =
    'january|february|march|april|may|june|july|august|september|october|november|december';
  const named = haystack.match(new RegExp(`\\b(${months})\\w*\\s+(20\\d{2})\\b`, 'i'));
  if (named?.[1] && named[2]) {
    const idx = months.split('|').indexOf(named[1].toLowerCase());
    if (idx >= 0) return `${named[2]}-${String(idx + 1).padStart(2, '0')}`;
  }

  const numeric = haystack.match(/\b(0[1-9]|1[0-2])[-_/](20\d{2})\b/);
  if (numeric?.[1] && numeric[2]) return `${numeric[2]}-${numeric[1]}`;

  const yearOnly = haystack.match(/\b(20\d{2})\b/);
  return yearOnly?.[1] ?? null;
}

export function detectSite(haystack: string): string | null {
  for (const { site, pattern } of SITE_PATTERNS) {
    if (pattern.test(haystack)) return site;
  }
  return null;
}

/**
 * Purely local classification. No I/O, exhaustively unit-testable.
 *
 * Scoring: a filename/path hit is worth more than a structural hit (people name
 * files deliberately; column headers repeat across document types), and the
 * winner must clear the runner-up to be confident. Two rules scoring equally is
 * the definition of ambiguous, and ambiguous must not read as certain.
 */
export function classifyLocally(input: ClassifierInput): Classification {
  const nameHay = `${input.filename} ${input.pathHint ?? ''}`;
  const structureHay = [
    ...(input.summary?.sheets.map((s) => s.name) ?? []),
    ...(input.summary?.sheets.flatMap((s) => s.headers) ?? []),
    input.summary?.textSample ?? '',
  ].join(' ');

  const scores = RULES.map((rule) => {
    const nameHits = rule.name.filter((r) => r.test(nameHay)).length;
    const structureHits = rule.structure.filter((r) => r.test(structureHay)).length;
    return { kind: rule.kind, score: nameHits * 2 + structureHits, nameHits, structureHits };
  }).sort((a, b) => b.score - a.score);

  const best = scores[0];
  const runnerUp = scores[1];
  const haystack = `${nameHay} ${structureHay}`;

  if (!best || best.score === 0) {
    return {
      kind: 'unknown',
      confidence: 0,
      site: detectSite(nameHay),
      period: detectPeriod(nameHay),
      reasoning:
        'Nothing in the filename, folder path, sheet names or column headers matched a known document type.',
      source: 'local',
    };
  }

  // ── Confidence = EVIDENCE × DOMINANCE ───────────────────────────────────
  //
  // Both factors are needed, and an earlier additive version proved it: summing
  // "how much matched" with "by how much it won" let a document that matched
  // several vendor-invoice words AND several rate-table words score 0.95, because
  // the strength of the winner drowned out the fact that something else matched
  // almost as well. Ambiguity read as certainty — which under D6 auto-applies.
  //
  // Multiplying fixes that: dominance is a fraction, so a close runner-up caps
  // confidence no matter how much evidence there was.
  //   evidence  — is there enough signal at all? (one name hit is not much)
  //   dominance — did this kind actually beat the field, or merely lead it?
  const runnerUpScore = runnerUp?.score ?? 0;
  const evidence = Math.min(1, 0.4 + best.score * 0.15);
  const dominance = best.score / (best.score + runnerUpScore);
  const confidence = Math.min(0.95, 0.95 * evidence * dominance);

  return {
    kind: best.kind,
    confidence,
    site: detectSite(haystack),
    period: detectPeriod(nameHay) ?? detectPeriod(structureHay),
    reasoning:
      `Matched ${best.nameHits} filename/path signal(s) and ${best.structureHits} structural signal(s) for ` +
      `${best.kind}${runnerUp && runnerUp.score > 0 ? `; next best was ${runnerUp.kind} (${runnerUp.score})` : ''}.`,
    source: 'local',
  };
}

// ── Claude fallback (D-M5-2 shape) ──────────────────────────────────────────

/** Injectable model-call seam. Tests supply a fake; the SDK is never loaded. */
export interface ClassifierModelCall {
  (args: {
    model: string;
    timeoutMs: number;
    system: string;
    content: Anthropic.ContentBlockParam[];
  }): Promise<{ text: string }>;
}

const SYSTEM_PROMPT =
  'You classify business documents for a mattress-recycling operation. Respond with ONLY a JSON object ' +
  'and no other prose. If the document does not clearly match one of the listed kinds, answer "unknown" — ' +
  'a wrong confident answer is much worse than an honest unknown, because downstream systems act on it ' +
  'automatically.';

function userPrompt(input: ClassifierInput): string {
  return (
    'Classify this document.\n\n' +
    `kind must be exactly one of: ${DOC_KINDS.join(', ')}.\n` +
    '- daily_log_workbook: a daily operations log of mattresses received/processed at a facility.\n' +
    '- ap_history_report: a historical listing of accounts-payable invoices.\n' +
    '- equipment_inventory: a register of physical assets/equipment.\n' +
    '- rate_table: pricing or rates, usually with effective dates.\n' +
    '- mrc_invoice: paperwork from the Mattress Recycling Council.\n' +
    '- vendor_invoice: a single bill from a supplier requesting payment.\n' +
    '- unknown: anything you are not confident about.\n\n' +
    'site must be exactly "Eugene", "Woodland", or null. No other site exists.\n' +
    'period should be "YYYY-MM" when the document covers a specific month, otherwise null.\n\n' +
    'Return JSON with fields: kind (string), confidence (number 0-1), site (string|null), ' +
    'period (string|null), reasoning (string).\n\n' +
    `Filename: ${input.filename}\n` +
    `Folder path: ${input.pathHint ?? '(none)'}\n` +
    `Content type: ${input.contentType ?? '(unknown)'}\n` +
    contentBlock(input)
  );
}

/**
 * Render the parsed content — and, when there is none, say so in terms that
 * cannot be mistaken for "the document is empty".
 *
 * `Sheets: (none) / Row count: 0` reads identically whether the workbook was
 * read and found blank or was never read at all. On 2026-07-29 the sweep handed
 * this function a null summary for a file it had not fetched yet; the model
 * answered, accurately for its input, "the workbook is completely empty" — about
 * a workbook holding 40 sheets and 2,117 rows. The model was not wrong. The
 * input was a lie. Absence of evidence is rendered as absence of evidence.
 */
function contentBlock(input: ClassifierInput): string {
  if (!input.summary) {
    return (
      'Parsed content: NOT AVAILABLE.\n' +
      'This document has not been read — it has not been downloaded yet, or its format could not be ' +
      'parsed. This does NOT mean the document is empty, and you must not say or imply that it is. ' +
      'Classify from the filename, folder path and content type alone, and lower your confidence to ' +
      'reflect that you have not seen the contents.'
    );
  }
  return (
    'Parsed content: AVAILABLE (the figures below are what the document actually contains).\n' +
    `Sheets: ${input.summary.sheets.map((s) => s.name).join(', ') || '(the file has no sheets)'}\n` +
    `Column headers: ${
      input.summary.sheets
        .flatMap((s) => s.headers)
        .slice(0, 80)
        .join(' | ') || '(no column headers found)'
    }\n` +
    `Row count: ${input.summary.totalRows}\n\n` +
    `Content sample:\n${input.summary.textSample.slice(0, 4000)}`
  );
}

const defaultModelCall: ClassifierModelCall = async ({ model, timeoutMs, system, content }) => {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  const client = new AnthropicClient({
    apiKey: process.env['ANTHROPIC_API_KEY'],
    timeout: timeoutMs,
    // Retries disabled so one timeout budget is not silently multiplied.
    maxRetries: 0,
  });
  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text };
};

/** Parse the model's JSON. Anything unparseable or off-vocabulary → null. */
function parseClassification(text: string): Omit<Classification, 'source'> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const rawKind = obj['kind'];
  // An off-vocabulary kind becomes `unknown`, never a new kind invented at
  // runtime: the vocabulary is a contract with the confirm queue and the
  // guardrail, not a suggestion.
  const kind: DocKind = typeof rawKind === 'string' && isDocKind(rawKind) ? rawKind : 'unknown';

  const rawConfidence = obj['confidence'];
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0.5;

  const rawSite = obj['site'];
  // Only the two real sites survive. A hallucinated third site must never reach
  // a site-scoped column (hard rule #2).
  const site = rawSite === 'Eugene' || rawSite === 'Woodland' ? rawSite : null;

  const rawPeriod = obj['period'];
  const period = typeof rawPeriod === 'string' && rawPeriod.trim() ? rawPeriod.trim() : null;

  return {
    kind,
    confidence: kind === 'unknown' ? Math.min(confidence, 0.5) : confidence,
    site,
    period,
    reasoning: typeof obj['reasoning'] === 'string' ? obj['reasoning'] : '',
  };
}

export interface ClassifyDeps {
  modelCall?: ClassifierModelCall;
  fallbackEnabled?: () => boolean;
}

/**
 * Classify a document: local first, Claude only when local is weak.
 *
 * NEVER throws. A fallback failure keeps the local answer and records the error
 * — classification is an input to a human decision, not a gate, so degrading to
 * "unknown, and here is why" is always better than failing the sweep.
 */
export async function classifyDocument(
  input: ClassifierInput,
  deps: ClassifyDeps = {},
): Promise<{ classification: Classification; error: string | null }> {
  const local = classifyLocally(input);
  const enabled = deps.fallbackEnabled ?? apExtractionFallbackEnabled;

  if (local.confidence >= CONFIRM_CONFIDENCE_FLOOR) return { classification: local, error: null };
  if (!enabled()) {
    return {
      classification: local.confidence > 0 ? local : { ...local, kind: 'unknown' },
      error: null,
    };
  }

  try {
    const call = deps.modelCall ?? defaultModelCall;
    const { text } = await call({
      model: apExtractionClaudeModel(),
      timeoutMs: apExtractionClaudeTimeoutMs(),
      system: SYSTEM_PROMPT,
      content: [{ type: 'text', text: userPrompt(input) }],
    });
    const parsed = parseClassification(text);
    if (!parsed) {
      return { classification: local, error: 'classifier_unparseable_response' };
    }
    return { classification: { ...parsed, source: 'claude' }, error: null };
  } catch (e) {
    // Keep the local proposal. It is weak, which is why the queue exists.
    return {
      classification: local,
      error: `classifier_fallback_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
