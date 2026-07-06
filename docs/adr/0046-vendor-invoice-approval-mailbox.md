# ADR-0046 — Vendor-invoice approval via Graph mailbox ingestion (first inbound-email transport)

**Status:** PROPOSED — awaiting operator review (Bill)
**Date:** 2026-07-06
**Relates to:** mission record §2.1 hybrid (Morena AND Janette, first action wins — locked); **Addendum C** (`docs/handoffs/2026-07-06-adr-0036-addendum-c-…`) — C1–C8 architecture + C9 locked D-items + C10 heterogeneous-input/sanitization (non-negotiable); ADR-0028/0041 (atomic approval machinery), ADR-0038 (poll-ledger/loud-failure pattern), ADR-0045 (PII log discipline)
**Series:** post-P5; fills the last locked mission function

## Context

Accounting keeps composing ordinary emails — their one-time change is the To:
address (**`approvals-dr3@svdp.us`**, C9-D1). Vision polls the shared mailbox by
Graph delta, turns valid messages into approval requests, Morena/Janette decide
inside Vision (first action wins, atomic), and Vision mails the decision back for
Mary's Great Plains filing. **External gate (C7):** the mailbox + Graph app
registration + tenant-admin consent + ApplicationAccessPolicy are in flight with
SVdP IT — so this build runs complete against a **mock transport** and flips to
live credentials with configuration only.

## Decisions

### D1 — Generic Graph-mail transport: `src/lib/msgraph-mail/` (C2)

A reusable inbound-mail capability, deliberately NOT scoped to AP (Morena's
parked dispatch↔Outlook ask consumes it later):

- `transport.ts` — the interface: `listDelta(folder)`, `getMessage(id)`,
  `listAttachments(id)`, `moveMessage(id, folder)`, typed
  `AuthFailedError`/`GraphContractDriftError`. TWO implementations:
  `graphTransport` (client-credentials via env
  `MSGRAPH_MAIL_{TENANT_ID,CLIENT_ID,SECRET,MAILBOX}` from
  `~/.dr3-vision-secrets/msgraph-mail.env`, `Mail.ReadWrite` per C9-D6) and
  `mockTransport` (fixture-driven, the DEFAULT until creds land — selected by
  env presence, logged loudly at startup which one is active).
- Delta-token persistence per mailbox+folder (survives restarts; a lost token
  degrades to full-folder resync, idempotency absorbs it).
- The transport NEVER sends — outbound stays `sendSystemEmail` from
  `dr3-vision@svdp.us` (C2); no Graph send permission exists.

### D2 — Schema

```
ap_requests(id, status enum(pending, approved, rejected, quarantined),
    internet_message_id UNIQUE, conversation_id, received_at, sender_address,
    sender_validated Boolean, subject, body_html_sanitized, body_text,
    vendor String?, amount_cents Int?,           -- optional, at decision (C9-D5)
    decided_by?, decided_at?, decision_note?, decision_mail_sent_at?,
    quarantine_reason?, …audit)
ap_attachments(id, request_id FK, kind enum(file, nested_message, reference_link),
    filename?, storage_key?, link_url?, nested_subject?, byte_size?, …)
ap_followups(id, request_id FK, internet_message_id UNIQUE, received_at,
    sender_address, body_text, …)               -- same-conversation while open (C4)
ap_senders(id, mode-row or entries: see below, …audit)
ap_poll_runs(…mymrc_sync_runs shape: status ok|auth_failed|error, counts,
    run_id, ALWAYS written)
```

`ap_senders` implements C9-D2: a single config row holds
`mode enum(tenant_wide, explicit_list)` (**default `tenant_wide`** — any
authenticated `@svdp.us` internal sender is approvable; tightening to the
explicit list is an admin toggle, never code) plus optional explicit entries
used when mode=explicit_list. Quarantine ring therefore covers **external
senders + unprocessable messages only**.

### D3 — Pipeline (C4 + C10, v1 deliberately modest)

Poll (10 min, C9-D3) → delta list → per message, exactly ONE terminal state:
1. **Sender validation** on the authenticated envelope sender (never display
   name; for forwards the internal FORWARDER is the auth subject — the vendor
   address inside the body is display context only, C10.4).
2. **Persist**: full body HTML + text. **Body HTML is sanitized server-side at
   ingest** (allowlist-based `sanitize-html`; stored as
   `body_html_sanitized` — raw HTML is never stored for render and never
   executes in the app origin; the queue renders the sanitized HTML inside a
   sandboxed container as belt-and-suspenders). **Regression test: a
   script/onerror/iframe-bearing fixture renders inert** (C10.2,
   non-negotiable).
