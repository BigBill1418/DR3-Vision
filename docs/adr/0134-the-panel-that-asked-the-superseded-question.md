# ADR-0134 — The panel that asked the superseded question

- **Status:** Accepted, implemented 2026-09-18 (Pacific)
- **Context:** Bill relayed that Morena Gomez, Janette Tomas, Rick Albritton and
  Shannon Rockwell could not act as second signer on AP invoices >= $1,000,
  "even though the routing configuration says they should be able to."
- **Extends:** ADR-0066 §1.4 (the shared second-approval resolver), ADR-0046
  Amendment 5 (D-M5-3, the $1,000 dual-approval workflow), ADR-0129 §D2 (the
  warning that named the wrong population).

## Context

**Every configuration artifact was correct.** `ap_approval_routing` held seven
active rows pairing the right people (Morena↔Janette, Rick↔Shannon, and the
rest), all pointing at the right _manager_ user ids — not the operator PIN
duplicates that ADR-0066 §1.4 warns about. The ADR-0046 `ap_approvers` roster
held five unexpired rows. Every user was `is_active`, correctly roled, and sat
at the right `primary_site_id`. Nothing had expired; the "Kelsey pattern" of
ADR-0129 had not recurred.

**The production record said otherwise.** Of every second approval ever
fulfilled — 38 of them, 2026-07-27 through 2026-09-18 — **Bill fulfilled all 38.** Not one was signed by a routed peer. Shannon, the only name in the
superseded roster, never signed one either, because the >= $1,000 traffic is
overwhelmingly Woodland.

**ADR-0066 migrated two call sites and left two behind.** It replaced the
per-site `ap_second_approvers` model with person→person `ap_approval_routing`,
and its entire premise was that one function must answer both halves of the
question so they cannot drift apart. It converted the _write_ leg
(`decideSecondApproval`) and the _notify_ leg. It did not convert the two
**read** paths that decide what the operator is shown:

| Path                                               | Asked                                                                    | Answer for a routed peer |
| -------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------ |
| `GET /api/ops/ap/[id]` → `secondApproval.eligible` | `canFulfillSecondApproval(…, siteCode)` — the superseded per-site roster | `false`                  |
| `awaitingSecondApprovalCount` → the AP tile badge  | the same superseded roster                                               | `0`                      |

`ap_second_approvers` was left holding exactly one row — Shannon, `eugene`. So
for every peer ADR-0066 had just made eligible, both read paths answered _no_.

**The failure mode was an absent button, not an error.** `ApQueueClient`
renders the whole Approve/Reject panel behind `{sa?.eligible ? …}`. When the
flag is false the panel is simply not there: no 403, no toast, no log line,
nothing to grep. And the badge said `0`, so the four managers were never told
an invoice was waiting on them in the first place. Meanwhile the server-side
write was already correct — `decideSecondApproval` would have _accepted_
Janette's signature the whole time. The UI refused to offer a decision the
server would have taken.

That asymmetry is what made it read as a configuration problem: every artifact
an operator can inspect was right, and had been right since ADR-0129 closed the
routing-coverage gap on 2026-08-27. The disagreement was between two functions,
in code, where nobody was looking.

**The control was not being provided.** For 52 days the "second" signature on
every >= $1,000 invoice was Bill's. The $1,000 threshold exists to put a second
pair of eyes on the payment; what it actually produced was Bill approving
behind four people who could not. That is the finding, not a side effect.

## Decisions

**D1 — The panel's eligibility flag is answered by the function that authorizes
the write.** `GET /api/ops/ap/[id]` now calls
`canFulfillSecondApprovalByRouting` with exactly the arguments
`decideSecondApproval` passes — `firstApproverId`, `escalated`, and
`requestSiteId` — plus the same NOT-DR3/siteless guard. The panel can no longer
show less than the server will accept, because both ask one function. Hard
rule #2 is unchanged and still enforced inside the resolver: cross-site reach
needs `admin` or `all_sites`, so Shannon still cannot sign a Woodland invoice.

**D2 — The badge counts what the actor can actually fulfill.**
`awaitingSecondApprovalCount` resolves each `pending_second_approval` row
through that same function rather than through a parallel query. Per-row
resolution is deliberate: it makes the badge correct _by construction_ instead
of by a second query that can drift out of agreement again — which is the
entire failure this ADR records. The candidate set is the live backlog (single
digits), so the cost is not a concern.

**D3 — The superseded checker is fenced, not deleted.**
`canFulfillSecondApproval` keeps its tests (they pin the legacy behaviour and
prove nothing reads it in anger) but carries `@deprecated` and a comment naming
this incident. Deleting it outright was the larger change and this was an
active production block; fencing it now, dropping it later.

## Consequences

- Morena, Janette, Rick and Shannon can act as second signer on the invoices
  routed to them. Dual approval becomes real segregation of duties rather than
  Bill signing behind every first approver.
- `ap_second_approvers` now has **no live reader**. The table and its one row
  stay in place pending an explicit decision to drop them (`docs/OPEN-ITEMS.md`
  § 0.BW BW-2). Nothing should read it again.
- Two anti-regression tests pin the failure, and both were confirmed to FAIL
  against the pre-fix code rather than merely passing after it:
  `src/app/api/ops/ap/[id]/route.test.ts` (`expected false to be true`) and the
  routed-peer case in `src/lib/ap/second-approval.test.ts` (`expected +0 to be
1`). The first also re-exports the superseded checker into its module mock on
  purpose, so the counterfactual exercises the real legacy path instead of
  failing on a missing export.
- **Observed, not changed:** because `resolveSecondApproval` authorises admins
  plus the routed peer, a non-admin first approver is not in their own
  authorized set — so the self-fulfilment path in `decideSecondApproval` (the
  re-confirm checkbox and the 30-second wait, D-M5-3 decision (c)) is reachable
  only by an admin. That is a consequence of ADR-0066's person→person model,
  not of this fix, and tightening or loosening it is a policy call for Bill.
  Recorded as `docs/OPEN-ITEMS.md` § 0.BW BW-3.
