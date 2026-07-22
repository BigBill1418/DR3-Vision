# ADR-0046 — Vendor-invoice approval via Graph mailbox ingestion (first inbound-email transport)

**Status:** Accepted (2026-07-06, approved by Bill) — **LIVE in production 2026-07-15, both sites** (validation record + go-live at the bottom of this file)
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

## Post-acceptance implementation notes (2026-07-06)

Built end-to-end against the mock transport; migration `20260712_ap_approvals`
clean-replays on empty PG16 (28 migrations) with zero AP drift. Decisions taken
during implementation, and where they refine the ADR:

- **Thin daemon, transport in the app (reconciled).** Per D5 the daemon is a thin
  10-min scheduler that POSTs `/api/internal/ap/poll`; the Graph transport +
  sanitize + persist run INSIDE the Next app (`runApPoll`). So the
  `msgraph-mail.env` creds are mounted on the **`app`** service (where the
  transport executes). The profile-gated `ap-poll` service also carries the file
  (`required:false`, for parity/forward-compat) but does not consume it.
- **`ap_senders` realized as two tables.** The D2 "single config row + optional
  entries" is `ap_sender_config` (singleton, holds `mode`) + `ap_sender_entries`
  (the explicit allowlist). A missing config row defaults to `tenant_wide`.
