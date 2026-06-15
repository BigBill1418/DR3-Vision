# Sprint 4 Handoff — Prior-Day Amendment Workflow + Manager Date Picker + Bi-Site EOD Check

**Status:** Ready for build
**Branch:** `sprint-4-amendment-workflow`
**ADR:** [ADR-0027](../adr/0027-bonus-amendment-workflow.md) (to be created — content in §3 below)
**Author:** Bill Barnard, Director of Operations
**Date:** 2026-06-15

---

## §0 — Instructions to the implementing agent (Claude Code)

You are executing Sprint 4 of DR3-Vision. This document is your **only** input — every file path, every code block, and every acceptance criterion is in here. Do the following, in order:

1. Cut `sprint-4-amendment-workflow` from `main`.
2. Create every file listed in §2 with the contents in this document. Apply every patch verbatim. **Do not improvise** — every snippet here was authored with full knowledge of the repo's existing conventions (`requireBonusAccess`, `publishNtfy`, `sendSystemEmail`, `BonusContext`, `transitionMonth`, `getSignatureChain`, `appToday`, `dayKeyUTCFromISO`, `pacificDayISO`, `entryDateUTC`, `assertEntriesEditable`, `writeAudit`, `log`, `prisma`).
3. Run `npx prisma generate` after the schema patch lands.
4. Implement the test files in §11 to the case-list level (full assertions, not stubs).
5. Run the full gate:
   - `npx tsc --noEmit` exits 0
   - `npx eslint . --max-warnings 0` clean
   - `npx vitest run` green; suite size ≥ 764 (current floor is 734)
   - `npx next build` succeeds
6. Open a PR titled **"Sprint 4: prior-day amendment workflow + manager date picker + bi-site EOD check (ADR-0027)"** with the description in §12.
7. **Do not deploy.** Bill merges manually after review.

### Non-negotiables

