# 2026-07-28 — Employee reimbursement requests: structured intake + mandatory dual approval (segregation of duties fix)

**Session context (Bill × Claude, 2026-07-28):**

Mary Scott (SVdP accounting) escalated a control failure she encountered in live use:

> *"I am receiving requests for payment from Janette and then when I put them thru the approval process they are returned as approved by Janette. Is this correct. If so, why am I wasting my time sending these requests thru if she is approving her own requests. This does not make sense to me."*

**She is right.** This handoff fixes it.

**Bill's description of the current process, verbatim:**

> *"a employee at woodland needs to be reimbursed for a expense - Janette or Morena scans the reimbursement form and sends it to mary. mary then forwards it into the vision AP system and then they end up approving a reimbursement they wrote. We need to think this all the way through and deep dive on how to make it better and more controlled. without making it insane."*

**Relationship to PR #179:** separate handoff, deliberately. PR #179 is actively executing and must not become a moving target. This work depends on `ap_approval_routing` from PR #179 §1.4 and should be sequenced after Phase 1 of that handoff lands.

---

## §1 — Root cause

The current path is: employee incurs expense → Janette or Morena completes and scans the paper reimbursement form → emails it to Mary → Mary forwards it into the Vision AP mailbox → it lands in the shared AP queue → **Janette approves her own submission** → Mary receives it back "approved by Janette."

**Vision has no concept of who originated a request.** It knows who forwarded it (Mary) and who approved it (Janette). Janette's role as originator exists only as ink inside a scanned PDF — invisible to the system. First-action-wins then does exactly what it was designed to do and lets her claim her own submission.

Two aggravating factors:

- **The approval stamp implies independent review that never happened.** That is worse than no control at all — it manufactures audit evidence for a check that did not occur.
- **Mary is performing a control step that returns her nothing.** Her time is spent relaying a document that comes back approved by the person who sent it to her.

**PR #179's peer routing does not fix this.** That routing fires only at ≥$1,000 and reimbursements rarely reach it; and even when it does, it swaps the *second* approver — the *first* could still be the originator.

**Why reimbursements collided with vendor invoices:** a vendor invoice is an arm's-length transaction with an external counterparty, and the invoice itself is independent evidence. A reimbursement pays an insider against a form an insider wrote. The AP queue was built for the former, where "originator" is meaningless because vendors are not in the org chart.

---

## §2 — Design (all decisions locked with Bill)

### D1 — Structured form intake, not email

Managers get a new **Employee Reimbursement** tile. Clicking it opens a form. **The paper form is retired** — the Vision form replaces it outright.

This is the change that makes everything else possible: **the submitter is authenticated, so Vision knows who originated the request as a fact, not an inference.** No PDF parsing, no tagging, no heuristics. "The submitter cannot approve" becomes a one-line rule instead of a detection problem.

Secondary benefits: amount is entered rather than OCR-guessed; reimbursement spend becomes queryable data instead of a pile of scans; Mary stops being a relay.

### D2 — Form fields (confirmed complete by Bill)

| Field | Type | Required | Notes |
|---|---|---|---|
| Employee being reimbursed | Picker over existing Vision people, **free-text fallback** | Yes | Fallback matters — not every reimbursed person has a Vision account |
| Amount | Currency | Yes | |
| Date of expense | Date | Yes | The expense date, not the submission date |
| Category | Select: mileage, fuel, supplies, meals, tools, other | Yes | |
| What it was for | Free text | Yes | Business purpose |
| Receipt | Photo or file upload | Yes | |
| Site | Auto-filled from submitter | — | Not user-editable |

Captured automatically, not shown as inputs: submitter identity, submitted-at timestamp.

**Bill confirmed this set covers what Mary needs to pay without follow-up questions.**

### D3 — No employee signature

**The employee does not sign today — only the manager does.** So there is no employee attestation to preserve and no signed paper artifact to photograph. The Vision form fully replaces the paper form.

The manager's authenticated submission *is* the first signature.

### D4 — Every reimbursement requires two approvals, regardless of amount

Bill, verbatim:

