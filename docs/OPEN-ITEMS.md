# Open items register

The single live list of everything HANGING — operator actions, decisions
waiting on Bill or a stakeholder, and accepted-residual code follow-ups.
Started 2026-07-10 (post-stack-sweep, pre-AP-go-live). Any session that
finishes work with a loose end appends it here; any session that closes one
marks it **DONE (date)** and moves it to the bottom section. Sibling docs:
`docs/QUESTIONS.md` (design questions), `docs/handoffs/` (session context),
`CHANGELOG.md` (what shipped).

**Kelsey's availability ENDED 2026-08-08. That deadline has passed.** It was
extended one week from 8/1 by Bill's renegotiated transfer (2026-07-19, rollup §
preamble); no further extension was taken. **Everything that was blocked on her
is now blocked with NO OWNER** — AK-4 (Layer B commodity reconciliation rules),
F-3 in 0.AI (the entered-vs-derived cross-check rule), S-10, and her AP routing
row (§1 O-13, deactivate rather than delete). Each of those needs a new owner or
an explicit decision to drop it; none has been re-dated or re-assigned. Read any
item below that names Kelsey as a dependency in that light.

---

## 0.BH — 2026-08-20 workbook-import ownership (ADR-0123) — one Bill action, one open question, one residual

- **O-1 — BILL'S DATA ENTRY (ADR-0123): re-enter the M-186301 correction.**
  2026-08-19 Woodland, **960 program / 110 non-program**. Prod currently reads
  970.0/100.0 with `source = 'import'`. It was deliberately NOT written on his
  behalf — it is his figure and his decision. Do it AFTER this deploys: before
  the guard, the next sync tick would have overwritten it back to 970/100 within
  ten minutes. Once entered it takes ownership and stands.

- **Q-1 — OPEN QUESTION (ADR-0123): where did the original 960/110 correction
  go?** The brief said the 09:39 AM PT workbook import overwrote it. It did not.
  The row's audit trail holds exactly one entry — an INSERT by workbook-sync at
  09:39, so no row existed before it. No manual write to `processed_units_daily`
  exists in four days; the MyMRC mirror also reads 970/100; the sync has been
  healthy every ten minutes all day. **The correction was never persisted
  anywhere the system can see.** Candidates worth Bill's eye: a save that failed
  silently on the manager screen, a correction typed into a surface that does not
  write this table, or one never submitted. Not resolvable from the data.

- **R-1 — ACCEPTED RESIDUAL (ADR-0123): the sync's INSERT path still has no
  conflict clause.** A manual row created between the loop's `findUnique` and its
  `create` raises a unique violation that fails the tick. Pre-existing, retried
  ten minutes later, and out of scope for an ownership ADR — but it is the one
  remaining read-then-write in this writer.
## 0.BG — 2026-08-20 floor dead-end pager (ADR-0122) — ONE blocking operator action

Fast-follow to the ADR-0121 emergency. The detector and the page are live; one
step is Bill's and the alert does nothing until it is taken.

- **O-1 — OPERATOR ACTION, BLOCKING (ADR-0122): subscribe the phone to
  `dr3-vision-floor` on `https://ntfy.barnardhq.com`.** This is a NEW primary
  topic. The ntfy server's `auth.db` carries no `user_subscription` table —
  account subscription sync is not enabled — so subscriptions live on the device
  and **cannot be verified from the server.** Publishing is proven end to end
  (a labelled test page was published and read back off the topic, and it is in
  BOS-HQ's `cache.db`), but a topic nobody has added is a black hole. That is the
  state `dr3-vision-loads` and `dr3-vision-deploys` have been in since
  2026-05-06, and the reason ADR-0088 D4 refused to mint a new topic at all.
  Until this is done, a trapped operator still reaches nobody.
  _Owner: Bill. One-time, ~30 seconds in the ntfy app._

- **R-1 — ACCEPTED RESIDUAL (ADR-0122): a SECOND live instance of the ADR-0121
  trap is now instrumented but NOT fixed.** Stage 2 (weight) `add` sub-screen has
  no way back to `choose`. An operator re-entering a load whose weight ticket is
  already on the server and tapping "Add weight" lands on: capture withheld
  (ADR-0109), "add another" unrendered, Continue held by `!hasPhoto` — which
  typing a weight cannot satisfy. ADR-0121 recorded stage 2 as safe on the
  strength of the `choose` screen's None button, which is true only until the
  operator leaves `choose`. It is armed in `main` today. It now PAGES instead of
  hiding; the fix is a behaviour change and rides with ADR-0121 §Follow-ups
  item 2 (server-derived stage selection), which waits for a before-noon window.

- **R-2 — ACCEPTED RESIDUAL (ADR-0122): the obscured fallback topic is a
  hand-mirrored constant in two repos** — DR3-Vision `src/lib/ntfy.ts` and
  `~/noc-master/data/ntfy-fallback-topics.yml`. Nothing at runtime notices drift,
  because the fallback hop only runs when the primary is already down and ntfy.sh
  answers 200 for any topic name. Both were written in the same change
  (noc-master `4374402`).

---

## 0.BF — 2026-08-19 late: the transaction-boundary set (ADRs 0117–0120)

Bill's 2026-08-19 ~10:30 PM PT review of the engineering audit's five criticals
and eight high-severity siblings. Operator-window override (CONTRIBUTING's
before-noon `/operator` rule) explicitly approved by Bill for this set — the
floor is closed overnight.

- **R-1 — ACCEPTED RESIDUAL (ADR-0117): payroll re-drive latency is up to ~24 h.**
  The sweep rides the 06:30 PT chain-health cron, so a delivery lost just after a
  fire waits for the next one. This is bounded and visible where the previous
  behaviour was unbounded and invisible, and shortening it is a schedule change
  (a more frequent sweep), not a code change. Revisit only if a real loss is ever
  observed to have cost a payroll day.
- **R-6 — FOUND AND FIXED IN FLIGHT (ADR-0118 batch).** Converting
  `transition()` to a guarded `updateMany` surfaced a latent ADR-0115-class
  defect: `submitLoad` and `rejectLoad` passed `submitted_by: { connect: … }`,
  a nested relation write that `updateMany` cannot accept and that Prisma
  refuses at argument validation. Both now set `submitted_by_id`, and the
  `data` parameter was retyped to `InboundLoadUncheckedUpdateInput` so `tsc`
  refuses the shape. **Worth a sweep:** other services may pass nested relation
  writes into helpers that were converted to `updateMany` in this set. Not
  swept tonight.
- **R-4 — ACCEPTED RESIDUAL (ADR-0120): the promotion lock is a convention, and
  the index only backstops one table.** Eleven call sites take
  `lockSiteAgainstPromotion`; a NEW writer of `inbound_loads`,
  `outbound_materials`, `landfilled_units`, `consumer_dropoffs` or
  `site_inventory_snapshots` that forgets it reopens the hole for its own path.
  The database-level backstop covers only the snapshot table, and only
  `source = 'import'` rows — the manual-count half must stay index-free because
  ADR-0078 D1 requires same-instant manual rows to be legal. A lint/CI check that
  every writer of the five tables takes the lock would close this; it is not
  built.
- **R-5 — DEVIATION FROM SPEC, recorded (ADR-0120 D3).** The
  transaction-boundary review specified the snapshot unique index WITHOUT the
  `source = 'import'` clause, on the premise that correct-count's void-first
  ordering already satisfied it, and asked for that to be verified against the
  real-DB suite. The verification FALSIFIED the premise: the unscoped index takes
  ADR-0078 D1's suite red and would refuse the second same-day physical count at
  a site. Narrowed and shipped; the evidence is in ADR-0120 D3 and in the
  migration header. **Flagged for Bill** — this is the one place tonight's build
  departed from the specification.
- **R-3 — ACCEPTED RESIDUAL (ADR-0118): two read-side races are narrowed, not
  closed.** `releaseHold` still recomputes the ADR-0072 swing classification
  BEFORE its transaction, so an anchor landing in between is classified against
  the older baseline; and `reconcilePhysicalCount`'s `onHand` read stays outside
  any caller transaction for the reason documented at
  `running-balance.ts:511-517`. Both are read-side and wider than ADR-0118's
  subject — pulling a six-table aggregate into every caller's transaction changes
  the lock footprint of every count on the floor, which deserves its own evidence
  and its own PR.
- **R-2 — ACCEPTED RESIDUAL (ADR-0117): a gate-blocked period re-pages daily.**
  A signed period that a refusal gate (reconciliation, suspected-wrong-$0,
  unconfigured R2) keeps blocking is re-driven by every sweep and pages each
  time, fingerprinted and cooled. Intended: a signed period with no payroll is an
  open problem and silence is the failure mode ADR-0117 exists to end.

---

## 0.BE — 2026-08-19: the count lands split, the digest reaches the managers, a bed-bug load gets rejected, and two watchdogs get honest

Status ledger for the day, written ~11:30 AM PT; in-flight items say so.

- **Woodland EOD-8/18 count APPLIED, then FINALIZED with the split.** First
  applied unsplit at 7:50 AM PT (anchor `6f8ae03b`, delta +383 vs computed
  540); Bill delivered the final split ~10 AM (**923 = 201 program + 722
  non-program**) — unsplit anchor soft-voided (chain-linked in audit), MEASURED
  anchor `855a23b1` live; balance reads 201/722/923. **The computed baseline
  moved 540→721 in the two hours between** (MRC late-arriving prior-day data)
  — the provisional-inbound drift class caught in the act; both deltas
  preserved (+383, +202). Eugene did NOT count (still unanchored; feeds
  decision open).
- **AP morning digest now reaches Bill + Morena + Janette** (was Bill only —
  the notify_daily_digest pref was on for exactly one user; this morning's
  6:00 AM send had `recipients: 1`). Both managers' prefs flipped on, audited;
  first three-recipient send is tomorrow 6:00 AM PT. Rick/Shannon/Kelsey
  remain off.
- **ADR-0109 (photos) LIVE at 10:36 AM PT** inside the floor window at Bill's
  go-ahead — **handoff #264 is complete in its entirety** (ADRs 0105–0109 all
  deployed). One CI flake en route (`stamp-render-gate` Chromium timing test;
  same commit green in the parallel run) — flaky test noted for maintenance.
- **H-137759 (Ron Lawrence & Son, Placer landfill): accepted, unload started,
  MASSIVE BED BUGS — rejected by audited manual rectification** (~11:20 AM PT,
  load `85f7221b`: in_progress → rejected / category `bedbugs`, 1 stack
  soft-voided same-transaction, evidence photos retained, actor
  `system:h137759-bedbug-rejection`). Inventory/pay never touched (non-verified
  statuses feed nothing). **Bill's action: reject the haul MRC-side too** — the
  mirror still shows it `Confirmed` and Vision cannot write to MRC.
  **IN BUILD — ADR-0113:** the product path for reject-after-unload-start
  (operator affordance on the in_progress screen, required category + evidence
  photo, same-transaction stack void + audit, slot semantics per
  ADR-0090/0091). Floor-facing → deploys in the 2026-08-20 before-noon window.
- **CORRECTED (12:45 PM PT): the discovery-gap watchdog was never blind — the
  11:00 AM report misread the gap-snapshot table** (`doc_ingest_reachable_items`
  is written only when a gap EXISTS; gap 0 since the 8/15 17:12 PT close means
  no rows, not no probe). Live probe capture: 22 raw hits = the same 11 docs
  deduped, no shape/permission drift; C-47/C-48 untouched. **What was real and
  shipped (ADR-0112, #273):** a successful-but-EMPTY search would have
  RESOLVED the standing anomaly with an all-clear ("0 of 0 watched") — now a
  loud `discovery_probe_contradiction` that resolves nothing; unprojectable
  search hits throw `GraphContractDriftError` instead of silently vanishing
  (the ADR-0102 class); digest wording says "completeness UNVERIFIED" when the
  probe can't run. Also repaired: committed merge-conflict markers in
  CHANGELOG from the #268 squash. Live behavior for healthy scans unchanged.
- Haul visibility spot-checks for Bill: H-137950 / H-137360 / H-137366 all
  mirrored, detailed, and inside the inventory feed (day-aggregates tie to the
  mirror to the unit; H-137950's 8/18 units are inside the counted 923, not
  double-added).

## 0.BD — 2026-08-18 SHIP-TODAY day: handoff #264 (retire the sheets) + handoff #270 (on-hand) — live status ledger

Written ~2:45 PM PT while the day is still in flight; each line states its own
status. Two handoffs ran concurrently, six + four workstreams, four parallel
build agents plus an orchestrator.

### Handoff #264 — six items, per-item PR

| Item                                                  | ADR / PR        | Status (2:45 PM PT)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 — Terex prior-day, month-bounded, reasoned, audited | ADR-0106 / #266 | **LIVE** (deployed 11:51 AM PT, smoke passed). Also closed an unbounded void hole the diagnosis surfaced: the API allowed voiding ANY prior day (UI merely hid the button)                                                                                                                                                                                                                                                                                                                   |
| 4 — Terex Start/End meters, run-hours derived+locked  | ADR-0107 / #269 | Merged 2:36 PM PT, **deploying now**. Meter-vs-clock resolved from live bytes: 2025–26 tabs are cumulative hour-meters (2dp; the sheet carries Start from prior End by formula); Nov/Dec-24 tabs were clock-times — both shapes recorded in D1                                                                                                                                                                                                                                               |
| 5 — reconcile view verification                       | ADR-0108 / #267 | Verified green clause-by-clause vs plan §12; one red clause fixed (the uncovered stat tile now says "expected — outside the workbook's range", not fault-speak)                                                                                                                                                                                                                                                                                                                              |
| 6 — data-derived variance flags                       | ADR-0108 / #267 | Merged 12:01 PM PT; **rides the current deploy** (see incident below). The handoff's comparand DIED on measurement (mirror holds no weight anywhere; units on 1 of 831 joined loads; total-vs-parts already 0-drift) — shipped per-commodity log-space MAD outlier flags instead, k=6, n≥20 floor, editable config, 14/831 flagged. **Dollar side BLOCKED on a nonexistent join key** (4 accidental of 233 keys; 0 Materials-ID matches) — reported, not fabricated                          |
| 2 — manager corrects operator count, 2-day window     | ADR-0105 / #265 | CI-green including the `/dashboard/[site]/count-corrections` screen (added after review — "usable by the team" means a screen, not an API). **Merges next** after the in-flight deploy + docs re-union. 11 falsifications, storage-layer audit proven                                                                                                                                                                                                                                        |
| 1 — up to 3 photos                                    | ADR-0109 / #268 | **LIVE** (merged 10:20 AM PT 8/19 in the floor window at Bill's go-ahead; deployed 10:36 AM, smoke passed; one Chromium-timing CI flake re-run green — stamp-render-gate noted for maintenance). Premise died safely: "3 total per load" would have refused the door-open (timer-starting) photo on ordinary loads — the flow already takes 3 kinds; ceiling shipped per (load, kind). The capability existed by accident and the floor was already using it (87 loads with photos; up to 6) |

### Handoff #270 — on-hand (SHIP-TODAY; EOD physical count tonight)

- **Phase 0 diagnosis DONE and reported to Bill** (~1 PM PT), live-DB, read-only.
  Headline findings, contradicting the handoff's assumptions: **report ==
  canonical already** (`getEodInventorySnapshot` delegates to `onHand`; live
  442/397/839 identical on both paths); **Woodland is arithmetically healthy
  today** (ties to the unit; no negative in 14 days; 0 undated of 7,372
  Delivered hauls; 15 Confirmed = future appointments, benign); **Eugene is
  EMPTY, not negative** (no anchor ever, zero inbound/mirror/processed rows —
  its 0 is meaningless; tonight = its FIRST anchor; thereafter static until
  feeds exist — Eugene feeds are the named follow-up); the **kind gap is real
  but unfired** (all drop-off kinds sum unfiltered into the pool — the next new
  kind joins silently).
- **Phases 1/2/4 + Phase-3 verification: building now** (one PR): kind
  fail-loud, report==onHand regression pin, negative/stale banners on report +
  floor tile (display-layer, reusing the existing freshness signal), and
  end-to-end verification that tonight's count path is guarded (ADR-0072 tiered
  overwrite guardrail wired to /count, Pacific-day date correct, Eugene
  first-anchor case safe). Merge target: before the EOD count.
- **COUNT ARMED (verified live 3:55 PM PT, post-ADR-0110 deploy):** report ==
  onHand on both sites (Woodland 947/397/1,344 healthy; Eugene 0/0/0 zero);
  every anchor-write path tier-guarded (the desktop snapshot POST's missing
  ADR-0072 guardrail was FOUND AND FIXED in #271 — pre-fix it accepted a 32%
  swing with 201); ADR-0105's correction screen live, so a mis-keyed count is
  correctable under audit. Woodland re-anchors (prior anchor 27.5 d old);
  Eugene counts its FIRST (tier-0 no-prior-anchor case test-covered).
