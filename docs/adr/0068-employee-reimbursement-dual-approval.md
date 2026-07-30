# ADR-0068 — Employee reimbursements: structured intake + mandatory dual approval

- **Status:** accepted, shipped 2026-07-29
- **Supersedes:** nothing. Extends ADR-0046 (AP approvals) and ADR-0066 (peer routing).
- **Depends on:** ADR-0066 `ap_approval_routing` + the shared second-approval resolver.

## Context — a control that was manufacturing audit evidence

Mary Scott (SVdP accounting) escalated this, and she was right:

> _"I am receiving requests for payment from Janette and then when I put them thru
> the approval process they are returned as approved by Janette. Is this correct.
> If so, why am I wasting my time sending these requests thru if she is approving
> her own requests. This does not make sense to me."_

The path was: employee incurs an expense → Janette or Morena completes and scans
the paper reimbursement form → emails it to Mary → Mary forwards it into the
Vision AP mailbox → it lands in the shared AP queue → **Janette approves her own
submission** → Mary receives it back "approved by Janette."

**Vision had no concept of who ORIGINATED a request.** It knew who forwarded it
(Mary) and who approved it (Janette). Janette's role as originator existed only
as ink inside a scanned PDF — invisible to the system. First-action-wins then did
exactly what it was designed to do.

Two things made this worse than a missing control:

- **The approval stamp implied independent review that never happened.** That is
  worse than no control at all: it manufactures audit evidence for a check that
  did not occur.
- **Mary was performing a control step that returned her nothing** — relaying a
  document that came back approved by the person who sent it to her.

**Why reimbursements collided with vendor invoices:** a vendor invoice is an
arm's-length transaction with an external counterparty, and the invoice itself is
independent evidence. A reimbursement pays an **insider** against a form an
insider wrote. The AP queue was built for the former, where "originator" is
meaningless because vendors are not in the org chart.

**ADR-0066's peer routing does not fix this.** It fires only at ≥ $1,000,
reimbursements rarely reach that, and even when they do it swaps the _second_
approver — the _first_ could still be the originator.

## Decision

### D1 — Structured intake, not email. The paper form is retired.

Managers get an **Employee Reimbursement** tile; clicking it opens a form.

This is the change that makes everything else possible: **the submitter is
authenticated, so Vision knows who originated the request as a fact, not an
inference.** No PDF parsing, no tagging, no heuristics. "The submitter cannot
approve" becomes a constraint instead of a detection problem.

Secondary benefits: the amount is entered rather than OCR-guessed; reimbursement
spend becomes queryable data instead of a pile of scans; Mary stops being a relay.

### D2 — Two signatures on every reimbursement, no dollar threshold

Submission is signature one. A peer's approval is signature two. Always.

Deliberately **stricter than vendor invoices**, where only ≥ $1,000 needs a
second signature. A $40 reimbursement needs two signatures where a $900 vendor
invoice needs one. Justification: reimbursements pay insiders with no external
counterparty and no independent documentary evidence beyond a receipt the
claimant supplied.

### D3 — The exclusion rule is approver ≠ submitter **AND** approver ≠ beneficiary

Bill's stated rule ("the second cannot be the initiator") covers the submitter.
**It does not cover the beneficiary**, and that gap reproduces Mary's complaint in
mirror image: if Morena submits a reimbursement _for Janette_, person routing
sends it to Janette — the person being paid.

```
eligible second approver =
      the ap_approval_routing peer for the submitter
  AND is not the submitter
  AND is not the person being reimbursed
```

**When the routed peer is the beneficiary, escalation to an admin is IMMEDIATE**,
not after 24 hours. There is no valid local approver, so waiting accomplishes
nothing. At Woodland this means one manager submitting for the other goes to Bill
— the correct outcome, since a manager's own reimbursement warrants his eyes
regardless. The common case (either manager submitting for a floor employee) is a
plain peer swap.

**Free-text beneficiary names FAIL SAFE.** Exact or first+last agreement is a
match; a lone token that collides with an approver's name is **ambiguous** and
escalates rather than guessing. The asymmetry is deliberate: a needless escalation
costs one glance, a missed exclusion pays someone against their own signature.

### D4 — Three enforcement layers, because one was already proven insufficient

