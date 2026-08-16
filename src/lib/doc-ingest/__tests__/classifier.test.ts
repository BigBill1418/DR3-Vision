// ADR-0067 §3.2 D5 — the classifier.
//
// The two things that matter most here are not accuracy but POSTURE:
//   - `unknown` must be graceful (it is the normal path for a new share);
//   - a vendor invoice must be recognized and REFUSED with the right address.
// A confident wrong answer is worse than either, because under D6 it flows
// straight through to downstream numbers.

import { describe, expect, it, vi } from 'vitest';
import {
  classifyDocument,
  classifyLocally,
  detectPeriod,
  detectSite,
  isDocKind,
  userPrompt,
  renderKindVocabulary,
  DOC_KINDS,
  DOC_KIND_DESCRIPTIONS,
  CONFIRM_CONFIDENCE_FLOOR,
  VENDOR_INVOICE_CORRECT_ADDRESS,
  type ClassifierInput,
} from '../classifier';
import type { ParseSummary } from '../parse';

function input(over: Partial<ClassifierInput> = {}): ClassifierInput {
  return { filename: 'file.xlsx', pathHint: null, contentType: null, summary: null, ...over };
}

function summary(sheets: string[], headers: string[]): ParseSummary {
  return {
    format: 'xlsx',
    sheets: sheets.map((name) => ({
      name,
      rowCount: 10,
      headers,
      headerRowIndex: 1,
      headerConfidence: 'strong' as const,
      titleRows: [],
      populatedColumns: headers,
      numericTotals: {},
    })),
    totalRows: 10,
    textSample: '',
  };
}

describe('local classification', () => {
  it('recognizes a daily log workbook from its name and structure', () => {
    const result = classifyLocally(
      input({
        filename: 'JULY 2026 DAILY LOG.xlsm',
        summary: summary(['Inbound', 'Outbound'], ['Units', 'Mattresses']),
      }),
    );
    expect(result.kind).toBe('daily_log_workbook');
    expect(result.confidence).toBeGreaterThanOrEqual(CONFIRM_CONFIDENCE_FLOOR);
  });

  it('recognizes an equipment inventory', () => {
    const result = classifyLocally(
      input({
        filename: 'Equipment Register.xlsx',
        summary: summary(['Assets'], ['Serial', 'Make', 'Model', 'Hours']),
      }),
    );
    expect(result.kind).toBe('equipment_inventory');
  });

  it('recognizes an MRC document', () => {
    const result = classifyLocally(
      input({
        filename: 'MRC Haul Claim 2026-07.pdf',
        summary: summary(['Claims'], ['Haul', 'MRC']),
      }),
    );
    expect(result.kind).toBe('mrc_invoice');
  });

  it('answers `unknown` — not a guess — when nothing matches', () => {
    const result = classifyLocally(input({ filename: 'notes.txt' }));
    expect(result.kind).toBe('unknown');
    expect(result.confidence).toBe(0);
    // The reasoning has to be usable by a human, since a human is the next step.
    expect(result.reasoning).toContain('Nothing in the filename');
  });

  it('uses the FOLDER PATH as a signal — where a file lives is often the strongest one', () => {
    const withPath = classifyLocally(
      input({ filename: '2026-07.xlsm', pathHint: '/drive/root:/Daily Logs/2026' }),
    );
    expect(withPath.kind).toBe('daily_log_workbook');
  });

  it('reports LOW confidence when two kinds score alike, rather than picking one confidently', () => {
    // "Invoice" + "rates" pull in different directions; ambiguity must not read
    // as certainty, because a confident wrong answer auto-applies under D6.
    const result = classifyLocally(input({ filename: 'invoice rates statement.xlsx' }));
    expect(result.confidence).toBeLessThan(CONFIRM_CONFIDENCE_FLOOR);
  });
});

describe('site and period detection', () => {
  it('detects only the two real sites', () => {
    expect(detectSite('Eugene Daily Log')).toBe('Eugene');
    expect(detectSite('WOODLAND July')).toBe('Woodland');
    expect(detectSite('Portland warehouse')).toBeNull();
  });

  it('normalizes periods to YYYY-MM across the formats people actually use', () => {
    expect(detectPeriod('Daily Log 2026-07.xlsm')).toBe('2026-07');
    expect(detectPeriod('July 2026 log')).toBe('2026-07');
    expect(detectPeriod('07/2026 report')).toBe('2026-07');
    expect(detectPeriod('Annual 2026 summary')).toBe('2026');
    expect(detectPeriod('no date here')).toBeNull();
  });
});

