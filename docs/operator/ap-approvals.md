# AP vendor-invoice approvals (ADR-0046)

Vision polls a dedicated shared mailbox, turns each valid accounting email into an
approval request, lets Morena/Janette approve or reject inside Vision
(first-action-wins), and emails the decision back to accounting for Mary's Great
Plains filing.

**This build ships complete against a MOCK transport.** Until SVdP IT delivers
the mailbox + Graph app, Vision processes fixtures and self-reports `mode=mock` in
every poll-run ledger row. Flipping to live is **configuration only** — no code
change.

---

## 1. IT prerequisites checklist (C7 — the calendar-days risk, not code)

Bill raises these with SVdP IT (start Monday 2026-07-06):

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

The `ap-poll` compose service is **profile-gated** (`profiles: [ap]`) — it is NOT
started by `docker compose up -d` or the deployer. Once IT delivers and the
secrets + recipients are in place:

```
docker compose --profile ap up -d
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

**Optional site tag:** at approve/reject time an approver may tag the request
Eugene / Woodland / blank (a dropdown). Intake stays untagged.

**Decision routing:** the decision email now goes to the **original internal SVdP
forwarder** (the intake message's From, already validated `@svdp.us` at intake),
carrying a **stamped PDF** of the approved item ("Approved by [Name] on [Timestamp
PT] via DR3-Vision" — a visible stamp, no cryptographic signature). The stamped
PDF's sha256 is recorded on the request + in the audit log as a tamper record. The
whole decision mail still routes through the `ap_notify` rollout surface — in pilot
it reroutes to admins.

**Note on the stamp:** because the repo has no PDF-editing library (and none may be
added), the stamp is produced with the same Playwright→PDF mechanism as the bonus
PDFs. A body-only invoice is rendered to a stamped PDF; a PDF attachment gets a
stamped approval page carrying the original's filename + hash, sent alongside the
original.