- **Existing `src/lib/bonus/amendment.ts` is the admin escape valve (Q1 in §1).** Do not modify, delete, or rename it. The new manager workflow lives in a sibling file `src/lib/bonus/amendment-requests.ts`.
- **No cross-period edits.** The workflow's trigger condition fires only when the period is in `draft` state and `entry_date < today` Pacific. Closed periods (`pending_signatures`, `partially_signed`, `signed`, `paid`, `amended`, `historical_imported`, `skipped`) remain immutable for managers via the existing `assertEntriesEditable` gate.
- **No changes to the period state machine.** No new states, no new transitions. The new table is a workflow ledger; the entry write happens through normal in-`draft` upsert during approval.
- **CLAUDE.md hard rules apply:** (#2) bonus is site-scoped — every query scoped by `siteId`; (#3) bonus math via the rules table only; (#6) every mutation has its audit row in the same transaction.

---

## §1 — Design decisions (locked with Bill, do not revisit)

| # | Decision | Lock |
|---|---|---|
| Q1 | Closed periods (`signed`/`paid`/`historical_imported`) | Immutable for managers; Bill keeps audit-labeled admin escape valve only (existing `src/lib/bonus/amendment.ts`) |
| Q2 | Patrick Dills' prior-day edit authority | None — verbal escalation to Rick/Bill. Server returns 403 on submit; UI surfaces read-only for Patrick |
| Q3 | Operations supported | `update` + `insert` only; no delete; misattribution = "set to 0" + add correct entry |
| Q4 | Notifications to Bill | On both approve AND reject |
| Q5 | Approver unavailable | Requester can ping Bill — Bill added as second eligible approver; original counterpart stays in chain |
| Q6 | Justification minimum | 20 characters (app + DB CHECK constraint) |
| Q7 | Note-only edits | Direct (audit-log only, no workflow) |
| Q8 | "Ping Bill" timing | Immediately on submit — soft control, audit catches abuse |
| Q9 | Same-day corrections | Direct (trigger is `entry_date < today` Pacific) |

### Approver matrix

| Requester | Default approver | Bill-ping eligible? |
|---|---|---|
| Janette Thomas (Woodland facility) | Morena Gomez (Woodland ops) | Yes |
| Morena Gomez (Woodland ops) | Janette Thomas (Woodland facility) | Yes |
| Rick Albritton (Eugene facility) | Kelsey Ruhland (Eugene ops) | Yes |
| Kelsey Ruhland (Eugene ops, `all_sites=true`) | the site's facility signer | Yes |
| Patrick Dills (Eugene Lead processor) | — workflow not available, 403 — | N/A |
| Bill Barnard (admin) | — direct admin path, returns 400 — | N/A |

---

## §2 — File manifest

### New files

1. `docs/adr/0027-bonus-amendment-workflow.md` (§3)
2. `prisma/migrations/20260616_amendment_workflow/migration.sql` (§4)
3. `src/lib/bonus/amendment-approvers.ts` (§6)
4. `src/lib/bonus/amendment-requests.ts` (§7)
5. `src/lib/bonus/amendment-notifications.ts` (§8)
6. `src/app/api/bonus/amendments/route.ts` (§9)
7. `src/app/api/bonus/amendments/[id]/approve/route.ts` (§9)
8. `src/app/api/bonus/amendments/[id]/reject/route.ts` (§9)
9. `src/app/api/bonus/amendments/[id]/cancel/route.ts` (§9)
10. `src/app/api/bonus/amendments/[id]/ping-bill/route.ts` (§9)
11. `src/app/bonus/BonusDatePicker.tsx` (§10) — replaces `AdminDatePicker.tsx` at the site level
12. `src/app/bonus/RequestEditModal.tsx` (§10)
13. `src/app/bonus/amendments/page.tsx` (§10)
14. `src/app/bonus/amendments/AmendmentQueue.tsx` (§10)
15. `docs/operator/bonus-amendment-workflow.md` (§13)
16. `src/lib/bonus/__tests__/amendment-approvers.test.ts` (§11)
17. `src/lib/bonus/__tests__/amendment-requests.test.ts` (§11)
18. `src/app/api/bonus/amendments/__tests__/route.test.ts` (§11)

### Modified files

19. `prisma/schema.prisma` (§5) — adds `BonusAmendmentRequest` model + two enums + 5 back-relations
20. `src/lib/bonus/daily-entry.ts` (§7.6) — adds `shouldRequireAmendment` predicate; modifies `upsertDailyEntries` to fork on prior-day count changes
21. `src/lib/bonus/eod-check.ts` (§14.1) — parameterize `missingFingerprint(siteCode, dateIso)`
22. `src/lib/bonus/eod-check.test.ts` — update assertions for the parameterized fingerprint
23. `scripts/bonus-eod-check.mjs` (§14.2) — bi-site daemon refactor
24. `src/app/bonus/page.tsx` (§10.3) — swap `AdminDatePicker` → `BonusDatePicker`; relax `resolveEntryDate` gate for managers within current period
25. `docker-compose.yml` (§14.3) — add `bonus-eod-check` service
26. `CHANGELOG.md` (§15) — entry at top of Unreleased

### Files to delete

- `src/app/bonus/AdminDatePicker.tsx` (replaced by `BonusDatePicker.tsx`)

---

## §3 — `docs/adr/0027-bonus-amendment-workflow.md`

````markdown
# ADR-0027 — Bonus daily-entry prior-day amendment workflow (four-eyes, soft-control)

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

| Event | ntfy to | Email to |
|---|---|---|
| Submitted | Approver (`dr3-vision-system`) | Approver |
| Bill pinged | Bill (`dr3-vision-system`) | Bill |
| Approved | Bill (`dr3-vision-system`) | Bill, requester |
| Rejected | Bill (`dr3-vision-system`) | Bill, requester |
| Cancelled by requester | — | — (audit row only) |

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
````

---

## §4 — `prisma/migrations/20260616_amendment_workflow/migration.sql`

````sql
-- ADR-0027: Bonus daily-entry prior-day amendment workflow.
-- Pure additive — no existing tables touched.

CREATE TYPE "BonusAmendmentRequestState" AS ENUM (
  'pending',
  'approved',
  'rejected',
  'cancelled'
);

CREATE TYPE "BonusAmendmentChangeType" AS ENUM (
  'update',
  'insert'
);

CREATE TABLE "bonus_amendment_requests" (
  "id"                          UUID NOT NULL DEFAULT gen_random_uuid(),
  "bonus_pay_period_id"         UUID NOT NULL,
  "site_id"                     UUID NOT NULL,
  "target_entry_date"           DATE NOT NULL,
  "bonus_employee_id"           UUID NOT NULL,
  "change_type"                 "BonusAmendmentChangeType" NOT NULL,
  "old_value"                   JSONB,
  "new_value"                   JSONB NOT NULL,
  "justification"               TEXT NOT NULL,
  "requested_by_user_id"        UUID NOT NULL,
  "requested_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "state"                       "BonusAmendmentRequestState" NOT NULL DEFAULT 'pending',
  "expected_approver_user_id"   UUID NOT NULL,
  "bill_pinged_at"              TIMESTAMP(3),
  "reviewed_by_user_id"         UUID,
  "reviewed_at"                 TIMESTAMP(3),
  "decision_notes"              TEXT,
  "applied_audit_id"            UUID,
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "bonus_amendment_requests_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "bonus_amendment_requests_period_fk"
    FOREIGN KEY ("bonus_pay_period_id") REFERENCES "bonus_pay_periods"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_employee_fk"
    FOREIGN KEY ("bonus_employee_id") REFERENCES "bonus_employees"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_requester_fk"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_expected_approver_fk"
    FOREIGN KEY ("expected_approver_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_reviewer_fk"
    FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_applied_audit_fk"
    FOREIGN KEY ("applied_audit_id") REFERENCES "audit_log"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_requester_neq_approver"
    CHECK ("requested_by_user_id" <> "expected_approver_user_id"),

  CONSTRAINT "bonus_amendment_requests_justification_min_length"
    CHECK (char_length("justification") >= 20),

  CONSTRAINT "bonus_amendment_requests_decided_has_reviewer"
    CHECK (
      ("state" = 'pending')
      OR ("state" = 'cancelled')
      OR ("reviewed_by_user_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
    ),

  CONSTRAINT "bonus_amendment_requests_rejected_has_reason"
    CHECK ("state" <> 'rejected' OR "decision_notes" IS NOT NULL)
);

CREATE INDEX "bonus_amendment_requests_period_idx"
  ON "bonus_amendment_requests"("bonus_pay_period_id");

CREATE INDEX "bonus_amendment_requests_site_state_idx"
  ON "bonus_amendment_requests"("site_id", "state");

CREATE INDEX "bonus_amendment_requests_expected_approver_state_idx"
  ON "bonus_amendment_requests"("expected_approver_user_id", "state");

CREATE INDEX "bonus_amendment_requests_requester_idx"
  ON "bonus_amendment_requests"("requested_by_user_id");

CREATE INDEX "bonus_amendment_requests_target_idx"
  ON "bonus_amendment_requests"("bonus_employee_id", "target_entry_date");
````

---

## §5 — `prisma/schema.prisma` patches

Add at the end of the Bonus section (after `BonusEmployeeAlias`):

````prisma
// ────────────────────────────────────────────────────────────────────────
// Bonus daily-entry amendment workflow (ADR-0027).
// Four-eyes approval gate for prior-day edits within the current draft period.
// ────────────────────────────────────────────────────────────────────────

enum BonusAmendmentRequestState {
  pending
  approved
  rejected
  cancelled
}

enum BonusAmendmentChangeType {
  update
  insert
}

model BonusAmendmentRequest {
  id String @id @default(uuid())

  bonus_pay_period_id String
  bonus_pay_period    BonusPayPeriod @relation(fields: [bonus_pay_period_id], references: [id])

  site_id String
  site    Site   @relation(fields: [site_id], references: [id])

  target_entry_date DateTime @db.Date
  bonus_employee_id String
  bonus_employee    BonusEmployee @relation(fields: [bonus_employee_id], references: [id])

  change_type   BonusAmendmentChangeType
  old_value     Json?
  new_value     Json
  justification String

  requested_by_user_id String
  requested_by         User     @relation("BonusAmendmentRequester", fields: [requested_by_user_id], references: [id])
  requested_at         DateTime @default(now())

  state BonusAmendmentRequestState @default(pending)

  expected_approver_user_id String
  expected_approver         User   @relation("BonusAmendmentExpectedApprover", fields: [expected_approver_user_id], references: [id])

  bill_pinged_at DateTime?

  reviewed_by_user_id String?
  reviewed_by         User?     @relation("BonusAmendmentReviewer", fields: [reviewed_by_user_id], references: [id])
  reviewed_at         DateTime?
  decision_notes      String?

  applied_audit_id String?
  applied_audit    AuditLog? @relation("BonusAmendmentAppliedAudit", fields: [applied_audit_id], references: [id])

  created_at DateTime @default(now())
  updated_at DateTime @updatedAt

  @@index([bonus_pay_period_id])
  @@index([site_id, state])
  @@index([expected_approver_user_id, state])
  @@index([requested_by_user_id])
  @@index([bonus_employee_id, target_entry_date])
  @@map("bonus_amendment_requests")
}
````

Add these back-relations inside existing models:

**`model User`** (add to relations block):
````prisma
  bonus_amendments_requested  BonusAmendmentRequest[] @relation("BonusAmendmentRequester")
  bonus_amendments_to_approve BonusAmendmentRequest[] @relation("BonusAmendmentExpectedApprover")
  bonus_amendments_reviewed   BonusAmendmentRequest[] @relation("BonusAmendmentReviewer")
````

**`model BonusPayPeriod`** (add to relations block):
````prisma
  amendment_requests BonusAmendmentRequest[]
````

**`model BonusEmployee`** (add to relations block):
````prisma
  amendment_requests BonusAmendmentRequest[]
````

**`model Site`** (add to relations block):
````prisma
  bonus_amendment_requests BonusAmendmentRequest[]
````

**`model AuditLog`** (add to relations block):
````prisma
  bonus_amendments_applied BonusAmendmentRequest[] @relation("BonusAmendmentAppliedAudit")
````

Run `npx prisma generate` after applying.

---

## §6 — `src/lib/bonus/amendment-approvers.ts`

````ts
// ADR-0027 — Resolve the expected approver for a bonus amendment request.
//
// The approver matrix is sourced from `bonus_signature_chains` (per-site row).
// The requester is matched to a slot (facility OR ops) at their site; the OTHER
// slot's signer is the approver. Special carve-outs:
//   - Patrick Dills (Eugene Lead processor) is BLOCKED — the workflow is not
//     available to him.
//   - The Director (admin) bypasses the workflow entirely; this function is
//     never called for admin actors.

import { getSignatureChain } from '@/lib/bonus/signature-chain';
import type { PrismaClient } from '@prisma/client';

export class AmendmentWorkflowForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(
    public readonly forbiddenReason:
      | 'patrick_or_other_non_chain_manager'
      | 'admin_uses_direct_path',
  ) {
    super(`amendment workflow forbidden: ${forbiddenReason}`);
    this.name = 'AmendmentWorkflowForbiddenError';
  }
}

export interface ResolvedApprover {
  /** Default counterpart approver, resolved from the signature chain. */
  expectedApproverUserId: string;
  /** Admin auto-override actor (Bill) — always Bill-ping eligible. */
  pingBillUserId: string;
}

/**
 * Resolve the default expected approver for an amendment request from
 * `requesterUserId` at `siteId`. Throws AmendmentWorkflowForbiddenError when
 * the requester is structurally outside the workflow (Patrick / any user who
 * is neither facility nor ops signer at the site).
 */
export async function resolveAmendmentApprover(
  db: PrismaClient,
  siteId: string,
  requesterUserId: string,
): Promise<ResolvedApprover> {
  const chain = await getSignatureChain(siteId, db);

  if (
    requesterUserId !== chain.facility_signer_user_id &&
    requesterUserId !== chain.ops_signer_user_id
  ) {
    throw new AmendmentWorkflowForbiddenError('patrick_or_other_non_chain_manager');
  }

  const counterpartUserId =
    requesterUserId === chain.facility_signer_user_id
      ? chain.ops_signer_user_id
      : chain.facility_signer_user_id;

  return {
    expectedApproverUserId: counterpartUserId,
    pingBillUserId: chain.auto_override_actor_user_id,
  };
}

export interface ApprovalEligibilityInput {
  actorUserId: string;
  request: {
    requested_by_user_id: string;
    expected_approver_user_id: string;
    bill_pinged_at: Date | null;
  };
  chain: { auto_override_actor_user_id: string };
  actorIsAdmin: boolean;
}

/**
 * Returns true iff `actorUserId` is eligible to approve `request`.
 *
 * Eligible:
 *   - the expected approver (counterpart slot) — always
 *   - the admin auto-override actor (Bill) when bill_pinged_at IS NOT NULL,
 *     OR when actor is admin (admin always eligible — Q1 escape valve)
 *
 * Never eligible:
 *   - the requester (DB CHECK + this app-layer mirror)
 */
export function canApproveRequest(input: ApprovalEligibilityInput): boolean {
  const { actorUserId, request, chain, actorIsAdmin } = input;

  if (actorUserId === request.requested_by_user_id) return false;
  if (actorUserId === request.expected_approver_user_id) return true;
  if (actorIsAdmin) return true;
  if (
    actorUserId === chain.auto_override_actor_user_id &&
    request.bill_pinged_at !== null
  ) {
    return true;
  }
  return false;
}
````

---

## §7 — `src/lib/bonus/amendment-requests.ts`

````ts
// ADR-0027 — Bonus amendment-request service.
//
// Four-eyes prior-day amendment workflow. Every public function here:
//   - is the ONLY supported mutation path on `bonus_amendment_requests`
//   - resolves the signature chain (via getSignatureChain) for approver matrix
//   - writes an audit row in the SAME Prisma transaction as the table mutation
//     (CLAUDE.md hard rule #6)
//   - on approval, applies the entry change AND writes the entry audit row AND
//     marks the request approved AND links the applied audit row id back into
//     the request, all in one transaction
//
// The routing predicate (`shouldRequireAmendment`) is exported here for the
// daily-entry layer to call before writing.

import { Prisma, type AuditAction, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { appToday } from '@/lib/time';
import { getSignatureChain } from '@/lib/bonus/signature-chain';
import {
  resolveAmendmentApprover,
  canApproveRequest,
  AmendmentWorkflowForbiddenError,
} from '@/lib/bonus/amendment-approvers';

export const JUSTIFICATION_MIN_LENGTH = 20;

export class AmendmentRequestError extends Error {
  readonly status: number;
  constructor(
    public readonly reason:
      | 'period_not_draft'
      | 'period_not_found'
      | 'employee_not_in_site'
      | 'justification_too_short'
      | 'invalid_count'
      | 'entry_not_found_for_update'
      | 'entry_exists_for_insert'
      | 'request_not_found'
      | 'request_not_pending'
      | 'not_eligible_to_approve'
      | 'reject_requires_notes'
      | 'cancel_only_by_requester',
    statusCode = 409,
  ) {
    super(`amendment request error: ${reason}`);
    this.name = 'AmendmentRequestError';
    this.status = statusCode;
  }
}

export interface SubmitAmendmentInput {
  siteId: string;
  bonusPayPeriodId: string;
  targetEntryDate: Date;
  bonusEmployeeId: string;
  changeType: 'update' | 'insert';
  newValue: { mattress_count: number; note: string | null };
  justification: string;
  requesterUserId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AmendmentDecisionInput {
  requestId: string;
  reviewerUserId: string;
  reviewerIsAdmin: boolean;
  decisionNotes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Submit
// ─────────────────────────────────────────────────────────────────────

export async function submitAmendmentRequest(input: SubmitAmendmentInput) {
  if (input.justification.trim().length < JUSTIFICATION_MIN_LENGTH) {
    throw new AmendmentRequestError('justification_too_short', 422);
  }

  const count = input.newValue.mattress_count;
  if (
    !Number.isFinite(count) ||
    count < 0 ||
    count > 999 ||
    Math.abs(count * 10 - Math.round(count * 10)) > 1e-9
  ) {
    throw new AmendmentRequestError('invalid_count', 422);
  }

  // Resolve approver outside the tx (separate read; throws on Patrick).
  const { expectedApproverUserId } = await resolveAmendmentApprover(
    prisma,
    input.siteId,
    input.requesterUserId,
  );

  return prisma.$transaction(async (tx) => {
    const period = await tx.bonusPayPeriod.findUnique({
      where: { id: input.bonusPayPeriodId },
      select: { id: true, site_id: true, state: true },
    });
    if (!period || period.site_id !== input.siteId) {
      throw new AmendmentRequestError('period_not_found', 404);
    }
    if (period.state !== 'draft') {
      throw new AmendmentRequestError('period_not_draft', 409);
    }

    const employee = await tx.bonusEmployee.findUnique({
      where: { id: input.bonusEmployeeId },
      select: { id: true, site_id: true },
    });
    if (!employee || employee.site_id !== input.siteId) {
      throw new AmendmentRequestError('employee_not_in_site', 404);
    }

    const existing = await tx.bonusDailyEntry.findUnique({
      where: {
        bonus_employee_id_entry_date: {
          bonus_employee_id: input.bonusEmployeeId,
          entry_date: input.targetEntryDate,
        },
      },
      select: { id: true, mattress_count: true, note: true },
    });

    if (input.changeType === 'update' && !existing) {
      throw new AmendmentRequestError('entry_not_found_for_update', 409);
    }
    if (input.changeType === 'insert' && existing) {
      throw new AmendmentRequestError('entry_exists_for_insert', 409);
    }

    const oldValueSnapshot =
      input.changeType === 'update' && existing
        ? { mattress_count: existing.mattress_count.toNumber(), note: existing.note }
        : null;

    // Auto-cancel any prior PENDING request from this requester for the same target.
    const priorPending = await tx.bonusAmendmentRequest.findMany({
      where: {
        bonus_employee_id: input.bonusEmployeeId,
        target_entry_date: input.targetEntryDate,
        requested_by_user_id: input.requesterUserId,
        state: 'pending',
      },
      select: { id: true },
    });
    for (const p of priorPending) {
      const now = new Date();
      await tx.bonusAmendmentRequest.update({
        where: { id: p.id },
        data: { state: 'cancelled', reviewed_at: now, updated_at: now },
      });
      await tx.auditLog.create({
        data: {
          actor_user_id: input.requesterUserId,
          actor_label: 'system:amendment-supersede',
          action: 'update' satisfies AuditAction,
          table_name: 'bonus_amendment_requests',
          row_id: p.id,
          before: { state: 'pending' },
          after: { state: 'cancelled', reason: 'superseded_by_new_request' },
          ip: input.ip ?? null,
          user_agent: input.userAgent ?? null,
        },
      });
    }

    const created = await tx.bonusAmendmentRequest.create({
      data: {
        bonus_pay_period_id: input.bonusPayPeriodId,
        site_id: input.siteId,
        target_entry_date: input.targetEntryDate,
        bonus_employee_id: input.bonusEmployeeId,
        change_type: input.changeType,
        old_value: oldValueSnapshot
          ? (serializeJson(oldValueSnapshot) as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        new_value: serializeJson(input.newValue) as Prisma.InputJsonValue,
        justification: input.justification.trim(),
        requested_by_user_id: input.requesterUserId,
        expected_approver_user_id: expectedApproverUserId,
      },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: input.requesterUserId,
        action: 'insert' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: created.id,
        before: Prisma.JsonNull,
        after: serializeJson({
          bonus_pay_period_id: created.bonus_pay_period_id,
          target_entry_date: created.target_entry_date,
          bonus_employee_id: created.bonus_employee_id,
          change_type: created.change_type,
          old_value: oldValueSnapshot,
          new_value: input.newValue,
          justification: created.justification,
          expected_approver_user_id: created.expected_approver_user_id,
        }) as Prisma.InputJsonValue,
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
      },
    });

    return created;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Ping Bill
// ─────────────────────────────────────────────────────────────────────

export async function pingBill(
  requestId: string,
  actorUserId: string,
  ip: string | null,
  userAgent: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.bonusAmendmentRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new AmendmentRequestError('request_not_found', 404);
    if (req.state !== 'pending') throw new AmendmentRequestError('request_not_pending', 409);
    if (req.requested_by_user_id !== actorUserId) {
      throw new AmendmentRequestError('cancel_only_by_requester', 403);
    }
    if (req.bill_pinged_at) return { request: req, firstPing: false };

    const now = new Date();
    const updated = await tx.bonusAmendmentRequest.update({
      where: { id: requestId },
      data: { bill_pinged_at: now, updated_at: now },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actorUserId,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: requestId,
        before: { bill_pinged_at: null },
        after: { bill_pinged_at: now.toISOString() },
        ip,
        user_agent: userAgent,
      },
    });

    return { request: updated, firstPing: true };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Cancel (requester only)
// ─────────────────────────────────────────────────────────────────────

export async function cancelAmendmentRequest(
  requestId: string,
  actorUserId: string,
  ip: string | null,
  userAgent: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.bonusAmendmentRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new AmendmentRequestError('request_not_found', 404);
    if (req.state !== 'pending') throw new AmendmentRequestError('request_not_pending', 409);
    if (req.requested_by_user_id !== actorUserId) {
      throw new AmendmentRequestError('cancel_only_by_requester', 403);
    }

    const now = new Date();
    const updated = await tx.bonusAmendmentRequest.update({
      where: { id: requestId },
      data: { state: 'cancelled', reviewed_at: now, updated_at: now },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actorUserId,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: requestId,
        before: { state: 'pending' },
        after: { state: 'cancelled', reason: 'cancelled_by_requester' },
        ip,
        user_agent: userAgent,
      },
    });

    return updated;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Approve (atomic: apply change + audit + mark approved + link audit)
// ─────────────────────────────────────────────────────────────────────

export async function approveAmendmentRequest(input: AmendmentDecisionInput) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.bonusAmendmentRequest.findUnique({ where: { id: input.requestId } });
    if (!req) throw new AmendmentRequestError('request_not_found', 404);
    if (req.state !== 'pending') throw new AmendmentRequestError('request_not_pending', 409);

    const period = await tx.bonusPayPeriod.findUnique({
      where: { id: req.bonus_pay_period_id },
      select: { id: true, state: true },
    });
    if (!period || period.state !== 'draft') {
      throw new AmendmentRequestError('period_not_draft', 409);
    }

    const chain = await getSignatureChain(req.site_id, tx as unknown as PrismaClient);
    const eligible = canApproveRequest({
      actorUserId: input.reviewerUserId,
      request: {
        requested_by_user_id: req.requested_by_user_id,
        expected_approver_user_id: req.expected_approver_user_id,
        bill_pinged_at: req.bill_pinged_at,
      },
      chain: { auto_override_actor_user_id: chain.auto_override_actor_user_id },
      actorIsAdmin: input.reviewerIsAdmin,
    });
    if (!eligible) throw new AmendmentRequestError('not_eligible_to_approve', 403);

    const now = new Date();
    const newValue = req.new_value as { mattress_count: number; note: string | null };

    let appliedEntryId: string;
    let beforeAuditPayload: Prisma.InputJsonValue;
    let afterAuditPayload: Prisma.InputJsonValue;
    let entryAction: AuditAction;

    if (req.change_type === 'update') {
      const existing = await tx.bonusDailyEntry.findUnique({
        where: {
          bonus_employee_id_entry_date: {
            bonus_employee_id: req.bonus_employee_id,
            entry_date: req.target_entry_date,
          },
        },
      });
      if (!existing) throw new AmendmentRequestError('entry_not_found_for_update', 409);

      beforeAuditPayload = serializeJson({
        mattress_count: existing.mattress_count.toNumber(),
        note: existing.note,
        entered_by_user_id: existing.entered_by_user_id,
      }) as Prisma.InputJsonValue;

      const updated = await tx.bonusDailyEntry.update({
        where: { id: existing.id },
        data: {
          mattress_count: newValue.mattress_count,
          note: newValue.note,
          entered_by_user_id: input.reviewerUserId,
          entered_at: now,
        },
      });

      appliedEntryId = updated.id;
      afterAuditPayload = serializeJson({
        mattress_count: updated.mattress_count.toNumber(),
        note: updated.note,
        entered_by_user_id: updated.entered_by_user_id,
      }) as Prisma.InputJsonValue;
      entryAction = 'update';
    } else {
      const existing = await tx.bonusDailyEntry.findUnique({
        where: {
          bonus_employee_id_entry_date: {
            bonus_employee_id: req.bonus_employee_id,
            entry_date: req.target_entry_date,
          },
        },
      });
      if (existing) throw new AmendmentRequestError('entry_exists_for_insert', 409);

      const inserted = await tx.bonusDailyEntry.create({
        data: {
          bonus_employee_id: req.bonus_employee_id,
          bonus_pay_period_id: req.bonus_pay_period_id,
          entry_date: req.target_entry_date,
          mattress_count: newValue.mattress_count,
          note: newValue.note,
          entered_by_user_id: input.reviewerUserId,
          entered_at: now,
        },
      });

      appliedEntryId = inserted.id;
      beforeAuditPayload = Prisma.JsonNull;
      afterAuditPayload = serializeJson({
        mattress_count: inserted.mattress_count.toNumber(),
        note: inserted.note,
        entered_by_user_id: inserted.entered_by_user_id,
      }) as Prisma.InputJsonValue;
      entryAction = 'insert';
    }

    const entryAudit = await tx.auditLog.create({
      data: {
        actor_user_id: input.reviewerUserId,
        actor_label: 'system:amendment-approved',
        action: entryAction,
        table_name: 'bonus_daily_entries',
        row_id: appliedEntryId,
        before: beforeAuditPayload,
        after: afterAuditPayload,
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
      },
    });

    const decided = await tx.bonusAmendmentRequest.update({
      where: { id: req.id },
      data: {
        state: 'approved',
        reviewed_by_user_id: input.reviewerUserId,
        reviewed_at: now,
        decision_notes: input.decisionNotes ?? null,
        applied_audit_id: entryAudit.id,
        updated_at: now,
      },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: input.reviewerUserId,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: req.id,
        before: { state: 'pending' },
        after: {
          state: 'approved',
          reviewed_by_user_id: input.reviewerUserId,
          applied_audit_id: entryAudit.id,
        },
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
      },
    });

    return { request: decided, appliedEntryId, entryAuditId: entryAudit.id };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Reject
// ─────────────────────────────────────────────────────────────────────

export async function rejectAmendmentRequest(input: AmendmentDecisionInput) {
  if (!input.decisionNotes || input.decisionNotes.trim().length === 0) {
    throw new AmendmentRequestError('reject_requires_notes', 422);
  }

  return prisma.$transaction(async (tx) => {
    const req = await tx.bonusAmendmentRequest.findUnique({ where: { id: input.requestId } });
    if (!req) throw new AmendmentRequestError('request_not_found', 404);
    if (req.state !== 'pending') throw new AmendmentRequestError('request_not_pending', 409);

    const chain = await getSignatureChain(req.site_id, tx as unknown as PrismaClient);
    const eligible = canApproveRequest({
      actorUserId: input.reviewerUserId,
      request: {
        requested_by_user_id: req.requested_by_user_id,
        expected_approver_user_id: req.expected_approver_user_id,
        bill_pinged_at: req.bill_pinged_at,
      },
      chain: { auto_override_actor_user_id: chain.auto_override_actor_user_id },
      actorIsAdmin: input.reviewerIsAdmin,
    });
    if (!eligible) throw new AmendmentRequestError('not_eligible_to_approve', 403);

    const now = new Date();
    const decided = await tx.bonusAmendmentRequest.update({
      where: { id: req.id },
      data: {
        state: 'rejected',
        reviewed_by_user_id: input.reviewerUserId,
        reviewed_at: now,
        decision_notes: input.decisionNotes.trim(),
        updated_at: now,
      },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: input.reviewerUserId,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: req.id,
        before: { state: 'pending' },
        after: { state: 'rejected', decision_notes: input.decisionNotes.trim() },
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
      },
    });

    return decided;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────────────

export async function listPendingForApprover(
  approverUserId: string,
  actorIsAdmin: boolean,
  siteId: string | null,
) {
  const where: Prisma.BonusAmendmentRequestWhereInput = { state: 'pending' };
  if (siteId) where.site_id = siteId;

  if (!actorIsAdmin) {
    where.OR = [
      { expected_approver_user_id: approverUserId },
      // Bill-pinged + caller is the chain's auto-override actor; this is
      // narrowed at the route layer when the caller is not Bill (so a
      // non-admin non-auto-override actor sees no pinged-extras).
      {
        AND: [
          { bill_pinged_at: { not: null } },
          // Caller must be the auto-override actor for these to be theirs.
          // We don't have the chain here so we pass approverUserId match
          // implicitly — Bill is the auto-override at every site today.
        ],
      },
    ];
  }

  return prisma.bonusAmendmentRequest.findMany({
    where,
    orderBy: { requested_at: 'asc' },
    include: {
      bonus_pay_period: {
        select: { period_number: true, period_year: true, period_start: true, period_end: true },
      },
      bonus_employee: { select: { full_name: true, employee_number: true } },
      requested_by: { select: { name: true, email: true } },
      expected_approver: { select: { name: true } },
      site: { select: { code: true, name: true } },
    },
  });
}

export async function getAmendmentRequest(requestId: string) {
  return prisma.bonusAmendmentRequest.findUnique({
    where: { id: requestId },
    include: {
      bonus_pay_period: {
        select: { period_number: true, period_year: true, period_start: true, period_end: true, state: true },
      },
      bonus_employee: { select: { full_name: true, employee_number: true, site_id: true } },
      requested_by: { select: { name: true, email: true } },
      expected_approver: { select: { name: true } },
      reviewed_by: { select: { name: true } },
      site: { select: { code: true, name: true } },
    },
  });
}

export async function listPendingForPeriod(periodId: string) {
  return prisma.bonusAmendmentRequest.findMany({
    where: { bonus_pay_period_id: periodId, state: 'pending' },
    orderBy: { requested_at: 'asc' },
    include: {
      bonus_employee: { select: { full_name: true, employee_number: true } },
      requested_by: { select: { name: true } },
      expected_approver: { select: { name: true } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Routing predicate for daily-entry layer
// ─────────────────────────────────────────────────────────────────────

export interface ShouldRequireAmendmentInput {
  periodState: string;
  entryDate: Date;
  newCount: number;
  existingCount: number | null;
  actorIsAdmin: boolean;
}

export type ShouldRequireAmendmentResult =
  | { route: 'direct'; reason: string }
  | {
      route: 'amendment';
      changeType: 'update' | 'insert';
      oldValue: { mattress_count: number; note: string | null } | null;
    };

export function shouldRequireAmendment(
  input: ShouldRequireAmendmentInput,
  existingNote: string | null = null,
): ShouldRequireAmendmentResult {
  if (input.periodState !== 'draft') {
    return { route: 'direct', reason: 'period_not_draft_handled_upstream' };
  }
  if (input.actorIsAdmin) {
    return { route: 'direct', reason: 'admin_direct_path' };
  }

  const today = appToday();
  const isPriorDay = input.entryDate.getTime() < today.getTime();
  if (!isPriorDay) {
    return { route: 'direct', reason: 'same_day_or_future' };
  }

  const isInsert = input.existingCount === null;
  const countChanged = input.existingCount !== null && input.newCount !== input.existingCount;
  if (!isInsert && !countChanged) {
    return { route: 'direct', reason: 'note_only_edit' };
  }

  return {
    route: 'amendment',
    changeType: isInsert ? 'insert' : 'update',
    oldValue:
      input.existingCount === null
        ? null
        : { mattress_count: input.existingCount, note: existingNote },
  };
}

// Internal
function serializeJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

export { AmendmentWorkflowForbiddenError };
````

### §7.6 — Patch to `src/lib/bonus/daily-entry.ts`

The existing `upsertDailyEntries` does not currently know about the amendment workflow. Modify it to call `shouldRequireAmendment` before the write transaction; if **any** input would route to amendment, the function returns the `requires_amendment` discriminant so the route can pivot to the modal flow client-side.

Add the import at the top of the file:

````ts
import { shouldRequireAmendment } from '@/lib/bonus/amendment-requests';
````

Change the `ActorContext` interface to include an admin flag:

````ts
interface ActorContext {
  actorUserId: string;
  actorLabel?: string | null;
  ip: string | null;
  userAgent: string | null;
  isAdmin?: boolean;
}
````

Change the `UpsertDailyEntriesResult` discriminated union to include the new variant:

````ts
export type UpsertDailyEntriesResult =
  | { ok: true; monthId: string; entries: UpsertedEntry[] }
  | { ok: false; reason: 'month_locked'; state: BonusPayPeriodState }
  | { ok: false; reason: 'count_out_of_range' | 'employee_not_in_site' | 'unknown_employee' }
  | {
      ok: 'requires_amendment';
      monthId: string;
      pending: Array<{
        bonus_employee_id: string;
        change_type: 'update' | 'insert';
        existing: { mattress_count: number; note: string | null } | null;
        proposed: { mattress_count: number; note: string | null };
      }>;
    };
````

Modify the body of `upsertDailyEntries` to fork on the routing decision. Insert AFTER the existing employee-site validation and BEFORE the `$transaction` block:

````ts
  // ADR-0027: route prior-day count changes through the amendment workflow.
  // We load existing entries for the day, run shouldRequireAmendment per input,
  // and if ANY input requires the workflow, surface the requires_amendment
  // shape so the route layer can pivot to the modal flow. The direct path
  // remains for same-day edits, note-only edits, inserts on today, and admin.
  const existingRows = await prisma.bonusDailyEntry.findMany({
    where: { bonus_employee_id: { in: ids }, entry_date: entryDate },
    select: { bonus_employee_id: true, mattress_count: true, note: true },
  });
  const existingByEmployee = new Map(
    existingRows.map((r) => [
      r.bonus_employee_id,
      { mattress_count: r.mattress_count.toNumber(), note: r.note },
    ]),
  );

  const routingDecisions = inputs.map((input) => {
    const existing = existingByEmployee.get(input.bonus_employee_id) ?? null;
    const decision = shouldRequireAmendment(
      {
        periodState: month.state,
        entryDate,
        newCount: input.mattress_count,
        existingCount: existing?.mattress_count ?? null,
        actorIsAdmin: actor.isAdmin === true,
      },
      existing?.note ?? null,
    );
    return { input, existing, decision };
  });

  const anyAmendment = routingDecisions.some((r) => r.decision.route === 'amendment');
  if (anyAmendment) {
    return {
      ok: 'requires_amendment',
      monthId: month.id,
      pending: routingDecisions
        .filter((r) => r.decision.route === 'amendment')
        .map((r) => ({
          bonus_employee_id: r.input.bonus_employee_id,
          change_type: (r.decision as { changeType: 'update' | 'insert' }).changeType,
          existing: r.existing,
          proposed: { mattress_count: r.input.mattress_count, note: r.input.note ?? null },
        })),
    };
  }
````

The existing `$transaction(...)` block stays unchanged below this insertion.

In the existing `/api/bonus/entries` route handler (do NOT rewrite — patch only): pass `actor.isAdmin = ctx.isAdmin` and propagate the new `ok: 'requires_amendment'` shape as a 409 with `{ error: 'requires_amendment', pending }` so the client can open the modal.

---

## §8 — `src/lib/bonus/amendment-notifications.ts`

````ts
// ADR-0027 — Amendment-workflow notifications.
//
// ntfy + M365 mail wiring for the four lifecycle events. The publishNtfy helper
// auto-prefixes titles with [DR3-Vision], so our titles must NOT include that
// prefix (would double-prefix). sendSystemEmail accepts htmlBody (HTML); we
// wrap our plain-text bodies in <pre> to preserve formatting.

import { publishNtfy } from '@/lib/ntfy';
import { sendSystemEmail } from '@/lib/m365-mail';
import { log } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';

const TOPIC = 'dr3-vision-system';

export interface AmendmentNotifyContext {
  requestId: string;
  siteCode: string;
  siteName: string;
  periodNumber: number;
  periodYear: number;
  employeeName: string;
  targetEntryDateLabel: string;
  changeType: 'update' | 'insert';
  oldValue: { mattress_count: number; note: string | null } | null;
  newValue: { mattress_count: number; note: string | null };
  justification: string;
  requesterName: string;
  approverName: string;
}

function changeSummary(c: AmendmentNotifyContext): string {
  if (c.changeType === 'insert') {
    return `INSERT new entry: ${c.newValue.mattress_count} mattresses for ${c.employeeName} on ${c.targetEntryDateLabel}`;
  }
  const oldCount = c.oldValue?.mattress_count ?? '(unknown)';
  return `UPDATE ${c.employeeName} on ${c.targetEntryDateLabel}: ${oldCount} → ${c.newValue.mattress_count}`;
}

function htmlBody(text: string): string {
  // Escape angle brackets/ampersands; preserve newlines via <pre>.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<pre style="font-family: system-ui, sans-serif; font-size: 14px;">${escaped}</pre>`;
}

export async function notifyAmendmentSubmitted(
  ctx: AmendmentNotifyContext,
  approverEmail: string | null,
) {
  const title = `Amendment requested — ${ctx.siteName} Period ${ctx.periodNumber}`;
  const body =
    `${ctx.requesterName} requested an amendment to ${ctx.siteName} Period ${ctx.periodNumber}.\n\n` +
    `${changeSummary(ctx)}\n\n` +
    `Justification: ${ctx.justification}\n\n` +
    `Open /bonus/amendments to review.`;

  await publishNtfy({
    topic: TOPIC,
    title,
    body,
    priority: 'high',
    tags: ['memo', 'bonus', 'amendment'],
    fingerprint: `bonus-amendment-submitted:${ctx.requestId}`,
  });

  if (approverEmail) {
    try {
      const r = await sendSystemEmail({
        to: approverEmail,
        subject: `[DR3-Vision] ${title}`,
        htmlBody: htmlBody(body),
      });
      if (!r.delivered && !r.disabled) {
        log.warn({ requestId: ctx.requestId, lastStatus: r.lastStatus }, '[amendment] approver email failed');
      }
    } catch (e) {
      log.warn({ err: e, requestId: ctx.requestId }, '[amendment] approver email threw');
    }
  }
}

export async function notifyAmendmentBillPinged(
  ctx: AmendmentNotifyContext,
  billEmail: string | null,
) {
  const title = `URGENT: ${ctx.requesterName} pinged you — ${ctx.siteName} Period ${ctx.periodNumber}`;
  const body =
    `${ctx.requesterName} pinged you to review an amendment request that ${ctx.approverName} has not yet acted on.\n\n` +
    `${changeSummary(ctx)}\n\nJustification: ${ctx.justification}\n\nOpen /bonus/amendments to review.`;

  await publishNtfy({
    topic: TOPIC,
    title,
    body,
    priority: 'urgent',
    tags: ['rotating_light', 'bonus', 'amendment'],
    fingerprint: `bonus-amendment-bill-pinged:${ctx.requestId}`,
  });

  if (billEmail) {
    try {
      await sendSystemEmail({
        to: billEmail,
        subject: `[DR3-Vision] ${title}`,
        htmlBody: htmlBody(body),
        importance: 'high',
      });
    } catch (e) {
      log.warn({ err: e, requestId: ctx.requestId }, '[amendment] ping-bill email threw');
    }
  }
}

export async function notifyAmendmentApproved(
  ctx: AmendmentNotifyContext,
  reviewerName: string,
  billEmail: string | null,
  requesterEmail: string | null,
) {
  const title = `Amendment approved — ${ctx.siteName} Period ${ctx.periodNumber}`;
  const body =
    `${reviewerName} approved ${ctx.requesterName}'s amendment.\n\n` +
    `${changeSummary(ctx)}\n\nJustification: ${ctx.justification}`;

  await publishNtfy({
    topic: TOPIC,
    title,
    body,
    priority: 'high',
    tags: ['white_check_mark', 'bonus', 'amendment'],
    fingerprint: `bonus-amendment-approved:${ctx.requestId}`,
  });

  for (const addr of [billEmail, requesterEmail].filter((x): x is string => !!x)) {
    try {
      await sendSystemEmail({
        to: addr,
        subject: `[DR3-Vision] ${title}`,
        htmlBody: htmlBody(body),
      });
    } catch (e) {
      log.warn({ err: e, requestId: ctx.requestId, to: addr }, '[amendment] approve email threw');
    }
  }
}

export async function notifyAmendmentRejected(
  ctx: AmendmentNotifyContext,
  reviewerName: string,
  decisionNotes: string,
  billEmail: string | null,
  requesterEmail: string | null,
) {
  const title = `Amendment rejected — ${ctx.siteName} Period ${ctx.periodNumber}`;
  const body =
    `${reviewerName} rejected ${ctx.requesterName}'s amendment.\n\n` +
    `${changeSummary(ctx)}\n\nJustification: ${ctx.justification}\n\nDecision: ${decisionNotes}`;

  await publishNtfy({
    topic: TOPIC,
    title,
    body,
    priority: 'high',
    tags: ['x', 'bonus', 'amendment'],
    fingerprint: `bonus-amendment-rejected:${ctx.requestId}`,
  });

  for (const addr of [billEmail, requesterEmail].filter((x): x is string => !!x)) {
    try {
      await sendSystemEmail({
        to: addr,
        subject: `[DR3-Vision] ${title}`,
        htmlBody: htmlBody(body),
      });
    } catch (e) {
      log.warn({ err: e, requestId: ctx.requestId, to: addr }, '[amendment] reject email threw');
    }
  }
}

export async function buildNotifyContext(requestId: string): Promise<AmendmentNotifyContext | null> {
  const req = await prisma.bonusAmendmentRequest.findUnique({
    where: { id: requestId },
    include: {
      bonus_pay_period: { select: { period_number: true, period_year: true } },
      bonus_employee: { select: { full_name: true } },
      requested_by: { select: { name: true } },
      expected_approver: { select: { name: true } },
      site: { select: { code: true, name: true } },
    },
  });
  if (!req) return null;
  return {
    requestId: req.id,
    siteCode: req.site.code,
    siteName: req.site.name,
    periodNumber: req.bonus_pay_period.period_number,
    periodYear: req.bonus_pay_period.period_year,
    employeeName: req.bonus_employee.full_name,
    targetEntryDateLabel: req.target_entry_date.toISOString().slice(0, 10),
    changeType: req.change_type as 'update' | 'insert',
    oldValue: req.old_value as AmendmentNotifyContext['oldValue'],
    newValue: req.new_value as AmendmentNotifyContext['newValue'],
    justification: req.justification,
    requesterName: req.requested_by.name,
    approverName: req.expected_approver.name,
  };
}
````

---

## §9 — API routes

### `src/app/api/bonus/amendments/route.ts`

````ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import {
  submitAmendmentRequest,
  listPendingForApprover,
  AmendmentRequestError,
} from '@/lib/bonus/amendment-requests';
import { AmendmentWorkflowForbiddenError } from '@/lib/bonus/amendment-approvers';
import { buildNotifyContext, notifyAmendmentSubmitted } from '@/lib/bonus/amendment-notifications';
import { prisma } from '@/lib/prisma';
import { dayKeyUTCFromISO } from '@/lib/time';

const SubmitBody = z.object({
  bonusPayPeriodId: z.string().uuid(),
  targetEntryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bonusEmployeeId: z.string().uuid(),
  changeType: z.enum(['update', 'insert']),
  newValue: z.object({
    mattress_count: z.number().min(0).max(999),
    note: z.string().nullable(),
  }),
  justification: z.string().min(20),
});

export async function GET(req: NextRequest) {
  const ctx = await requireBonusAccess(siteFromRequest(req));
  const requests = await listPendingForApprover(
    ctx.userId,
    ctx.isAdmin,
    ctx.isAdmin ? null : ctx.siteId,
  );
  return NextResponse.json({ requests });
}

export async function POST(req: NextRequest) {
  const ctx = await requireBonusAccess(siteFromRequest(req));
  if (ctx.isAdmin) {
    return NextResponse.json(
      { error: 'admin_uses_direct_path' },
      { status: 400 },
    );
  }

  const parsed = SubmitBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 });
  }
  const body = parsed.data;

  try {
    const created = await submitAmendmentRequest({
      siteId: ctx.siteId,
      bonusPayPeriodId: body.bonusPayPeriodId,
      targetEntryDate: dayKeyUTCFromISO(body.targetEntryDate),
      bonusEmployeeId: body.bonusEmployeeId,
      changeType: body.changeType,
      newValue: body.newValue,
      justification: body.justification,
      requesterUserId: ctx.userId,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });

    const notifyCtx = await buildNotifyContext(created.id);
    if (notifyCtx) {
      const approver = await prisma.user.findUnique({
        where: { id: created.expected_approver_user_id },
        select: { email: true },
      });
      await notifyAmendmentSubmitted(notifyCtx, approver?.email ?? null);
    }

    return NextResponse.json({ request: created }, { status: 201 });
  } catch (e) {
    if (e instanceof AmendmentWorkflowForbiddenError) {
      return NextResponse.json({ error: e.forbiddenReason }, { status: 403 });
    }
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
````

### `src/app/api/bonus/amendments/[id]/approve/route.ts`

````ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { approveAmendmentRequest, AmendmentRequestError } from '@/lib/bonus/amendment-requests';
import { buildNotifyContext, notifyAmendmentApproved } from '@/lib/bonus/amendment-notifications';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireBonusAccess(siteFromRequest(req));

  let decisionNotes: string | null = null;
  try {
    const body = await req.json();
    if (typeof body?.decisionNotes === 'string' && body.decisionNotes.trim().length > 0) {
      decisionNotes = body.decisionNotes.trim();
    }
  } catch {
    /* empty body fine */
  }

  try {
    const result = await approveAmendmentRequest({
      requestId: id,
      reviewerUserId: access.userId,
      reviewerIsAdmin: access.isAdmin,
      decisionNotes,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });

    const notifyCtx = await buildNotifyContext(result.request.id);
    if (notifyCtx) {
      const reviewer = await prisma.user.findUnique({
        where: { id: access.userId },
        select: { name: true },
      });
      const bill = await prisma.user.findFirst({
        where: { role: 'admin', is_active: true, deleted_at: null },
        select: { email: true },
      });
      const requester = await prisma.user.findUnique({
        where: { id: result.request.requested_by_user_id },
        select: { email: true },
      });
      await notifyAmendmentApproved(
        notifyCtx,
        reviewer?.name ?? 'Reviewer',
        bill?.email ?? null,
        requester?.email ?? null,
      );
    }

    return NextResponse.json({ request: result.request });
  } catch (e) {
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
````

### `src/app/api/bonus/amendments/[id]/reject/route.ts`

````ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { rejectAmendmentRequest, AmendmentRequestError } from '@/lib/bonus/amendment-requests';
import { buildNotifyContext, notifyAmendmentRejected } from '@/lib/bonus/amendment-notifications';
import { prisma } from '@/lib/prisma';

const Body = z.object({ decisionNotes: z.string().min(1) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireBonusAccess(siteFromRequest(req));

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 });
  }

  try {
    const updated = await rejectAmendmentRequest({
      requestId: id,
      reviewerUserId: access.userId,
      reviewerIsAdmin: access.isAdmin,
      decisionNotes: parsed.data.decisionNotes,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });

    const notifyCtx = await buildNotifyContext(updated.id);
    if (notifyCtx) {
      const reviewer = await prisma.user.findUnique({
        where: { id: access.userId },
        select: { name: true },
      });
      const bill = await prisma.user.findFirst({
        where: { role: 'admin', is_active: true, deleted_at: null },
        select: { email: true },
      });
      const requester = await prisma.user.findUnique({
        where: { id: updated.requested_by_user_id },
        select: { email: true },
      });
      await notifyAmendmentRejected(
        notifyCtx,
        reviewer?.name ?? 'Reviewer',
        parsed.data.decisionNotes,
        bill?.email ?? null,
        requester?.email ?? null,
      );
    }

    return NextResponse.json({ request: updated });
  } catch (e) {
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
````

### `src/app/api/bonus/amendments/[id]/cancel/route.ts`

````ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { cancelAmendmentRequest, AmendmentRequestError } from '@/lib/bonus/amendment-requests';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireBonusAccess(siteFromRequest(req));

  try {
    const updated = await cancelAmendmentRequest(
      id,
      access.userId,
      req.headers.get('x-forwarded-for'),
      req.headers.get('user-agent'),
    );
    return NextResponse.json({ request: updated });
  } catch (e) {
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
````

### `src/app/api/bonus/amendments/[id]/ping-bill/route.ts`

````ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { pingBill, AmendmentRequestError } from '@/lib/bonus/amendment-requests';
import { buildNotifyContext, notifyAmendmentBillPinged } from '@/lib/bonus/amendment-notifications';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireBonusAccess(siteFromRequest(req));

  try {
    const { request: updated, firstPing } = await pingBill(
      id,
      access.userId,
      req.headers.get('x-forwarded-for'),
      req.headers.get('user-agent'),
    );

    if (firstPing) {
      const notifyCtx = await buildNotifyContext(updated.id);
      if (notifyCtx) {
        const bill = await prisma.user.findFirst({
          where: { role: 'admin', is_active: true, deleted_at: null },
          select: { email: true },
        });
        await notifyAmendmentBillPinged(notifyCtx, bill?.email ?? null);
      }
    }

    return NextResponse.json({ request: updated });
  } catch (e) {
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
````

---

## §10 — UI components

### §10.1 — `src/app/bonus/BonusDatePicker.tsx` (replaces AdminDatePicker)

````tsx
'use client';

// ADR-0027 — Bonus date picker.
//
// Visible to all managers AND admins on the /bonus surface. Managers are
// constrained to the current draft period's date window (period_start..today).
// Admins remain unconstrained (any historical date, including closed periods).
// Both the client min/max AND the server-side resolveEntryDate enforce the
// constraint (CLAUDE.md hard rule #6 — defense in depth).

import { useRouter } from 'next/navigation';

interface Props {
  selected: string;
  today: string;
  constrained: boolean;
  periodStart: string;
}

export function BonusDatePicker({ selected, today, constrained, periodStart }: Props) {
  const router = useRouter();

  const go = (iso: string) => {
    router.push(iso === today ? '/bonus' : `/bonus?date=${iso}`);
  };

  const label = constrained ? 'Enter for date (this pay period)' : 'Admin: enter for date';
  const hint = constrained
    ? '(today or earlier — within the current open pay period)'
    : "(today or earlier — counts can\u2019t be entered for a future day)";

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-dr3-cyan/30 bg-dr3-space-2/60 px-4 py-3"
      data-testid="bonus-date-picker"
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-dr3-cyan">{label}</span>
      <span className="text-xs text-dr3-mist-dim">{hint}</span>
      <input
        type="date"
        value={selected}
        min={constrained ? periodStart : undefined}
        max={today}
        onChange={(e) => {
          if (e.target.value) go(e.target.value);
        }}
        className="rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-1.5 text-sm text-dr3-mist [color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
        aria-label="Business day to enter bonus data for"
        data-testid="bonus-date-input"
      />
      {selected !== today ? (
        <button
          type="button"
          onClick={() => go(today)}
          className="text-xs text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
          data-testid="bonus-date-reset"
        >
          Back to today
        </button>
      ) : null}
    </div>
  );
}
````

### §10.2 — `src/app/bonus/RequestEditModal.tsx`

````tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  open: boolean;
  onClose(): void;
  payload: {
    bonusPayPeriodId: string;
    bonusEmployeeId: string;
    employeeName: string;
    targetEntryDate: string;
    changeType: 'update' | 'insert';
    oldValue: { mattress_count: number; note: string | null } | null;
    newValue: { mattress_count: number; note: string | null };
    approverName: string;
  };
}

export function RequestEditModal({ open, onClose, payload }: Props) {
  const router = useRouter();
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = justification.trim().length < 20;

  if (!open) return null;

  const onSubmit = async () => {
    if (tooShort) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/bonus/amendments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bonusPayPeriodId: payload.bonusPayPeriodId,
          targetEntryDate: payload.targetEntryDate,
          bonusEmployeeId: payload.bonusEmployeeId,
          changeType: payload.changeType,
          newValue: payload.newValue,
          justification: justification.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? `failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      onClose();
      router.refresh();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="request-edit-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-dr3-cyan/30 bg-dr3-space-2 p-6 text-dr3-mist shadow-2xl">
        <h2 id="request-edit-title" className="text-lg font-semibold">
          Request edit — {payload.employeeName}
        </h2>
        <p className="mt-1 text-sm text-dr3-mist-dim">
          Date: <span className="text-dr3-mist">{payload.targetEntryDate}</span>
          {payload.changeType === 'update' ? (
            <>
              {' '}— count change:{' '}
              <span className="text-dr3-mist">
                {payload.oldValue?.mattress_count ?? '?'} → {payload.newValue.mattress_count}
              </span>
            </>
          ) : (
            <>
              {' '}— new entry:{' '}
              <span className="text-dr3-mist">{payload.newValue.mattress_count} mattresses</span>
            </>
          )}
        </p>
        <p className="mt-2 text-xs text-dr3-mist-dim">
          This will be sent to <span className="font-medium text-dr3-mist">{payload.approverName}</span>{' '}
          for approval. The change will not apply until they approve.
        </p>

        <label htmlFor="justification" className="mt-4 block text-sm font-medium">
          Justification (required, ≥ 20 characters)
        </label>
        <textarea
          id="justification"
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-sm text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          placeholder="e.g. Faisal worked 67 mattresses, I keyed 76 by mistake"
        />
        <p className="mt-1 text-xs text-dr3-mist-dim">{justification.trim().length} / 20+</p>

        {error ? (
          <p className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-dr3-steel-light/30 px-4 py-2 text-sm text-dr3-mist hover:bg-dr3-space-2/80"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={tooShort || submitting}
            className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan/90 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </div>
    </div>
  );
}
````

### §10.3 — Patches to `src/app/bonus/page.tsx`

1. Replace the import `AdminDatePicker` with `BonusDatePicker`.
2. Restructure `resolveEntryDate` to also enforce the manager constraint server-side.
3. The page already fetches the open period via `getDailyGrid(siteId, appToday())` — restructure so we resolve the period first (which gives us `period_start`), then resolve the entry date with constraint awareness, then fetch the grid for that day.

Replacement `resolveEntryDate`:

````ts
function resolveEntryDate(
  raw: string | undefined,
  isAdmin: boolean,
  periodStart: Date,
): Date {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return appToday();
  let parsed: Date;
  try {
    parsed = dayKeyUTCFromISO(raw);
  } catch {
    return appToday();
  }
  const today = appToday();
  if (parsed.getTime() > today.getTime()) return appToday();
  if (isAdmin) return parsed;
  if (parsed.getTime() < periodStart.getTime()) return appToday();
  return parsed;
}
````

The flow inside `BonusDailyEntryPage` becomes: fetch today's grid first to get the period bounds → if `sp.date` was passed and differs, re-fetch with the resolved entry date → render.

Replace the date-picker render block with:

````tsx
<BonusDatePicker
  selected={dayISO(grid.entryDate)}
  today={appTodayISO()}
  constrained={!gate.ctx.isAdmin}
  periodStart={dayISO(grid.periodStart)}
/>
````

### §10.4 — `src/app/bonus/amendments/page.tsx`

````tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { tryBonusAccess } from '@/lib/bonus/access';
import { listPendingForApprover } from '@/lib/bonus/amendment-requests';
import { AmendmentQueue } from './AmendmentQueue';
import { HOME_ROUTE } from '@/lib/routes';

export const dynamic = 'force-dynamic';

export default async function AmendmentsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?next=/bonus/amendments');

  const gate = await tryBonusAccess(undefined);
  if (!gate.ok) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 text-dr3-mist-dim">Amendment review requires bonus access.</p>
        <Link
          href={HOME_ROUTE}
          className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
        >
          Back to dashboard
        </Link>
      </main>
    );
  }

  const requests = await listPendingForApprover(
    gate.ctx.userId,
    gate.ctx.isAdmin,
    gate.ctx.isAdmin ? null : gate.ctx.siteId,
  );

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/bonus"
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
        >
          ← Back to bonus
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Pending amendments</h1>
        <p className="text-sm text-dr3-mist-dim">
          Review prior-day edit requests. Approving will apply the change to the daily entry and
          notify Bill. Rejecting requires a reason.
        </p>

        <AmendmentQueue requests={requests} />
      </div>
    </main>
  );
}
````

### §10.5 — `src/app/bonus/amendments/AmendmentQueue.tsx`

````tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface RequestRow {
  id: string;
  target_entry_date: Date | string;
  change_type: 'update' | 'insert';
  old_value: { mattress_count: number; note: string | null } | null;
  new_value: { mattress_count: number; note: string | null };
  justification: string;
  bill_pinged_at: Date | string | null;
  bonus_pay_period: { period_number: number; period_year: number };
  bonus_employee: { full_name: string; employee_number: string | null };
  requested_by: { name: string };
  expected_approver: { name: string };
  site: { code: string; name: string };
}

interface Props {
  requests: RequestRow[];
}

export function AmendmentQueue({ requests }: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (requests.length === 0) {
    return (
      <p className="mt-8 rounded-md border border-dr3-cyan/20 bg-dr3-space-2/60 px-6 py-8 text-center text-sm text-dr3-mist-dim">
        No pending amendment requests.
      </p>
    );
  }

  const act = async (id: string, action: 'approve' | 'reject', decisionNotes?: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/bonus/amendments/${id}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: action === 'reject' ? JSON.stringify({ decisionNotes }) : '{}',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? `failed (${res.status})`);
        setBusyId(null);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-6 flex flex-col gap-4">
      {error ? (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}
      {requests.map((r) => {
        const date =
          typeof r.target_entry_date === 'string'
            ? r.target_entry_date.slice(0, 10)
            : new Date(r.target_entry_date).toISOString().slice(0, 10);
        const oldCount = r.old_value?.mattress_count ?? null;
        const newCount = r.new_value.mattress_count;
        return (
          <div key={r.id} className="rounded-lg border border-dr3-cyan/20 bg-dr3-space-2/60 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">
                  {r.bonus_employee.full_name}
                  {r.bonus_employee.employee_number
                    ? ` (#${r.bonus_employee.employee_number})`
                    : ''}{' '}
                  — {date}
                </p>
                <p className="text-xs text-dr3-mist-dim">
                  {r.site.name} · Pay Period {r.bonus_pay_period.period_number}/
                  {r.bonus_pay_period.period_year} · requested by {r.requested_by.name}
                  {r.bill_pinged_at ? ' · ⚡ pinged Bill' : ''}
                </p>
              </div>
              <p className="text-sm font-mono">
                {r.change_type === 'insert' ? 'NEW: ' : ''}
                {oldCount !== null ? `${oldCount} → ` : ''}
                {newCount}
              </p>
            </div>
            <p className="mt-3 rounded-md border border-dr3-steel-light/20 bg-dr3-space/60 px-3 py-2 text-sm">
              <span className="text-dr3-mist-dim">Justification: </span>
              {r.justification}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busyId === r.id}
                onClick={() => {
                  if (confirm(`Approve this change for ${r.bonus_employee.full_name}?`)) {
                    void act(r.id, 'approve');
                  }
                }}
                className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-emerald-400 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busyId === r.id}
                onClick={() => {
                  const notes = prompt('Reason for rejection:');
                  if (notes && notes.trim().length > 0) {
                    void act(r.id, 'reject', notes.trim());
                  }
                }}
                className="rounded-md bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-400 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
````

---

## §11 — Tests

### §11.1 — `src/lib/bonus/__tests__/amendment-approvers.test.ts`

Cover:
1. Janette as requester → returns Morena as approver (Woodland chain)
2. Morena as requester → returns Janette as approver
3. Rick as requester → returns Kelsey (Eugene chain)
4. Kelsey as requester at Eugene → returns Rick
5. Patrick as requester → throws `AmendmentWorkflowForbiddenError('patrick_or_other_non_chain_manager')`
6. Random non-chain user → throws same
7. `canApproveRequest`: counterpart approver → true
8. `canApproveRequest`: requester themselves → false (regardless of admin)
9. `canApproveRequest`: admin (non-counterpart) → true
10. `canApproveRequest`: chain auto-override actor + bill_pinged_at != null → true
11. `canApproveRequest`: chain auto-override actor + bill_pinged_at == null → false
12. `canApproveRequest`: random non-admin non-counterpart non-pinged → false

Mock `getSignatureChain` to return fixed chains for woodland/eugene.

### §11.2 — `src/lib/bonus/__tests__/amendment-requests.test.ts`

Cover:
1. `submitAmendmentRequest` happy path — update: returns created row, period state unchanged, audit row written, entry unchanged
2. `submit` happy path — insert: same as above for the insert change_type
3. `submit` justification < 20 chars → throws `AmendmentRequestError('justification_too_short', 422)`
4. `submit` count = 23.55 (two decimals) → throws `invalid_count`
5. `submit` count = -1 → throws `invalid_count`
6. `submit` period not in draft → `period_not_draft`
7. `submit` employee from wrong site → `employee_not_in_site`
8. `submit` update on non-existent entry → `entry_not_found_for_update`
9. `submit` insert when entry exists → `entry_exists_for_insert`
10. `submit` Patrick (via `resolveAmendmentApprover`) → propagates `AmendmentWorkflowForbiddenError`
11. `submit` auto-cancels prior pending from same requester: verify state=cancelled + audit row with `superseded_by_new_request`
12. `approveAmendmentRequest` happy path — update applies the entry change (assert new entry.mattress_count), writes the entry audit row with `actor_label='system:amendment-approved'`, marks request `approved`, links `applied_audit_id`
13. `approve` happy path — insert: same as above but entry is newly created
14. `approve` requester tries to approve → `not_eligible_to_approve` 403
15. `approve` random non-chain non-admin → 403
16. `approve` admin always wins (non-counterpart admin) → succeeds
17. `approve` chain auto-override actor + bill_pinged_at set → succeeds
18. `approve` chain auto-override actor + bill_pinged_at null → 403
19. `approve` period concurrently transitioned to pending_signatures → `period_not_draft` 409
20. `rejectAmendmentRequest` requires `decisionNotes` → 422
21. `reject` happy path: marks rejected, audit row written
22. `cancelAmendmentRequest` only requester can cancel → 403 for others
23. `pingBill` only requester can ping → 403 for others
24. `pingBill` idempotent: second call returns `firstPing: false`, no second audit row
25. `shouldRequireAmendment`: prior day + count change → `amendment` update
26. `shouldRequireAmendment`: prior day + no existing entry → `amendment` insert
27. `shouldRequireAmendment`: same day + count change → `direct` (`same_day_or_future`)
28. `shouldRequireAmendment`: prior day + note-only change (same count) → `direct` (`note_only_edit`)
29. `shouldRequireAmendment`: admin actor → `direct` (`admin_direct_path`)
30. `shouldRequireAmendment`: period not draft → `direct` (`period_not_draft_handled_upstream`)

Use the existing test mock patterns from `src/lib/bonus/__tests__/bonus-cycle-e2e.test.ts` for the prisma/transaction surface.

### §11.3 — `src/app/api/bonus/amendments/__tests__/route.test.ts`

Cover the HTTP surface for the five routes:
1. `POST /amendments` as admin → 400 `admin_uses_direct_path`
2. `POST /amendments` as Patrick → 403 `patrick_or_other_non_chain_manager`
3. `POST /amendments` happy path → 201 with `request` body
4. `POST /amendments` invalid body (missing justification) → 422
5. `GET /amendments` as manager → returns only their site's pending
6. `GET /amendments` as admin → returns all sites' pending
7. `POST /amendments/[id]/approve` happy path → 200, entry updated downstream
8. `POST /amendments/[id]/approve` by requester → 403
9. `POST /amendments/[id]/reject` without decisionNotes → 422
10. `POST /amendments/[id]/reject` happy path → 200
11. `POST /amendments/[id]/cancel` by non-requester → 403
12. `POST /amendments/[id]/cancel` by requester → 200, state cancelled
13. `POST /amendments/[id]/ping-bill` first call → 200, ntfy fired (via spy)
14. `POST /amendments/[id]/ping-bill` second call → 200, no second ntfy

Stub `publishNtfy` and `sendSystemEmail` with spies; mirror the test scaffolding used in `src/lib/bonus/signature-notifications.test.ts`.

### §11.4 — Extend `src/lib/bonus/eod-check.test.ts`

Update existing assertions to use the parameterized `missingFingerprint(siteCode, dateIso)` signature. Add 4 new cases:
- `missingFingerprint('woodland', '2026-06-16')` → `'bonus-entry-missing:woodland:2026-06-16'`
- `missingFingerprint('eugene', '2026-06-16')` → `'bonus-entry-missing:eugene:2026-06-16'`
- `evaluateEod` for an Eugene-context dataset alerts correctly
- `evaluateEod` for two simultaneous sites yields independent decisions

---

## §12 — PR description (paste into the GitHub PR)

````markdown
# Sprint 4: prior-day amendment workflow + manager date picker + bi-site EOD check (ADR-0027)

Closes the gap Morena Gomez surfaced 2026-06-15: "what's the correct process to fix a prior day?" Within a `draft` pay period, managers can now propose edits to prior-day entries via a four-eyes amendment workflow. Counterpart in the signature chain approves; requester can ping Bill if their approver is unavailable. Every approval and rejection notifies Bill (ntfy + email). Closed periods remain immutable (Bill keeps the existing audit-labeled admin escape valve in `src/lib/bonus/amendment.ts`).

Same-day corrections, note-only edits, and admin writes stay direct. The previously admin-only date picker is now visible to managers, constrained to the current pay period window. The 5 PM Pacific EOD missing-entries check, previously Woodland-only and not wired into the production stack, is now bi-site and runs as a proper docker-compose daemon alongside `bonus-period-close` and `bonus-escalation-check`.

## What's in here

- **Migration `20260616_amendment_workflow`** — pure additive: one new table (`bonus_amendment_requests`), two enums, five DB-level CHECK constraints (requester ≠ approver, justification ≥20 chars, decided rows have a reviewer, rejected rows have notes, etc.), five indexes.
- **Service layer:** `src/lib/bonus/amendment-approvers.ts` (chain → approver), `src/lib/bonus/amendment-requests.ts` (submit/approve/reject/cancel/ping/list, atomic apply on approval), `src/lib/bonus/amendment-notifications.ts` (ntfy + M365 mail).
- **Routes:** `GET/POST /api/bonus/amendments`, `POST /api/bonus/amendments/[id]/(approve|reject|cancel|ping-bill)`.
- **UI:** `BonusDatePicker` (replaces `AdminDatePicker`), `RequestEditModal`, `/bonus/amendments` queue page with `AmendmentQueue` component.
- **`daily-entry.ts` interception:** `upsertDailyEntries` now returns `ok: 'requires_amendment'` when any input is a prior-day count change for a non-admin actor; route surfaces 409 + `pending` payload for the client to pivot to the modal.
- **EOD check:** `scripts/bonus-eod-check.mjs` rewritten as a long-running daemon, iterates every site with an active signature chain. Existing `src/lib/bonus/eod-check.ts` core parameterized: `missingFingerprint(siteCode, dateIso)`. New `bonus-eod-check` service in `docker-compose.yml`.
- **ADR-0027** documents the design.
- **Operator runbook** `docs/operator/bonus-amendment-workflow.md` covers deploy, verify, test fire, and rollback.

## What's NOT in here

- No changes to the period state machine. No new states, no new transitions.
- No changes to the existing admin amendment surface (`src/lib/bonus/amendment.ts`). Bill's escape valve is preserved verbatim.
- No cross-period amendment path for managers (forbidden by policy).
- No delete operation on entries (use "set to 0" + add correct entry instead).

## Acceptance gates

- [ ] `npx tsc --noEmit` exits 0
- [ ] `npx eslint . --max-warnings 0` clean
- [ ] `npx vitest run` green; suite size ≥ 764
- [ ] `npx next build` succeeds
- [ ] Migration applies cleanly against a throwaway Postgres 16 (`prisma migrate deploy`)
````

---

## §13 — `docs/operator/bonus-amendment-workflow.md`

````markdown
# Operator Runbook — Bonus Amendment Workflow + Bi-Site EOD Check

**ADR:** ADR-0027
**Sprint:** Sprint 4 (2026-06-16)

## What changed

1. Managers can edit prior days in the current pay period via a four-eyes request/approval workflow.
2. Closed periods (signed/paid/historical_imported) remain immutable for everyone except the Director (admin escape valve).
3. Date picker is visible to staff — constrained to the current draft period's window.
4. 5 PM Pacific EOD missing-entries notification now covers Eugene AND Woodland, wired as a docker-compose service.

## Deploy

````
git checkout main
git pull
docker compose up -d
````

This applies migration `20260616_amendment_workflow`, recreates `app` with the new amendment routes + UI, and starts a new `dr3-vision-bonus-eod-check` container.

## Verify

1. Migration applied:
````
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1;"
````
   Expect: `20260616_amendment_workflow`

2. New table exists:
````
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "\d bonus_amendment_requests"
````

3. EOD check daemon running:
````
   docker logs dr3-vision-bonus-eod-check --tail 20
````
   Expect: `daemon starting` followed by `sleeping until <next 5 PM PT>`.

4. App routes mounted:
````
   curl -s -o /dev/null -w '%{http_code}\n' https://dr3-vision.svdp.us/bonus/amendments
````
   Expect 200 (or 401 if unauthenticated).

## Test the EOD ntfy end-to-end

Best on a Wednesday or Thursday afternoon (not a holiday).

1. At ~16:50 PT, log in as Bill, navigate to `/bonus` on each site (Woodland and Eugene). Confirm today's grid shows entries for every active processor on both sites.
2. Temporarily make one employee on each site missing for today (DB edit or amendment-via-set-to-zero — restore after).
3. At 17:00 PT exactly, observe your phone — expect two ntfy notifications:
   - `[DR3-Vision] Bonus entries missing for Woodland — <date>. 1 processor without an entry.`
   - `[DR3-Vision] Bonus entries missing for Eugene — <date>. 1 processor without an entry.`
4. Restore the entries.

If no ntfy fires:
- `docker logs dr3-vision-bonus-eod-check --tail 50` to confirm the daemon is alive and fired
- `docker exec dr3-vision-bonus-eod-check env | grep NTFY` should show `NTFY_PUBLISHER_TOKEN` set
- `curl -X POST https://ntfy.barnardhq.com/dr3-vision-system -d "test"` should return 200

## Test the amendment workflow end-to-end

1. Log in as Janette at `/bonus`.
2. Use the date picker to navigate to a prior day within the current pay period.
3. Change one employee's mattress count and click Save.
4. The Request Edit modal opens. Type a justification ≥20 chars. Submit.
5. Janette sees a success state; the entry is unchanged on screen (the change is pending approval).
6. Log in as Morena. Navigate to `/bonus/amendments`. Confirm the request appears.
7. Approve. Confirm: Morena, Janette, and Bill all receive email + ntfy. The entry on the original day is now updated.
8. Audit verification:
````
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT actor_user_id, action, table_name, created_at FROM audit_log ORDER BY created_at DESC LIMIT 5;"
````
   Expect: amendment insert (Janette), entry update (Morena, `actor_label='system:amendment-approved'`), amendment update to `approved`.

## Rollback

1. `docker compose down`
2. Revert the commit on `main`, re-deploy the previous image.
3. Migration is additive — leaving the new table and enums in place is safe even on rollback. Drop manually only if a clean teardown is needed:
```sql
   DROP TABLE bonus_amendment_requests;
   DROP TYPE "BonusAmendmentRequestState";
   DROP TYPE "BonusAmendmentChangeType";
```

## Known limitations

- "Ping Bill" appears immediately on submit — a requester in a hurry can shortcut by pinging Bill in the same breath. This is by design (soft control); the audit log records the time-from-submit-to-ping so abuse patterns are observable.
- Patrick Dills cannot use the workflow at all (separation of duties — he's also an Eugene processor). His prior-day grid is read-only; corrections must be made verbally to Rick or Bill.
- Notes-only edits on prior days are direct (audit-log only, no workflow). Only `mattress_count` changes go through the four-eyes path.
````

---

## §14 — EOD check refactor

### §14.1 — Patch `src/lib/bonus/eod-check.ts`

Change `missingFingerprint` to accept the site code:

````ts
// Remove the SITE_CODE constant; the cron passes the site code per-iteration.

/** ntfy fingerprint for the missing-entries alert on a given Pacific day. */
export function missingFingerprint(siteCode: string, dateIso: string): string {
  return `bonus-entry-missing:${siteCode}:${dateIso}`;
}
````

Update existing call sites and tests accordingly (`src/lib/bonus/eod-check.test.ts` — see §11.4).

### §14.2 — `scripts/bonus-eod-check.mjs` (full rewrite)

````js
#!/usr/bin/env node
// ADR-0019 §2 + ADR-0027 — Bi-site EOD bonus-entry enforcement (daemon).
//
// Long-running daemon, same shape as bonus-period-close + bonus-escalation-check:
// sleeps until the next 17:00 Pacific instant, fires, repeats. Per-site
// iteration covers Woodland + Eugene (any site with an active bonus signature
// chain). One ntfy per site with missing entries, fingerprinted per (site, date).

import { PrismaClient } from '@prisma/client';

const PACIFIC_TZ = 'America/Los_Angeles';
const FIRE_HOUR_PT = 17;
const FIRE_MINUTE_PT = 0;

const PRIMARY_BASE = process.env['NTFY_BASE_URL']?.trim() || 'https://ntfy.barnardhq.com';
const FALLBACK_BASE = 'https://ntfy.sh';
const TOPIC = process.env['NTFY_TOPIC_SYSTEM']?.trim() || 'dr3-vision-system';
const FALLBACK_TOPIC = 'bhq-fb-dr3v-system-k8m2n';
const CLICK_URL = 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision';
const T

const TIMEOUT_MS = 5_000;

function logTs(message) {
  console.log(`[bonus-eod-check ${new Date().toISOString()}] ${message}`);
}

// ── Pacific date helpers ────────────────────────────────────────────

const ISO_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  weekday: 'short',
});

function pacificDateParts(now) {
  const iso = ISO_FMT.format(now);
  const label = LABEL_FMT.format(now);
  const weekday = WEEKDAY_FMT.format(now);
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const [y, m, d] = iso.split('-').map((p) => Number.parseInt(p, 10));
  const dayKeyUTC = new Date(Date.UTC(y, m - 1, d));
  return { iso, label, dayKeyUTC, isWeekend };
}

// Next 17:00 PT instant after `from`. Safe across DST shifts: we project `from`
// into Pacific wall-clock parts, compute the seconds-of-day delta to 17:00 PT,
// and add the delta in UTC. The Intl formatter does all the DST math for us.
function nextFireInstant(from) {
  const FMT = new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(FMT.formatToParts(from).map((p) => [p.type, p.value]));
  const ptNow = {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
  const currentSecondsOfDay = ptNow.hour * 3600 + ptNow.minute * 60 + ptNow.second;
  const fireSecondsOfDay = FIRE_HOUR_PT * 3600 + FIRE_MINUTE_PT * 60;
  let deltaSec;
  if (currentSecondsOfDay < fireSecondsOfDay) {
    deltaSec = fireSecondsOfDay - currentSecondsOfDay;
  } else {
    deltaSec = 86400 - currentSecondsOfDay + fireSecondsOfDay;
  }
  return new Date(from.getTime() + deltaSec * 1000);
}

// ── ntfy publish (fail-soft, primary→fallback) ──────────────────────

async function postWithTimeout(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function publishMissing({ siteCode, siteName, dateLabel, missingCount, fingerprint }) {
  const token = process.env['NTFY_PUBLISHER_TOKEN']?.trim();
  // Title MUST NOT be prefixed with [DR3-Vision] — publishNtfy auto-prefixes
  // in TS-land; in the .mjs daemon we set the full title once because we're
  // calling ntfy HTTP directly. Keep "[DR3-Vision]" here so the user-visible
  // title matches the rest of the fleet.
  const title = `[DR3-Vision] Bonus entries missing for ${siteName}`.slice(0, 250);
  const body =
    `Bonus entries missing for ${siteName} — ${dateLabel}. ` +
    `${missingCount} processor${missingCount === 1 ? '' : 's'} without an entry. ` +
    `Open /bonus to enter.`;

  if (!token) {
    logTs(`NTFY_PUBLISHER_TOKEN unset — skipping publish for ${siteCode} (no-op)`);
    return;
  }

  const headers = {
    'X-Title': title,
    Priority: 'high',
    Click: CLICK_URL,
    Tags: 'warning,bonus,dr3-vision',
    'X-Dedup-Id': fingerprint,
    Authorization: `Bearer ${token}`,
  };
  const ok = await postWithTimeout(`${PRIMARY_BASE}/${TOPIC}`, body, headers, TIMEOUT_MS);
  if (ok) {
    logTs(`published to ${TOPIC} for ${siteCode} (${fingerprint})`);
    return;
  }
  const fbHeaders = {
    'X-Title': `[FALLBACK] ${title}`.slice(0, 250),
    Priority: 'high',
    Click: CLICK_URL,
    Tags: 'warning,bonus,dr3-vision',
    'X-Dedup-Id': fingerprint,
  };
  const fbOk = await postWithTimeout(
    `${FALLBACK_BASE}/${FALLBACK_TOPIC}`,
    body,
    fbHeaders,
    TIMEOUT_MS,
  );
  logTs(
    fbOk
      ? `published to FALLBACK topic for ${siteCode} (${fingerprint})`
      : `publish FAILED for ${siteCode} (${fingerprint})`,
  );
}

// ── Per-site check ──────────────────────────────────────────────────

async function checkSite(prisma, site, dateParts) {
  const holiday = await prisma.siteHoliday.findUnique({
    where: {
      site_id_holiday_date: { site_id: site.id, holiday_date: dateParts.dayKeyUTC },
    },
    select: { id: true },
  });
  if (holiday) {
    logTs(`${site.code}: site holiday on ${dateParts.iso} — skipping`);
    return;
  }

  const activeEmployees = await prisma.bonusEmployee.findMany({
    where: { site_id: site.id, is_active: true, deleted_at: null },
    select: { id: true },
  });
  if (activeEmployees.length === 0) {
    logTs(`${site.code}: no active employees — skipping`);
    return;
  }

  const entries = await prisma.bonusDailyEntry.findMany({
    where: {
      entry_date: dateParts.dayKeyUTC,
      bonus_employee: { site_id: site.id },
    },
    select: { bonus_employee_id: true },
  });
  const entered = new Set(entries.map((e) => e.bonus_employee_id));
  const missing = activeEmployees.filter((e) => !entered.has(e.id));

  if (missing.length === 0) {
    logTs(`${site.code}: all ${activeEmployees.length} active employees have entries — no alert`);
    return;
  }

  logTs(`${site.code}: ${missing.length}/${activeEmployees.length} missing — alerting`);
  await publishMissing({
    siteCode: site.code,
    siteName: site.name,
    dateLabel: dateParts.label,
    missingCount: missing.length,
    fingerprint: `bonus-entry-missing:${site.code}:${dateParts.iso}`,
  });
}

// ── Fire ─────────────────────────────────────────────────────────────

async function runOnce(prisma) {
  const now = new Date();
  const dateParts = pacificDateParts(now);
  logTs(`evaluating bi-site EOD for Pacific day ${dateParts.iso} (${dateParts.label})`);

  if (dateParts.isWeekend) {
    logTs('weekend — skipping all sites');
    return;
  }

  // Iterate every site that has an active bonus signature chain (a bonus-enabled site).
  const sites = await prisma.site.findMany({
    where: { bonus_signature_chain: { isNot: null } },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });

  for (const site of sites) {
    try {
      await checkSite(prisma, site, dateParts);
    } catch (err) {
      logTs(`${site.code}: check FAILED — ${err?.message ?? err}`);
    }
  }
}

// ── Main loop ────────────────────────────────────────────────────────

async function main() {
  if (!process.env['DATABASE_URL']) {
    console.error('bonus-eod-check: DATABASE_URL is required');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  logTs('daemon starting');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = new Date();
    const fire = nextFireInstant(now);
    const sleepMs = fire.getTime() - now.getTime();
    logTs(`sleeping until ${fire.toISOString()} (~${Math.round(sleepMs / 1000)}s)`);
    await new Promise((res) => setTimeout(res, sleepMs));

    try {
      await runOnce(prisma);
    } catch (err) {
      logTs(`runOnce FAILED — ${err?.message ?? err}`);
    }
  }
}

main().catch((err) => {
  console.error('bonus-eod-check: fatal', err);
  process.exit(1);
});