// ADR-0138 — who COUNTED a physical count, as distinct from who KEYED it in.
//
// The insert audit row names the account that submitted a count. That account is
// frequently not on the floor: Eugene's first count (snapshot 7232d092) was
// counted by Chris R, confirmed by Patrick D, relayed by the site manager and
// keyed by an admin — and the daily report printed the admin as "Counter".
// `counted_by` / `confirmed_by` carry the floor people as the entry form captured
// them; the audit actor is only ever presented as "entered by".

import { z } from 'zod';

/**
 * A person's name as typed on the count form. Free text because crew members
 * are not all users. Trimmed; control characters refused (the value is rendered
 * into an email and a dashboard).
 */
export const CountPersonName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'control characters');

export interface CountAttribution {
  /** Who physically counted (snapshot `counted_by`). Null when never captured. */
  countedBy: string | null;
  /** Who confirmed the count (snapshot `confirmed_by`). */
  confirmedBy: string | null;
  /** Who keyed it in: the enterer of record (audit actor, or the hold's creator). */
  enteredBy: string | null;
}

/**
 * The one sentence every surface prints for "who counted". Plain text — callers
 * escape for their medium.
 *
 *   counted + confirmed + different enterer → "Chris R, confirmed by Patrick D · entered by Bill Barnard"
 *   counted by the enterer themselves       → "Janette Tomas"
 *   counter never captured                  → "Not recorded · entered by Bill Barnard"
 *   nothing known                            → null
 *
 * The keying account is NEVER presented as the counter — that is the defect this
 * exists to close.
 */
export function formatCountAttribution(a: CountAttribution): string | null {
  const entered = a.enteredBy?.trim() || null;
  const counted = a.countedBy?.trim() || null;
  if (!counted) return entered ? `Not recorded · entered by ${entered}` : null;
  const confirmed = a.confirmedBy?.trim() || null;
  const who = confirmed ? `${counted}, confirmed by ${confirmed}` : counted;
  return entered && entered !== counted ? `${who} · entered by ${entered}` : who;
}
