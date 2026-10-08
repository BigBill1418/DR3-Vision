# ADR-0141 — An invoice the team received directly: in-app submission, and the submitter names the accountant

- **Status:** **Proposed** (2026-10-08). Planning only. No code yet. Eight open
  questions for Bill are listed in the plan (`docs/plans/2026-10-08-ap-team-submit.md` §2).
  The Decision section below is written for the **recommended** answers and must
  be amended before build if Bill picks differently.
- **Request:** Bill, 2026-10-08, verbatim: _"currently only accounting submits invoices
  for approval - we need a new method for invoices that come in to the team directly -
  we need to be able to submit - then SELECT which accounting staff the
  approval/rejection goes to after we submit the invoice - this keeps the existing
  setup the same but ADDS this functionality."_
- **Extends:** ADR-0046 (AP approval mailbox, all amendments), ADR-0066 (person routing
  and the shared second-approval resolver), ADR-0068 (the in-app submission and
  submitter-exclusion precedent), ADR-0136 (duplicate-invoice guard), ADR-0047
  (rollout gate), ADR-0035 (additive, clean-replay migrations).
- **Changes nothing in:** the mailbox intake, the approver roster, the Approve panel,
  the $1,000 second signature, the decision mail for mailbox-originated invoices, the
  morning digest's rules, approver expiry, the baseline rebuild, or desktop-only review.

## Context — what exists today (verified 2026-10-08 against `origin/main` f3867db and prod)

**One intake channel.** Accounting forwards a vendor invoice email to
`approvals-dr3@svdp.us`. `runApPoll` → `ingestMessage` (`src/lib/ap/ingest.ts:217`)
validates the envelope sender, sanitizes, stores attachments in R2 `ap/`, runs amount
extraction, and creates the `ap_requests` row (`ingest.ts:315`). That is the only code
that creates an `ap_requests` row (`ingest.ts:99` is the quarantine create).