- **COUNT APPLIED (2026-08-19 ~7:50 AM PT, Bill's instruction):** Woodland
  physical count **923** recorded as the authoritative anchor for EOD 8/18
  (snapshot `6f8ae03b`, Pacific-midnight-8/18 storage per D-3, `legacy`/unsplit
  attribution — crew counted total only; Bill confirmed the site and the
  unsplit recording in-session, which also served as the >20%-swing manager
  approval). **`reconciled_delta = +383`** (counted 923 vs computed 540) — the
  ledger was UNDER-counting by 383 units, the drift evidence the reset exists
  to capture; likely provisional-inbound under-feed, worth reading against the
  next few days of MyMRC deliveries. On-hand now computes forward from 923.
  **SUPERSEDED same morning (~10:00 AM PT): Bill delivered the FINAL split —
  923 = 201 program + 722 non-program.** The unsplit anchor was soft-voided
  (ADR-0084/0105 discipline, chain-linked in audit) and replaced by MEASURED
  anchor `855a23b1` (201/722/923). Live balance now reads 201/722/923.
  **Both drift snapshots preserved:** the 7:50 AM anchor recorded delta +383
  (vs computed 540); by 10:00 AM the computed baseline had moved to 721 —
  MRC's late-arriving prior-day data raised computed history by ~181 units in
  two hours — so the measured row records delta +202. That movement is the
  provisional-inbound drift class in live action, and is itself evidence for
  why the physical count is the authority.
  **Eugene did NOT count** — still unanchored/zero; its first anchor remains
  open alongside the Eugene-feeds decision.
- **Decision after tonight:** `correct-count.ts` (ADR-0105) is a third
  anchor-write door with real controls but no swing-tier check — a typo'd
  correction of a typo is possible. Deliberately not churned on count day;
  needs a call tomorrow (flagged in #271).

### Incidents & residuals from today

- **The [skip-deploy] squash trap fired a SECOND time (#267, 12:01 PM PT).** The
  squash body inherited the tag from a branch commit; the deployer forced
  pull-only and logged "Updated (no services to rebuild)"; prod ran without
  ADR-0108 for ~2.5 h until the orchestrator's reconciliation caught it. Fixed
  by the #269 merge (explicit clean body). **Standing rule: every squash merge
  passes an explicit `--body`; check the squash message for the tag before
  merging.** Follow-up worth an ADR discussion (noc-master side): the deployer
  should arguably honor `[skip-deploy]` only in the subject line of the range
  head, not anywhere in a squash body.
- Platform-wide API 529 storm ~10:40 AM PT dropped all four build agents
  mid-start; all resumed with backoff, no work lost.
- The CHAD-HQ builder cache was ~4.9 GB and fully reclaimable again before the
  2:37 PM build — the ADR-0101 cache-persistence residual is still live; deploys
  are running cold (~21 min).
- Three build agents independently hit `tsc | head` masking real errors behind
  exit 0 — lab hazard, each caught it; noting for the fleet.

### Still open at day close (expected)

- Bill: the two staged ADR-0104 batch confirmations (outbound / expenses review
  pages) — the variance page reads staged scope honestly meanwhile.
- Bill/Rick/Janette: variance threshold retuning after the first real week
  (AK-4c verdicts stay human).
- #268 merge tomorrow before noon PT.
- Eugene inbound/processing feeds (scoping decision, named by the Phase-0
  diagnosis).

## 0.BC — ADR-0105 shipped 2026-08-18 — screen INCLUDED; one deliberate residual left

`POST/GET /api/manager/[site]/snapshots/[id]/correct` is live, gated and audited,
**and `/dashboard/[site]/count-corrections` renders it** — linked from
`/dashboard/[site]/loads-inventory`. A manager or admin can correct a physical
count taken today or yesterday (Pacific) from the browser: the corrected value
becomes the anchor, the prior value stays on screen struck through and labelled
`superseded by <value>`, and no approval is required.

**The "no screen" item recorded when this ADR first landed is CLOSED** — the
surface shipped in the same PR (#265) rather than being deferred, because an
endpoint a manager cannot reach relocates the phone call instead of retiring it.

### Still open, and deliberate

- **The daily report's "counted by" line names the MANAGER for a corrected
  count.** `eod-inventory.resolveCounter` reads the insert audit row's actor, and
  on a corrected snapshot that is whoever put the number on the record. The
  operator who physically counted is preserved as `counted_by` in the audit
  payload and as `entered_by` on the correction row, so nothing is lost — but the
  rendered line changes. **Not fixed here on purpose:** changing `resolveCounter`
  changes a report that is actually sent, which needs its own evidence and its
  own ADR (the same call ADR-0084 made about the `created_at DESC` divergence).
- **No browser/e2e test of the correction screen.** Covered by server-render and
  jsdom tests; nobody has clicked the real page against a real database.
- **`GET /api/manager/[site]/snapshots` still has no client consumer.** ADR-0105
  did not adopt it — it ships its own list (`listWindowCountsAtSite`) because that
  endpoint returns a history with no correction chain and no `correctable` flag.
  The older endpoint remains unrendered, exactly as ADR-0084 recorded.

## 0.BC — 2026-08-18 three photos per capture point (ADR-0109) — two accepted residuals

Handoff #264 Item 1 shipped: a load takes **3 photos per capture point** (BOL,
weight ticket, door-open, rejection), one required and unchanged, two optional
and unnamed. The brief's "3 total per load" was falsified against prod before
building — an ordinary load already takes three, so a per-load cap would have
refused the door-open photo (which starts the unload timer) on every load with a
weight ticket. Retires the extra-photo camera-roll/text side channel.

**Accepted residual 1 — nine production loads are already over the ceiling.**
Measured 2026-08-18: 4 loads hold 4 photos, 4 hold 5, 1 holds 6, and load
`fce4fbc5-9fca-4d50-8afb-d074b8994e74` holds **four BOL photos** alone. The cap
governs **new writes only**; those rows are not retracted and
`photosRemaining()` clamps at 0 so none renders a negative count. No action
needed — recorded so a future reader does not read them as a cap failure.

**Accepted residual 2 — one behaviour is withdrawn.** An operator who could take
a fourth photo of one kind no longer can. That has happened once, ever
(2026-08-10). Three is Bill's stated ceiling, and the control is removed rather
than left to refuse — so the floor meets a limit, not an error. If the floor
asks for more, the number is one constant in `src/lib/loads/photo-limit.ts` and
a product decision, not a rebuild.

**Watch item — the `concern` PhotoKind still has no stage that mounts it.**
`PhotoKind.concern` exists in the schema and has a translated label
(`photo.label_concern`), and no operator surface captures one. Pre-existing, not
introduced here, and now slightly more visible because the extras this ADR adds
are the thing a "concern" photo would otherwise have been. Not a defect; a
question about whether that kind should exist at all.

---

## 0.BB — ADR-0104 shipped and executed 2026-08-15 (7:22 PM PT) — TWO STAGED BATCHES AWAIT BILL

The document-ingestion gap is closed: `doc_sources` is **11 registered, 0
unconfirmed**, and the outbound weight column the operation was missing is in the
database. `mymrc_outbound_mirror` had `weight_lbs` NULL on **4,673 of 4,673**
loads; **831 of them now have a weight** (5,619,037 lb, Woodland Jan–Jun 2026),
plus 1,699 commodity rows and 332 facility-expense rows.

**2026-08-17 addendum — the TEREX sheet is still the floor's habit, and the
guardrail now shows it.** Five revisions of the live TEREX source staged between
8/14 and 8/17 (Aug26 cumulative counters legitimately accrete past the ADR-0069
15% threshold mid-month; nothing applied since 8/13). At Bill's written
instruction the newest (`626b11aa`, modified 8/17 6:09 PM PT) was applied and
absorbed (**80 rows**, no error) and the five superseded intermediates
discarded, all audited. **Standing item:** while the team keeps editing the
sheet, every edit re-stages and sits silently. Either the team moves to
Vision's equipment entry (Bill: "we need to get them to stop"), or staged TEREX
revisions get a periodic apply pass / a deliberate guardrail carve-out for
mid-month accretion. Until one of those happens, "the ledger looks stale" means
"check the staged queue" first.

**2026-08-18 addendum — one of the two reasons the team stays on the sheet is
gone (ADR-0106).** The standing item above says the fix is the team moving to
Vision's equipment entry. Vision was giving them a reason not to: ADR-0079 D4
refused every prior day, so a Monday correction to Friday's numbers could only
be made in the workbook. Prior-day entry and edit are now accepted for any date
in the current Pacific month, with a required reason on the audit row; a prior
month still routes to the office. **This does not close 0.BB** — the team's
maintenance logging habit is a separate half, and staged revisions will keep
arriving until they stop editing the sheet at all. It removes the excuse, not
the habit.

**2026-08-18 addendum 2 — the sheet's Start/End columns now exist in Vision
(ADR-0107), and one residual is left open deliberately.** `start_hours` /
`end_hours` are captured and `run_hours` is derived from them, so the sheet's
`Start Hours`, `End Hours` and `Day Total Hrs Used` columns can be retired.

**RESIDUAL — the ADR-0081 workbook importer still writes NULL meters
(ADR-0107 D6).** The extractor already parses `startHours`/`endHours`, so this
looks like a two-line change and is not. The new
`run_hours_is_the_difference` CHECK would refuse any sheet row whose own
`Day Total Hrs Used` does not equal `End − Start` to the cent, and
`terex-monthly-extract.ts` records in its header that such rows exist — it
refuses to derive hours from the meter difference precisely because operators
leave the day-total formula un-filled on some rows. **What is owed: measure how
many rows in the absorbed history actually disagree, and by how much.** That
number decides between wiring the import as-is, importing only agreeing rows, or
relaxing the CHECK — and it is a data question with a real answer, not a
judgement call to make blind.

### WAITING ON BILL — the only thing this build cannot do for itself

Both batches are **STAGED**. Nothing counts until he accepts them, and an agent
clicking confirm would put his attestation on a reading nobody read (ADR-0069
Am.2 O-2). Two clicks, both admin-only:

| Screen                       | What to check before accepting                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin/doc-ingest/outbound` | **831 loads / 5,619,037 lb.** The screen states that 556 duplicate rows were removed — four sheet pairs are exact copies plus one subset sheet — so the total is the real tonnage and not ~1.67x it. It also names the 2 loads (`M-159724`, `M-172079`) where the workbook's own check column disagrees with its weight column.        |
| `/admin/doc-ingest/expenses` | **332 rows / $974,928.37**, $104,241.82 credited. Both STOCKTON sheets were refused (Stockton is not a registered site). **No row carries a real invoice date** — the workbook's `Invoice Date` column holds a day of the month under month banner rows, and 40 rows sit above the first banner, so their month is genuinely unstated. |

Until he accepts, `/admin/doc-ingest/outbound-coverage` reads empty at
`confirmed` scope by design; the `staged` view shows the figures.

### Still open, and NOT closed by this build

- **AK-4c — what a disagreement MEANS.** The coverage page surfaces the
  mirror/workbook join and grades nothing: no threshold, no tolerance, no
  verdict (P-48). That rule is Bill's with Rick and Janette, and it has had **no
  owner since Kelsey's availability ended 2026-08-08** (see the preamble). A
  guess encoded now would become the default by being first.
  **2026-08-18 (ADR-0108) — still open, and deliberately so.** The page now
  marks loads whose weight is unusual _for their own commodity_ against an
  editable line (`/admin/doc-ingest/outbound-variance`, defaults `k = 6`,
  `min_sample_n = 20`, seeded from the measured distribution). That is a
  look-at-this, not a verdict: no `ok`/`mismatch` wording, **no alert channel and
  no email**, and a test fails the build on the vocabulary of blame. It moves the
  state from "nothing is surfaced" to "unusual rows are surfaced against a number
  you can change" — it does **not** decide what a difference means, and does not
  need an owner to keep working.
- **AK-4c dollar leg — BLOCKED on a join key that does not exist.** Measured
  2026-08-18 and reported rather than approximated: of 332 facility-expense rows,
  262 carry an invoice number (233 distinct normalized); overlap with the mirror's
  4,628 distinct normalized BOL ids is **4** — bare-numeric collision territory,
  not a signal — overlap with Materials IDs is **0**; `commodity_raw` ↔ Materials
  ID is **0** (it holds 12 commodity _names_, never an id); and the 6 `haul_ref`
  values are `H-` prefixed **inbound** hauls, not outbound `M-` loads. **To
  unblock:** the expense log needs a load or BOL reference captured at entry, or
  MyMRC needs to expose an invoice number on the outbound record. Neither exists
  and neither can be inferred. No dollar matching was built (ADR-0108 §5).
- **A real weight comparand could appear, and here is the exact condition.**
  39 mirror rows _do_ carry per-commodity pound figures under Salesforce
  commodity keys (`Waste__c`, `Wood__c`) — which is why a search for "weight"
  finds nothing while a comparand exists in principle. They are all **March
  2024** and their overlap with the workbook's Jan–Jun 2026 loads is **zero**. If
  detail capture is ever extended over the workbook's range, a genuine
  expected-vs-actual pair exists and ADR-0108 should be revisited (ADR-0108 §2.1).
- **AK-4b — the operational outbound leg.** `outbound_materials`,
  `outbound_vendors`, `recycling_rates`, `landfilled_units`,
  `outbound_material_payments` and `invoices` all stay at **0 rows** (P-49).
  Their prerequisite vendor and rate masters do not exist and could only be
  satisfied by inventing rates from `Disposition` strings.
- **P-47 — 3,839 Woodland loads still have no weight**, and every Eugene load.
  The only document that supplies weights covers Woodland Jan–Jun 2026. Loads
  before 2026, after June 2026, and all of Eugene are out of its range and **no
  currently watched document supplies them.** If a MyMRC export for those
  periods exists, registering it is the fix; nothing in the code is.
- **P-46 — `doc_commodity_audit_rows` still has 252 rows that can never leave
  `staged`.** ADR-0080 shipped that class with no decide service; ADR-0104 ships
  one for each of its own two staging classes rather than replicating the gap,
  but does not repair this one. It needs a `commodity-decide.ts` on the same
  contract plus a confirm control on `/admin/doc-ingest/commodity`.
- **P-50 — the `Licenses, Registrations, etc` sheet** (41 rows: filed-through,
  expiry, cost, owner) is real operational value that is NOT captured. It lives
  in a stale 2025 file. That needs a CURRENT document from Bill, not an
  extractor.

### Two operating notes worth keeping

- **A squash-merge inherits `[skip-deploy]` from any commit folded into it.**
  PR #261 merged with a body carrying the trailer twice — inherited from the two
  docs-only design commits — so the deployer took the pull-only path and never
  rebuilt the app image. The build only reached prod on the follow-up (#262).
  When a branch mixes docs-only commits with real code, check the squash body
  before merging.
- **Kelsey's TEREX copy `5b298aeb` is held off by `enabled = false`, not by a
  constraint** (P-52). It is now classified honestly as `terex_maintenance_log`,
  so it is exactly one Enable click from double-absorbing 173 maintenance
  events. As of this build the health page raises a red panel if any
  single-instance class ever has two enabled sources — but the guard is a
  report, not a lock.

---

## 0.BA — 2026-08-13 late-night MyMRC sync incident (ADR-0103) — fixed and deployed, two watch items, one audit caveat

The 11:01 PM PT `MyMRC sync error - woodland [outbound]` page was a cached-page
contract violation in the scraper's capture path, fixed and live as `d717859`
(12:34 AM PT scrape verified clean, all four Woodland feeds ok, freshness
green). Full record: ADR-0103. Residuals:

- **WATCH — the heal branch has not yet run live.** The replay-on-heal path is
  proven adversarially by test; its first live exercise will be the next
  mid-run session drop (historically ~once/day). Confirmation looks like a
  `heal detected — pass discarded, replaying` log line in
  `dr3-vision-mymrc-scrape` with the feed still ending `ok`. If instead the
  `mymrc-error:woodland:*` fingerprint fires again with the SAME
  `waitForTimeout` message, the fix missed a second caller — reopen ADR-0103.
- **WATCH — CI on `main` was red for ~35 min after `d717859`** (the direct push
  bypassed the PR gate; the full-suite ADR-index test failed on the missing
  0103 row — the deployer ships on health, not CI, so prod was never blocked).
  Closed by this docs commit (index row added, `adr-record-integrity` 20/20
  locally). Standing note: a direct-to-main incident fix should run
  `npx vitest run src/__tests__/adr-record-integrity.test.ts` before push.
- **AUDIT CAVEAT — any grep-based audit of this repo executed before
  2026-08-14 silently excluded** `src/lib/mymrc/list-page.ts` (571 lines) and
  `src/lib/equipment/import.ts`: both contained a literal 0x00 byte, which
  grep/ripgrep treat as "binary — skip, report nothing". Fixed (escapes,
  byte-identical) + guarded by `repo-hygiene.nul-bytes.test.ts`. Re-run any
  audit whose conclusions leaned on repo-wide grep coverage of the MyMRC or
  equipment-import modules.

## 0.AZ — 2026-08-12 handoff #259: commodity sources confirmed, quota digest enabled, unwatched-file triage

All four phases of the confirm-and-sweep handoff executed (evening PT). Full
evidence: `docs/q2-commodity-reconciliation-finding-2026-08-12.md` §CONFIRMED.

- **HEADLINE — Layer B is buildable from files (Q-2/AK-4b evidence landed).**
  `Woodland Outbound Auditing 2026.xlsx` (now watched, source `63da2155`) carries
  per-commodity WEIGHT per outbound load (M-id grain, VC-vendor codes, BOL IDs,
  shipment dates; no dollars). `Woodland Invoices tracking.xlsx` (now watched,
  source `e0101cb5`) carries Invoice # + `Amt.` + category/commodity (no
  weights). **No shared machine key** (275 Invoice# vs 816 BOL / 831 M-id:
  zero overlap) — but the linkage is hand-recorded in Notes (tickets that ARE
  BOL IDs, M-id lists, tonnage+rate, "in MyMRC <date>") and 29 invoice rows key
  directly to **H-haul numbers**. Reconciliation grain that works:
  (month × commodity × vendor), with per-load matching for the Notes-keyed
  subset. Building it stays **Bill's call** (AK-4).
- **WATCH — do NOT confirm the Outbound file's proposed class.** The classifier
  proposed `commodity_audit_tracker` (conf 0.30); that absorber expects the
  sign-off-log shape, not a weights workbook. Needs a new class when Layer B is
  designed. (The Invoices file proposed `ap_history_report` 0.72 — also leave
  unconfirmed; it is not an AP feed.)
- **RETENTION RISK — 4 of 5 watched sources live on Kelsey's personal OneDrive**
  (departed 2026-08-08); if the account is deprovisioned the live links die (R2
  retains ingested versions). Durable fix = move the canon to a team/SharePoint
  library — the same move ADR-0067 Am.6 §E recommends. Operator action.
- **TRIAGE — the remaining 6 reachable-but-unwatched files** (all
  `/Documents/Attachments/` e-mail-attachment snapshots; none looks like
  client-PII; nothing auto-watched — Bill decides):
  | File | Size/owner/modified | Likely is | Recommend |
  |---|---|---|---|
  | DR3 Data Tracking.xlsx | 331 KB · Kelsey · 07-29 | general tracking workbook, contents unknown | **watch once to sample** (same read-only pattern as this handoff), then decide |
  | TEREX.xlsx (Attachments copy) | 481 KB · Kelsey · 07-29 | duplicate-by-name of the WATCHED TEREX (which lives on Janette's drive, still updating) — different identity, frozen snapshot | don't watch (double-ingest risk) |
  | DR3 Machine List (2).xlsx | 41 KB · **Bill** · 07-28 | equipment roster copy; superseded by the ADR-0062 equipment master | don't watch |
  | DR3 Meeting Notes Log 2026.xlsx | 81 KB · Kelsey · 07-29 | meeting notes; names staff, no operational figures | don't watch |
  | DR3 Task Lists for 2025.xlsx | 50 KB · Kelsey · 07-29 | stale 2025 task lists | don't watch |
  | JOURNAL Woodland Facility.xlsx | 58 KB · Kelsey · 07-29 | facility journal; may contain personnel/incident notes | keep unwatched pending Bill review (C-47-adjacent) |
- **DONE — ADR-0071 Am.2 shipped and enabled** (see CHANGELOG this date):
  #257/#258 merged, Woodland `enabled=true / min_misses=3 / Friday 20:00 PT`,
  recipients Bill+Morena+Janette (pre-existing), the 8/03–8/07 week pre-claimed
  (suppressed, reason on the row) so the **first digest lands Friday 2026-08-14
  20:00 PT** covering Mon 8/10–Fri 8/14. Eugene stays disabled, recipients
  empty (Am.1 — Bill's to fill).
  **2026-08-14 postscript — the first send fired PILOT, then went LIVE the same
  evening.** The enablement above missed the ADR-0047 rollout gate: the
  `processor_quota_digest` surface was still `pilot`, so the Friday 20:00 PT
  send correctly rerouted to admins with the `[PILOT — would have sent to: …]`
  banner (the gate doing its job — content + targeting validated before ramp).
  Bill reviewed it and ordered the flip (~9:20 PM PT): Woodland surface flipped
  `live` via `flipRolloutSurface` (audited, criteria note on the row), the
  pilot claim row for week 8/10 cleared (audited delete, before-image kept),
  and the run re-fired — **delivered live 9:23 PM PT to Morena + Bill +
  Janette** (notify audit: mode `live`, 3/3, week 8/10–8/14, 15 of 22
  flagged). Eugene's surface remains `pilot` and its config disabled.
  Lesson for the next surface enablement: `enabled=true` on the feature config
  AND the ADR-0047 rollout row are two separate gates — check both.
- **DONE — F-1 display completion**: COR headcount prose now renders a real
  number or "not recorded", never `—`, never a fabricated 0 (prefill already
  derived from payroll per ADR-0076; this closes the display letter of F-1).
- **DECISION BRIEF — C-47 (scope narrowing), investigation only, nothing
  changed.** The live connection (`doc_ingest_connections`, verified
  2026-08-12) holds `email openid profile User.Read Files.Read.All
Sites.Read.All`. What doc-ingest actually exercises today needs only
  `Files.Read.All`: sharedWithMe enumeration, `/shares/{token}` URL
  registration (C-48: measured working on Files.Read.All), per-item
  metadata/children/delta/content on the 5 watched item-level shares, and the
  ADR-0080 reachability probe. Nothing currently calls a Sites API; the only
  planned consumer of `Sites.Read.All` is the ADR-0067 Am.6 §B SharePoint-list
  subscription — which is also the recommended escape from both on-borrowed-time
  discovery routes. The 11,403-file/42-site blast radius is **unproven to come
  from the scope at all** (the ⚠ 2026-07-29 amendment): it may be docs-dr3's
  org-wide site membership, in which case dropping the scope shrinks nothing.
  **Decision shape for Bill:** (1) run the falsifiable narrowed-token test from
  a separately consented test app (avoids the refresh-token-rotation re-auth
  risk on prod); (2) if the scope is the lever, narrow it; if membership is,
  pull docs-dr3 out of `NSStaff`/`HSS*` site groups — that removes the PII
  exposure under either answer and costs doc-ingest nothing today.
- **DECISION BRIEF — ADR-0087 (VLM equipment identity), Proposed, unbuilt.**
  Proposes: key VLM↔DR3 equipment on `vlm_legacy_id` (one additive nullable
  column + partial unique index), nightly additive upsert from the existing
  `vlm-cdc` → `analytics.equipment` feed (dry-run first; never hard-delete), a
  canonical match key that PRESERVES `-` and `#` (both proven to distinguish
  real assets), "key proposes, corroboration disposes" merges, wiring
  `findSimilarEquipment` into the AP request path (the hole that minted 4
  duplicates on 2026-08-06 alone), a 22-value type vocabulary, and CSV decision
  registers in-repo instead of chat approvals. Cost: one migration + one sync
  job + register decisions (3 type-vocab calls, ghost bulk rule, a handful of
  corroborated merges); plus the CDC projection must regain VIN/plate for merge
  corroboration. Unblocks: durable equipment population (519/626 matched,
  drifting), real dedup (M104/F9/DV2547), and `equipment_trend` leaving pilot
  on trustworthy identity. **Open question for Bill:** accept the ADR and
  authorize the build, and make the register's three pending vocabulary calls
  (`Vehicle`, `Van`, blank) plus the ghost-archival bulk rule.

## 0.AY — 2026-08-11/12 floor dead-end week-one slice — one decision for Bill, two accepted residuals

The dead-end inventory (`docs/2026-08-11-floor-dead-end-state-inventory.md`, 25
findings) and ADR-0094's prevention plan, executed as far as the week-one scope
went. Sixteen findings closed. What is left:

- **DECISION FOR BILL — may the floor restore a slot MyMRC withdrew?** (ADR-0099
  §D4.) A withdrawn slot is now legible on both surfaces and self-heals within an
  hour once the office re-adds the haul, but there is no operator control, and a
  truck arriving against a slot withdrawn more than three scrapes ago still needs
  a phone call. A restore button is buildable and would survive long enough to
  work. It is not defaulted because a load worked against a haul MyMRC does not
  list is a **billing** artefact, and whether the floor may create one is a
  product call, not an engineering one. **Ask:** yes/no, and if yes, manager-gated
  or any operator?

- **RESIDUAL — the error-contract batch is untouched.** Audit D-7, D-10, D-11,
  D-12, D-13, D-16 (all M). D-7 in particular (`{"error":"error"}` from five
  auth/rollout guards) is a _prerequisite_ for the rest of §2.4 being fixable,
  because the information is destroyed server-side.

- **RESIDUAL — D-3 shipped WITHOUT the iPad hand-check the audit asked for.** The
  audit could not drive `notFound()` end-to-end (the auth redirect intercepts
  every unauthenticated probe) and wanted ten minutes on a real iPad first. The
  page shipped anyway because the default 404 has no chrome, no locale and no
  navigation in _every_ scenario, so it is a strict improvement either way — but
  the exact repro is still unconfirmed. Worth one tap next time an iPad is in
  hand: open `/operator/woodland/load/<a-uuid-that-does-not-exist>` while signed
  in and confirm the green chrome + Back appear.

- **WATCH — `src/lib/ap/poll.test.ts` is load-sensitive.** It fails under a full
  parallel suite run on a busy host and passes in isolation against both the
  pristine and the changed tree (A/B'd 2026-08-12). Pre-existing, not caused by
  the dead-end work, and not investigated here. If CI starts flaking on it, this
  is the note.

- **WATCH — the ship-before-noon rule is a documented convention, not CI.**
  ADR-0094 P4, now in `CONTRIBUTING.md`. Nothing enforces it. Note that this very
  slice was shipped in the evening, which the rule would have deferred; see the
  rule's own text for why that is recorded rather than hidden.

---

## 0.AX — 2026-08-10 late-night solidity sweep ("confirm we are solid") — two fixes executed, one decision for Bill, two watch items

Bill ordered a full verification sweep (~6:56 PM PT). All six of the day's PRs
verified LIVE and behaving; the sweep also found four untracked issues. Fixes
executed ~7:20 PM PT, audited under Bill's user id:

- **FIXED — H-136912 (Costco-Innovel, appt Tue 8/11 10:00 PT) slot freed by
  RE-ATTRIBUTION, not just detach.** The 95-unit load worked 8/7 (13:38–14:19
  PT) matches **H-136736** exactly — same transporter (Titan Concepts), same
  commodity, same 53' trailer, same 95-unit count, MRC **Delivered** 95, worked
  68 minutes after H-136736's appointment — while H-136912 is MRC Confirmed/0.
  `9e7c1cf4.expected_load_id` → H-136736's slot (which had no child). One move
  closes both the consumed slot AND H-136736's missing-work gap. **The 0.AV
  item-D claim that "only the operator knows which truck it was" is FALSIFIED
  for this class — carrier+commodity+trailer+unit-count+MRC-status matching
  identified the truck from data alone; try that method on the 159-unit orphan.**
- **FIXED — stale future-dated aggregate deleted (audited).** `2b460bb7`,
  104 program units keyed to 2026-08-12 = H-136583's pre-ADR-0089 appointment
  day; the Am.1 re-key moved the haul's real units into the 8/6 aggregate but
  the bridge never removes day-rows whose hauls migrate away. Left alone it
  would have phantom-added 104 program units to the floor at Wed 00:00 PT.
  **Design gap for the build list: the bridge has no cleanup path for aggregate
  rows whose mirror day-group becomes empty** (one-line ADR-0089 amendment).
- **DECISION FOR BILL — 2026-07-29 has a 671-unit hole the hourly bridge can
  never fix.** An `ipad_floor` aggregate (150 units, entered 8:34 AM that day —
  the only non-MyMRC aggregate in the table) occupies the unique
  (site, day)-slot, so the MyMRC bridge could never land that day's real
  aggregate (mirror: 10 delivered hauls, 439 program / 382 non-program), and
  7/29 has since slid out of the 10-day trailing window. **Consequence: the
  current program floor reads −52, but correcting 7/29 moves it to +237 /
  +1,398 — do NOT treat −52 as a physical deficit until 7/29 is decided.**
  Needed: what does the iPad 150-unit row represent (partial manual count?
  double-entry with a haul?) — then `mymrc-inbound-bridge-backfill.mjs --since
2026-07-29` once the slot conflict is resolved. **Second design gap: no
  defined semantics for ipad_floor vs mymrc_haul aggregate-slot contention.**

  **ASKED — email SENT 2026-08-10 (evening PT) to `morena.gomez@svdp.us` from
  `dr3-vision@svdp.us`, CC Bill**, asking what the 150-unit iPad entry from
  2026-07-29 (entered 8:34 AM PT under Pablo) actually represented. **Waiting on
  her reply — this is now a stakeholder block, not a Bill decision.** Nothing
  will be backfilled for 7/29 until she answers, because the two plausible
  readings point opposite ways: a partial manual count means the MyMRC aggregate
  should REPLACE it, while a double-entry against a real haul means the 150 units
  are already counted somewhere and adding the day's 439/382 would over-credit.
  Per the fleet rule this went from the SVdP mailbox, never a BarnardHQ identity.

  **Do not publish or act on the −52 program floor while this is open.**
  Correcting 7/29 moves it to +237 / +1,398.

- ~~WATCH — six loads carry exactly 2.000× MRC's unit count~~ **RESOLVED 2026-08-10 ~8:30 PM PT** — PR #227's replay tests falsified the replay-double-add theory; the load_stacks rows proved plain DOUBLE-ENTRY (two identical rows per load). At Bill's instruction all six were corrected: duplicate stack soft-voided (ADR-0090 semantics), total_units set to the true count, audited per load; verified total_units == MRC unit_count_at_unload == live stack sum on all six. The live-total display + stack void shipped in #227 prevent recurrence. Original text kept below.
- **(original)** six loads carry exactly 2.000× MRC's unit count (H-135978/135313/
  136226/136232/136250/136664; two operators; MRC's independent
  unit_count_at_unload agrees with MRC each time). Exact doubling across six
  loads smells like the AW-1 finishUnload/replay double-add, not counting
  habits. `b2b_haul` rows never reach inventory (all sit `submitted`; only
  `verified|submitted_to_mymrc|processed` feed onHand), so this is a floor-record
  /attribution issue, not an inventory one — but investigate before any
  haul-count-driven figure is published. Build, this week.
- **WATCH — `19bfc591` (H-136796 HWMA, late truck)** started 5:13 PM PT on the
  freed slot, `in_progress` — genuinely being worked. If still open at start of
  shift Tue, chase it (the void now exists for exactly this).
- **Corrections to earlier entries:** 0.AV W "H-135311 still in_progress" —
  zeroed+submitted 4:58 PM PT; 0.AW-6 "H-136796 being resolved" — resolved
  (mis-click zeroed+detached 4:58 PM PT, real truck checked in 5:13 PM PT).
- Also verified: Woodland DID enter today's Terex number (69 units / 6.15 h,
  5:26 PM PT) — the 08:30 watchdog stays correctly silent Tue morning. Source
  queue: one NEW pending item ("Mt Diablo Pittsburg", arrived 7:01 PM PT) — the
  queue working as designed, decide it with the next batch. Nine stale git
  worktrees exist on this box, six carrying unmerged commits from earlier
  sessions — deliberate prune needed, not auto-cleanup.

---

## 0.AW — 2026-08-10 floor workflow ergonomics (ADR-0090) — all three features shipped, three decisions for Bill

_All times and dates Pacific. Both merge commits carry 2026-08-11 UTC stamps; the
work happened Monday 2026-08-10. A + C = PR #226 (5:34 PM PT), B = PR #227
(7:54 PM PT)._

Branches: `feat/floor-workflow-ergonomics` (A + C) and
`feat/adr0090-back-navigation` (B). All three of JT's items are now built.

- **AW-1 — DONE (2026-08-10, PR #227).** B (back navigation) shipped on
  `feat/adr0090-back-navigation`, built to the ADR-0090 §D3 design with the
  deviations recorded in ADR-0090 Amendment 1. All three §D3 stack findings were
  implemented as written and each is pinned by a real-Postgres test in
  `src/lib/loads/back-navigation.db.test.ts`: both `finishUnload` sums filter
  through one shared `NOT_VOIDED_STACK` constant, `nextIndex` is computed over the
  MAXIMUM index including voided rows, and the `addStack` P2002 convergence check
  refuses a voided row with a 409.

  **Bears on 0.AX's 2.000x watch item, which attributes the doubling to "the AW-1
  finishUnload/replay double-add".** That half is falsified by a real-Postgres
  test on this branch (`back-navigation.db.test.ts`, "a replay cannot DOUBLE a
  total"): a queued `add_stack` carries its ORIGINAL `stackIndex` in the payload,
  so a replay always targets the row it was for and either converges on it or
  409s — it can never land at a fresh index — and the ADR-0078 D7 branch
  RECOMPUTES `total_units` from a fresh sum rather than accumulating. Neither
  route can double a total. The live hypothesis that survives is a genuine
  DOUBLE-ENTRY: two taps minting two keys at two indexes, which in `total` count
  mode (re-typing a total the operator believes did not save) produces exactly
  2.000x and nothing else. Until this branch the floor had no way to take one
  back, which is consistent with six of them shipping. **Still needs the six
  loads' `load_stacks` rows to confirm** — one row of 2N is a mis-count, two rows
  of N is the double-entry. Not verifiable from a test.

- **AW-2 — DECIDED by Bill 2026-08-10 ~6:56 PM PT; DONE (2026-08-10, PR #227).** Yes,
  `finished → in_progress` reopen is allowed, and **the duration freezes at the
  first finish** — a re-finish keeps the value computed then. Built that way, and
  the freeze is structural rather than a UI branch: the timing columns are written
  by a conditional `UPDATE ... WHERE unload_duration_seconds IS NULL`, so it holds
  however a second finish is reached and holds under concurrency.
  `unload_finished_at` is frozen alongside it so the documented pair cannot
  disagree; the instant of a re-finish lives in the audit row. Reasoning and the
  alternatives: ADR-0090 Am1.1–Am1.2.

- **AW-3 — DECISION for Bill: should a `truck_never_arrived` void notify anyone?**
  It is the signal that a carrier no-showed and currently lands in a column nobody
  watches. Graded against ADR-0037 it is not a page; it may be a daily-digest line
  or a dashboard tile.

- **AW-4 — HARDENING: six hand-maintained duplicates of the `LoadStatus` allow-lists.**
  `INVOICE_STATUSES`, `VERIFIED_INBOUND_STATUSES` (plus two byte-identical local
  copies in `audit/leg-fetchers.ts` and `mymrc/inbound-bridge.ts`, both documented as
  such), an inline literal in `audit/workbench-providers.ts`, `OPEN_DOCK_STATUSES`,
  `OPERATOR_ACTIVE_STATUSES` (two separate copies), and the unsynced pair
  `labels.ts ALL_LOAD_STATUSES` / `dashboard/[site]/loads/page.tsx ALL_STATUSES`
  (`ALL_LOAD_STATUSES` is currently imported by nothing — a dead export). Adding
  `voided` was safe because they are all allow-lists, but this duplication is how the
  NEXT enum addition gets missed. Consolidate behind
  `satisfies readonly LoadStatus[]` in one module.

  Re-checked 2026-08-10 on `feat/adr0090-back-navigation` and deliberately NOT folded
  in: that branch adds a state-machine EDGE (`finished → in_progress`) and no new
  `LoadStatus` member, so none of the six lists needed an edit. The consolidation
  spans six files across the export, inventory and audit paths, and bundling a
  refactor with no test of its own into the diff that carries two billing-sum edits
  and a schema change was not a trade worth making. Still open, still unowned.

- **AW-5 — WATCH: the void is unreachable for aggregate rows, by construction.**
  The status-blind precedence lookups in `floor-inbound.ts`, `bulk-inbound.ts` and
  `inbound-bridge.ts` are scoped to `load_source_type in AGGREGATE_SOURCE_TYPES` /
  `mymrc_haul` / `paper_bulk`, and a dock void only ever produces a `b2b_haul` row.
  If a void is ever offered on an aggregate row those queries become reachable and
  each needs `notVoidedLoadWhere`.

- **AW-6 — REFERENCE, not an action: the three stuck Woodland loads. ALL THREE
  RESOLVED 2026-08-10 — see §0.AX.** H-136796 (HWMA, mis-tap) was zeroed and
  detached 4:58 PM PT and the real truck checked in on the freed slot 5:13 PM PT;
  H-135311 (Wexler, 13-day zombie) was zeroed and submitted 4:58 PM PT; H-136917
  (Pleasanton) was genuinely open and was worked. This branch changed no data —
  the resolutions were hand-audited under Bill's user id, recorded in §0.AX.

- **AW-7 — ACCEPTED RESIDUAL: an offline-queued stack cannot be taken back.** A stack
  added while offline renders with a client-minted `tmp-` id and has no server row to
  void, so the Remove control is not offered on it (ADR-0090 §D3's own guard: an
  affordance whose only outcome is a 404 is a dead end). The operator's route is to
  wait for the queue to drain and then correct — the same wait the ordering guard
  already imposes on every correction while this load has unsent work. No owner; open
  it only if the floor reports hitting it.

---

## 0.AV — 2026-08-10 consumed-slot check-in (ADR-0074 Amendment 1) — one reconciliation decision, two watch items, one hardening call

Fix branch: `fix/consumed-expected-load-checkin`. Root cause, timeline, the
time-bounding decision and the alternative considered: **ADR-0074 Amendment 1**.
Shipped state: `CHANGELOG.md` 2026-08-10 (later). Every figure below was read from
`dr3_vision` on CHAD-HQ on 2026-08-10; all times Pacific.

- **D — DECISION FOR BILL: the 159-unit mis-attribution.** Load
  `2b60d7ba-efb4-46de-ba27-8801bbf0be5a` was started 2026-08-03 17:01 against
  H-134743's slot (appointment 2026-08-10 15:00, **seven days later**), worked, and
  `submitted` 2026-08-05 16:48 with **159 units**. It is real physical work — a truck
  was unloaded and counted — booked against **the wrong haul number**. The
  2026-08-10 detach set its `expected_load_id` to NULL to free the slot, so it is now
  an **orphan**: 159 units with no haul attribution at all, carrying
  `external_mymrc_haul_id = NULL`. Nothing has been reconciled and nothing further has
  been touched. The open question is **which haul those 159 units belong to** — the
  operator who started it on 08-03 is the only person who knows which truck was on the
  dock that afternoon. Options: (a) identify the real haul and re-attribute; (b) leave
  it orphaned and adjust inventory by hand; (c) void it and re-enter. **All three
  change billing figures, so none was taken by this fix.**

  **UPDATE 2026-08-10 — "only the operator knows" is FALSIFIED for this class (see
  §0.AX).** H-136912's twin was identified from data alone by matching carrier +
  commodity + trailer type + unit count + MRC status, with no operator recall
  involved. **Try that method on this 159-unit orphan before treating (b) or (c) as
  the only remaining routes** — option (a) may well be reachable. Note this one is
  harder: the detach already NULLed its `expected_load_id`, so there is no slot to
  work back from, only the 08-03 17:01 start and the 159-unit count.

- **W — WATCH: two early-started loads whose appointments have not yet arrived.**
  Both are consumed slots today. **They have NOT been detached — not in code, not in
  data — and must not be, without a decision.** After this fix their cards render
  read-only ("already worked — N units, submitted <date>") instead of dead buttons, so
  neither can block the floor the way H-134743 did; but if the physical truck DOES
  arrive there is still no way to check it in without a detach.
  - **H-136912** — appointment **2026-08-11 10:00** (tomorrow). Child load
    `9e7c1cf4`, started 2026-08-07 13:36, submitted 14:19, **95 units**.
  - **H-136583** — appointment **2026-08-12 07:00**. Child load `b57eeeb3`, started
    and submitted 2026-08-06 17:48, **104 units**. **MRC records this haul as
    delivered EARLY on 8/6**, so its truck may never come and the early start may in
    fact be the correct one. Do not act on it before that is confirmed.
- **W — the other two of the four, for completeness.** Same class, appointments
  already past, no floor block possible:
  - **H-135311** — appointment 2026-08-05 12:00; child `d792ed15` started
    **2026-07-28 12:55** and is **still `in_progress` after 13 days**, with no units
    recorded. This is also an ADR-0082 stranded-load case, reachable from the queue's
    held-by-others block.
  - **H-135615** — appointment 2026-08-07 12:00; child `30c98815` started 2026-08-05
    09:55, submitted **2026-08-10 08:43** (the morning of the incident), 148 units.
- **D — DECISION FOR BILL: should the day bound also be asserted in the WRITE path?**
  The check-in bound added by ADR-0074 Am.1 lives in the read/render layer of both
  surfaces. It was deliberately NOT added to `startLoadAction` / `startInboundLoad`,
  because that path is shared with the **offline queue** — a check-in captured at
  23:58 and replayed at 00:02 would be refused by a naive server-side day check,
  turning a legitimate captured tap into a lost one (ADR-0078 replay semantics would
  need settling first). The residual, stated plainly: an authenticated operator issuing
  a crafted server-action invocation for their own site could still start a
  future-dated load. No surface offers it and no ordinary path reaches it, but
  ADR-0065 Am.1's "defense in depth, not a replacement" principle argues the write
  should assert it too. Not shipped unilaterally — it is a behaviour change, not a
  hardening.
- **R — ACCEPTED RESIDUAL: a genuinely early truck cannot be checked in from the
  iPad.** By design, and it restores the behaviour the queue always had. The fix is
  upstream — correct the appointment in MyMRC and let the ADR-0059 bridge re-sync. If
  the floor hits this in practice, the answer is a **manager-scoped override**, not
  re-widening the floor surface. Reasoning: ADR-0074 Amendment 1, "The alternative, and
  why it was rejected".

---

## 0.AU — 2026-08-10 iPad reject-evidence 403 (ADR-0086 Amendment 1) — one re-capture + one decision for Bill

Fix branch: `fix/ipad-rejection-evidence-mint-403`. Root cause and reasoning:
ADR-0086 **Amendment 1**; shipped state: `CHANGELOG.md` 2026-08-10 (late).

- **O — FLOOR RE-CAPTURE (after the fix deploys).** Load
  `54ad7a11-7066-4d6b-b064-8c57483fa067` (Woodland) is stranded at `unload_started`
  with 3 photos and **no rejection evidence**. The bytes were never handed to the
  offline queue and are **not recoverable** — the floor has to photograph the
  rejection again and re-run the reject stage. Nothing to run server-side.
- **D — DECISION FOR BILL: the 5-minute operator idle window vs iOS camera
  suspension.** These are in structural tension. iPadOS suspends the page while the
  camera sheet is up, so any capture that involves walking to a trailer can outlive
  `IDLE_TIMEOUT_OPERATOR_S` (5 min, ADR-0004) and come back to a dead session. The
  fix makes that outcome **honest and non-destructive** (401 → "sign in to send",
  photo queued, nothing lost) but does not remove it — the operator still has to
  re-enter a PIN mid-reject. Deliberately NOT changed here: shared-forklift-iPad
  idle timeout is a security-posture call. Options, cheapest first:
  1. keep-alive ping while a capture sheet is open (narrow; only extends during an
     actual capture),
  2. capture-scoped session extension (a bounded bump on the capture screens),
  3. a longer operator window outright (widest blast radius — it is the control
     that limits who can pick up an unattended iPad).
- **N — note for whoever touches auth next.** The husk (`session.user` truthy,
  `id`/`role` undefined) is what Auth.js hands every guard after idle expiry or an
  ADR-0053 D2 revocation. `src/lib/session-husk.test.ts` pins the shape and
  `src/app/operator/_components/floor-session-husk-coverage.test.ts` keeps floor
  surfaces from re-introducing `!session?.user`. **Manager/admin surfaces under
  `src/app/dashboard/**`still test`!session?.user`** — not swept here because they
run a 12h window and redirect to `/login`, which is the right destination for them,
  so the husk costs at most one extra hop. Flagged rather than fixed: a sweep of
  those is its own change.

## 0.AT — 2026-08-08 evening close-out: Terex gap follow-through + operational sends

- **Terex page gap (Bill's question, ~13:10 PT) — DIAGNOSED, nothing broken.** The
  workbook's last filled day is Fri 7/24 (live Graph read confirmed: file untouched
  since 7/31, `Aug26` tab literally `#DIV/0!`-empty); the floor ran throughout
  (daily closes ~1,000–1,250 u/day), so 7/27–8/6 is a nine-working-day PAPERWORK
  gap. Post-cutover: JT reached the equipment surface Fri 8/7 but used the
  downtime form (two empty submits, self-deleted) — never the daily-processing
  form. Surface verified working end-to-end; nobody had asked her to use it.
- **PENDING FOLLOW-THROUGH (next session picks this up):** Bill chose Option B —
  JT re-fills 7/27–8/7 into `TEREX.xlsx` (`Jul26`/`Aug26` tabs INCLUDING each
  totals row, or R5 reconciliation refuses the tab). Instruction email sent
  2026-08-08 via `dr3-vision@svdp.us` (cc bill.barnard@svdp.us). When the sweep
  shows a new revision of doc source `8a0246e7`, re-run
  `scripts/one-off/2026-08-07-terex-workbook-history-import.ts` (idempotent,
  version-scoped, JT-wins; verified: NO cutover date filter, so 8/7 imports and
  renders as striped `workbook` source). Then verify the page and, if all days
  land, the workbook can be RETIRED (final pull done).
- **Stranded dock loads (ADR-0082 Am.1 list):** email sent 2026-08-08 to Janette
  - Morena via `dr3-vision@svdp.us` (after a first send from Bill@BarnardHQ.com —
    WRONG channel, corrected; the barnardhq identity must never touch @svdp.us
    recipients). 9 loads / 4 holders; the `finished` 148-unit load flagged first.
    Floor action; re-run `docs/queries/2026-08-08-open-dock-loads.sql` to track.
- ~~`equipment_throughput_gap` surface (ADR-0088) ships PILOT~~ **RAMPED LIVE at
  Woodland 2026-08-10** (audited one-off at Bill's written instruction; Eugene
  stays pilot — no machine). See 0.AQ.
- **Fleet finding — `[skip-deploy]` is DECORATIVE on this repo's deployer:** the
  2026-08-08 docs-only merges each triggered a full ~20-min rebuild. Harmless
  but wasteful; fix belongs in the deployer repo (honor a commit-message tag or
  a docs-only diff check), not here.
- **Test residuals:** `src/lib/ap/stamp-render-gate.test.ts` flakes under
  fully-parallel local runs (chromium semaphore timing; passes isolated, passes
  in CI) — known, don't re-diagnose. The ADR-0088 fake-DB double now evaluates
  its three predicates but still silently ignores UNKNOWN where-keys; the
  structural close is to throw on unrecognized keys (reviewer residual).
- **ADR-0086 §9 Q4 key-retirement calendar is UNOWNED** — the likeliest way the
  grants feature fails in six months is a rotation runbook nobody is scheduled
  to execute. Needs an owner + a calendar entry (~2026-11-01, N-1 retirement).

## 0.AR — 2026-08-08 VLM equipment decision register opened (ADR-0087, Proposed)

- **DECISION WAITING ON BILL — the register.** ADR-0087 (Proposed) fixes the
  policy for VLM↔DR3 equipment identity (canonical key preserves `-` AND `#`;
  merges need VIN/make corroboration; sync keys on a new `vlm_legacy_id`;
  nightly CDC upsert). The item-level calls live in
  `docs/plans/2026-08-08-vlm-equipment-decision-register.md`: 7 VIN-verified
  collision groups (G1–G7), 3 standing questions (`-ACC` meaning, ghost-unit
  default, optional renumbers), and 5 CSV worksheets (492 ghosts, 146 blank
  types, 48 aliases, 39 type mappings — 36 prefilled, 6 ACC). Decisions are the
  CSV `decision` columns + §4 bulk rules; tooling executes only decided rows.
  Nothing is implemented until decided — sequencing in ADR-0087 §10.
- **Context worth keeping:** the equipment table drifts TODAY — AP
  request-resolution created 4 duplicate rows on 2026-08-06 (no similarity
  check on that path; fix is ADR-0087 D4). The ADR-0075 merge tool has never
  been exercised (`merged_into_id` NULL on all rows), contra ADR-0075 D5's
  claim the Terex dupes were merged.

## 0.AQ — 2026-08-08 ADR-0088 throughput-gap watchdog (ships DARK, born pilot)

- ~~OPERATOR ACTION (Bill) — ramp `equipment_throughput_gap` to `live` at Woodland~~
  **DONE 2026-08-10 17:04 UTC** — flipped `pilot → live` at Woodland through the
  audited `flipRolloutSurface` path (one-off
  `scripts/one-off/2026-08-10-throughput-gap-flip-live.ts`, actor
  `system:throughput-gap-flip`, criteria note carries the pilot evidence), at
  Bill's written instruction ("flip live the no terex numbers alert - that
  should be good to go"). Verified live post-flip: `rollout_surfaces` row
  `live`/attributed/stamped + matching `audit_log` row. Eugene left `pilot` as a
  recorded "no". From the next fire (a working morning that finds a gap), the
  nudge goes to the Woodland `alert_recipients` roster (Morena + Janette), not
  admins. Original text kept below.

  Until you flip it at `/admin/rollout`, the morning
  nudge goes to ADMINS ONLY, with the `[PILOT — would have sent to: …]` header
  naming the real audience (the `alert_recipients` roster: Morena + Janette at
  Woodland). That is the ADR-0047 default and it is deliberate — it lets you read a
  week of these, and check both the wording and the targeting, before any manager
  gets one.

  **This is not a no-op in pilot.** The scan runs, the ledger fills, and you receive
  the mail. Only the recipient list is gated. So the ramp decision is "is this
  useful and correctly worded", not "does it work" — you will already know.

  **Eugene:** leave it pilot. `resolveSiteThroughputMachine` returns null there, so
  the scan skips the site before it ever consults the surface; the row exists only so
  that a Terex arriving at Eugene is handled with no code change.

  **What flipping it does:** the nudge starts going to the site's active
  `alert_recipients` instead of to admins. Nothing else changes — no new alert
  fires, no history is back-alerted, and the (site, gap_date) ledger means a day
  already nudged in pilot is never re-sent to the roster.

- **OPERATOR ACTION — bring up the new cron container on CHAD-HQ.** The deploy adds
  a compose service. It reads only `INTERNAL_CRON_TOKEN` from the existing
  `cron.env`, so there is no new secret to provision:

  ```
  ssh -F ~/noc-master/config/swarm-auto-update.sshconfig chad-hq
  cd ~/DR3-Vision && docker compose up -d throughput-gap
  docker logs --tail 20 dr3-vision-throughput-gap   # expect: "next gap scan at …"
  ```

  If the container is not started, the watchdog simply never fires — the app is
  otherwise unaffected. That is the pre-0088 status quo, **not an outage**.

- **RESIDUAL (accepted) — this watchdog detects a MISSING entry, never a WRONG one.**
  A manager who types a plausible but incorrect number produces a recorded day and
  the scan stays silent, correctly. Entered-vs-derived cross-checking remains **F-3**
  (blocked on Kelsey) and ADR-0088 does not touch it. Do not read a quiet watchdog as
  evidence the numbers are right — only as evidence they exist.

- ~~VERIFY AFTER THE FIRST WORKING MORNING (2026-08-10, Monday)~~ **DONE
  2026-08-10** — the scan ran on schedule (ledger `created_at` 15:30:01 UTC =
  08:30 PT) and found **Friday 2026-08-07 unrecorded**: one ledger row
  (woodland, gap_date 2026-08-07, `notify_mode = pilot`, delivered 1/1). So the
  watchdog's very first pass caught a real gap — the cutover day itself has no
  live throughput row. That day is prior-day-refused on the entry form (ADR-0079
  D4), so if Woodland's 8/7 number is wanted it goes through the office
  amendment path; the ledger row means it will never be re-nudged either way.
  Original verify text kept below.

  Monday's scan asks
  about **Friday 2026-08-07** — the cutover day itself, and the first day a gap is a
  gap. Confirm it did the right thing:

  ```
  docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c \
    "SELECT s.code, a.gap_date, a.scanned_on, a.notify_mode, a.recipient_count, a.delivered_count
     FROM equipment_throughput_gap_alerts a JOIN sites s ON s.id = a.site_id
     ORDER BY a.created_at DESC LIMIT 10;"
  ```

  A row means the gap was found and reported. **NO row is equally valid** — it means
  2026-08-07 was recorded, which is the outcome we want. Cross-check against the
  Woodland equipment page for that day rather than assuming either way.

## 0.AP — 2026-08-08 ADR-0086 capture-time photo upload grants (ships INERT)

- ~~OPERATOR ACTION — provision `PHOTO_GRANT_SECRET`~~ **DONE 2026-08-08 ~20:45 UTC** — provisioned per the runbook below at `~/.dr3-vision-secrets/photo-grant.env` (mode 600, KEY_VERSION=1), app recreated, **`/healthz` verified `photo_grants_ok: true`**. (First placement mistakenly went to the repo `.env`, which the app never reads — removed; the compose `env_file` list is the contract.) Original runbook kept below. Until this exists
  the feature does nothing at all: the app mints no grants, `/api/photos/*` behaves
  exactly as it did before ADR-0086, and a queued photo still needs a live signed-in
  session at its site in order to drain. That is the pre-0086 status quo, **not an
  outage** — the deploy is safe to land before this step and must be, because the
  image ships before the secret file does.

  ```
  ssh -F ~/noc-master/config/swarm-auto-update.sshconfig chad-hq
  umask 077
  printf 'PHOTO_GRANT_SECRET=%s\nPHOTO_GRANT_KEY_VERSION=1\n' "$(openssl rand -base64 48)" \
    > ~/.dr3-vision-secrets/photo-grant.env
  chmod 600 ~/.dr3-vision-secrets/photo-grant.env
  # then recreate the app container so env_file is re-read
  cd ~/DR3-Vision && docker compose up -d --force-recreate app
  ```

  `docker-compose.yml` already mounts the file with `required: false`, so a missing
  file is not a boot failure — it is the inert state above.

  **Verify (do not skip — a secret that did not reach the process is invisible
  otherwise):** `curl -s https://dr3-vision.svdp.us/healthz | jq .photo_grants_ok`
  must return `true`. It is deliberately NOT part of the `status`/`ok` verdict, so a
  missing secret will never fail the deployer's smoke test or trigger a rollback —
  which means it will also never announce itself. Check it explicitly.

  Never in the repo, never in a commit message, never in a log. Generated ONLY on
  CHAD-HQ by the operator; no session has ever held this value.

- **OPEN — the `N-1` key-retirement calendar entry has no owner.** ADR-0086 D6:
  rotation is destructive here. `PHOTO_GRANT_KEY_VERSION` selects the key, the
  verifier accepts `N` and `N-1`, the minter only issues `N`, and
  `PHOTO_GRANT_SECRET_PREVIOUS` (i.e. `N-1`) **may not be retired sooner than 14
  days** after a rotation — `max(exp)`. Retiring it early invalidates every grant
  sitting in every iPad's IndexedDB at once, silently, which is precisely the
  evidence-loss event this ADR exists to prevent. There is no rotation scheduled
  today, so nothing is due; the item is that **a runbook nobody is scheduled to
  execute is a rotation that will happen once, in an emergency, on the day it
  destroys 40 queued photos** (ADR-0086 §9 Q4 — the one open question the walkthrough
  did not assign). Bill to name an owner.

- **Accepted residual — `uploaded_by` changes MEANING for grant-drained photos.**
  ADR-0086 D8: under a grant the column records the **capture-time** operator rather
  than whoever was signed in when the queue drained. This is _more_ truthful, not
  less, and it is the direction that runs opposite to the usual one for a bearer
  credential — but it is a semantic change to an existing column and it should be
  read that way by whoever audits attribution. To be noted in `COMPLIANCE.md` at the
  next pass on that document rather than discovered from the data.

## 0.AO — 2026-08-08 ADR-0085 iPad walk-up drop-off (born pilot)

- ~~OPERATOR ACTION — flip `ipad_dropoff`~~ **DONE 2026-08-08 18:35 UTC — Bill chose LIVE AT BOTH SITES** (walkthrough decision; audited rollout_surfaces flip, labelled SQL). Original text: the surface ships
  `pilot` at BOTH sites per ADR-0047 #3, so the button is invisible to operators
  and the API refuses them until Bill flips it. Nothing about the feature is
  observable on the floor before that. Recommend flipping ONE site first and
  watching a real walk-up land before the second — this is the first floor surface
  that writes inventory from a photo-gated capture.
- **OPERATOR ACTION — confirm the R2 CORS policy is actually applied.** Run
  `R2_ACCOUNT_ID=… ./infra/apply-r2-cors.sh --check` against `dr3-vision-photos`.
  The rule was hand-repaired 2026-08-07 and the shell that did it has closed;
  the declared policy is now in git but nothing has verified the LIVE bucket
  against it. A bucket with no rule 404s on that call rather than returning an
  empty list — which is precisely the state the months-long zero-rows outage was
  in, so the script reports it as a finding, not an error. **Do not assume it is
  configured because photos drained yesterday** — that proves the policy existed
  yesterday, not that it exists now.
- **RESIDUAL (someone else's path, deliberately not fixed here) —
  `upsertProcessedUnits` leaves `source` unchanged on update.** `src/lib/loads/
processed-units.ts` writes `source: 'manual'` in the `create` branch only, so a
  manager or operator editing a day the MyMRC bridge already created leaves
  `source = 'mymrc'` and `closed_at = NULL`. The next hourly bridge run then sees
  a `mymrc`, non-closed row whose values differ and **silently overwrites the
  human edit**. Found while tracing the `processed_units_daily` precedence rule
  for ADR-0085 D9. Folding a fix into a drop-off PR would have hidden it; it wants
  its own change and its own test. Note the contrast: `workbook-sync/upsert.ts`
  documents the OPPOSITE hazard at its line 30 (writing `source='import'` on a
  headcount-only disagreement permanently locks the bridge out), so the fix is a
  judgement about which way that trade should fall, not a one-liner.
- **RESIDUAL — the audit workbench will label the new kinds with their raw enum
  names.** `workbench-providers.ts` emits `dropoff_<kind>` rows and falls through
  `INBOUND_SOURCE_LABELS[sourceType] ?? sourceType`, so `dropoff_floor_public` /
  `dropoff_floor_incentive` render un-prettified until someone adds labels. Display
  only; no figure is affected. Left open rather than guessed at — the wording is
  Kelsey's/the office's call and this session had no basis for inventing it.
- **RESIDUAL — no same-day correction for drop-offs.** ADR-0083/Phase 4 gives the
  iPad a same-day void for COUNTS. A mistyped drop-off is a manager job through
  the existing CRUD-lite path (`/api/manager/[site]/dropoffs/[id]`). Named so it
  reads as a scope decision rather than an omission; revisit if the floor asks.
- **NOTE for whoever merges the 2026-08-07 handoff wave** — ADR-0085 bumps the ADR
  count in `CLAUDE.md` (86 → 87) and the `docs/adr/README.md` index. Phases 2 and 3
  (ADR-0082 / ADR-0083) touch the same two lines, so expect a textual conflict
  there. That is the desired failure mode: a visible conflict beats three branches
  each silently claiming a different count. Re-derive it with
  `ls docs/adr/*.md | wc -l` minus the README after the last merge.

---

## 0.AS — 2026-08-08 load claim + takeover (ADR-0082) residuals _(renumbered from a duplicate 0.AO on 2026-08-08; third section-numbering collision — see the claim-the-number rule now in docs/adr/README.md)_

- **The nine stranded loads are now REACHABLE, not resolved.** Production held 9 open
  dock loads across 5 operators at Woodland when ADR-0082 landed — oldest claimed
  2026-07-28 (11 days), one at `finished` with its units counted and never submitted, so
  outside inventory and billing. The ADR removes the reason they were unreachable; it does
  not close them. **Someone on the floor still has to pick each one up and finish or reject
  it.** Worth a look on the first shift after deploy, starting with the `finished` one
  (Pablo Ledezma, 2026-08-05) because its number is already measured and simply missing.
  Owner: floor (JT), one shift.
- **`submitted_by_id` can now legitimately differ from `assigned_operator_id`.** It never
  could before — `assertOwn` made the closer and the claimer the same person by
  construction, which is why the production figure was 0 of 40. Any consumer that treated
  those two columns as interchangeable now needs to mean one or the other: "who closed it"
  vs "who last held it". Nothing is known to be wrong today; this is a flag for whoever
  next touches load reporting/exports. Not blocking.
- **Server Action error messages are redacted in production, everywhere on the floor.**
  ADR-0082 D6 works around this for the claim case specifically (the client re-asks who
  holds the load rather than trying to read a message it cannot). But every stage
  component still renders `e.message` in its error banner, which in a production build is
  Next's redaction text rather than the reason. That is a pre-existing, general defect —
  an operator hitting a validation refusal or an illegal transition sees a paragraph about
  Server Components. Fixing it properly means the stage actions returning typed results
  instead of throwing, which is a broader refactor than this phase. **Accepted residual,
  flagged deliberately rather than expanded into.**
- **The nine open loads are "open", not proven "stranded".** The published query
  (`docs/queries/2026-08-08-open-dock-loads.sql`) cannot distinguish a load abandoned at
  lunch from a truck being unloaded right now — `in_progress` is the same status for
  both. On the 2026-08-08 reading all nine predated that Pacific day, so none was an
  in-flight unload, but that is a property of the reading and not of the query. **Re-run
  it before quoting the number to anyone**, and quote the age column with it.
- **Migration prefix `20260835` assigned to ADR-0082 and NOT used** — the claim columns,
  their index and the `AuditAction` value all already existed. The gap in the sequence is
  a decision, not a lost file.

## 0.AN — 2026-08-08 Kelsey departure config + commodity tracker classified

- **Eugene bonus ops signer: Shannon Rockwell replaces Kelsey Ruhland, effective
  2026-08-08** (Bill's instruction; Kelsey's availability ended 8/8). Executed in
  `bonus_signature_chains` (ops signer slot + facility override list), audited
  (`system:approver-swap`). Kelsey held no other approver roles (not on
  `ap_approvers`; not a second approver; zero pending items routed to her).
  NOTE: signature-request emails go to the responsible signer directly (not via
  `ap_notification_prefs`), so Shannon WILL receive Eugene period-close signature
  requests — consistent with her new duty; her 2026-08-07 "Eugene production report
  only" mail posture otherwise unchanged.
- **`Woodland Data Auditing Tracker (1).xlsx` classified**: `commodity_audit_tracker`
  / Woodland, on the document's own header evidence ("Commodity Audit (against
  Vendor Invoices) WOODLAND", 2025+2026 sheets), at Bill's written instruction
  (audited, `system:doc-classification`). AK-2's class question is answered; the
  ADR-0080 absorption will stage on the next sweep — the absorption CONFIRM
  (preview → accept) remains the human money-gate.

## 0.AM — 2026-08-08 post-wave reconciliation (docs only, no code)

Five PRs merged and deployed 2026-08-07 (#210 #211 #212 #213 #214, final live SHA
`1bbc8c3`, container up since 23:56 UTC). This section is the **index** of what is
still open after that wave — every item is stated in full exactly once, in its own
section below; nothing here is a second copy. Each line was re-measured against
production on 2026-08-08, not carried forward from a claim.

| Residual                                                                              | Lives in                              | State as re-measured 2026-08-08                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-3** — capture-time upload grant                                                   | 0.AJ / **ADR-0086 (Accepted)**        | **DONE — accepted by Bill (walkthrough 2026-08-08) and built 2026-08-08.** The §0.AJ design was unbuildable as written (grant signed over `storage_key`, but the drain re-mints a fresh key past 8 min — 100% of the target population fails its own check); ADR-0086 corrects it to a right-to-attach grant, prefix-bound object identity, revocation re-read live at redemption. **Operator step DONE 2026-08-08: secret provisioned, `photo_grants_ok: true` verified live — see 0.AP. F-3 is fully CLOSED.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **R2 bucket CORS is hand-set**                                                        | 0.AJ / ADR-0085                       | **Codified 2026-08-08** (PR #217): spec + idempotent apply script at `infra/apply-r2-cors.sh`. `--check` run 2026-08-08 (account-token path): **live policy matches the checked-in spec, exit 0. CLOSED.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **C-50** — the four 2024 TEREX tabs                                                   | 0.AL                                  | Deferred by decision. History starts 2025-01-02.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **AK-4** — Layer B commodity reconciliation rules                                     | 0.AK                                  | **Re-scoped 2026-08-08 (PR #215, `docs/plans/2026-08-08-layer-b-commodity-reconciliation-rescope.md`) — the Kelsey option is dead** (availability ended 2026-08-08; method never captured). Four premises died on checking: the tracker has no formulas (records _that_, not _how_); Shannon never initialled a commodity audit (evidence holders: Kelsey 82 / Rick 17+1 / **Janette 15**); the vendor-invoice data leg (`outbound_materials`, `outbound_material_payments`, `outbound_vendors`, `recycling_rates`, `landfilled_units`, `invoices`) is **all 0 rows in prod** — Kelsey was never the only blocker. New plan: 4a interview Rick + Janette (proposed ~2026-08-22), 4b stand up the data leg (gates everything), 4c rules. Side-finding for Rick: the two-pass audit discipline collapsed — 2025 = 76% coverage / 27 second audits; 2026 = 25% / zero.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **AK-5 (C-43)** — `sharedWithMe` November sunset                                      | 0.AK / 0.AB                           | Architecture decision pending, **decision-by 2026-10-01** (set in PR #215; one-month floor before the 2026-11-01 sunset). No successor identified; `pipeline-config.ts:171,178` verified as the dependent code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **O-16** — `March25` day 29 (131.75) hand-entry                                       | 0.AL                                  | **Verified absent in prod**: 0 rows for `2025-03-29`. Import is 319 rows, not 320, by design.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **#205 P2–P5** — claim/takeover, saves, snapshot void re-scope, dropoff               | §0.AM handoff ledger below            | **ALL FIVE PHASES SHIPPED.** P1 = ADR-0078 (2026-08-07); P3 + P4 = ADR-0083/0084, P2 = ADR-0082, P5 = ADR-0085 (all merged 2026-08-08). P5 ships dark — `ipad_dropoff` pilot flag, Bill flips at `/admin/rollout`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **ADR-0083: the AMENDED-month editor cannot set `saves`** — ~~open~~ **CLOSED**       | ADR-0083 / `AmendmentPanel.tsx`       | **CLOSED 2026-08-08 (ADR-0083 Amendment 1).** Shipped before the deadline this row named — the first signed period containing a non-zero save had not yet closed. `AmendmentPanel` grew the fifth column and now sends `saves` in its POST body; a blank box is an explicit `0` (so a value can be CLEARED), a row is keyed if EITHER box has a value (so a saves-only correction is submittable), and the day total tiers ONCE over `count + saves`. The panel seeds each saves box from the stored entry, so a note-only correction re-sends the existing figure rather than zeroing it — falsified RED at **$6.75 under-paid on one day**. **Checking it turned up a second, unreported defect:** `/bonus/months/[id]/page.tsx` computed its per-employee monthly totals AND its read-only grid totals with `calculateDailyBonusCents(mattress_count, rule)` — the last pay path in the app bypassing the `paid-units.ts` funnel, understating every processor by the whole cash value of their saves, on the very page an admin reads a corrected total on. Both call sites fixed, and ADR-0083 §2's one-funnel claim is now enforced by `paid-units-callers.guard.test.ts` (source-scanning, allowlisted-with-reasons, self-testing, asserts its own call-site count). |
| **ADR-0084 void is OWNER-scoped on a SHARED iPad** — ~~needs Bill's call~~ **CLOSED** | ADR-0084 D3 / ADR-0078 Am.1 precedent | **CLOSED 2026-08-08 (ADR-0084 Amendment 1). Bill's decision: "Widen to site."** — chosen from keep-owner-only / widen-to-site / widen-with-manager-confirm. Any activated operator at the count's SITE may now withdraw a same-day count. `SnapshotNotYoursError` / `not_your_count` / the `void_err_not_yours` string in all three locales were **deleted**, not left dead, and `listTodaysVoidableCounts` was renamed `…AtSite` — a disused check reads as an oversight and invites its restoration. The audit row now carries **both** ids (`actor_user_id` = who withdrew, `after.entered_by` = who entered, plus `cross_operator`), written on every void including self-voids so an absent field is never ambiguous. The widened gate ships WITH the disclosure: a colleague's count is labelled with their name and the confirm step says the withdrawal is recorded under the signed-in operator's name. Cross-SITE still 404s (falsified with the original enterer as the actor, so the surviving refusal is demonstrably the site check); same-day-only, confirm, soft-void and every reader filter untouched.                                                                                                                                                    |
| **ADR-0078 D1 tiebreak divergence** — 3 anchor selectors lack `created_at DESC`       | ADR-0084 §residuals                   | **Open, reported not fixed.** `leg-fetchers.startBalance()`, `cor/prefill.ts` and `loads/eod-inventory.ts` order by `snapshot_at DESC` alone, so they can name a DIFFERENT anchor than `onHand` — **including on a filed COR**. Marked in-code at all three sites. Deliberately out of ADR-0084's scope: fixing it changes which anchor a filed COR and a sent daily report select, which is a behavioural change to reported numbers and needs its own evidence + ADR. Bundled, ADR-0084's verification could not have told which change moved a number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **`snapshot-void.db.test.ts`** — ~~has never executed~~ **EXECUTED 2026-08-08**       | ADR-0084 §residuals                   | **Closed by evidence, not by CI.** Ran green (3 tests) on 2026-08-08 against an ephemeral `postgres:16-alpine` with the full chain applied via `prisma migrate deploy` — stood up from the ADR-0086 branch while proving that ADR's own `.db.test.ts`. **The "no Postgres on the build host" premise was wrong:** docker is available and an ephemeral PG16 costs about a minute, so a `*.db.test.ts` need not be shipped un-executed again. Recipe: `docker run -d -e POSTGRES_PASSWORD=… -p <port>:5432 postgres:16-alpine`, point BOTH `DATABASE_URL` and `DR3_TEST_DATABASE_URL` at it (the suites throw if they differ), then `npx vitest run --no-file-parallelism db.test.ts` — 58 tests across 10 files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **`scripts/fix-woodland-inbound.sh` hand-reproduces the anchor query**                | ADR-0084 §residuals                   | **Partly open.** The void filter was added; it still lacks a `snapshot_kind` filter and the `created_at` tiebreak, so it can disagree with `onHand`. Noted in the script. It is an operator verification script on the prod host, not app code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **ADR-0083/0084 iPad + ES/UR strings unreviewed**                                     | ADR-0084 §residuals                   | **Open, and slightly widened 2026-08-08 (ADR-0084 Am.1).** The `floor.count.void_*` keys in `es`/`ur` are machine-authored; the parity test passes, quality is unreviewed. Amendment 1 re-voiced `void_heading`/`void_intro`/`void_none`/`void_confirm_body` from second person to neutral (the old wording is actively false on a colleague's row) and added two more machine-authored keys, `void_entered_by` and `void_confirm_other`. The iPad void surface still has no rendering test, so the new "Entered by …" label and the cross-operator confirm panel are visually unverified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **O-15 / O-17** — three defects in Bill/Janette's workbook                            | 0.AL                                  | Reported, not repaired by Vision. Fixes are cell edits in `TEREX.xlsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **AK-1 / AK-2** — trailer-list + commodity-tracker confirm clicks                     | 0.AK                                  | **Both operator-classified by Bill 2026-08-08** (~00:31 PT). AK-2 (`commodity_audit_tracker`) absorbed — 252 rows in `doc_commodity_audit_rows`. **AK-1 landed on `equipment_inventory`, a class with NO absorber** — `doc_trailer_rows` = 0 and stays 0; the absorber keys on `trailer_list` (`absorb.ts:294`). **RESOLVED 2026-08-08 18:34 UTC:** Bill chose labelled-SQL reclassify (walkthrough); `doc_class` → `trailer_list` with audit row; the very next sweep (18:35:05) absorbed **96 rows** into `doc_trailer_rows`. The silent-gap defect row below remains open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **AK-3** — 8 reachable-but-unwatched documents                                        | 0.AK                                  | Open. Prod watches 3 sources; the `discovery_gap` anomaly stays open by design.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Access review — Kelsey Ruhland login still active**                                 | 0.AN / PR #215                        | **Bill's decision 2026-08-08 (walkthrough): KEEP ACTIVE for now.** Re-check ~**2026-08-22**. `is_active = true` stands deliberately; nothing misroutes (§0.AN moved signer duties; zero approver roles, zero pending items). ADR-0086's grant redemption re-reads `is_active` live, so a later deactivation also kills any outstanding photo grants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Silent gap — a confirmed `doc_class` with no absorber raises no anomaly**           | AK-1 evidence                         | **Open defect, found 2026-08-08.** The trailer list was confirmed under `equipment_inventory`; sweeps ran `ok`; 0 rows absorbed; no anomaly, no health signal. A class without an absorber should surface in `/admin/doc-ingest/health` per the ADR-0057 D9 non-silence discipline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **S-7 — `Xtraction × metal = 0.8100` seed never live?**                               | PR #215 / AK-4b                       | **Open question.** `recycling_rates` is empty in prod, so the S-7 seed either never ran or was rolled back. Resolve as part of AK-4b (the data leg).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Rollout state, read from `rollout_surfaces` on 2026-08-08 (not inferred):**
`equipment_entry`, `equipment_terex_ledger`, `equipment_trend`, `ipad_hauls` are
all **`live` at Woodland and `pilot` at Eugene** — Eugene by design, and its rows
stay registered so a deliberate "no" is distinguishable from a lookup that failed.
`ipad_count`, `ipad_inbound`, `ipad_queue`, `loads_inventory`, `reimbursement_tile`
are live at both. `workbook_sync` is registered for **Woodland only** and is still
`pilot` — the ADR-0081 history import was a one-off script run, not a sweep behind
that surface, so the surface being `pilot` is not a contradiction.

### Handoff execution ledger (2026-08-07 wave)

⚠ **The three handoff documents are NOT on `main`.** PRs **#205**, **#206** and
**#207** are still **OPEN**; each carries exactly one file under `docs/handoffs/`
that has never merged. The EXECUTED notes below therefore live here, on main,
because that is where a future session can actually read them. Attaching them to
the handoffs themselves means merging or commenting on those three PRs — a
decision for Bill, not a docs sweep.

- **#205 — floor/iPad bulletproof reliability + four operator features (JT feedback).**
  **Executed 2026-08-07 as ADR-0078 (PR #212) — P1 ONLY.** Phases **P2** (claim /
  takeover), **P3** (saves), **P4** (snapshot void re-scope) and **P5** (dropoff)
  are **still pending and unstarted**. The handoff's premise corrections — the G1–G3
  answers — are on record in ADR-0078 under "Premises that died on checking" and
  stand as the input to that eventual build. ADR-0078 **Amendment 1** (PR #214)
  followed the same day and is not in the handoff at all: Bill ordered the photo
  gate loosened from load-owner to site mid-drain.
- **#205 P3 + P4 — saves, and the same-day count void.** **Executed 2026-08-08 as
  ADR-0083 (saves) + ADR-0084 (snapshot void), one branch.** Three things are worth
  carrying forward beyond the ADRs themselves:
  (1) **Two live bypasses existed and neither failed loudly.** The four-eyes prior-day
  gate compared `mattress_count` only, so a saves-only prior-day edit would have written
  an unapproved change to somebody's pay; and the amendments endpoint's zod schema
  stripped `saves` silently, which would have produced a green audit trail for a payroll
  correction that never happened. Both are closed and both were falsified RED against the
  shipped code, not against a copy.
  (2) **A falsification measured a copy, and only attempting it revealed that.** The
  zod test originally asserted against a schema pasted into the test file — it would have
  stayed green through any change to the real endpoint. The schema now lives in
  `src/lib/bonus/amendment-schemas.ts` and both the route and its tests import it. Worth
  remembering the next time a "falsification" passes on the first try.
  (3) **The G1 and G3 rulings are now implemented, not just recorded.** G1: saves do NOT
  decrement live on-hand inventory (Kelsey's immediate-subtraction model stays retracted;
  Rick's model is what the code does), and `unit_status_movements` has its first writer
  after existing with none. G3: the void target is `site_inventory_snapshots`, NOT bonus
  entries — operators cannot reach the bonus grid and a duplicate bonus entry is
  structurally impossible there. **P2 (claim/takeover) and P5 (dropoff) remain unstarted.**

- **#206 — Terex daily processing captured by manager entry, not derived.**
  **Executed 2026-08-07 as ADR-0079 (PR #208), renumbered from 0078 by a
  concurrency ruling (PR #209).** Two deviations worth carrying forward: (1) the
  handoff's premise that the **bonus amendment workflow was a reusable house
  pattern with two or three consumers is FALSE** — there is exactly one consumer,
  and the reuse was structurally impossible (see 0.AI, F-2); prior-day edits are
  refused rather than forked. (2) The cutover did **not** hide the sheet era —
  ADR-0079 **Amendment 1** (PR #211) restored it to the chart, structurally
  labeled floor-wide, the same day.
- **#207 — doc-ingest: fix under-discovery, absorb the commodity tracker and the
  trailer list.** **Executed 2026-08-07 as ADR-0080 (PR #210).** Two reversals
  against the handoff: (1) `POST /search/query` was adopted as a **reachability
  probe only and explicitly NEVER as the enumeration** — as the enumeration it
  would widen intake to case-management and HR material, a security delta rather
  than a functional one; (2) the commodity tracker **carries no money at all**, so
  it was absorbed as audit **COVERAGE**, not as a reconciliation source — which
  changes the shape of AK-4 rather than satisfying it. The Terex cost residual
  (ADR-0077 Am.3) rode the same PR.

---

## 0.AL — 2026-08-07 TEREX workbook history import (ADR-0081) — residuals

_Renumbered 2026-08-08: this section shipped as a second `0.AK` because two
parallel branches picked the next free letter at the same time. `0.AK` belongs to
the ADR-0080 section further down, whose items are keyed `AK-1`…`AK-8`; this
section's items are `O-15`…`O-17` and `C-50`, so no cross-reference moves._

**Live in production, verified 2026-08-08:** 319 rows, `source = 'workbook_import'`,
2025-01-02 → 2026-07-24, **44,663 units / 2,045.59 run hours**, 0 voided, and
**0 manager-entered rows so far** — JT's own entries begin whenever he next enters
a day, and win over the import by construction.

Everything in this section was measured against the real R2 artifact
(`doc_sources 8a0246e7-dbb0-4de2-a90f-ddc5d4b2de4b`, version
`eed9d4cb-03c1-47cf-8ea6-081995fac4c4`, 490,670 bytes, sha256
`36308cbc54e6…cc14fa6b`, 40 sheets / 2,080 rows), not against a fixture.

### Operator actions — three of these are fixes in Bill/Janette's spreadsheet

Vision **reports** these; it does not repair them. Every one is a defect in the
source workbook, and correcting it there is what makes the workbook's own
published totals true again. None of them blocks the import — the rows are read
correctly and the import ran green.

- **O-15 — two monthly tabs total a SHORTER row range than their own data, so
  the workbook's published totals under-report. Fix the SUM ranges in
  `TEREX.xlsx`.**

  | Tab       | Formula as written                                       | Rows the block actually reaches | Omitted                                                         |
  | --------- | -------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------- |
  | `March25` | units `SUM(B3:B30)` / `SUM(C3:C30)`; hours `SUM(G3:G33)` | through row 33                  | row 31 (day 29) **131.75 coils**; row 33 (day 31) **157 coils** |
  | `Dec25`   | units `SUM(B3:B32)`; hours `SUM(G3:G32)`                 | through row 33                  | row 33 (day 31) — **182 coils and 7.45 hours**                  |

  Arithmetic closes exactly, which is how we know the defect is the formula and
  not the reading: `March25` publishes 1483 + 57 = **1540** and the extraction
  reads 1540 + 131.75 + 157 = **1828.75**; `Dec25` publishes **1675** units /
  **67.99** hours and the extraction reads 1675 + 182 = **1857** and
  67.99 + 7.45 = **75.44**. On `March25` the hours formula covers the whole block
  while the units formulas do not, which is exactly why hours reconciled to the
  cent and units were out by 288.75.

  **The fix is one cell each** — widen the units SUM on `March25` to reach row 33
  and both SUMs on `Dec25` to reach row 33. Until then, anyone reading the
  workbook's own monthly totals for March 2025 or December 2025 is reading a
  figure short by 288.75 units, or by 182 units and 7.45 hours respectively.
  Vision's imported history already carries the full, correct figures.

- **O-16 — `March25` day 29 reads `131.75` pocket coils. A manager must enter
  that day deliberately; the import will not guess it.**

  The only fractional-unit cell in the whole workbook. `units_processed` is
  `INTEGER NOT NULL`, so the row cannot be stored as written and **every way of
  storing it anyway is a lie**: `132` invents a quarter of a mattress, `131`
  discards one, and either puts a number nobody wrote into a table whose whole
  premise is that the figures are the operator's own. The row is skipped,
  counted, and named in the import report — which is why the import produced
  **319** rows and not 320.

  Two ways to close it, either is fine: correct the cell in `TEREX.xlsx` to a
  whole number and re-import (the new revision supersedes cleanly, ADR-0081 R4),
  or have a Woodland manager enter 2025-03-29 through the ordinary ADR-0079
  entry path — a manager's row wins over the import by construction, so a later
  re-import will leave it alone.

- **O-17 — `OVERVIEW2026` row 12 computes July's "High" units/hour with
  `MINIFS` where it means `MAXIFS`. A formula bug in the workbook.**

  Cosmetic to Vision and consequential to anyone reading the OVERVIEW tab: the
  cell labelled "High" reports the month's **lowest** qualifying rate. This is
  the specific reason OVERVIEW-derived reconciliation checks are **advisory**
  rather than hard gates (ADR-0081 R5) — making every published cell blocking
  would let the workbook's own bug refuse a correct import. Fix the function
  name in the sheet; no Vision change follows.

### Proposed follow-up (recorded, NOT built in v1)

- **C-50 — the four 2024 tabs are out of v1. They are four bespoke schemas, and
  one extractor that "handles" all four is how a wrong number gets a confident
  label.**

  The imported history therefore starts **2025-01-02**. The four are excluded
  _by name_ rather than merely unmatched (`TABS_2024_OUT_OF_SCOPE`), so the
  import report says "out of scope for v1 (four bespoke 2024 schemas)" for these
  and "not a monthly operating tab" for `diesel` — a reader can tell somebody
  looked. What each one actually is, measured:

  | Tab      | Shape                                                                                                                                                                                              |
  | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `Sept24` | header on **row 1**: `Date \| Processed \| Received \| Hrs Used` — a real date column, and `Processed`/`Received` rather than the three commodity columns                                          |
  | `Oct24`  | doubled per-commodity layout with **three** separate `Hrs Used` columns                                                                                                                            |
  | `Nov24`  | a distinct shape again — not characterised further in this pass                                                                                                                                    |
  | `Dec24`  | carries `Start Time` / `End Time` **clock times**, not hour-meter readings — so run hours would have to be derived from wall-clock, which is a different measurement from the machine's hour meter |

  `Dec24` is the one that decides this is not a small job: every other tab in the
  workbook reports hours the machine **ran**, and a clock-time span reports hours
  a person was **there**. Importing them as the same quantity would put two
  different measurements on one line with no way to tell them apart afterwards —
  the exact defect class ADR-0079 D2 and ADR-0077 exist to prevent.

  **Not urgent.** The 2025–2026 history is nineteen months deep and the gap is
  visible rather than silent. Worth doing as its own pass, per-tab, each measured
  against the real bytes — or worth declining outright if Bill decides four
  months of 2024 at four schemas is not worth the surface area.

---

## 0.AJ — 2026-08-07 iPad reliability (ADR-0078) — residuals

### Operator actions

- **O-12 — the iPads must ACCEPT THE UPDATE PROMPT before any of this reaches
  them.** The floor devices are kiosks and the service worker does not
  `skipWaiting`, so a deploy strands every iPad on the bundle it already has —
  indefinitely, if nobody taps. Until then a device keeps sending the old
  request shape (no `countDate`), which the server still accepts by design, and
  keeps running the OLD queue code, which has no conflicts screen and no
  connection indicator. **Nothing in this ADR is live on a device until its
  operator accepts the prompt.** Confirm per-device: the chrome shows a
  connection pill, and `/operator/<site>/queue/conflicts` resolves.

- **O-13 — drain the parked photo queue on JT's iPad. — SUBSTANTIALLY DONE; one
  more Retry-all is wanted.**

  **Measured in production 2026-08-08: `load_photos` holds 85 photos across 34
  loads.** The saga in one line: **0 forever → 4** (the R2 CORS repair) **→ 47**
  (the ADR-0078 app-level drain engine, PR #212) **→ 85** (once ADR-0078 Am.1,
  PR #214, stopped the gate refusing another operator's rows). Against the ~103
  the device was known to be holding, **roughly 18 rows are still parked** and
  should come across on one more **Retry all** from the conflicts screen.

  **The per-operator caveat is now simply GONE, not conditionally gone.** Am.1 is
  merged and live (`1bbc8c3`), so the photo gate is site-scoped: any operator
  signed in at the site drains every row on that device. The original wording —
  "rows whose loads belong to another operator's login will refuse again; those
  need that operator signed in on that device" — described the pre-Am.1 build and
  must not be followed. Cross-SITE rows would still refuse, but a floor iPad only
  ever holds its own site's loads.

  **`uploaded_by` attribution is live and correctly EMPTY.** All 85 rows carry
  `uploaded_by IS NULL` because every one of them predates Am.1's flip; that is
  the honest reading, not a defect. The first attributed row will be the next
  photo uploaded. Do not "backfill" it — there is no record of who took those.

### Proposed follow-up (recorded, NOT built in P1) — **BUILT 2026-08-08 as ADR-0086**

> **The design recorded below is the ORIGINAL and it does not work.** It is left in
> place unedited because ADR-0086 §4 is a correction _of this text_, and deleting it
> would leave that correction with nothing to correct. **Do not build from this
> paragraph.** The grant is signed over `storage_key`, but the drain re-mints a fresh
> key past eight minutes — so the field-match check fails on 100% of the population the
> feature exists for. `docs/adr/0086-capture-time-photo-upload-grants.md` is the
> authority; the shipped grant binds the load + kind + idempotency key and constrains
> object identity by PREFIX instead.

- **F-3 — capture-time upload grant, so a photo can drain with no live session.**
  ADR-0078 G7 fixed the auth failure that _looked_ like success, and G8c makes
  recovery one tap. What remains: on iOS the queue still needs a signed-in
  session to drain, because there is no closed-app execution to fall back on.

  Design, in full so it does not have to be re-derived:
  `/api/photos/upload-url` additionally returns `upload_grant`, an HMAC-signed
  token (`node:crypto`, one new secret `PHOTO_GRANT_SECRET`) over
  `{v, load_id, kind, storage_key, actor_user_id, site_id, idempotency_key,
exp ≈ 14d}`. Both photo routes accept **a session OR** an `X-Upload-Grant`
  whose signature validates and whose fields match the request EXACTLY — the
  grant authorises one upload of one photo to one load, nothing wider. Both
  routes move to the established route-handler-is-the-real-gate pattern
  (`public-paths.ts` precedent) rather than being exempted at the middleware.

  **Deliberately not bundled with ADR-0078.** It introduces a bearer credential
  that authorises a write, which needs its own secret provisioning and rotation
  runbook plus falsification tests (forged signature, expired grant, field
  substitution, cross-load replay) — and a credential like that must not ride
  along on a money-path PR as a rider. Wants its own ADR.

### Accepted residuals (recorded, not actions)

- **R2 bucket CORS is HAND-SET INFRASTRUCTURE, not code.** The
  `dr3-vision-photos` bucket had no CORS rule from the day the photo feature
  shipped, so 100% of browser uploads failed the preflight and `load_photos`
  held zero rows — invisibly, because a request that dies at preflight never
  reaches the server. Repaired 2026-08-07 via the Cloudflare API
  (`origins: [https://dr3-vision.svdp.us]`, `methods: [PUT, GET, HEAD]`,
  `headers: [content-type]`, `maxAge 3600`).
  **The configuration now exists only in a shell history.** A bucket recreated,
  a second environment stood up, or an account-level change silently
  reintroduces the identical outage. Smallest honest codification, in order of
  preference: (1) a checked-in `infra/r2-cors.json` plus a small apply script,
  so the intended state is reviewable and re-appliable; (2) failing that, a
  startup assertion that performs one OPTIONS preflight against the bucket and
  refuses to report healthy on a non-204. Not bundled with ADR-0078 because it
  is infrastructure-shaped, not application-shaped, and deserves its own review.
  ADR-0078's client-side mitigation (`blocked:` / `uploads-blocked`) makes a
  recurrence VISIBLE within one sweep; it does not prevent one.
  **STILL OPEN 2026-08-08, and it is now the only unclosed piece of the drain
  saga.** The repair is proven — 85 photos have crossed the preflight since — but
  proof that it works is not the same as codification, and this is the one item
  where a silent recurrence would look exactly like the original outage. Option
  (1), a checked-in `infra/r2-cors.json` plus an apply script, remains the
  recommendation.

- **`src/lib/events/sequences.test.ts` has never run in CI.** It is gated on
  `DR3_TEST_DATABASE_URL`, which nothing in the repo sets, so it self-skips
  everywhere — a real-concurrency proof that has proven nothing since it was
  written. ADR-0078 adds a CI step running `src/**/*.db.test.ts` against the
  `migrations` job's real Postgres; `sequences.test.ts` does not match that glob
  (it is `.test.ts`, not `.db.test.ts`). Either rename it or widen the glob —
  deliberately not done here, because it needs the ADR-0041 migration and a look
  at whether it still passes, which is not this change's scope.

- **Inbound and processed writes are response-deduped, not atomically claimed.**
  Both services own their internal transactions, so the idempotency claim and
  the business write are not in one transaction. The residual failure is
  one-directional and benign — the write can commit while the claim rolls back,
  costing the dedupe on a later retry, and that retry converges on the same row
  because both writes are already convergent (an upsert and a day-keyed
  delete-then-write). The dangerous direction cannot occur. Making them fully
  atomic means threading a transaction through both services and changing their
  lock footprint, which buys nothing today.

---

## 0.AK — 2026-08-07 ADR-0080: discovery reachability + commodity absorption

### Decisions waiting on Bill

- **O-2/AK-1 — confirm the TRAILER LIST classification.** `Woodland Trailer list.xlsx`
  has `doc_class = NULL` and is waiting on the confirm click at `/admin/doc-ingest`.
  The absorption path is **verified end-to-end against the real archived bytes**:
  the extractor reads the live workbook and yields **96 rows**, 41 distinct entry
  dates, 19 rows with no recorded weight (correctly `NULL`, never `0`), sheet
  `Trailer List Woodland 2025`. The read surface at `/admin/doc-ingest/trailers`
  is already version-scoped (newest revision wins). **Claude Code did not and must
  not confirm this** — `confirmClassification` writes `classified_by` +
  `doc_class_source='operator'`, and Vision must not stamp Bill's name on a
  decision he did not make. Ready to confirm.
  **STILL UNCONFIRMED, verified in prod 2026-08-08:** `Woodland Trailer list.xlsx`
  has `doc_class IS NULL`, `doc_class_source IS NULL`, `site_id IS NULL`, and a
  `proposed_class` of `equipment_inventory`. Bill's click is the whole remaining
  step; nothing else waits on anything.
- **AK-2 — confirm the COMMODITY tracker classification** (`commodity_audit_tracker`),
  same discipline, once the extractor fix below lands.
  **STILL UNCONFIRMED, verified in prod 2026-08-08 — and one detail changes what
  the click is.** The extractor fix landed with ADR-0080 (PR #210), so the stated
  precondition is met. But the row (`Woodland Data Auditing Tracker (1).xlsx`)
  carries `proposed_class = 'unknown'`, **not** `commodity_audit_tracker` — the
  classifier declines to guess it, which is exactly the outcome C-35 predicted for
  a document with no naming convention behind it. So this is not a one-click accept
  of a proposal: Bill has to **choose** the class and the site. Correct behaviour,
  and the reason the click cannot be automated away.
- **AK-3 — review the 8 reachable-but-unwatched documents** now listed on
  `/admin/doc-ingest/health`: `DR3 Machine List (2).xlsx`, `TEREX.xlsx` (Kelsey's
  copy — a SECOND copy, distinct from the watched one in Janette's drive),
  `JOURNAL Woodland Facility.xlsx`, `DR3 Data Tracking.xlsx`,
  `DR3 Meeting Notes Log 2026.xlsx`, `DR3 Task Lists for 2025.xlsx`,
  `Woodland Invoices tracking.xlsx`, `Woodland Outbound Auditing 2026.xlsx`.
  Nothing is registered automatically; each is a decision. Until reviewed, the
  `discovery_gap` anomaly stays open — that is intended, not noise.
  **Unchanged 2026-08-08:** `doc_sources` still holds exactly **three** watched
  rows — `TEREX.xlsx` (confirmed), the trailer list and the commodity tracker
  (both unconfirmed). None of the eight has been adopted.

### Blocked on a stakeholder

- **AK-4 — Layer B: the commodity RECONCILIATION RULES are NOT built and are
  blocked.** Layer A (absorb + display) is what shipped. The rules — which
  discrepancies matter, which source is authoritative per field, ranked by dollar
  impact — need the audit-method capture from Kelsey (availability ends 8/8) as
  their requirements document. **Additional finding that changes this item's
  shape:** the tracker carries no figures at all (ADR-0080 D7), so "reconcile the
  tracker against Vision" is not a thing that can be specified from this document
  alone; the rules will need whichever document actually holds the commodity
  figures. Ask her which one that is. Do not invent thresholds in the meantime.

### Architecture decision required BEFORE November 2026

- **AK-5 (C-43) — the shared-item enumeration has no successor.** `GET /me/drive/sharedWithMe`
  is deprecated, **already degraded in production** (the 1-item response is the
  degradation), and stops returning data in **November 2026** — Microsoft published
  a month, not a day, so our `2026-11-01` is a conservative inference and is now
  labelled as one in code and on the health page. The whole "owners share, Vision
  reads in place" model rests on it. Findings that narrow the options:
  - `/me/insights/shared` (10 items, correctly scoped, carries `sharedBy`) is
    deprecated **on the same date**, requires `Sites.Read.All`, and can be disabled
    tenant-wide _or per-user_ via ItemInsights settings — returning an empty 200
    with no error. Not a successor.
  - `SharedWithUsersOWSUser:"docs-dr3@svdp.us"` — the documented SharePoint
    "shared with this person" managed property — **was tested against this tenant
    and returned total = 0** (it indexes only "Specific people" shares; ours are
    link shares). Not a usable narrowing. Recorded so nobody re-derives it.
  - `POST /search/query` works and is now wired as the reachability probe, but it
    answers "what can this identity READ" (11,442 items tenant-wide) rather than
    "what was shared with it". Adopting it as the enumeration would widen Vision's
    intake to case-management and HR material — a security delta, not just a
    functional one.

  ADR-0080 ships the transport and the scope discipline; **it does not decide
  this.** Owner: Bill + Claude Code, needs a decision well before November.

### Code follow-ups (accepted residuals, not bugs)

- **AK-6 — `distinctProcessors` now exists twice.** The canonical implementation is
  `src/lib/bonus/processor-count.ts`; `src/lib/bonus/daily-report.ts` retains a
  private twin, deliberately untouched this session to keep the bonus daily report
  byte-identical. Collapse the twin onto the module the next time that file is
  legitimately opened. The module header says so in place.
- **AK-7 — `CorClient.tsx` label is now inaccurate.** It reads "Pre-fill from
  month-end close …: employees …, processors …", but the processors figure is no
  longer close-derived (ADR-0076 follow-up). The _number_ renders correctly (`??`,
  so a real `0` shows as `0` and only a genuine null shows `—`); only the sentence
  is stale. Copy fix, not a correctness fix.
- **AK-8 — DONE (2026-08-07).** Terex cost `$0.00` → "not recorded" shipped as
  **ADR-0077 Amendment 3** (not Amendment 2 — that number was already taken by the
  independent-audit observations). Landed after the ADR-0079 stream merged, on a
  rebase, in its own commit. Original note retained for the record: ADR-0077 fixed the identical bug for downtime and explicitly left the
  cost residual, because cost is genuinely partly populated (7 of 68 events) and is
  therefore the weaker case. **Corrected file target:** it lives in
  `src/lib/equipment/throughput.ts` plus `EquipmentClient` / `OpsOverviewPanel` /
  `throughput.test.ts` — **not** `terex-ledger.ts` as the originating handoff
  stated (verified by reading the code). Those exact files were rewritten on a
  parallel branch (PR #206), so this lands afterwards, on a rebase, as **ADR-0077
  Amendment 2** in its own commit. Widen `totalCostCents` to `number | null`,
  update `costUsd` consumers, and keep a real `$0` distinct from an absent one.

## 0.AI — 2026-08-07 Terex daily throughput (ADR-0079) — follow-up

- **F-2 — the amendment workflow is bonus-specific and could not be reused; equipment
  prior-day edits are REFUSED until it is generalized.**

  ADR-0079 D4 needed prior-day Terex corrections to route through "the existing
  bonus amendment workflow". They could not, and the blocker is structural rather
  than cosmetic. What was found:
  - **`resolveAmendmentApprover` (`src/lib/bonus/amendment-approvers.ts`) throws
    `AmendmentWorkflowForbiddenError` for any requester who is not a bonus payroll
    signer**, because it sources the approver from `bonus_signature_chains` — the
    payroll PDF dual-signature roster. A Woodland equipment manager is not
    necessarily one. This alone is disqualifying: reuse would hand _the exact
    audience the feature is for_ a 403 they could do nothing about.
  - `bonus_amendment_requests` carries two `NOT NULL` FKs to bonus-specific tables
    (`bonus_pay_periods`, `bonus_employees`, both `ON DELETE RESTRICT`) and has
    **no** polymorphic targeting — no `subject_type`, no generic `row_id`.
  - `applyApprovalInTx` writes `tx.bonusDailyEntry` literally, with no dispatch
    point, strategy or writer interface.
  - Four DB-level CHECK constraints (including `char_length(justification) >= 20`)
    live only in raw SQL, invisible in `schema.prisma`.

  **The handoff's premise that this pattern already had two or three consumers is
  false — there is exactly one.** `shouldRequireAmendment` has a single non-test
  importer (`src/lib/bonus/daily-entry.ts`). `processed_units_daily`, the presumed
  second, uses a _lock_ rather than a four-eyes gate ("That day is already closed
  and locked — ask Bill to run the amendment path"). The ~40 files mentioning
  "amendment" are overwhelmingly ADR-revision naming ("ADR-0077 Amendment 1"), and
  that collision is almost certainly what produced the false premise. **Worth
  re-checking before any future work assumes a house pattern exists here.**

  **Current behaviour (shipped):** same-day entry/edit is free and audited; a
  prior-day change returns `409 requires_amendment` with the target date, today,
  the on-record values and the proposed values, and the UI tells the manager to
  send the date and corrected numbers to the office. Nothing is written. No
  parallel amendment system was forked.

  **Smallest generalization proposed** (roughly in dependency order; ~1 focused PR):
  1. **Lift `shouldRequireAmendment` into a domain-neutral module.** It is already
     a pure, DB-free function whose only bonus leaks are the literal `'draft'`
     state check, a `{ mattress_count, note }`-shaped `oldValue`, and its location.
     Parameterize the value shape and replace `periodState !== 'draft'` with an
     `isLocked: boolean`. ~15 lines.
  2. **Add a nullable `subject_type` discriminator + generic target columns to
     `bonus_amendment_requests`**, and relax the two bonus FKs to nullable _for
     non-bonus subjects only_ (a CHECK enforcing "bonus rows still carry both").
     The repo's own `AuditLog` (`table_name` + `row_id`) is the in-house
     polymorphic precedent. This is the only schema change and the only risk to
     the live payroll path — it must not weaken bonus-row integrity.
  3. **Introduce an approver-source interface** so equipment can resolve an
     approver from something other than `bonus_signature_chains`. This is the
     genuinely new design work: _who_ countersigns an equipment correction is a
     product question for Bill, not a code question.
  4. **Add a writer interface at `applyApprovalInTx`** so approval dispatches to
     the target table instead of naming `bonusDailyEntry`.
  5. Generalize `RequestEditBatchModal` (note: `RequestEditModal` singular does not
     exist; the batch modal superseded it) — its structure and a11y are reusable,
     its props and hardcoded `/api/bonus/amendments` endpoint are not.

  **Blocked on a product decision at step 3.** Not urgent: the refusal is honest,
  visible, and routes to a human who can act. Revisit when a second non-bonus
  surface needs prior-day approval, so the generalization is driven by two real
  consumers rather than one plus a guess.

- **F-4 — production carries a STALE `_prisma_migrations` row named
  `20260830_adr0078_equipment_daily_throughput`. It is ADR-0079's work, not
  ADR-0078's. Harmless; do not "fix" it by deleting the table.**

  This ADR shipped as 0078 and was merged + deployed before a concurrency ruling
  reassigned 0078 to the parallel iPad-reliability stream. The ADR, migration
  directory and all ~30 in-source citations were renumbered to **0079** and the
  migration directory re-prefixed to `20260831_` so it sorts after the
  reliability stream's `20260830_`. Production had already applied the old name.

  **The renamed migration therefore re-applies once as a clean no-op** — every
  statement is `CREATE TABLE / CREATE INDEX ... IF NOT EXISTS`. Verified on an
  ephemeral PG16 by reproducing prod's exact state (old name applied), renaming,
  and re-running `prisma migrate deploy`: exit 0, table and all four indexes
  intact, `migrate status` reports "Database schema is up to date!". Prod ends
  with **two** applied rows for one table, which Prisma tolerates.

  **Two warnings for anyone reading prod's migration ledger:**
  1. The `20260830_adr0078_…_equipment_daily_throughput` row does **not** belong
     to ADR-0078 (iPad reliability). The prefix collision is historical, not
     semantic. The reliability stream's own
     `20260830_adr0078_ipad_reliability_idempotency` is a different directory and
     does not conflict.
  2. Deleting the stale row is optional cosmetic tidying and is **not** required.
     Deleting the _table_ would destroy manager-entered production data.

- **F-3 — the derived floor number is retained but has no reconciliation rule.**
  ADR-0079 D5 keeps `derivedFloorUnits` and `legacyDerivedUnitsPerRunHour`
  computable so an entered-vs-derived cross-check is buildable (a manager entering
  40 units on a day the floor stripped 400 is either a light day or a typo).
  **Deliberately no rule in v1** — that is reconciliation-layer work and is blocked
  on Kelsey's method. The inputs are in place; only the rule is missing.

## 0.AG — 2026-08-05 Processor headcount (ADR-0076) — follow-up

- **F-1 — the COR month-end headcount pre-fill renders `—` and now has an easy fix.**
  `src/lib/cor/prefill.ts` reads `processed_units_daily.employees_count` /
  `processors_count`, which are NULL on all 987 prod rows (never written by any of
  their four write paths). ADR-0076's `distinctProcessors` helper computes the real
  figure from the payroll source in ~21 ms. Small change + tests when the COR
  surface next gets touched; deliberately not bundled with ADR-0076 to keep that
  change email-only.

## 0.AF — 2026-08-04 ADR-0075: a name collision becomes a fork, not a wall

Shipped today. Additive schema (`merged_into_id` + `merged_by` + `merged_at`), a
second resolve mode, collision suggestions, and an admin merge tool. No invoice,
amount or approval is touched by any of it. **Two operator actions, both of which
need a human to confirm a physical fact — neither was performed by the session
that shipped this.**

### Operator actions

- **O-10 — Bill merges the three Woodland Terex rows. — DONE (2026-08-06, ADR-0077 D1).**
  Executed by Claude Code at Bill's written instruction (handoff PR #197), through
  `mergeEquipment` — the same audited transaction the admin Merge button drives —
  under `actor_label: system:terex-canonical-merge`, with `actor_user_id` and
  `merged_by` left NULL rather than borrowing a person's id.
  **The direction below is WRONG and was corrected.** The survivor is `7e35a4aa`
  (`Terex`), NOT `bee54def`: a merged-away row keeps its `display_name`, so
  merging into `bee54def` would have left the survivor permanently called `Terex
  Machine` with the wanted name frozen on a dead row that `(site_id,
  display_name)` uniqueness forbids reusing. `7e35a4aa` also already held 2 of
  the 4 links and 2 of the 4 resolved requests.
  **Verified:** one active unmerged row (`7e35a4aa`, category `terex`); both
  losers `is_active=false` + `merged_into_id=7e35a4aa`; 4 of 4 links and 4 of 4
  resolved requests on the survivor; spend **202,492 cents before and after**
  (`COALESCE(confirmed_amount_cents, amount_cents)`); three audit rows.
  **Unblocks** the case-insensitive-unique-index ADR — no violating group remains.

  _Original text, retained for the record:_ Production carries
  **three records for one machine**, each cited by a different approved invoice:
  `7e35a4aa` (`Terex`), `bee54def` (`Terex Machine`), `1125fb30` (`Terex
machine`). The intended merge is **`7e35a4aa` and `1125fb30` INTO `bee54def`**
  — but **a human must confirm they are the same physical machine first.**
  `Terex` in particular is a bare name that could plausibly be a second unit;
  canonical detection deliberately does NOT treat it as a match for the other two
  (ADR-0075 D3), so this is a judgement call, not a lookup.
  Use `/admin/equipment` → _Merge into…_ on each row to be merged away, pick the
  survivor, confirm. While there, **fix the survivor's category to `terex`** —
  all three were created as `vehicle`.
  **This BLOCKS any future case-insensitive-unique-index ADR.** That index cannot
  be built while a violating group exists, and migrations run in the deploy's
  init container — attempting it today would crash-loop the deploy, not fail a
  review (ADR-0075 D3).

- **O-11 — Bill resolves open request `a2ab144d` ("trailer 540010", Woodland). — DONE (verified 2026-08-06).**
  Already satisfied in production: the request is `resolved` against `3c063c8d`
  (`trailer 540010`, the row that already existed), `resolved_at 2026-08-06
17:15`. **No fourth duplicate was created** — the expected outcome below held,
  so the ADR-0075 suggestion path fired as designed.

  _Original text, retained for the record:_
  This is the acceptance click for the whole ADR. The asset **already exists** —
  `3c063c8d`, `trailer 540010`, active, Woodland — so the old code path would have
  hit the same wall that produced the Terex split and manufactured a fourth
  duplicate. Open `/admin/ap/equipment-requests`, choose _Add to the fleet_, and
  the existing row should surface as a suggestion: click **Use this one**.
  **Expected outcome: NO new equipment row.** The request stamps `resolved` against
  `3c063c8d` and the original invoice link repoints at it. If a new row appears
  instead, the suggestion path did not fire and that is a defect worth reporting.

### Accepted residuals (recorded, not actions)

- **Detection has a known blind spot.** `canonicalizeName` folds case and strips
  punctuation, so `Terex Machine` ≡ `terex machine`. It does NOT match `Terex`
  against `Terex 2` — those are plausibly different machines and conflating them
  automatically would silently rewrite what approved invoices name. The merge tool
  plus a human is the answer for that class; there is no plan to widen the matcher.
- **Merge is an admin escalation.** A site manager who spots a duplicate resolves
  correctly against the survivor (which they can do) but cannot merge the stray
  rows themselves — declaring two records to be one machine rewrites financial
  attribution and is not reversible from the UI. Intended trade.

## 0.AH — 2026-08-06/07 ADR-0077: one Terex, and the downtime that was never there

**STATUS: every operator action in this section is DONE (2026-08-07).** O-12
(classify + absorb + accept), O-13 (downtime capture), O-14 (rollout flip) all
executed at Bill's written instruction; an independent verification pass returned
CLEAN on all shipped scope. What remains below is residuals only.

_(O-numbers below are scoped to this section, as in 0.AF — the 2026-07 table further down reuses the same numerals.)_

### Operator actions

- **O-12 — classify + absorb + accept `TEREX.xlsx`. — DONE (2026-08-06).**
  Executed by Claude Code at Bill's written instruction ("you need to classify and
  accept everything"), through `confirmClassification` / `applyVersion` /
  `decideTerexBatch` under `actor_label: system:terex-absorption`, with
  `actor_user_id` NULL. Registered as `terex_maintenance_log` / **Woodland** —
  Bill's own words settled the site ("the terex machine operates exclusively at
  woodland").
  **Accepted: 80 rows, $77,067.94 repair / $4,025.36 credited**, matching
  ADR-0069 Am.2 to the cent and verified live after the write.
  **It tried to count itself three times.** Registering the source made all three
  applied revisions absorbable at once — 240 staged rows, $231,203.82, exactly
  3 × the real figure. Per revision the arithmetic was perfect; the ADR-0069 Am.2
  de-duplication is WITHIN a version and was never meant to cross revisions. The
  two superseded revisions were discarded through the audited decision path, and
  `computeTerexLedger` is now version-scoped (newest absorption wins) so the total
  does not depend on that tidying having happened. See ADR-0077 D9.

- **O-14 — flip `equipment_terex_ledger` live for Woodland. — DONE (2026-08-06).**
  Flipped through `flipRolloutSurface` (the one audited place a rollout state
  changes) under `actor_label: system:terex-ledger-flip`, with the acceptance
  figures as the criteria note. **Woodland `live`, Eugene `pilot`** — and Eugene's
  row STAYS: an unregistered surface resolves to admin-only via a caught
  exception, so deleting it would make a deliberate "no" indistinguishable from a
  lookup that quietly failed. Bill: "eugene has no use or need for this data at
  all." **The ledger is now visible to Bill, Morena and Janette at Woodland.**

- **O-13 — the downtime capture path. — DONE (2026-08-06).** Bill: "ok build the
  downtime capture path." **It was already built** (ADR-0044): `hours_down` on
  `equipment_events`, bounded + kind-restricted validation, audited in-transaction
  write, soft-void correction, API zod guard, and an entry form that reveals the
  hours input for downtime kinds. What was missing was REACH —
  `equipment_entry` was `pilot`, so no Woodland manager could see the form, which
  is why `hours_down` was NULL on all 68 rows (they came from the ADR-0048
  importer, not a person). **`equipment_entry` flipped live at Woodland**
  under `actor_label: system:terex-ledger-flip`. Eugene stays `pilot`.
  Design choice + rejected alternatives recorded in ADR-0077 D11.
  **Residual — CLOSED 2026-08-07:** `equipment_trend` was `pilot` at Woodland when
  this was written; Bill ordered the flip and it went `live` at **15:10 UTC**
  (audited, `system:claude-code`). Eugene stays `pilot` by design. Verified against
  `rollout_surfaces` 2026-08-08.

### Accepted residuals (recorded, not actions)

- **The Terex machine view SHIPPED, dark** (ADR-0077 D6/D7/D8) — the flip is
  O-14 above. Detail view at `/dashboard/[site]/equipment/[equipmentId]` under the
  ADR-0044 tile (not a parallel tile), gated on `admin OR
(can_resolve_equipment_requests AND site reach)` = exactly Bill, Morena and
  Janette. **No event↔invoice matching in v1** (all four invoices share one vendor
  inside six days; any heuristic would manufacture links) — revisit only when a
  real match need is observed, never speculatively.
- **The ledger identifies "the Terex machine" by proxy, not by declaration.**
  `category: 'terex'` is the ADR-0062 seed's category for SHEAR MACHINES —
  production carries `EQ24/EQ43/EQ74 — Shear Machine` at Woodland and `EQ65 —
Sheer Machine Shear Machine` at **Eugene**, none of them the machine. Because
  `doc_terex_maintenance_rows` is keyed by SITE and `equipment_events` by a
  free-text `equipment_code` with no FK, pointing the ledger at one of those rows
  would render the Terex's money under a shear machine's name. `isSiteTerexMachine`
  therefore also requires that the Terex invoices resolve to the row. That is
  evidence-based and self-correcting, but it is a proxy: **the real fix is a link
  from the absorbed rows (or `equipment_events`) to an equipment id.** Do that
  before a second Terex-class machine ever exists.
- **`can_resolve_equipment_requests` now grants TWO things.** It unlocks the
  equipment-request worklist AND the machine ledger, so granting it to a fourth
  person also shows them one machine's whole invoice history. Correct default
  (the person who decides what an asset IS should see what it has cost), but it
  is a second effect of ticking a box that used to have one.
- **`summary.totalCostCents` has the same shape of defect as downtime had, one
  notch weaker.** It sums to `0` and renders `$0.00` when no event carried a cost.
  Not widened to `number | null` in this pass because the column IS genuinely
  populated (7 of 68 Terex events), so `$0.00` is a much weaker claim than "0.0
  hrs" on a never-written column, and the change ripples into `costUsd` on the
  overview panel. Fix it when that panel is next opened.
- **`equipment_events` cost coverage is 7 of 68 rows.** The ADR-0048 import
  carried costs on a tenth of the history. Decide re-import vs retire when the
  ledger view is picked back up — it is NOT the AP cost ledger and must never be
  blended with it as the same money.
- **The rollout flag hides the PAGE, not the API** (audit D4). The ledger's GET
  route does not consult `equipment_terex_ledger`; the access gate
  (`requireEquipmentLedgerAccess` + `ledgerReaches`) bounds the audience
  independently. Intended: a rollout gate is a VISIBILITY ramp, never an
  authorisation boundary. Recorded in ADR-0077 Amendment 2 so nobody reaches for a
  flag when they need access control.
- **`linkedCents <= totalCents` is tautological until matching exists** (audit
  D2). v1 sets `linkedCents` to a literal 0. Kept deliberately — the guard should
  predate the feature it guards. Not evidence of a working matcher.
- **A merge audit row should carry the money, not just the counts** (audit D5).
  ADR-0075's merge audit records `repointed_links` / `repointed_equipment_requests`
  but not the cent total, so proving conservation meant re-deriving it from
  `ap_requests`. A future merge should stamp
  `COALESCE(confirmed_amount_cents, amount_cents)` into the audit `after` payload.
- **`equipment_trend` — DONE (2026-08-07 15:10 UTC), no longer a residual.**
  _(This entry was a mangled splice of the original residual and its closing note;
  rewritten 2026-08-08 against `rollout_surfaces`, which is the authority.)_
  It was written when entry and the ledger were live at Woodland but the trend
  CHART was not, so managers saw the entry form and the ledger link with no
  throughput graph. Bill ordered the flip; `equipment_trend` is **`live` at
  Woodland** (audited, `system:claude-code`) and **`pilot` at Eugene** by design.
  With ADR-0079 Am.1 and ADR-0081 both landed, that chart now carries the combined
  series — nineteen months of imported sheet-era history alongside whatever JT
  enters from here.
- **Shannon's AP second-approval emails disabled 2026-08-07** at Bill's
  instruction. She now receives **only** the Eugene daily production report.
  **Routing is unchanged** — requests still route to her, so anything assigned to
  her will age to escalation **silently**. If that becomes a problem the fix is a
  routing change, not re-enabling the mail.
- **The TEREX preview page targets `stagedRows[0].doc_source_version_id`.** With
  two staged versions live at once, the Confirm button acts on whichever sorts
  first. Harmless today (one staged version); a trap the day there are two.

---

## 0.AE — 2026-08-03 ADR-0074: the iPad's open portal-haul surface

Shipped tonight (CHANGELOG 2026-08-03 night). Additive and read-only; the check-in
flow and every write guard are untouched. Two hanging items and two accepted
residuals.

### Operator action

- **O-6 — ✅ DONE (2026-08-03 23:57 UTC).** Flipped to `live` for Woodland via the
  DB write path at Bill's explicit instruction (audit row `system:claude-code (Bill
instruction)`; criteria note carries the directive). **Woodland operators confirmed
  they can see everything** (2026-08-03 ~17:09 PT). Eugene deliberately left `pilot`
  (no MyMRC feed — empty state). Original item:** Bill flips `ipad_hauls` to `live` at `/admin/rollout`.** The surface is
  seeded **`pilot`** per ADR-0047 #3, so today only an admin sees it; an operator
  who reaches `/operator/<site>/hauls` gets the translated "not turned on yet"
  block with back and Log Out intact — honest, never a dead end, never a 404. Flip
  **Woodland** (Eugene has no MyMRC portal feed and will render an empty state
  either way). Do it after the deploy's migrate init container has run — the
  migration `20260826_adr0074_ipad_hauls_surface` is what creates the row to flip.
  Nothing else is required; there is no second step and no deploy.

### Decision waiting on Bill

- **Q-4 — should it have shipped `live` instead?** ADR-0047 #3 says new
  staff-visible surfaces are born `pilot`, and this is genuinely new exposure
  (7,280 previously invisible rows reaching the floor), so `pilot` was taken as the
  default with no deviation. But there IS precedent for the other reading: the
  **ADR-0065 migration deliberately seeded `ipad_queue` / `ipad_inbound` `live`**,
  on the grounds that born-pilot protects new exposure and must not take working
  functionality away — and Bill's directive here was explicit and unhedged
  ("operators must be able to see any pending haul or load"). Seeding `live` and
  citing the directive would have been defensible on that precedent. It was not
  done, because unlike ADR-0065 there is nothing working today that `pilot` takes
  away, and the flip costs one click. **Answered in effect 2026-08-03: Bill ordered the flip same-day** ("you turn it
  on and make it live now") — O-6 is done. The pilot-first default stands for future
  surfaces unless Bill says otherwise.

### Accepted residuals (recorded, not actions)

- **3,316 undated hauls are now VISIBLE, not FIXED.** They carry
  `Docking_Appointment_Date__c` as JSON `null` with the companion time field as the
  empty template — an upstream MyMRC gap first measured in ADR-0070 (`undated:2301`,
  since grown to 3,316). The new surface sorts them last and reaches them through an
  `Undated (N)` chip rather than hiding them, so operators will start asking about
  them. That is the correct outcome of making a gap legible; **closing it is an
  operational chase with MRC**, not a code change.
- **Eugene renders an honest empty state.** Zero mirror rows exist for that site
  because Rick's site has no portal feed at all (the same construction as ADR-0049's
  workbook finding). Nothing is broken; no special case was added.

---

## 0.AD — 2026-07-31 End-of-day state: what is live, and what is waiting on Bill

Eight builds shipped, deployed and verified live today (see CHANGELOG 2026-07-31).
Everything below is a DECISION or an OPERATIONAL action, not code.

### Decisions waiting on Bill

- **Q-1 — the processor-quota threshold (ADR-0071).** The feature ships **disabled**
  on purpose. At the seeded quota of 75, a dry run against the real week of
  2026-07-20 flags **13 of 18** Woodland processors — a roster, not an exception
  list. Lowering the quota alone does not fix it: 60 → 10 flagged, 50 → 8, and even
  at **40** four still flag. The sensitivity is as much the **2-miss threshold on a
  5-day week** as the quota. `/admin/processor-quota` is live and accurate now, so
  combinations can be tried against real weeks before any email is enabled. Both
  numbers are settings; neither needs a deploy.
- **Q-2 — the commodity-audit tracker: absorb it, or not?** It is NOT what the
  absorption handoff assumed. Reading the real file: banded layout, and its row-4
  columns are `Audited | Initials | Date | 2nd Audit | Initials | Date` repeating per
  commodity band. **No weight, no amount, no invoice number, no variance.** It records
  _who checked_, not the figures. Absorbing it as-is yields a queryable table of
  ticked boxes. There IS a legitimate feature in it — "did anyone audit METAL in
  March, and who" — but that is a compliance-records surface, not
  absorption-for-reconciliation, and it needs Bill's call before it is built.
  **2026-08-12 update:** the reconciliation inputs themselves are now CONFIRMED
  to live in the two sibling files (watched + sampled, handoff #259) — see §0.AZ
  and the finding doc's CONFIRMED section.
- **Q-3 — ADR-0073 shape** (see 0.AC, L-1).

### Operator actions

- **O-1 — nine submitted loads are holding 880 units out of the floor.** Since the
  2026-07-22 anchor, Woodland has 12 inbound loads: **9 `submitted` (880 units, pool
  split UNSET), 1 `arrived`, 1 `in_progress`, 1 `verified` (150 units)**. Only
  `verified` loads reach `onHand`, because verification is what sets the
  program/non-program split. **Verifying those nine is the single action that moves
  the floor today without waiting on anyone.** Includes Pablo's `3700cfef` (07-29,
  3 units) and Morena's `d792ed15` (07-28, `arrived`, no units) — both flagged at the
  start of the 07-30/31 session and still open.
- **O-2 — the three shared documents still need two clicks.** On
  `/admin/doc-ingest`: **Re-read this file** on each (their stored headers still read
  `["Woodland Trailer List 2025"]` etc., because a parse only happens on a new
  revision), then **Confirm** the class + site. Confirming the trailer list absorbs 96
  rows; confirming TEREX stages 80 maintenance events for review. Deliberately not
  done on Bill's behalf — `confirmClassification` writes `classified_by` and
  `doc_class_source='operator'`, and putting his name on a decision he did not make
  defeats the audit trail.
- **O-3 — the Woodland floor reads −4,243 and is NOT a Vision defect.** ~34 hauls
  dated 07-23→07-31 remain `Confirmed` in MRC's own portal carrying 0 units (units
  populate on delivery); at July's ~106 units/haul that is ≈3,600 units. Vision now
  watches the right list view and will pick them up within the hour once MRC marks
  them delivered. **Expect the freshness alarm to fire** (`high`, 24h cooldown, one
  fingerprint per site+feed) until then — that is the guard working, not a new fault.
  If it is still firing in a few days, the deliveries genuinely are not being recorded
  upstream, which is an operational chase.
  **UPDATE 2026-08-03 — measured again under the PR #196 falsification gate: still
  zero delivered.** Floor now **−6,287 program / −5,401 total** (stripped since anchor
  8,034 vs 150 verified inbound); ~60 hauls dated 07-22→08-10 still `Confirmed` at 0
  units; recoverable Delivered General units in the window = **0**, so the recovery
  script (`scripts/fix-woodland-inbound.sh`, landed today) correctly refused to write.
  Two consequences now in force: (1) the July Woodland COR is **mechanically blocked**
  (prefill AND finalize refuse on the stale delivered feed / negative ledger —
  CHANGELOG 2026-08-03), and (2) **when MRC finally marks the hauls delivered, the
  floor will NOT fully self-heal**: the hourly scrape only re-bridges a trailing
  10-day window and every frozen-window day has already slid out of it — run
  `scripts/fix-woodland-inbound.sh --dry-run` then `--apply` (gate-aware; use
  `--allow-partial` if MRC marks in batches) to bridge the older days. **This is now
  purely an operational chase with MRC: get the 07-22→07-31 deliveries marked.**
  **CORRECTION + PARTIAL RESOLUTION 2026-08-03 (afternoon) — the verdict above was
  WRONG; it was us, and the window is recovered.** MRC HAD marked the hauls delivered;
  Vision's mirror froze them at `Confirmed`/0 because details were fetched once per
  row, ever (see CHANGELOG 2026-08-03 later entry — `idsNeedingDetail` fix + proof
  H-134015). Recovery ran through the script's gates (5,022 ≥ 5,000, PASSED): 61 hauls
  flipped Delivered, +4,306 program units bridged, floor −6,287 → **−2,439 program /
  −1,553 total** as shown today (−1,981/−1,095 once the 08-04/08-06 deliveries' days
  arrive). **REMAINING OPEN: a ~1,900-unit reconciliation gap** (stripped 8,034 vs
  anchor+inbound ≈ 6,131) — candidates: further MRC marking lag (22 hauls still
  Confirmed dated 08-04+), the 2,319 undated-haul defect, stripped over-count. The
  COR stays blocked on the negative-ledger refusal; a fresh physical count is the
  clean reset if the July COR cannot wait for the gap to close. No MRC chase needed
  for the recovered window; the 08-04+ hauls will absorb automatically now that
  details refresh on the completed feed.
  **DIAGNOSED 2026-08-10 (ADR-0089) — MRC confirmed no delay; the gap is ours, and
  the mechanism is found. Candidate 1 is dead; the undated-haul candidate is the
  prime suspect and was mis-scoped as "historical."** Bill spoke to MRC directly
  (~10:26 PT): they HAVE haul data entered after 07-21 and report no issues or
  delays. Re-measured on prod the same morning:
  - **The mirror is NOT stale.** 7,334 rows, newest delivered dock date 2026-08-12,
    newest `first_seen_at` 2026-08-10 10:00 PT, detail coverage 7,333/7,334, hourly
    cron `ok` on all four feeds. Delivered hauls 07-22→08-12 = 93 hauls / 10,134
    program units, every weekday populated. The 07-21 cliff is gone and stayed gone.
  - **Candidate 1 (further MRC marking lag, "22 hauls Confirmed dated 08-04+") is
    FALSIFIED.** Only 16 Confirmed hauls remain mirror-wide; 12 are dated 08-10 or
    later (today/future, legitimately undelivered). Just four carry a past dock date.
    Twenty-two became four with no MRC chase, and MRC reports no backlog.
  - **Candidate 2 (the "2,319 undated-haul defect") is the prime suspect and is
    NOT historical.** 3,330 of 7,334 rows (45%) have a NULL `docking_appointment_date`;
    3,328 are Delivered carrying 206,684 program units, all skipped by the ADR-0059
    bridge. ADR-0059 and `inbound-bridge.ts` both assert every undated haul is
    "pre-anchor and inert" and that "the live/forward path is fully covered" —
    **false.** 35 undated Delivered hauls arrived 07-31→08-10 carrying \*\*639 program
    - 1,790 non-program units / 133,595 lb\*\* and never reached the floor ledger.
  - **Root cause:** the bridge keys the delivery day on `Docking_Appointment_Date__c`,
    a _scheduling_ field MyMRC leaves null for route collections that book no dock
    slot (verified in H-137017's raw payload). Every haul with a `Collection_Source__c`
    set is undated — 886/886. The real field, `Recycler_Reported_Delivery_Date__c`,
    is enumerated in our own `docs/mymrc-discovery-2026-07-22.md` and is requested
    nowhere in the codebase. `freshness.ts` keys on the same wrong column, so the
    COR inbound gate would report the feed fresh while 100% of collection-network
    intake went unbridged.
  - **BUILD LANDED 2026-08-10 evening (ADR-0089 D1–D3 + D4 tooling, branch
    `feat/adr-0089-delivery-date-rekey`).** Deploying it moves nothing by itself
    (all pre-deploy rows NULL → COALESCE falls back to the appointment date).
    **RECOVERY EXECUTED 2026-08-10 19:45–19:55 UTC (12:45–12:55 PT), at Bill's
    instruction ("merge the PR and run the recovery sequence"). All five steps
    ran and verified:**
    - Deploy: PR #223 squash-merged (`b3d552c`), migration `20260840` applied,
      app + scrape containers healthy on the new build.
    - Re-detail: cursor cleared (7,335 rows, audited), enrich swept 74 batches →
      **7,314/7,314 Delivered hauls now carry a recycler delivery date — ZERO
      dateless** (the only error is the known portal ghost `a2KUJ00000GXZ2b2AH`).
    - Delta report (read before the re-bridge): **35 hauls added (+639 program /
      +1,790 non-program — the ADR's exact prediction) + 30 hauls re-attributed
      (3,087 program units moved, max 9 days earlier than their appointment)**.
    - Re-bridge: falsification gate passed (11,437 recoverable ≥ 5,000);
      16 days → 2 inserted / 13 updated / 1 skippedGuarded (manager-owned day,
      precedence held) / 0 dateless; 15 audit rows in-transaction.
    - **Floor: −1,166 program / −505 non-program (−1,671 total) → +479 / +903
      (+1,382 total). The negative Woodland floor is GONE.** Freshness business
      day = 2026-08-10 on the COALESCE key. ~~The July COR negative-ledger block
      should now clear — re-run the COR flow to confirm.~~ **CONFIRMED CLEAR
      2026-08-10 ~13:20 PT** (read-only probe
      `scripts/one-off/2026-08-10-adr0089-july-cor-verify.ts`, driving the COR
      service's own gate + prefill functions against prod): GATE 1 inbound
      freshness PASS; **July EOM inventory computes to 512 units (151 program +
      361 non-program)**, anchored on the 07-22 physical count (2,483), running
      balance to 07-31 23:59:59 PT; GATE 2 non-negative ledger PASS. The July
      Woodland COR is mechanically unblocked — Bill can generate/file it from
      the app whenever ready.
    - Residuals: the ~1,900-unit O-3 gap is now largely explained + recovered;
      remaining candidate (stripped over-count) shrinks to the current +479
      floor arithmetic. Cosmetic: `fix-woodland-inbound.sh` emits two harmless
      `command not found` lines (backticks inside the floor_sql heredoc comment
      undergo command substitution — pre-existing, SQL unaffected).

    ~~OPERATOR SEQUENCE for the recovery (each step gates the next):~~
    1. Merge + deploy the branch (migration runs in the init container).
    2. On CHAD-HQ: `scripts/one-off/2026-08-10-adr0089-redetail-sweep.sh`
       (dry-run first, then `--apply`), then the enrich run it prints
       (~74 batched POSTs, a few minutes).
    3. `scripts/one-off/2026-08-10-adr0089-rekey-delta-report.sh` (read-only) —
       **Bill reads this**: it separates NEW days (collection network, was
       invisible) from RE-ATTRIBUTED days (units moving between floor days
       managers have seen — the Am.1 §3 decision).
    4. Only after the deltas are accepted:
       `scripts/fix-woodland-inbound.sh --dry-run` then `--apply` (gated,
       audited, precedence-guarded). Expect ≈ +639 program / +1,790 non-program
       post-anchor from the added hauls, plus the re-attribution movement the
       report shows.
    5. Then re-check the O-3 gap arithmetic and the July COR negative-ledger
       block (expected to clear or shrink to the stripped-over-count candidate).

  - ~~Still unproven: that MRC populates `Recycler_Reported_Delivery_Date__c`~~
    **PROVEN 2026-08-10 ~11:04 AM PT (ADR-0089 Am.1)** — read-only probe
    (`scripts/one-off/2026-08-10-adr0089-field-probe.mjs`, one-shot scrape
    container, 14 hauls / 5 classes, 14/14 fetched, 0 errors): populated on
    **12/12 Delivered** including all 7 undated collection-network hauls AND
    both pre-anchor rows (2023/2024 — D4 will recover real dates); null on both
    Confirmed controls (correct). Both fallback candidates
    (`Transporter_Reported_Delivery_Date__c`, `Actual_Pickup_Date__c`) are
    **null on all 14** — dead in practice. **NEW finding:** the appointment
    date disagrees with the true delivery date on 2 of 3 dated comparators (−6
    and −7 days), so D2's re-key also RE-ATTRIBUTES some already-bridged dated
    hauls to earlier days — re-attribution scope is an explicit build-session
    decision with a before/after per-day delta report (ADR-0089 Am.1 §3).
    Bonus: `Unit_Count_at_Unload__c` populated on all Delivered rows — natural
    F-3 cross-check input, request it in D1.
  - Remaining gap candidate after this lands: stripped over-count. The COR stays
    blocked on the negative-ledger refusal; billing exposure is in the safe direction
    (unbridged inbound understates receipts, so MRC was not overbilled).

- **O-4 — load H-135881 was corrected by hand.** 40 → 95 units, audited, at Bill's
  instruction. Two caveats on the record: nothing in the DB links that load to the
  identifier "H-135881" (no BOL, DR3 or haul id — matched as the only Woodland load
  that day with 40 units), and it is now the only one of nine `b2b_haul` rows where
  `total_units` ≠ Σ `load_stacks` (4 × 10 = 40). The stacks were left intact
  deliberately — they record what was actually mis-keyed. It changes no inventory
  figure today because its pool split is still NULL.
- **O-5 (added 2026-08-03) — processed program/non-program misclassification: 07-29
  corrected (Rick), FOUR sibling days suspect, and a daily guard is wanted.**
  Rick corrected 07-29 in the MRC portal (1,249 all-program → 826 program + 423
  non-program — only 826 program were on the floor); absorbed into Vision same day
  (re-detail M-183347 + processed bridge, audited; billable program −423, nothing had
  been invoiced). THREE follow-ups:
  1. **RICK/OFFICE: 07-27 and 07-28 remain to check** (07-30 → 808/352 and 07-31 →
     1,063/95 corrected + absorbed 2026-08-03 evening; 870 units reclassified total).
     NOTE the non-program pool is at +16 — further reclassification drives it negative
     unless the INBOUND split is also revisited (MRC hauls are recorded 100% program).
     And reclassification is pool-neutral: the −1,525 TOTAL floor needs real inbound
     or a physical count, never a reclass.
     The running program pool crosses zero on 07-27 and deepens every stripping day —
     those days' all-program entries could not have been satisfied by recorded program
     stock. Correct in the MRC portal; Vision absorbs via re-detail + bridge (ask a
     session, or wait for the Half-B processed re-detail fix).
  2. **Rick's standing ask — daily tracking to prevent MRC overcharging.** The Half-B
     negative-pool alert (PR #196 §3.3) is the vehicle: stripping more program than the
     pool holds fires same-day. Treat Rick's 07-29 case as the acceptance fixture.
  3. **Processed/outbound mirrors still have the frozen-detail defect** (proven live on
     M-183347) — the 2026-08-03 hauls fix does not cover Materials edits (no status
     transition to key on). Needs a design decision (e.g., re-detail a trailing-N-day
     window each tick). Half-B scope.

## 0.AC — 2026-07-31 Manager load corrections (ADR-0073, proposed) — design landed, nothing built

Triggered by load **H-135881** (Woodland, arrived 2026-07-31 09:46 PT), keyed as 40
units, correct figure 95. Corrected by a **direct DB `UPDATE` + hand-written audit row**
at 11:35 PT — the DBA-shaped tool this ADR exists to retire. ADR-0073 is written and
**proposed only**; no schema, no route, no UI. Research findings that change other work
are broken out below because they are not all about corrections.

- **L-1 — DECISION (Bill): approve the ADR-0073 shape before anything is built.**
  Recommendation is a **tiered, approval-gated restatement of the load row** modelled on
  ADR-0072, with an append-only `inbound_load_corrections` record — **not** an ADR-0032
  style additive adjustment layer (that would give `onHand` a second sum, the exact
  divergence class ADR-0037 D6 was written to kill) and **not** a time-boxed edit (time is
  a proxy for the wrong thing; the real gate is what has been derived downstream).
- **L-2 — HIGHEST VALUE, and it is not the per-load route.** `upsertBulkInboundDay`
  (`bulk-inbound.ts:189`) and `confirmFloorInboundDay` (`floor-inbound.ts:193`) already
  rewrite `total_units` / `program_unit_count` / `non_program_unit_count` on a **verified**
  row for an **arbitrary past day** — no date window, no anchor check, no COR check, no
  lock. `mymrc/inbound-bridge.ts:237-244` absolute-SETs verified rows too. **Managers can
  already rewrite inventory history with less friction than ADR-0072 requires to change one
  physical count.** Whatever classifier ADR-0073 defines must land on these paths FIRST, or
  the new guarded door just adds friction to the safer of the two.
- **L-3 — BLOCKING for the "never restate what was sent to MRC" constraint: nothing
  records what was sent.** The MRC Monthly Invoice CSV (Article 10.4,
  `src/app/api/exports/mrc/route.ts`) reads `total_units` + `weight_lbs` **live on every
  GET** — `force-dynamic`, no snapshot, no version, no record of prior downloads. Re-pulling
  last month after any correction silently yields a different file than the one MRC has.
  Needs an `mrc_export_pulls` ledger (window + `content_sha256` + who + when) before that
  constraint is enforceable at all. Same exposure on `exports/svdp/route.ts`.
- **L-4 — DEFECT (live, unfixed): `2026-07-29` at Woodland holds BOTH inbound grains.**
  One `ipad_floor` **verified** aggregate (150 units) plus two `b2b_haul` **submitted**
  per-load rows (106 units). The ADR-0060 D5 double-count guard only refuses when per-load
  rows are **`verified`** (`floor-inbound.ts:146-152`), so it does not fire. **Verifying
  those two loads double-counts 106 units into `onHand`.** Nine `b2b_haul` loads sit
  unverified; none has ever reached `verified`. Decide the day's owner before anyone works
  the verify queue.
- **L-5 — DEFECT (data): H-135881's header and its evidence disagree.** `total_units = 95`
  but `load_stacks` still sum to **40** (four multiplier stacks of 10, 17:46:29–17:46:39Z).
  Every other `b2b_haul` row in prod satisfies `total_units == Σ stacks`. Also
  `program_unit_count` / `non_program_unit_count` are still NULL (status `submitted`), so
  **`onHand` is unaffected today** — the divergence bites at verify, where
  `assertProgramSplit` will hold the split to 95. ADR-0073 proposes recording this as
  `stacks_sum_at_correction` rather than rewriting the stacks; stacks are the operator's
  timestamped evidence and are never mutated.
- **L-6 — The amendment path `processed_units_daily` refuses into DOES NOT EXIST.**
  `processed-units.ts:178` throws _"corrections follow the amendment path, not in-place
  edits"_. There is no such route. Related: `BonusReportingAdjustment` (ADR-0032) has **no
  write API** — all five prod rows were inserted by hand. ADR-0073 deliberately does **not**
  extend to production rows (it would become a fourth writer against the
  `source` + `closed_at` precedence rule in `mymrc/processed-bridge.ts:140-143`); finishing
  the declared amendment path is separate work and needs its own ADR.
- **L-7 — Correcting a load inside a finalized COR month bricks that certificate's PDF.**
  `cor_certificates.inventory_units` is snapshotted, so a signed Exhibit 5 never silently
  changes — but `assertCorInventoryReconciles` gates `generateCorPdf` (`cor/pdf.ts:112`) and
  **409s on drift**. Result: an immutable, correct-when-signed certificate that can no
  longer render its own PDF. Recovery is `supersedeCor` → new draft → re-enter FT/PT →
  re-finalize. Must be a named Tier 2 consequence, never a surprise.
- **L-8 — Confirmed NOT a hazard (recorded so nobody re-litigates it): no invoice amount
  can change from an inbound unit-count edit.** Invoice lines derive from
  `processed_units_daily.stripped_program` and consumer drop-offs; the one invoice query
  touching `inboundLoad` (freight/fuel, `generation-inputs.ts:269-288`) has an exhaustive
  `select` with **no unit or weight column** — freight is a per-haul lane rate, fuel is
  priced off `source.canonical_mileage`. Per `audit/comparators/c4-billing.ts:3`, _"the
  billing basis is PROCESSED program units, not inbound."_ The edit CAN flip the ADR-0039
  trust gate (C1/C5 findings `blocksBilling`), changing **whether** an invoice may be
  approved — never the amount.
- **L-9 — `inbound_loads` is the only loads/inventory model with no lock.** `ConsumerDropoff`,
  `OutboundMaterial`, `LandfilledUnit`, `CollectionEvent` all carry `locked_at`;
  `ProcessedUnitsDaily` carries `closed_at`. Inbound carries neither, and there is no closed
  period or billed-window immutability anywhere on it. ADR-0073 adds `locked_at` as a column
  and a guard **with no automatic setter** — which leaves an open policy question: what
  locks an inbound load, and when? Proposed default is month close; needs Bill's call.

---

## 0.AA — 2026-07-29 Document ingestion foundation (ADR-0067) — operator actions

Shipped on `feat/doc-ingestion-foundation`: the ADR, the additive schema, and the
`/admin/doc-ingest/connect` surface. Nothing ingests yet, and nothing can until these
are done. See ADR-0067 + CHANGELOG 2026-07-29.

- **C-31 — OPERATOR: provision `~/.dr3-vision-secrets/doc-ingest.env` on svdp-dev**
  | O-14 | ❌ **WITHDRAWN 2026-07-29 — misdiagnosis. See ADR-0067 Amendment 2.** This claimed Entra's `appRoleAssignmentRequired` blocked `docs-dr3@svdp.us`. **False.** Live logs show `entra_signin_denied / email=docs-dr3@svdp.us / reason=unknown` — Microsoft authenticated it fine and **VISION's** SSO gate refused it, because `docs-dr3` has no `users` row (and must never have one). The operator was signing into **Vision** as the service account instead of into the **separate** Microsoft consent prompt that the Connect button opens. Root cause of the bad diagnosis: the error string was grepped with `--include=*.ts --include=*.tsx`, but it lives in `src/i18n/locales/en/operator.json`; the empty result was misread as "not our string". **Correct sequence: sign into Vision as `bill.barnard@svdp.us` FIRST, then click Connect, then sign in as `docs-dr3` at the Microsoft prompt.** The Entra group change is unnecessary and should be reverted (the runbook script removes it conditionally). |
  | C-31 | ✅ **RESOLVED 2026-07-29 — no secret needed; the requirement was removed, not satisfied.** This originally asked Bill to create `~/.dr3-vision-secrets/doc-ingest.env` with `DOC_INGEST_TOKEN_KEY`. He declined, correctly: the repo rule is no `.env` for credential material, and a second secret bought nothing. The doc-ingest AES key is now DERIVED (scrypt + a doc-ingest-specific salt, giving domain separation) from `MYMRC_CRED_KEY`, already mounted per ADR-0057. The `doc-ingest.env` compose mount and the `.env.example` entry are deleted. **Remaining operator action is now only Bill's one-time sign-in at `/admin/doc-ingest/connect` as `docs-dr3@svdp.us`.** Rotation note: rotating `MYMRC_CRED_KEY` costs one re-click of Connect (a refresh token is re-obtainable), not data loss. |
  `/admin/doc-ingest/connect` returns a loud 503 (by design — ADR-0067 D6; it never
  silently no-ops). The compose mount is already wired `required: false`, so the app
  boots fine without it.

- **C-32 — OPERATOR (Bill, one time, in a browser): click Connect and sign in as
  `docs-dr3@svdp.us` — NOT as yourself.** Signing in as yourself would succeed and
  would connect your personal OneDrive instead of the service account's shares. The
  server-side `/me` assertion refuses it, but the refusal costs a round trip and the
  point is not to need it. Requires C-31 first.
- **C-33 — Nothing in ADR-0067 has run against the LIVE tenant.** The migration is
  validated against live prod (rolled back) and the flow against stubbed Entra/Graph
  responses; CI has no tenant. The real authorize redirect, token response body, `/me`,
  and `/me/drive` are unproven until C-32 happens. Expect first-contact surprises there
  and nowhere else.
- **C-34 — RUNBOOK: add the 2028-05-05 expiry of the shared `DR3-Vision Production`
  client secret to the secret-rotation runbook,** with the coupling stated: it is the
  SAME secret AP mailbox polling uses, so a silent expiry stops AP mail **and** document
  ingestion simultaneously and will present as two unrelated outages. Surfaced on the
  connect page, but a page nobody is looking at is not a reminder.
- **C-35 — DECISION (Bill): who may share files to `docs-dr3@svdp.us`, and is there a
  naming/foldering convention?** The classifier (next phase) has to guess document type
  and site from what it finds. A convention would make that deterministic; without one it
  is inference. Not blocking the foundation.

## 0.AB — 2026-07-29 Document ingestion PIPELINE (ADR-0067 §3.2 D4–D8 / §3.4)

Shipped on `feat/doc-ingestion-pipeline`: discovery + folder traversal, change
subscriptions, the delta sweep, the classifier, the D7 guardrail, and the three §3.4
surfaces. See ADR-0067 (Pipeline addendum) + CHANGELOG 2026-07-29.

C-35 above is now **load-bearing rather than nice-to-have**: the classifier is live, and a
naming/foldering convention is the difference between deterministic classification and
inference that Bill has to confirm one document at a time.

- **C-43 — ⚠ SUNSET (2026-11-01): `GET /me/drive/sharedWithMe` is DEPRECATED and there is
  NO documented replacement.** Microsoft deprecated it (and `/me/insights/shared`) in
  November 2025; per learn.microsoft.com both "operate in a degraded state until November
  2026, after which [they] stop returning data". Microsoft's own Q&A thread on the
  deprecation ends with "I am not aware of any publicly documented one-to-one
  replacement", pointing only vaguely at the Microsoft Search API. **This API IS
  discovery** — the whole D1 premise (owners share, Vision reads in place) rests on it, so
  when it stops, shared-document discovery stops with it. Mitigations shipped: discovery
  goes through the `SharedItemSource` seam (`src/lib/doc-ingest/discovery.ts`) so the
  enumeration is one implementation swap, `/admin/doc-ingest/health` renders a live
  countdown, and `SHARED_WITH_ME_SUNSET` is a single constant. A speculative Search-API
  implementation was deliberately NOT shipped — it cannot be verified against the live
  tenant today, and an unverified fallback returning a DIFFERENT set of sources is worse
  than a loud countdown. **Needs a real replacement built and verified before 2026-11-01.**
- **C-44 — ✅ CLOSED 2026-07-29, NOT decided: the premise was FALSE.** This item asked Bill to
  choose between push latency and a tenant-wide `Files.ReadWrite.All` write grant. **There
  was never a choice to make, and the recommendation to consider the grant was itself the
  defect.** Microsoft's
  [create-subscription permissions table](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions)
  lists, for `driveItem` on OneDrive for Business, delegated **`Files.Read.All`** — with no
  higher-privileged alternative — and states: _"Due to security restrictions, Microsoft
  Graph subscriptions don't support write access permissions when only read access
  permissions are needed."_ We already hold exactly that. `GET /subscriptions` returns 200,
  so the token is accepted. The real blocker is the **resource**: on OneDrive for Business a
  subscription may target only a **drive root**, never an individual file, and the service
  account reaches these documents through **item-level** shares — so it has no permission on
  any drive root and there is no legal subscription target at any permission level. Push is
  unavailable for individually-shared files as a property of Graph; the delta sweep is the
  mechanism, not a fallback; D4 holds by construction. It went unnoticed for a week because
  the scope-detection regex could never match its own error, so the wrong explanation was
  never actually rendered. Corrected in `SUBSCRIPTION_SCOPE_NOTE`, ADR-0067 Amendment 4 §D.
- **C-47 — DECISION (Bill): does doc-ingest need `Sites.Read.All`?** Measured on the live
  tenant 2026-07-29: `docs-dr3@svdp.us` can enumerate **11,403 driveItems across 42
  SharePoint sites**, including `NSStaff` (Night Shelter Staff — case-management files,
  client rosters, intake packets), `HSSSitesStaff`, `HSSSitesManagers`. That is org-wide
  site membership, not a share, and it is materially broader than ADR-0067 §5.1's "no
  tenant-wide access" claim. **Not a bug and nothing exploits it** — discovery reads
  `sharedWithMe` and (soon) explicitly-registered URLs only. But it is the reason Graph
  search must never become a discovery source: it would pull the whole tenant, PII included,
  into a mattress-recycling document pipeline. Worth an explicit decision on whether
  `Files.Read.All` alone suffices, rather than leaving the wider grant as a default.

  **⚠ AMENDED 2026-07-29 — do not act on this item before running the test below.** The
  premise above (that the 42-site reach comes from the `Sites.Read.All` grant) is **[I]
  inferred and UNPROVEN**. Delegated `Files.Read.All` is documented as _"Read all files that
  user can access"_, and delegated scopes are bounded by the account's own effective
  SharePoint rights — so the reach may be a property of `docs-dr3`'s **org-wide site
  membership**, in which case revoking the scope would remove our ability to subscribe to a
  SharePoint list (ADR-0067 Amendment 6 §B) while reducing the file blast radius by roughly
  nothing, and the real lever is group membership.
  **The falsifiable test:** obtain a delegated token for `docs-dr3` requesting only
  `Files.Read.All offline_access openid profile User.Read` — omitting `Sites.Read.All` — and
  re-run the same site/driveItem enumeration. ~11,403 ⇒ premise wrong, retarget the item at
  group membership. ~0 ⇒ premise right, decide the scope.
  **⚠ RISK, operator decision required:** the cheap way to get that token is a
  `refresh_token` grant with a narrowed `scope`. Microsoft rotates refresh tokens on
  redemption, so a probe that discards the returned token **may invalidate the stored
  credential and force Bill to re-run the Connect sign-in**. That is a production-auth risk
  for an item nothing is currently blocked on, so it has NOT been run unilaterally. Either
  accept the re-auth risk deliberately, or run the enumeration from a separately consented
  test app.

- **C-48 — the `/shares` route runs on UNDOCUMENTED permission (extends C-43).** **[D]** The
  permission table at https://learn.microsoft.com/en-us/graph/api/shares-get lists delegated
  `Files.ReadWrite`, `Files.ReadWrite.All`, `Sites.ReadWrite.All` for `GET /shares/{id}` and
  does **not** list `Files.Read.All`. **[M]** It nonetheless returns 200 for us on
  `Files.Read.All` (measured 2026-07-29). The measurement is believed over the table — these
  tables lag — but the consequence stands: **both discovery routes are on borrowed time from
  different clocks.** `sharedWithMe` has a dated deprecation (~2026-11); `/shares` has an
  undated dependency on undocumented behaviour. Neither is a reason to stop using them today;
  together they are the strongest argument for moving primary discovery to a SharePoint
  library (ADR-0067 Amendment 6 §E) rather than deferring it until November.
- **C-49 — discovery under-reports RIGHT NOW, and nothing detects it.** **[M]**
  `sharedWithMe` returns 1 item while ≥2 documents are genuinely granted to `docs-dr3` (a
  Graph search surfaced `DR3 Machine List (2).xlsx`, an Outlook-attachment share that appears
  in no enumeration route). **No surface compares "reachable" against "watched"**, so the
  under-reporting is invisible — the same silent-staleness shape as ADR-0057 D9, in the one
  layer of this pipeline that does not guard against it. This **outranks the C-43 sunset**,
  which is at least loud and dated. Two responses, in order: (1) move primary discovery to a
  SharePoint library, where `delta` is the only enumeration Microsoft guarantees is complete;
  (2) interim, a coverage-divergence anomaly cross-checking an independent route
  (`/me/insights/shared` is documented to include _"documents that are attached as files and
  sent to the user"_ — exactly the gap that lost the Machine List). Per ADR-0067 Amendment 3
  §D4 such a cross-check may only ever ADD suspicion, never remove a source, and must never
  become the enumeration itself.
- **C-45 — UNVERIFIED against the live tenant (extends C-33 to the pipeline).** Everything
  in this phase is tested against stubbed Graph responses and a real-OOXML fixture; CI has
  no tenant and Bill has not yet completed the one-time sign-in (C-32). Specifically
  unproven: the real `sharedWithMe` payload shape (including whether `remoteItem` carries
  `shared.owner` for these shares), whether a subscription on a COLLEAGUE'S drive root is
  permitted at all given the service account only has access to the shared subtree, the
  real validation-token handshake over the Cloudflare tunnel, and real `.xlsm` daily-log
  bytes. The sweep is designed so each of those failing degrades to "slower" or "reported",
  never to "silently wrong" — but that design is exactly what first contact should test.
- **C-46 — ✅ DONE (verified live 2026-08-08).** `dr3-vision-doc-ingest-sweep` is up on
  svdp-dev (CHAD-HQ) alongside the other cron daemons, confirmed by `docker ps` rather
  than by assuming the compose change shipped. The precondition every doc-ingest item
  below used to carry is satisfied; `/admin/doc-ingest/health` no longer has a standing
  reason to report the sweep STALE.
  _Original item:_ **OPERATOR: deploy the `doc-ingest-sweep` container.** A new compose
  service was added (`docker-compose.yml`, `scripts/doc-ingest-sweep-cron.mjs`). It needs
  `~/.dr3-vision-secrets/cron.env` (already present for the other crons) and a
  `docker compose up -d doc-ingest-sweep` on svdp-dev. **Until it runs, nothing sweeps** —
  and `/admin/doc-ingest/health` will correctly show the sweep as STALE, which is the
  intended alarm rather than a cosmetic warning.

## 0.A — 2026-07-28 iPad gates + nav (ADR-0065) — residuals

Shipped on `feat/ipad-gates-and-nav`: per-surface iPad rollout gates, current-Pacific-day
floor scoping (incl. the UTC-vs-Pacific queue correctness fix), and the two app chromes
(ManagerChrome / FloorChrome). See ADR-0065 + CHANGELOG 2026-07-28. Left open:

- **C-30 — ~90 hardcoded `←` / `&larr;` glyphs remain across ~45 manager page files.**
  In Urdu (RTL) they point the wrong way. DELIBERATELY out of scope for ADR-0065: the strings
  the new chromes consume were fixed (`floor.common.back` deleted, chevrons now mirror via
  `rtl:rotate-180`), but a 45-file sweep would have buried the gate work Bill needed on the
  floor. Fix pattern is established — delete the glyph from the string, render
  `ChevronBackIcon` in the component. Candidate for a mechanical follow-up PR.

- **C-31 — `/admin` chrome labels are English-only.** `ManagerChromeBar` on `/admin` takes its
  strings from `adminMessages.nav` because ADR-0017 keeps that surface English-only and mounts
  no I18nProvider. Correct per ADR-0017, but it means "Log out" is untranslated for the one
  admin surface. Moves with the eventual admin i18n pass, not before.

- **C-32 — `/` (Vision Dashboard) chrome is English-only for the same structural reason.**
  The root page has no route-group layout and therefore no I18nProvider; `VisionShell` is
  already all-English ("Active", "Coming soon", the tagline). The new `SignOutPill` matches
  that existing treatment rather than introducing a lone translated string. If `/` is ever
  localized, the pill comes with it.

- **O-12 — OPERATOR ACTION (Bill): the new rollout rows only exist after the migration runs.**
  `20260813_adr0065_ipad_per_surface_rollout_gates` seeds all five surfaces × both sites on
  deploy. Until it runs, `/admin/rollout` will not list them and the pages fail CLOSED
  (unregistered ⇒ pilot ⇒ off) — which for `ipad_queue`/`ipad_inbound` means the truck queue
  and inbound confirm go dark. **Deploy the migration and the app together**; do not ship the
  app code ahead of the migration.

- **C-33 — `pre-push` bonus suite flake (C-29) is unchanged.** Noted here only so a future
  session does not re-diagnose it: `src/lib/bonus/__tests__/bonus-cycle-e2e.test.ts` and
  `src/lib/ap/poll.test.ts` both time out intermittently under load (5s default timeout) on a
  branch touching neither. Re-run before assuming a regression. `SKIP_PREPUSH` stays unused.

## 0 — 2026-07-25 session reconciliation (inventory pipeline + iPad floor + i18n)

**Shipped + LIVE + verified this session (ADRs 0058–0061):**

- **The MyMRC→inventory pipeline is now closed on BOTH legs.** ADR-0058 (processed bridge,
  PR #170) feeds the `Stripped` outflow from `mymrc_processed_mirror`→`processed_units_daily`
  (976 Woodland days backfilled, 0/976 mismatch vs mirror). ADR-0059 (inbound bridge, PR #172)
  feeds the `Inbound` inflow from Delivered MyMRC hauls→`inbound_loads` as PROVISIONAL
  (610 days, 0/610 mismatch). Both run hourly on scrape completion, both anchor-safe (floor
  2,483 byte-identical, gate-verified). This CLOSES the prior "forward accuracy depends on
  manual entry" gap — on-hand now moves on its own from MyMRC and is floor-confirmable. A
  floor-probe auth hotfix (PR #171) made the anchor-safety gate reachable.
- **Single 8pm production-report send** (ADR-0058) — the on-save re-send was removed; both
  sites verified sending once at 20:00 PT (2026-07-24 fire: woodland 3/3, eugene 4/4).
- **iPad floor validation surfaces LIVE** (ADR-0060, PR #173): F-1 `/operator/[site]/today`,
  F-2 `/inbound` (confirm/correct/enter — upgrades provisional `mymrc_haul`→`ipad_floor`),
  F-3 `/count` (physical on-hand → new anchor; establishes Eugene's first), F-4 `/processed`
  (confirm). Precedence `ipad_floor > paper_bulk > mymrc_haul`; double-count guard (409 on
  per-load days) + matching bridge guard. `loads_inventory` live both sites.
- **iPad i18n parity LIVE** (ADR-0061, PR #174): en/es/ur now reachable on the floor
  (switcher on the operator sign-in screens), per-operator + session-first (language follows
  the operator, not the shared device), CI key-parity gate blocks locale drift. Verified live:
  `<html lang/dir>` resolves per `users.locale` incl. `ur`→rtl. Deleted-operator name-picker
  filter also shipped here.

**STILL OPEN / accepted residuals from this work (honest):**

- **C-20 stays open** — ADR-0060 built the confirm/count/processed surfaces but did NOT build
  the `unit_status_movements` ledger writers ("mark saved" / "send to store"); `onHand` still
  derives pools from `processed_units_daily` aggregate columns. Separate future change.
- **Inbound is PROVISIONAL until floor-confirmed.** F-2 now provides the day-to-day
  confirmation path (upgrades to `ipad_floor`), but that's an operational adoption step —
  unconfirmed days render labeled "provisional." iPad floor-confirmation is the verification
  layer going forward.
- **Eugene** — no inventory anchor yet (F-3 establishes the first on first use) and no MyMRC
  haul-mirror data (C-21 Switch-Account still pending), so its inventory reads zero until the
  floor takes a count.
- **Backfill is honestly partial** — 2,301 undated Delivered-General hauls were skipped
  (all pre-anchor, inert to the live floor).
- **Operator-login note:** the "Test Operator" (Woodland) account was soft-deleted yet still
  selectable in the picker; the revocation kill-switch emptied its session → PIN "hang/bounce".
  Reactivated for testing (PIN set); the picker now filters `deleted_at IS NOT NULL` (#174).

---

## 1 — Operator actions (Bill)

| #   | Item | Source | Notes / deadline |
| --- | ---- | ------ | ---------------- |

| O-13 | **Review the AP routing table at `/admin/ap/routing` once ADR-0066 Amendment 1 deploys.** The screen now lists every active manager/admin with no routing row — each one falls back to an admin immediately instead of reaching a peer, which is the quiet degradation ADR-0066 was written about. Seeded pairs cover Janette/Morena/Kelsey/Rick/Shannon/Bill; anyone added since (or anyone the email-keyed seed skipped) shows as a warning with a one-click "Add routing pair". Also worth a look: the "Accounts deliberately excluded from the pickers" disclosure should list exactly the email-less operator PIN accounts and nothing surprising. **Kelsey's row expires with her availability on 8/8** — deactivate it rather than deleting, so the pair keeps its history. | ADR-0066 Amendment 1, `/admin/ap/routing` | Read-only check; no deploy prerequisite. Warnings are also carried in the 06:00 digest. |
| O-12 | ✅ **RESOLVED 2026-07-22/23.** Creds entered via the `/admin/mrc-scrape` tile; Phase 0 discovery + Phase 1 ingestion ran; backfill **7,207 hauls / 4,514 outbound / 984 processed**, detail-enriched to **100%** via the batched `getRecordWithFields` transport (#160, fixed the SOQL OFFSET-2000 truncation #155 + the racy per-record detail); `mymrc-scrape` worker **un-gated + running clean** (#158, hardened re-auth); non-program CA/OR sources seeded + out-of-state rule live (#166). MyMRC data now flows with real billing detail. Original blocker text retained for history: **⛔ BLOCKER — Bill enters MyMRC admin creds in the tile (ADR-0057).** ADR-0057 shipped; the credential mechanism is now the **`/admin/mrc-scrape` admin tile** (DB-encrypted AES-256-GCM, **no `.env`** for the login — per operator rule). Phase 0 discovery — Vision's **first-ever authenticated MyMRC pull** — is HALTED on a single operator action: **Bill opens `/admin/mrc-scrape`, enters his MyMRC admin username + password, and saves** (the form trims stray whitespace — MyMRC rejects a leading/trailing space). No env injection of the login is needed; it is stored encrypted in Postgres and the hourly scrape decrypts it. **One-time infra prereq (deploy):** the encryption KEY `MYMRC_CRED_KEY` (`openssl rand -hex 32`) must exist at `~/.dr3-vision-secrets/mymrc-cred-key.env` on CHAD-HQ — it is mounted (fail-soft) on BOTH the `app` and `mymrc-scrape` services; without it the save path 500s and the scrape can't decrypt. This is the encryption key, NOT the MyMRC login, so it is compatible with the no-`.env`-for-creds rule. Once the key is provisioned and Bill saves creds, Claude runs Phase 0 → Phase 1 non-stop. S-4/5/6/7 stay blocked until Phase 1 backfill + reconciliation populate. **PHASE 1 SHIPPED 2026-07-22 (ADR-0057):** real MyMRC ingestion is now BUILT end-to-end — mappers adapted to the real Phase-0 catalog, a windowed backfill worker (pages every object×list-view to `hasMoreData:false`, resumable via `mymrc_backfill_cursors`; **backfill is windowed-complete**, not floor-capped), the hourly sync wired to the real objects with global-pull site-on-data derivation, the stale-session self-heal, and the reconciliation-feed (queue-only). O-12 is STILL the only gate: nothing runs until Bill provisions `MYMRC_CRED_KEY` and saves creds. Once it runs, the CA source candidates (S-10 / the S-4 CA analog) surface as `new_record` rows in the Wave-2 queue at first backfill for **bulk-approve** — nothing is auto-written to `sources`; approve is the only write. | ADR-0057 §5.2 / D9, `/admin/mrc-scrape` | Halted per D9 (fail-loud, no silent no-op). Surface + auth transition BUILT 2026-07-22. Phase 1 ingestion BUILT 2026-07-22. |
| O-2 | **DECIDED + SURFACE BUILT 2026-07-16 — portal upload.** `/admin/file-drop` inbox live (admin-only): Bill dumps ANY file → stored to R2 + manifested with a best-effort `detected_kind`; Claude Code downloads + classifies/routes each (workbook staging / equipment import / etc.). REMAINING: Bill uploads the June/July workbook + Terex/Eugene files, then Claude runs §8.2 (ADR-0048 parser + promotion, June close-balance **3,977** assertion — corrected from the buggy 4,062; the workbook's grid double-counted the DAY23 non-program row, ADR-0037). **Kelsey window: before 8/1.** | rollup §7, `/admin/file-drop` | Capture done; §8.2 promotion awaits the actual files. |
| O-3 | ✅ **CLOSED 2026-07-22 — RESTIC_PASSWORD off-box CONFIRMED.** Verified directly via the fleet 1Password secrets stack (`~/.config/op/fleet-service-account.env` → Fleet vault): item **"DR3-Vision backups — restic + R2 repo (ADR-0037 D7 / P1-4)"** holds the restic repo `password` field, and its **SHA-256 matches the on-box `~/.dr3-vision-secrets/restic-dr3.env` value exactly** — proving the DR key exists off the backed-up host. Restore drill (P1-3) already MET (`d4917d0`). BOTH D7 activation preconditions now satisfied; the prior contradiction (this row vs `restore-drills.md` CLOSED 2026-07-06) is reconciled — the 07-06 closure stands, re-verified today. **Loads & Inventory flipped `live` for Woodland + Eugene 2026-07-22** (audited, attributed Bill). | go-live plan Stage 0 | Was the last gate in `assertLoadsInventoryActivated`. |
| A-1 | **Full-stack audit 2026-07-21 remediation (this session).** P1-3 backup alerting FIXED (this branch). Remaining confirmed P1s + week-list P2s in flight on `fix/audit-wave1`: P1-1 transport invoice status filter, P1-4 payroll-cron paging/retry, event-leg null-cost guard, OTel DoS bump, Chromium semaphore, cron secret split. P1-2 (build cgroup vs ADR-0062 cap) + P1-5 (fast-rollback retag) are host/deploy ops — operator/deployer follow-ups. **Operator action queued:** rotate NEXTAUTH*SECRET after the cron secret-split lands. Full report: `scratchpad/audit-report-20260721.md`. | audit 2026-07-21 | Report has P0=0, P1=5 (all confirmed, 0 refuted), + P2/P3 backlog. |
| O-4 | **HELD 2026-07-16 (Bill): do NOT create Mary's account now** — no other accounting staff has billing-verify, so she won't either for now. Revisit if that changes. | rollup §1.2 | `/admin/billing/verify` stays admin/super-admin-reachable only. |
| O-10 | **Five security-audit decision items** (2026-07-16 audit): D1 Next.js auth-layer bump (+D5 CVE clear), D2 session revocation strategy, D3 CSP nonce, D4 verify svdp.us DMARC + sender-header gate | ADR-0053, `docs/security/2026-07-16-full-stack-audit.md` | Each needs Bill's call/deploy window; recommendations + sequencing in ADR-0053. The `[fix]` findings already shipped (PRs #116/#117). |
| O-6 | **Kelsey capture register — effectively CLOSED (2026-07-17, rollup §A.11).** 4 of the 5 walkthrough items are resolved: DAY6 `×5` (B10-3) CLOSED as a false lead — Kelsey didn't recognize the concept; the "×5" was a garbled survey artifact, the real DAY6 cotton-block quirk was already solved in PR #87 §3.2 (§A.3). `%` column ANSWERED — it's per-vendor recycling rates, now built as ADR-0055 (§A.4). Event units (B10-4) ANSWERED — they feed the program pool like standard inbounds; event \_billing* is separate (Rick owns the mechanics) (§A.5). B10-5 (commodity → invoice mapping) CLOSED — NOT REQUIRED for billing (§A.1), which simplified the ADR-0041 invoice math to a single line. **RESIDUAL asks:** (1) `saved_units` (B10-2) — Kelsey confirmed the model (draw from non-program pool) but Rick must confirm OR practice; (2) MRC contact map + Re-TRAC filing — PENDING, on Kelsey's post-8/1 knowledge-transfer side (non-blocking). | rollup §A.11 / §8.3 / PR #87 §3 | Register closed except the 2 residuals above. |
| O-7 | **Answer: does Mary's outgoing stewardship-fee AP booking warrant a Vision surface?** | rollup §1.6, ADR-0046 note | If yes → draft an ADR (takes the NEXT FREE number at draft time — 0052 went to commodity payment reconciliation; numbers are never reserved). Also clarify which direction the fee flows. |
| O-8 | Remaining Stage-0 runbook rows (operator roster seed, ~~MyMRC profile enable~~ **DONE #158**, DR3# counter alignment with Janette, Rick's rate tables, E0/E-Rick comms). **UPDATE 2026-07-23:** MyMRC profile-enable DONE (#158 un-gate); **Loads & Inventory D7 go-live DONE** (rollout flipped `live` both sites 2026-07-22, both ops preconditions closed). Residual = operator-roster/DR3#-counter/rate-tables/comms rows, still Rick/Janette-dependent. | go-live plan Part 1, Stage 0 | See the plan's table for runbook links per row. |
| O-11 | **Audit wave-1 P2 cron-secret split — pre-deploy step + NEXTAUTH_SECRET rotation.** The `fix/audit-wave1` compose change moves the cron daemons off `auth.env` onto a new single-secret `cron.env`. **(1) BEFORE merge/deploy, on CHAD:** `umask 077 && grep '^INTERNAL_CRON_TOKEN=' ~/.dr3-vision-secrets/auth.env > ~/.dr3-vision-secrets/cron.env` (inert until the new compose lands; if forgotten, deploy fails loudly + non-destructively — old stack keeps running). **(2) After deploy verified:** remove the `INTERNAL_CRON_TOKEN` line from `auth.env`. **(3) Off-shift:** rotate `NEXTAUTH_SECRET` (and ideally the Entra client secret) — both were exposed to the cron containers; this change CONTAINS but does not UN-EXPOSE them. **(4) `bonus-escalation-check` also mounts `ntfy.env` (fail-soft `required: false`)** so its app-independent P1-4 fire-failure page can reach ntfy directly when the app is down; deploy tolerates the file being absent (the daemon then falls back to the tokenless ntfy.sh topic), so this adds no new pre-deploy blocker. | ADR-0053 addendum (2026-07-21), `docker-compose.yml` | Rotation is the only step that actually revokes the prior exposure; steps 1-2 are the deploy mechanics. |

| O-13 | ✅ **DONE 2026-07-29 — deployed and verified live.** `ap-escalation-scan` and `ap-morning-digest` are both up on svdp-dev; the scanner ran its first real tick at 06:10 UTC (`scanned:0, escalated:0, problems:[]`) and the digest is anchored to 13:00 UTC = 06:00 PDT, confirming the DST-aware scheduling. **CORRECTION to the original note:** it said to add these to the noc-master service-registry `containers[]`. **That field does not exist** — 0 of 38 services in `data/service-registry.json` have a `containers` key (the `containers[]` in noc-master code belongs to the DEPLOYER config in `data/config.yml`, a different file). Monitoring discovery is LABEL-based: the logging driver ships `com.barnardhq.service,project,env,tenant`, and both new containers already carry the full set via the `*barnardhq-labels` anchor (`project=dr3-vision, service=ap-escalation-scan, env=prod, tenant=svdp`, verified with `docker inspect`). They are already monitored; no registry edit is needed, and adding one would have created a field nothing reads. |

## 2 — Blocked on stakeholders

| #    | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Blocked on                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1  | ADR-0050 dispatch-integration draft (3 email types + parser signals)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Morena's 2–3 example emails per type                                        | She committed to forwarding them (rollup §2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| S-2  | "Verbal capture" surface for phone/text swap requests (ADR number assigned at draft time)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Product go-ahead post-cutover                                               | Parked deliberately (rollup §2.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| S-3  | Eugene source names/addresses (Thompsons Sanitary Service, Stayton Community Center, Deschutes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Rick                                                                        | Seeded 2026-07-10 with Address TBD; names to be confirmed against his forms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| S-4  | **§7 OR source seeds — CANONICAL NAMES LANDED 2026-07-21 (rollup §1/§12, ADR-0037b); rate-model wiring (C-16) still deferred.** Rick's canonical MyMRC name→entity mapping arrived in the 2026-07-21 rollup §1/§12, so the schema agent applied it: 5 OR sources renamed id-preservingly to the verbatim MyMRC names (incl. the verbatim typo "Glenwood Central Recieving Station"), 14 new eugene rows seeded (11 `svdp_internal_store` billing-off, + The Dalles/Rifes/Roseburg parked), 22 `source_aliases` rows seeded so the old/variant names resolve at intake (parser + promotion + MyMRC upsert all wired). `Sponsors` clarified as a provenance agency (`provenance_agencies`), not a source. The original §7.2 objections (a)-(b) — names + aliases — are thereby resolved. **STILL OPEN — objection (c), site_type classification of the OR BILLING sources:** only the 11 `svdp_internal_store` rows carry a `site_type` (billing-off) and Roseburg is parked; the 5 renamed OR collection sources + the 2 new active billing rows (The Dalles, Rifes) were seeded `active_billing=true` with `site_type` NULL. `resolveSiteTypeBilling` THROWS `SiteTypeUnclassifiedError` for an active-billing source with a null `site_type`, so every one of these refuses the moment the C-16 resolver wiring lands — the `collection_site` / `cvp_retailer` / `mrc_inbound` stamping is Rick/Bill data and is NOT yet applied. (Rifes appears as the `cvp_retailer` example in the `SourceSiteType` doc block in `schema.prisma` ONLY — that is documentation, the row itself is unclassified.) **STILL OPEN — objection (d):** OR rates remain in `state_program_rules` (where the generator reads them); `source_service_rates` (ADR-0040) still has no generator consumer — the migrate-vs-keep decision is **C-16** and gated on Bill's rate-model call. 4 unnamed-by-Rick OR sites (Short Mountain, Thompsons, Stayton, Deschutes — see S-3) left as-is. | Bill (rate-model decision — see C-16)                                       | Names + aliases DONE. **site_type classification of the OR billing sources is NOT done** — folded into the C-16 wiring gate (stamp `collection_site`/`cvp_retailer`/`mrc_inbound` on the 7 active OR billing rows the same time the resolvers are wired, or they all throw). Remaining = the C-16 rate-model fork (keep `state_program_rules` current-wired vs migrate to per-source `source_service_rates` + generator rewire); §10.5 still gates live-rate seeding on Bill. **NOTE 2026-07-22 (ADR-0057 D4):** the CA (Woodland) analog of objection (c) now has a data home — `CA_SOURCE_DISAMBIGUATION` carries Rick's per-source `siteType`/`isProgram` and is the operator's reference when the reconciliation queue surfaces those CA `new_record`s at first backfill. This does NOT resolve the OR site_type classification (still folded into C-16); it only means the CA billing-pool intent is captured, not that any classification has been written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| S-5  | **MRC invoice: incentives (B7) + event-misc (B8) on the processing invoice?** ADR-0041 still composes B7/B8 as ancillary lines → GP `Misc`. §A.7 single-line math (`units×rate + trade_discount`) is EXACT for a clean Woodland processing invoice (no incentives/events → Misc $0). If they should be OFF the processing invoice, it's a one-line change that CHANGES BILLED MONEY.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Mary/Rick                                                                   | Needs explicit sign-off; not done unilaterally (ADR-0041 amendment §residual-1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| S-7  | **Recycling rate: Xtraction steel 0.81 vs 0.8098?** Kelsey's verbal example (1,054 trash + 4,487 steel on 5,541 lb) implies 80.98%, not the 0.81 she stated. Seeded the confirmed **0.81** (derives 4,488/1,053). Other wood-recycler rates unknown. **UPDATE 2026-07-21 (rollup §11):** Steel × Xtraction @ **81%** now CONFIRMED against real production data (matches Kelsey Q4) — the 0.81 seed is validated. Residual = the remaining wood-recycler rates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Kelsey/Morena                                                               | 81% confirmed; ADR-0055 seed stands. Still confirm the remaining wood vendors. **NOTE 2026-07-22 (ADR-0057 §A.5):** the `Xtraction × metal = 0.8100` seed is now pinned by a test guard against silent drift.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| S-9  | **Per-location container-rental roster needed from Rick before rental lines can be data-driven.** The handoff (§6.1/§13) gives only the June TOTALS — **CA $10,800/mo (44 rentals)**, **OR $900/mo (6 rentals, incl. The Dalles at +$100)** — not the per-location `$/site` breakdown. `container_rental_sites` is seeded EMPTY (`prisma/seed.mjs`), so per-row seeding would require inventing per-location values (rollup §15 DO-NOTs). Consequently the **CA $10,800 + OR $900 rental basis for the EOM `MILES 0` line has no data home** — the aggregate is correct against §10 but the composer cannot derive it from `container_rental_sites` rows until the roster lands. The Dalles `+$100` exists only as a source-row note in the seeds migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Rick (per-location rental roster: `$/site` for the 44 CA + 6 OR containers) | Once the roster arrives: seed `container_rental_sites` per location; the composer then derives the rental leaf from rows instead of a hardcoded total. Reconciles to $10,800 CA / $900 OR. See also C-10 (flat-monthly, no proration).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| S-10 | **15 residual June Woodland source names unresolved — block the June Woodland promotion.** Tonight (2026-07-21) 30 evidence-confirmed Woodland nicknames were backfilled into `source_aliases` (repo seed + `20260731_woodland_source_aliases` migration). These 15 remaining names from the June Woodland workbook still have NO canonical source / alias, so they cannot resolve at promotion (June units observed in the staged import, from `workbook_import_rows` sum): **Western Placerville (1,215), Recology San Francisco (477), Other (440), Sleep Number (428), Lake County (138), Ikea ×3 — Palo Alto 129 / Emeryville 125 / West Sac 41 (295 total), Golden Bear (97), Humboldt Moving (97), Recology Healdsburg (85), City Of Chico Event (80), Go Getter Company (64), Recology Sonoma (47), Illegal Drop off (31).** Ambiguous-candidate notes for Bill/Rick: Western Placerville (Western Placer WMA Lincoln vs El Dorado Disposal), Sleep Number (Redding vs Sacramento store), Lake County (Lake County Waste Solutions vs Eastlake Landfill), Humboldt Moving (Crescent City vs Eureka yard). Not-in-catalog: Recology SF/Healdsburg/Sonoma, Ikea ×3, Golden Bear, Go Getter — likely new Sources pending MyMRC name confirmation. Category rows: Other, City Of Chico Event (likely an event), Illegal Drop off (consumer-drop illegal channel). The June Woodland promotion (import `ba3beeeb-442d-46ed-ad30-b1a7975906f9`) waits on Rick's reply mapping each to a canonical source (or confirming a catch-all like `Other`/`Illegal Drop off`).                                                                                                                                                                                                                                                                                                                                                                                           | Rick (canonical name → source mapping for the 15)                           | Once Rick replies: add each as a `Source` (or alias) the same way the 30 landed, then run the §8.2 June Woodland promotion. Related: O-2, §8.2. **UPDATE 2026-07-22 (ADR-0057 D4 integrator):** Rick's 2026-07-21 reply resolved 7 of these into confirmed canonical CA sources, now captured in `src/lib/mymrc/ca-source-seed.ts` (`CA_SOURCE_DISAMBIGUATION`). The D4 reconciliation queue + surface (`/admin/mymrc/reconcile`) and the CA seed data are BUILT — at the first post-Phase-0 backfill these 7 surface as `new_record` candidates for Bill's **bulk-approve** (nothing is auto-written to `sources`; approve is the only write). The other 6 (5 hinted in `CA_SOURCE_DISAMBIGUATION_PENDING`, 1 unhinted) stay blocked on Rick's exact canonical names. **UPDATE 2026-07-23: the June Woodland promotion is SUPERSEDED — June was anchored DIRECTLY to Rick's signed close (3,748 program / 229 non-program = 3,977) as a `measured` physical snapshot (Bill's "count june" call), so the surface reads the correct number without resolving all 15 source names. The non-program CLASSIFICATION now has data (#166: Morena's 12-site charging list + the out-of-state-by-generated-location rule). Backfill DID run (7,207 hauls). RESIDUAL = the per-supplier June DETAIL (the 15 names → canonical sources) still needs Rick's reply — email sent to bill.barnard@svdp.us 2026-07-23 to forward. Not blocking; the June TOTAL is correct.** |
| S-8  | **Covanta WTE % + Xtraction-Landfill classification pending Rick (rollup §11, soft blocker).** The EOM commodity attachment (ADR-0055) renders recovery-% + recycled-lbs today, but the metal→Steel/Xtraction-Landfill/Covanta-WTE taxonomy split is **taxonomy-driven** and awaits (1) Covanta's WTE recycling %, (2) whether MRC wants Xtraction Landfill as a separate reporting block vs Rick's rendering choice. Rick email sent 2026-07-20, awaiting reply. NOT launch-critical for pilot — the split slots in as a data change when the answers land (invoice-gen agent built the render seam; `OutboundCommodity` currently carries the daily-log-9 taxonomy where `metal` is one bucket).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Rick                                                                        | Soft blocker; pilot launches without it. When answered: extend the commodity taxonomy + the attachment block, no code-path change. **NOTE 2026-07-22 (ADR-0057 §A.4):** Covanta is now seeded as an INACTIVE vendor with NO rate — its name is suppressed from the customer-facing commodity attachment until Rick's WTE % + block boundary land (no WTE % is invented as a recycling %).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 3 — Code follow-ups (accepted residuals, not bugs)

| #                            | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Source                                                                                                                                                                                                                                                                                                                                                                                                                          | Shape                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| C-1                          | `invoice_export` **v2 contract bump** carrying the trade-discount fields — lands WITH the GP adapter (blocked on Mary's packet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ADR-0041 §D review item 1                                                                                                                                                                                                                                                                                                                                                                                                       | Deliberate: v1 stays frozen; the adapter must not re-derive from line JSON.                                                                                                                                                                                                                              |
| C-2                          | Credit-memo **admin UI** (list + transition actions)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ADR-0041 §D item 2                                                                                                                                                                                                                                                                                                                                                                                                              | API + state machine shipped (PR #92/#93); UI is the follow-up.                                                                                                                                                                                                                                           |
| C-3                          | Credit-memo **cancel/withdrawn state**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ADR-0041 §D item 4                                                                                                                                                                                                                                                                                                                                                                                                              | Today a memo whose invoice was voided out-of-band can only bounce between `rejected` and a failing reissue (compensated + audited, but wedged).                                                                                                                                                          |
| C-4                          | Credit memo ↔ ADR-0039 **finding soft-link** (provenance chain finding → memo → superseding invoice)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ADR-0041 §D item 3                                                                                                                                                                                                                                                                                                                                                                                                              | Nice-to-have provenance.                                                                                                                                                                                                                                                                                 |
| C-5                          | Section-resolver **provenance telemetry for §8.2** — flag category tabs that only resolve via the name-fallback tier so unconfirmed row-2 label rules fail loudly against real files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ADR-0041 §D item 5 / resolver TODO                                                                                                                                                                                                                                                                                                                                                                                              | Do during §8.2 finalization.                                                                                                                                                                                                                                                                             |
| C-6                          | **Period-close manual-close residual**: an app outage spanning the whole retry budget (~07:00–09:30 PT on a close day) still needs a manual close; nothing pages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | PR #93 / cron audit F4                                                                                                                                                                                                                                                                                                                                                                                                          | Candidate: daemon-side ntfy page on final give-up. Documented in `scripts/bonus-period-close.mjs`.                                                                                                                                                                                                       |
| C-7                          | **Client-side GlitchTip DSN not baked** into the browser bundle — client React errors go unreported (server-side reporting is live)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2026-07-10 ops sweep                                                                                                                                                                                                                                                                                                                                                                                                            | Needs `NEXT_PUBLIC_GLITCHTIP_DSN` at image build (Dockerfile ARG), not runtime env.                                                                                                                                                                                                                      |
| C-8                          | **AP `pendingApCount` excludes ON-HOLD items** from the ADR-0043 digest count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | AP audit #6 (deliberate, test-asserted)                                                                                                                                                                                                                                                                                                                                                                                         | Product call for Bill: is a held invoice "pending" in the digest sense?                                                                                                                                                                                                                                  |
| C-9                          | **Workbook-wins sync never deletes**: a row Kelsey removes from the workbook survives in `processed_units_daily` (caught only by ADR-0039 comparators/parity); **mid-edit rows never age out** (a permanently malformed date cell = a day silently absent, by D11 design, with no aging alarm)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | billing audit M6                                                                                                                                                                                                                                                                                                                                                                                                                | Revisit at §8.2 / before cutover parity window.                                                                                                                                                                                                                                                          |
| C-10                         | Container rentals bill the **full monthly rate for any overlap** (no proration; a boundary-spanning rental bills full in both months)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | billing audit M7                                                                                                                                                                                                                                                                                                                                                                                                                | Believed intentional (flat monthly) — confirm with Rick, then document in ADR-0040.                                                                                                                                                                                                                      |
| C-11                         | Transportation generation is a **per-load N+1** (~6 queries/load, serial)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | billing audit M5                                                                                                                                                                                                                                                                                                                                                                                                                | Operator-triggered, tolerable; batch when invoice volume grows.                                                                                                                                                                                                                                          |
| C-12                         | `bonus-eod-check.mjs` is a **fat daemon** (direct Prisma + business logic, diverges from the thin-daemon contract; bypasses the in-process ntfy cooldown ledger)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | cron audit F6                                                                                                                                                                                                                                                                                                                                                                                                                   | Refactor to internal-route shape when next touched.                                                                                                                                                                                                                                                      |
| C-13                         | Shared **ForbiddenPage** component — 4 inline copies across admin pages (billing-rates already extracted its own)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 7/9 review pass                                                                                                                                                                                                                                                                                                                                                                                                                 | Consolidate on next admin-surface touch.                                                                                                                                                                                                                                                                 |
| C-14                         | ✅ **RESOLVED 2026-07-22** — worker UN-GATED (#158: `profiles: ['mymrc']` removed, `restart: unless-stopped`), creds provisioned, mid-run re-auth hardened (clean-context rebuild). Running clean (consecutive `ok` sync-runs; hourly detail enrichment). Was: `mymrc-cron` timer fix shipped but service stays **profile-disabled** (creds unprovisioned)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | cron audit F1                                                                                                                                                                                                                                                                                                                                                                                                                   | Re-enable steps in `docs/` + compose comment; safe to re-enable now.                                                                                                                                                                                                                                     |
| C-15                         | **`ap_attachments.is_inline` capture** — replace the 50 KB image size-heuristic with Graph's exact `isInline`/`contentId` signal (`normalizeFile` → `persistFile` → new column)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ADR-0046 note 2026-07-15 (PR #101)                                                                                                                                                                                                                                                                                                                                                                                              | The heuristic ships fine; this is the durable form.                                                                                                                                                                                                                                                      |
| C-16                         | **ADR-0040 rate resolvers built but NOT wired into the generator.** `resolveSiteTypeBilling` / `resolveSourceServiceRateCents` / `resolveWoodlandFreightCents` (`src/lib/billing-rates/`, PR #132) have no caller in `src/lib/invoices/generation-inputs.ts` — the live generator still prices OR via `resolveFreightCents` (`account_haul_rates`+`transport_rate_tiers`) and reads per_mattress/processing rates from `state_program_rules`. The new resolvers + `source_service_rates` are forward-infra.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | PR #132 / 2026-07-18 §7-seed audit                                                                                                                                                                                                                                                                                                                                                                                              | Deliberate for now (pilot mode = no live MRC send). Wiring is coupled to the S-4 rate-model decision — do BOTH together or the two paths drift.                                                                                                                                                          |
| C-18                         | **Event-billing + TONU compute layer built (ADR-0056) but NO rate rows seeded and NOT wired into the invoice generator.** `src/lib/event-billing/` prices the six §5.3 components (leg transport, labor wages, driver wages, per-diem, IRS mileage) + TONU, but the rate constants (`irs_mileage_rate` `StateProgramRuleKind`, plus the reused labor/driver/per-diem hourly/nightly kinds) have **NO seeded values** — the figures are not in the handoff, and the module fails-loud (`EventRateUnavailableError` 409) rather than guessing $0. Zero-activity events correctly total $0 with all rates null (the OR-June case). No `collection_events`→invoice generator wiring yet; the exact `EVENTO` vs `MILES 0` line membership is an invoice-agent call against the §10 reconciliation. **UPDATE 2026-07-21 (audit wave-1 P2):** the _existing_ `fetchEventCostRows` null→0 path (`src/lib/invoices/event-leg.ts`) is now guarded by `assertEventCosted` (`event-leg-guard.ts`) — an event with a billable quantity but null stored `*_cents` throws `EventUncostedError` (422) instead of silently billing $0. This hardens the current path; it does NOT wire `computeEventBilling` in — that (and rate seeding) remains this item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | ADR-0056 / rollup §5.3                                                                                                                                                                                                                                                                                                                                                                                                          | Seed the rate constants when Rick/Mary supply the figures; then wire `computeEventBilling` into the invoice generator's EVENTO/MILES-0 path. Both gated on real numbers — never invent.                                                                                                                  |
| C-20                         | **Rewire `onHand()` to the `unit_status_movements` ledger (currently derives saved-vs-on_floor from aggregate close columns).** ADR-0037 amendment §5.2 shipped the `unit_status_movements` schema + contract but NO writer — the §15-2 iPad ops ("Mark N as saved", "Send N saved units to [store]" = a `saved → sold` movement carrying `store_destination_id` → the `svdp_internal_store` source) do not exist yet, so the ledger is empty and `onHand` (and the §3 floor tile that reads it) still computes the pools from `processed_units_daily` aggregate columns. The live floor tile depends on this: once real store-transfers flow, the movement ledger becomes the source of truth and `onHand` must consume it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ADR-0037 amendment §5.2 (`docs/adr/0037-loads-inventory-foundations.md` "STILL DEFERRED")                                                                                                                                                                                                                                                                                                                                       | Later, separate change (inventory feature agent): build the two iPad ops as ledger writers, then rewire `onHand` to read `unit_status_movements` instead of the aggregate close columns. Money-safe today (saved units correctly stay on the floor per §5.2); this is a fidelity upgrade, not a bug fix. |
| C-21                         | ⚠️ **CAUSE CORRECTED 2026-07-29 — the "Switch Account" diagnosis is WRONG.** Eugene has 0 `mymrc_haul` rows, but NOT because the session is stuck in one recycler context. Investigation (PR #179 §4) proved: (a) **no contamination** — `siteCodeFromDiscriminator` has NO Woodland default (unmatched → NULL), and exactly 2 rows with a blank recycler correctly landed NULL, which is the proof the null path works; every one of the 7,233 hauls genuinely carries `Recycling_Center_Lookup__c = 0014600000is4tFAAQ`. **Woodland's backfilled inbound is NOT overstated and the MRC billing basis is intact.** (b) The real cause is **§4b list-view scope**: `mymrc_backfill_cursors` shows every view paged to COMPLETION (`completed_hauls` 8000/6185, `consumer_drop_off_rc` 993, `docking_appointments_rc` 29, `outbound_active` 6000/4490) — nothing was truncated. Those are the **"(RC)" Recycling-Center-scoped views** from `docs/mymrc-discovery-2026-07-22.md`. The scrape enumerated LIST VIEWS rather than issuing org-wide queries, and the views themselves are the boundary. Bill confirms his credentials see all sites, so switching accounts was never the fix — querying outside the (RC) views is. (c) **Still to check in the MyMRC UI before building anything:** whether Eugene has `Haul_Request__c` records at all. Eugene runs collection sites and thrift stores rather than Woodland's hauler network, so its inbound may live on a different object — in which case there is no gap. Also note the handoff's §4(a) query path (`payload->'fields'->'Recycler__c'`) does not exist in the stored payload; the real field is `Recycling_Center_Lookup__c`. Original text retained: **MyMRC pull covers ONE recycler context — the Woodland↔Eugene "Switch Account" iteration is next (ADR-0057 Phase 1).** The Phase-0 authenticated session lands in a single recycler/account context (observed: DR3 Woodland). MyMRC exposes a "Switch Account" control to move the admin session to the other recycler (Eugene); the current backfill + hourly sync pull only the context the session is in, so Eugene records are not yet fetched. The site-on-data derivation (`siteCodeFromDiscriminator`) already handles both `DR3 Woodland` and `DR3 Eugene`, and the backfill engine is per-object×list-view — so iterating both contexts is a transport addition (drive the Switch-Account control, then re-run the same targets), not a schema/mapper change. Until then, Eugene mirror rows stay unpopulated and Eugene source candidates do not surface in the reconciliation queue. **DEADMAN FALSE-GREEN FIXED 2026-07-22 (review remediation):** the scrape used to loop `['eugene','woodland']` against the one global session, so the vestigial eugene pass wrote `ok` sync-runs that made the deadman believe Eugene was healthy forever. The scrape now pulls + deadman-watches only the **active recycler context** (`resolveActiveSites`, default `woodland`, overridable via `MYMRC_ACTIVE_SITES`). When Switch-Account lands, add `eugene` (env or default) so it gets a real pull AND real deadman coverage. | ADR-0057 Phase 1 / recon B §6                                                                                                                                                                                                                                                                                                                                                                                                   | Next MyMRC iteration: teach the portal-client to switch recycler context and run the backfill/sync targets per context. No billing math depends on it yet (pilot = Woodland-first).                                                                                                                      |                                                                                               |
| ~~C-24~~ RESOLVED 2026-07-22 | **Windowed backfill worker is now LIVE — offset-pagination adapter + one-shot entrypoint shipped.** The `getItems` OFFSET pagination mechanism was CONFIRMED LIVE against the real portal 2026-07-22 (`filterName`+`entityName`+`pageSize:50`+`offset:N` → `{records, offset, hasMoreData}`; loop to `hasMoreData:false`). Encoded pure in `src/lib/mymrc/list-page.ts` (codec + list-view id resolver, unit-tested), driven by `createBackfillPortalClient`/`playwrightBackfillSession` (`backfill-portal-client.ts`) which reuses the sync's self-healing admin session via the new `openAdminSession`. `scripts/mymrc-backfill.mjs` runs it one-shot (`node scripts/mymrc-backfill.mjs`). `pageIndex → offset = pageIndex*pageSize` keeps the engine's DB-durable `last_page_index` cursor resumable. List-view ids: 2 captured live (Docking, Processed); the other 3 resolve at RUNTIME from the browser's own getItems request, or via `MYMRC_LISTVIEW_IDS` override — an unresolved id fails LOUD per-target (never guessed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ADR-0057 D3 / 2026-07-22                                                                                                                                                                                                                                                                                                                                                                                                        | DONE. Follow-ups: capture/override the 3 not-yet-observed list-view ids on first live run; C-21 (Switch-Account) to backfill the Eugene context.                                                                                                                                                         |
| C-22                         | **Outbound `vendor` (`Outbound_Vendor_Name__c`) stays NULL — it is a getItems list-only column absent from the record detail.** Verified against the Materials Phase-0 discovery metadata: `Outbound_Vendor_Name__c` is a list-view column, not in the `getRecordWithFields` detail field set, so `mapOutboundRecord(record)` yields `vendor: null` on real data. The mapper already accepts a threaded value (`mapOutboundRecord(rec, { vendor })`); wiring it requires the transport to capture per-id vendor from the `getItems` list pass and thread it through both the hourly sync and backfill detail writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ADR-0057 Phase 1 (mappers/sync/backfill agents)                                                                                                                                                                                                                                                                                                                                                                                 | Thread the list-captured vendor once the transport extracts per-id list-column values; until then outbound rows carry `vendor=NULL` (non-billing field).                                                                                                                                                 |
| C-23                         | **Dock_Availability_Schedule\_\_c is backfilled but NOT wired into the hourly sync ledger.** The mapper (`mapDockAvailabilityRecord`), mirror (`mymrc_dock_availability_mirror`), and backfill target are all built and the object is windowed-backfilled — but the hourly `syncFeed` path does not yet carry an `'availability'` feed. Two coupled decisions block it: (a) add `'availability'` to `FeedName`/`FEED_NAMES` + `FEED_LIST_PATH`, and (b) `mymrc_sync_runs.site_id` is `NOT NULL` while dock availability has NO site discriminator in its 14-field set — its run-ledger row needs either a nullable `site_id` or a global sentinel. Non-billing scheduling data, so no money impact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ADR-0057 Phase 1 (sync agent)                                                                                                                                                                                                                                                                                                                                                                                                   | Add the availability feed + resolve the `mymrc_sync_runs.site_id` nullability/sentinel decision, then wire `mapDockAvailabilityRecord` into `syncFeed`. Backfill already keeps the mirror fresh in the meantime.                                                                                         |
| C-25                         | **Hauls list-view picker "More" — possible uncatalogued haul history views (ADR-0057 D3).** The full-history backfill now pages the confirmed history views (`completed_hauls` + inactive Materials, captured live 2026-07-22). The Hauls list-view picker also shows a **"More"** entry that MAY expose additional views beyond Docking / Consumer Drop-Off / Completed Hauls. Per the "never guess a transport id" rule, none were added speculatively. RESIDUAL: on a live run, expand the "More" menu, capture any additional view's `filterName` (`00B…`) + title, and add a one-line `BACKFILL_LIST_VIEWS` entry (or an `MYMRC_LISTVIEW_IDS` override) if it carries records not already covered by the 3 hauls cursors. Low-risk (dedup by `salesforce_record_id` makes any overlap a no-op); the gap is only records that live EXCLUSIVELY under a "More" view.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ADR-0057 D3 / 2026-07-22                                                                                                                                                                                                                                                                                                                                                                                                        | Capture ids from the live picker, then extend the map. No code change until an id is in hand.                                                                                                                                                                                                            |
| C-29                         | **`bonus-cycle-e2e.test.ts` is FLAKY in the payroll-delivery path — and it guards real money.** The case _"(b) delivery FAILURE → stays signed, and t4 at 09:00 PT DOES fire the real deadline-miss"_ intermittently fails with `expected 'paid' to be 'signed'`: the injected PDF failure (`Chromium crashed`) is logged correctly (`[payroll-delivery] PDF generation failed; skipping mail`) yet the period still lands `paid`. Observed 2026-07-28 in the husky pre-push gate (1 failed / 567 passed) on a commit containing **zero `src/` changes**; the same file then passed 3/3 in isolation and the full `src/lib/bonus` suite 2/2. Earlier the same file timed out at 5000ms under full-suite CPU load. Two candidate causes, both worth ruling out: (a) cross-test state leakage — a prior test's period reaching `paid` and bleeding into this one; (b) a genuine race in `payroll-delivery` where the state transition is not properly gated on PDF success. **(b) would be a real payroll defect** — a period marked `paid` when the payroll PDF never generated or sent. Do not dismiss as "just flaky" until the state transition is proven ordered after delivery success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| C-31                         | **DONE (2026-07-28) — flaky CI: `auth-config.jwt-killswitch.test.ts` was a 1-second clock race.** `NOW_S` was `Math.floor(Date.now()/1000)` evaluated at MODULE LOAD while the jwt callback computes its own `now` at CALL time; crossing a second boundary between the two made `last_seen_at` come back one higher and failed two assertions (`expected 1785275672 to be 1785275671`). It failed a CI run on a branch touching none of that code. Fixed by freezing the clock (`vi.useFakeTimers` + `setSystemTime`) so the test and implementation read the same instant by construction; verified 5/5 clean runs. Logged because it is the SECOND time-based flake found today (see C-29, and C-30 for the `poll.test.ts` load-sensitive timeout) — worth a sweep for other `Date.now()`-at-module-load assertions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C-36                         | **`fallback_approver_id = NULL` resolves to a BROADCAST of every reachable admin (ADR-0066 §1.4/§1.6).** The migration seeds NULL for all six pairs, so this IS the production path. §1.4 calls it "the system admin" (singular); the resolver expands NULL to `reachableAdmins` — every active admin with an email (prod has at least Bill + admin-role Kelsey). §1.6 says `second_approval_request` is "never a broadcast", so the shipped default contradicts it. Compounding: `escalated_to` records `targets[0]` off an UNORDERED `user.findMany`, so the audit column names an arbitrary one of the people who were all emailed — it only looks deterministic because the test fake sorts. Fix = designate an explicit system-admin fallback (or make NULL mean "the single lowest-id active admin" deterministically) and record the choice. Found by adversarial review 2026-07-29.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| C-37                         | **The escalation scanner has no weekday gate on its IMMEDIATE-escalation arms (ADR-0066 §1.5).** The elapsed-hours arm is weekday-aware via the shared business clock, but the two "escalate immediately" arms (no routing row; `pending_second_approval` with a null `first_approved_at`) return `{due:true}` unconditionally and `runApEscalationScan` never calls `isBusinessDayNow`. So a misconfigured pair emails staff at 03:00 on a Saturday — which is exactly the weekend pause Bill asked for, bypassed. Low impact (both arms are misconfiguration states, not routine flow) but it contradicts the stated rule. Found by adversarial review 2026-07-29.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C-38                         | **A missed digest permanently drops that day's escalation lines (ADR-0066 §1.7).** `escalationWindowStart` walks back to the PREVIOUS BUSINESS DAY only, so if the container is down Tue+Wed, Wednesday's escalations never appear in Thursday's digest — they are not re-reported, they are simply gone. The window deliberately over-covers by <=6h in the normal case (repeating a line is noise; dropping one is the failure mode), but that reasoning was not extended to a missed RUN. Fix = anchor the window to the last SUCCESSFUL digest rather than to a fixed one-business-day walk-back, which implies a small send ledger. Found by adversarial review 2026-07-29.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| C-39                         | **`fake-prisma` silently IGNORES unmodelled `where` keys rather than applying them.** `{status, site_id:'s-w', received_at:{gte}}` returns BOTH rows. Any filter added later to the digest or scanner will be GREEN in tests and WRONG in production — and given C-36/ADR-0066's site work, a site filter is exactly what someone adds next. Also: `pick()` does not route through `escalatedAtOf`, so `select:{escalated_at:true}` yields `undefined` for an omitting fixture where real Prisma yields `null` (equivalent under every current `!= null` read; diverges the moment someone writes `'escalated_at' in row` or `=== null`). Fix = make the fake THROW on an unmodelled where key. Found by adversarial review 2026-07-29.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C-27                         | **DONE 2026-07-28 (ADR-0063, branch `feat/admin-equipment-screen`).** `/admin/equipment` shipped: list with site/category/status filters + search (all four in the URL), create, edit, and activate/deactivate, behind `requireAdmin()` re-checked in every handler with an `audit_log` row written in the same transaction as each mutation. Nothing is hard-deleted — the `[id]` route exposes NO `DELETE` at all, because `ap_equipment_links.equipment_id` is `onDelete: Restrict` and those rows are financial-approval evidence; `is_active=false` is the only removal, which is what `listSiteEquipment()` already filters on. `(site_id, display_name)` is now a real unique index (migration `20260813_adr0063_...`), promoting the seed script's idempotency key from convention to constraint — verified zero duplicate groups in prod first, since `migrate deploy` runs at container start. All fields incl. `site_id` stay editable even on cited assets — a site-LOCK was built and then REVERSED the same day when ADR-0046 Amendment 7 (PR #181) made the AP selector fleet-wide, killing the lock's premise and making it harmful (it would have made the most-cited assets the ones nobody could fix, blocking exactly the C-28 correction this screen exists for). Both halves recorded in ADR-0063 D4. Amendment 7 also means `is_active` is now the ONLY thing scoping the approver's picker, so deactivate/reactivate hits BOTH sites — see D4a. Latent: the uniqueness key is per-site while the picker is fleet-wide, so identical labels across sites could collide visually (zero today in prod); fix would be naming/grouping, NOT a global index. **The seed script is no longer the only write path** — it reverts to a bulk-import path for a refreshed workbook. NOT deployed: hand-off is the branch, unpushed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| C-28                         | **The equipment site mapping is coarse and known to be coarse (ADR-0062).** The SVdP machine list has NO `DR3 Eugene` facility and only 21 `DR3 Woodland` rows out of 554, so rows were mapped by JURISDICTION (California→woodland, everything else→eugene) per Bill's direction ("load all of this in for all sites — just no better way for now"). Consequence: Eugene's approver picker contains the unqualified OTR fleet and every SVdP Lane County facility; Woodland's contains Livermore + Stockton assets. **Open question: which Eugene-Oregon facility IS the DR3 Eugene operation?** (`Cleveland Warehouse` is the leading candidate — it has its own shear machine `EQ65` — but unconfirmed.) Refine when a real DR3-Eugene asset list exists; re-running the seed script is the update path. **Update 2026-07-29 (ADR-0046 Amendment 9):** this gap is now MEASURABLE and self-correcting at the edges — approvers hitting a missing asset file a tracked `ap_equipment_requests` row instead of mis-filing, so the open-request count per site is a direct read on how incomplete the seed is, and each resolution adds a real, crew-named asset to the registry. Also deferred there: a `location`/`facility` column so the picker can group by real facility (collides with hard rule #1 the moment a Stockton row renders).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| C-30                         | **`src/lib/ap/poll.test.ts` is a SECOND file with the C-29 5000ms-under-load fragility.** The case _"runApPoll — success > processes the fixture mailbox: 5 created + 1 quarantined…"_ failed with `Test timed out in 5000ms` during a full-suite run on 2026-07-28 that shared the box with a concurrent `next build` (load avg ~15). Re-run in isolation immediately after: **12/12 passed in 4211ms**, with the offending case taking **3889ms of its 5000ms budget even unloaded** — roughly 1.1s of headroom, so any CPU contention tips it over. Unlike C-29 this one looks purely like a budget problem rather than a possible state/ordering defect (the assertion never runs — the test never reaches it). Fix = raise the per-case timeout for the mailbox-fixture case, or find why a mocked-mode poll of 6 messages costs ~4s. Worth doing together with C-29 — a suite that goes red under load trains sessions to ignore red. Surfaced while building `/admin/equipment` (ADR-0063), on a branch touching **zero** AP code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C-26                         | **`CLAUDE.md`'s "done" bar cites a Playwright suite that does not exist.** The "What 'done' looks like" section requires `npx playwright test` green, but there is **no `playwright.config.*` and zero `*.spec.ts` in the repo** (verified 2026-07-28 via `git ls-files`); `npm run e2e` maps to `playwright test` with nothing to run. The only Playwright in the project is the MyMRC **scraper** (ADR-0009), which is app code, not a test suite. Coverage is vitest-only. Every session reads that bullet and either wastes a cycle looking for the suite or reports a green bar it never ran. Fix = either correct the CLAUDE.md bullet to vitest-only, or stand up a real e2e suite and keep the bullet. Surfaced while fixing the ADR-0017 user-list view-reset (2026-07-28).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C-19                         | **Commodity-breakdown PDF has no download/delivery route.** `buildInvoiceCommodityBreakdownPdf` (`src/lib/commodity/fetch.ts`) is the ready entry point but no route serves the EOM attachment alongside the invoice (would touch shared routing/middleware — deferred out of the feature agents' scope).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ADR-0041 amendment / rollup §10                                                                                                                                                                                                                                                                                                                                                                                                 | Add a download route (or fold the attachment into the invoice-detail surface) when the EOM commodity attachment goes live.                                                                                                                                                                               |
| C-34                         | ✅ **RESOLVED on integration 2026-07-29 — the page now exists.** Filed by the §1.7 digest agent, which correctly could not see the sibling worktree: it noted the digest's routing-coverage warning NAMES the table rather than linking a route that would 404. The §1.4/§1.6 config-screen agent built `/admin/ap/routing` + `/admin/ap/notifications` in the same parallel build, so the route is live and the warning can link it. **Residual:** the digest's warning text still names the table instead of hyperlinking — cosmetic, one-line, tracked here rather than silently closed. Original text retained:                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **No `/admin/ap/routing` page.** ADR-0066 §1.4 makes `ap_approval_routing` the source of truth and the §1.7 digest NAMES every approver missing a row, but the pairs are still only editable in the DB. The digest warning deliberately does not hyperlink `/admin/ap/routing` (it would 404). Shape: mirror `/admin/equipment` — list + edit, `requireAdmin()` re-checked in the API, `audit_log` row in the same transaction. | ADR-0066 §1.7 build (2026-07-29)                                                                                                                                                                                                                                                                         | Deliberate: the digest surfaces the gap loudly today; the editor is the ergonomics follow-up. |
| C-40                         | **`can_resolve_equipment_requests` has no admin UI — it is a DB-only grant.** ADR-0046 Amendment 9 §2.5 gates `/admin/ap/equipment-requests` on this flag, seeded by the migration for Morena, Janette (Woodland) and Rick (Eugene). `/admin/users` does not render it (nor does `can_view_ap_history`, the flag it is modelled on — same residual, now doubled). Granting a fourth person, or revoking one, is a hand-written `UPDATE` against production. Fix = surface both flags on the user edit form, coerced manager-only exactly like `can_manage_rates`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | ADR-0046 Amendment 9 build (2026-07-29)                                                                                                                                                                                                                                                                                                                                                                                         | Deliberate for now: the three named managers are the whole intended audience and the ADR-0017 form was out of scope. Revisit the moment a fourth grant is needed.                                                                                                                                        |
| C-41                         | **The Amendment 9 escape-hatch email is not covered by an integration test.** `notifyEquipmentRequestCreated` is exercised only through its recipient resolver (`equipment-requests.test.ts`) and the decide-path wiring (`approvals.test.ts` asserts the request + link rows, not the send). The call site is fail-soft by design — `.catch(() => undefined)` — so a broken send is SILENT, which is precisely the ADR-0066 §B.5 failure class. Mitigations already in place: the recipient resolver can never return an empty set (it falls back to admins) and that fallback IS tested. Fix = a decide-level test asserting one `notifyStaff` call on the `ap_equipment_request` surface with the site-scoped recipients.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ADR-0046 Amendment 9 build (2026-07-29)                                                                                                                                                                                                                                                                                                                                                                                         | Accepted residual: `fake-prisma` does not model the `user.findMany` reach query the resolver needs, so the assertion would test the fake, not the code. Worth doing alongside the C-39 fake-prisma hardening.                                                                                            |
| C-42                         | **The `ap_equipment_requests` worklist has no pagination or archive.** `listEquipmentRequests` returns the whole filtered set (deliberately mirroring ADR-0063 D2 — search, not pagination), oldest first. `?status=all` grows without bound. Zero rows today and the open queue is self-limiting (resolving one removes it), but the `all` view is the one that will eventually get long. Fix = cap or paginate the non-open views.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ADR-0046 Amendment 9 build (2026-07-29)                                                                                                                                                                                                                                                                                                                                                                                         | Accepted residual: identical shape and identical reasoning to the equipment master's list.                                                                                                                                                                                                               |
| C-35                         | **AP morning digest resolves second-approval routing per row (N+1).** `buildApMorningDigest` calls `resolveSecondApproval` once per `pending_second_approval` invoice, to keep ONE definition of "who owes this signature" (re-deriving it in the digest is the exact drift that caused the ADR-0066 outage). Bounded by design — Check A found a zero-row backlog. If the backlog ever runs to dozens, batch the resolver rather than inlining the query.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ADR-0066 §1.7 build (2026-07-29)                                                                                                                                                                                                                                                                                                                                                                                                | Accepted residual: correctness over a query count on a handful of rows.                                                                                                                                                                                                                                  |

## 4 — §8.2 (unblocks the moment O-2 lands)

1. ADR-0048 D4 promotion of June + July + Terex against real bytes (checksums in rollup §7.4).
2. Full-file parser fuzzing; reconcile the resolver's inferred row-2 label rules (only `inb_trans_charges` is confirmed) + DAY-grid stride (cotton col-68 anchor is proven; blocks 1–8 inferred).
3. Woodland June close-balance assertion (= **3,977** — corrected from the buggy
   4,062; the workbook grid double-counted the DAY23 non-program row, ADR-0037).

## Done

- **C-27 — DONE 2026-07-28 (ADR-0063).** The `equipment` master is maintainable
  from the UI: `/admin/equipment` (list + site/category/status filters + search,
  all URL-held), `/admin/equipment/new`, `/admin/equipment/[id]` (edit +
  activate/deactivate), `POST /api/admin/equipment` and
  `PATCH /api/admin/equipment/[id]`. Admin-only, re-gated in every handler,
  every mutation audited in-transaction. Deactivate is the only removal and the
  `[id]` route ships no `DELETE` handler at all — `ap_equipment_links` are
  financial-approval evidence and the FK is `onDelete: Restrict`.
  `(site_id, display_name)` became a real unique index, so the ADR-0062 seed
  script's idempotency key is now enforced rather than assumed and the script
  stops being the only write path. **Still open alongside it: C-28** — the
  coarse jurisdiction→site mapping is unchanged by this work; it is now
  _editable by hand_, which is a mitigation, not a fix. **Not deployed** —
  delivered as the unpushed branch `feat/admin-equipment-screen`.

- **S-6 — DONE 2026-07-21 (Mary answered, rollup §8/§13).** All GP identifiers
  now confirmed: OR customer ID = **`MRCL001`** (same as CA — §8 Q1); Woodland PO
  suffix **`DR3 W`** (with space); Eugene PO suffix **`DR3 OREGON`** (spelled out,
  spaces — NOT `DR3E`/`DR3O`). Transportation/collection POs are kind-derived
  (`M/DD/YY TRANS` / `M/DD/YY TRANS OR` / `M/YY OR COLLECTIONS`). Seeded in
  `seedGpSiteBillingConfig` (the `update` branch now re-applies them, correcting
  rows previously seeded `DR3W`/null); `buildPoNumberForKind` builds them per §6.
  See ADR-0041 amendment + `src/lib/invoices/gp-identifiers.ts`.

- **O-5 — DONE 2026-07-16 (Bill: skip, Option C).** No Eugene June backfill; Rick's 7/20 iPad go-live starts a clean forward-only ledger (Eugene lacks Woodland's billing complexity, so the shadow-billing-parity rationale doesn't apply).

- **C-16 — DONE 2026-07-16 (office dark-theme sweep executed).** Operator
  directive (Bill): "everything goes to the new look except the floor iPads."
  Repainted every remaining green office/manager surface to the Vision
  deep-space theme (`dr3-space`/`dr3-mist`/`dr3-cyan`/`dr3-steel`) following the
  AP reference (PR #99), as an in-place token swap (the optional `office-shell`
  extraction from VisionShell was not needed for the sweep goal and is deferred).
  Surfaces: all `/dashboard/[site]/*` pages + clients (cor, equipment, invoices,
  invoices/[id], loads-inventory, ops, yard), `/dashboard/ops/digests`,
  `/admin/processed-units`, `/admin/production-report`, `/bonus/amendments`, the
  `/login` locale picker, and the app-global chrome (`layout` themeColor,
  `global-error` fallback, the `UpdatePrompt` banner CTA). `/login` was confirmed
  office-only (Entra SSO door; the floor PIN path is under `/operator`), so it
  goes dark. The floor (`/operator/*`) and the COR PDF renderer stay green per
  ADR-0008. A static sweep test (`office-dark-theme-sweep.test.tsx`) now guards
  the "no green office pages" invariant. See the ADR-0051 post-acceptance note.

- **O-9(b) — DONE 2026-07-15 (floor stays GREEN).** Operator decision: "keep
  the floor green." The warehouse-floor iPad surfaces (`/operator/*`) keep the
  ADR-0008 green theme for sunlight/glare readability; the deep-space theme
  remains office/manager-only per ADR-0051. O-9 is now fully closed — (a)
  site tag required shipped same day (PR #105), (b) settled here.

- **O-9(a) — DONE 2026-07-15 (site tag REQUIRED on decisions).** Operator
  directive: "make the site tag required on decisions." Enforced service-side
  (`assertDecisionSite` → `ApSiteRequiredError` 400 before any state change),
  route-side (resolve + refuse pre-CAS), and in the queue UI (required select
  - client guard). ADR-0046 post-go-live amendment note. Only O-9(b) (floor
    iPad theme) remains open above.
- **C-17 — DONE (shipped in the 7/15 AP overhaul).** The decision-mail resend
  path exists end-to-end: `Resend` button in the queue detail →
  `/api/ops/ap/[id]/resend`. Register row was stale.

- **O-1 — DONE 2026-07-15 (AP IS LIVE).** Operator order same day as the
  validation pass: test data purged (3 requests: DB rows, 7 R2 objects, 3
  mailbox emails; audit rows kept) and `ap_notify` flipped to **live at BOTH
  sites** (audited under Bill's admin user; criteria note cites the ADR-0046
  validation record + PRs #98–#102). Mary (`mary.scott@svdp.us`) active in
  `ap_decision_recipients`; approver roster: Morena, Rick, Janette, Kelsey
  (auto-expires 8/8 — extended one week from 8/1 on 2026-07-19, seeded in
  `AP_APPROVERS`). From now on: new-invoice alerts go to the real roster,
  decision mail to the forwarder + Mary CC — no [PILOT] banner. Rollback =
  flip both rows back to pilot on /admin/rollout, one audited action each.

- **O-0 — DONE 2026-07-14.** Bill added `dr3-vision@svdp.us` to the
  `dr3-vision-scoped@svdp.us` RAOP scoping group (Exchange device-code session
  from the workspace host — pwsh 7.4 + ExchangeOnlineManagement now installed
  at `~/.local/pwsh` for future admin one-offs). After propagation the probe
  cleared (201), `M365_MAIL_FROM_ADDRESS` was restored to `dr3-vision@svdp.us`
  on CHAD, app recreated, and a live test report delivered from the proper
  sender (delivered 1). AP mail keeps sending from `approvals-dr3@svdp.us` as
  designed. The 2026-07-10 mitigation is fully unwound.