describe('vendor invoice — recognized so it can be REFUSED', () => {
  it('classifies a vendor invoice and names where it should have gone', () => {
    const result = classifyLocally(
      input({
        filename: 'Acme Invoice 4432.pdf',
        summary: summary([], ['Amount Due', 'Remit To']),
      }),
    );
    expect(result.kind).toBe('vendor_invoice');
    // The address itself is asserted in classification.test coverage of the
    // misdirect anomaly; here we just pin the constant so it cannot drift.
    expect(VENDOR_INVOICE_CORRECT_ADDRESS).toBe('ap@svdp.us');
  });
});

describe('Claude fallback (the D-M5-2 hybrid)', () => {
  it('is NOT consulted when local confidence is already strong', async () => {
    const modelCall = vi.fn();
    const { classification } = await classifyDocument(
      input({
        filename: 'JULY 2026 DAILY LOG.xlsm',
        summary: summary(['Inbound', 'Outbound'], ['Units', 'EOD']),
      }),
      { modelCall, fallbackEnabled: () => true },
    );
    expect(modelCall).not.toHaveBeenCalled();
    expect(classification.source).toBe('local');
  });

  it('is consulted when local confidence is weak, and its answer wins', async () => {
    const modelCall = vi.fn(async () => ({
      text: '{"kind":"rate_table","confidence":0.9,"site":"Eugene","period":"2026-07","reasoning":"effective-dated rates"}',
    }));
    const { classification } = await classifyDocument(input({ filename: 'sheet1.xlsx' }), {
      modelCall,
      fallbackEnabled: () => true,
    });
    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(classification.kind).toBe('rate_table');
    expect(classification.source).toBe('claude');
    expect(classification.site).toBe('Eugene');
  });

  it('is skipped entirely when no API key is configured', async () => {
    const modelCall = vi.fn();
    const { classification } = await classifyDocument(input({ filename: 'sheet1.xlsx' }), {
      modelCall,
      fallbackEnabled: () => false,
    });
    expect(modelCall).not.toHaveBeenCalled();
    expect(classification.kind).toBe('unknown');
  });

  it('degrades to the local answer — never throws — when the model call fails', async () => {
    const { classification, error } = await classifyDocument(input({ filename: 'sheet1.xlsx' }), {
      modelCall: async () => {
        throw new Error('timeout');
      },
      fallbackEnabled: () => true,
    });
    // Classification is an input to a human decision, not a gate.
    expect(classification.kind).toBe('unknown');
    expect(error).toContain('classifier_fallback_failed');
  });

  it('records an unparseable response instead of inventing a classification', async () => {
    const { classification, error } = await classifyDocument(input({ filename: 'sheet1.xlsx' }), {
      modelCall: async () => ({ text: 'I think this is a spreadsheet of some kind.' }),
      fallbackEnabled: () => true,
    });
    expect(error).toBe('classifier_unparseable_response');
    expect(classification.source).toBe('local');
  });

  it('collapses an OFF-VOCABULARY kind to `unknown` rather than inventing one', async () => {
    // The vocabulary is a contract with the confirm queue and the guardrail.
    const { classification } = await classifyDocument(input({ filename: 'sheet1.xlsx' }), {
      modelCall: async () => ({
        text: '{"kind":"payroll_register","confidence":0.99,"site":null,"period":null,"reasoning":"x"}',
      }),
      fallbackEnabled: () => true,
    });
    expect(classification.kind).toBe('unknown');
    expect(classification.confidence).toBeLessThanOrEqual(0.5);
  });

  it('rejects a hallucinated site so it can never reach a site-scoped column', async () => {
    // Hard rule #2 — Eugene and Woodland are the only sites that exist.
    const { classification } = await classifyDocument(input({ filename: 'sheet1.xlsx' }), {
      modelCall: async () => ({
        text: '{"kind":"rate_table","confidence":0.9,"site":"Stockton","period":null,"reasoning":"x"}',
      }),
      fallbackEnabled: () => true,
    });
    expect(classification.site).toBeNull();
  });

  it('clamps an out-of-range confidence', async () => {
    const { classification } = await classifyDocument(input({ filename: 'sheet1.xlsx' }), {
      modelCall: async () => ({
        text: '{"kind":"rate_table","confidence":47,"site":null,"period":null,"reasoning":"x"}',
      }),
      fallbackEnabled: () => true,
    });
    expect(classification.confidence).toBe(1);
  });
});

describe('kind vocabulary', () => {
  it('guards the exact D5 list', () => {
    for (const kind of [
      'daily_log_workbook',
      'ap_history_report',
      'equipment_inventory',
      'rate_table',
      'mrc_invoice',
      'vendor_invoice',
      'unknown',
    ]) {
      expect(isDocKind(kind)).toBe(true);
    }
    expect(isDocKind('payroll_register')).toBe(false);
  });
});