1. **A database CHECK** — `second_approver_id <> submitted_by`.
2. **The server-side resolver** — before any write, on every transition.
3. **The UI** — which does not offer the buttons, and says why.

This is not belt-and-braces theatre. Mary caught this exact control failing in
production _while every surface reported success_. The point is that no single
layer has to be trusted. The CHECK in particular cannot be refactored away,
cannot be bypassed by a hand-crafted request, and does not depend on any
application file being correct.

Note there is **no `role === 'admin'` short-circuit**, unlike the AP path: an
admin who submitted the request, or who is the beneficiary, is still refused. The
exclusions are about the **person**, not the privilege.

### D5 — One routing table, one resolver

Reimbursement routing is a **thin wrapper** over ADR-0066's
`resolveSecondApproval`, adding exactly the two exclusions above. Forking a second
resolver would recreate the ADR-0066 outage shape with a third answer — that
outage happened _because_ two code paths answered "who may sign / who do we tell"
differently, and the notify path is fail-soft over an empty recipient set, so
≥ $1,000 invoices sat unapproved and invisible for days.

### D6 — Output goes to Mary, always. Never back to the submitter.

Vendor invoices route the decision back to the SVdP forwarder with Mary CC'd,
because a forwarder exists. Reimbursements have **no forwarder** — the manager
submits directly.

- **Approved → Mary as sole primary recipient.** She pays them. **Not** the
  submitter: they already know they submitted it.
- **Rejected / held → the submitting manager**, with the note. They are the one
  who must act. Mary is not told; nothing is owed.
- The record carries **both** signatures with Pacific timestamps.

### D7 — The approval panel is reimbursement-specific

ADR-0046 Amendment 5's structured Approve panel (vendor freeform / explanation /
confirmed amount / equipment multi-select) is a **vendor-invoice** construct and
does not apply — that data is captured at submission. Also not applicable: vendor
baseline variance detection, equipment linking, and amount auto-extraction.

Reject and hold require a note; approve does not, because the substantive data was
captured at submission.

## Verification — the control was exercised, not assumed

The full migration chain was replayed on an **empty PG16**, then hostile INSERTs
were driven at the result:

| Attempt                               | Outcome                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| Janette submits, **Janette approves** | **REFUSED** — `reimbursement_second_approver_not_submitter` |
| Both beneficiary identities set       | REFUSED — `reimbursement_exactly_one_beneficiary`           |
| Neither beneficiary identity set      | REFUSED — same constraint                                   |
| `rejected` with no note               | REFUSED — `reimbursement_refusal_has_note`                  |
| Zero amount                           | REFUSED — `reimbursement_amount_positive`                   |
| **Janette submits, Morena approves**  | **ACCEPTED**                                                |

Survivor row: `submitted_by=u_jt approved_by=u_mg`. A constraint that rejects
everything would be useless, so the legitimate case was proven too.

24 unit tests cover both exclusions, the immediate beneficiary escalation, the
ambiguous-name fail-safe, the common case NOT over-escalating, site reach, and the
ADR-0066 invariant (authorized-by-someone is never notifiable-by-nobody) swept
across every submitter — 16 in `routing.test.ts` (the exclusion logic) plus 8 in
`service.test.ts` (that the decision path CONSULTS it). See Amendment 1 §C: this
line originally read "16 unit tests", which counted only the first file, and
`notify.ts` had none at all until Amendment 1 §D.

## Consequences

- Mary stops forwarding reimbursements entirely and receives them already
  approved by two people, neither of whom submitted them.
- Reimbursement spend becomes queryable per site and period.
- A reimbursement whose only eligible approver is excluded **cannot be submitted**
  — refused at intake rather than stored as a row that can never be approved and
  sits looking in-progress.
- If R2 is unavailable, submission is refused rather than stored without its
  required receipt. A row that looks complete but is not is worse than a clear
  failure.

## Not in this ADR — tracked, not silently dropped

The following were specified and are **deliberately deferred**, so they are
recorded here rather than discovered later:

1. **The stamped decision PDF.** The decision email carries both signatures, all
   submitted fields, and Pacific timestamps, and the receipt is retrievable in
   Vision — but the AP-format stamped PDF attachment is not yet generated. Mary
   gets everything she needs to pay; the artefact shape differs from AP.
