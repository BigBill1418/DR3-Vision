# ADR-0141 — An invoice the team received directly: in-app submission, and the submitter names the accountant

- **Status:** **Accepted** (2026-10-08). Bill answered every open question on
  2026-10-08 at 08:56 PDT and added a third accountant at 09:05 PDT. Built and shipped
  in the same PR as this acceptance, born `pilot` (D8). Go-live is Bill's flip.
- **Request:** Bill, 2026-10-08, verbatim: _"currently only accounting submits invoices
  for approval - we need a new method for invoices that come in to the team directly -
  we need to be able to submit - then SELECT which accounting staff the
  approval/rejection goes to after we submit the invoice - this keeps the existing
  setup the same but ADDS this functionality."_
- **Extends:** ADR-0046 (AP approval mailbox, all amendments), ADR-0066 (person routing
  and the shared second-approval resolver), ADR-0068 (the in-app submission
  precedent), ADR-0136 (duplicate-invoice guard), ADR-0047 (rollout gate), ADR-0035
  (additive, clean-replay migrations).
- **Changes nothing in:** the mailbox intake, the approver roster, the Approve panel,
  the $1,000 second signature, the decision mail for mailbox-originated invoices, the
  morning digest's rules, approver expiry, the baseline rebuild, or desktop-only review.
