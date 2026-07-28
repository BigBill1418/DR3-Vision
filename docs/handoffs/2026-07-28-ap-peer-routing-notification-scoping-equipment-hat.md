# 2026-07-28 — AP peer second-approval routing + notification scoping + equipment escape hatch + shared-file document ingestion (ADR-0062)

**Session context (Bill × Claude, 2026-07-26 → 2026-07-28):**

Woodland iPad operators went in; floor surfaces (ADR-0060/0061) are live and need nothing here. Live use of the AP module surfaced two defects. Every decision below is locked with Bill through a full question-by-question walkthrough — **nothing in this handoff is inferred or assumed.**

**Bill's directives, verbatim:**

1. *"there are second approval invoices so you need to check your data on that - maybe the gate is not working appropriately?"*
2. *"for woodland if the first signer is JT - you notify Morena for second approval if required - if the first is MG - you notify JT... shannon should only get a AP notification if second approval is required on something that RICK initially signed."*
3. *"yes let's add the equipment escape hatch that will then alert Morena / Rick to add the appropriate equipment with all of the needed and required data."*
4. *"i want to get you ingesting all these sheets and data sources from shared office docs so you can get live updates and i don't need to manually sync files"*
5. *"they live all over microsoft - we will just share it to the spec address from various users and owners that has to be planned for and be fully functional"*

**Also corrected:** Bill's MyMRC credentials see ALL sites. The ADR-0057 C-21 "Switch-Account" explanation for Eugene's empty haul mirror is a **wrong diagnosis** carrying a billing-basis escalation risk (§4).

**Contents:** §1 AP routing + notifications · §2 equipment escape hatch · §3 ADR-0062 shared-file ingestion · §4 Eugene mirror investigation · §5 Bill actions · §6 Claude Code actions · §7 success criteria

**Execution posture:** §1 first and urgent — money is sitting unapproved and invisible. §2 same-day. §3 is a full ADR + build gated on an operator prerequisite (§5.1). §4 is investigation-only with an escalation trigger. Full green light.

---

## §1 — Second-approval routing rebuild + notification scoping (URGENT)

### §1.1 — Symptom

Invoices ≥ $1,000 correctly transition to `pending_second_approval`. Bill receives nothing — no ntfy, no email. They sit indefinitely. `docs/operator/ap-approvals.md` claims both channels fire; observed behavior disagrees.

### §1.2 — Root-cause hypothesis: authorization path ≠ notification path

The runbook states, under Shannon's provisioning:

> Bill/Woodland needs no `ap_second_approvers` row — admin-eligibility covers it.

Correct for **authorization** — whether Bill may act. But the **notification recipient resolver** is separate code. If it resolves via `ap_second_approvers WHERE site_id='woodland' AND active=true`, that returns **zero rows** because Bill was deliberately never given one. Empty recipient list, nothing sent, no error logged. Shannon (explicit `eugene` row) is notified normally — which is why this looks fine from the Eugene side and would pass any Eugene-side test.

Classic authorization/notification divergence: the permission model correctly includes admin-eligibility; the notification model was written against the roster table alone.

### §1.3 — Investigation (run FIRST; report before writing code)

**Check A — the backlog. This is the highest-priority action in the entire handoff.**

```sql
SELECT id, site_id, status, confirmed_amount_cents,
       vendor_freeform, first_approver_id, first_approved_at,
       now() - first_approved_at AS age
FROM ap_requests
WHERE status = 'pending_second_approval'
ORDER BY first_approved_at ASC;
```

**Bill's decision: send him this list immediately — he will second-approve them manually today.** Do not wait for the rebuild. Do not wait for the digest. Surface it as soon as the query returns, via ntfy + email, with vendor, amount, first approver, and age per row.

**Check B — what the current resolver sees.**

```sql
SELECT * FROM ap_second_approvers WHERE active = true;
```

Hypothesis predicts a Shannon/`eugene` row and nothing for `woodland`.

**Check C — the notification code path.** Locate the second-approval notify call site (likely the AP decide route, or `src/lib/ap/notify.ts`, routed through `notifyStaff()` per the ADR-0047 chokepoint). Determine whether the path exists at all, how it resolves recipients, whether it passes the `ap_notify` rollout gate, and whether any send was attempted at the `first_approved_at` timestamps from Check A.

**Check D — rollout gate state.**

```sql
SELECT surface, site_id, rollout_state FROM rollout_state WHERE surface = 'ap_notify';
```

Expect `live` both sites (flipped 2026-07-15). A reversion to `pilot` would reroute to admins with a `[PILOT]` header — still reaching Bill, so it alone does not explain the symptom, but confirm.

**Report all four before writing code.**

### §1.4 — The new routing model: person → person

**Site-based routing is retired.** Second approval is determined solely by who signed first. Separation of duties: the two people who work the same floor check each other and carry the context to catch a wrong charge.

| First approver | Second approver |
|---|---|
| Janette | Morena |
| Morena | Janette |
| Kelsey (until 8/8) | Morena |
| Rick | Shannon |
| Shannon | Rick |
| Bill | Morena |

**The table must be total.** Any approver without a row falls back to Bill **immediately** (no 24h wait) and raises a warning line in Bill's morning digest so the missing pair gets configured.

**Data-driven, not hardcoded** — staff changes, code shouldn't:

```
ap_approval_routing (
  id                    text PK,
  first_approver_id     text FK → users(id) UNIQUE,
  second_approver_id    text FK → users(id),
  fallback_approver_id  text FK → users(id) NULL,   -- NULL ⇒ system admin (Bill)
  fallback_after_hours  int  NOT NULL DEFAULT 24,
  active                bool NOT NULL DEFAULT true,
  created_at, updated_at, updated_by
)
```

