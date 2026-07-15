# AP vendor-invoice approvals (ADR-0046)

Vision polls a dedicated shared mailbox, turns each valid accounting email into an
approval request, lets the approver roster approve or reject inside Vision
(first-action-wins), and emails the decision back to accounting for Mary's Great
Plains filing.

> **PRODUCTION STATUS — LIVE since 2026-07-15 at BOTH sites** (operator order
> after the same-day validation pass; ADR-0046 validation record, PRs #98–#103).
> Live transport (`mode=graph`, mailbox `approvals-dr3@svdp.us`), `ap_notify`
> flipped live for Eugene + Woodland. Real routing: new-invoice alerts → the
> active approver roster (Morena, Rick, Janette, Kelsey — Kelsey auto-expires
> 8/1); decision mail → the original forwarder with Mary
> (`mary.scott@svdp.us`) CC'd; the decision email carries the ACTUAL invoice
> stamped on every page, archived to R2. Access: the **AP Approvals tile** on
> `/` (admins + active roster; live pending-count badge) → `/dashboard/ops/ap`
> (dark-space theme, inline PDF/image attachment previews).
> **ROLLBACK:** flip `ap_notify` back to `pilot` for either/both sites on
> `/admin/rollout` — all AP mail instantly reroutes to admins with the
> `[PILOT]` banner. One audited action; no deploy.

---

## 1. IT prerequisites checklist (C7) — ALL DELIVERED (record)

Completed 2026-07-09 (IT permissions execution, PR #86) + 2026-07-14 (the
`dr3-vision@svdp.us` mailbox was added to the RAOP scoping group after the
policy broke the report sender — see `docs/OPEN-ITEMS.md` Done/O-0). The
`Processed` folder no longer needs manual creation — the transport resolves it
by name and **creates it if absent** (PR #98). Kept for the record:

- [ ] **Shared mailbox** `approvals-dr3@svdp.us` created. Accounting's one-time
      change is the To: address they compose to.
- [ ] Inside that mailbox, a **`Processed` folder** created (Vision moves ingested
      messages there so the inbox stays clean and re-polls can't double-ingest).
- [ ] **Entra app registration** for Vision's mail transport (can be the existing
      DR3-Vision app or a new one) with an **application** permission
      **`Mail.ReadWrite`** (needed for the move-to-Processed step).
- [ ] **Tenant-admin consent** granted for that application permission.
- [ ] **ApplicationAccessPolicy** scoping the app's mailbox access to
      **`approvals-dr3@svdp.us` ONLY**. Org-wide mailbox read is unacceptable.
- [ ] A **client secret** minted for the app.

Mary's Monday call also confirms: the decision-recipient address (Mary's GP
filing inbox) and whether the sender allowlist stays tenant-wide (default) or
tightens to an explicit list.

---

## 2. Provision the secrets (CHAD-HQ)

Create `~/.dr3-vision-secrets/msgraph-mail.env` (chmod 600):

```
MSGRAPH_MAIL_TENANT_ID=<tenant id>
MSGRAPH_MAIL_CLIENT_ID=<app client id>
MSGRAPH_MAIL_SECRET=<client secret>
MSGRAPH_MAIL_MAILBOX=approvals-dr3@svdp.us
# optional:
# MSGRAPH_MAIL_PROCESSED_FOLDER=Processed
# AP_QUARANTINE_EMAIL=bill@barnardhq.com
```

This file is read by the **`app`** service (the poll route + transport run inside
the app). It is OPTIONAL / fail-open: absent → the transport selects the MOCK.

Confirm mode after a deploy:

```
docker logs dr3-vision-app 2>&1 | grep msgraph-mail   # "LIVE transport selected" vs "MOCK transport selected"
```

or read the latest `ap_poll_runs.transport_mode` (`mock` | `graph`).

---

## 3. Configure the decision recipients (REQUIRED before go-live)

The decision email goes to a **fixed** recipient list — never the inbound
Reply-To. It is seeded **EMPTY**: with zero active recipients a decision still
records, but **refuses to email** and fires a `dr3-vision-system` page
(`ap-decision-recipients-empty`). Add Mary's address after the Monday call:

```sql
INSERT INTO ap_decision_recipients (id, email, active, created_at, updated_at)
VALUES (gen_random_uuid()::text, 'mary@svdp.us', true, now(), now());
```

To re-send a decision that was recorded while the list was empty: open the
request in the AP queue and click **Re-send decision email**.

---

## 4. Approvers (the "approver set as data")

The AP queue is an **org-level** surface (AP requests are accounting records, not
site-scoped): it is reachable by **admins** and **all_sites managers**. Provision
Morena and Janette as all_sites managers (the existing admin affordance / a DB
update) to make them the approver set. New-request notifications go to this same
set (active admin/all_sites users with an email).

---

## 5. Sender validation mode (default vs tightened)

`ap_sender_config.mode` defaults to `tenant_wide`: any authenticated `@svdp.us`
internal sender creates an approvable request (matches today's trust model — a
human still reviews before any decision). To tighten to an explicit allowlist
(admin toggle, never a code change):

```sql
UPDATE ap_sender_config SET mode = 'explicit_list', updated_at = now() WHERE id = 'singleton';
INSERT INTO ap_sender_entries (id, address, active, created_at, updated_at)
VALUES (gen_random_uuid()::text, 'morena@svdp.us', true, now(), now());
```

(If no `ap_sender_config` row exists yet, the mode defaults to `tenant_wide`.)

---

## 6. Enable the poll daemon

The `ap-poll` compose service is **profile-gated** (`profiles: [ap]`). ENABLED
in production since 2026-07-09, and made durable on 2026-07-10:
**`COMPOSE_PROFILES=ap` is baked into CHAD's `~/DR3-Vision/.env`**, so every
deployer `up -d` carries the profile — without that line, each deploy strands
`ap-poll` on the previous image (the 2026-07-10 stale-image incident). Manual
(re-)enable if ever needed:

```
docker compose --env-file .env --profile ap up -d
```

Then add `ap-poll` to the noc-master service-registry `containers[]` so NOC
watches it. The daemon POSTs `/api/internal/ap/poll` every 10 minutes; the app
does all the work (delta → ingest → move → ledger → deadman).

---

## 7. Quarantine handling

External senders and unprocessable messages are **quarantined, never dropped** —
they land as `status=quarantined` requests (admin-only, unapprovable) in the AP
queue and fire a `dr3-vision-system` page carrying **row id + sender domain
ONLY** (no body, attachment names, or amounts — ADR-0045). Review them in the
queue's **quarantined** tab. There is no "approve" for a quarantined item by
design; if a legitimate sender was quarantined, fix the sender config and have
them re-send.

---

## 8. Observability

- **Ledger:** `ap_poll_runs` — one row per poll (ALWAYS, incl. failures), with
  `status` (`ok`/`auth_failed`/`error`), `transport_mode`, and counts.
- **Deadman:** no successful poll in > 45 min (while enabled) pages
  `dr3-vision-system` (`ap-poll-deadman`).
- **Run failures:** auth/error pages fire `ap-poll-auth_failed` / `ap-poll-error`.
- A green run that read nothing while mail exists is impossible by construction
  (delta contract + ledger counts).

---

## 9. Security posture (recap)

- Auth is on the envelope sender, never the display name; for forwards the
  internal forwarder is the auth subject (the vendor address in the body is
  context only).
- Email can only CREATE requests — a decision requires an authenticated Vision
  session over the stored record.
- Email HTML is sanitized at ingest and rendered inside a sandboxed iframe.
- Attachments (which may carry bank details) live in R2 under `ap/` only; logs
  and notifications carry row ids + sender domain, never amounts/vendor/bank data.
- Decision replies go only to the fixed configured addresses, never the inbound
  Reply-To.

## 2026-07-08 expansion (ADR-0046 §3 amendment)

**Scope:** the mailbox now covers ALL Woodland + Eugene invoices (both sites), not
just DR3 vendor invoices.

**Approver roster (5, explicit):** Morena, Rick, Janette, Bill, Kelsey (until 8/1).
Approvers live in the `ap_approvers` table (seeded for Morena/Rick/Janette/Kelsey).
Bill is an admin and can always act, so he needs no row. All approvers see all
pending invoices; first action wins.

- **Rick and Janette are single-site managers** but are full AP approvers here —
  the AP queue/decide permission is now "admin OR active `ap_approvers` member",
  not `all_sites`.
- **Kelsey auto-removes 8/1.** Her `ap_approvers` row carries
  `active_until = 2026-08-01 00:00 PT`. A daily `ap-approver-expiry` cron removes
  expired approvers with an audit row + a `dr3-vision-system` ntfy to Bill. To add
  or remove an approver by hand, insert/delete an `ap_approvers` row (by `user_id`).

**Site tag — REQUIRED (operator directive 2026-07-15):** at approve/reject
time the approver MUST tag the request Eugene or Woodland (a dropdown; the
Approve/Reject buttons refuse until one is picked, and the server refuses an
untagged decision even by direct API call). Accounting files each invoice
against a site in Great Plains. Intake stays untagged; the tag is set at
decision. Requests decided before 2026-07-15 may carry no site (historical,
not backfilled).

**Decision routing:** the decision email now goes to the **original internal SVdP
forwarder** (the intake message's From, already validated `@svdp.us` at intake),
carrying a **stamped PDF** of the approved item ("Approved by [Name] on [Timestamp
PT] via DR3-Vision" — a visible stamp, no cryptographic signature). The stamped
PDF's sha256 is recorded on the request + in the audit log as a tamper record. The
whole decision mail still routes through the `ap_notify` rollout surface — in pilot
it reroutes to admins.

**Note on the stamp (updated 2026-07-15, ADR-0046 Amendment 4 + notes):** the
no-PDF-library constraint was REVERSED by operator directive — `pdf-lib` now
overlays the stamp directly onto **every page of the ORIGINAL document**
(decision + approver + site tag + Pacific time + the approver's note,
wrapped to at most 3 lines on the stamp band — the full note is always in the
email body), for BOTH approved and rejected. **Attachment-first precedence:** real file attachments are the
artifacts (each one stamped; filenames de-duped; tiny inline logo/signature
images under 50 KB filtered out); the rendered body is only the fallback for
body-only invoices. Image attachments stamp via the Playwright overlay path.
Every stamped artifact is archived to R2 (`ap/<request>/decision/…`) with a
dual sha256 tamper record (original + stamped) on the row and audit log. The
decision email SUBJECT carries the decision, site tag, and original subject —
Mary's GP matching keys — and the body carries only the human-facing facts.

## 2026-07-09 go-live features (ADR-0046 Amendment 3)

Operator-directed, ahead of AP going LIVE ~2026-07-11.

### New-invoice notification to all approvers

Every new invoice fires ONE email (per request, not per poll) to **all active
approvers** (the `ap_approvers` roster, excluding anyone past `active_until`). The
email carries the requester, subject, received-at (Pacific), attachment count, and a
**direct link to that specific request** in the queue. It routes through the
`ap_notify` rollout surface — in **pilot** it reroutes to admins with a
"would-have-sent" header; it reaches the real approvers only once you flip
`ap_notify` **live** (see the go-live runbook below).

### Approval / rejection notes

The decision panel has a **Note** field. A note is **optional to approve** but
**required to reject** (a rejection must say why — the Reject button is disabled
until a note is entered, and the server rejects a note-less rejection). The note
appears in the decision email to accounting, **on the stamped invoice itself**
(drawn into the stamp band on every page of the returned PDF — since 2026-07-15;
before that only the Playwright-rendered stamps carried it), and in the audit
trail. Approvers: write the note for accounting's eyes — it is on the document
they file.

### Hold — "pending review"

An approver who is not ready to decide can place a pending invoice **on hold** with a
**required hold note**. Effects:

- Accounting (the original forwarder) is **emailed that it is being held** — who
  holds it, the note, and that a final decision will follow.
- The queue shows a distinct **amber "ON HOLD" chip**; the holder and hold note are
  visible to all approvers on the request.
- From hold, **any approver** can still Approve or Reject (first action wins), or
  **Update hold note**.
- Every transition (place hold, update note, final decision) is audited.

There is no per-invoice "stale/aging" alert today; if one is added later it must
exclude on-hold (`pending_review`) items, which are being actively worked.

### Go-live flip runbook — EXECUTED 2026-07-15 (kept as the rollback/reference procedure)

1. **Secrets** — provision `~/.dr3-vision-secrets/msgraph-mail.env` on CHAD-HQ (§2)
   once SVdP IT delivers the mailbox + Graph app + consent + ApplicationAccessPolicy.
2. **Decision recipients** — insert Mary's GP filing address into
   `ap_decision_recipients` (§3). Without it, decisions record but refuse to mail and
   page `ap-decision-recipients-empty`.
3. **Enable the poll daemon** — `docker compose --profile ap up -d` (§6); add
   `ap-poll` to the noc-master service registry.
4. **Flip `ap_notify` live** — from `/admin/rollout`, ramp the `ap_notify` surface
   from pilot to **live for BOTH sites** (an org-wide surface stays pilot until every
   per-site row is live). Until then all AP mail (new-request, hold notice, decision)
   goes to admins only.
5. **Verify the first real cycle** — confirm `ap_poll_runs.transport_mode='graph'`,
   a real invoice creates a request, all active approvers receive the new-request
   email, a hold notice reaches the forwarder, and a decision email + stamped PDF
   reach the forwarder (Mary CC'd).

