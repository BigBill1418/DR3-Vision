# Plan — AP team submission with a chosen accounting recipient (ADR-0141)

- **Status:** **SHIPPED, born pilot** (2026-10-08). Bill answered every question on
  2026-10-08 at 08:56 PDT (third accountant added 09:05 PDT); the answers are recorded
  below each question in §2 and in ADR-0141 (now Accepted). Phases 0–4 shipped in one PR
  (#298); Phase 3's SoD half was dropped by Bill's Q6 answer. Phase 5 (Bill's pilot run
  and the flip of `ap_team_submit` + `ap_team_outcome` per site at `/admin/rollout`) is
  his call and has NOT happened.
- **Branch:** `plan/ap-team-submit` (PR #298), squash-merged to `main`.
- **Implementer:** Aegis (or svdp-apps-engineer). Ryan verifies (READ-ONLY) at the
  end of Phase 5.
- **Collision check (2026-10-08):** the only other AP branch,
  `fix/ap-second-signer-cant-act` (714ef62, ADR-0134), is already on `main` as #292
  (`git cherry` reports it patch-equivalent) and its worktree is clean. No open branch
  touches `approvals.ts`, `second-approval*.ts`, `notify.ts` or `ApQueueClient.tsx`.
  Re-check with `git fetch && git log origin/main -- src/lib/ap` before Phase 1.

## 1. Verified-open line

**verified-open-because:**

- `ap_requests` rows are created only by the mailbox poll (`src/lib/ap/ingest.ts:99`,
  `:315`). There is no in-app invoice submission route.
- There is no column recording who originated an invoice, and none recording a chosen
  accounting recipient.
- Decision and hold mail always go to the forwarder, with the fixed roster on CC
  (`resolveForwarderRecipients`, `src/lib/ap/approvals.ts:829`).
- `decideRequest` has no submitter or forwarder exclusion (`approvals.ts:373`). In prod,
  1 of 227 requests was first-approved by the person who forwarded it.

The partial overlap is the mailbox itself. Under the default `tenant_wide` sender mode,
a manager can already email `approvals-dr3@svdp.us`, but the outcome comes back to the
manager and they cannot pick an accountant.

## 2. Questions for Bill, with his answers (2026-10-08)

**Q1. What does "the approval/rejection goes to [the selected accountant]" mean?**

- **A (recommended).** The invoice goes through the normal approvers (Morena, Rick,
  Janette, …, $1,000 second signature unchanged). The selected accountant **receives the
  decision mail** so they can process payment. This is the same role the forwarder
  plays for an emailed invoice.
- **B.** The selected accountant **is** the approver. Each accountant needs a Vision
  account and approver authority (2 of the 3 have no account today), and the
  submitter would be choosing their own approver.
- **C.** Both: the normal approvers decide, and the accountant must also approve before
  it is final. This adds a third signature to every team invoice.

Recommendation: **A**. It is the only reading that keeps the existing approval setup
unchanged.

> **Bill (08:56 PDT): A.** The picked accountant is the decision RECIPIENT, not an approver. The normal approver path decides: same request record, ADR-0136 duplicate check, $1,000+ second signer through the shared resolver.

**Q2. Who may submit?**

- **A (recommended).** Managers at their own site, plus admins. This is the
  reimbursement guard.
- **B.** Managers and admins only if they are also on the approver roster.
- **C.** Any Vision user with an email address, including office staff with no site.
- **D.** An explicit admin-managed allow-list.

> **Bill: A.** Managers for their own site only, plus admins for any site. Built so the `all_sites` reach flag does not widen a manager's submit scope.

**Q3. Where does the "accounting staff" list come from?**

- **A (recommended).** A new admin-managed list at `/admin/ap/config`: name and
  `@svdp.us` email, with an active flag. Bill seeds it with the accounting staff names.
- **B.** Reuse `ap_decision_recipients`. Today everyone on that list is CC'd on every
  decision, so adding people to it changes existing mail.
- **C.** An Entra (M365) security group read through Graph. This needs a new Graph
  permission and tenant-admin consent from SVdP IT.
- **D.** Vision user accounts with an "accounting" flag. 2 of the 3 accounting staff
  have no account.

Bill also needs to supply the names and emails to seed, whichever option he picks.

> **Bill: A.** A new admin-managed list (name, @svdp.us email, active) in `/admin`, seeded with Gloria Salpino <gloria.salpino@svdp.us>, Mary Scott <mary.scott@svdp.us> and (09:05 PDT) Yvonne Stephens <yvonne.stephens@svdp.us>. Seeded by an idempotent, audited data migration (the repo's named-person seed precedent). Managed on `/admin/ap/routing`.

**Q4. One accountant or several?**

- **A (recommended).** Exactly one, required.
- **B.** One primary, plus optional additional CCs.
- **C.** Multi-select, all equal.

> **Bill: A.** Exactly one, required.

**Q5. Who else gets the decision mail for a team invoice?**

- **A (recommended).** To: the selected accountant. CC: the submitter, plus the
  existing GP-filing roster (Mary), exactly as she is CC'd today.
- **B.** The selected accountant only.
- **C.** The accountant and the submitter, but not the roster.

> **Bill: A, for every mail `resolveForwarderRecipients` served** (approve, reject, NOT-DR3, hold, second signature, resend): To the picked accountant, CC the submitter plus the `ap_decision_recipients` roster, de-duplicated. Team rows only; the mailbox path is byte-identical. Note this also routes the HOLD notice To the accountant (the plan's D4 table had sent it To the submitter).

**Q6. What may the submitter do on their own invoice?**

- **A (recommended).** Nothing: no approve, reject, hold or NOT-DR3, and no
  first or second signature. Another approver decides.
- **B.** No approve, but they may withdraw it (reject with a note).
- **C.** No approve, but they may hold it.

> **Bill: none of the above — CHANGED FROM THE RECOMMENDATION.** The submitter MAY approve or hold their own invoice, the same as any other invoice. No submitter guard was built; every existing rule stays. ADR-0141 D5 records the decision and its accepted risk.

**Q7. What must the submitter fill in?**

- **A (recommended).** Invoice file(s), vendor, invoice number, amount, "what is this
  for" and the accountant. The site is automatic. Approvers still confirm vendor and
  amount in the Approve panel.
- **B.** Only the file(s) and the accountant. Approvers type everything else. The
  duplicate check then depends on extraction finding the invoice number.
- **C.** A plus an optional equipment pick, which pre-fills the approver's equipment
  field.

> **Bill: A.** Required: invoice file (PDF/image, same R2 storage as ingested attachments), vendor, invoice number, amount, purpose; plus the accountant (Q4). The site is auto-filled from the manager's site; admins pick one.

**Q8. Can the chosen accountant be changed after submission?**

- **A (recommended).** No. It is fixed at submit. An admin can correct it and use the
  existing Resend.
- **B.** The submitter may change it while the invoice is undecided (audited).
- **C.** An approver may change it in the decide panel.

> **Bill: A.** Fixed at submit. An admin can correct it and resend (audited): the AP queue detail's "Correct and resend" control, `POST /api/admin/ap/requests/<id>/accountant`.

## 3. Phased build (sized for Aegis)

Each phase is one PR into `main` with tests green and docs updated in the same commit:
CHANGELOG, this plan's status line, and the ADR-0141 status. The deployer
auto-deploys on merge. **Every phase is inert until Bill flips the surfaces**, because the
UI surface is born pilot.

### Phase 0 — Answers (gate)

Bill answers Q1–Q8. Amend ADR-0141 to match, and mark it Accepted.
**Done when:** the ADR has no "recommended/pending" wording left.

### Phase 1 — Schema, accounting list, rollout rows (~0.5 day)

- Migration `2026101x_ap_team_submit`: the ADR-0141 D6 enum, columns, CHECKs (incl. the
  D5 SoD CHECKs) and the `ap_accounting_contacts` table. Purely additive. Clean-replays
  on empty PG16 (ADR-0035). Backfill: none (`intake_channel` defaults to `mailbox`).
- Seed `rollout_surfaces` rows: `ui/ap_team_submit` × 2 sites and
  `notification/ap_team_outcome` × 2 sites, all `pilot`. Register both codes in
  `src/lib/notify/rollout.ts`.
- Accounting-contacts CRUD on `/admin/ap/config` (admin only, `@svdp.us` validation,
  audited). Use the `ApConfigScreen` pattern.
- **Tests:** migration replay; the CHECK rejects a `team_submit` row without a
  recipient; the CHECK rejects `first_approver_id = submitted_by` through raw SQL; CRUD
  refuses external domains.

### Phase 2 — Submission service and route (~1 day)

- `src/lib/ap/team-submit.ts`, with `submitTeamInvoice({ session, siteCode, fields, files })`:
  - stores the files in R2 `ap/` and writes `ap_attachments` the same way `persistAttachments` does;
  - runs `extractFromRequest` on the files;
  - composes the subject (ADR-0141 D6) and creates the `ap_requests` row with
    `intake_channel=team_submit` and `internet_message_id='team-submit:'+uuid`;
  - snapshots the accountant's email and writes the audit row;
  - calls `notifyNewRequest` with the submitter removed from the approver list.
- Route `POST /api/dashboard/[site]/ap-submit`, multipart, `requireManagerForSite`.
  The UI surface check is server-side too, so an API call can't bypass the pilot gate
  (ADR-0085 pattern). It returns 400 with plain English for a missing file, missing
  accountant, inactive accountant, bad amount, or an oversize or unsupported file.
- If the accounting list is empty, refuse and page `dr3-vision-system` once
  (fingerprinted).
- **Tests:** happy path writes the expected row shape; site comes from the session (a
  body `site_id` is ignored); operator → 403; manager at another site → 403; pilot
  surface + non-admin → 403; the duplicate guard (ADR-0136) fires for a team row whose
  invoice number matches an approved mailbox row.

### Phase 3 — SoD guards and outcome routing (~1 day)

- **SoD:**
  - `assertNotSubmitter(request, actorUserId)` is called first in `decideRequest`
    (`approvals.ts:373`), `holdRequest` (`:867`), `updateHoldNote` and
    `decideSecondApproval` (`second-approval.ts:120`);
  - the refusal is audited as `refused_submitter_self_decision`;
  - the second-signature resolver wrapper excludes `submitted_by` and escalates
    immediately when the routed peer is the submitter. Model it on
    `src/lib/reimbursements/routing.ts:133`, and keep one resolver
    (`second-approval-resolver.ts`): do not fork it.
- **Routing:**
  - `resolveOutcomeRecipients(request)` replaces both call sites of
    `resolveForwarderRecipients` (`approvals.ts:997`, `:1109`);
  - mailbox rows delegate to the old function unchanged;
  - team rows use the ADR-0141 D4 table, and their mail goes through
    `notifyStaff('ap_team_outcome')`.
- The detail route (`GET /api/ops/ap/[id]`) adds `isSubmitter` and the team-submission
  fields, so the panel can hide itself.
- **Tests (the "existing path unchanged" set):**
  - for every fixture mailbox row, `resolveOutcomeRecipients` deep-equals
    `resolveForwarderRecipients`;
  - `sendDecisionEmail` recipients for a mailbox row are unchanged (existing tests pass
    unmodified);
  - `ingestMessage` rows carry `intake_channel='mailbox'` and null submitter columns;
  - the decision, hold and resend paths for mailbox rows go through `ap_notify` as
    before.
- **Tests (new):**
  - the submitter is refused at each of the 4 entry points, admin included;
  - a routed peer equal to the submitter → immediate escalation;
  - the empty-recipient refusal still pages;
  - a team decision mail goes To the accountant, CC the submitter and the roster;
  - the hold notice goes To the submitter, CC the accountant;
  - in pilot, team mail reroutes to admins.

### Phase 4 — UI (~1 day)

- Site dashboard tile (gated like `reimbursementTileLive`, `src/app/dashboard/[site]/page.tsx:83`).
- `/dashboard/[site]/ap-submit`: form plus "My submissions" list. It must work at phone
  width with camera capture (`accept="application/pdf,image/*" capture`).
- AP queue (`ApQueueClient.tsx`):
  - a "Team submission · <submitter> (<site>) → <accountant>" chip;
  - the submitter's typed vendor, amount and invoice number shown as reference;
  - the decide/hold panel replaced, for the submitter, by the D5 sentence.
- `/admin/ap/history`: filter by channel.
- **Verification:** Playwright at 390 / 768 / 1440 px **by eye** on the live URL after
  deploy (`feedback_ui_visual_verification`). Review stays desktop (ADR-0046 Am.6). Only
  the submit page is mobile.

### Phase 5 — Pilot and flip (~0.5 day, plus Bill)

1. Deploy. Verify the live container contains the merged SHA (`docker exec`, not the
   git HEAD).
2. As admin, in pilot, submit a test invoice at Woodland with a test accountant
   contact. Confirm:
   - the row shape;
   - an approver sees it with the chip;
   - Bill, as submitter, is refused at the panel and by a direct POST;
   - the decision mail lands in the admin pilot reroute with the would-have-sent header
     naming the accountant.
3. Ryan reconciles the ADR-0141 deliverables (DELIVERED / PARTIAL / NOT STARTED).
4. Bill flips `ap_team_submit` and `ap_team_outcome` live per site from
   `/admin/rollout`. Record the flip in CHANGELOG.

## 4. What does NOT change (pinned by tests)

- The mailbox poll, sender policy, quarantine and follow-ups.
- The approver roster and expiry reaper, and `ap_notify`.
- The Approve panel fields, the variance gate, and the $1,000 rule and routing table.
- The duplicate guard, stamp and PDF, and the decision mail for mailbox rows.
- The morning digest's sections and suppression rule. Team rows appear in it naturally
  as `pending` / `pending_second_approval` rows.
- The baseline rebuild. A team approval feeds `recordVisionApproval` like any approval.
- Desktop-only review.

## 5. Risks

| Risk                                                                                | Likelihood                                   | Impact                                       | Mitigation                                                                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| The same invoice arrives by both channels                                           | Medium (vendors often email the site and AP) | Double payment in GP                         | The ADR-0136 guard. The composed subject always carries the invoice number. The chip makes the channel visible.                        |
| Accounting list empty or stale                                                      | Low                                          | Submissions refused                          | Refuse plus page. Admin CRUD. The snapshot email means a later edit can't misroute a decided invoice.                                  |
| Submitter-exclusion drift between the write path and the panel (the ADR-0134 class) | Medium without care                          | A wrong button shown or hidden               | One `assertNotSubmitter` / `isSubmitter` function is used by write, detail route and badge count, with a test that asserts they agree. |
| Mailbox SoD gap persists                                                            | Exists today (1/227)                         | Self-approval of a manager-forwarded invoice | Recorded as residual in ADR-0141. A follow-up is possible if Bill wants it, but it changes the existing path.                          |