- **Decision-recipient config = `ap_decision_recipients`** (reuse of the
  `alert_recipients` pattern rather than an `ap_config` singleton, per D2's "small
  row OR reuse pattern"). Seeded EMPTY; a decision with zero active recipients
  records the state change but refuses to mail and pages
  `ap-decision-recipients-empty` (never silent).
- **Delta-token persistence = `ap_delta_tokens`** (per mailbox+folder). Tokens are
  stored opaque (the full `@odata.deltaLink` URL for the live transport).
- **Approver set as data = org reach.** AP requests are org-level (no `site_id`);
  the queue + "act" permission use `requireOrgReach` (admin OR all_sites), so
  Morena/Janette are the approver set by being all_sites managers (operator
  action; see the operator doc). No new `User` column was needed.
- **Digest line rides, does not trigger.** The ADR-0043 digest gains an org-wide
  pending-AP count line, but AP alone does NOT trigger a digest send (the existing
  findings/tasks gate is unchanged); a count shown in both sites' digests is
  harmless (unlike task rows).
- **Move keeps the mock id stable.** In the live transport Graph re-issues the id
  on move; the pipeline does all per-message work (attachments, persist) BEFORE
  the move and the `internet_message_id` UNIQUE key is the true idempotency guard,
  so this is immaterial.
- **`listDelta` takes the persisted token.** The transport signature adds a
  `deltaToken` parameter to `listDelta` (returns the new token) so the DB-backed
  `ap_delta_tokens` store loads/saves it — the functional shape of "delta-token
  persistence per mailbox+folder" from D1.

## §3 amendment — AP mailbox expansion (planning rollup 2026-07-08 §1.6)

Significant scope expansion. The mock-first architecture (C1–C10) is unchanged;
these amend §C1/§C5/§C10.

- **§C1 scope:** from "DR3 vendor invoices" to **ALL Woodland + Eugene invoices**
  (one mailbox, both sites).
- **§C5 approver roster — 2 → 5, now EXPLICIT.** The original build resolved
  approvers implicitly as "active users with org reach (admin OR all_sites)". This
  amendment introduces an explicit `ap_approvers` roster (bare `user_id` FK,
  `active_until TIMESTAMPTZ?`) so single-site managers (Rick = Eugene, Janette =
  Woodland) are approvers who see **all** invoices without granting them
  `all_sites`. Roster: Morena, Rick, Janette, Bill, Kelsey. **Admins can always
  act** (checked separately), so Bill needs no row. Approver resolution excludes
  rows whose `active_until <= now()`. The AP queue/decide/attachment/resend routes
  move from `requireOrgReach` to `requireApApprover` (admin OR active approver).
- **§C5 Kelsey auto-removal 8/8.** Kelsey's `ap_approvers` row carries
  `active_until = 2026-08-08 00:00 PT`. A daily `ap-approver-expiry` cron
  (00:05 PT → `/api/internal/ap/expiry` → `runApApproverExpiry`) removes expired
  approvers with an append-only audit row + a `dr3-vision-system` ntfy to Bill (a
  system event, Bill-only, allowed).
- **§C5 all-approvers-see-all + first-action-wins.** AP requests stay org-level (no
  per-request site filter); all approvers see all pending. First-action-wins (the
  conditional `updateMany` from D4) is unchanged — verified + locked in with a test.
- **§C5 OPTIONAL site tag at decision.** `ap_requests` gains nullable `site_id`, set
  via a dropdown (Eugene/Woodland/blank) at approve/reject time. Intake stays
  untagged (incoming email doesn't know the site).
- **§C5 decision routing → original forwarder.** The decision email now routes to
  the **original internal SVdP forwarder** (the intake message's `sender_address`,
  already validated `@svdp.us` at intake per D2) instead of only the fixed
  `ap_decision_recipients` list. **D2 intake sender validation is unchanged.** The
  send still passes through `notifyStaff('ap_notify')` (born pilot ⇒ reroutes to
  admins in pilot — correct).
- **§C10 signed PDF of the approved item on the decision email.** Visible stamp
  only, NO cryptography ("Approved by [Name] on [Timestamp PT] via DR3-Vision").
  The stamped PDF's sha256 is stored on `ap_requests.decision_pdf_sha256` + in the
  audit row (tamper record) and attached to the decision mail. **Implementation
  constraint / deviation:** the repo has no PDF-manipulation library (no pdf-lib)
  and none may be added, so stamping reuses the repo's only PDF mechanism —
  Playwright HTML→PDF (as the bonus PDFs do). Body-only originals render body +
  stamp overlay → PDF; existing PDF attachments get a Playwright-rendered approval
  stamp PAGE (carrying the stamp text + the original's filename and sha256) sent
  alongside the original, rather than an in-place vector overlay. See the build
  report / code comments in `src/lib/ap/stamp.ts` for the exact behavior. §C10
  sanitization rules still apply to any rendered HTML.

## Amendment 3 — AP go-live features (operator-directed 2026-07-09)

Bill, on 2026-07-09, ahead of AP going LIVE ~2026-07-11: "make sure that all
approvers get a email notification when there are new invoices to approve and make
sure there is a section to add approval notes or reject notes — also introduce a
'pending review / hold' status that will let accounting know that it is currently
being held." Production-grade, break nothing. This amends §C5 (approver notice,
notes, lifecycle); the mock-first transport architecture (C1–C10) is unchanged.
Migration `20260716_ap_hold_and_notes` is purely additive and clean-replays on
empty PG16.

### A3.1 — New-invoice notification to ALL active approvers

The new-request notification (`notifyNewRequest`, fired on the `created` terminal
state — one email per request, never per-poll) already targeted the full
expiry-aware roster (`apApproverEmails`, which excludes any approver past
`active_until`). It is ENRICHED to carry, for a tier-1 triage email: the requester
(the internal forwarder `sender_address`), subject, received-at in **Pacific**,
attachment count, and a **tier-1 deep link** to the specific queue item
(`/dashboard/ops/ap?request=<id>` — the queue reads `?request=` on mount and opens
it). Still routed through `notifyStaff('ap_notify')` — born pilot, so in pilot it
reroutes to admins with the would-have-sent header; it reaches the real approvers
only when Bill flips `ap_notify` live from `/admin/rollout`. PII discipline holds:
subject + forwarder address are from an authenticated internal sender; no amounts,
vendor, or attachment bytes ride the email (ADR-0045).

### A3.2 — Approval / rejection notes

`ap_requests.decision_note` already existed. Enforcement is added: **a rejection
MUST carry a note** explaining why (`assertDecisionNote`, plain-English 400 at the
decide route; approvals stay note-optional). The UI requires a note before Reject
(button disabled + guard). The note already rode the decision email; it now ALSO
appears on the **stamped decision PDF** ("Note: …") and remains in the audit row.
The AP queue is a manager/approver-facing surface with plain-English strings (no
i18n today); the new strings match that existing pattern, per the standing
"manager-facing follows existing locale pattern" rule.

### A3.3 — `pending_review` (hold) status

New enum value `ApRequestStatus.pending_review` + three nullable `ap_requests`
columns (`held_by` — a bare audit-actor user id, matching `decided_by`; `held_at`;
`hold_note`).

State machine: `pending → pending_review → approved|rejected`; the direct
`pending → approved|rejected` path is unchanged. Effects:

- **(a) Accounting is told it is held.** Placing a hold requires a hold note and
  emails the **original forwarder** (same forwarder/roster-fallback routing as the
  decision email, via `notifyStaff('ap_notify')`) stating who holds it, the note,
  and that a final decision follows. Unlike the terminal decision mail, the hold
  notice does NOT page on an empty recipient set (a hold is non-terminal — a warn is
  logged; the decision mail still guards Mary's roster loudly).
- **(b) Distinct in the queue.** An **amber "ON HOLD" chip** (pending shifts to sky
  so they are unmistakable), with the holder + hold note visible to all approvers on
  the request detail (and holder/note surfaced on the list read model).
- **(c) From hold**, any approver may approve or reject (first-action-wins
  unchanged — the atomic conditional `updateMany` now matches `status IN (pending,
pending_review)`) or **update the hold note** (holder unchanged; editor audited).
- **(d) Aging/staleness.** The AP module has **no per-request staleness/aging alert
  today** (the only deadman is poll-freshness, unrelated to request age), so there is
  nothing to exclude. Recorded here: **any future AP staleness alert MUST exclude
  `pending_review`** (a held item is being actively worked, not stalled).
- **(e) Audit** row per transition (place-hold won/lost, update-note, decide-from-
  hold carries `from_hold: true`). Idempotency + concurrent-action safety reuse the
  existing first-action-wins row-level guard (a losing concurrent hold gets
  `ApAlreadyDecidedError`, attributed to the current holder/decider; both audited).

## Post-acceptance note — 2026-07-09 (outgoing AP stays OUT of scope; ADR-0051 candidate)

Mary Scott's survey (rollup §1.6): beyond typing MRC invoices she also "makes
and books the AP payment for the stewardship fees." That is an OUTGOING payment
booking — a different lane from this ADR's INCOMING vendor-invoice approval
flow (email intake → approver decision → decision mail back to accounting).
Decision: ADR-0046 deliberately stays in the incoming lane; a Mary-facing
outgoing-AP-payment surface is flagged as **ADR-0052 (candidate, not drafted)**
— renumbered from the original 0051 placeholder, since 0051 was accepted for the
office dark-theme reconciliation (see `docs/adr/0051-office-dark-theme.md`) —
rather than an expansion of this scope. Open question for Bill/Mary first:
which direction the stewardship fee actually flows (DR3 → stewardship program,
or invoiced through MRC) — the rollup marks it ambiguous.

## Amendment 4 — inline preview, body-key strip, stamp-the-original (2026-07-15, operator-directed)

**Status:** Accepted (2026-07-15, Bill — "let's do this now — functional and
robust"). Ships behind AP pilot mode (ADR-0047). Items 2/3/5 of the AP overhaul
pass (item 1 repaint = ADR-0051; item 6 tile = ADR-0020 note).

### (a) Inline attachment preview — no download round-trip

The AP queue previously presigned an R2 GET and `window.open`'d every attachment.
Approvers now **preview PDFs and images in-panel**: the attachment route
(`/api/ops/ap/[id]/attachment/[attId]`) decides inline eligibility **server-side**
off the stored `content_type` (allowlist: `application/pdf`, `image/png|jpeg|jpg|
webp`) and signs the URL with `Content-Disposition: inline`; everything else keeps
the plain download URL. The client renders images in `<img>` and PDFs in a
cross-origin `<iframe>` (deliberately **not** `sandbox=""` — a full sandbox kills
Chromium's built-in PDF viewer; the frame is cross-origin R2 and cannot script our
origin). Each attachment has a collapse/expand toggle so many attachments don't all
render at once; files over a ~15 MB cap open in a new tab instead of framing.
**CSP:** the base policy (`next.config.js`) gains
`frame-src 'self' https://*.r2.cloudflarestorage.com` — scoped to the R2 host;
`img-src` already allowed it.

### (b) Great-Plains matching keys STRIPPED from email bodies

The decision, hold-notice, and new-request emails no longer repeat the GP matching
keys (request id + original subject) as body `<li>` lines. The keys survive where
they belong: the **email SUBJECT line** carries the original subject, the **stamped
decision PDF** carries request id + subject, and the request id rides (invisibly)
the new-request deep-link URL. The bodies now read as human decision notices, not
machine records. (Test coverage updated to assert the strip + the surviving keys.)

### (c) Stamp the ORIGINAL invoice — REVERSES the §C10 no-PDF-lib constraint

The §1.6e stamp originally produced only a Playwright **cover page** for file
originals (the original was never overlaid or attached), because the repo had no
PDF-manipulation library and one was forbidden (§C10). **That constraint is
reversed here:** `pdf-lib` (pure-JS, MIT, pinned `1.17.1`) is now an approved
dependency — Playwright can only print HTML→PDF, it cannot composite a stamp onto
existing PDF vector bytes, so stamping the _actual_ original invoice required a real
PDF library. The decision path now, for **both approve and reject**:

- **PDF originals** → `stampOntoOriginalPdf` overlays a visible stamp band + a
  diagonal APPROVED/REJECTED watermark onto **every page** of the original (a true
  overlay). PDF metadata dates/producer are pinned to the decision instant so the
  tamper-record sha256 is reproducible.
- **Image originals** → embedded in a branded HTML page with the stamp overlay,
  printed to PDF via Playwright (true overlay, no image-decode dependency).
- **Multi-attachment** → each `file` attachment is stamped and attached (loop, not
  a single `.find`).
- The stamped original(s) are **attached to the decision email** and **archived to
  R2** under `ap/{requestId}/decision/…`. The row records a **dual-sha tamper
  record**: `decision_pdf_sha256` (generated stamped PDF) + `original_attachment_
sha256` (original bytes), plus `decision_pdf_r2_key`. New nullable columns land in
  migration `20260720_ap_decision_artifacts` (purely additive, ADR-0035 clean-replay).

**Fail-soft preserved (non-negotiable):** a stamp/download/R2 failure must NEVER
block the decision email to accounting. The `buildDecisionStamp(...).catch(→null)`
guard stands; R2 archival is per-artifact `.catch(→null)`; an R2-unconfigured window
degrades to the stamped cover page (the documented deviation) and the mail still
sends. Recipients (`resolveForwarderRecipients`) are unchanged — confirmed correct.

## Post-amendment note — 2026-07-15 (site tag surfaces everywhere accounting looks)

Operator directive: the Amendment-3 decision-time site tag was stored but
never displayed downstream. It now rides the decision email subject line and
body and the per-page stamp line + meta block of the stamped original.
Untagged decisions render exactly as before — the tag remains optional.

## Post-amendment note — 2026-07-15 (attachment-first precedence — the body-first defect)

Live-test defect (operator, request `c38909b2`): an approved invoice that carried
a real PDF attachment (`Hertz Invoice 599597504.PDF`) **and** a forward body came
back to accounting as a stamped **body render** — not the Hertz invoice — and
`original_attachment_sha256` was NULL (the pdf-lib overlay never ran). Root cause:
`buildDecisionStamp` gave the **body precedence** — it returned the body artifact
before ever looking at file attachments, and a forwarded invoice **always** has a
body, so the overlay path was permanently dead for the exact case Amendment 4 was
built to serve.

Fix — **attachment-first precedence**: real file attachments (`kind='file'` +
`storage_key`, passing the inline filter below) now **win**. Each is stamped and
returned; the body render is **only** the fallback for body-only invoices. When
attachments exist the mail is **docs-only** — the body render does not ride along;
the approver's decision note is already stamped onto every attachment, so no
approver-relevant context is lost, and accounting files the actual document into
Great Plains, not the forward wrapper. The caller already records the first
artifact's dual-sha and attaches every artifact, so the reorder auto-populates
`original_attachment_sha256` with **zero caller changes**. Multi-artifact mails get
filename collision de-dup (`approved-invoice.pdf`, `approved-invoice-2.pdf`).

**Inline-image filter (size heuristic, ship-now tier).** Forwards drag in
signature/logo images that must not be stamped and mailed as if they were the
invoice. There is no exact inline signal today: `normalizeFile`
(`msgraph-mail/normalize.ts`) drops Graph's `isInline`/`contentId`, so
`ap_attachments` has no inline column. Ship-now proxy: exclude `image/*` under
50 KB (a scanned/photographed invoice is virtually always >200 KB; logos/signatures
<20 KB). PDFs and non-image files are always kept regardless of size; if the filter
would drop **every** attachment, the files are kept anyway (a decision mail is never
artifact-empty when real files exist). **Durable follow-up (separate change):**
capture `isInline`+`contentId` through `normalizeFile` → `persistFile` → a new
`ap_attachments.is_inline` column and filter on that exact signal, retiring the size
heuristic.

## Validation record — 2026-07-15 (operator live-test pass: "working perfectly")

Bill ran full live test loops against the pilot-mode module on 2026-07-15 and
signed off verbatim: "ap module is working perfectly." Validated end-to-end on
request `53dc5d3c` (approved, Woodland-tagged): Graph ingest with full-body
hydration → dark-space queue reached via the new `ap-approvals` tile → inline
attachment preview → decision with site tag → decision email to the forwarder
(pilot-rerouted) carrying the ACTUAL original document stamped on every page
(decision + approver + site + PT time), R2-archived with the dual-sha tamper
record. The three defects the test runs surfaced (Processed-folder move 400,
body-first stamp precedence, invisible site tag) are all fixed and merged
(PRs #98–#101). Remaining before the live flip: O-1 in `docs/OPEN-ITEMS.md`.

## Post-go-live amendment — 2026-07-15 (site tag REQUIRED on decisions)

Operator directive (same day as go-live): "make the site tag required on
decisions." The §3-amendment site tag was optional; an untagged decision could
reach accounting without the Woodland/Eugene marker Mary files against in
Great Plains. Now enforced at all three layers:

- **Service** — `assertDecisionSite()` throws `ApSiteRequiredError` (400) at
  the top of `decideRequest`, before any read or state change (mirrors the
  Amendment-3 rejection-note boundary).
- **Route** — `/api/ops/ap/[id]/decide` resolves the id/code via
  `resolveDecisionSiteId` and refuses (400, plain-English message) when
  absent or unresolvable, before the CAS.
- **UI** — the queue's site select is labeled _required_; Approve/Reject are
  client-guarded with "Select the site (Woodland or Eugene) before deciding."

`ap_requests.site_id` therefore becomes always-populated for rows decided
after this ships; rows decided earlier may still carry NULL (historical, not
backfilled). This closes O-9(a) in `docs/OPEN-ITEMS.md`.

## Post-go-live amendment — 2026-07-15 (approver note displays on the returned invoice)

Operator directive: the decision **note must display on the output invoice**
accounting receives back. The note already rode the decision-email body and
the Playwright-rendered stamps (body-only / image originals), but the pdf-lib
overlay — the path every real PDF invoice takes — never drew it. Now the
bottom stamp band grows to carry the note (wrapped, capped at 3 lines with an
ellipsis; the full note always remains in the email body), on every page,
both decisions. The queue's Note field is labeled "appears on the returned
invoice" so approvers know the audience.

## Amendment — 2026-07-20 (third location disposition: "NOT DR3 — See Reason")

Operator directive (Bill): _"on the ap approval portal add a third option for
location 'NOT DR3 - See Reason'."_

**Problem.** Since the 2026-07-15 site-required amendment, every AP decision must
tag a real DR3 site (Woodland/Eugene). But not every invoice that lands in the AP
mailbox is _for_ a DR3 location — some are mis-addressed, sent to the wrong entity,
or are a parent-org bill. Forcing such an invoice onto a real site's books would
mis-file a real vendor bill. Approvers had no honest way to record "this is not a
DR3 invoice."

**Decision.** Add a third **location** option, `NOT DR3 – See Reason`. When chosen,
the approver must supply a **reason** (the decision note), and the decision is
recorded WITHOUT filing against a real site: `site_id` stays NULL and a new marker
column `ap_requests.filed_not_dr3` is set true.

**Location invariant.** A decided row is now EXACTLY ONE of:
- **site-filed** — `site_id` NOT NULL, `filed_not_dr3 = false` (Woodland/Eugene), or
- **NOT DR3** — `filed_not_dr3 = true`, `site_id` NULL (reason required).

Never both; never neither (for rows decided after this ships). Enforced in depth:

- **Schema/DB** — `filed_not_dr3 BOOLEAN NOT NULL DEFAULT false` (migration
  `20260728_ap_not_dr3_location`, purely additive, sorts after
  `20260727_adr0041_pilot_mode_gp_export`; default false backfills every existing
  row as a normal site-filed decision). A **partial CHECK** enforces the "never
  both" half (`NOT (filed_not_dr3 = true AND site_id IS NOT NULL)`); it is
  deliberately partial so historical NULL-site rows decided before the site-required
  directive remain valid.
- **Service** (`decideRequest`) — the location guard runs BEFORE any read/state
  change (mirrors the reject-note + site boundaries): `filedNotDr3` requires a
  non-empty note (else `ApNoteRequiredError`, 400) and forbids a `siteId` (else
  `ApLocationConflictError`, 400); otherwise `assertDecisionSite` still requires a
  site exactly as before. Persistence writes `filed_not_dr3 = true, site_id = NULL`
  for NOT-DR3; the winning audit row records `filed_not_dr3`.
- **Route** (`/api/ops/ap/[id]/decide`) — accepts `notDr3?: boolean`. `notDr3 &&
  siteId` → 400 (mutual exclusion, never silently pick one); `notDr3` without a
  non-empty note → 400; NOT-DR3 calls `decideRequest({ filedNotDr3: true })` and
  does NOT resolve/assert a site. The existing site path is unchanged.
- **UI** — the location select gains `NOT DR3 – See Reason`; selecting it shows an
  inline "add the reason in the note (required)" hint, disables Approve until a note
  is present (Reject/Hold already require one), and posts `notDr3: true` instead of a
  `siteId`. The field is relabeled **Location** (Woodland / Eugene / NOT DR3).

**Accounting semantics.** So Mary never mistakes a NOT-DR3 decision for a DR3-site
invoice, the disposition is unmissable everywhere accounting looks — in the same
slot the site name occupies today:
- **Decision email** — subject reads `(approved — NOT DR3)`; the body leads with
  `NOT DR3 — see reason: <reason>` in place of the `Site:` line.
- **Stamped PDF / cover / image render** — the per-page stamp line reads
  `… via DR3-Vision — NOT DR3 (see reason)`, and the meta block shows
  `Location: NOT DR3 — see reason: <reason>` instead of a `Site:` line.

**Disposition semantics (design note).** NOT-DR3 is a **location tag orthogonal to
the approve/reject decision**, not a distinct decision type. An approver still
Approves or Rejects the invoice AND tags the location; when the location is NOT DR3
a reason is required either way. This keeps the existing approve/reject state machine
and audit trail intact. (If the operator later wants NOT-DR3 to be its own terminal
disposition — e.g. "returned to sender, not actioned" — that would be a follow-up
status, not covered here.)

## Amendment — 2026-07-21 (approvals now REQUIRE an explanatory note)

Operator directive (Bill): _"on the AP module let's not allow approval without a
note — the user needs to enter data about what the transaction was for and explain
additional context before being able to approve the invoice."_

**Problem.** Amendment 3 required a note only for **rejections** ("say why"), and the
2026-07-20 amendment required a **reason** only for the NOT-DR3 disposition. A plain
approval (Woodland/Eugene) stayed note-optional, so an approved invoice could reach
accounting with **no recorded transaction purpose** — an audit-trail gap. Accounting
(and any later reviewer) had no captured statement of what a paid invoice was for.

**Decision.** Extend the note requirement to **every** decision: an **approval** must
carry a non-empty note describing what the transaction was for + any additional
context, using the **same minimum** as the rejection path (non-empty after trim — no
min-word count). The rejection and NOT-DR3-reason rules are unchanged; a NOT-DR3
approval's required reason simply satisfies this same note.

**Rationale.** The note is the durable audit record of transaction purpose/context —
it already rides the decision email and the stamped decision PDF back to accounting.
Requiring it on approvals closes the gap where the most common decision (approve)
carried the least context.

**Enforced in depth:**

- **Service** (`assertDecisionNote`, `src/lib/ap/approvals.ts`) — now throws
  `ApNoteRequiredError` (400) for an **approval** with no/blank note as well as a
  rejection, each with a purpose-specific message. Still called at the API boundary
  BEFORE any read/state change (kept out of `decideRequest` so the pure lib
  race-tests can decide without a note). The NOT-DR3 reason guard inside
  `decideRequest` is unchanged and still fires for the NOT-DR3 path.
- **Route** (`/api/ops/ap/[id]/decide`) — unchanged flow: `assertDecisionNote` runs
  before the site is resolved or the row flipped, so an approval without a note 400s
  with no DB write. Mutual-exclusion (`notDr3 && siteId`) and the NOT-DR3 reason
  branch continue to work; the note guard now fires first when both are violated,
  still a 400 before any state change (no double-error, no bypass).
- **UI** — the approver panel disables **Approve** until a non-empty note is present
  (mirroring the existing Reject/Hold gates); the Note field is relabeled
  **(required)** and prompts for "what this transaction was for + any additional
  context". The server re-validates.

No schema change (the note already persists to `ap_requests.decision_note`). No
migration.

## Amendment 5 — Approver-side vetting friction + dual approval + variance detection + history + equipment linking (2026-07-22)

**Trigger:** Kelsey's post-live feedback on the AP module (delivered 2026-07-15, worked through with Bill 2026-07-21 → 2026-07-22). Her operating stance: performative approval is worse than no approval. This amendment installs structural friction on the Approve path so that every approval carries recorded vetting, and formalizes the second-eyes workflow that Kelsey used to perform manually.

**Scope:** Four decisions covering the approver-facing side of the module, plus one Phase-2 dependency on ADR-0057 for MyMRC cross-checking. Reject / Hold / NOT-DR3 dispositions are untouched except where explicitly noted.

### D-M5-1 — Structured decide input (replaces single freeform note)

**Approve requires four fields, all non-empty:**

| Field | Type | Notes |
|---|---|---|
| `vendor` | freeform text | Approver types the vendor name. Helper prompt above the field: *"Enter the vendor name carefully — check spelling and capitalization. This appears on the returned decision email and Mary's GP filing."* Vendor doesn't need to be pre-registered; Vision matches loosely to existing vendors via the baseline table (§D-M5-4) but accepts any text. |
| `explanation` | freeform text | Replaces today's single freeform "note". Prompt: *"What was this transaction for? Include any relevant context (site work, repair reason, event, etc.)."* Same non-empty gate as today. |
| `confirmed_amount_cents` | integer | Approver-confirmed dollar amount. Pre-filled from the auto-extraction pipeline (§D-M5-2) with a confidence badge. Approver can override. |
| `equipment_link_ids[]` | multi-select | Vehicles/equipment referenced by the invoice. Multi-select. Always shown. Approver picks one or more OR the explicit `Not equipment-related` option. Field is required with that explicit-none option available (§D-M5-6). |

**Reject / Hold / NOT-DR3** keep their existing single reason-field pattern — no vendor / explanation / amount / equipment required to reject a bogus invoice.

**Rationale:** Kelsey's example (Sunbelt Rentals mower charged to Stockton by mistake) — if the approver had to type "mower rental" and pick an equipment record from Stockton's fleet, they'd have paused at the equipment picker realizing no Stockton mower exists. The friction IS the vetting.

### D-M5-2 — Automatic amount extraction at intake (hybrid local + Claude API)

**Runs at intake** (during `runApPoll`, right after body sanitize + attachment persist), before the request appears in the AP queue. Result stored on the `ap_requests` row.

**Pipeline (hybrid, ordered):**

1. **Local text extraction** — pdf-parse on attached PDFs + heuristic scan of email body text. Regex patterns for common invoice totals: `Total(?: Due)?:?\s*\$?[\d,]+\.\d{2}`, `Amount Due:?\s*\$?[\d,]+\.\d{2}`, `Balance Due:?\s*\$?[\d,]+\.\d{2}`, `Grand Total:?\s*\$?[\d,]+\.\d{2}`. Also captures ALL candidate amounts in the document for later disambiguation.
2. **Confidence scoring:**
   - `HIGH`: exactly one distinct match on `Total`/`Amount Due`/`Balance Due`/`Grand Total`, agrees with any repeated `Total:` line
   - `MEDIUM`: single match on any pattern but multiple candidates exist in the doc; or single non-canonical pattern match
   - `LOW`: multiple `Total`-like matches disagree; or no canonical pattern found, only bare amounts extracted
   - `FAILED`: no dollar amounts extracted at all (scanned image with no OCR, empty body)
3. **Claude API fallback** — fires when local confidence is `LOW` or `FAILED`. Sends the sanitized body text + attachment text (extracted via pdf-parse; images sent as base64 up to size cap) to Claude with a structured extraction prompt: *"Extract the total invoice amount and vendor name. Return JSON with fields: amount_cents (integer), vendor (string), confidence (high|medium|low), reasoning (string)."* Uses the `anthropic` SDK via `~/.dr3-vision-secrets/anthropic.env` (new secret). Model: `claude-sonnet-4-6` for cost efficiency at DR3's invoice volume (~50-100/mo). Timeout 30s.
4. **Storage:** `ap_requests.extraction jsonb` field carries `{best_amount_cents, best_vendor, confidence: 'high'|'medium'|'low'|'failed', source: 'local'|'claude_api', candidates: [{amount_cents, source_hint}], attempted_at, model?, cost_cents?, error?}`.

**Failure mode:** if Claude API is unavailable OR local extraction fails outright, the request lands with `extraction.confidence = 'failed'` and `best_amount_cents = null`. Approver sees "Amount not extracted — please enter manually" and provides `confirmed_amount_cents` themselves. Approval still gates on all four required fields.

**Approver UX (in decide panel):**
- Best-guess amount pre-filled in the `confirmed_amount_cents` input
- Confidence badge next to the input:
  - `HIGH` → **green** ✓ badge, label *"Verified"*
  - `MEDIUM` → **yellow** ⚠ badge, label *"Please verify"*
  - `LOW` → **red** ⚠ badge, label *"Low confidence — verify against invoice"*
  - `FAILED` → no badge, input is blank, placeholder *"Enter amount from invoice"*
- Approver can always override the pre-filled value

**Cost budget:** at $0.05-0.20/invoice × ~50-100/mo (Claude API fallback path only, when local fails), total marginal cost is <$20/mo. Cost gets logged per-invoice for observability.

### D-M5-3 — $1,000 second-approval workflow

**Threshold:** `confirmed_amount_cents >= 100000` (i.e., $1,000 or more) triggers second approval.

**Applies to Approve only** — Reject / Hold / NOT-DR3 remain single-approver regardless of amount.

**Second approvers, by site tag:**
- Woodland → **Bill** (admin, always eligible)
- Eugene → **Shannon Rockwell** (must be provisioned as an active approver, may need admin role)
- NOT DR3 → **NOT APPLICABLE** — invoice returns to sender, no payment happens, no second approval needed

**State machine additions:**

Existing states: `pending | approved | rejected | quarantined` plus the informal `pending_review` (Hold — represented by columns, not a status). Adds:

```
pending_second_approval
  -- request has first approval + all four required fields
  -- awaiting second-approver decision
```

Transitions:

```
pending
  ├── Reject → rejected                                (any approver, unchanged)
  ├── Hold → pending (pending_review column set)      (any approver, unchanged)
  ├── NOT DR3 → rejected (with disposition=not_dr3)   (any approver, unchanged)
  ├── Approve with confirmed_amount < $1,000
  │     → approved                                     (any approver, single-action, unchanged)
  └── Approve with confirmed_amount >= $1,000
        → pending_second_approval                      (any approver except site's second approver)
        └── first_approver_id, first_approved_at, and all four field values stamped

pending_second_approval
  ├── Second-approver Approve → approved               (Bill for Woodland, Shannon for Eugene)
  └── Second-approver Reject → rejected                (with second_approver_note explaining override)
```

**First-approver == second-approver edge case:** if Bill (admin) is the first approver on a Woodland invoice above $1K, the second-approval step still applies but Bill can't fulfill it alone. Options considered:
- (a) Route to Shannon regardless
- (b) Route to a fallback admin (e.g., Bethany)
- (c) Allow Bill to self-fulfill with an explicit re-confirmation click

**Decision: (c)** — if first_approver_id == would-be second_approver_id, the pending_second_approval state still fires but the second-approval panel shows a re-confirmation UX ("You are both first and second approver on this invoice — please re-confirm the decision below.") with a 30-second minimum wait between clicks. Documented in the approver runbook.

**Notification:** ntfy `dr3-vision-system` fires the moment a request enters `pending_second_approval`, addressed to the site-appropriate second approver. The `ap-approvals` tile on `/` shows a distinct "awaiting 2nd approval" badge count for the second approvers. Existing `ap_notify` rollout gate still applies — in pilot, second-approval notifications reroute to admins with `[PILOT]` header.

**Decision email routing:** only fires on final `approved` state (i.e., after second approval, or after first approval for sub-$1K invoices). The stamped PDF now carries BOTH approver names + timestamps: *"Approved by [First] on [T1 PT] via DR3-Vision; second approval by [Second] on [T2 PT]"*. For sub-$1K invoices the stamp is unchanged.

**Second approver can override first approval by rejecting.** The rejection email to the original forwarder carries both the first-approver's context (vendor + explanation + amount + equipment + note) and the second-approver's rejection note explaining why it was overridden. First approver is CC'd on the rejection so they see the override.

**Existing "first-action-wins" contract** still holds for sub-$1K invoices — no behavior change for those. Above $1K, "first-vetted, second-confirmed" is the new contract.

### D-M5-4 — Vendor baseline + variance detection

**Baseline source: Bill-uploaded PDF AP report** (from GP or an equivalent history dump), one per site or combined. Uploaded via `/admin/file-drop` (existing surface). New parser + admin surface at `/admin/ap/baselines/import`:

1. Admin selects the uploaded PDF from file-drop
2. Vision runs pdf-parse tabular extraction + Claude API fallback on the whole document to normalize into rows: `{vendor_name, invoice_date, invoice_amount_cents, site}`
3. Preview UI shows extracted rows for admin approval before write
4. On confirm, populates `ap_vendor_baseline_history` (raw extracted rows) + rebuilds `ap_vendor_baselines` (aggregated per-vendor over trailing 12 months)

**Baseline aggregation logic:**

For each distinct `vendor_name` (normalized: trim, lowercase, collapse whitespace):
- Filter history to trailing 12 months from most recent invoice date
- Compute: `mean_amount_cents`, `median_amount_cents`, `min_amount_cents`, `max_amount_cents`, `stddev_amount_cents`, `invoice_count`
- Baseline is considered established when `invoice_count >= 3` in the window
- Vendors with fewer than 3 historical invoices are stored but NOT used for variance flagging (insufficient data)

**Variance thresholds:**
- **Global defaults:** $50 flat + 15% percentage (either trips fires the flag)
- **Per-vendor overrides:** admin can set stricter or looser bounds at `/admin/ap/baselines` (e.g., Clark Pest → $25 flat + 6.25%, matching Kelsey's example)
- **Effective logic:** flag fires when `abs(confirmed_amount - baseline_mean) > flat_threshold` OR `abs(confirmed_amount - baseline_mean) / baseline_mean > percent_threshold`. Either-trips (whichever's stricter fires first).

**Approver UX when variance fires:**

At Approve time, if the vendor matches an established baseline AND the current `confirmed_amount_cents` exceeds thresholds:

- **RED variance banner** appears above the Approve button:
  > *"⚠ VARIANCE FLAG — {vendor} usually bills ${baseline_mean:.2f} (avg from {invoice_count} invoices, last 12 months). This invoice is ${confirmed_amount:.2f}, a {variance_direction} of ${variance_abs:.2f} ({variance_pct:.1f}%). Recent history: [last 3 invoices with dates + amounts]"*
- **Approve button DISABLED** until approver clicks *"I've verified the variance"* explicit acknowledgment button
- Clicking the button:
  - Stamps `variance_acknowledged_by`, `variance_acknowledged_at`, and `variance_acknowledgment_note` (optional additional note the approver may add — e.g., "Confirmed with Morena, additional cockroach treatment this month")
  - Enables Approve button
- Variance acknowledgment is part of the audit trail and appears in the decision email + stamped PDF footer

**Below-threshold (or no baseline):** no variance banner, no acknowledgment gate. Approve flows normally.

**Baseline lifecycle:**
- Bill re-uploads AP report periodically (quarterly is a reasonable cadence) to refresh baselines with new production data
- Approved invoices in Vision (post-Amendment 5) also feed the baseline: on every `approved` state transition, insert a row into `ap_vendor_baseline_history` with `source='vision_approval'` — so baselines stay fresh even between Bill's re-uploads
- Rebuild of aggregated `ap_vendor_baselines` runs nightly (cron) OR on-demand from `/admin/ap/baselines` refresh button

### D-M5-5 — Invoice history search surface

New admin surface at `/admin/ap/history`, **scoped to admins + designated second approvers only** (Bill + Shannon in current config; the general approver roster Morena/Rick/Janette does NOT see this surface).

**Permission model:**
- New capability: `can_view_ap_history` — attached to admin role by default + granted explicitly to designated second approvers via `ap_second_approvers` config table
- Not attached to `ap_approvers` roster by default (avoids leaking historical AP data to shift operators)

**Data source:** union of `ap_requests` (Vision-recorded invoices) + `ap_vendor_baseline_history` (Bill-uploaded historical AP data). Distinguished by `source` column.

**Filters:**
- Vendor (typeahead search against unique vendor names from both sources)
- Date range
- Amount range (min/max)
- Site (Woodland / Eugene / NOT DR3)
- Approver (from `ap_requests` only)
- Source (Vision-approved / historical import)

**Row detail:** clicking a row opens a modal showing:
- All fields (vendor, amount, site, date, source)
- If Vision-approved: full decision context (approvers, notes, equipment links, stamped PDF link)
- If historical import: raw imported values

**Use cases (validated with Bill):**
- Second approver reviewing a $1K+ invoice can check the vendor's history before confirming
- Audit response to any board or Bethany question
- Rate renegotiation prep (vendor Y's charges over 24 months)
- Investigation of a specific approver's decision patterns

**Not exposed:** aggregate reports, cross-vendor summaries, or dashboards — those are follow-on work if ever needed.

### D-M5-6 — Equipment / vehicle linking

**Field on every Approve** — always shown, required with explicit `Not equipment-related` option (Bill's directive: *"forces a decision every time"*).

**Data source:** existing equipment/fleet records in Vision. Consolidated view over:
- Terex maintenance records (Terex assets are already tracked; see `docs/operator/fleet-observability-setup.md` + ADR-0030 references)
- Fleet vehicles (trucks, forklifts, balers) — inventory sources TBD by implementation; likely a `fleet_assets` table or existing equipment table

Implementer confirms exact source table(s) during migration design. Amendment 5 requires:
- Consolidated `equipment_view` (materialized view or join) with columns: `id`, `site_id`, `display_name`, `category` (vehicle | forklift | baler | terex | other), `is_active`
- If existing tables don't cover all categories, add missing tables (e.g., `fleet_vehicles` if not already present)

**UI:**
- Multi-select combobox on Approve panel
- Options filtered by the currently-selected site tag (Woodland site → only Woodland-tagged equipment; Eugene → Eugene equipment)
- Search by `display_name` (typeahead)
- Explicit `Not equipment-related` option always in the list as a distinct choice (mutually exclusive with actual equipment picks)
- At least one selection required (equipment(s) OR "Not equipment-related") to Approve

**Storage:** new join table `ap_equipment_links(request_id FK, equipment_id?, is_not_equipment_related boolean)`. Distinct rows per selected equipment; single row with `is_not_equipment_related=true` for the explicit-none case.

**Missing equipment (approver picks nothing that matches):** admin has to add missing equipment via existing fleet/equipment management surface; approver cannot inline-create equipment (avoids drive-by creation of noise records). If frequent, approver Holds the invoice with a note "waiting for asset X to be added to fleet."

### D-M5-7 — Phase 2: MyMRC haul cross-check (depends on ADR-0057 Phase 1 completion)

**Trigger:** once ADR-0057 Phase 1 lands (`mymrc_hauls_mirror` populated with real data from Bill's admin credentials), Vision can auto-cross-check invoice line items against MyMRC hauls.

**Use case (Kelsey's example verbatim):** *"invoices from Pacific Trucking are for inbound loads from Eureka. I make sure these loads are recorded in MyMRC before approving them."*

**Behavior:**

At intake (part of the extraction pipeline in §D-M5-2), also extract any `H-####` haul references from the invoice body/attachments. Store in `ap_requests.extracted_haul_numbers` (text[] column).

At approve time in the UI, for each extracted haul number:
- Query `mymrc_hauls_mirror` by `external_name` (haul number)
- **GREEN indicator** if the haul is found — display "H-1234 → matches: [date] [source] [units]"
- **YELLOW indicator** if the haul is NOT found — display "H-1234 → not in MyMRC — verify with dispatch before approving"

Not a hard block — approver sees context, decides. Consistent with the amendment's overall philosophy: friction that vets, not blocks.

**Implementation gate:** cannot ship until `mymrc_hauls_mirror` has real data (i.e., after ADR-0057 Phase 1 backfill completes). Schema hook (`ap_requests.extracted_haul_numbers`) ships in Phase 1 of Amendment 5; wire-up ships in Phase 2 once the mirror is populated.

### Schema deltas (consolidated)

**`ap_requests` — new columns:**

```
vendor_freeform         text       -- D-M5-1 (replaces optional `vendor` at decide)
explanation             text       -- D-M5-1 (replaces optional `note` at decide for Approve; Reject/Hold/NOT-DR3 keep decision_note)
extraction              jsonb      -- D-M5-2 (extraction result: best_amount_cents, best_vendor, confidence, source, candidates, cost_cents, model, attempted_at, error)
confirmed_amount_cents  int        -- D-M5-1 (approver-confirmed, replaces optional `amount_cents` at decide)
extracted_haul_numbers  text[]     -- D-M5-7 (Phase 2 schema hook; Phase 1 stores nothing here)

-- Second approval state:
first_approver_id       text?      -- D-M5-3
first_approved_at       timestamp? -- D-M5-3
second_approver_id      text?      -- D-M5-3
second_approved_at      timestamp? -- D-M5-3
second_approver_note    text?      -- D-M5-3 (populated only on second-approver override/reject)

-- Variance flag state:
variance_flag_state     enum       -- 'not_applicable' | 'below_threshold' | 'above_threshold' | 'acknowledged'
variance_acknowledged_by      text?
variance_acknowledged_at      timestamp?
variance_acknowledgment_note  text?

-- Status enum extension:
status  -- add: pending_second_approval  (between pending and approved)
```

**New tables:**

```
ap_vendor_baseline_history (
  id text PK,
  vendor_name text,
  vendor_name_normalized text,      -- lowered, trimmed, whitespace-collapsed
  invoice_date date,
  invoice_amount_cents int,
  site_id text?,
  source enum('bill_upload','vision_approval'),
  imported_at timestamp,
  imported_by text?
)

ap_vendor_baselines (               -- computed, refreshed nightly + on-demand
  vendor_name_normalized text PK,
  vendor_display_name text,
  invoice_count int,
  mean_amount_cents int,
  median_amount_cents int,
  min_amount_cents int,
  max_amount_cents int,
  stddev_amount_cents int?,
  computed_at timestamp,
  variance_flat_override_cents int?,      -- admin per-vendor override
  variance_percent_override numeric?      -- admin per-vendor override
)

ap_equipment_links (
  id text PK,
  request_id text FK,
  equipment_id text FK?,                  -- nullable when is_not_equipment_related
  is_not_equipment_related bool,          -- mutually exclusive with equipment_id
  created_at timestamp
)

ap_second_approvers (
  id text PK,
  user_id text FK,
  site_id text,                           -- 'woodland' | 'eugene' (NOT DR3 has no second approver)
  active bool,
  active_from timestamp,
  active_until timestamp?,
  created_at timestamp
)
```

**Existing table adjustments:**
- `ap_requests.vendor` → deprecate; migrate any existing values to `vendor_freeform` via one-time migration
- `ap_requests.amount_cents` → deprecate; migrate to `confirmed_amount_cents`
- `ap_requests.decision_note` → keep for Reject/Hold/NOT-DR3 dispositions; Approve now uses `explanation` instead
- `equipment` (or equivalent existing table) → add `site_id` if not already present, add `is_active` if not already present

**New capabilities / config:**
- `can_view_ap_history` — admin role by default + granted via `ap_second_approvers`
- `~/.dr3-vision-secrets/anthropic.env` — API key for Claude extraction fallback
- New env var `AP_EXTRACTION_CLAUDE_MODEL` (default `claude-sonnet-4-6`)
- New env var `AP_EXTRACTION_CLAUDE_TIMEOUT_MS` (default `30000`)

### Rollout + test plan

**Phase 1 (this amendment):**
- Migration + all Amendment 5 schema changes
- Extraction pipeline (D-M5-2) with fixture tests: HIGH/MEDIUM/LOW/FAILED cases, Claude API fallback with mock, image attachment path
- Structured decide UI (D-M5-1) with tests: all-four-fields-required, equipment multi-select with explicit-none, vendor helper prompt
- Second-approval workflow (D-M5-3) with tests: state machine transitions, notification firing, first==second edge case, override rejection routing
- Variance detection (D-M5-4) with tests: baseline computation over trailing 12 months, either-trips flag logic, acknowledgment gate, per-vendor override precedence
- Baseline import surface (D-M5-4) with fixture PDF from Bill (uploaded to file-drop)
- History search surface (D-M5-5) with permission gate tests
- Equipment linking (D-M5-6) with site-filtered dropdown tests
- Amendment 5 schema hook `extracted_haul_numbers` ships (empty behavior)
- Migration clean-replay CI gate

**Phase 2 (gated on ADR-0057 completion):**
- Wire haul-number extraction in the pipeline (D-M5-2 extension)
- Wire cross-check against `mymrc_hauls_mirror` at decide time (D-M5-7)
- Fixture tests with mocked mirror data (green + yellow indicator cases)

**Rollout:**
- Phase 1 deploys to prod. `ap_notify` rollout gate still governs decision email routing.
- Approver runbook updated (`docs/operator/ap-approvals.md`)
- Bill uploads the initial AP report to file-drop; admin runs the baseline import via `/admin/ap/baselines/import`
- First real invoice under Amendment 5 flow triggers a monitored watch — Bill/Bethany verify structured decide fields render correctly, extraction produces sane confidence badges, variance flag fires appropriately, second-approval routing lands where expected

**Rollback:** revert the app image; Amendment 5 schema is additive (new columns nullable, new tables independent), so the old flow degrades to the pre-Amendment-5 behavior on the same schema. Data written under Amendment 5 (structured fields) remains visible in the DB even after rollback for post-incident forensics.

**Watch metrics:**
- Extraction confidence distribution (proportion HIGH / MEDIUM / LOW / FAILED across a week — informs when to increase Claude fallback aggressiveness)
- Second-approval hop rate (% of Approves crossing the $1K threshold)
- Variance flag fire rate (% of Approves where variance fires)
- Variance acknowledgment note fill rate (% where approver adds context vs. bare click)
- Second-approver rejection rate (signal for whether the second layer is catching real issues)

---

## Amendment 6 — AP attachment preview reliability, DESKTOP-scoped (2026-07-22)

**Status:** Accepted (2026-07-22, operator-directed). Bug-fix amendment to
Amendment 4 §(a). No schema change, no new dependency, no CSP change.

**Scope note — DESKTOP ONLY.** AP review happens on desktop: managers/admins
authenticating via Entra SSO. The floor iPads are PIN operators and are **403 on the
AP surface**, so no iPad-specific handling is introduced here. The existing desktop
inline `<iframe>` preview and the existing download/open control are kept as-is.

### Problem

Approvers reported the invoice preview as unreliable — "can't see the invoice." Two
independent defects, one proven against the live DB and one certain from the code.

**Defect 1 (PRIMARY, confirmed live) — the strict MIME gate hid the Preview button.**
Amendment 4 gated inline eligibility on an anchored `^application/pdf$` regex
(server) mirrored by a strict string equality (client). The stored `content_type` is
whatever Microsoft Graph labeled the attachment, persisted verbatim at ingest
(`normalize.ts` → `ingest.ts`) and never normalized. A live query of `ap_attachments`
found **2 of 41 file attachments are PDFs stored as `application/octet-stream`**
(both `.pdf` by filename). The anchored regex rejects those — and also rejects the
parameterized `application/pdf; name="inv.pdf"` form — so those invoices render
**no Preview button at all**, download-only. This is deterministic per-sender: any
relay that mislabels the MIME repeats it on every invoice from that vendor.

**Defect 2 (SECONDARY, certain by code) — 300 s URL lifetime + cache-forever.**
`signApAttachmentDownload` minted with `expiresIn: 300`, and the client cached the
presigned URL and never re-minted (`resolve()` returned the cache unconditionally).
The URL is minted **on expand**, not at queue render, so the *first* view is always
fresh — the hypothesis that it goes stale before first use is wrong. The real failure
is **reuse**: a reviewer who collapses "Hide preview" and re-expands >5 min later, or
who reads the invoice then clicks download/open, replays an expired URL → R2 `403` →
blank iframe / dead link. AP review is not instantaneous, so both are routine.

### Decision

Keep the presigned-inline-in-iframe architecture and harden it. Explicitly rejected:
proxying the bytes through the app (violates hard rule #7 — codified in `r2.ts` — and
would stream invoice PDFs through load-sensitive CHAD), and adding pdf.js (desktop
browsers already render inline cross-origin PDFs natively; a ~1 MB dependency with a
large regression surface buys nothing here). CSP was audited and is **not** the
blocker — the live header already carries
`frame-src 'self' https://*.r2.cloudflarestorage.com`, which matches the presign host.

**1. Broadened inline gate, in ONE shared predicate used by both sides.** New module
`src/lib/ap/inline-preview.ts` (pure, no server-only imports, so the client may
import it directly) is the single source of truth. An attachment is inline-PDF when
its `content_type` — with `;`-parameters stripped, trimmed, lowercased — is
`application/pdf`, **OR** it is `application/octet-stream`/empty **and** the filename
ends in `.pdf` (case-insensitive). The same tolerance is mirrored for images
(`.png/.jpeg/.jpg/.webp`). Both the route and `ApQueueClient.tsx` call the shared
helper, so the two can no longer drift — which is how Amendment 4's two hand-written
copies of the rule became a maintenance hazard in the first place.

The attachment route's Prisma `select` now includes `filename` (it previously did
not), which is what makes the filename fallback possible server-side.

**2. Canonical Content-Type on the wire.** A subtlety the gate alone does not fix:
the presign sets `ResponseContentType` from the *stored* type, so an octet-stream
`.pdf` served as `application/octet-stream; inline` would still download rather than
frame. The route therefore signs with `effectiveInlineContentType()` — the
**canonical** type (`application/pdf`, `image/jpeg`, …) rather than the mislabeled
stored one — and echoes that same canonical value to the client, which is what the
client's render branch keys on. `image/jpg` (not a real MIME) canonicalizes to
`image/jpeg`.

**3. TTL raise + re-mint on staleness.** `AP_ATTACHMENT_URL_TTL_SECONDS = 900`
(raised from 300); the route passes it explicitly and returns it in the response body
so the client never has to hard-code a value that could drift from the server's. The
`r2.ts` default is likewise raised 300 → 900 for any other caller. Client-side, the
`Presigned` cache entry now carries `mintedAt` + `expiresIn`, and `resolve()` reuses
the cache **only while fresh** — re-minting once the URL is within
`PRESIGN_STALE_SKEW_SECONDS` (60 s) of expiry. A collapse/re-expand or a
read-then-download therefore gets a live URL instead of a 403.

### Consequences

- The 2 live octet-stream invoices (and every future mislabeled one) regain their
  Preview button immediately on deploy — no backfill, no data migration.
- The gate stays a **positive allowlist**: broadening is bounded to PDFs and the four
  image types, and the filename fallback only applies to the genuinely ambiguous
  types (`application/octet-stream` / empty). A real non-inline type is never
  reinterpreted, and an octet-stream `.xlsx` still keeps a plain download (tested).
- Presigned AP URLs now live 15 min instead of 5. Still short-lived, still scoped to
  a single object, still only mintable by an authenticated approver
  (`requireApApprover()` is unchanged). The re-mint means the effective window a
  reviewer can operate in is unbounded without lengthening any individual URL's life.
- Hard rule #7 (the app never proxies attachment bytes) is preserved.

### Verification

Unit tests cover the live-confirmed case (`application/octet-stream` + `.pdf` →
inline, signed as `application/pdf`), the parameterized `application/pdf; name="x"`
form, the negative (`application/octet-stream` + `.xlsx` → plain download), and the
staleness decision (fresh → reuse; at/after TTL−60 s → re-mint; a cached 300 s URL
10 min old → re-mint). Route tests assert the response `contentType`/`expiresIn` and
the arguments handed to the signer.

**Not verified in this change:** an end-to-end render of a real signed AP PDF in a
desktop browser — that needs an authenticated approver session behind CF Access.
Recommended one-time post-deploy check: as an approver, expand one of the two
octet-stream rows and confirm the Preview button now appears and frames, and
`curl -I` the returned URL to confirm `content-type: application/pdf` +
`content-disposition: inline`.

**Rollback:** revert the app image. The change is code-only (no schema, no config),
and reverting restores the Amendment 4 behavior exactly — the stricter gate and the
300 s TTL.