CHECK: `first_approver_id <> second_approver_id`. Self-approval is never a valid pair.

Admin surface at `/admin/ap/routing` — view/edit pairs, with a validation warning when any active approver lacks a row.

**`ap_second_approvers` (site-based, Amendment 5) is superseded.** Deprecate rather than drop — keep table and data for audit continuity, stop reading from it. Record the supersession in ADR-0046's amendment history.

### §1.5 — 24-hour fallback, weekday clock only

**Bill's decision: weekdays only. The clock pauses Friday evening and resumes Monday.**

If a `pending_second_approval` request is untouched for `fallback_after_hours` of **business time** after `first_approved_at`, it escalates to `fallback_approver_id` (default Bill).

- **Business-hours accrual.** Reuse the existing weekend/holiday skip logic from `scripts/bonus-eod-check.mjs` (ADR-0036/0037-compliant, already handles weekends and holidays) rather than writing a second calendar implementation. If that logic isn't cleanly extractable, factor it into a shared helper and have both consume it.
- **Escalation is additive, not a transfer.** The original peer remains able to sign; Bill becomes *additionally* able. Whoever acts first completes it.
- Hourly scanner, **idempotent** — an already-escalated request is never re-notified.
- The second-approval panel shows escalation state so Bill can see he's acting as backstop rather than primary.
- `ap_requests` gains `escalated_at timestamptz NULL`, `escalated_to text FK → users(id) NULL`.

### §1.6 — Notification scoping (per-user, per-event-type)

Today every roster member gets a new-invoice alert on every arrival. Shannon — who does not work the daily queue — is buried in noise for a queue she has no role in.

Generalize rather than special-case:

```
ap_notification_prefs (
  id                              text PK,
  user_id                         text FK → users(id) UNIQUE,
  notify_new_invoice              bool NOT NULL DEFAULT true,
  notify_second_approval_request  bool NOT NULL DEFAULT true,
  notify_daily_digest             bool NOT NULL DEFAULT false,
  notify_decision_outcome         bool NOT NULL DEFAULT false,
  updated_at, updated_by
)
```

**Four event types, precise semantics:**

| Event | Fires to |
|---|---|
| `new_invoice` | Every user with the pref on. Broadcast to the working queue. |
| `second_approval_request` | **Only the specific person it routed to** (plus the fallback approver on escalation). Never a broadcast — even with the pref on, a user is notified only for requests routed to *them*. |
| `daily_digest` | **Bill only** (§1.7). Full queue status. |
| `decision_outcome` | **Nobody.** Bill's decision: *"No — they don't need to know, it's done."* Ships as a column with everyone false, for future flexibility. |

**Seed values (locked with Bill):**

| User | new_invoice | second_approval | digest | outcome |
|---|---|---|---|---|
| Morena | ✅ | ✅ | ❌ | ❌ |
| Janette | ✅ | ✅ | ❌ | ❌ |
| Rick | ✅ | ✅ | ❌ | ❌ |
| Kelsey (until 8/8) | ✅ | ✅ | ❌ | ❌ |
| **Shannon** | **❌** | ✅ | ❌ | ❌ |
| **Bill** | **❌** | ✅ | **✅** | ❌ |

**Shannon's net effect: exactly one kind of email — a second-approval request when Rick first-signed. Nothing else, ever.** This is Bill's explicit requirement and should be asserted directly in a test, not merely implied by the pref rows.

Bill's `new_invoice=false` reflects that he does not work the daily queue; he still receives second-approval requests (for him, 24h fallback escalations) plus the digest.

Kelsey's existing 8/8 auto-removal must also clear her prefs and routing rows.

Admin surface at `/admin/ap/notifications` — grid of users × event types. **Co-locate with `/admin/ap/routing` on one "AP configuration" screen**; two separate pages for six rows of config is worse.

**All sends continue through `notifyStaff()`** (ADR-0047 chokepoint) and remain subject to the `ap_notify` rollout gate. Prefs filter *within* that gate; they never bypass it.

### §1.7 — Morning digest — GO LIVE

Bill: *"we want that daily digest to go live as well - its time."* **Ships live at both sites, no pilot gating.**

- **06:00 PT, weekdays only** (same skip logic as §1.5).
- **Recipient: Bill only.** Bill's reasoning: *"it's an oversight tool, the team works off the live queue."*
- **Coverage: everything pending** — Bill's explicit choice over the tighter options:
  - Invoices in `pending_second_approval`, with who owes the signature and age
  - Invoices with no first approval yet, flagged by age
  - Invoices on Hold that have gone stale
  - Any escalations that fired since the last digest
  - **Warning line** when any active approver lacks an `ap_approval_routing` row
  - **Warning line** when any invoice is 3+ days old — mark the digest high-priority
- **Suppressed entirely when everything is empty.** No zero-state noise.
- Deep link per row to the relevant panel.

**Keep the AP digest as its own email, separate from the §3 document digest.** Bill selected 6:00 AM without the merge option. Revisit only if he asks.

### §1.8 — Surface the current backlog immediately

Restating because it is the single most time-sensitive item: whatever Check A returns goes to Bill **today**, before any build work. He is clearing them manually.

---

## §2 — AP equipment escape hatch + asset-request workflow

### §2.1 — Two changes, one of which is a spec correction

**(a) Load the equipment master.** Bill has **already uploaded the full equipment list to `/admin/file-drop`.** Find it, import it, populate the equipment master for both sites.

**(b) Remove the site filter — SPEC CHANGE.** Amendment 5 D-M5-6 specified a *site-filtered* typeahead. **Bill's directive overrides this:** *"I don't care about location right now - just populate it all for everyone for now."*

