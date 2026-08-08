// ADR-0083 — saves must survive the whole amendment round trip, and the zod
// silent-strip that would have eaten it.
//
// THE HAZARD: zod's default object behaviour is to STRIP unknown keys silently —
// no error, no warning, no log. The amendments endpoint's `NewValue` schema
// listed `mattress_count` and `note` only. A client correctly posting a saves
// amendment would have had the field deleted at the edge, and every downstream
// step would then have behaved perfectly on the truncated payload: the request
// row stores a `new_value` with no saves, the approver reviews and approves a
// change that never mentions it, and the apply path writes the count and leaves
// saves untouched. A payroll correction that silently did not happen, with a
// fully green audit trail asserting that it did.
//
// This is the class of defect that a green test can hide, so the last block
// re-parses the same body through the OLD schema and asserts the field is gone —
// the strip demonstrated, not asserted in prose.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AmendmentNewValue } from '@/lib/bonus/amendment-schemas';
import { amendmentSummaryLine, amendmentFieldChanges } from '@/lib/bonus/amendment-display';

// The REAL schema the endpoint validates with — imported, never copied.
//
// An earlier draft of this file pasted the schema in as a local const. That
// version would have stayed green through any change to the actual route,
// measuring the copy instead of the code. Importing it is what makes the
// falsification at the bottom of this file mean something: strip `saves` from
// `amendment-schemas.ts` and these tests go red.
const NewValue = AmendmentNewValue;

// The schema as it stood BEFORE ADR-0083.
const NewValue_preAdr0083 = z.object({
  mattress_count: z.number().min(0).max(999),
  note: z.string().nullable(),
});

const POSTED_BODY = { mattress_count: 76, saves: 9, note: null };

describe('the amendments endpoint carries saves through the edge', () => {
  it('parses saves out of the posted body', () => {
    const parsed = NewValue.parse(POSTED_BODY);
    expect(parsed).toEqual({ mattress_count: 76, saves: 9, note: null });
    expect(parsed.saves).toBe(9);
  });

  it('rejects an out-of-range saves rather than clamping it', () => {
    expect(NewValue.safeParse({ ...POSTED_BODY, saves: -1 }).success).toBe(false);
    expect(NewValue.safeParse({ ...POSTED_BODY, saves: 1000 }).success).toBe(false);
  });

  it('rejects a body that omits saves rather than defaulting it to 0', () => {
    // Defaulting would let a stale client silently propose "zero saves" for a
    // day that had some — a proposal nobody made.
    const r = NewValue.safeParse({ mattress_count: 76, note: null });
    expect(r.success).toBe(false);
  });
});

describe('the approver is SHOWN the saves change', () => {
  it('names both moved columns in the summary line', () => {
    const line = amendmentSummaryLine(
      'update',
      { mattress_count: 76, saves: 4, note: null },
      { mattress_count: 80, saves: 9, note: null },
    );
    expect(line).toContain('76 → 80 mattresses');
    expect(line).toContain('4 → 9 saves');
  });

  it('a saves-ONLY change does not render as an empty/no-op line', () => {
    // The failure mode being pinned: an approver shown "76 → 76" (or nothing at
    // all) clicking Approve on a change whose entire content was the saves move.
    const line = amendmentSummaryLine(
      'update',
      { mattress_count: 76, saves: 4, note: null },
      { mattress_count: 76, saves: 9, note: null },
    );
    expect(line).toBe('4 → 9 saves');
    expect(line).not.toBe('');
  });

  it('omits saves entirely for a pre-ADR-0083 request rather than inventing a 0', () => {
    // Claiming a historical request proposed zero saves would be asserting a
    // fact about a payroll record that nobody recorded.
    const fields = amendmentFieldChanges(
      'update',
      { mattress_count: 76, note: null },
      { mattress_count: 80, note: null },
    );
    expect(fields.map((f) => f.label)).toEqual(['mattresses']);
  });

  it('renders an insert with both values', () => {
    const line = amendmentSummaryLine('insert', null, {
      mattress_count: 42,
      saves: 3,
      note: null,
    });
    expect(line).toBe('NEW 42 mattresses · 3 saves');
  });
});

describe('FALSIFICATION — the pre-ADR-0083 schema eats the field in silence', () => {
  it('strips saves with no error, so nothing downstream could notice', () => {
    const stripped = NewValue_preAdr0083.parse(POSTED_BODY);

    // The defect, executed. Note it did not throw and did not warn.
    expect(stripped).not.toHaveProperty('saves');
    expect(stripped).toEqual({ mattress_count: 76, note: null });
    expect(NewValue_preAdr0083.safeParse(POSTED_BODY).success).toBe(true);

    // And the summary the approver would have been shown for a saves-only
    // amendment, after the strip: no mention of the thing being changed.
    const lineAfterStrip = amendmentSummaryLine(
      'update',
      { mattress_count: 76, saves: 4, note: null },
      stripped as { mattress_count: number; note: string | null },
    );
    expect(lineAfterStrip).toBe('no change to keyed values (note only)');

    // The shipped schema keeps it.
    expect(NewValue.parse(POSTED_BODY).saves).toBe(9);
  });
});
