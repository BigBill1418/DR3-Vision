// ADR-0083 — how a prior-day amendment is DESCRIBED to the person approving it.
//
// The four-eyes workflow is only worth its cost if the approver can see what
// they are approving. Before saves, the change was one number and every surface
// rendered `76 → 67` by hand. With two paid columns, a surface that still
// renders only the count would show an approver a change that reads as "no
// change at all" when the saves figure is what moved — they would click Approve
// on a payroll edit whose actual content was never displayed. That is worse than
// not showing it, because it manufactures the appearance of review.
//
// So the label is built ONCE, here, and the queue, the batch modal and the
// notification email all use it. Three hand-rolled formatters would drift; this
// one cannot.

/** The `{ mattress_count, saves, note }` snapshot stored on an amendment request. */
export interface AmendmentValueSnapshot {
  mattress_count: number;
  /**
   * Optional because a request row written before ADR-0083 has no `saves` key.
   * Rendered as "unchanged" rather than as 0 — claiming a historical request
   * proposed zero saves would be inventing a fact about a payroll record.
   */
  saves?: number | null;
  note?: string | null;
}

/** One rendered field-level change, for surfaces that lay out their own markup. */
export interface AmendmentFieldChange {
  label: string;
  /** Null on an insert — there is no prior value. */
  from: number | null;
  to: number;
  changed: boolean;
}

/**
 * The field-level changes an amendment proposes, in display order.
 *
 * A field is OMITTED entirely when the proposal says nothing about it (a
 * pre-ADR-0083 request and `saves`), and included-but-`changed:false` when it
 * was submitted and simply did not move — those are different states and the
 * approver should be able to tell them apart.
 */
export function amendmentFieldChanges(
  changeType: 'update' | 'insert',
  oldValue: AmendmentValueSnapshot | null,
  newValue: AmendmentValueSnapshot,
): AmendmentFieldChange[] {
  const out: AmendmentFieldChange[] = [
    {
      label: 'mattresses',
      from: changeType === 'insert' ? null : (oldValue?.mattress_count ?? null),
      to: newValue.mattress_count,
      changed: changeType === 'insert' || oldValue?.mattress_count !== newValue.mattress_count,
    },
  ];

  if (newValue.saves != null) {
    const fromSaves = changeType === 'insert' ? null : (oldValue?.saves ?? 0);
    out.push({
      label: 'saves',
      from: fromSaves,
      to: newValue.saves,
      changed: changeType === 'insert' || fromSaves !== newValue.saves,
    });
  }

  return out;
}

/**
 * A compact one-line summary: `76 → 67 mattresses · 4 → 9 saves`, or
 * `NEW 42 mattresses · 3 saves` for an insert.
 *
 * Unchanged fields are dropped from the summary on an update so the line names
 * what actually moved — EXCEPT that a summary is never allowed to come back
 * empty, because "this amendment changes nothing" must be visible rather than
 * rendered as blank space.
 */
export function amendmentSummaryLine(
  changeType: 'update' | 'insert',
  oldValue: AmendmentValueSnapshot | null,
  newValue: AmendmentValueSnapshot,
): string {
  const fields = amendmentFieldChanges(changeType, oldValue, newValue);

  if (changeType === 'insert') {
    return `NEW ${fields.map((f) => `${f.to} ${f.label}`).join(' · ')}`;
  }

  const moved = fields.filter((f) => f.changed);
  if (moved.length === 0) return 'no change to keyed values (note only)';

  return moved.map((f) => `${f.from ?? '?'} → ${f.to} ${f.label}`).join(' · ');
}
