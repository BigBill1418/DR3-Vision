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
import { DOC_KINDS, DOC_KIND_DESCRIPTIONS, isDocKind, type DocKind } from './doc-kinds';

// Re-exported so every existing `from '@/lib/doc-ingest/classifier'` import of
// the vocabulary keeps working. The definitions live in `doc-kinds.ts` — see
// that file's header for why.
export { DOC_KINDS, DOC_KIND_DESCRIPTIONS, isDocKind };
export type { DocKind };

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
    // ADR-0069 Am.1 — the first kind absorbed into a typed table. The structure
    // signals are taken from the REAL file's row-2 headers (verified 2026-07-31),
    // not from an assumed shape: `Date of Entry to Yard | Trailer # | Material |
    // Weight (lbs) | Driver | Days in Yard | Exit Date`.
    kind: 'trailer_list',
    name: [/\btrailer\b/i, /\byard\b.*\blist\b/i],
    structure: [/\btrailer\b/i, /\bdays? in yard\b/i, /\bdate of entry\b/i, /\bexit[\s_]*date\b/i],
  },
  {
    // ADR-0069 Am.2. Structure signals from the REAL row-2 headers (verified
    // 2026-07-31). Deliberately requires the maintenance vocabulary and not just
    // the machine name: the same workbook has 28 monthly OPERATING tabs and
    // several derived summary tabs that also say "Terex", and none of them is a
    // maintenance log.
    kind: 'terex_maintenance_log',
    name: [/\bterex\b/i, /maintenance[\s_-]*log/i],
    structure: [
      /\bmeasures? taken\b/i,
      /\bactual repair cost\b/i,
      /\bamount credited\b/i,
      /\bestimated repair time\b/i,
    ],
  },
  {
    // ADR-0080 Phase 2. Signals taken from the REAL file (verified 2026-08-07):
    // the filename "Woodland Data Auditing Tracker (1).xlsx", sheet names that
    // begin "Commodity Audit" ("Commodity Audit 2026" / "Commodity Audit 2025"),
    // the row-1 title banner "Commodity Audit (against Vendor Invoices)", and the
    // row-4 header vocabulary Audited / Initials / 2nd Audit.
    //
    // Deliberately does NOT include a bare `/\bdate\b/`. "Date" appears in the
    // header row of nearly every workbook this system sees, so scoring on it
    // would give this rule points on documents that are nothing like it — which
    // costs confidence on the RIGHT rule (dominance is a fraction) as well as
    // manufacturing evidence for this one. Conservative on purpose: this only
    // ever writes `proposed_*`, and Bill confirms.
    kind: 'commodity_audit_tracker',
    name: [/data[\s_-]*auditing[\s_-]*tracker/i, /commodity[\s_-]*audit/i],
    structure: [
      /\bcommodity audit\b/i,
      /\bagainst vendor invoices\b/i,
      /\baudited\b/i,
      /\b(2nd|second)[\s_-]*audit\b/i,
      /\binitials\b/i,
    ],
  },
  {
    // ADR-0104 §D2. Structure signals read off the REAL header rows of
    // "Woodland Outbound Auditing 2026.xlsx" (measured 2026-08-16 against the
    // archived bytes, not assumed): the header row is on row 1, 2, 4 or 10
    // depending on the sheet, and these four labels are present on all eleven
    // candidate sheets.
    kind: 'outbound_weight_audit',
    name: [/\boutbound\b/i, /\bauditing\b/i],
    structure: [
      /materials:\s*materials id/i,
      /\bbol id\b/i,
      /\btotal outbound weight\b/i,
      /\bdisposition\b/i,
    ],
  },
  {
    // ADR-0104 §D4. Signals from the REAL row-3 headers of "Woodland Invoices
    // tracking.xlsx" (measured 2026-08-16). `present on daily log` is the
    // distinctive one — no other watched document has it.
    kind: 'facility_expense_log',
    name: [/\binvoices?\b[\s_-]*tracking/i],
    structure: [
      /\bpresent on daily log\b/i,
      /\bcredit amt\b/i,
      /\binvoice\s*#/i,
      /\bmachine id\b/i,
    ],
  },
  {
    kind: 'facility_journal',
    name: [/\bjournal\b/i],
    structure: [/\bfacility journal\b/i],
  },
  {
    kind: 'meeting_notes_log',
    name: [/meeting[\s_-]*notes/i],
    structure: [/\bmeeting date\b/i, /\battendees\b/i],
  },
  {
    kind: 'admin_task_tracker',
    name: [/task[\s_-]*lists?/i],
    structure: [/\bproject title\b/i, /%\s*complete/i],
  },
  {
    kind: 'analysis_workbook',
    name: [/data[\s_-]*tracking/i],
    structure: [/\bmass balance\b/i, /\bforecast\b/i, /\brecovery rate\b/i],
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

/**
 * The kind vocabulary, rendered for the model.
 *
 * DERIVED from {@link DOC_KIND_DESCRIPTIONS}, never hand-written — see §D9 on
 * that constant. Exported so a test can assert every member of `DOC_KINDS`
 * appears in it; that test fails against the pre-ADR-0104 prompt.
 */
export function renderKindVocabulary(): string {
  return DOC_KINDS.map((k) => `- ${k}: ${DOC_KIND_DESCRIPTIONS[k]}\n`).join('');
}

export function userPrompt(input: ClassifierInput): string {
  return (
    'Classify this document.\n\n' +
    `kind must be exactly one of: ${DOC_KINDS.join(', ')}.\n` +
    renderKindVocabulary() +
    '\n' +
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