Every approver sees every asset regardless of site. Rationale: a Woodland approver picking a Eugene asset is a far smaller problem than a Woodland approver being unable to pick anything. Site filtering can return later as a refinement; record the change in the ADR-0046 amendment history so the deviation from D-M5-6 is intentional and traceable.

### §2.2 — The escape hatch

Even with a populated master, rentals and new purchases will always outpace it. Bill: *"Build it now, it's small."*

**Third option in the equipment selector:** `Equipment not in list — describe it`

Three-way mutually exclusive with the asset multi-select and "Not equipment-related"; selecting any one clears the others.

Selecting it reveals a **required** free-text field:

> *"Describe the equipment as specifically as you can — type, make/model if known, unit number or the nickname the crew uses, and which site it lives at. Morena and Rick will add it to the fleet properly."*

Approve enables on non-empty description. All other Amendment 5 requirements still apply (vendor, explanation, confirmed amount, variance acknowledgment).

**This is not a bypass.** The description is mandatory and creates a tracked request — not a silent third flavor of "not equipment."

### §2.3 — Schema

```
ap_equipment_requests (
  id                     text PK,
  ap_request_id          text FK → ap_requests(id),
  site_id                text,
  description            text NOT NULL,
  requested_by           text FK → users(id),
  requested_at           timestamptz NOT NULL,
  status                 enum('open','resolved','rejected') DEFAULT 'open',
  resolved_equipment_id  text FK → <equipment table>(id) NULL,
  resolved_by            text FK → users(id) NULL,
  resolved_at            timestamptz NULL,
  resolution_note        text NULL
)
```

`ap_equipment_links` gains `equipment_request_id text FK NULL`. Exactly one of `equipment_id`, `is_not_equipment_related`, `equipment_request_id` non-null per row — CHECK constraint plus a test. Additive migration.

### §2.4 — Alert on request creation

Through `notifyStaff()` (ADR-0047 gating respected):

- **Recipients:** Morena (Woodland) and Rick (Eugene) by site; Bill CC'd on both.
- **Channels:** email + ntfy.
- **Content:** description verbatim, approver name, vendor and amount, site, deep link.
- **Framing:** a request to create a properly-formed asset record. The approver did the right thing — the message must read that way.

### §2.5 — Resolution surface

`/admin/ap/equipment-requests`, also linked from the fleet/equipment hub.

- Open requests with description, requester, invoice context, age.
- **Resolve** opens the standard equipment-creation form pre-filled with the description as a hint. Saving creates the real asset with all required fields and stamps the resolution.
- **Backfill link** — on resolution, offer to repoint the original `ap_equipment_links` row at the new `equipment_id`, so the historical invoice ends up correctly attributed. **This is the payoff of Bill's directive:** *"any equipment that was entered quickly to be properly formatted in the future."*
- **Reject** for genuine non-equipment cases; requires a note. The original invoice stays approved — bookkeeping cleanup, never a reversal.

**Access:** admins plus site managers (Morena, Rick, Janette). Not the general approver roster.

### §2.6 — Reporting

Open-request count on the Ops Dashboard (ADR-0020).

### §2.7 — Variance detection: still dormant, not a defect

Amendment 5's variance flag has **never fired** because no vendor baselines exist — it needs 3+ historical invoices per vendor. The GP AP-history report is **pending from accounting** (confirmed with Bill 2026-07-28). The import path at `/admin/ap/baselines/import` is already built; Bill imports when it lands. **No code work here — do not "fix" a dormant feature that is working as designed.**

---

## §3 — ADR-0062: Shared-file document ingestion

### §3.1 — Context and the architectural correction

Bill hand-uploads every document Vision needs. `/admin/file-drop` is capture-only by design; a human then routes each file.

An earlier draft of this work specced **email-forward** ingestion. Bill's answers corrected that: the files *"live all over microsoft"* and *"we will just share it to the spec address from various users and owners."*

**That is a materially better architecture, and the distinction matters:**

- **Email forwarding** delivers a *snapshot* — whatever the file looked like whenever someone remembered to send it.
- **Microsoft file sharing** grants access to the *live document*. The file stays where it lives; Vision reads current state. When Janette updates the daily log, Vision sees today's version with no re-share and no re-upload.

For living documents — daily logs, rate tables, equipment lists that get edited — file-watch on the source is the only correct model. Email remains supported for genuinely static one-off documents.

### §3.2 — Decisions (all locked with Bill)

#### D1 — A licensed M365 user account, not a shared mailbox

**Bill asked whether an existing shared mailbox could serve. It cannot, and the reason is structural:** a shared mailbox has no license → no OneDrive → no drive identity → nothing that can hold a file-share permission or expose a "Shared with me" for Vision to enumerate. Sharing *to* such an address merely emails a link into the mailbox. Shared mailboxes also cannot sign in at all, by design.

Two license-free alternatives were presented and **explicitly declined by Bill** in favor of the licensed account:

- A dedicated SharePoint library with `Sites.Selected` — no license, but files must live in that library, which breaks the live-document property.
- `Sites.Selected` on the existing sites — no license and files stay put, but requires enumerating sites up front and cannot reach personal OneDrive.

**Bill's choice: the licensed user.** *"Worth it, people share from wherever files already live."* Business Basic tier or equivalent — it only needs OneDrive/SharePoint so the account has a drive identity.

#### D2 — One address, three ways in

**Same address for everything.** Bill: *"Same address — share files to it OR email files to it, one thing to remember."*

1. **Share a file** to the address → Vision reads the live document
2. **Share a folder** to the address → Vision reads everything inside, **including files added later**
3. **Email an attachment** to the address → captured as a static snapshot (the original email path, retained)

#### D3 — Read-only, always

