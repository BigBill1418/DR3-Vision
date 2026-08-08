// ADR-0083 — the wire contract for an amendment's proposed value.
//
// This lives in `lib/` rather than inline in the route handler for one reason:
// a validation contract that exists only inside a transport file cannot be
// tested against. The first version of the ADR-0083 test suite asserted against
// a COPY of this schema pasted into the test — which would have stayed green
// through any change to the real endpoint, measuring the copy instead of the
// code. One definition, imported by both the route and its tests, is the fix.
//
// (Next.js App Router route files are also restricted in what they may export,
// so hoisting the schema is the supported way to share it regardless.)

import { z } from 'zod';

/**
 * The `new_value` payload of a bonus amendment request.
 *
 * `saves` is REQUIRED. Zod strips unknown keys SILENTLY by default, so omitting
 * it from this object would not reject a saves amendment — it would delete the
 * field at the edge and let every downstream step behave perfectly on the
 * truncated payload: the request row stores a proposal with no saves, the
 * approver reviews a change that never mentions it, and the apply path writes
 * the count and leaves saves untouched. A payroll correction that silently did
 * not happen, with a fully green audit trail saying it did.
 *
 * Not `.optional()` and not `.default(0)`: defaulting would let a stale client
 * silently propose "zero saves" for a day that had some — a proposal nobody
 * made. A client too old to send the field should be rejected loudly.
 *
 * Range mirrors `mattress_count` (both `Decimal(5,1)`, 0..999). The service
 * layer re-validates independently via `validateCount` — never trust the client.
 */
export const AmendmentNewValue = z.object({
  mattress_count: z.number().min(0).max(999),
  saves: z.number().min(0).max(999),
  note: z.string().nullable(),
});

export type AmendmentNewValueInput = z.infer<typeof AmendmentNewValue>;