3. **Attachments per the full Graph taxonomy** (C10.3): `fileAttachment` → R2
   `ap/` (private); `itemAttachment` → unwrap ONE level (subject/body/files),
   deeper nesting stored as-is with a visible "nested message" marker;
   `referenceAttachment` → link recorded for the approver, **never fetched**.
   No attachment = body-only request, fully approvable (C10.1).
4. **Request creation** idempotent on `internetMessageId` UNIQUE;
   same-`conversationId` while a request is open → `ap_followups`, never a
   second request.
5. **Move to Processed folder** (C9-D6) — the mailbox itself stays clean and
   re-polls can't double-ingest even if the DB row and the move race (the
   UNIQUE key is the true guard; the move is hygiene).
6. **Quarantine, never silent-drop** (C3): external sender or parse failure →
   `status=quarantined` (admin-only, unapprovable) + email to Bill via
   `sendSystemEmail` carrying row id + sender DOMAIN only (C9-D4 — no body
   content, no attachment names) + `dr3-vision-system` page, fingerprinted.

### D4 — Approval + return path (C5)

- Queue `/dashboard/ops/ap` (Morena/Janette = approver set as data; admin can
  act; all_sites reach applies): pending list, request view (sanitized body +
  attachments from R2 + reference links + follow-ups), approve/reject with
  optional note + optional vendor/amount (C9-D5).
- **First action wins, atomically**: conditional `updateMany({where: {id,
  status:'pending'}})` count check; the loser gets "already decided by {actor}
  at {time}"; **both attempts audited** (ADR-0028/0041 machinery).
- New-request notification to both approvers via `sendSystemEmail`; the
  ADR-0043 digest gains a pending-AP count line (implementer's-call item —
  taking it: one line, same recipients).
- **Decision email to accounting goes to a FIXED configured address list**
  (config row, seeded with Mary's address post-Monday-call) — **never the
  inbound Reply-To** (C3.3). Carries request id, original subject, decision,
  approver, timestamp, note — Mary's GP matching key under any input shape
  (C10.5).

### D5 — Daemon + ops wiring (house pattern, every lesson applied)

Thin cron `scripts/ap-poll-cron.mjs` (10-min tick) → internal route
`/api/internal/ap/poll` (loopback guard + bearer) + **`/api/internal/ap/` in
`public-paths.ts` + regression-test case** (the standing ADR-0036 lesson).
Profile-gated compose service `ap-poll` (like `mymrc`) — enabling is an
operator action once IT delivers. Poll-run ledger row ALWAYS written;
**deadman** (no successful poll > 45 min while enabled) pages
`dr3-vision-system`; a green run that read nothing while mail exists is
impossible by construction (delta contract + ledger counts, ADR-0038 lesson).

### D6 — Security summary (C3, restated as invariants)

Auth on envelope, never display name · quarantine never-drop · replies only to
fixed config addresses · email can only CREATE requests — decisions require an
authenticated Vision session over the stored record · sanitized-at-ingest HTML,
inert-fixture regression test · attachments/PII in R2 only; logs and
notifications carry row ids + sender domain, never amounts/vendor/bank data.
Residual risk (accepted in Addendum C): fake-invoice social engineering,
identical to today's email workflow — now with provenance and an audit trail.

## Mock-first build plan (C7)

Everything above builds and fully tests against `mockTransport` fixtures
(constructed per the C10 taxonomy: PDF attachment, bare forward, nested
forward, reference link, external sender, script-bearing body). Flipping live =
IT delivers mailbox + consent + AAP → operator drops
`msgraph-mail.env` + enables the `ap-poll` profile. Zero code between mock and
live; the transport self-reports its mode at startup and in every poll-ledger
row.

## Out of scope

Dispatch↔Outlook (consumes this transport later, own decision) · PDF content
parsing/OCR (v1 reads by human) · Graph change subscriptions (polling locked,
C2) · any Graph send · GP write-back (Mary files manually per C5).

## Test plan (summary)

Transport contract tests against fixtures (delta paging, token loss → resync,
auth-fail, drift) · sanitization inert-fixture (script/onerror/iframe/style-url)
· taxonomy matrix (file/nested-one-level/deeper/reference/none) · sender modes
(tenant_wide internal/external; explicit_list hit/miss; forwarder-not-vendor
auth) · idempotency (re-poll, move-race, duplicate internetMessageId) ·
follow-up threading vs new request · first-action-wins race (conditional-update
count; both audited) · quarantine notification content (row id + domain ONLY —
log/PII-absence assertions) · decision-mail contract (fixed recipients, GP
matching fields) · deadman + ledger-always-written incl. throw paths · migration
clean-replay (CI).