Bill: *"Read-only — Vision never touches the source files."*

Vision never writes to, renames, moves, or deletes a shared file. This also keeps the IT permission ask minimal, and it means a Vision bug can never corrupt a source document.

#### D4 — Near real-time via change notifications, with a sweep behind it

Bill's choice: *"Near real-time — Microsoft pushes a notification when a file changes."*

- **Graph change-notification subscriptions** on the account's drive and on each shared item/folder. Requires a publicly reachable HTTPS webhook endpoint (`dr3-vision.svdp.us` qualifies), the validation-token handshake on subscription creation, and a `clientState` secret verified on every inbound notification.
- Notifications signal *that* something changed, not what — Vision follows with a **delta query** to identify the actual change.
- **Subscriptions expire and must be auto-renewed** before lapse. A renewal job runs well ahead of expiry.
- **MANDATORY: a periodic delta sweep runs regardless of webhook health.** Push-only fails silently when a subscription lapses or a notification is dropped — **this is precisely the failure mode that had MyMRC ingesting nothing for months (ADR-0057 D9).** Push for latency, sweep for correctness. The sweep is not optional and not a "nice to have."
- **Fail loud.** A lapsed subscription that cannot renew, an auth failure, or a sweep that cannot run pages `dr3-vision-system` immediately. Silence is never an acceptable state.

#### D5 — Classify once, confirm once, then locked

Bill: *"Vision guesses what it is, I confirm or correct it once, then it's locked in."*

- On first sight of a newly shared file, Vision classifies it (local parse first, Claude API fallback — the Amendment 5 D-M5-2 hybrid pattern) and produces `{kind, confidence, site?, period?, reasoning}`.
- The proposed classification appears at `/admin/doc-ingest` for Bill to **confirm or correct — exactly once per file**.
- Once confirmed, the file's kind is **registered and stable**. Vision never re-asks.
- **Re-classification is only triggered if the file's structure changes materially** (headers change, sheet renamed/removed) — that surfaces as an anomaly per D7, not as a silent re-guess.

Known kinds, extensible:

| kind | Downstream |
|---|---|
| `daily_log_workbook` | ADR-0048 workbook staging |
| `ap_history_report` | Amendment 5 D-M5-4 baseline import |
| `equipment_inventory` | Equipment master |
| `rate_table` | Rate configuration |
| `mrc_invoice` | Billing reconciliation reference |
| `vendor_invoice` | **NOT routed here** — belongs in the AP mailbox; flag the misdirect and state the correct address |
| `unknown` | Awaits Bill's classification |

**Bill is not pre-registering anything.** *"Just build it and I'll start sharing things — Vision figures out what arrives."* The classifier must be robust and the `unknown` path graceful — an unclassifiable file waits for Bill rather than erroring or guessing wildly.

#### D6 — After confirmation, changes flow automatically

Bill: *"Once I've confirmed what a file is, changes just flow — no more approvals."*

No per-change approval gate. A confirmed file's updates propagate to its downstream pipeline automatically. This is the entire point of the feature — an approval prompt on every edit would defeat it.

#### D7 — Anomaly guardrail (the safety net that replaces the gate)

Bill: *"Yes — flow by default, stage only the anomalies, page me on those."*

Every prior money-touching path in Vision holds a human-confirm line, and that discipline caught real problems (the DAY23 double-count; the promotion reconciliation refusal). D6 removes the gate, so the guardrail replaces it — **not by gating normal changes, but by catching abnormal ones.**

An incoming change **stages instead of flowing, and pages Bill**, when it would:

- Move a billing- or inventory-relevant aggregate beyond a configurable threshold (default: **$50 flat or 15%**, either trips — reuse the Amendment 5 D-M5-4 variance semantics so there is one anomaly concept in the system, not two)
- Delete or null a column that previously carried data
- Drop more than a configurable share of rows (default **10%**)
- Change the file's structure such that the registered classification no longer parses cleanly

Staged anomalies land in a review queue at `/admin/doc-ingest/anomalies` with a clear before/after diff, and can be applied or discarded.

**Every auto-applied change writes a full before/after `audit_log` entry** — anything wrong is findable and reversible after the fact. Bill's morning digest carries a line for what moved.

Bill declined per-file anomaly tuning for now; global thresholds ship first, with the config structured so per-file overrides can be added without a schema change.

#### D8 — Operational robustness ("has to be planned for and be fully functional")

Bill flagged this explicitly. All of the following are **in scope, not follow-ups**:

| Condition | Required behavior |
|---|---|
| Share revoked / permission lost | Detect on next sweep, mark the source `access_lost`, **page Bill**, stop trying silently |
| Owner leaves the org / account disabled | Same as above; name the previous owner in the alert |
| File renamed | Track by immutable `driveItem` id, not path or name — a rename is not a new file |
| File moved | Same — id survives the move |
| File deleted | Mark `deleted`, page Bill, retain the last-known ingested state |
| Same file shared by two people | Deduplicate on `driveItem` id; one logical source, one classification |
| Folder shared | Enumerate contents; **new files appearing later are picked up automatically** and classified per D5 |
| Nested folders | Traverse; configurable depth limit with a sane default |
| `.xlsm` macro workbooks | **Must be supported — the daily logs are `.xlsm`.** Parse without executing macros. |
| Password-protected / unreadable file | Mark `unreadable`, page Bill, do not retry in a loop |
| Very large file | Streaming read with a size cap; exceeding it pages rather than silently truncating |
| Subscription lapse | Auto-renew ahead of expiry; failure to renew pages; the sweep covers the gap |
| Tenant auth failure | Page immediately, halt cleanly, never no-op silently |

#### D9 — Retention and provenance