**The decision mail goes back to whoever forwarded it.** `resolveForwarderRecipients`
(`src/lib/ap/approvals.ts:829`): To = the forwarder (`sender_address`) when it is
`@svdp.us`; CC = every active `ap_decision_recipients` row (Mary's GP filing). The
hold notice (`approvals.ts:997`) and the decision mail (`approvals.ts:1109`) both use it,
and `sendDecisionEmail` is the single sender for first decision, second signature
(`second-approval.ts:271`) and resend (`api/ops/ap/[id]/resend/route.ts:22`).

**Prod shape (counts only):** `ap_sender_config` has no row, so the mode is the default
`tenant_wide` (`senders.ts:94`): any `@svdp.us` sender is accepted. In the last 90 days
227 requests came from **3** distinct forwarders. **2 of the 3 have no Vision account**;
the third is a manager who is also an approver. `ap_decision_recipients` holds 1 active
row, which is also not a Vision user. 5 active approvers; 7 active managers, 1 admin,
9 operators.

**So "accounting staff" does not exist in Vision's user table.** Any picker has to be
backed by a new list.

**A team member can already email the mailbox, and that is the gap, not the feature.**
Under `tenant_wide` a site manager can forward an invoice to `approvals-dr3@svdp.us`
today. The outcome then goes back **to the manager**, not to an accountant of their
choosing. There is also **no separation-of-duties check against the forwarder**:
nothing in `decideRequest` (`approvals.ts:373`) compares the actor with
`sender_address`. In prod, 1 of 227 requests was first-approved by the person who
forwarded it. Accounting forwarders are never approvers, so this has not mattered.
It matters as soon as the people who receive invoices directly (managers, several of
them approvers) can submit.

**Precedent.** ADR-0068 (employee reimbursements) already ships an in-app,
manager-authenticated submission with `submitted_by` as a fact, a DB CHECK plus
resolver plus UI exclusion of the submitter, and a per-site UI rollout surface
(`reimbursement_tile`). It also proved the cost of forking the approver path: ADR-0066
and ADR-0134 were both outages caused by two code paths answering "who may sign"
differently.

## Decision (as recommended — pending Bill, see plan §2)

### D1 — Same record, second intake channel

A team submission creates an **`ap_requests` row**, not a new table. Every approver
control then applies unchanged and with no copy: the structured Approve (ADR-0046
Am.5), extraction, the variance gate, the $1,000 second signature through the ADR-0066
resolver, the duplicate guard (ADR-0136), the stamped PDF, the AP queue, history,
escalation and the morning digest. A team submission shows in the shared queue with a
**"Team submission"** chip naming the submitter, their site and the chosen accountant.

Rejected alternative: a separate table and queue, like reimbursements. That forks
the approver path, which is the failure class behind ADR-0066 and ADR-0134. A vendor
invoice is the same kind of document whoever receives it. Only how it arrived differs.

### D2 — Who may submit

A **manager, at their own site, or an admin** (`requireManagerForSite`, the
reimbursement guard). The site comes from the session, never from the request body.
Operators (PIN floor accounts) may not. Being on the approver roster is **not**
required, and being on it does not stop someone submitting (see D5).

### D3 — Where it lives

- **Submit:** a tile on the site dashboard opens `/dashboard/[site]/ap-submit`. It works
  on a phone, because the typical case is a paper invoice handed over on the floor, so
  a camera photo is a valid file. The tile is gated by a new per-site UI surface
  `ap_team_submit`, **born pilot** (ADR-0047: admin-only until Bill flips it live per
  site).
- **Form:** invoice file(s) (PDF/JPEG/PNG/HEIC, required, at least 1 and at most 5,
  15 MB each); vendor; invoice number; amount; "what is this for"; **accounting staff
  member** (required, single select).
- **My submissions:** the same page lists the manager's own submissions and their
  status (pending / on hold / awaiting 2nd signature / approved / rejected / NOT DR3).
- **Review is unchanged:** approvers decide in `/dashboard/ops/ap` on desktop
  (ADR-0046 Am.6). Nothing about review moves to mobile.

### D4 — "The approval/rejection goes to": the selected accountant is the RECIPIENT of the outcome, not the approver

Recommended reading (Interpretation A in the plan): the invoice goes through the
**normal approvers**. The selected accountant is who the **decision mail** goes to, in
place of the "original forwarder" an emailed invoice has. This is the only reading
that keeps "the existing setup the same":

- the approver roster, Approve panel and $1,000 rule are untouched;
- 2 of the 3 accounting staff have no Vision account, so they cannot approve inside
  Vision without new accounts, new roster rows and a new authority;
- letting the submitter choose their own approver would weaken the control
  ADR-0068 exists to enforce.

Interpretation B (the chosen accountant **is** the approver) is set out in the plan
and is **not** built unless Bill picks it.

**Decision-mail routing for `intake_channel = team_submit`** (mailbox rows untouched):

| Mail                                                                              | To                                                | CC                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Decision (approved / rejected / NOT DR3), incl. after 2nd signature and on resend | the selected accountant                           | the submitter + the existing `ap_decision_recipients` roster (unchanged GP filing) |
| Hold notice                                                                       | the submitter (they hold the vendor relationship) | the selected accountant                                                            |

This is implemented as **one** new resolver, `resolveOutcomeRecipients(request)`,
that branches on `intake_channel`. For a `mailbox` row it returns exactly what
`resolveForwarderRecipients` returns today, and a test pins that equality. The
"no recipients → refuse and page" path in `sendDecisionEmail` is unchanged.

The accountant's address is **snapshotted** on the request at submit time
(`outcome_recipient_email`). A later edit to the accounting list cannot redirect a
decision that was already routed.

### D5 — Separation of duties: the submitter takes no decision on their own submission

The submitter cannot **approve** (first or second signature), **reject**, **hold** or
file **NOT DR3** on a request they submitted. Enforced at three layers, as in ADR-0068 D4:

1. **DB CHECKs:** `submitted_by IS DISTINCT FROM first_approver_id`,
   `… second_approver_id`, `… decided_by`, `… held_by`.
2. **Server guard:** before any write in `decideRequest`, `decideSecondApproval` and
   `holdRequest`, with a plain-English 403 and an audited refusal
   (`outcome: refused_submitter_self_decision`).
3. **UI:** the panel is not offered to the submitter and says why ("You submitted
   this invoice. Another approver decides it.").

There is **no admin short-circuit**. The exclusion is about the person, not the
privilege (ADR-0068 D4).

**Second signature.** The ADR-0066 resolver gets the submitter as an exclusion, the
same thin-wrapper pattern as `src/lib/reimbursements/routing.ts`. If the routed peer
**is** the submitter, it escalates to the fallback admin **immediately**, not after
24 hours, because no local signer can act.

**New-invoice notification** (`notifyNewRequest`) excludes the submitter from the
approver list. They already know they submitted it.

### D6 — Schema (additive only, ADR-0035; every pre-existing row backfills as a mailbox row)

```
enum ApIntakeChannel { mailbox, team_submit }

ap_requests
  + intake_channel          ApIntakeChannel @default(mailbox)
  + submitted_by            String?   -- bare FK users.id
  + submitted_site_id       String?   -- bare FK sites.id (from the session)
  + submitted_at            DateTime?
  + outcome_recipient_id    String?   -- bare FK ap_accounting_contacts.id
  + outcome_recipient_email String?   -- snapshot at submit
  + submitted_vendor        String?   -- the submitter's typed values; approvers still
  + submitted_invoice_number String?  --   confirm every Am.5 field themselves
  + submitted_amount_cents  Int?
  CHECK (intake_channel <> 'team_submit'
         OR (submitted_by, submitted_site_id, outcome_recipient_id,
             outcome_recipient_email) all NOT NULL)
  CHECKs from D5

ap_accounting_contacts            -- the "accounting staff" list (source of truth)
  id, email UNIQUE (must be @svdp.us), display_name, active,
  created_by, created_at, updated_at, updated_by
```

Team rows reuse the existing columns: `internet_message_id = 'team-submit:<uuid>'`
(cannot collide with an RFC 5322 id), `sender_address` = the submitter's email
(every reader that shows "requester" keeps working), `sender_validated = true`,
`subject` composed as `Invoice #: <number> — <vendor> (team submission)` so ADR-0136's
`extractInvoiceNumber` finds the number without change, and `body_text` = "what this is
for". Attachments go into `ap_attachments` under R2 `ap/`, and extraction runs on them
as it does at mailbox intake.

`ap_accounting_contacts` is managed at `/admin/ap/config`. It is deliberately
**not** `ap_decision_recipients`: every row in that table is CC'd on **every**
decision, so adding accountants there would change today's mail for everyone.

### D7 — Audit

Append-only `writeAudit` rows for each step:

- submission (`actor_user_id` = submitter; after = channel, site, outcome-recipient
  id, attachment count and sha256s, with no amount or vendor in the audit payload);
- every refused self-decision;
- every accounting-contact create, edit and deactivate.

Decision audits are unchanged.

### D8 — Rollout

- **UI surface** `ap_team_submit`, one row per site, born `pilot`. In pilot only an
  admin sees the tile.
- **Notification surface** `ap_team_outcome`, born `pilot`. The decision and hold mail
  for team rows go through `notifyStaff('ap_team_outcome')`. In pilot they reroute to
  admins with the would-have-sent header.
- Bill runs an end-to-end submission as admin in pilot, then flips both surfaces live
  per site from `/admin/rollout`. `ap_notify` (new-invoice mail to approvers) is already
  live and is not touched.

## Consequences

- A manager who receives an invoice directly no longer has to route it through
  accounting by email. The accountant they pick gets the outcome. Accounting's own flow
  is byte-identical.
- The approver can now see who originated an invoice, which the mailbox channel never
  recorded. The SoD gap for manager-originated invoices closes **for the new channel
  only**. A manager who still emails the mailbox directly keeps today's behaviour
  (decision back to them, no submitter exclusion). This residual is recorded, not
  fixed, because fixing it would change the existing setup Bill asked to keep.
- Duplicate risk rises: a vendor that emails both the site and accounting can produce
  one team submission and one mailbox request. ADR-0136's guard covers this only when
  both carry the invoice number. The composed subject makes the team row carry it
  every time.
- The accounting list is a new thing someone has to maintain. If it is empty, the
  submit form refuses with a clear message and pages `dr3-vision-system` once.

## Residual risks

- The mailbox SoD gap described above.
- A submitter can pick the wrong accountant. The snapshot is fixed. An admin
  correction followed by a resend is the remedy (plan Q8).
- An invoice photographed badly gives extraction confidence `failed`. The approver
  enters the amount, as today.