> *"every reimbursement gets two approvals - the second cannot be the initiator and if it's JT it has to be mg if it's Eugene and it's Rick it's got to be Shannon for a second"*

- **Submission is the first approval.** The submitting manager's authenticated submit is signature one.
- **A peer's approval is the second.** Always. There is no dollar threshold.

**This is deliberately stricter than vendor invoices,** where only ≥$1,000 requires a second signature. A $40 reimbursement needs two signatures where a $900 vendor invoice needs one. The justification: reimbursements pay insiders with no external counterparty and no independent documentary evidence beyond a receipt the claimant supplied.

### D5 — Second-approver routing reuses `ap_approval_routing`

The same table PR #179 §1.4 introduces:

| Submitter | Second approver |
|---|---|
| Janette | Morena |
| Morena | Janette |
| Kelsey (until 8/8) | Morena |
| Rick | Shannon |
| Shannon | Rick |
| Bill | Morena |

One table serves both flows. Staff changes are edited once.

### D6 — The complete exclusion rule: approver ≠ submitter AND approver ≠ beneficiary

Bill's stated rule ("the second cannot be the initiator") covers the submitter. **It does not cover the beneficiary,** and that gap reproduces Mary's exact complaint in mirror image: if Morena submits a reimbursement *for Janette*, routing sends it to Janette — the person being paid.

**Rule as implemented:**

```
eligible second approver =
      routing table peer for the submitter
  AND is not the submitter
  AND is not the person being reimbursed
```

**When the routed peer is the beneficiary, escalate immediately to Bill** — not after 24 hours. There is no valid local approver, so waiting accomplishes nothing.

At Woodland this means: when one manager submits a reimbursement for the other manager, it goes to Bill. Correct outcome — a manager's own reimbursement warrants Bill's eyes regardless.

The common case (either manager submitting for a floor employee) is unaffected: neither is the beneficiary, so it is a plain peer swap.

**Beneficiary matching:** when the employee is chosen from the picker, match on user id. When entered as free text, match case-insensitively on normalized name against the routing-eligible approvers, and **fail safe** — an ambiguous match escalates to Bill rather than risking a self-approval. Log the ambiguity.

### D7 — Same queue, same portal, visually distinguished

Bill: *"that approval will live in the same portal as our current approvals."*

Reimbursements appear in the existing AP queue alongside vendor invoices, with a clear type badge so approvers know which they are looking at. Same tile, same badge counts, same notification plumbing.

**But the approval panel differs.** The Amendment 5 structured Approve panel (vendor freeform / explanation / confirmed amount / equipment multi-select) is a **vendor-invoice** construct and **does not apply to reimbursements** — that data was captured at submission. The reimbursement approval panel shows the submitted form read-only plus the receipt, and offers Approve / Reject / Hold.

Likewise **not applicable to reimbursements:** vendor baseline variance detection, equipment linking, the equipment escape hatch, and amount auto-extraction. All are vendor-invoice concepts.

### D8 — Output goes to Mary, always — never back to the submitter

Bill: *"Mary gets every employee reimbursement request instead of it going to whoever initiated it on the accounting side."*

Vendor invoices route the decision email back to the SVdP forwarder with Mary CC'd, because a forwarder exists. **Reimbursements have no forwarder** — the manager submits directly through the form.

So:

- **Approved reimbursements go to Mary as the sole primary recipient.** She pays them.
- **They are NOT routed back to the submitting manager.** They already know they submitted it.
- **Format matches what Mary receives today** — the same stamped document and decision email shape as AP approvals, so her workflow is unchanged apart from no longer having to forward anything in.
- The stamp carries **both** signatures: submitter (with submitted-at, Pacific) and second approver (with approved-at, Pacific).
- The receipt travels with the document.

**Rejections** go back to the **submitting manager** with the rejection note — they are the one who needs to act. Mary is not notified of a rejection; nothing is owed. **Holds** likewise notify the submitter with the note.

### D9 — 24-hour fallback, consistent with AP