Every ingested version records `driveItem` id, `eTag`/version, `lastModifiedBy`, `lastModifiedDateTime`, and the ingest timestamp. Vision keeps a content hash per version so "what did this sheet say when we ingested it" is always answerable. Full historical copies are not retained (the source system owns that); the hash plus the derived data plus the audit trail are.

### §3.3 — Schema

```
doc_sources (
  id                  text PK,
  drive_item_id       text UNIQUE,        -- immutable Graph id; survives rename/move
  drive_id            text,
  display_name        text,
  web_url             text,
  shared_by_email     text,
  shared_at           timestamptz,
  parent_folder_id    text NULL,          -- set when discovered inside a shared folder
  kind                text NULL,          -- NULL until Bill confirms
  kind_confidence     text NULL,
  kind_confirmed_by   text NULL,
  kind_confirmed_at   timestamptz NULL,
  status              enum('pending_classification','active','access_lost','deleted','unreadable','paused'),
  last_ingested_at    timestamptz NULL,
  last_etag           text NULL,
  last_content_hash   text NULL,
  created_at, updated_at
)

doc_source_versions (
  id, doc_source_id FK, etag, content_hash,
  last_modified_by, last_modified_at,
  ingested_at, applied bool, anomaly_id NULL
)

doc_ingest_anomalies (
  id, doc_source_id FK, detected_at,
  anomaly_kind enum('threshold_breach','column_lost','rows_dropped','structure_changed'),
  detail jsonb,                            -- before/after diff
  status enum('pending','applied','discarded'),
  reviewed_by NULL, reviewed_at NULL, review_note NULL
)

doc_ingest_subscriptions (
  id, subscription_id UNIQUE, resource, expires_at,
  last_renewed_at, client_state, status enum('active','expired','failed')
)
```

`file_drops` gains `ingest_source` (enum `manual`|`email`|`shared_file`, default `manual`) plus `doc_source_id` FK NULL, so emailed and shared-file arrivals share one manifest. All additive; existing rows keep working as `manual`.

### §3.4 — Surfaces

- `/admin/doc-ingest` — sources with status, kind, last ingest, owner; **classification confirm/correct queue** (D5)
- `/admin/doc-ingest/anomalies` — staged anomalies with before/after diff (D7)
- `/admin/doc-ingest/health` — subscription status, last sweep, access-lost sources, failures
- `/admin/file-drop` — unchanged, now showing ingest source per row

### §3.5 — Auth: settle against the real tenant

The exact mechanism for unattended read-as-the-service-account has several variants in Microsoft's model, and which one works cleanly depends on SVdP's conditional-access configuration. **Claude Code determines this against the live tenant during the build rather than committing to an approach here.**

Constraints that hold regardless: read-only; scoped to what is shared with the account (no tenant-wide file read); credentials stored per the existing secrets discipline (encrypted at rest, never in `.env` for the account login itself, mirroring the ADR-0057 `/admin/mrc-scrape` pattern); and a documented rotation runbook.

### §3.6 — Document elimination backlog

The goal is not to automate document ingestion forever — it is to **eliminate the documents**. Each recurring file is a system Vision hasn't absorbed yet. Recorded in the ADR and reviewed as each becomes actionable:

| Document | Why it exists | Elimination path | Status |
|---|---|---|---|
| Monthly daily-log workbooks | Inventory + billing lived in Excel | ADR-0058/0059 bridges + iPad floor surfaces own the math now | **Largely eliminated** — historical/cross-check only; the feed should end once Kelsey's window closes |
| GP AP-history report | GP is the AP system of record | Scheduled GP export, or GP API pull | Open — pending accounting; investigate GP capabilities |
| Equipment inventory | No master in Vision | **Being imported now (§2.1)** — Vision becomes the master | Closing this session |
| Rick's rate tables | Rates live in his spreadsheets | Vision rate-configuration surface (ADR-0040 groundwork exists) | Open — needs a build |
| MRC invoices | MRC's system of record | ADR-0057 already mirrors the underlying data | Mostly eliminated — reference only |

**Target end state: the shared-file channel handles exceptions and genuinely-external documents, not a recurring internal feed.**

---

## §4 — Eugene MyMRC haul mirror: re-investigate (C-21 diagnosis is wrong)

`docs/plans/2026-07-25-ipad-floor-surfaces-buildout.md` reports Eugene at **0 `mymrc_haul` rows** and attributes it to *"ADR-0057 C-21 not built"* (Switch-Account). **Bill confirms his credentials see all sites.** That explanation is wrong; the real cause is unknown.

**(a) Site derivation fails on Eugene records.** The sync does global-pull with site-on-data derivation. If Eugene records carry a recycler string the mapper doesn't recognize, Eugene hauls land unmapped — **or silently default to Woodland.**

```sql
SELECT payload->'fields'->'Recycler__c'->>'displayValue' AS recycler,
       COUNT(*) AS rows
FROM mymrc_hauls_mirror
GROUP BY 1 ORDER BY 2 DESC;
```

Run against all three mirrors. Compare distinct values against the mapper's recognized set.

**(b) List-view scope is Woodland-biased.** Phase 0 catalogued list views rather than issuing org-wide queries. Check the definitions in `docs/mymrc-discovery-2026-07-22.md` for site filtering.

**(c) Eugene genuinely has few or no `Haul_Request__c` records.** Eugene runs collection sites and thrift stores rather than Woodland's hauler network; inbound may live on a different object. Verify in the MyMRC portal UI before concluding bug.

**Investigation only.** Report; scope any fix separately.

**⚠ ESCALATE IMMEDIATELY if (a) proves true and Eugene rows have been defaulting to Woodland** — Woodland's backfilled inbound would be overstated, which touches the MRC billing basis.