- **Plan:** `docs/plans/2026-10-08-ap-team-submit.md` (§2 records each question and
  Bill's answer).

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

## Decision (Bill, 2026-10-08)

| #   | Question                         | Bill's answer                                                                                                                                                                                                               |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What is the picked accountant?   | The **recipient** of the decision, not an approver. The normal approver path decides: the same `ap_requests` record, the ADR-0136 duplicate check, the $1,000 second signer through the shared resolver.                    |
| Q2  | Who may submit?                  | Managers for **their own site only**, and admins for any site.                                                                                                                                                              |
| Q3  | Where does the list come from?   | A **new admin-managed list** (name, `@svdp.us` email, active) in `/admin`. Seeded with Gloria Salpino, Mary Scott and (09:05 PDT) Yvonne Stephens.                                                                          |
| Q4  | How many accountants?            | **Exactly one**, required.                                                                                                                                                                                                  |
| Q5  | Who gets the mail?               | **To** the picked accountant, **CC** the submitter plus the existing `ap_decision_recipients` roster, de-duplicated, for every mail `resolveForwarderRecipients` served. Team rows only; mailbox mail stays byte-identical. |
| Q6  | May the submitter decide?        | **Yes.** The submitter may approve or hold their own invoice like any other. No submitter guard. Every existing rule stays.                                                                                                 |
| Q7  | Required fields                  | Invoice file (PDF/image, same storage as ingested attachments), vendor, invoice number, amount, purpose. Site auto-filled from the manager's site; admins pick one.                                                         |
| Q8  | Can the accountant change later? | Fixed at submit. An **admin** can correct it and resend (audited).                                                                                                                                                          |

### D1 — Same record, second intake channel

A team submission creates an **`ap_requests` row** with `intake_channel = team_submit`,
not a new table. Every approver control applies unchanged: the structured Approve
(ADR-0046 Am.5), extraction, the variance gate, the $1,000 second signature through the
ADR-0066 resolver, the duplicate guard (ADR-0136), the stamped PDF, the AP queue,
history, escalation and the morning digest. The approver sees a **"Team submission ·
<submitter> (<site>) → <accountant>"** block in the queue detail with the submitter's
typed vendor, invoice number and amount for reference.

Rejected: a separate table and queue (the reimbursement shape). That forks the approver
path, which is the failure class behind ADR-0066 and ADR-0134.

### D2 — Who may submit

`teamSubmitAccess` (`src/lib/ap/team-submit.ts`) is the one gate for the dashboard
tile, the page and the API:

- **admin:** any site, always (pilot included);
- **manager:** only when the URL site is their `primary_site_id`. The `all_sites` reach
  flag does **not** widen this (Bill: "for their own site only");
- **operator:** never;
- while `ui/ap_team_submit` is `pilot` for the site, a manager is refused (`pilot`).

The site comes from the URL and is checked against the session; the submitter is the
session user. Body fields named `site_id` or `submitted_by` are ignored (tested).

### D3 — Where it lives

- **Submit:** "Submit an invoice" on the site dashboard opens
  `/dashboard/<site>/ap-submit`. Phone-width layout; a camera photo is a valid file.
  The manager's site is shown fixed; an admin gets a site picker. English, Spanish and
  Urdu (`ap_submit.*` in the manager dictionary; the parity test covers it).
- **Form:** invoice file(s) (PDF, JPEG, PNG, HEIC/HEIF, WebP; 1 to 5 files, 15 MB each),
  vendor, invoice number, amount, "what is this invoice for", and the accounting staff
  member (required, single select).
- **My submissions:** the same page lists the user's own team submissions with status
  and who the decision goes to.
- **Review is unchanged:** approvers decide in `/dashboard/ops/ap` on desktop
  (ADR-0046 Am.6).
- **The list:** managed on the AP configuration page, `/admin/ap/routing` (also
  `/admin/ap/notifications`), section "Accounting staff (team-submitted invoices)".
  Add, deactivate and reactivate; never delete (a routed request keeps its foreign key).

### D4 — Outcome routing: the accountant is the RECIPIENT

One resolver, `resolveOutcomeRecipients(prisma, request)` in `approvals.ts`, replaces the
two direct calls of `resolveForwarderRecipients` (hold notice and `sendDecisionEmail`).
`sendDecisionEmail` is the single sender for the first decision, the second signature
and resend, so the resolver covers every mail type.

| Row channel   | Mail                                                                         | To                                          | CC                                                                        | Surface                                |
| ------------- | ---------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `mailbox`     | all (unchanged)                                                              | the forwarder (roster if no forwarder)      | the roster                                                                | `ap_notify`, org-wide                  |
| `team_submit` | approve, reject, NOT-DR3, hold, second signature (approve or reject), resend | the picked accountant (snapshot on the row) | the submitter + the roster, de-duplicated, never repeating the To address | `ap_team_outcome`, the submission site |

The existing extras are kept: a second-signer override reject still adds the first
approver to CC. The "no recipient → refuse and page" path is unchanged.

The accountant's address is **snapshotted** on the request at submit
(`outcome_recipient_email`), so a later edit to the list cannot redirect a routed
decision. Only the admin correction changes it.

### D5 — The submitter may decide their own invoice (Bill's decision; accepted risk)

The plan recommended a separation-of-duties guard (the submitter takes no decision on
their own submission). **Bill rejected it on 2026-10-08:** the submitter may approve
or hold their own invoice the same as any other invoice. Nothing was added to
`decideRequest`, `holdRequest`, `updateHoldNote` or `decideSecondApproval`, and the
new-invoice notification still goes to every approver, the submitter included.

Every existing rule stays exactly as it was, including the second-signature rules
(the routed second signer, escalation, and the first approver's self-reconfirm wait
under ADR-0066/Am.5). Nothing new was added and nothing was removed.

**Accepted risk, recorded:** a manager who is also an approver can submit an invoice,
pick the accountant and approve it themselves when it is under $1,000. Above $1,000 the
second signature still applies under the existing rules. The mitigations are the ones
that already exist: the submission, the accountant choice and every decision are
audited with the actor; the "Team submission" block shows the approver who submitted
it; and the accountant receives the decision with the submitter named. This matches
today's mailbox behaviour, where a manager-approver who forwards an invoice can also
approve it (1 of 227 prod requests on 2026-10-08).

### D6 — Schema (additive only, ADR-0035; migration `20260869_adr0141_ap_team_submit`)

```
enum ApIntakeChannel { mailbox, team_submit }

ap_requests
  + intake_channel           ApIntakeChannel NOT NULL DEFAULT 'mailbox'
  + submitted_by             FK users.id
  + submitted_site_id        FK sites.id
  + submitted_at
  + outcome_recipient_id     FK ap_accounting_contacts.id
  + outcome_recipient_email  -- snapshot
  + submitted_vendor, submitted_invoice_number, submitted_amount_cents
  CHECK ap_requests_team_submit_shape_chk:
    team_submit ⇒ submitter, site, submitted_at, recipient id + email all present;
    mailbox     ⇒ no submitter, no recipient

ap_accounting_contacts
  id, display_name (non-blank), email UNIQUE (lower-case @svdp.us, CHECK), active,
  created_by, updated_by, created_at, updated_at
```

Team rows reuse the existing columns: `internet_message_id = 'team-submit:<uuid>'`,
`sender_address` = the submitter's email (lower-cased), `sender_validated = true`,
`subject = "Invoice #: <number> — <vendor> (team submission)"` so ADR-0136's
`extractInvoiceNumber` finds the number, and `body_text` = the purpose. Files are stored
**before** the row exists, under the same R2 `ap/<request>/<attachment>/` layout as the
mailbox intake (`putApAttachment`), each with its sha256; if R2 is unavailable the
submission is refused (503) and no row is written. Extraction runs exactly as at
mailbox intake.

**Seed:** an idempotent data migration (`INSERT … ON CONFLICT (email) DO NOTHING`, one
`audit_log` row per row actually inserted), following the repo's named-person seed
precedent (ADR-0066, ADR-0046 Am.9, ADR-0019.7). It lands with the code that reads it,
so the picker is never born empty, and a re-run never overwrites an admin's later edit.

### D7 — Audit (append-only `audit_log`)

- the submission and the accountant choice, one row: actor = submitter; after = channel,
  site, recipient id and email, attachment count and sha256s (no vendor or amount);
- every admin correction: actor = admin; before/after recipient; plus one row for the
  re-send it triggered;
- every accounting-list create, edit, deactivate and reactivate (before/after);
- the three seeded contacts (`system:migration 20260869`).

Decision audits are unchanged.

### D8 — Rollout (ADR-0047), born pilot

- **UI surface** `ap_team_submit` (`kind = ui`), one row per site, born `pilot`. Pilot =
  only admins see the tile, open the page or can POST.
- **Notification surface** `ap_team_outcome` (`kind = notification`), one row per site,
  born `pilot`. Team decision and hold mail go through
  `notifyStaff('ap_team_outcome', site)`. In pilot it reroutes to admins with the
  would-have-sent header naming the accountant, so an admin test submission never
  mails accounting. It is its own row (not `ap_notify`) because it is a new recipient
  set, the ADR-0068 precedent.
- **Go-live is Bill's call:** flip both rows `live` per site from `/admin/rollout`.
  `ap_notify` (new-invoice mail to approvers) is already live and is not touched.

## Consequences

- A manager who receives an invoice directly no longer has to route it through
  accounting by email. The accountant they pick gets the outcome. Accounting's own flow
  is byte-identical, pinned by a regression suite over every mail type.
- The approver can now see who originated a team invoice.
- Duplicate risk rises: a vendor that emails both the site and accounting can produce
  one team submission and one mailbox request. ADR-0136's guard catches it when both
  carry the invoice number; the composed subject guarantees the team row does.
- The accounting list is a new thing someone maintains. An empty active list shows the
  manager "No accounting staff are set up yet" instead of a form.

## Residual risks

- D5: a manager-approver can approve their own sub-$1,000 team invoice (Bill's decision).
- A submitter can pick the wrong accountant. The admin correction plus re-send is the
  remedy.
- A badly photographed invoice gives extraction confidence `failed`; the approver
  enters the amount, as today.