If the routed peer has not acted within 24 hours of **business** time (weekday clock, same skip logic as PR #179 §1.5), the request escalates additively to Bill. The peer remains able to act; whoever acts first completes it.

**Exception per D6:** when the routed peer is the beneficiary, escalation to Bill is immediate, not after 24 hours.

### D10 — Notification scope

Slots into PR #179 §1.6's per-user, per-event model. Reimbursements introduce these events:

| Event | Recipients |
|---|---|
| `reimbursement_approval_needed` | **Only the routed second approver** (or Bill on escalation). Never a broadcast. |
| `reimbursement_approved` | **Mary.** Carries the stamped document. |
| `reimbursement_rejected` | The submitting manager, with the note. |
| `reimbursement_held` | The submitting manager, with the note. |

Pending reimbursements appear in **Bill's 06:00 PT morning digest** (PR #179 §1.7) alongside pending AP items — it is a full-queue oversight tool and reimbursements awaiting signature belong in it.

Shannon's constraint from PR #179 still holds and now reads: she receives a second-approval request when Rick first-signs — whether that is a vendor invoice or a reimbursement — and nothing else.

---

## §3 — Schema

```
reimbursement_requests (
  id                      text PK,
  site_id                 text NOT NULL,

  -- beneficiary
  employee_user_id        text FK → users(id) NULL,   -- when picked from roster
  employee_name_freeform  text NULL,                  -- when not in roster
  -- CHECK: exactly one of the two is non-null

  amount_cents            int  NOT NULL,
  expense_date            date NOT NULL,
  category                enum('mileage','fuel','supplies','meals','tools','other') NOT NULL,
  purpose                 text NOT NULL,
  receipt_file_key        text NOT NULL,              -- R2 object key
  receipt_content_type    text NOT NULL,

  -- first signature = submission
  submitted_by            text FK → users(id) NOT NULL,
  submitted_at            timestamptz NOT NULL,

  -- second signature
  status                  enum('pending_second_approval','approved','rejected','held') NOT NULL,
  second_approver_id      text FK → users(id) NULL,
  second_approved_at      timestamptz NULL,
  decision_note           text NULL,                  -- required on reject and hold

  -- routing / escalation
  routed_to_user_id       text FK → users(id) NOT NULL,
  escalated_at            timestamptz NULL,
  escalated_to            text FK → users(id) NULL,
  escalation_reason       enum('timeout','beneficiary_conflict','no_routing_row') NULL,

  -- output
  decision_pdf_key        text NULL,
  decision_pdf_sha256     text NULL,
  sent_to_accounting_at   timestamptz NULL,

  created_at, updated_at
)
```

Constraints and indexes:

- CHECK: exactly one of `employee_user_id` / `employee_name_freeform` is non-null
- CHECK: `second_approver_id <> submitted_by` — **database-level guarantee that the submitter never approves**
- Index on `(status, routed_to_user_id)` for queue and digest reads
- Index on `(site_id, expense_date)` for reporting

The CHECK constraint is deliberate. This is the control Mary caught failing; it should be impossible at the storage layer, not merely discouraged in application code.

Migration is additive. Clean-replay on empty PG16. CI gate.

---

## §4 — Surfaces

**`/dashboard/<site>/reimbursements/new`** — the Employee Reimbursement tile target. D2 form. Manager role and above. Site auto-filled from the submitter, not editable.

**Existing AP queue** — reimbursements appear with a type badge. The approval panel is the reimbursement-specific one (D7), not the Amendment 5 structured panel.

**`/dashboard/<site>/reimbursements`** — submitter's own view of what they have submitted and where each stands. Read-only.

**Approval panel** — submitted form read-only, receipt inline (image preview or PDF viewer), then Approve / Reject / Hold. Reject and Hold require a note; Approve does not, because the substantive data was captured at submission.

**Guards:** the eligibility check for the second approval consumes the **same shared resolver** PR #179 §1.4 introduces, extended with the D6 beneficiary exclusion. Server-side, always — a hand-crafted request from an ineligible approver is refused.

---

## §5 — Sequencing and dependencies

**Depends on PR #179 Phase 1** for `ap_approval_routing`, the shared approver resolver, the per-user notification prefs model, and the weekday-clock helper. **Do not begin this work until PR #179 Phase 1 has landed** — building against a routing table that does not exist yet, or duplicating one, would be the same mistake twice.

Independent of PR #179 Phases 2, 3, and 4.

**ADR number:** take the next free number at draft time. 0062 is the equipment master; PR #179 §3 is drafting 0063 for document ingestion. **Verify what is actually free — numbers are never reserved.**

---

## §6 — Actions for Bill

1. **Reply to Mary.** She reported a real control failure and was right to push. Worth telling her explicitly that she was right, that the fix is being built, and what changes for her: she stops forwarding reimbursements entirely, and receives them already approved by two people, neither of whom submitted it.

2. **Interim control until this ships.** Reimbursements are still flowing through the current path today. Until the form exists, the rule is verbal: **whoever scanned and sent a reimbursement does not approve it.** Tell Janette and Morena directly — it is the same peer swap they are about to be told about for AP, so it can be one conversation.

3. **Confirm the category list** — mileage, fuel, supplies, meals, tools, other. Add or remove before build rather than after.

4. **Decide whether Eugene needs the same tile now.** Rick and Shannon are in the routing table and the build is site-agnostic; this is only a question of whether Eugene's reimbursement process runs the same way today.

---

## §7 — Actions for Claude Code

1. Author the ADR from §2 at the next free number.
2. Migration per §3, including **both** CHECK constraints. Additive, clean-replay, CI gate.
3. Reimbursement form + tile per §4.
4. Extend the PR #179 shared approver resolver with the D6 beneficiary exclusion. **Do not fork a second resolver.**
5. Approval panel, queue integration with type badge, submitter's own view.
6. Notification events per D10, wired into the PR #179 per-user prefs model and `notifyStaff()`.
7. Decision document generation matching the existing AP stamped-PDF format, carrying both signatures and the receipt.
8. Delivery to Mary per D8. Rejections and holds to the submitter.
9. 24-hour weekday fallback per D9, reusing the PR #179 scanner rather than a second one. Immediate escalation on the beneficiary conflict.
10. Fold pending reimbursements into Bill's 06:00 digest.

**Do NOT:**

- Do NOT let the submitter approve their own request. Enforce at the database, in the resolver, and in the UI.
- Do NOT let the beneficiary approve their own reimbursement, even when the routing table points at them. Escalate to Bill immediately.
- Do NOT apply the Amendment 5 structured Approve panel, vendor baselines, variance detection, equipment linking, or amount auto-extraction to reimbursements. All are vendor-invoice constructs.
- Do NOT route approved reimbursements back to the submitter. They go to Mary.
- Do NOT add a dollar threshold. Every reimbursement gets two signatures.
- Do NOT build a second routing table or a second approver resolver. Extend PR #179's.
- Do NOT begin before PR #179 Phase 1 lands.
- Do NOT require an employee signature. The employee does not sign today; the manager does.

---

## §8 — Success criteria

- A manager submits a reimbursement from the tile; it lands in the AP queue badged as a reimbursement and routed to their peer.
- **The submitter cannot approve it** — refused in the UI, refused server-side, and impossible at the database.
- When the routed peer is the person being reimbursed, it escalates to Bill immediately, not after 24 hours.
- Approved reimbursements reach **Mary** in the same document format she receives today, carrying both signatures and the receipt, and are **not** sent back to the submitter.
- Rejections and holds reach the submitting manager with the note.
- Pending reimbursements appear in Bill's 06:00 digest.
- Shannon receives a reimbursement approval request only when Rick submitted — consistent with her AP constraint.
- No dollar threshold exists anywhere in the reimbursement path.

---

## §9 — Session close

Mary found a control that manufactured evidence of a review that never happened, and said so plainly. The fix is structural rather than procedural: once intake is an authenticated form instead of a scanned PDF, Vision knows who originated the request as a fact, and "the submitter cannot approve" becomes enforceable at the database rather than a policy nobody can check.

The mandatory two signatures — stricter than the vendor-invoice threshold — reflect that reimbursements pay insiders against documentation the claimant supplied, with no external counterparty. The beneficiary exclusion in D6 closes the mirror-image gap that the stated rule alone would have left open.

Mary's workflow gets shorter, not longer: she stops forwarding, and receives only finished work.
