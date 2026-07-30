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

---

## Amendment 2 — 2026-07-30 — placement corrected, and three of the four deferred items completed

### A. The tile was in the wrong place. **[M]**

Operator directive, verbatim: _"the reimbursement tile is NOT a ipad surface it is
a manager surface in the primary dashboard."_

**[M]** Measured 2026-07-30 with a minted session for `bill.barnard@svdp.us`:
`/dashboard` → tile ABSENT; `/dashboard/woodland` and `/dashboard/eugene` → tile
PRESENT. **[M]** His account is `role='admin'` with `primary_site_id = NULL` and
`all_sites = false`, so he lands on the picker at `/dashboard` and never on a
per-site page by default. A plain manager lands on their own site and saw it
immediately — which is exactly why this passed testing and still failed the person
who asked for it.

**[I]** No iPad/operator gate was ever involved: the rollout row is
`kind='ui', surface_code='reimbursement_tile'`, and nothing under
`src/lib/reimbursements/**` or the reimbursement pages references any `ipad_*`
surface. The directive is about placement, and the placement was wrong.

**Fixed:** the primary dashboard now carries one entry **per reachable site**
(the form is site-scoped and the site is auto-filled, so a single org-wide link
would have to guess), each with a live pending count. `N waiting for your
signature` — counted from `routed_to_user_id`, the value the shared resolver
actually wrote — is the number that changes behaviour, so it gets the alerting
colour; a bare label would not. The per-site nav entry is kept: a manager already
on their site page should not have to go back out.

### B. Item 3 — the 06:00 digest fold-in. **SHIPPED.**

A **separate section**, not merged into `pendingSecondApproval`: a reimbursement
has no vendor and no `received_at`, is aged from `submitted_at`, and needs two
signatures at **every** amount where an invoice only does at ≥ $1,000. Merging
them would imply a threshold that does not apply and a vendor that does not exist.

An aged reimbursement raises the whole digest to high priority on the same 3-day
bar as an invoice, with a warning that names the consequence — _"Somebody is owed
money."_ A pending reimbursement **alone** is enough to send the digest; without
that, the one case that matters (empty invoice queue, unsigned reimbursement)
would be suppressed as "nothing to report". Rows deep-link to the reimbursement
surface via a new `reimbursementUrl()`, **not** `apQueueUrl()` — the AP queue does
not contain the row the line is about.

### C. Item 4 — the plain 24-hour weekday timeout escalation. **SHIPPED.**

`src/lib/reimbursements/escalation.ts`, riding the **existing** hourly
`/api/internal/ap/escalation-scan` tick rather than a second cron service: both
scans answer "has a signature been owed too long?" on the same weekday clock, and
a second scheduler is a second thing to notice has stopped.

**[D]** `escalated_at IS NULL` is both the candidate filter and the claim
condition, so a row escalated IMMEDIATELY at submit time (beneficiary conflict,
ambiguous name, no routing row) is **never a candidate** and can never be
re-escalated or double-paged. Asserted directly rather than trusted.

Widening never relaxes the control — the submitter and beneficiary stay excluded
after the fallback is added, and the audit row records `submitter_excluded` so an
auditor reads it rather than re-deriving it. When nobody reachable is left even
after widening, `escalated_at` is deliberately left NULL and the problem is
reported: stamping it would mark an unpayable row "handled" forever.

A reimbursement-scan failure returns non-200 so the daemon logs it, but the AP
result already earned is still in the body — half-ran-and-looked-fine is the shape
this ADR series exists to remove.

### D. Item 1 — the stamped decision PDF. **SHIPPED, and NOT via `ap/stamp.ts`.**

**[D]** `stampText()` in `src/lib/ap/stamp.ts` renders the FIRST party as
`Approved by <name>` and the second as an appended clause. On a reimbursement the
first party is the **submitter**, so reusing it would print **"Approved by
Janette"** on the document Mary files — the precise manufactured audit evidence
this ADR exists to delete, printed on the artefact an auditor reads. Amendment 5's
dual-approval shape looks superficially correct here and is semantically inverted.

So `src/lib/reimbursements/pdf.ts` is separate, but reuses `PdfRenderer`,
`defaultPlaywrightRenderer` and `sha256Hex` from `ap/stamp` and keeps the same
visual family. It carries both signatures with Pacific timestamps, the
beneficiary, amount, expense date, category, purpose, site, decision and note.

**The audit statement is VERIFIED before it is printed.** `assertDualSignature`
refuses to render when the row cannot evidence the claim — status ≠ approved,
missing second approver or instant, `second_approver_id === submitted_by`, or
`second_approver_id === employee_user_id`. And where the check is impossible it
says so instead of overclaiming: for a **free-text** beneficiary there is no id to
compare, so the document states the exclusion was enforced at submission by name
matching (ambiguity escalates) and **cannot** be re-checked by account id.

`decision_pdf_sha256` is recorded when a PDF was really attached, so "is the
document in Mary's mailbox the one Vision produced?" stays answerable.
`decision_pdf_key` stays NULL: `putApDecisionPdf` keys objects under `ap/…` with
an attachment id, and filing reimbursements there would give the object a key that
lies. A reimbursement-namespaced R2 helper is the small follow-up.

### E. Item 2 — the AP-queue type badge. **REJECTED on privacy grounds, not deferred.**

ADR-0068 §D7 wanted reimbursements interleaved into the AP queue. **That should
not be built as specified.**

**[M]** `listApRequests` has no site filter and `ApQueuePage` gates on AP-roster
membership, not site reach. **[M]** The seeded roster contains Rick Albritton
(Eugene, `all_sites=false`) and Janette/Morena (Woodland, `all_sites=false`).
So interleaving puts a named Woodland employee, the amount they are personally
owed, and a free-text `purpose` — which can carry medical, financial-hardship or
household detail — in front of a Eugene-only manager.

The decisive point is that the two visibility models point in **opposite
directions**. The AP queue is org-wide _because_ it is first-action-wins: every
viewer can act, so seeing everything is the feature. A reimbursement can be acted
on by **exactly one** person — `canApproveReimbursement` hard-stops the submitter
and the beneficiary and, for a non-admin without `all_sites`, requires
`primary_site_id === request.site_id`. Rick could never act on a Woodland
reimbursement. Interleaving therefore grants four people read access to personal
financial data so that one person can act: **pure exposure, zero operational
gain.**

**Recorded as REJECTED so it does not look merely unfinished.** If Bill wants
queue visibility, the buildable form is a **count only**, scoped to what the
viewer can actually open — beneficiary, amount and purpose never inline, and
clicking through lands on a surface that re-enforces `checkManagerForSite`. An
unscoped count would say 3 where the page shows 1, which is its own species of
misleading UI.

**This needs Bill's decision, and the honest question is:** does he accept that
AP-roster approvers at either site can read what a named employee at the _other_
site is being reimbursed for, and why? Until he says yes, it is not built.

### F. Known test-isolation flake, recorded rather than left to be rediscovered

**[M]** `src/lib/ap/stamp-render-gate.test.ts` passes in isolation (twice,
confirmed) and can fail with `expected 1 to be 2` when run alongside the new
`pdf.test.ts`. Both exercise the module-level Chromium semaphore in `ap/stamp.ts`,
so parallel vitest files contend for it. **[I]** A test-isolation issue, not a
product defect — the gate is doing its job; the assertion counts slots across
files that share module state. Not fixed here; recorded so the next person does
not diagnose it as a rendering bug.
