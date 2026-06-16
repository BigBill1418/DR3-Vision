# ADR-0029 — Amendment notification batching (one notification per root action)

**Status:** Accepted (Sprint 4, 2026-06-16)
**Related:** ADR-0028 (the amendment workflow this extends), ADR-0037 (fleet
notification noise-reduction policy — "deduplicate against root cause").

## Context

ADR-0028 shipped the four-eyes prior-day amendment workflow. It modelled each
line item as its own amendment request: one row, one "please approve" email to
the approver, one ntfy to Bill, one approve-click, one result email.

That is correct for a one-line correction. It is **noise** for the real case.
A manager correcting a prior day routinely edits N line items in a single
save — the daily-entry grid lets them re-key every processor's count and press
Save once. Under ADR-0028 that one root action exploded into N requests:

- A real 16-line Woodland correction sent **Morena 16 approval emails**, pushed
  Bill **16 ntfy notifications**, and would have required **16 approve-clicks**
  and produced **16 result emails**.

This directly violates the ADR-0037 noise rubric (gate question #4:
"Deduplicated against root cause? — one alert per root cause, not N"). One root
action — a manager's single save, an approver's single decision — must produce
**one** notification per direction.

## Decision

Group the requests that were submitted together and notify once per root action.

### Grouping key

Add a nullable `submission_group_id TEXT` column to `bonus_amendment_requests`
(+ an index). The N requests created by one save share a generated id; a
genuinely single-item submit leaves it `null` (a singleton).

> **Migration discipline (carried from ADR-0028):** the column is `TEXT`, not
> `UUID`. This database stores every id/FK as `TEXT` (`String @default(uuid())`
> → text); a `UUID`-typed column is incompatible with the `TEXT` ids it is
> compared against — exactly the `42804` failure that broke prod in the original
> ADR-0028 migration. The migration is purely additive and idempotent
> (`ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`), so it is safe
> against the live-test pending row already present in prod.

### Submit → one notification

The submit endpoint (`POST /api/bonus/amendments`) accepts **either** the legacy
single-item body (back-compat) **or** a batch body sharing one
`bonusPayPeriodId` / `targetEntryDate` / `justification` across an `items[]`
array. Both flow through `submitAmendmentBatch`, which:

- creates all N requests in **one transaction**, each stamped with the shared
  `submission_group_id` (null when N=1);
- writes a per-row insert **audit row** for every item (ADR-0028 / hard rule #6
  — per-row audit is never dropped, even in a batch);
- rolls the **whole** batch back if any single item fails validation (no partial
  submit);
- fires exactly **one** `notifyAmendmentBatchSubmitted` — one email to the
  approver, one ntfy to Bill — summarising the batch (requester, site, period,
  date, and a short employee + old→new list).

A single-item submit takes the same path with N=1 and sends exactly one.

### Approve / reject → one result notification

The grid's `AmendmentQueue` groups pending requests by `submission_group_id`.
Singletons render as before; a group renders once with **Approve all** /
**Reject all** (reject-all shares one reason, entered inline — not a
`window.prompt`).

The approve/reject routes detect the group: a grouped request applies **every**
item — each with its own entry write + per-item entry-audit row, in one
transaction (`approveAmendmentGroup` / `rejectAmendmentGroup`) — and fires
**one** `notifyAmendmentBatchDecided` (one ntfy to Bill, one email each to Bill

- the requester). A singleton decides the one and notifies once.

All ADR-0028 invariants are preserved per request inside the group: four-eyes
eligibility (`canApproveRequest`), requester ≠ approver, period-still-draft, the
Patrick carve-out, and the ping-Bill soft control (ping is one notification
regardless of batch).

### In-app discoverability

The approver previously could only reach `/bonus/amendments` via the email link.
A **"Pending Amendments"** nav link is added to the bonus nav, shown only to
users who can approve — admins (all-site), or a manager who is a signer
(facility/ops slot) in their site's signature chain. It carries a badge with the
count of items pending the caller's review (counts items, not groups, so the
approver sees the true work ahead).

## Alternatives considered

- **Coalesce notifications by a time-window debounce instead of an explicit
  group id.** Rejected: fragile (depends on wall-clock timing), and it can't
  group the approve/reject side, where there is no submit burst to debounce.
- **Per-fingerprint ntfy cooldown only (ADR-0037 helper).** That dedups Bill's
  pushes but does nothing for the approver's N emails or the N approve-clicks.
  The root-cause grouping is the actual fix; the cooldown is a backstop.
- **A separate `submission_groups` table.** Over-modelled for a grouping key
  with no attributes of its own; a nullable column + index is sufficient and
  additive.

## Consequences

### Positive

- One save → one approval email + one push. One decision → one result email +
  one push. The 16-line correction is now 1 email / 1 push / 1 click / 1 result.
- The approver has an in-app route to the queue with a live pending count.
- Per-row audit is fully preserved — the audit trail is unchanged in richness.

### Negative / trade-offs

- The submit endpoint now accepts two body shapes (single + batch). The single
  shape is retained only for back-compat; new clients send batches.
- Approve-all / reject-all is all-or-nothing per group. Splitting a group (accept
  some lines, reject others) is out of scope — the manager re-submits the
  rejected lines, which is the rare path.

### Out of scope

- Cross-group bulk actions (deciding multiple groups in one click).
- Partial-group decisions.

## Rollout & verification (2026-06-16)

Merged to `main` (PR #28) and deployed to svdp-dev prod. The `migrate` init
container applied `20260616_amendment_submission_group`; the column is verified
present as `submission_group_id text` (nullable). Typecheck clean; 536/536 tests
pass, including the route assertions "N-item batch → exactly ONE submitted
notification" and "grouped → approves the WHOLE group + exactly ONE decided
notification", and the lib assertions "N rows share ONE submission_group_id" /
"N=1 → null group singleton" / "approveAmendmentGroup applies all".

### Pre-migration backlog behaves as singletons (expected)

Requests created **before** the migration carry `submission_group_id = NULL`.
The grouping logic treats NULL as a singleton, so each such row notifies on its
own. Immediately after rollout the first approver cleared a ~13-row pre-migration
backlog, which produced **one email per row** — this is the documented singleton
behavior of legacy un-grouped rows, **not a batching regression**. Only rows
created post-migration carry a shared group id and collapse to one notification.
The backlog is drained (0 pending); no migration backfill is warranted for a
one-time legacy set.

### Live prod self-test (data layer, fully reverted)

A 3-line grouped batch was submitted and approved directly against the production
DB — exercising the real `createOneAmendmentInTx` / `applyApprovalInTx` write
shape, **without** invoking the notification fan-out (which lives in the HTTP
routes, so no email/ntfy was sent). It confirmed: all 3 rows share one non-null
`submission_group_id`; group approval applies every row atomically in one
transaction; the route would therefore fire exactly one decided notification for
the batch. The test then deleted every row it created (requests, applied daily
entries, audit rows) and asserted before==after counts across all three tables —
zero residue.