---

## §5 — Actions for Bill

### §5.1 — Provision the shared-file service account (longest lead time — start first)

Gates all of §3. Ask IT for:

1. A **licensed** M365 user account — `docs-dr3@svdp.us` or preferred name. Business Basic or equivalent; it needs OneDrive/SharePoint so the account has a drive identity capable of receiving shares.
2. Access for the existing DR3-Vision app registration to read as that account.
3. Confirmation that `dr3-vision.svdp.us` can receive inbound Graph change notifications (it is already public; verify no egress/ingress policy blocks Microsoft's callbacks).

**Emphasize to IT: read-only, and scoped solely to what is explicitly shared with the account. No tenant-wide file access.** That is usually the sticking point and this design avoids it.

### §5.2 — Everything else

1. **Review the stranded second-approval list** as soon as §1.3 Check A reports — you are clearing these manually today.
2. **Tell Morena, Janette, Rick, and Shannon about the peer pairing verbally** before the code ships. They do not know their role changed. Bill: *"I'll tell them verbally — just draft the written version for after."* Claude drafts the written follow-up separately; **the two existing AP comms drafts in Bill's UI are now stale — they describe the retired site-based routing and must not be sent.**
3. **Confirm the equipment list** Claude Code finds in file-drop is the right one before it imports.
4. **GP AP-history report** — still pending from accounting. Variance stays dormant until it lands; nothing to build.
5. **Start sharing files** to the new address once §5.1 completes.
6. **Still outstanding, Kelsey window closes 8/8:** June/July Woodland workbook, Eugene workbook, MRC contact map + Re-TRAC filing, `allocation_pct` and `saved_units` semantics.

---

## §6 — Actions for Claude Code (execution order)

### Phase 1 — §1, urgent

1. Run §1.3 Checks A–D. **Report before changing code.**
2. **Send Bill the stranded list immediately** (§1.3 Check A / §1.8) — ntfy + email, with vendor, amount, first approver, age. Do this before any build work.
3. Migration: `ap_approval_routing`, `ap_notification_prefs`, `ap_requests.escalated_at`/`escalated_to`. Additive, clean-replay, CI gate.
4. Seed the §1.4 routing table and §1.6 prefs exactly as tabulated.
5. Replace site-based resolution with routing-table lookup via **one shared function consumed by both the authorization check and the notification resolver**, so they cannot diverge again. Test the invariant: for any first approver, the notification recipient set is non-empty whenever the authorization set is non-empty.
6. Deprecate `ap_second_approvers` — stop reading, keep data, note supersession in ADR-0046.
7. §1.5 fallback scanner — hourly, idempotent, additive-not-transfer, **business-hours clock reusing the existing weekend/holiday skip logic**.
8. §1.6 pref filtering inside `notifyStaff()`. `second_approval_request` fires **only** to the routed/escalated individual.
9. `/admin/ap/routing` + `/admin/ap/notifications` as one AP configuration screen.
10. §1.7 morning digest — **live**, 06:00 PT weekdays, Bill only, full queue coverage, zero-suppressed.

### Phase 2 — §2, same-day

11. Locate and import Bill's equipment list from `/admin/file-drop`. **Confirm with Bill it is the right file before importing.**
12. **Remove the site filter** from the equipment selector (spec change vs Amendment 5 D-M5-6 — record it in the amendment history).
13. Migration: `ap_equipment_requests`, `ap_equipment_links.equipment_request_id`, three-way CHECK.
14. Escape-hatch UI per §2.2.
15. Alert on creation per §2.4.
16. `/admin/ap/equipment-requests` including the backfill-link action.
17. Ops Dashboard open-request count.

### Phase 3 — §3, gated on §5.1

18. Author `docs/adr/0062-shared-file-document-ingestion.md` from §3. **Take the next free ADR number at draft time if 0062 is claimed — numbers are never reserved.**
19. Migrations per §3.3.
20. Settle the auth approach against the live tenant per §3.5; document it.
21. Shared-item discovery + folder traversal + `driveItem`-id-keyed source registry.
22. Change-notification subscriptions with validation handshake, `clientState` verification, and auto-renewal.
23. **The periodic delta sweep** — mandatory, independent of webhook health.
24. Classifier per D5; classification confirm/correct queue.
25. Auto-flow per D6 with the D7 anomaly guardrail and full before/after audit.
26. All of D8's operational conditions, each with a test.
27. Surfaces per §3.4.

### Phase 4 — §4, investigation only

28. Run the §4 queries; compare to the mapper's recognized set; check list-view definitions. **Report, do not fix.** Escalate immediately on the Woodland-contamination finding.

### Do NOT

- Do NOT change the second-approval **authorization** rule — admin-eligibility is correct. Routing and notification are what change.
- Do NOT broadcast `second_approval_request`. Exactly one person, plus the fallback on escalation.
- Do NOT site-scope the AP queue. Bill explicitly declined; everyone continues to see all pending.
- Do NOT send `decision_outcome` to anyone. Ships as a column, all false.
- Do NOT keep the equipment site filter. Bill overrode D-M5-6.
- Do NOT let the equipment hatch become a bypass — description required, non-empty, tracked.
- Do NOT build a webhook-only ingestion path. The sweep is mandatory (ADR-0057 D9 lesson).
- Do NOT execute macros when parsing `.xlsm`.
- Do NOT write to, rename, move, or delete any shared source file. Read-only, always.
- Do NOT re-ask Bill to classify a file he has already confirmed.
- Do NOT auto-apply a change that trips an anomaly threshold — stage and page.
- Do NOT "fix" variance detection. It is dormant by design pending the GP report.
- Do NOT fix the Eugene mirror gap in this pass.
- Do NOT send the stale AP comms drafts sitting in Bill's UI — they describe retired routing.

---

## §7 — Success criteria

**§1:**
- Checks A–D reported; **stranded list in Bill's hands same-day**
- Routing table live and total; missing pairs surface as digest warnings
- One shared resolver behind both authorization and notification, with the non-empty-recipients invariant under test
- A test invoice ≥ $1,000 from each of Janette / Morena / Rick / Shannon / Kelsey / Bill notifies exactly the right person and nobody else
- **Shannon receives zero AP email except second-approval on Rick's first signature — asserted directly in a test**
- 24h fallback escalates to Bill additively, idempotently, on a weekday clock that pauses over weekends
- Digest live: 06:00 PT weekdays, Bill only, full queue, suppressed when empty, 3-day items flagged high-priority

**§2:**
- Equipment master populated from Bill's file-drop upload
- No site filter — every approver sees every asset
- An approver facing an unlisted asset completes the Approve by describing it
- Morena/Rick alerted with full invoice context
- Resolving creates a properly-formed record and offers to backfill the original link
- Three equipment states mutually exclusive (CHECK + test)

**§3:**
- ADR shipped
- A file shared to the address is discovered, classified, and awaits Bill's one-time confirmation
- A shared **folder** picks up files added later
- After confirmation, edits flow automatically with a before/after audit entry
- An anomalous change stages and pages instead of flowing
- Every D8 condition has a test and a defined non-silent behavior
- Webhook lapse is covered by the sweep and pages
- `.xlsm` parses without executing macros
- Manual file-drop and the email path both still work

**§4:**
- Distinct recycler values reported for all three mirrors vs the mapper's set
- List-view scope confirmed or ruled out
- A definite cause, or a clear statement of what remains to check in the MyMRC UI
- Immediate escalation if Eugene data landed under Woodland

---

## §8 — Session close

§1's root cause is instructive and worth remembering: the authorization path correctly included admin-eligibility while the notification path queried the roster table alone, so Woodland second-approvals resolved to an empty recipient set and vanished silently. The fix replaces site-based routing with person-to-person pairs — better separation of duties, and it takes Bill out of the bottleneck while keeping him as the weekday-clock backstop. Notification scoping becomes per-user and per-event, which solves Shannon's noise problem as an instance of a general rule rather than a hardcoded exception.

§2 unblocks approvers hard-stopped on a required field with no honest answer, loads the master Bill already uploaded, drops the site filter per his directive, and converts each remaining gap into a properly-formed asset record.

§3 is the architectural correction: Bill's *"share it to the spec address"* is a materially better model than email forwarding, because shared files stay live. The build must be genuinely robust — Bill said *"has to be planned for and be fully functional"* — so revoked shares, renames, deletions, folder additions, `.xlsm` workbooks, and lapsed subscriptions are all in scope with defined non-silent behavior, and the mandatory delta sweep exists specifically because a push-only design is the exact failure mode that had MyMRC ingesting nothing for months.

§4 corrects a wrong diagnosis carrying real billing-basis risk.

Woodland iPad operators went in as this ships; the floor surfaces need nothing from this handoff.




---

## Amendment A — 2026-07-28 — Entra service account PROVISIONED (§3 prerequisite closed)

**Status change:** §5.1 (the operator prerequisite gating all of §3) is **COMPLETE**. Bill provisioned the account directly in the tenant via PowerShell rather than routing through an IT ticket. Phase 3 is unblocked.

### §A.1 — Provisioned values

```
Tenant ID     : 72843ea8-e50d-4500-a0d5-d924e9acb4d5
Client ID     : 2da92424-7397-435d-96a1-d2a382293a53
App reg name  : DR3-Vision
Service UPN   : docs-dr3@svdp.us
Object ID     : 7ad08443-3d96-400e-9e4d-0c34208305e2
Licence       : SPB (Microsoft 365 Business Premium)
Redirect URI  : https://dr3-vision.svdp.us/api/admin/doc-ingest/oauth/callback
```

Tenant/client/object IDs are not secrets and may appear in config and logs.

### §A.2 — Client secret: ALREADY EXISTS — do not create another

The DR3-Vision app registration carries `DR3-Vision Production`, valid **2026-05-06 → 2028-05-05**. This is the **same app registration the AP approvals mailbox already authenticates with**, so the secret is already present in the Vision secret store.

**Do NOT add a second client secret.** Reuse the configured one. A second credential on the same registration doubles the rotation surface for no benefit.

**Expiry 2028-05-05** — add to the rotation runbook alongside the MyMRC credential rotation. A silently expired app secret takes down both AP mail polling *and* document ingestion simultaneously, and presents as two unrelated outages.

### §A.3 — Granted delegated scopes (verified live)

`Get-MgOauth2PermissionGrant` against the app SP → Graph SP returns:

```
ConsentType : AllPrincipals
Scope       : email Files.Read.All offline_access openid profile Sites.Read.All User.Read
```

- `Files.Read.All` + `Sites.Read.All` — read shared items across OneDrive and SharePoint
- `offline_access` — **the refresh token, which is what makes unattended operation work (§A.4)**
- `User.Read` — sign-in / own profile
- `email`, `openid`, `profile` — pre-existing from the Entra SSO integration on this same registration; unrelated and harmless

Admin consent is tenant-wide (`AllPrincipals`). No per-user consent prompt will appear.

Redirect URIs on the registration, both confirmed present:

```
https://dr3-vision.svdp.us/api/admin/doc-ingest/oauth/callback   ← added for this work
https://dr3-vision.svdp.us/api/auth/callback/microsoft-entra-id  ← pre-existing SSO, untouched
```

### §A.4 — Auth model: authorization-code + refresh token. NOT ROPC.

**This supersedes the Conditional Access discussion in §3.5 and §5.1 of the main handoff. That framing was wrong and is retired.**

The earlier draft assumed unattended sign-in implies ROPC (username/password grant), which breaks under any MFA requirement — hence the CA-exclusion and certificate-auth options. **ROPC is deprecated, disabled by default in most tenants, and unnecessary here.**

The correct model:

1. Bill clicks **Connect document service account** on an admin surface in Vision
2. Standard authorization-code redirect to Microsoft
3. **Bill signs in interactively as `docs-dr3@svdp.us`**, completing MFA if prompted
4. Vision receives an authorization code, exchanges it for access + refresh tokens
5. The refresh token is stored encrypted and rolled forward on every refresh thereafter

**No Conditional Access changes are required.** The MFA claim from the original interactive sign-in is carried in the token chain and satisfies CA on every subsequent refresh. No exclusion, no certificate-based auth, no policy edit.

**Claude Code must NOT implement ROPC.** Any design requiring the service account password at runtime is wrong.

**The only condition that forces another interactive sign-in** is a sign-in-frequency CA policy that expires the refresh token, an admin revoking sessions, or a password rotation. Vision must detect that state, mark the connection `reauth_required`, and page Bill (§A.6) — never silently stop ingesting.

**The service account password is not a runtime credential.** It is used once, by a human, in a browser, during step 3. It is stored in 1Password for recovery only. **It must never be written to the Vision secret store, `.env`, or any config.**

### §A.5 — OneDrive provisioning

`Get-MgUserDefaultDrive` may 404 immediately post-licensing. OneDrive provisions asynchronously and is reliably created by the account's first interactive sign-in — i.e. step 3 of §A.4 handles it as a side effect.

Claude Code should not treat an initial 404 as an error. The connect flow's success check happens *after* the sign-in completes.

### §A.6 — Connect surface requirements

New admin surface (suggested `/admin/doc-ingest/connect`, admin-only):

**Disconnected state:**
- Explain that a one-time sign-in as `docs-dr3@svdp.us` is required, and name the account explicitly so Bill doesn't sign in as himself by reflex
- **Connect document service account** button → authorization-code flow against the §A.1 redirect URI
- State parameter with CSRF protection; verify on callback

**Connected state:**
- Signed-in account UPN (assert it matches `docs-dr3@svdp.us` — **if a different account authenticated, refuse the connection and say so plainly**; connecting as Bill personally would silently expose his own files instead of the service account's shares)
- Token acquisition time, last successful refresh, refresh-token age
- Granted scopes, verified against the §A.3 required set
- OneDrive provisioning status
- Active subscription count + next renewal
- Last successful delta sweep
- **Reconnect** action for the reauth path

**`reauth_required` state:**
- Triggered by any refresh failure attributable to an invalidated or expired token
- Pages `dr3-vision-system` **immediately** — this is the ADR-0057 D9 posture; silence is never acceptable
- Banner on the surface with the reconnect action
- Line in Bill's 06:00 digest until resolved
- **Ingestion halts loudly rather than degrading quietly**

### §A.7 — Secret storage

The refresh token, access token, and the existing client secret all follow the established discipline:

- Encrypted at rest in Postgres, same pattern as the `/admin/mrc-scrape` MyMRC credentials (ADR-0057)
- **Never in `.env`** for the account-identity credentials
- Encryption key on CHAD-HQ under `~/.dr3-vision-secrets/`, mounted fail-soft
- Fail-loud on a missing key — never silent no-op (ADR-0057 D9)

If the existing AP-mailbox client secret already lives in a config path rather than the encrypted store, **leave it where it is** — moving it is out of scope here and would risk the AP integration. Document the split; unify later.

### §A.8 — Corrections to the main handoff

| Section | Correction |
|---|---|
| §3.5 (auth "settle against the tenant") | **Settled.** Authorization-code + refresh token per §A.4. No open question remains. |
| §3.2 D1 (licensed user rationale) | Confirmed correct and provisioned. SPB, not Business Basic — Business Basic isn't in this tenant. |
| §5.1 (IT provisioning ask) | **Complete.** Bill did it directly; no IT ticket. Only the webhook-reachability check remains (§A.9). |
| §5.1 Conditional Access sub-item | **RETIRED.** No CA change needed. §A.4 supersedes. |
| §6 Phase 3 gating | **Ungated.** Phase 3 may proceed as soon as Phases 1–2 complete. |

### §A.9 — Sole remaining external unknown

**Inbound Graph change notifications must reach `https://dr3-vision.svdp.us`.** Microsoft POSTs to that host; nothing in the tenant governs whether a firewall, proxy, or WAF permits it.

Claude Code verifies empirically during the Phase 3 build by creating a subscription and confirming the validation handshake completes. **If the handshake fails, do not silently fall back to polling-only** — report to Bill so the network path gets fixed. The delta sweep (§3.2 D4) covers correctness meanwhile, but latency degrades from near-real-time to sweep-interval and Bill must know that happened.

### §A.10 — Test file for end-to-end verification

Once the connect flow ships and Bill signs in, he shares one file with `docs-dr3@svdp.us`. Expected chain:

1. Discovery finds it (push, or sweep)
2. `doc_sources` row created, status `pending_classification`
3. Classifier proposes a kind + confidence
4. It appears at `/admin/doc-ingest` for Bill's one-time confirmation (D5)
5. Confirming registers the kind permanently
6. Editing the file at source propagates automatically (D6), subject to the anomaly guardrail (D7)
7. An `audit_log` row records the before/after

**That chain working end-to-end on one real file is the Phase 3 acceptance test.**