2. **The 24-hour weekday fallback for the timeout case.** The IMMEDIATE
   beneficiary-conflict escalation (the control-critical one) ships and is
   enforced. The plain timeout escalation reusing the ADR-0066 scanner does not.
3. **Fold-in to Bill's 06:00 digest.**
4. **The AP-queue type badge.** Reimbursements live on their own site surface
   rather than being interleaved into the AP queue.

None of the four weakens the control. All four are queue-visibility and
document-format work.

---

## Amendment 1 — 2026-07-30 — rollout state ratified LIVE, and four documentation defects corrected

This amendment exists because the ADR as written **contradicted production**, and
because three factual claims made in the shipping commits were wrong. None of it
changes the control; all of it changes what the record says about the control.

### A. Both surfaces are `live` at BOTH sites. This is INTENDED and is now ratified.

The body of this ADR, and the seed comments in
`prisma/migrations/20260817_adr0068_employee_reimbursements/migration.sql`
(§"Notification surface (ADR-0047), **born pilot**" and §"The Employee
Reimbursement tile itself. **Born `pilot`**"), describe a staged ramp: pilot
first, Woodland before Eugene. **Production is not in that state and is not
going to be.** Ground truth, read from the production database
(`dr3_vision` on CHAD-HQ) on 2026-07-30 at 03:13 UTC = 2026-07-29 20:13 PDT:

| surface                | site     | rollout_state | flipped_by | flipped_at |
| ---------------------- | -------- | ------------- | ---------- | ---------- |
| `reimbursement_notify` | eugene   | **live**      | _(null)_   | _(null)_   |
| `reimbursement_notify` | woodland | **live**      | _(null)_   | _(null)_   |
| `reimbursement_tile`   | eugene   | **live**      | _(null)_   | _(null)_   |
| `reimbursement_tile`   | woodland | **live**      | _(null)_   | _(null)_   |

All four rows: `created_at` 2026-07-29 21:29:55 UTC (14:29:55 PDT — the moment
`migrate deploy` applied the migration), `updated_at` 2026-07-29 21:40:49 UTC
(14:40:49 PDT — eleven minutes later, when they were flipped).

**Operator-ratified 2026-07-30: reimbursements are LIVE at both sites, and
`mary.scott@svdp.us` is the correct accounting recipient.** Neither is to be
reverted. The "born pilot" language describes the migration's SEED VALUE, which
is still `pilot` and still correct as a seed; it does not describe the running
system. Read it as history, not as current state.

### B. The flip bypassed the audited `/admin/rollout` path — there is no flip record

`flipped_by`, `flipped_at` and `criteria_note` are **all NULL** on all four rows.
`/admin/rollout` sets those fields; therefore the transition to `live` did not go
through it. The consequence is narrow but real: **the rollout table cannot say who
ramped reimbursements, when, or against what criteria.** The directive's
"record the criteria at the flip" rule produced no evidence here.

The state itself is ratified (§A) — this is not a request to change it. But the
same pattern is present on other surfaces, so it is not a one-off: `ipad_queue`
and `ipad_inbound` are also `live` with a NULL `flipped_by` (2 rows each).
`bonus_signature_chain` and `survey_sends` are also NULL-`flipped_by`, but those
are the deliberately grandfathered surfaces seeded `live`, so they are expected.

Tracked as follow-up, not fixed here: either backfill `flipped_by`/`criteria_note`
for the ratified flips, or make out-of-band flips impossible so the audit field
cannot be empty. Deciding that is an operator call.

### C. The migration comment could NOT be corrected in place — it is checksum-locked

The obvious fix — edit the "born pilot" comment in the migration — **would break
production deploys and CI**, so it was deliberately not done.

`prisma/migrations/.../migration.sql` is an APPLIED migration. Its checksum is
recorded in `_prisma_migrations` (`68374a197bf6153c…`, `finished_at`
2026-07-29 21:29:55 UTC / 14:29:55 PDT). Prisma's schema engine compares that
checksum on every run; the binary carries the failure string verbatim:

> `` `<migration>` was modified after it was applied. ``

Editing the file would therefore fail (a) the one-shot `prisma migrate deploy`
init container in `docker-compose.yml` on the next production deploy, and (b) the
`prisma migrate deploy` + `prisma migrate status` **hard CI gate** in
`.github/workflows/ci.yml`. An applied migration is immutable in practice, comments
included. **This ADR is the correction of record for that comment.**

### D. `notify.ts` had ZERO test coverage. It now has 20 tests.

269 lines, fail-soft over an empty recipient set, on the money path — and
untested, which made it the highest-risk file in the feature. This repo has
already been bitten by exactly this shape: `resolveSlotSigner` had tests that
mocked the database into AGREEING with a production-wrong query, and ops signers
were never emailed while every surface reported success.

`src/lib/reimbursements/__tests__/notify.test.ts` is therefore built to avoid that
failure mode: the **real** `resolveReimbursementApproval` runs over a fake Prisma,
and only `notifyStaff` (the email transport) is mocked, echoing its arguments back
so assertions are made against what the code really asked to send. D6 is asserted
in both directions and negatively as well as positively:

- approved → Mary is the **sole** primary recipient, and the submitter is **not**
  in the audience (not as a recipient, not as a cc);
- rejected / held → the **submitting manager**, and Mary is **never** told;
- submission → **only** the routed second approver — never the submitter, never Mary;
- the empty-recipient path is **LOUD**: it returns `not_sent`, names the amount and
  the beneficiary, states "nobody has been asked to sign it", and does not quietly
  email anyone.

The suite was mutation-tested rather than trusted for being green. Three
deliberate defects were injected and each was caught: leaking the approved mail to
the submitter (2 failures), removing the beneficiary exclusion from `routing.ts`
(2 failures — proving the real resolver is genuinely in the loop), and silencing
the empty-audience report (1 failure).

Reimbursement suite total: **44 tests** (16 routing + 8 service + 20 notify).

### E. A fail-soft audit field was recording deliveries that never happened

Found while writing §D. `notifyReimbursementDecided` stamped
`sent_to_accounting_at = now()` **unconditionally** after the approved-path send —
including when the resolved audience was empty, and when the mail transport was
disabled (M365 unconfigured, which `notifyStaff` reports as `disabled: true` and
fails open as a no-op). Either way the row read as "handed off to accounting" when
nothing had been sent: the precise fail-soft-looks-like-success shape §D exists to
refuse, on the field an auditor would trust.

Fixed: the stamp is now written only when `intendedRecipients` is non-empty AND
the transport is not disabled, and both failure cases push an explicit `problems`
line naming the consequence ("Mary has NOT been told to pay it"). The disabled
transport is now reported on the rejected/held path too. `sent_to_accounting_at`
has no readers anywhere in the codebase (verified with two independent searches),
so nothing depended on the old unconditional write.

### F. Two wrong counts in the shipping record, and a dangling decision numbering

1. **"FIVE CHECK constraints"** — commit `decad39`'s message says the migration
   adds five. **There are four:** `reimbursement_second_approver_not_submitter`,
   `reimbursement_exactly_one_beneficiary`, `reimbursement_amount_positive`, and
   `reimbursement_refusal_has_note`. The commit message cannot be edited without
   rewriting pushed history, so this is the correction of record. The Verification
   table in this ADR is unaffected — it lists four constraint names and was right.

2. **"16 unit tests"** — corrected in the Verification section above to 24.

3. **Dangling `D8` / `D10` references.** `notify.ts` cited "ADR-0068 D8/D10" and
   `routing.ts` cited "D5/D6" and "D4", but **this ADR only ever had D1–D7** — an
   earlier, longer numbering — the pre-ADR handoff's — leaked into the code
   comments and pointed at decisions no COMMITTED document defines. Searched for
   and not found: no file in this repo, and no file in the sibling DR3 working
   directories or `~/Docs`/`~/docs`/`~/lists`, contains a reimbursement `D8` or
   `D10` (verified with two independent search methods). The handoff itself was
   never committed, so those citations were unresolvable for any future reader —
   which is the whole defect, independent of what the handoff once said. The
   comments have
   been renumbered onto the real decisions: Mary-as-sole-primary and
   never-a-broadcast are **D6**; the beneficiary exclusion is **D3**;
   submission-is-the-first-signature is **D2**; the thin-wrapper rule is **D5**;
   the enforcement layers are **D4**.
