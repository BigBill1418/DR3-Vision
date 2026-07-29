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

16 unit tests cover both exclusions, the immediate beneficiary escalation, the
ambiguous-name fail-safe, the common case NOT over-escalating, site reach, and the
ADR-0066 invariant (authorized-by-someone is never notifiable-by-nobody) swept
across every submitter.

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