// ── ADR-0104 §D9 — the prompt disagreed with its own enum ───────────────────
//
// `userPrompt()` told the model `kind must be exactly one of: ${DOC_KINDS}` —
// nine kinds — and then hand-wrote a bullet list describing SIX. `trailer_list`,
// `terex_maintenance_log` and `commodity_audit_tracker` were named as legal and
// never explained, and the model read the DESCRIBED list as the allow-list. The
// Outbound file's stored `proposed_reasoning` shows it happening in production:
//
//   "commodity_audit_tracker is the closest listed kind, but since that kind is
//    not in the allowed list, and none of the allowed kinds clearly match…"
//
// — written about a kind that IS in the allowed list. The fix is derivation, not
// six more string literals.
describe('the model is shown every kind it is allowed to answer (ADR-0104 §D9)', () => {
  it('describes EVERY member of DOC_KINDS in the rendered prompt', () => {
    const prompt = userPrompt({
      filename: 'Woodland Outbound Auditing 2026.xlsx',
      pathHint: null,
      contentType: null,
      summary: null,
    });

    for (const kind of DOC_KINDS) {
      // Named in the allow-list sentence AND described in the bullet list. Only
      // the first of those was true before ADR-0104, for 3 of 9 kinds.
      expect(prompt, `${kind} must be named`).toContain(kind);
      expect(prompt, `${kind} must be described`).toContain(`- ${kind}: `);
    }
  });

  it('FALSIFIES the guard: a hand-written six-kind list fails it', () => {
    // The pre-ADR-0104 bullet list, verbatim. Asserting that this SHAPE fails is
    // what proves the test above is not true by construction — a vocabulary
    // check that has never seen a bad vocabulary proves nothing.
    const stalePrompt =
      `kind must be exactly one of: ${DOC_KINDS.join(', ')}.\n` +
      '- daily_log_workbook: a daily operations log.\n' +
      '- ap_history_report: a historical listing of AP invoices.\n' +
      '- equipment_inventory: a register of physical assets.\n' +
      '- rate_table: pricing or rates.\n' +
      '- mrc_invoice: paperwork from the MRC.\n' +
      '- vendor_invoice: a single bill from a supplier.\n' +
      '- unknown: anything you are not confident about.\n';

    const undescribed = DOC_KINDS.filter((k) => !stalePrompt.includes(`- ${k}: `));
    expect(undescribed).toContain('trailer_list');
    expect(undescribed).toContain('terex_maintenance_log');
    expect(undescribed).toContain('commodity_audit_tracker');
    // The two new absorbable classes would have been silently undescribed too.
    expect(undescribed).toContain('outbound_weight_audit');
    expect(undescribed).toContain('facility_expense_log');
  });

  it('has a non-empty description for every kind', () => {
    // `Record<DocKind, string>` already makes a MISSING key a compile error.
    // This catches the other way to get it wrong: a present-but-empty string.
    for (const kind of DOC_KINDS) {
      expect(DOC_KIND_DESCRIPTIONS[kind].trim().length, kind).toBeGreaterThan(10);
    }
    expect(renderKindVocabulary().split('\n').filter(Boolean)).toHaveLength(DOC_KINDS.length);
  });
});

describe('the ADR-0104 classes classify locally (ADR-0104 §5.1)', () => {
  it('proposes outbound_weight_audit from the REAL headers', () => {
    // Header text read off the live workbook 2026-08-16, not invented.
    const c = classifyLocally({
      filename: 'Woodland Outbound Auditing 2026.xlsx',
      pathHint: null,
      contentType: null,
      summary: {
        sheets: [
          {
            name: 'Outbound Feb 2026',
            headers: [
              'Materials: Materials ID',
              'Shipment Date',
              'BOL ID',
              'Total Outbound Weight',
              'Steel Disposition',
            ],
          },
        ],
        totalRows: 113,
        textSample: '',
      } as unknown as ParseSummary,
    });
    expect(c.kind).toBe('outbound_weight_audit');
    // Strong enough to skip the Claude fallback entirely — the point of adding
    // a local rule rather than tuning a confidence.
    expect(c.confidence).toBeGreaterThanOrEqual(CONFIRM_CONFIDENCE_FLOOR);
    expect(c.site).toBe('Woodland');
  });

  it('proposes facility_expense_log from the REAL headers', () => {
    const c = classifyLocally({
      filename: 'Woodland Invoices tracking.xlsx',
      pathHint: null,
      contentType: null,
      summary: {
        sheets: [
          {
            name: 'WOODLAND 2026',
            headers: ['Present on Daily Log', 'Invoice Date', 'credit amt', 'Invoice #', 'Machine ID'],
          },
        ],
        totalRows: 325,
        textSample: '',
      } as unknown as ParseSummary,
    });
    expect(c.kind).toBe('facility_expense_log');
    expect(c.confidence).toBeGreaterThanOrEqual(CONFIRM_CONFIDENCE_FLOOR);
  });
});
