# ADR-0028 — Bonus daily-entry prior-day amendment workflow (four-eyes, soft-control)

**Status:** Accepted (Sprint 4, 2026-06-16)
**Related:** ADR-0019, ADR-0019.1, ADR-0019.2, ADR-0024.

## Context

Until this ADR, within a `draft` pay period, any manager with site access could
edit a prior day's bonus entry directly with no governance other than the audit
log. Morena Gomez (Woodland Operations Manager) surfaced this on 2026-06-15:
"what is the correct process if we need to go back and enter or correct
something from a prior day or from the previous week?" — and there was no
defined process.

The Director of Operations established the following constraints:

- **No cross-period edits, ever.** Closed periods remain immutable to all
  managers.
- **Within the current draft period, prior-day edits require four-eyes review.**
  The requester cannot also be the approver.
- **A justification is required.** No silent rewrites.
- **The Director is notified on every approval AND every rejection.**

The Director retains an admin-only escape valve for closed-period corrections in
true emergencies (existing `signed → amended` / `paid → amended` /
`historical_imported → amended` transitions in `src/lib/bonus/amendment.ts`),
audit-labeled and out of scope for this ADR.

## Decision

We introduce a four-eyes amendment-request workflow for prior-day edits within
the current `draft` period. The workflow is implemented as a **soft control**:
the four-eyes pathway is the default, but a "Ping Bill" escape adds the Director
as an alternate eligible approver immediately on request. The audit log
captures any pattern of immediate-ping abuse.

### Trigger

A daily-entry write goes through the workflow iff ALL of these are true:

1. The period is in `draft` state (existing requirement; `EDITABLE_STATES`
   membership).
2. The `entry_date < today` (Pacific calendar day).
3. The requested change touches `mattress_count` (an `update` to count, or an
   `insert` of a new row for a prior day).
4. The actor is a manager who is NOT excluded (Patrick carve-out below).
5. The actor is not the Director (admin path is direct).

Otherwise the write is direct (existing path).

### Patrick carve-out

Patrick Dills is an Eugene manager AND a `BonusEmployee` (Lead processor) at
Eugene. By the same separation-of-duties principle that excludes him from the
Eugene signature chain, the amendment workflow is not available to him. The
prior-day grid renders his rows read-only; any correction must be verbally
escalated to Rick or Bill.

### Change types

- `update` — change an existing entry's `mattress_count` (the `note` may also
  change as part of the same request).
- `insert` — add a missed entry for a past day.
- **No `delete` operation.** Misattribution is corrected by setting the
  wrong-attribution row's count to 0, plus a separate `insert` for the correct
  employee. The misattribution stays visible in the audit trail.

### Justification

Required, minimum 20 characters (DB CHECK + app validation).

### "Ping Bill" escape

Available **immediately** on submission. Adds the chain's
`auto_override_actor_user_id` (Bill) as a second eligible approver. The original
counterpart approver stays eligible. Either may approve. The four-eyes property
is therefore a soft control; abuse patterns are observable in the audit log
via `bill_pinged_at - requested_at`.

### Notifications

| Event                  | ntfy to                        | Email to           |
| ---------------------- | ------------------------------ | ------------------ |
| Submitted              | Approver (`dr3-vision-system`) | Approver           |
| Bill pinged            | Bill (`dr3-vision-system`)     | Bill               |
| Approved               | Bill (`dr3-vision-system`)     | Bill, requester    |
| Rejected               | Bill (`dr3-vision-system`)     | Bill, requester    |
| Cancelled by requester | —                              | — (audit row only) |

### Data model

See `prisma/migrations/20260616_amendment_workflow/migration.sql`.

### Approval atomicity

Approval applies the entry change AND records the entry-audit row AND marks the
request `approved` AND links the entry-audit row id back into the request, all
in a single Prisma transaction.

### Concurrency

If the same requester submits a new request for the same
`(target_entry_date, bonus_employee_id)` while a prior request from them is
pending, the prior request is auto-cancelled (state → `cancelled`,
audit-tracked).

### Date picker access for managers

The existing `AdminDatePicker` (admin-only) is replaced by `BonusDatePicker`,
visible to all managers and admins. For managers, the picker is constrained to
the current draft period's date range (`min=period_start`, `max=today`
Pacific). For admins, the picker remains unconstrained.

Both the client gate AND the server-side `resolveEntryDate` enforce the
constraint (defense in depth).

## Consequences

### Positive

- Morena's question has a defined answer.
- Audit trail is materially richer: every prior-day edit carries a
  justification and an approval record.
- Separation of duties enforced for material changes (counts), with
  soft-control flexibility for time-pressured corrections.
- Closed-period immutability preserved without ambiguity.

### Negative

- New surface: one table, one approver eligibility module, one notification
  module, five routes, three UI components.
- Approvers gain a new responsibility — checking the pending-amendments queue.

### Out of scope

- Cross-period amendments (forbidden by policy).
- Bulk-amend.
- Pre-approval delegation.
- Auto-escalation on time-of-day (deliberately not introduced).
