# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

**Dates here are PACIFIC, always.** The fleet hosts and git both stamp UTC, which
is 7 hours ahead — so an evening merge lands on the NEXT UTC day. Date an entry by
the Pacific day the work happened, not by the commit stamp. (Two 2026-08-10
entries were briefly headed 2026-08-11 for exactly this reason; corrected
2026-08-10.)

## 2026-08-19 (9:35 AM PT) — ops: AP morning digest now reaches Morena and Janette, not only Bill

The digest's recipient list is the per-user `notify_daily_digest` pref
(ap_notification_prefs), and only Bill's was on — this morning's 6:00 AM send
went to exactly one inbox. At Bill's instruction ("it should be me / morena &
janette") both managers' prefs were flipped on (audited,
`system:ap-digest-recipients-20260819`). The `ap_notify` surface is already
live at both sites, so the next 6:00 AM PT send delivers to all three.

## 2026-08-18 (5:00 PM PT) — The probe was wrong, not the password (ADR-0111)

At 3:51 PM the MyMRC scrape worker paged: `mymrc: still logged out after fresh
login (admin)`. The stored admin credential — created 2026-07-22, never rotated —
was the prime suspect, then a Salesforce Experience Cloud device-verification
challenge. **Both died on measurement, and the credential was never touched.**

**Bill's browser worked, and so did the scraper.** The 4:00 PM cycle, nine
minutes after the page, ran fully clean on the same stored credential: all four
feeds, mirror freshness green, exit 0. The question was never "why can't it log
in" — it was "why does it sometimes believe it hasn't".

**One controlled login, captured.** A single headless login from the scraper image
landed authenticated: the post-submit page carried the "Switch Account" banner and
the "viewing as DR3" context. No verification challenge, no authentication error,
no lockout notice.

**The decisive run.** Re-using ONE authenticated session across twelve
navigations — spending no further logins — and reading the auth state twice per
navigation:

| Read                                         | Verdict                   |
| -------------------------------------------- | ------------------------- |
| At `domcontentloaded` (what production does) | **logged out in 3 of 12** |
| After `networkidle` + settle                 | logged **in** in 12 of 12 |

The session was authenticated every time. The probe disagreed 25% of the time.
Those trials ran against a warm, idle portal — the race belongs to the check, not
to container boot; a boot storm only makes it likelier to lose.

**Why.** `/s/` is an Aura SPA whose authenticated markers paint client-side
_after_ `domcontentloaded`. `looksLoggedOut` is a positive test — correctly so
since ADR-0038 D4 — but it reaches its verdict two ways: a real sign-in form
(decisive) or merely no marker (an assumption). On an Aura shell those are
indistinguishable. Verified against the live capture: the shell carries no
sign-in markup, no sign-in URL and no banner, and an anonymous `/s/` renders that
_same_ shell. `collectAura` already waits `networkidle` + 6 s for exactly this
reason. Only the auth read did not.

### Fixed

- **The auth verdict waits for the page to decide.** New `looksDefinitelyLoggedOut`
  reports decisive evidence only; `isLoginPage` — the one choke point all six
  consumers share — polls every 250 ms up to 15 s. Fail-loud is preserved; the
  bound is a poll _count_, not wall-clock. Honest cost, pinned by a test: an
  expired session renders that same undecided shell, so it waits out the budget
  before failing.
- **Session failures appear in the ledger.** `openAdminSession` throws before the
  first feed row, so `mymrc_sync_runs` read 100% green straight through this
  incident and the only evidence was a container log that a redeploy destroys —
  and did. Session failures now write `feed='__session__'`. No schema change.
- **The page waits for self-heal.** It fired on the _first_ failed tick, gated by
  a cooldown `Map` held in the per-tick process — which exits after every tick, so
  it gated nothing. The ledger now supplies real cross-tick memory: pages on the
  second failure within an hour (ADR-0037 Q3), and fails **open** so broken
  bookkeeping can never silence a real outage.
- **The boot scrape stops racing its own stack.** `BOOT_DELAY_MS` 5 s → 90 s
  (`MYMRC_BOOT_DELAY_MS` to override). Both boot scrapes that day died inside the
  stack recreation — one to this race, one to a `chrome-headless-shell` SIGSEGV
  about two seconds after container start — and both healed at the next
  top-of-hour, untouched.

### Verification

Falsified by reverting `isLoginPage` to its single read: the regression test then
fails with the incident's own string. The unhydrated-shell fixture is a live
capture and carries a guard test — its first draft described the sign-in markup in
its own header comment, which the predicates scan, making the fixture assert the
opposite of its purpose. The test caught it.

## 2026-08-18 (3:30 PM PT) — An untaught kind, an unguarded door, and a number the building cannot hold (ADR-0110)

Bill: on-hand inventory is _constantly_ wrong, especially on the production
report, and it goes negative on both sites. **Two of the four suspected causes
died on measurement, and that is the most useful thing in this entry.**

**The report does NOT compute on-hand a second way.** The standing suspicion was
that `getEodInventorySnapshot` re-derived the balance independently of `onHand` —
"two modules, two chances to disagree". It already delegates _both_ day balances
to `onHand`; live Woodland reads 442 program / 397 non-program / 839 total,
identical on both paths. Its own aggregate queries are `_max` **date** keys for
freshness, not units. There was nothing to unify.

**Woodland's inbound is not under-fed today.** Anchor 2,483 (07-22) + inbound
18,392 + dropoffs 92 − stripped 20,128 = **839**, to the unit. No negative in the
trailing 14 days, zero undated hauls against 7,372 Delivered, and the 15
`Confirmed` hauls are _future_ appointments — what a healthy scheduling feed looks
like. No inbound recovery was run, and none was needed.

**Eugene is EMPTY, not negative.** No anchor has ever been set, `inbound_loads` is
empty all-time, no mirror or processed rows. Its `0` is not a measurement of an
empty building; it is the absence of any measurement. Tonight's count gives it a
first anchor (Tier 0 — no prior, no swing arithmetic, nothing in the way).

### What was actually wrong

**A drop-off `kind` nobody taught the balance about.** `onHand` summed consumer
drop-offs with **no `kind` predicate**, so every kind — present and future —
landed in the PROGRAM pool by default. ADR-0085 added `floor_public` and
`floor_incentive` and this reader absorbed them without anyone deciding it should.
It happened to be right. MRC is billed on program units, so a mis-routed kind is a
mis-invoice **indistinguishable from a correct one**. Now gated twice, because the
enum can grow through two doors: a total `Record<ConsumerDropoffKind, 'program'>`
fails `tsc` with `TS2741` on a new member, and `sumTaughtDropoffKinds` **throws**
on a kind the database returns that the module was never taught — the raw
`ALTER TYPE` door the compile gate is blind to. The query is a `groupBy(['kind'])`
on the same table, window and round trip; the grouping buys no arithmetic, it buys
the reader the ability to _see_ what it is adding up.

**A negative floor rendered as though someone had measured it.** The building
cannot hold −2,439 mattresses. `EodInventoryState` gains `negative`, checked
**before** freshness — a negative behind a _fresh_ anchor is the worst case, not an
acceptable one, and the precedence makes every existing `state === 'healthy'` guard
(notably the ADR-0058 estimated-floor block) stop deriving from a broken floor for
free. Either **pool** counts, not just the total: a −300 program pool inside a +900
total is a billing error a total-only check waves through. On the report and the
floor tile the figure is **replaced** by the banner, not shown beside it — a
negative printed anywhere gets pasted into a spreadsheet — and the tile's
days-remaining line is suppressed outright rather than CSS-hidden, because
`display:none` still ships the sentence to anything reading the page.

**Freshness that could not see intake stop.** `flowThrough` is the max over _every_
feed, so a site that keeps stripping while intake is frozen reads perfectly fresh —
the outflow rows hold the max up. That is exactly the 2026-07-22→31 outage: the
delivered feed froze for nine days, processing kept subtracting, every signal
stayed green and the floor went negative. Intake now has its own clock
(`inboundThrough` / `inboundDaysSince` / `inboundStale`), surfaced from the `_max`
the existing freshness aggregate **already fetched and threw away**. No new query,
no second freshness system. The threshold is _derived from_ the ADR-0089 mirror
guard's own 96 h so the two cannot drift apart.

### The one found while verifying, and the one that mattered tonight

**ADR-0072 was enforced on the iPad count path and the hold-release path — but not
on `POST /api/manager/[site]/snapshots`.** That is the Loads & Inventory desktop
form a manager actually uses. It went straight to `reconcilePhysicalCount` with no
tier check: same table, same anchor, same total authority over the floor, none of
the friction. A 32% swing was accepted with `201` and written. A gated capability
is only as gated as its **least guarded entry point**. The route now classifies
server-side and holds Tier 2 exactly as the floor path does, reusing `createHold`
so the entry is preserved and the release is recorded against whoever approves it.
Falsified against the real pre-fix handler on `origin/main`, not a hand-mutated
copy: `expected 201 to be 422`, and the anchor really was written.

**No schema change, no migration, and no live number moves** — the grouped
drop-off sum is asserted equal to the old bare sum for any all-taught window,
which is what let this ship on the day of a physical count.

Also in this commit: **`CHANGELOG.md` on `main` carried committed merge-conflict
markers** (`<<<<<<< HEAD` / `=======` / `>>>>>>> origin/main` at lines 12/73/135),
which landed with today's ADR-0107 and ADR-0108 entries. Both entries were intact
inside the block; only the three marker lines were removed.

## 2026-08-18 (2:45 PM PT) — ops: the on-hand Phase-0 diagnosis, and the skip-deploy squash trap's second firing

**Handoff #270 Phase 0 (read-only, reported to Bill before any fix).** Live-DB
diagnosis of the "chronically wrong on-hand": the report and the canonical
balance ALREADY agree exactly (`getEodInventorySnapshot` delegates to `onHand`;
442 / 397 / 839 at Woodland on both paths, arithmetic ties to the unit), no
negative in 14 days, 0 undated hauls of 7,372 Delivered, the 15 `Confirmed`
hauls are future appointments. **Eugene is not negative — it is EMPTY**: no
anchor ever, zero inbound/mirror/processed rows all-time; its 0 is meaningless
and tonight's EOD count establishes its first anchor (thereafter static until
Eugene feeds exist — the named follow-up). The one structural hazard confirmed:
`onHand` sums drop-off units with NO kind filter, so an untaught kind joins the
pool silently — the fail-loud fix, the report==onHand regression pin, and the
negative/stale display banners are in build (ADR-0110 expected), targeted to
land before tonight's count. The count path's ADR-0072 overwrite guardrail and
Pacific-day handling are under end-to-end verification for tonight.

**Incident: prod ran ~2.5 h without ADR-0108.** The #267 squash merge inherited
a `[skip-deploy]` trailer from a folded branch-commit message (the same
mechanism as the 8/15 #261 case — second firing); the deployer forced pull-only
and logged success. Caught on reconciliation at 2:35 PM PT; the #269 merge
(explicit clean `--body`) carried ADR-0107 + ADR-0108 to prod together.
Standing rule recorded in OPEN-ITEMS §0.BD: every squash merge passes an
explicit `--body`.

## 2026-08-18 (12:05 PM PT) — Start and End hours, and run hours stop being typed (ADR-0107)

The TEREX sheet does not record a duration. It records **two hour-meter
readings** and computes the duration from them. ADR-0079 captured the answer and
threw away the question — so nothing could check the subtraction, and two of the
sheet's nine columns still had nowhere to live in Vision.

**The meter-vs-clock question is RESOLVED, and it is meters.** Measured against
the live workbook: `Jul26` runs 2,462.75 → 2,608.05, `Aug26` continues
2,685 → 2,804.8, daily deltas ~6–12 h, and each day's Start is a **formula**
pointing at the row above (`=F<prev>`, `='Jul26'!F33` across the month
boundary). This repo's own extractor already said so — it types them "Hour-meter
readings" and separately flags `Nov24`/`Dec24` as the tabs carrying `Start
Time`/`End Time` **clock** times. Both shapes exist in the workbook's history;
the 2025–2026 tabs this product mirrors are meters.

### Added

- **`start_hours` / `end_hours`** — `Decimal(8,2)`, nullable, additive migration.
  Wider than `run_hours`'s `(5,2)` because a meter is cumulative: at ~2,805 h and
  ~1,400 h/yr, a `(6,2)` ceiling of 9,999.99 arrives inside the asset's service
  life.
- **Start PRE-FILLS from the previous recorded day's End** (`GET ?forDate=`),
  mirroring the sheet's own carry-forward formula. Editable, still required.
  Nearest earlier DAY — not highest reading, because a serviced machine can read
  lower than an older row — and a legacy day with NULL meters prefills nothing
  rather than seeding a fabricated `0`.
- **Four DB CHECKs**, proved by insertion against a clean PG16 **including the
  positive controls**: `meter_pair_complete`, `meter_end_after_start`,
  `meter_non_negative`, and `run_hours_is_the_difference` — the last being what
  stops the stored difference and the stored pair from ever disagreeing.

### Changed

- **`run_hours` is DERIVED (`end - start`), stored, and no longer accepted as an
  input anywhere.** The service throws on `'runHours' in args`, the route's zod
  schema is `.strict()` so a stale client gets a `422` rather than a silently
  ignored field, and the UI shows a calculated read-out instead of an input.
  Leaving the box on screen while the server derived the value would have
  reintroduced ADR-0079's own two-artifacts-of-one-fact defect at the UI.
- **`end > start` is refused** — the machine does not run overnight, so an End at
  or below the Start is a keying error, never a short day. Both readings are
  rounded to the stored scale BEFORE comparison, so a pair that is ordered at
  full precision but equal once stored (`2800.001 → 2800.002`) is caught rather
  than written as a zero-hour day.

### Not backfilled

Existing rows keep their `run_hours` with **NULL** meters. A difference does not
determine the pair it came from, and a fabricated `0 → 6.5` would be
indistinguishable from a real reading — and would then propagate through the
carry-forward. The UI draws `—`, not `0`.

### Deferred, with a reason

The ADR-0081 **workbook importer is not wired to these columns** (ADR-0107 D6).
`run_hours_is_the_difference` would refuse any sheet row whose own
`Day Total Hrs Used` disagrees with `End − Start`, and the extractor's own header
records that such rows exist. Measuring that disagreement is a data question, not
a code change to guess at.

## 2026-08-18 — the comparand that does not exist, and the outlier that does (ADR-0108)

Handoff #264 asked for expected-vs-actual variance flagging on the outbound
weights ADR-0104 absorbed. **The premise died on measurement, before any code was
written**, and that is recorded rather than worked around:
`mymrc_outbound_mirror` carries a weight for **0 of 4,685** loads and no
weight-like key anywhere in its payload; positive unit counts exist on **1 of the
831** joined loads, so there is no lbs-per-unit denominator either; and the
workbook's own total-vs-parts is already reconciled at **0 drift on 831 of 831**.
There is no expected-vs-actual pair, and inventing one would make the guess
authoritative by being first (ADR-0080 §D7).

**What shipped instead is what the data supports: per-commodity load-weight
outlier flagging**, seeded from the measured distribution of the pinned revision.

- **A second measurement changed the shape of that too.** A symmetric `±k×MAD`
  bound in pounds is structurally blind below the median — weight ≥ 0 caps the
  reachable low-side deviation at `median/MAD`, which for Wood is **4.01 MAD**,
  so no `k ≥ 4.01` can ever flag a low Wood weight however absurd. The real
  keying-error row `Wood 40 lb` (median 3,170) sits at 3.96, just inside. The
  deviation is therefore measured in **log space**, making the band a ratio and
  genuinely two-sided; `Wood 40 lb` lands 16.5 steps out.
- **Thresholds are an editable table**, not constants: `outbound_variance_config`
  (median, spread step, `k`, minimum-n, on/off) on the `processor_quota_config`
  precedent, retunable by an admin at `/admin/doc-ingest/outbound-variance`
  without a deploy. Defaults `k = 6`, `min_sample_n = 20` — k=6 puts **14 of 831
  loads (1.7%)** on the list against 41 at k=5 and 60 at k=4, and the floor turns
  flagging off for the six commodities too thin to estimate a spread from
  (Cotton n=3 spreads by ×2.29; three singletons whose zero-width band would flag
  every row that is not exactly the median).
- **AK-4c is untouched.** Flags are a _look-at-this_: the copy says a load
  "exceeds the current variance threshold (editable)" and never wrong, mismatch,
  error or dispute; there is **no alert channel and no email**; and a test scans
  the rendered copy and fails the build on the vocabulary of blame. What a
  difference _means_ is still Bill's decision with Rick and Janette.
- **Dollar-side matching is BLOCKED and was not built.** No join key survives:
  normalized invoice# ↔ mirror BOL overlaps **4** of 233 distinct expense keys
  against 4,628 mirror BOLs (bare-numeric collisions), invoice# ↔ Materials ID
  **0**, `commodity_raw` ↔ Materials ID **0** (it holds 12 commodity _names_),
  and the 6 `haul_ref` values are `H-` **inbound** hauls, not outbound `M-` loads.
  Four accidental matches would have looked exactly like a working feature.

Honesty rails, each falsified first: flags compute only inside the pinned winning
revision (`versionId` is a required argument, and deleting the version clause
makes the suite flag a 40 lb row the winning revision had already corrected to
3,300 — failure quoted in ADR-0108 §8); an uncovered load is **not covered**,
never "0 variance" and never flagged; a recorded `0` is "carried none", not a low
outlier.

**Item 5 of the same handoff verified green** — the §12 reconcile module and
coverage page match their contract clause for clause. One amendment: the
uncovered-count stat tile now reads _"expected — outside the workbook's range,
not missing data"_ rather than _"no watched document supplies these"_, which was
true and read like a fault. The number is ~3,850 (P-47) and a reader who takes it
for data loss goes hunting a bug that is not there.

Note the surface renders at `staged` scope today, because both ADR-0104 batches
are still staged awaiting Bill (OPEN-ITEMS §0.BB). Flagging follows whichever
scope the page renders and **never promotes staged to confirmed**.

Admin-only. Not a floor surface.

> > > > > > > origin/main

## 2026-08-18 (11:15 AM PT) — the manager can fix yesterday, inside this month (ADR-0106)

Yesterday's entry recorded the standing tension plainly: the team keeps editing
the TEREX workbook, and the fix Bill wants is them moving to Vision's equipment
entry. This closes the half of that Vision was responsible for.

ADR-0079 D4 refused **every** prior day with `409 requires_amendment` and named
the office as the route. The floor did not go to the office — it went back to the
sheet, which is the artifact "no more sheets" exists to retire. A refusal the
users can route around is not a control; it is a redirect to the system you were
retiring.

### Changed

- **Prior-day entry and edit are ACCEPTED for any date in the current Pacific
  calendar month.** A date in a prior month is still refused with the same
  `409 requires_amendment` — the `409` body now also carries `monthStart`, so the
  refusal states the rule and not only the verdict.
- **A backdated change REQUIRES a reason**, stored on the audit row as
  `prior_day: true` / `prior_day_reason`, beside the actor and timestamp
  `audit_log` already carries. Who, when, why. Refused `422` without one, and
  nothing is written — no row, and no audit row claiming one.
- **No approval gate**, on ADR-0079 D4's own evidence:
  `resolveAmendmentApprover` 403s any requester who is not a bonus payroll
  signer, so a four-eyes step would hand this feature's audience a refusal they
  could do nothing about (OPEN-ITEMS F-2, unchanged).
- **The same bound now applies to the VOID path.** `voidDailyThroughput` had no
  date bound at all — the UI hid the button, the API did not. Left alone, last
  month's figure would have been uncorrectable but **erasable**.

### Added

- `monthStartOfDayKey(day)` in `src/lib/time.ts`. `appCurrentMonthStart` takes an
  **instant**; feeding it a `@db.Date` day key returns the WRONG month, measured:
  key `2026-08-01` → `2026-07-01`, because UTC midnight re-reads as 17:00 the
  previous Pacific day. As a month floor that fails **open** on the 1st of every
  month. `appCurrentMonthStart` is now expressed in terms of the new helper so
  the two cannot drift.

### Not touched

`run_hours NOT NULL`, the `(equipment_id, throughput_date)` partial unique, and
every read path. The month bound is a write-path predicate. **No migration.**

## 2026-08-18 (11:15 AM PT) — a manager can correct an operator's count without ringing Bill (ADR-0105)

ADR-0084 gave the **floor** a same-day self-void and explicitly left the desk
with nothing: _"a count discovered wrong the next morning is a phone call, not a
tap."_ It has been a phone call ever since, and the right number gets written on
paper beside the sheet. This closes that.

A manager (or admin) at the count's own site can now correct a physical count
taken **today or yesterday, Pacific**. The corrected value becomes the live
anchor and the prior value is retained — nothing is ever deleted.

### Added

- **`correctPhysicalCount`** (`src/lib/inventory/correct-count.ts`) and
  **`POST/GET /api/manager/[site]/snapshots/[id]/correct`**. Gated on
  `requireManagerForSite` via `requireActivatedManager` — **operators are refused
  403** and keep exactly the ADR-0084 Am.1 self-void they already had.
- **Edit in place, with soft-void discipline.** The corrected value is written as
  a new `physical` snapshot carrying the **original's `snapshot_at`** (so the
  count stays on the day it was taken), and the row it corrects is soft-voided
  with ADR-0084's existing `voided_at`/`voided_by`. **No new column and no new
  reader obligation** — all thirteen ADR-0084 anchor readers honour this for free.
- **Storage-layer audit, enforced.** Both audit rows (`insert` on the new row,
  `update` on the corrected one — who / when / from / to / whose entry /
  `corrected_to`) are written in the same transaction and then **read back before
  it commits**. A missing audit row aborts the whole thing, so the failure mode is
  "the correction did not happen", never "the correction happened quietly".
- **No approval gate** — Bill's decision, recorded in ADR-0105 D4 so nobody later
  "restores" a gate that was never removed.

### Fixed before it shipped

- **The delta trap.** Re-deriving `reconciled_delta` via `reconcilePhysicalCount`
  would anchor `onHand` on **the row being corrected** (it ties on `snapshot_at`,
  wins the `created_at` tiebreak, and the soft-void is invisible to it because
  that read runs outside the transaction). It would have recorded the size of the
  typo — `−45` — where the drift against the running balance belongs: `−28`. The
  baseline is now preserved arithmetically. Falsified in the suite.
- **A false green, caught.** The first `npm run typecheck` in the fresh worktree
  reported success while printing `sh: 1: tsc: not found` — no `node_modules`,
  and the output was piped into `tail`, so the exit code was `tail`'s. Every gate
  was re-run with the exit code preserved.

### Verified

Typecheck clean, ESLint clean (`--max-warnings 0`), Prettier clean on every
authored file. **1,524 passed / 39 skipped** across `src/lib/{inventory,audit,cor,loads,dashboard,bonus}`,
`src/app/api/manager` and the ADR-record integrity suite — including the
payroll-critical bonus suite, untouched and green. `check-adr-citations`: 4,497
citations across 1,218 files resolve.

**Seven falsifications, each broken on purpose and observed red:** audit read-back
deleted; window narrowed to today; window widened to three days; delta re-derived;
`entered_by` dropped; hard delete instead of soft-void; role gate removed. The
hard-delete one was **rewritten** after it first went red for the wrong reason
(the fake Prisma had no `deleteMany`, so the double was refusing rather than the
assertion catching).

### Premise that died

**"Counts feed pay" is false**, and the repo says so in an executed test:
`src/lib/bonus/__tests__/saves-inventory.test.ts` asserts the payroll saves path
writes to nothing but `unit_status_movements`, with
`expect(touchedModels).not.toContain('siteInventorySnapshot')`. A physical count
feeds `onHand` → the floor, the EOD report, the COR and MRC billing — the
**revenue** path, not payroll. Still money-adjacent; the mechanism is not the one
the handoff named.

### The screen, shipped with it (ADR-0105 D9)

An API a manager cannot reach relocates the phone call rather than retiring it,
so `/dashboard/[site]/count-corrections` ships in the same change — linked from
`/dashboard/[site]/loads-inventory`, the page a manager is already on when the
balance looks wrong.

- **Same gate as the API**, and it runs BEFORE the counts are read — a page that
  fetched first and denied second would ship numbers to a browser not allowed to
  see them. The test asserts the read never happened, not that the markup looks
  right.
- **`correctable` is computed server-side** from the same predicate the service
  gates on, so the screen cannot offer a Correct button on a row the service
  refuses. Superseded and floor-withdrawn rows carry no affordance.
- **Refusals surface VERBATIM** — the 409 already names the counted day, today,
  the earliest correctable day and the route to use instead. Re-wording it in the
  client would create a second copy of the window rule that can drift from the
  enforced one.
- **The chain renders honestly**: the superseded value stays visible, struck
  through, labelled `superseded by <value>` with the corrector's name; the live
  row says `corrected from <value>`; an ADR-0084 floor void says `withdrawn on
the floor`. No verdict language — pinned by a test asserting "wrong", "error",
  "mistake", "invalid" and "incorrect" never render against a count.
- `listCorrectableCountsAtSite` → **`listWindowCountsAtSite`**, now returning live
  AND superseded rows with chain links. Deliberately not `NOT_VOIDED`-filtered and
  allowlisted in the reader guard on ADR-0084 D3's grounds: a history is not an
  anchor selector, and hiding the retained value would defeat the soft-void
  discipline in the UI instead of in the database.

**Four more falsifications, each observed red:** the Correct button stops
checking `correctable`; the page calls its auth guard but ignores the refusal;
the 409 is re-worded instead of surfaced; the history reader filters voided rows
out. The page-gate break was **rewritten** after its first form went red by
crashing (`Cannot read properties of undefined`) rather than on the claim.

### Known residual

**The daily report's "counted by" line names the manager for a corrected count**
(`resolveCounter` reads the insert audit row's actor; the operator is preserved as
`counted_by`). Deliberately not fixed — changing it changes a report that is sent.
Tracked in OPEN-ITEMS §0.BC.

## 2026-08-17 (7:30 PM PT) — ops: five staged TEREX revisions cleared; the guardrail and the floor's habits are now visibly at odds

The team is still logging maintenance in the TEREX workbook (five edits since
8/14). Every revision staged: the Aug26 sheet's cumulative counters ("Day Total
Hrs Used" 141→214.5, "Units per hour" 127→206) legitimately accrete past the
ADR-0069 15%/$50 guardrail threshold mid-month, so nothing had applied since
8/13. At Bill's written instruction ("apply the latest terex sheet … apply all
the current data"):

- Newest revision `626b11aa` (modified 8/17 6:09 PM PT) applied through
  `applyVersion` (mode `system`, actor `system:terex-apply-20260817`);
  absorption ran on the next sweep — **absorbed, 80 rows**, no error, no new
  anomalies. Version-pinned reads now serve the current sheet.
- Five superseded staged intermediates discarded (audited under Bill's id,
  original guardrail reasons preserved in the audit before-images) — each
  version is a complete copy, so the newest carries all current data.

**Standing tension, recorded in OPEN-ITEMS §0.BB:** while the team keeps using
the sheet, every future edit will re-stage and sit. The fix Bill wants is the
team moving to Vision's equipment entry; until that happens, staged TEREX
revisions need a periodic apply pass, or the mid-month accretion pattern needs a
guardrail carve-out (a decision, not a default).

## 2026-08-15 (7:22 PM PT) — every outbound load is recorded, and now 831 of them have a weight (ADR-0104)

`mymrc_outbound_mirror` holds **4,673 outbound loads** spanning 2023-01-02 to
2026-08-14. Every one carries a Materials ID; 4,669 carry a BOL and a shipment
date. **`weight_lbs` was NULL on 4,673 of 4,673.** The system knew every load
left, when, on what BOL and to whose account — and did not know what any of them
weighed.

Of 11 watched `doc_sources`, 3 were absorbing and **8 were sitting on an
unconfirmed classifier proposal**, two of which held the missing figures. This
closes that: every watched document now has an answer, and the outbound weight
column the operation was missing is in the database.

### Added

- **Two new absorbable classes**, each with its own extractor, typed tables and
  migration, landing in **reference** tables — never operational ones.
  - `outbound_weight_audit` → `doc_outbound_load_rows` +
    `doc_outbound_commodity_rows`. **831 loads, 1,699 commodity rows,
    5,619,037 lb**, joinable to the mirror on `external_materials_id`.
  - `facility_expense_log` → `doc_facility_expense_rows`. **332 rows,
    $974,928.36**, Woodland only.
- **Four archive-only classes** — `facility_journal`, `meeting_notes_log`,
  `admin_task_tracker`, `analysis_workbook` — registered in `DOC_KINDS` and
  deliberately absent from `ABSORBABLE_KINDS`, so the classifier stops
  re-proposing five documents nobody will absorb. Unconfirmed count 8 → 0.
- **A decide service, route and review page for each new staging class**
  (`/admin/doc-ingest/outbound`, `/admin/doc-ingest/expenses`). `doc_commodity_audit_rows`
  has held 252 rows that can never leave `staged` since ADR-0080 shipped without
  one (P-46); this does not ship that shape twice more.
- **`/admin/doc-ingest/outbound-coverage`** — read-only. Per month: loads MyMRC
  records, loads with a weight, loads without, and the summed weight, every
  figure labelled with the ONE pinned revision it came from. **No threshold, no
  tolerance, no verdict** — grading a disagreement is AK-4c, Bill's call with
  Rick and Janette (P-48).
- **A single-instance guard** (`single-instance.ts` + test): at most one enabled
  `doc_source` per single-instance absorbable class per site. This is what keeps
  Kelsey Ruhland's frozen `TEREX.xlsx` copy from being re-enabled by a future
  session that no longer remembers why it is off (P-52).

### Fixed — two live defects that would have corrupted this work

- **The classifier prompt disagreed with its own enum.** It told the model
  `kind must be exactly one of:` all nine kinds, then hand-wrote a bullet list
  describing six. The Outbound file's stored `proposed_reasoning` shows the model
  reasoning through the contradiction in production — _"commodity_audit_tracker
  is the closest listed kind, but since that kind is not in the allowed list…"_ —
  about a kind that **is** in the allowed list. It read the described list as the
  allow-list. The bullet list is now generated from
  `DOC_KIND_DESCRIPTIONS: Record<DocKind, string>`, so an undescribed kind fails
  the type-check.
- **The confirm dropdown could not select any absorbable class.**
  `SourcesClient.tsx` hardcoded a 5-entry list that was **three classes stale** —
  every absorbable class in the product was missing — and its draft pre-fill
  silently dropped any proposal not in it, so a correct `commodity_audit_tracker`
  proposal rendered as an empty dropdown. Both `KIND_OPTIONS` and a
  `Record<DocKind, string>` label map are now derived from the enum.

### The three double-count traps, all closed by measurement

1. **The workbook double-counts itself.** Four sheet pairs are exact copies plus
   one filtered subset sheet — **556 of 1,387 candidate rows** are the same load
   twice. Extraction is therefore **workbook-level**, not per-sheet: the
   duplication is cross-sheet, so a per-sheet extractor structurally cannot see
   it. A per-sheet read would have reported ~1.67× the real tonnage.
2. **The most authoritative-sounding column is sign-flipped.**
   `Total Outbound Materials Weight` is the **negation** of the real figure.
   Weights come from `Total Outbound Weight`, which reconciles to the sum of the
   13 commodity columns with **0 drift on 831 of 831 loads**; the check column is
   stored only so the sign relationship can be asserted (2 rows disagree and are
   surfaced, not smoothed over).
3. **There are two TEREX.xlsx files.** `5b298aeb` is a frozen copy on a departed
   account, structurally identical to the live one. Confirming its correct 0.81
   proposal was all it would have taken to absorb 173 maintenance events twice.
   It is classified honestly and `enabled=false`, disabled **before** the
   confirmation reached it.

### Verified against the live bytes and against prod

- **831 of 831** workbook Materials IDs resolve in `mymrc_outbound_mirror`, and
  **831 of 831 shipment dates match the mirror exactly** — which validates the
  Excel-serial and `M/D/YYYY` text conversions against a source that is not the
  workbook.
- Corrections recorded in the build plan's Amendment 1: the workbook holds
  **831** loads and not the ~1,085 the design half stated (its own month table
  already summed to 831), and — the substantive one — **the `Invoice Date` column
  does not hold dates.** It holds day-of-month numbers under month banner rows,
  and 0 of 332 absorbed rows carry a readable date. Composing one was rejected:
  40 rows sit above the first banner and one sheet has two blocks both labelled
  "July". The banner and the day are stored separately and verbatim.

### Unchanged, deliberately

`processed_units_daily` keeps its one writer (workbook-sync, ADR-0049). The six
operational vendor-leg tables — `outbound_materials`, `outbound_vendors`,
`recycling_rates`, `landfilled_units`, `outbound_material_payments`, `invoices` —
stay at **0 rows** (AK-4b / P-49): their prerequisite vendor and rate masters do
not exist and could only be satisfied by inventing rates from `Disposition`
strings. The two Stockton sheets are refused by name — Stockton is not a row in
`sites`, and a figure attributed to the wrong facility is worse than one nobody
has.

**The first honest readout will show that most loads still have no weight.** The
workbook covers Woodland, January to June 2026; ~3,840 of 4,673 loads remain
weightless and no watched document supplies them. That is worse-looking than the
silence it replaces, and it is the point (P-47).

### Executed and verified in production, 7:22 PM PT

Under Bill's written instruction, as a NAMED non-human run (`actor_label`
`system:adr-0104-execution`, `actor_user_id` NULL — ADR-0077's discipline; his
user id is recorded as the AUTHORIZER, not the actor, and the instruction is
quoted verbatim in the run's audit row).

- Kelsey's TEREX copy `5b298aeb` was **disabled FIRST**, then classified
  honestly as `terex_maintenance_log`. Order was load-bearing: between a confirm
  and a disable the source is absorbable, and a sweep landing in that window
  double-absorbs 173 maintenance events.
- All eight remaining sources confirmed. **`doc_sources`: 11 registered, 0
  unconfirmed** (was 8 unconfirmed).
- Sweep run `96afe54c` fired; the absorption pass landed **831 load rows, 1,699
  commodity rows, 332 expense rows** — matching the extractor's dry run against
  the archived bytes exactly.
- **Zero new anomalies.** 6 sheets contributed loads; the 5 duplicate sheets
  contributed 0, as designed. 2 sign disagreements stored and surfaced.
- Expenses: `WOODLAND 2025` 194 rows / $544,321.63 / $104,241.82 credited;
  `WOODLAND 2026` 138 rows / $430,606.74. **0 rows carry a real invoice date**;
  316 carry a day number. Both Stockton sheets refused.
- The coverage read, pinned to revision `7829de7b`: **4,670 Woodland loads on
  record, 831 with a weight, 3,839 without, 5,619,037 lb known.** The
  per-commodity split sums to the load total to the pound. `revisionBleedIds` 0,
  unmatched absorbed loads 0.
- All seven of the ADR's spot-check Materials IDs resolve with matching BOL and
  shipment date.

**Both batches are STAGED and await Bill's confirmation** on
`/admin/doc-ingest/outbound` and `/admin/doc-ingest/expenses`. Nothing counts
until he accepts them — that is the whole point of §D5, and an agent clicking it
would put his attestation on a reading nobody read.

## 2026-08-14 (9:23 PM PT) — the first quota digest went out pilot, Bill flipped it live the same evening

The Friday 20:00 PT send (week 8/10–8/14, 22 processors seen, **15 flagged** at
75 / 3-misses Mon–Fri) fired in **pilot**: the 08-12 enablement set the feature
config but missed the ADR-0047 rollout gate, so `notifyStaff` rerouted to the
admins with the `[PILOT — would have sent to: …]` banner — the gate working as
designed. Bill reviewed the pilot copy and ordered the ramp (~9:20 PM PT):

- Woodland `processor_quota_digest` surface flipped `pilot → live` through
  `flipRolloutSurface` (the admin route's own path; audited, criteria note on
  the row). Eugene stays `pilot` with its config disabled.
- Tonight's pilot claim row cleared (audited delete, before-image preserved) and
  the internal route re-fired: **mode `live`, delivered 3/3** — Morena, Bill,
  Janette — verified in the notify audit and the fresh `processor_quota_logs`
  row (`sent_at` 9:23 PM PT).
- Operating note now in OPEN-ITEMS §0.AZ: a notification feature has TWO gates —
  its own config row and the ADR-0047 rollout surface. Enablement checklists
  must flip (or consciously not flip) both.

## 2026-08-14 (12:15 AM PT) — the capture held a page the heal had already closed (ADR-0103)

**Incident: `[DR3-Vision] MyMRC sync error - woodland [outbound]`, 2026-08-13
11:01 PM PT.** The MyMRC `outbound` feed failed with
`page.waitForTimeout: Target page, context or browser has been closed`, one
second after the log said `mid-run re-auth recovered on attempt 1/3`. Same
fingerprint had fired once before, 2026-08-12 12:01 AM PT.

### Fixed

- **`captureListPage` no longer caches the Playwright page across
  `ensureAuthenticated`.** A mid-run session drop makes the shared `AdminSession`
  tear down its context and open a NEW page (ADR-0057 `rebuildAndLogin`), so the
  cached reference was dead and the settle call threw. The `AdminSession`
  docstring already required this ("callers must never cache the reference across
  an `ensureAuthenticated`"); this was the one caller that did.
- **A healed pass is now replayed, not patched.** Merely re-reading the page
  would have stopped the alert and shipped a _worse_ defect: the aura listeners
  were bound to the dead page and the heal re-navigates itself, so the capture
  would have come back EMPTY and silently under-synced billing data. The pass is
  discarded and re-run on the healed page, listeners and all.
- Budget `MAX_CAPTURE_PASSES = 2`. If the last pass is still healed, the capture
  is **discarded** rather than trusted — the heal only fires on a logged-OUT
  page, so that traffic is unauthenticated. `fetchListPage` then wedges loud and
  resumable on the missing envelope instead of replaying garbage.
- Freshness was green throughout (`hauls`/`processed`/`outbound` all newest
  2026-08-13, 0.8d behind). **This was not the known confirmed-but-undelivered
  freshness pattern, and nothing was silenced.**

### Fixed — two source files were binary to `grep`

Found while diagnosing: `grep` reported **zero matches for `export`** in
`src/lib/mymrc/list-page.ts`, a 571-line module exporting 23 symbols.

- `src/lib/mymrc/list-page.ts` and `src/lib/equipment/import.ts` each contained a
  **literal 0x00 byte** used as a composite-key separator. NUL is valid UTF-8, so
  both compiled and every test passed — but `grep`/`ripgrep` classify a file
  containing NUL as binary and **skip it silently**, reporting no hits rather than
  an error. Every codebase-wide audit over this repo has had a blind spot in both
  files.
- Both changed to the `\u0000` escape. **Byte-identical at runtime** — verified by
  normalising the escape back to a raw NUL and reproducing the previous file
  exactly, and (for `import.ts`, whose NUL feeds a sha256 idempotency key) by
  confirming the digest is unchanged.
- Repo-wide sweep of all 1,837 tracked files: no other source file affected.
- **New guard:** `src/lib/repo-hygiene.nul-bytes.test.ts` fails the suite on any
  tracked text file containing 0x00, so this cannot recur silently. Verified by
  staging a probe file with a NUL and watching the guard fail.

### Verification

- New `backfill-portal-client.capture-heal.test.ts` (4 tests). **Adversarially
  confirmed**: reverted to the pre-fix source and watched 3 of the 4 fail with the
  exact production string `page.waitForTimeout: Target page, context or browser
has been closed`.
- `vitest run src/lib/mymrc/ src/lib/equipment/` — 612 passed.
- `tsc --noEmit` + `tsc -p tsconfig.mymrc.json --noEmit` clean; `next lint
--max-warnings 0` clean.
- **Docs follow-up (~12:55 AM PT):** the direct-to-main push left `main` CI red
  for ~35 min — the full suite's ADR-index test caught 0103 missing its
  `docs/adr/README.md` row (the pre-push hook runs only typecheck + the bonus
  suite, so it could not have). Row added, `adr-record-integrity` 20/20;
  incident residuals (heal-branch live-proof watch, the pre-2026-08-14
  grep-audit caveat) recorded in OPEN-ITEMS §0.BA. The deployer gates on
  health, not CI, so prod was never blocked — but the red run is why this
  follow-up exists.

## 2026-08-13 (8:15 PM PT) — five hand-copied fallback topics, one weak secret each (noc-master ADR-0194 Am.3)

The `dr3-vision-*` rows in the fleet's obscured-fallback registry each carried a
**5-character suffix** (~26 bits). These name the public `ntfy.sh` topics this
app fails over to when `ntfy.barnardhq.com` is unreachable, and **public ntfy.sh
has no authentication — the topic name is the entire access control.** A
5-character suffix is enumerable: guess it and you can read every system alert
DR3-Vision fails over onto it, and POST a forged `[DR3-Vision]` page straight to
Bill's phone. All three regenerated with 32 hex (128 bits).

**The structural problem is that one of them is written out in five places.**
`dr3-vision-system`'s topic appears in `src/lib/ntfy.ts`, in
`src/lib/mymrc/ntfy.ts` (the MyMRC bundle compiles alias-less and cannot import
it), and in three standalone `scripts/*.mjs` daemons that run as their own
compose services outside the Next build graph. Nothing at runtime can notice
them diverging: the fallback only fires when the primary is already down, and
`ntfy.sh` answers **200 for a POST to any topic name**, so a stale copy
publishes into the void and logs success. The sibling repo swept in the same
pass (DroneOpsMap) had exactly that drift, live, for months.

- `src/lib/ntfy.ts`, `src/lib/mymrc/ntfy.ts`,
  `scripts/{bonus-eod-check,bonus-escalation-check,migrate-with-ntfy}.mjs` —
  11 literals across 7 files updated in one commit.
- `src/lib/ntfy.test.ts` — three new tests in an `ADR-0194 Am.3` block:
  every pinned topic carries its own `>=32`-hex suffix, is inside ntfy's 64-char
  limit (over-length 404s on **both** servers and delivers nothing), and all
  suffixes are distinct; a guard-the-guard case pinning the regex against the
  three retired values; and a **cross-file consistency check** that reads the
  four sibling copies off disk and fails if any drifts from `src/lib/ntfy.ts`.
  Proven non-vacuous — reverting the MyMRC copy to `bhq-fb-dr3v-system-k8m2n`
  fails it by name. 24 passed (was 21).

No behaviour change and no operator-visible surface. `tsc --noEmit` clean;
ESLint unchanged from `main` (the one `bonus-eod-check.mjs` unused-disable
warning is present at HEAD and is not from this change).

## 2026-08-12 (10:30 PM PT) — the reconciliation Kelsey took with her was in two unwatched files (handoff #259)

The Q-2 finding named two reachable-but-unwatched spreadsheets as the likely
home of the real MyMRC-vs-vendor-invoice inputs. This session turned "likely"
into **confirmed**, read-only, using the pipeline's own machinery.

- **Both files are now watched `doc_sources`** (registered by identity from
  `doc_ingest_reachable_items`, exactly what the admin register route does;
  audited under Bill's user id, `system:handoff-259-phase1-register`). Sweep run
  `28997020` ingested + parsed both; ADR-0067 Am.8 resolved **strong** header
  rows past the MyMRC banners (Jan sheet: row 10 under 7 title rows). The
  classifier filed **proposals only** — nothing confirmed, so ADR-0069
  absorption never ran and no money figure touched a typed table.
- **The answer** (full evidence in the finding doc's CONFIRMED section):
  Outbound = per-commodity **weights** per load (M-id grain, VC vendor codes,
  BOL IDs, dates; no dollars). Invoices = **Invoice # + Amt. + category/
  commodity** (no weights). **No shared machine key** (275 Invoice# × 816 BOL /
  831 M-id: zero overlap) — but Notes hand-record tickets that ARE BOL IDs,
  M-id lists, tonnage+rate, and 29 rows key to **H-haul numbers**. **Layer B is
  buildable** at (month × commodity × vendor) grain, per-load for the
  Notes-keyed subset. Building it remains Bill's decision (AK-4).
- **Reachable-but-unwatched went 8 → 6**, and the 6 are now a named triage
  table in OPEN-ITEMS §0.AZ (all Attachments-folder snapshots; none watched,
  none PII-sampled). Also recorded there: 4 of 5 watched sources live on
  Kelsey's departed-account OneDrive (retention risk), and the Outbound file's
  proposed class must NOT be confirmed as `commodity_audit_tracker`.
- **ADR-0071 Am.2 landed and is enabled** (#257 + #258, both CI-green, merged):
  digest anchor 20:00 PT, `latestDueMonFriWeek()` Mon–Fri window, default
  min_misses 3 (migration `20260846`, default-only — no live row rewritten by
  migration, no migration renamed). Live Woodland row flipped
  `enabled=true / min_misses=3 / send_dow=5 / 20:00` (audited); recipients were
  already Bill+Morena+Janette. The 8/03–8/07 week was **pre-claimed suppressed**
  (reason on the row) so the first digest is **Friday 2026-08-14 20:00 PT**
  covering Mon 8/10–Fri 8/14 — not a Thursday catch-up. Eugene stays disabled.
- **F-1 closed to the letter**: the COR headcount prose now renders a real
  number or **"not recorded"** — never `—`, never a fabricated 0 (matching the
  Terex band convention; data side was already payroll-derived per ADR-0076).
- **Verified rather than assumed:** the "#256 batch" premise was checked against
  main first — the renumber (0078/0087/0097/0098) and F-1 data fix were already
  on main; the digest code was NOT (it sat in open PR #257). What "verify the
  batch landed" actually required was landing it.

## 2026-08-12 (3:50 AM PT) — the build recompiled everything to ship anything (ADR-0101)

Deploy builds cost ~17 minutes and about **853 s** of that was `docker compose
build` — the same 853 s for a one-line comment as for a thousand-line feature.

- **The Docker layer cache was never the problem.** `RUN npm run build` sits
  below `COPY . .`, so every commit invalidates it and Next.js recompiles **93
  pages / 191 API routes / ~266k LOC** from cold: ~787 s of the 853 s. It started
  cold every time because nothing carried `.next/cache` between builds —
  `.dockerignore` excludes `.next` (correctly), and there was no BuildKit cache
  mount.

- **Two cache mounts, both namespaced.** `--mount=type=cache,id=dr3-npm` on
  `/root/.npm` for `npm ci`, and `--mount=type=cache,id=dr3-next-cache,
sharing=locked` on `/app/.next/cache` for `npm run build`. The explicit `id=`
  matters: CHAD-HQ is a ~15-tenant host, and an unnamed mount takes an id from
  its target path, so every other stack's `/root/.npm` would share one directory.

- **CHAD-HQ's nightly prune was eating the other 200–270 s.**
  `buildkit-prune-daily` (04:30 UTC, an ADR-0062 §2 artifact in `noc-master`) ran
  at `--keep-storage=4GB`; the 2026-08-12 04:31 run **deleted 12.63 GB and left
  5.166 GB**, evicting the `npm ci` layer so the first build of each day paid a
  reinstall tail. Retention raised to **40 GB** (the host has 4.4 TB free), and
  the flag moved off the deprecated `--keep-storage` onto `--reserved-space` —
  the script runs under `set -euo pipefail`, so the day that alias is removed the
  entire prune would die silently.

- **Type-checking stays inside the image build**, by explicit decision. CI
  type-checks the commit; `npm run build` type-checks the artifact that ships,
  and that is the gate the ADR-0033 payroll type-lie would have tripped.

- **The dead `deps` stage is gone.** Nothing ever copied from it and compose sets
  no build `target:`, so BuildKit never built it — zero time saved, one less
  thing that reads like it matters.

- **Verified rather than assumed:** cache mounts work on the host's built-in
  BuildKit frontend with **no** `# syntax=` directive (throwaway build on
  CHAD-HQ, exit 0) — so no `docker/dockerfile:1` network pull was added to every
  build; `docker build --check` reported _"no warnings found"_; baseline recorded
  at `docker builder du` **13.88 GB total, zero cache-mount records**.

- **This deploy was still a full cold build**, by design — the mounts are empty
  until a build fills them. The halved build is read off the NEXT deploy.

## 2026-08-12 (12:15 AM PT) — the floor should not be the discovery mechanism (ADR-0100)

Implements ADR-0094 §P0 and §P4 — the two items it sequenced FIRST, ahead of
every fix, because _"today, the discovery mechanism for this entire defect class
is Bill's phone."_

- **Every actionless floor state is now counted.** `<DeadEndBeacon>` mounts
  inside the branch it measures (so it cannot drift from it) and reports
  `{surface, state, objectId, locale}`; identity and site are resolved
  SERVER-SIDE from the session and never accepted from the client. Emits
  `evt=floor.dead_end` to Loki + `dr3_vision_floor_dead_end_renders_total`.

- **Every classified write refusal is counted too**, on its own counter and its
  own `evt` — an operator who ACTED and was told no is a different question from
  one stuck looking at a screen. `WriteRefusalNotice` now takes `siteCode` and
  `surface` as REQUIRED props: an optional telemetry prop is one the next screen
  forgets, and a surface missing from the metric reads identically to a surface
  where nobody is being refused.

- **A log line and a counter, not a table.** Loki + Prometheus already exist and
  are already watched (ADR-0022 §3/§4), so this is queryable tonight with no
  migration and no retention question. Label sets are CLOSED unions validated
  again at the API boundary — the object id rides the Loki line, never a
  Prometheus label, because a per-haul label is how a counter becomes a
  cardinality incident.

- **The instrument cannot break what it measures.** Each sink is wrapped
  separately (a registry error cannot cost the log line), the route answers 204
  with no body, and the browser beacon is `keepalive`, never retried, and never
  touches IndexedDB — the offline queue is for the operator's work.

- **Per ADR-0037 this does NOT page.** A dead-end render is not actionable within
  five minutes: it is a tile and a digest line. The one shape that could earn
  `high` — the same object dead-ended by the same user 3+ times in an hour — is
  registered as a promise, not built.

- **P4, the shipping window:** floor-facing changes deploy **before 12:00 PT** or
  wait for tomorrow. Written into a new `CONTRIBUTING.md`. Noon rather than
  ADR-0094's proposed 15:00 (Bill's call) — 15:00 would have permitted the 13:59
  ship inside the measured 8/10 cluster. A documented convention, not CI, and the
  file says so — including that this very slice was shipped in the evening, which
  the rule would have deferred.

## 2026-08-11 (11:55 PM PT) — Two ADRs claimed 0097 nineteen seconds apart (ADR-0098 §8)

**ADR number collision, resolved.** PR #244 ("A page that heals before the phone
buzzes") was opened at 05:31:51Z and PR #245 ("A citation is a promise…") at
**05:32:10Z** — both claiming **ADR-0097**, both merged, and `main` briefly carried
two ADR-0097 files.

- **Resolved per the repo's own rule**, stated in `docs/adr/README.md`: a number is
  claimed by the first **pushed** reference, and the **later claim renumbers**
  (precedent: ADR-0087 → 0088). PR #244 claimed first, so the citation/promise ADR
  renumbered to **ADR-0098**. That was also the lower-blast-radius choice — ADR-0097
  is cited by runtime code (`src/lib/doc-ingest/*`), ADR-0098 only by its own CI
  scripts.

- **The checker was green the whole time.** The index deliberately MERGES files that
  share a number — correct for amendments, blind to a collision. So a citation to
  ADR-0097 resolved to **two different decisions**, which is _worse_ than resolving
  to none: an unresolved citation announces itself, an ambiguous one looks correct.

- **`findDuplicateAdrNumbers` is now part of the hard gate.** Two or more PRIMARY
  files on one number fails CI; `NNNN-amendment-K-*.md` files legitimately share
  their parent's number and are excluded. Three tests, including one that proves the
  detector fires and one that proves it does **not** fire on the legitimate
  parent-plus-amendments case.

- **ADR-0097 also got the index row it never had** — the same completeness gap, found
  the same way.

Both numbers were verified free across all 56 remote branches and every open PR
before pushing; #244 did not exist at that moment. The rule is sound, but the window
it leaves open is the time between the check and the push. Now a gate closes it.

## 2026-08-12 (7:15 AM PT) — INCIDENT: the transport that could never find a file (ADR-0102)

A `status=not_found` page for DR3 Woodland at ~7:14 AM PT: _"672 consecutive
failed poll(s); last successful read NEVER."_ The alert advised checking for a
rename, a typo, a stray copy or a moved folder. **None of those was true.**
`AUGUST 2026 DAILY LOG WOODLAND.xlsm` was in its folder the whole time — 710,386
bytes, modified 7:45 PM PT the previous evening. Ledger: **1,098 polls since
2026-07-31, every one `not_found`, `last_success_at` NULL.** Two independent
defects, either one sufficient on its own.

- **Defect A (data): `drive_upn` held a SharePoint URL fragment, not a UPN.**
  `kelsey_ruhland@svdp.us` — underscore — answered
  `404 ResourceNotFound: "User not found"`. The real account is
  `kelsey.ruhland@svdp.us`. SharePoint renders a personal site as
  `/personal/kelsey_ruhland_svdp_us`, flattening `.` and `@` to `_`; someone read
  the UPN out of that URL. It looks exactly like an email address and is not one.

- **Defect B (code): `$select` omitted the facet the code branches on.** This is
  the fatal one — fixing the UPN alone changed nothing. `FILE_SELECT` stopped at
  `lastModifiedDateTime`, and `$select` returns ONLY what it names, so `raw.file`
  was always `undefined`, `toDriveFile()` read that as "folder, not a file", and
  **`listFolder` returned zero files for every folder in every drive.** Measured
  live on the same folder: shipped select → 3 items, 0 kept, `getFile` null; with
  `file,folder` → 3 items, 1 kept, found. The transport was structurally
  incapable of finding anything, which is precisely what "last successful read
  NEVER" means.

- **Why no test caught it.** `graph-transport.ts` carried the comment "UNTESTED by
  unit tests; the mock is the tested path", and `mock-transport.ts` hands back
  ready-made `DriveFile` objects — it has no concept of `$select`, so every field
  is always present. A double more permissive than the real dependency cannot
  fail on the bug it exists to catch. New `graph-transport.test.ts` drives the
  real transport against a fetch double that **honours `$select`**; all four
  behavioural assertions fail against the shipped select.

- **A silent zero is now a loud one.** `listFolder` throws
  `FilesContractDriftError` when a page returns items of which none carries a
  `file` or `folder` facet — we asked for both, so that state means the select
  was dropped, and its symptom is an empty folder indistinguishable from a
  correct answer. Per page, only when items exist, so an empty folder stays empty.

- **The rollover was only half automated (ADR-0049 D5).** D5 templated the file
  NAME on the assumption of one fixed folder per source. Woodland nests each
  month inside a per-year folder, so a static `folder_path` is right for one
  month and then silently wrong — a `not_found` every 1st, forever. New
  `resolveMonthlyFolderPath` expands the same tokens in the path, and the engine
  uses the **same `monthAnchor`** as the file name, so the Am.4 B1 grace window
  reads the prior month's file out of the prior month's folder for free.
  Token-free paths (including the empty drive-root default) are unchanged.
  Verified live: Aug present, Sep/Oct/Nov/Dec 2026 folders already exist, and
  `2027 Daily Logs` does not yet — the same benign no-op D5 already handles.

- **Left open, deliberately:** a 404 on the _drive_ still reads identically to a
  404 on the _folder_, so a bad `drive_upn` recommends hunting for a renamed
  file. And the admin API validates `driveUpn` as `z.string().min(3)`, which
  accepts a SharePoint URL fragment happily. Both are follow-ups; §2 of the ADR
  is the reproduction.

## 2026-08-11 (11 PM PT) — A citation is a promise that a reason is written down (ADR-0098)

Implements **ADR-0094 §5 P5**. Documentation, CI and test only — no runtime code,
no new dependency, nothing to deploy.

- **The phantom-citation class was four families, not one.** ADR-0094 found six
  source files and a test citing an `ADR-0065 Amendment 2` that did not exist.
  Running a resolver over the whole tree found **24 citations to amendments nobody
  ever wrote**: ADR-0065 Am.2 (7), **ADR-0068 Am.3/4/5 (14)**, ADR-0069 Am.3 (2),
  ADR-0019.5 Am.1 (2). In every case the work shipped and the record did not.

- **ADR-0065 Amendment 2 now exists**, twelve days after the code it governs. It
  records what shipped as `7e1cf342` on 2026-07-30 08:45 PT: six manager screens
  derived today as `new Date().toISOString().slice(0, 10)`, so from 5 PM Pacific
  every date input on those screens defaulted to **tomorrow** and an evening entry
  landed on a production day that had not happened. It also closes the residual
  ADR-0065 Amendment 1 left open — the same six surfaces, named and deferred.

- **New hard gate: `node scripts/check-adr-citations.mjs`.** Every `ADR-NNNN` and
  `Amendment N` reference in `src/`, `scripts/`, `e2e/`, `tests/` must resolve to a
  real file **and section**. over 4,000 citations across ~1,180 files against 102 ADRs (the exact count moves with every merge; the gate does not).
  Wired into `ci.yml` **before `npm ci`** — it is dependency-free, so it fails in
  seconds rather than after a five-minute build — and asserted again by
  `src/__tests__/adr-record-integrity.test.ts` so it fires at push time too.

- **The gate went hard on day one** by baselining the 18 pre-existing violations in
  `KNOWN_UNRESOLVED`. Writing those five amendments would mean inventing history for
  work this author did not do, so they are tracked instead. **The baseline
  ratchets:** an entry that no longer matches a real violation _fails_ the check, so
  it cannot quietly become a second `OPEN-ITEMS.md`.

- **New register: `docs/adr/PROMISES.md`**, seeded with **33 hand-audited rows** —
  the floor-ADR commitments ADR-0094 counted, its own P0–P6, the five phantom
  amendments, and ADR-0065 Am.1's residual as the worked closed example. A test
  asserts every baselined ADR has a row, because a tolerated violation with no
  handle is the exact failure being prevented.

- **Advisory check: `node scripts/extract-adr-promises.mjs --check`** annotates any
  ADR newer than the registry epoch that states a promise with no registry row. It
  **never fails a build** — same reasoning as the existing `migrate diff` step: a
  hard gate on pre-existing drift would red-on-arrival every PR and mask the real
  gate above.

- **Two deliberate deviations from P5 as written**, recorded in ADR-0098 §3: a
  registry row instead of a GitHub issue link (42 promises carried **zero** issue
  numbers — that is not 42 oversights, it is a team that does not work through
  issues, and a rule pointing at an unused system gets satisfied with a dead link),
  and warn instead of fail.

- **Precision over recall, measured.** 70 candidates across 40 ADRs; ~85% precision
  on the audited floor set. `gated on` was **removed** from the vocabulary after
  scoring **6 false positives out of 6** — in this repo it describes a rollout flag,
  not a commitment — and a test stops it being re-added. The recall gap is stated
  plainly: the tool is a net for obvious cases, the register is the source of truth.

- **A false positive nearly shipped.** The first indexer keyed one file per ADR
  number, so separate amendment files (`0069-amendment-2-*.md`) overwrote their
  parent and **46 false violations** were reported against ADR-0067 and ADR-0069. A
  gate that cries wolf gets switched off, so the merge of both amendment conventions
  is locked down by a named regression test.

- **ADR index completeness.** Rows added for **0019.3, 0019.4, 0019.5, 0091, 0092,
  0096, 0097** — seven of the most recent records, including two floor incidents,
  had no index row. A new test keeps `docs/adr/README.md` complete: an ADR that
  exists but is not indexed is the dangling-citation defect from the other end.

## 2026-08-11 (11 PM PT) — ADR-0071 Amendment 1: the quota monitor can now say it is alive

**Verdict first: the processor performance monitor was never broken and never fired. It has
been switched OFF in the database since it shipped on 2026-07-31, deliberately, pending a
decision on the quota number — and nothing in the system was capable of saying so.**

Ground truth taken live on CHAD-HQ (2026-08-11, ~10:40 PM PT):

- `processor_quota_config`: one row, Woodland, `enabled = f`, quota 75, min_misses 2.
- `processor_quota_logs`: **0 rows** — no week has ever been evaluated.
- `dr3-vision-processor-quota` container: **up and scheduling correctly**, next tick
  06:00 PT. The internal route answers **HTTP 200**; the cron token is present and valid.

So the cron fired every morning for twelve days and left behind exactly what a dead cron
leaves behind: nothing. The cause is one clause — the digest selected
`where: { enabled: true }`, matched zero rows, skipped the loop and returned `{"outcomes":[]}`.
ADR-0071 §4 anticipated precisely this failure shape and guarded the _suppressed week_; the
guard sat one step below the gate that was actually closed.

**Shipped**

- `processor_quota_runs` — a heartbeat written on **every live run**, including the run that
  evaluates nothing because every site is off, and the run that throws. Deliberately not keyed
  on `(site, week)`: that key belongs to `processor_quota_logs` and means "already sent", so a
  heartbeat sharing it would claim each week it skipped and permanently mute the first real digest.
- Disabled sites are now **evaluated read-only** and reported as `skipped: 'disabled'` with the
  count the digest _would_ have sent. Nothing is mailed and no week log is written.
- `loadProcessorQuotaHealth()` + a `processor-quota` subsystem on `/api/health/subsystems`,
  with three states rather than two: **green** (enabled and running), **amber** (running and
  deliberately emailing nobody), **red** (never ran, or stale beyond 36 h). Amber is the state
  that was invisible; red on an enabled site is the dangerous one, because managers read
  no-email as "everyone met quota".
- `/admin/processor-quota` shows a **"Monitor last checked …" heartbeat line** and, now that a
  second site exists, an explicit **site switcher**; the page's `findFirst()` became an ordered
  `findMany` (unordered `findFirst` across two rows silently changes which floor it describes).
- **Eugene seeded a config row (disabled).** It had none, so Eugene processors were not passing
  the quota — they were not being looked at. Recipients deliberately left empty: a guessed
  address does not fail loudly (ADR-0071's own finding), so Eugene's list is Bill's to fill in.

**What Bill missed, measured against real data.** Woodland, at the configured 75 / 2-misses,
per completed week: 06-29 3 of 9 · 07-06 6 of 17 · 07-13 5 of 19 · 07-20 11 of 18 ·
07-27 13 of 23 · 08-03 **18 of 21**. Eugene would have flagged 2 in the week of 08-03. Six
emails, naming most of the floor, and the last one names 86% of it. Woodland's median daily
output over that span is **64 units against a 75 quota**, so the threshold sits above typical
performance and the digest is a roster, not an exception list. Eugene's median is 83.
The threshold decision ADR-0071 reserved for Bill is still open and is still the blocker.

Tests: 21 new (7 liveness, 8 digest, 4 subsystem-route, 2 fixture-correctness), full suite
**5,362 passing**. Every new guard falsified before being kept — including the fixture itself,
which returned `[]` for a disabled config and so was _more permissive than Postgres_, making
the twelve-day silence not merely untested but untestable.

## 2026-08-11 (10:20 PM PT) — A signer cannot sign a period he is paid by (ADR-0019.3 §2)

ADR-0019.3 §2 recorded a separation-of-duties conflict as **accepted**: Patrick
Dills took the Eugene ops-signer slot while remaining a Eugene `BonusEmployee`
with **119 daily entries across 27 periods** (2025-01-07 → 2026-01-14, all
`historical_imported`). Any of those periods, once amended, walks
`historical_imported → amended → pending_signatures` and lands back in front of
its ops signer — who is also its subject. The DB CHECK prevents
`requester == approver`, not approver-has-an-interest. Bill approved building the
guard; §2 is now **resolved by guard** rather than accepted.

- **The rule is narrow on purpose.** A person may not sign a pay period
  containing bonus entries attributable to their own linked `bonus_employee`.
  No role, site, date or state test — "historical" is not a state, it is simply
  "this period holds their entries", so current and future periods fall out
  untouched with no carve-out. Patrick's employee row is `is_active = false`, so
  no current period can be conflicted for him.

- **Enforced server-side at the one choke point.** `recordSignature` is the only
  path that captures a signature — natural, manual override, and the 08:30 PT
  auto-override all funnel through it — so the guard sits there and returns
  `sod_excluded`, surfacing as **HTTP 403** from
  `POST /api/bonus/months/[id]/sign`. The UI hiding a control is not a guard; the
  endpoint is reachable directly by anyone holding a manager session, and the
  route tests assert the API refusal rather than a hidden button.

- **The exclusion is on the (person, period) pair, never on the slot** — the
  subtle part. Patrick holds Eugene's ops slot **and** sits in that site's
  `facility_override_actor_ids`. A slot-scoped guard would have blocked his
  natural ops signature and left him free to sign the same conflicted period
  through the facility slot.

- **It excludes without stranding.** No new authorization system: conflicted
  periods route to the **existing** ADR-0019.2 §3 override chain. Rick
  (facility) is unaffected, Eugene's `ops_override_actor_ids` resolves to Bill,
  any admin may override either slot, and the auto-override actor is a separate
  identity — so the exclusion cannot trade a conflict for a missed 09:00 PT
  deadline. A test pins that the alternate can actually sign, not merely that the
  conflicted signer cannot.

- **The chain-health pill understands it (ADR-0019.4).** A period routed to the
  override chain _because of_ an exclusion is **healthy** — green, with the
  exclusion carried as standing context and rendered on
  `/admin/bonus-chain-health` so nobody has to read an ADR to learn why an
  override actor signed. A monitor that reported a deliberate design as a break
  would sit permanently red, and a permanently red monitor is unread. The one
  case it does flag is an excluded signer whose slot has **no** override backstop:
  amber, `sod_excluded_no_backstop`, because there the risk is not hypothetical.

- **The join is a real FK**, `bonus_employees.user_id → users.id`, not a name or
  email match — verified against production, where Patrick's row carries
  `user_id = 57964c64…` and exactly **1 of 133** `bonus_employees` rows has a
  non-NULL `user_id`. That is the blast radius and the reason the check is one
  indexed read.

- **The new read is REQUIRED on `SignatureDb`**, the same discipline `saves`
  carries: a test double that omits it is a failure, not a silent bypass. Every
  pre-existing double was updated to answer honestly (no signer in those fixtures
  is a bonus subject) rather than to answer conveniently.

- **Not covered, deliberately:** the amendment **approval** path
  (`canApproveRequest`) is unchanged — Patrick may still approve an amendment
  touching his own entries, he simply cannot sign the period that results.
  Changing that would alter the ADR-0028 workflow contract.

## 2026-08-11 (10 PM PT) — H-135793 attribution recorded; canonical source-attribution notes doc created

Docs only. New `docs/INVENTORY-SOURCE-ATTRIBUTION.md` — the canonical running record for
individual inbound-load attribution questions, companion to the source-classification email
sent at the Loads & Inventory go-live (ADR-0037). Rules stay in ADR-0037 +
`src/lib/inventory/source-classification.ts`; specific reconciliations now live in the new doc.

First entry: the **150 units entered 2026-07-29 at DR3 Woodland** were **one load**, MyMRC haul
**H-135793** (150 units, all program, Delivered, docking 08:00 PDT). Transporter per system is
**Humboldt Sanitation**; it was reported to Bill by email as "Humble Moving." The system name is
authoritative unless Bill corrects it — both recorded, neither overwritten.

Three things the note pins down so they are not misread later:

- **The link is an inference, not a foreign key.** The iPad floor row carries
  `transporter_id`, `source_id` and `external_mymrc_haul_id` all NULL. The match rests on
  there being exactly one 150-unit load fleet-wide that day, exactly one 150-unit mirror haul
  in the window, same site, same 150/150 program split, submitted 34 min after docking.
- **`arrived_at 2026-07-29 07:00:00Z` is Pacific midnight of the business day**, the
  day-anchoring convention of ADR-0037 §B7.1 — not the truck's arrival time.
- **The mirror's `docking_appointment_date` 12:00 is a date-field noon placeholder.** The
  appointment is 08:00 PDT (`docking_appointment_at` 15:00Z). A report quoting "docking 12:00"
  is reading the placeholder.

Also noted: a separate 3-unit Humboldt Sanitation `b2b_haul` at Woodland the same day is **not**
part of H-135793.

## 2026-08-11 (10 PM PT) — Why the floor keeps calling: one defect class, not many bugs (ADR-0094)

Bill, after the second floor-blocking incident in two days: _"I need to understand
why these issues keep happening — they should not need to call for help daily for
this kind of issue."_ **ADR-0094 is the answer**, measured against production rather
than argued from the code. Documentation only — no behaviour changes in this commit.

- **The headline number: 43 of 89 scheduled slots — 48.3% — diverge from the happy
  path.** Arrived on a different calendar day (7), >4h late (10), >4h early (4),
  never produced a child load at all (29), crossed midnight (6 of 64 claims),
  changed operator (15), carried no expected count (14). The design treats
  divergence as exceptional; in the yard it is a coin flip. And the response to
  nearly every unmodeled divergence is the same — **a card with information on it
  and no way to act.** The three incidents of 8/10–8/11 are three branches of one
  defect class, so fixing one branch per incident is a losing race.

- **A correction to the premise.** The floor workflow did not "go live in June."
  `inbound_loads` records the first operator-claimed load on **2026-07-29** — before
  that, zero rows carry an `assigned_operator_id`. The claim/count/submit workflow
  has ten operating days on it, with floor write volume up **~60× in that window**
  and the peak day (08-10, 92 writes) producing three ADRs.

- **A 13-day backlog nobody could see.** Of 16 recorded takeovers, eight fired in a
  16-minute burst on the morning of 08-10 against claims aged **2.9 to 12.8 days** —
  a backlog reaching back to the first days of floor use, cleared by hand on the
  first morning ADR-0082's takeover control existed. There was no representation for
  "claimed and abandoned," so the condition accumulated silently from day one.

- **Five ranked root causes**, with the shares stated as overlapping contributions
  rather than a partition: the domain model encodes the schedule while the floor
  works the yard (~60%); parity between surfaces was convention, not test (~25%);
  ship velocity outran the verification loop (~40% of the _recurrence rate_ — four
  behaviour-changing PRs merged 13:59–19:54 PT on 08-10, and Pablo was stranded at
  07:50 the next morning by the 16:29 one); **forward promises live in prose, and
  prose does not execute** (~15%); and a maturation curve that predicts the incident
  rate **rises before it falls**.

- **Found while counting promises:** ~42 forward commitments across the 13 floor
  ADRs carry **zero issue numbers**, and six source files plus one test cite an
  **`ADR-0065 Amendment 2` that does not exist**. Same class as the health pill that
  two later ADRs cited as a live control while it sat unbuilt for four months.

- **P0–P6, ~11–13 engineering days**, ordered by leverage per hour and front-loaded
  so the first 1.5 days change what Bill knows and the first 4 change what CI
  catches. §6 states plainly what the plan does _not_ fix — it does not reduce the
  48% divergence rate, and the first week of telemetry will look **worse**, which is
  the instrument working rather than a regression.

**Landed late:** written earlier the same evening and held out of git while the
shared checkout carried another session's work. Committed unmodified except for a
landing note and a date correction — the header read `2026-08-12`, the UTC day, the
same bleed this file warns about at the top and that `0101306` corrected for
ADR-0093 hours earlier. **§5 P2 shipped as ADR-0096 before this ADR landed**, and
followed its prescription: no widening of the ADR-0074 D5 day bound.

## 2026-08-11 (10:00 PM PT) — Doc-ingestion noise tuning + the resolve that never ran (ADR-0097)

Bill, ~10:00 PM PT: _"I'm still getting notifications that document ingestion is
not working and failed to get files. All of that needs to be working completely
and without issue."_

Read from ntfy's seven-day server cache: **exactly one** doc-ingestion page has
arrived since the ADR-0095 deploy landed at 7:11 PM PT — the 7:42 PM
`subscription_renew_failed` re-page, which is precisely the alert ADR-0095 §5
flagged as gate-failing and left untuned pending Bill's call. No new failure, no
regression, no stale document. (The other eleven DR3 messages tonight are
`Container started` deploy noise from PRs #235–#241, not ingestion.)

- **`sweep_failed` now pages on the SECOND consecutive failure.** Measured over
  the 7 days to 08-12 05:31Z: **684 ok / 4 failed / 1 partial** across 689 runs — a
  0.58% failure rate. The four failures fell on 08-06, 08-09, 08-10 and 08-11,
  **none consecutive**, every one self-healed on the next 15-minute run. The old
  grading cost roughly one page every other day about a condition already over;
  under the new one **all four would have sent zero pages**, because each row was
  resolved by the following successful sweep before it could reach occurrence 2.
  Consecutiveness needed no new state — a successful sweep
  resolves the open row, so `occurrences = 2` already _means_ two failures with no
  success between. The ADR-0057 D9 guard is intact: a genuinely dead sweep still
  pages `high`, 15 minutes later. Checked **before** the 24h re-page window so the
  suppressed first failure leaves `last_paged_at` NULL and the second page is
  immediate.

- **`subscription_renew_failed` is demoted per-OCCURRENCE, not per-kind.** The
  structural OneDrive-for-Business refusal (a subscription may only target a drive
  root; Vision holds item-level shares) is a health tile forever — nothing is
  actionable, ever. But the same kind also fires when a real subscription fails to
  renew, which _is_ actionable, so silencing the kind would have blinded the push
  path. New one-directional `dashboardOnly` flag, set at the raise site from the
  `isScope` it already computed. It can only ever suppress a page, never create or
  escalate one.

- **Fixed the resolve ADR-0095 §3 only half-moved.** It lifted the
  `download_failed` resolve above the guardrail branch, but left it below the
  `unchanged` early return — the path nearly every sweep takes. So a healed
  download only cleared on the next _content change_. TEREX's row from tonight's
  4:58 PM Graph 503 was still open at 10 PM on a source verified byte-identical to
  live Graph, and would have paged daily forever. Now resolved on the unchanged
  path too, guarded on `r2_key` so it never fights the missing-archive raise.

- **TEREX staged backlog cleared, verified against the source.** Live Graph
  download is byte-identical (sha256 `0dea4156…`, 491,583 B) to the newest staged
  revision; all six R2 archives hash to their recorded `content_sha256`. `Jul26`
  column G rows 3–33 sum to **222.25**, matching the workbook's own `G34`;
  baseline was 164.20 — July was filled in, monotonic, 31 days entered. The
  `5698.4` outlier was a half-entered row (End Hours 2665.95 with Start Hours
  blank) caught mid-keystroke and self-corrected 15 minutes later. Newest revision
  applied; four superseded intermediates discarded; audit rows carry the
  verification basis.

- **Known, NOT fixed here: `parse_summary.numericTotals` is exactly 2×** — it
  counts each sheet's own totals row as data (`444.50 = 2 × 222.25`). It corrupts
  nothing (consumed only by the variance comparison and the display; money rows
  come from a separate extractor that stages for human confirmation) and changes
  no staging decision (the doubling is consistent on both sides, so +35.4% is
  exact either way). Not fixed tonight because correcting it makes every stored
  baseline 2× its successor — a −50% variance that would stage every watched
  document at once. **Whoever fixes it must re-baseline in the same change.**

- **`column_nulled` on TEREX resolved as a false positive of our own upgrade.**
  "Estimates for 2025" was never removed — it is at `Annual Cost!A1` right now.
  ADR-0067 Am.8 correctly moved header detection from row 1 (merged section
  titles) to row 2 (real headers), 3 pseudo-columns → 21 real ones, and the
  guardrail compared across the change. The 92 occurrences are 92 findings in
  **one** sweep collapsing onto one fingerprint, not 92 events — `first_seen_at`
  and `last_seen_at` are identical to the millisecond.

- **`discovery_gap` left open deliberately** — 8 readable-but-unwatched documents,
  listed by name in the ADR for Bill to choose from. Nothing auto-registered.

## 2026-08-11 (10:00 PM PT) — the scrape was retiring trucks that were still coming (ADR-0099)

The hourly MyMRC scrape cancelled an `expected_loads` row the **first** time a
pass did not list it. Measured against `audit_log` at 2026-08-11 22:04 PT:

|                                            |        |
| ------------------------------------------ | ------ |
| Auto-cancellations, all time               | **69** |
| …later UN-cancelled by a subsequent scrape | **67** |
| …never restored (genuine retirements)      | **2**  |
| …restored by the very NEXT hourly pass     | 30     |
| …that fired BEFORE the appointment         | 16     |

**97% of every auto-cancellation this system has ever performed was wrong.** The
sweep was not retiring dead hauls, it was flapping — and a cancelled slot did not
merely lose its button, it _disappeared_: the queue filtered on
`cancelled_at: null`, and the hauls screen hit a bare `continue` that dropped the
card into the same "View only" branch as "no slot" and "not today".

- **Cancel on a STREAK, not one absence.** `expected_loads` gains
  `missed_scrape_count` + `first_missed_at`; a row is retired only after **3
  consecutive** misses. N=3 is read off the measured distribution, which is
  cleanly bimodal — it removes 32 of 69 cancellations (every one that resolved
  inside a day) and cannot touch the >24h population, where cancelling is
  correct. The streak resets on both write paths a present haul can take.

- **A pass that saw nothing retires nothing.** `feedExpectedLoads` reads the
  mirror, so an empty array can reach the sweep without the zero-anomaly gate
  firing. Now fenced explicitly, with a warning — silence would be
  indistinguishable from "nothing was stale".

- **The window is the PACIFIC day.** It bounded on `startOfUtcDay`, so between
  17:00 PT and midnight the sweep's "today" was the operator's tomorrow — the
  ADR-0065 class, still live in the write path.

- **A withdrawn slot is now legible on BOTH surfaces** — its own amber card on
  the hauls screen ("MyMRC withdrew this haul at 11:00 AM" + what to do), and a
  separate "Taken off today's list by MyMRC" block on the queue instead of being
  filtered away. **No control**, deliberately: `startInboundLoad` answers 409
  `expected_load_cancelled`, so a button would be an affordance whose only
  outcome is a refusal. It self-heals — the office re-adding the haul in MyMRC
  restores the row within the hour, which is the mechanism that produced the 67
  measured restorations. An operator-facing restore button is a **billing**
  decision and is put to Bill in OPEN-ITEMS rather than defaulted.

Closes floor dead-end audit **D-2** and the `cancelled` third of **D-1**.

## 2026-08-11 (5:18 PM PT) — INCIDENT: a truck that arrived a day late had no way in (ADR-0096)

Bill, 5:18 PM PT: _"Trying to access speedy delivery H-136980. But it won't let
us. We are clicking it and it does nothing."_

**H-136980** (Speedy Delivery LLC – Union City, Woodland) was booked for **8/10
9:00 AM PT**, nobody checked it in, and the truck arrived on the 11th. Live,
uncancelled, and with **no child load row** — so it reached neither the consumed
branch nor the check-in branch and fell to the bare "View only" card. The tap did
nothing because nothing was attempted. **Not a regression from ADR-0091**, which
only touched slots that already have a child row; this is the pre-existing
ADR-0074 D5 day-bound branch.

- **Unblocked 5:25 PM PT** by shifting `expected_arrival_at` +1 day into the
  current window (a scheduling field only — arrival and units come from
  `inbound_loads.arrived_at` at check-in). Janette checked in at **5:37 PM PT**
  and the load reached `submitted`.

- **The durable fix does NOT widen the day bound.** ADR-0094 §P2 is explicit that
  the bound is what stops a child load being minted onto the wrong slot (the
  159-unit mis-booking of ADR-0074 Am.1). `startableExpectedLoadId` keeps its
  exact meaning; the divergent case gets its own named state,
  `reconcilableExpectedLoadId`, with its own deliberately slower two-tap control
  whose second tap reads back the haul number **and** the day it was booked for.

- **The day guard now exists server-side, which it never did.** `startInboundLoad`
  performed no day check at all — the whole D5 bound lived in the two read layers,
  an open decision since ADR-0074 Am.1 and still open per ADR-0094. A bookmarked
  page or replayed POST could mint a child onto any slot at the site, of any age.
  Now enforced in the transaction that writes, **in Pacific** (a UTC comparison
  would refuse today's own slots for the last 7 hours of every Pacific day).

- **The exception is an acknowledgement, not a flag.** The caller must state which
  day it believes the slot is scheduled for; the server refuses unless it matches
  the row. A stale client cannot produce the value, so it is evidence rather than
  a permission the UI granted itself. Reconciled starts stamp
  `reconciled_from_day` / `reconciled_on_day` on the audit row.

- **Audit finding D-8 closed in the same change.** The online `date_not_today`
  refusal was a true silent no-op on all four floor write clients while the
  translated sentence sat wired only into the offline replay path. All four now
  classify it — and 401 — through one shared `classifyWriteRefusal` chokepoint,
  reusing existing strings (`floor.conflicts.why_wrong_day`,
  `auth_login.error_session_expired`). `dropoff-client.tsx` never parsed the
  response body at all; it does now. `QueueRow`, which swallowed every error, now
  names the one refusal a correctly-rendered page can hit — and re-throws
  `NEXT_REDIRECT` so a success is never reported as a failure.

## 2026-08-11 (7:11 PM PT) — header contract v3: the same word must not sanitize differently by normal form (ADR-0200 Am.3)

Re-vendored the canonical fleet conformance vectors from **v2 (20 vectors) to
v3 (24)** and upgraded both sanitizer twins to match. Two defects were in the
**contract itself**, not in this repo's reading of it.

- **The old `nbsp` vector could never fail.** Its input contained no U+00A0 at
  all — input and expected were byte-identical pure ASCII, so it passed against
  any implementation, including a broken one. v3 puts real U+00A0 in it and adds
  a `thin-spaces` vector covering U+2009 / U+202F / U+2007. Both already passed
  here, which is the point: a vacuous vector proves nothing either way.

- **Combining marks are now DROPPED, not degraded.** NFD-decomposed `café`
  (`e` + U+0301) left the mark as a standalone codepoint with no ASCII base, so
  it degraded to `?` and produced `cafe?` — while NFC `café` (U+00E9) folded
  cleanly to `cafe`. The same word, two different titles, decided purely by a
  normal form no caller controls. v3 strips U+0300–U+036F after the CR/LF pass
  so both forms land on `cafe`.

- **`ß`, `°`, `æ`, `ø`, `µ`, `½` and friends are transliterated.** These have no
  NFKD decomposition, so the fold could not help them and they degraded to `?` —
  `Straße` became `Stra?e`, `25°C` became `25?C`. The 2026-08-11 6:12 PM entry
  below flagged exactly this "upstream as a fleet-wide improvement rather than a
  local divergence"; this is that fix coming back. They now render `ss`, `deg`,
  `ae`, `o`, `u`, `1/2`.

- **Measured, not assumed.** Both twins were run against the v3 vectors _before_
  the change: **21 of 24**, failing exactly `nfd-accent` (`cafe? renewal`),
  `eszett` (`stra?e 5`) and `degree` (`25?C outside`). After: **24 of 24**, and
  the 85-assertion sweep is green.

- **The hollow-file floor now pins the real size.** The guard was
  `>= 15` against a 20-vector file; it is now `>= 24`. A floor set well below the
  vendored count silently tolerates a re-vendor that _loses_ vectors — the same
  lie the vacuous `nbsp` vector told, in slower motion.

- **Vendored byte-for-byte**, sha256
  `6e9da3beabc242fecebab49813c8cf410e1bfa6dc8231715b783d02e7b930dff`, identical
  to `noc-master/data/ntfy-header-conformance.json`. Copied, never retyped: the
  file carries invisible U+00A0/U+2009/U+202F/U+2007 and NFD combining marks that
  retyping destroys — which is how the hollow `nbsp` vector was born.

- **No behaviour change for `Authorization` or the BODY**, which are still never
  sanitized, and no change to where sanitization happens (each publisher's single
  choke point).

## 2026-08-11 (6:12 PM PT) — the header contract is ASCII, because the strictest client sets it (ADR-0093)

ADR-0019.5 stopped the drops. It also set the output contract one client too
loose, and this closes that.

- **What changed, in one line.** `toHeaderSafe()` now emits **pure ASCII** and
  **folds accents** — `café renewal for José` becomes `cafe renewal for Jose`.
  Under v1 it emitted latin-1 and left `café` untouched.

- **Why, since undici was demonstrably happy with `café`.** Because undici is not
  the strictest client on the fleet. `httpx` — which Helix-Hub and other fleet
  publishers post with — raises above **U+007F**, not U+00FF:
  `UnicodeEncodeError: 'ascii' codec can't encode character '\xe9'`. Same
  before-the-socket, kills-both-legs failure the em dash caused here, triggered by
  a character v1 deliberately preserved. A title provably safe in DR3-Vision was a
  dropped page one repo over. Sanitizing to the loosest client's limit is
  ADR-0019.5's own per-publisher failure mode, re-expressed as a per-repo one.

- **Measured, not assumed.** v1 run against the canonical fleet vectors
  (`noc-master/data/ntfy-header-conformance.json`) failed **3 of 20** — exactly
  the accent cases: `accent-fold` (`café renewal for José`), `accent-fold-high`
  (`naïve ÿ`), `mixed`. The other 17 already conformed; the gap was the latin-1
  allowance, not the transliteration table. Two gaps sit outside the vectors and
  were also closed: no `·` (U+00B7) mapping, and a dash class covering only `—–−`
  instead of the full U+2010–U+2015 range.

- **BEHAVIOUR CHANGE operators will see.** Accented names in alert **titles** now
  read `cafe` / `Jose` rather than `café` / `José`. That is a deliberate,
  visible readability cost, paid so one title is deliverable by every fleet
  publisher. Folding is what makes ASCII tolerable — `caf?` would be a
  readability regression rather than a fix. `ß` and `°` now degrade to `?`,
  where v1 passed them through; flagged upstream as a fleet-wide improvement
  rather than a local divergence. **Bodies are unaffected** and keep their full
  Unicode, as before.

- **`Authorization` and the BODY are still never sanitized**, and sanitization
  still happens at each publisher's single choke point — never per-field at call
  sites, which is the shape that failed three times.

- **Pinned to the fleet, in CI.** The canonical vectors are now **vendored** at
  `src/__tests__/ntfy-header-conformance.json` and asserted on every run:
  conformance to all 20, output is pure ASCII, a real undici `Request` accepts the
  sanitized value, the raw em-dash title genuinely still throws (the bug is
  proven, not taken on the ADR's word), accents fold rather than degrade, CR/LF
  is stripped, the function is idempotent, and a **floor of >= 15 vectors** so a
  truncated file cannot make the suite vacuously pass. The `.ts` and `.mjs` twins
  are pinned equal against the vector set rather than an ad-hoc case list.
  Vendored rather than fetched on purpose: a failed fetch degrades to a SKIPPED
  test, which is a safety net that lies.

- **Audited for bypasses.** All five publishers — `src/lib/ntfy.ts`,
  `src/lib/mymrc/ntfy.ts`, `scripts/bonus-eod-check.mjs`,
  `scripts/bonus-escalation-check.mjs`, `scripts/migrate-with-ntfy.mjs` — route
  headers through the shared sanitizer. No bypass path found.

- **Known limitation, raised upstream not patched locally.** Decomposed (NFD)
  input — `e` + U+0301 rather than precomposed `é` — yields `cafe?`. Both fleet
  reference implementations share this, so DR3 matches them rather than
  silently diverging on a case the shared vectors cannot detect. Belongs in
  ADR-0200 so every publisher moves together.

## 2026-08-11 (6:10 PM PT) — the ledger recorded the attempt, not the page (ADR-0095)

Bill, at 5:51 PM: _"I got a bunch of vision ntfy's about not being able to download
or ingest files. why?"_ **Nothing started failing. The channel started working.**

- **These alerts are newly VISIBLE, not newly OCCURRING.** `anomalies.ts` builds
  every doc-ingest title as `Document ingestion — ${kind}` — a literal U+2014. Per
  ADR-0019.5 that threw inside undici before a socket opened, on both legs, so
  **every document-ingestion page ever raised was discarded**. ADR-0019.5 shipped at
  2:25 PM, the container came up at 3:42 PM, and the first such page Bill has ever
  received landed at 4:13 PM. The delivered title hexdumps as `2d` — an ASCII hyphen,
  i.e. `toHeaderSafe()` folding the dash. The alerts did not change; the sanitizer
  that lets them out of the process did.

- **The defect fixed here.** `maybePage()` stamped `last_paged_at` _before_
  publishing and discarded the result, so the ledger recorded an intention rather
  than a delivery. Production carries `sweep_failed` rows stamped as paged on 07-31,
  08-01, 08-06, 08-09 and 08-10 with no matching message anywhere in ntfy's 7-day
  cache. Worse, that stamp arms the 24h re-page window — **a page that never
  existed suppressed its own retry for a day.** Now: publish first, stamp only on
  `result.ok`, and leave a `dropped` page unstamped so the next sweep retries it in
  fifteen minutes. (`cooldown-suppressed` and `unconfigured` are `ok` — deliberate
  local suppressions that must not spin.)

- **Second defect, same incident.** `download_failed` was resolved only on the
  _applied_ path, below the guardrail branch, so a source that recovered but whose
  revision **staged** never cleared its anomaly. TEREX.xlsx hit exactly that: Graph
  503 at 4:58 PM, clean download at 5:13 PM, revision staged on an aggregate
  variance, `download_failed` left open on a source downloading perfectly — and it
  would have paged daily forever. Whether a revision applies is a guardrail decision
  about content; whether it downloaded is not. The resolve moves above the branch.

- **What was actually wrong with ingestion: nothing that still is.** Two transient
  Graph 503s, each healed by the next 15-minute sweep. Sweep failure rate is ~1 in
  ~96 runs/day and has been since at least 07-28. The `discovery gap` is by design
  (registration is manual) and the `aggregate variance` is the guardrail working —
  TEREX "Day Total Hrs Used" 328.40 → 444.50 (+35.4%), **staged, not applied**,
  awaiting a human. MyMRC sync is unrelated and clean.

- **Deliberately not changed** (policy calls for Bill, see ADR-0095 §5): grading
  `sweep_failed` to page on the second _consecutive_ failure rather than the first,
  and demoting `subscription_renew_failed` — a limit the code itself documents as
  structural and unfixable — to a dashboard tile.

- Tests: 3 new in `anomalies.test.ts`, 1 in `ingest-d8.test.ts`, each verified to
  fail against the unpatched code. Full doc-ingest suite 436 passed / 28 files.

## 2026-08-11 (2:25 PM PT) — the em dash that ate the payroll alert (ADR-0019.5)

Bill asked why the 2026-08-05 page got dropped. It was an em dash.

- **Root cause.** HTTP header values are ByteStrings (latin-1). Node's undici
  throws `Cannot convert argument to a ByteString because the character at index
43 has a value of 8212` for any codepoint above 255. 8212 is U+2014, and the
  stranded page's title was `URGENT: bonus period STRANDED — DR3 Eugene Period 16`.
  `buildHeaders()` put it into `X-Title` unencoded.

- **Why it looked like a total outage.** The throw happens at `Request`
  construction — **before any socket opens**. No DNS, no TLS, no auth, no rate
  limit. The fallback builds the same header, so it threw identically. "Primary
  and fallback both failed" was one deterministic failure counted twice, which is
  why the ntfy server looked perfectly healthy: VLM, CallSign and InfraWatch all
  delivered inside the same three minutes.

- **Why nobody noticed for weeks.** `postWithTimeout` ended in
  `catch { return false; }`. The `TypeError` was discarded, so the caller could
  only say "dropped". A swallowed error is not a smaller failure; it is the same
  failure with the evidence removed.

- **It was never one alert.** A repo sweep found TWO publishers broken and three
  more one character away: `src/lib/ntfy.ts` (~18 call sites, essentially every
  app alert), `src/lib/mymrc/ntfy.ts` (hardcoded `${kind} — ${site}` — **every
  MyMRC page has been dropping**), and the three `.mjs` daemons, including the one
  that publishes the app-INDEPENDENT backstop pages. The retained 7-day ntfy
  cache corroborates it: only ASCII-titled DR3 messages are present.

- **This is the fleet's FOURTH re-discovery.** bash/Python fixed 2026-05-06;
  noc-master's Node publisher by ADR-0063 on 2026-05-22, after an em dash in
  `— cordoning` swallowed a real host-saturation alert. ADR-0063 closed asking
  whether the fix should become a shared utility "to prevent a fourth
  re-discovery". It was not lifted. Here is the fourth. The bug is not the em
  dash — it is that every publisher owns its own header construction and nothing
  structurally connects them.

- **Fixed.** One dependency-free `toHeaderSafe()` (`src/lib/ntfy-header-safe.ts`
  plus a plain-JS twin for the daemons, pinned equal by test), applied at each
  publisher's single choke point — never per-field, which is the shape that
  failed three times. Transliterates the punctuation these titles use, then
  hard-replaces any residual codepoint > 255 with `?`: an unmapped glyph must
  degrade to a sendable page, never a lost one. `Authorization` is excluded so an
  encoding fix cannot become an auth bug. Bodies keep their Unicode.

- **A drop now says why.** The failure class and message are captured and logged
  with the topic and fallback topic. Had that line existed on 2026-08-05 this
  would have been a ten-minute diagnosis.

- **The counters stop lying** (closes ADR-0019.4 residual #2). `ntfyPublished`
  counted attempts — on 2026-08-04 t3 logged `ntfyPublished:1` for a page thrown
  away inside the process. Every escalation publish now routes through
  `recordPublish()`: delivered outcomes only, a new `ntfyDropped` beside it, and
  the reason in the log.

- **No fifth re-discovery.** A sweep test walks `src/` and `scripts/`, finds every
  file setting `X-Title`, and fails if any bypasses the shared sanitizer — with a
  floor assertion so an empty sweep cannot pass while checking nothing.

- **Expect new MyMRC alerts.** They are not new failures; they were always
  happening and the pages were being discarded.

## 2026-08-11 (1:00 PM PT) — the auto-override safety net is now visible before it is needed (ADR-0019.4)

Bill asked whether the "auto sign as me if nobody does" path actually works — he
felt Eugene was late last period. It was: Period 16's ops slot was signed **25
hours** after its deadline. Here is what the logs say, and what now exists.

- **The escalation ladder was never the problem.** Loki, 2026-08-04, the payroll
  morning: t1 07:10 fired, t2 07:30 fired, t3 08:30 fired
  `{"autoSigned":0,"actorUnavailable":1}`, t4 09:00 fired `{"deadlineMissed":1}`.
  Every tier ran on time. The auto-sign refused because the chain's override actor
  was the deactivated `operations@svdp.us` alias — correctly refusing, since
  signing payroll as a dead identity is worse than missing a deadline.

- **The auto-sign WRITE path is proven working.** Period 14 carries a real
  `ops_auto_override_at` with the ADR-0019.1 system-override reason, and the
  T-213 end-to-end test drives the real orchestration: signs both slots, moves the
  period to `signed`, stamps the override timestamps, audits as
  `system:bonus-escalation`, triggers the PDF. It was the actor that was dead, not
  the mechanism.

- **Then the last alarm was lost.** The next morning t4 correctly re-detected the
  stranded period and tried to page. The app logged
  `[escalation] stranded ntfy dropped (primary+fallback failed)`. The ntfy server
  was healthy — VLM, CallSign and InfraWatch all delivered in the same three
  minutes. That page simply vanished, so nobody was told.

- **Which is the actual lesson.** Every safeguard on this path was an _event_
  delivered through one channel, and the channel can swallow it. So the fix is not
  another alert: a `signature-chain` subsystem now reads as STANDING STATE on the
  health pill and at `/admin/bonus-chain-health`, true whether or not any page was
  received. Green names who would sign ("Override actor available (Bill Barnard)")
  rather than just asserting things are fine.

- **It validates what the database cannot.** The override-actor lists are
  comma-separated UUID strings, so nothing constrains them; the signer columns are
  real FKs, which prove existence and say nothing about `is_active`. Neither
  constraint would have caught either incident. Red = a reference that cannot sign;
  amber = the chain works but has lost four-eyes or a backstop; empty = red, never
  green.

- **Deliberately stricter than the guard it watches.** `escalation.ts` checks only
  `is_active`, so a soft-deleted-but-active account would pass it and sign payroll.
  This check applies the repo's canonical `{is_active, deleted_at: null}`. A test
  pins the divergence, because a monitor exactly as strict as its subject cannot
  warn you about its subject.

- **Runs at 06:30 PT daily** — forty minutes before t1, two hours before the
  auto-override, so a broken chain is still fixable by hand before 09:00. Daily
  rather than payroll-mornings-only because the 2026-08-04 break was introduced by
  a `db:seed` days earlier and nothing looked until the moment it mattered.

- **Pages `high` on transition, not `urgent` per poll.** A broken chain is real but
  slow-moving — it only bites at 08:30 on a payroll Tuesday, so it does not warrant
  a 3am wake-up (ADR-0037). Prior state lives in a Postgres ledger, not the
  in-process ntfy cooldown map, so a deploy cannot cause a re-page. And a dropped
  page is recorded as `paged=false` — after 2026-08-05, a ledger that claimed
  someone was told when nobody was would launder exactly the failure being fixed.

- **Verdict for Aug 18:** the auto-sign will fire if nobody signs. The actor is now
  the active `bill.barnard@svdp.us`, the seed can no longer revert it (ADR-0019.3),
  the ladder is demonstrably firing on schedule, and a new test asserts that a green
  chain and a working auto-override are the same condition.

- **Left open, honestly:** why that 2026-08-05 publish failed on both primary and
  fallback is unexplained and deserves its own look. And `tierAutoOverride` still
  counts `ntfyPublished` without checking the outcome, so a dropped "actor
  unavailable" page reads as sent — the new sweep checks its own, the escalation
  path was left alone to keep this reviewable.

## 2026-08-11 (12:50 PM PT) — Stale-claim watchdog ramped PILOT → LIVE at both sites (ADR-0092)

Bill received the pilot-mode nudge — `[PILOT — would have sent to:
morena.gomez@svdp.us, janette.tomas@svdp.us] DR3-Vision — DR3 Woodland: 1 load
still open on the dock` — and replied _"flip these to live now! we need these."_
That is the ADR-0047 ramp doing its job: the pilot send showed him the content
AND the targeting before either reached a site manager.

- **Flipped 12:50:50 PM PT, both sites**, through the `flipRolloutSurface` field
  set (`rollout_state`, `flipped_by`, `flipped_at`, `criteria_note`) plus the
  audit row, under actor label `system:stale-claim-flip` rather than a borrowed
  `users.id` — the only admin in the database is Bill, and attributing the
  keystrokes to him would put a false statement in an append-only table. He
  directed it; he did not perform it. One-off:
  `scripts/one-off/2026-08-11-stale-claim-flip-live.mjs`.

- **Recipients verified against live data first.** Resolution is
  `alert_recipients WHERE site_id = <site> AND active = true` — site-scoped, NOT
  assignment-scoped, so it reaches the site's managers and never the operator who
  walked away. Woodland = morena.gomez@svdp.us + janette.tomas@svdp.us (exactly
  the pair in the pilot header); Eugene = rick.albritton@svdp.us.

- **Eugene flipped too, deliberately.** Unlike the ADR-0088 throughput-gap flip
  (which left Eugene pilot because it has no Terex and can never fire), Eugene's
  `ipad_queue` is live and it can strand a load once floor work starts there. It
  has zero `inbound_loads` today, so the flip cannot mail Rick yet.

- **First LIVE delivery 12:51:40 PM PT: 2/2 accepted** — H-136147 (Kiefer
  Landfill, Janette Tomas, `arrived`, 296 minutes silent). Ledger
  `notify_mode=live, recipient_count=2, delivered_count=2`; audit row names both
  addresses. **Caveat stated honestly:** `delivered` means Microsoft Graph
  accepted the message (202), not that it reached an inbox.

- **One pilot-era ledger row cleared** so that first live send could happen: the
  12:32 PM pilot send went to admins, so the floor had never been told about a
  load still open and by then five hours silent. Scoped to
  `notify_mode='pilot'` AND the load still being open — matched exactly one row.

- **Worst-case send rate to the floor: 1 email per site per day.** One scheduled
  fire (16:45 PT), one mail per site listing every newly-stale load, and a
  load-keyed ledger so nothing re-reports. Fifty stranded loads would still be
  one email.

## 2026-08-11 (12:15 PM PT) — The watchdog could not be reached, and neither could the TTL sweep (ADR-0092 follow-up)

Firing the new stale-claim scan by hand after deploy — rather than leaving it for
its first 16:45 PT run — returned `HTTP 401 {"error":"unauthenticated"}` with a
token byte-identical across all three containers. `/api/internal/loads/` was
never added to the middleware exemption list in `public-paths.ts`, so the route
was refused at the edge. Left alone, the daemon would have logged one failure a
day into its own container log and reported nothing, forever: **a watchdog that
does not watch, which is worse than no watchdog, because an empty ledger reads
as "no stranded loads."**

Note the daemon's `redirect:'manual'` guard could not have caught this. That
guard exists for the 2026-07-03 shape (a 307 to /login followed into a 200 HTML
page); ADR-0078 G7 replaced that with a flat 401 for `/api/*`, so there is no
redirect to refuse.

- **Fixed:** `/api/internal/loads/` exempted, with the route's own
  `guardInternalCron` (constant-time bearer + 404 on `cf-connecting-ip`) still
  the actual authorization.

- **The class, not the instance.** The exemption list has grown one production
  incident at a time (ADR-0036, ADR-0058, ADR-0067, ADR-0088, now this). A
  hand-maintained list of things-you-must-not-forget forgets, so
  `public-paths.test.ts` now **sweeps every `/api/internal/**/route.ts` on disk\*\*
  and asserts each is reachable. A new internal route that nobody exempts fails
  at the moment it is written.

- **That sweep immediately found a SECOND, PRE-EXISTING break.**
  `/api/internal/idempotency/sweep` (ADR-0078, the `idempotency_keys` TTL sweep,
  03:10 PT nightly) was never exempted either — verified by a bearer-carrying
  POST from inside the compose network returning 401. Every nightly fire since it
  shipped has been refused, so the receipt book has never been successfully
  pruned. **Impact measured, not assumed:** the table held 141 rows, oldest 4
  days, **zero past the 7-day retention floor** — the first successful sweep
  deleted 0. The break was real but had cost nothing yet; it was latent and
  would have begun mattering the first time a key aged past the TTL. Not a
  regression from this work; found by it.

## 2026-08-11 (11:00 AM PT) — Stale-claim watchdog: a stranded load stops needing a person to notice it (ADR-0092)

The ADR-0091 incident investigation found, next to the bug, a load nobody was
looking for: **H-136796** (HWMA, 117 expected units) held since 8/10 5:12 PM PT
and still `in_progress` **15.3 hours** later. The takeover history says that is
routine — 11 takeovers exist in production and **8 of them fired in one
eight-minute window** on 8/10 morning, one operator sweeping up after two others.
ADR-0082 built the mechanism to fix a stranded load and ADR-0091 made it
discoverable; neither built the thing that says a load _is_ stranded.

- **Detection is SILENCE, not claim age.** ADR-0082 said claim age carries
  strandedness; production falsifies that in both directions (a 07:55 PT claim
  against a 15:00 PT appointment is not abandoned; a load claimed 20 min ago and
  dropped 19 min ago is). The signal is time since the last evidence of work —
  `GREATEST(updated_at, newest stack, newest photo)`. **All three are required:**
  `addStack` never touches the parent row, so `updated_at` freezes for the whole
  count and a naive detector would report operators as abandoned mid-count.

- **Thresholds sit in a gap the data actually has.** Of 58 operator-claimed loads
  that reached `submitted`, the 52 healthy ones were all submitted the SAME
  Pacific day (p90 73 min, max 8.5 h); the 6 that crossed a day took 2–4 DAYS.
  Badge at **2 h** (in-app only), mail at **4 h**.

- **In-app first, and no page.** Hard rule #5 keeps operational events off ntfy
  ("long unloads, SLA breaches" are its own examples) and ADR-0037 puts
  below-default findings on a dashboard. So the primary surface is a new
  Operations Dashboard panel naming which loads are quiet, each linking tier-1 to
  the load; the 16:45 PT `notifyStaff()` nudge (born **pilot**) is the backstop
  for the day nobody looked. ntfy fires only when the nudge reaches 0 recipients.

- **No auto-release, at any threshold.** An auto-release that fires while an
  operator is mid-count on a slept iPad is this week's incident with a worse
  blast radius. The watchdog points; a person presses ADR-0082's Take over.

- **Idempotency is the database.** `stale_claim_alerts` unique on `load_id` — one
  report per load ever, so a re-fire, a restart, or a hand-run curl cannot
  double-report. Safe to invoke by hand.

- **Also fixed while in here:** `ops-overview.ts` carried a byte-for-byte copy of
  `OPEN_DOCK_STATUSES` under a local name, never imported — now the shared
  constant. And two cron daemons that were never covered by the DST regression
  test now are: this one and `equipment-throughput-gap-cron` (ADR-0088), which
  shipped carrying its own untested copy of the offset-reprobe helper.

## 2026-08-11 (10:48 AM PT) — Eugene bonus approver is Patrick; the 08:30 auto-override was dead at both sites (ADR-0019.3)

Bill directed that Patrick Dills become the Eugene bonus approver. The instruction
was phrased "remove Kelsey, install Patrick" — but Kelsey had held no slot since
**2026-08-08**, when Shannon Rockwell was installed as cover on Bill's own prior
instruction. Applying the words literally would have evicted Shannon, who was
never mentioned. The change was held, re-confirmed against `audit_log`, and
applied to the seat as it actually stood.

- **Eugene ops signer: Shannon → Patrick Dills.** Rick Albritton keeps facility;
  `ops_override` stays Bill-only; Patrick replaces Shannon in `facility_override`.
  No code change — approver identity is data (`bonus_signature_chains`), and the
  chain cache TTL is 30s, so it went live without a deploy.

- **This reverses the ADR-0023 / T-312 separation-of-duties exclusion, knowingly.**
  Patrick is also a Eugene `BonusEmployee` (119 entries, 2025-01-07 → 2026-01-14;
  now `is_active=false`), so he can be the default approver for amendments
  touching his own historical rows. The DB CHECK stops requester == approver, not
  approver-has-an-interest. Bill owns the trade-off; it is recorded, not absorbed.

- **Found while verifying: the 08:30 PT auto-override was dead at BOTH sites.**
  `auto_override_actor_user_id` pointed at `45a9d1d0…` (`operations@svdp.us`), an
  account seeded `is_active=false` _on purpose_. The `actorUnavailable` guard in
  `escalation.ts` refuses to sign as an inactive actor — so ADR-0019.1's
  "load-bearing mechanism for hitting the 9:00 AM deadline" had been a no-op since
  at least the 2026-07-07 incident. Woodland was carrying it too, one payroll
  morning from the same failure.

- **Root cause of the recurrence — the seed, not the operator.** The 2026-07-07
  audit row correctly records repointing the chain at the active admin. It did not
  stick because `prisma/seed.mjs` aliased `bill.barnard@svdp.us → operations@svdp.us`
  (added because `bill.barnard@` was never seeded), so **every `db:seed` re-broke
  it**. Fixed at the root: `bill.barnard@svdp.us` is now seeded as an active admin
  mirroring the live row (`is_super_admin=true`, so a re-seed cannot downgrade
  him), and the alias is removed with a do-not-reintroduce note.

- **The seed would also have reverted the approver change.** `bonus_signature_chains.csv`
  still named Kelsey; it now names Patrick. A re-seed now reinforces the
  configuration instead of silently rolling back a payroll approver.

- **Docs corrected where they were actively wrong.** ADR-0019.1 §3's timeline table
  had drifted from the schedulers on three times (close 07:00 not Mon 17:30, t1
  07:10 not 06:00, EOD 20:00 not 17:00) — annotated inline and reconciled in
  Amendment 2. The operator runbook told Eugene staff Patrick's corrections must go
  verbally to Rick or Bill; retired. ADR-0028's Patrick carve-out marked reversed.

- **Also confirmed unimplemented:** the ADR-0019.1 §4 "override actor available"
  health pill does not exist. The health pill shipped with a hardcoded six-subsystem
  list that never touches the chain. So a dead override actor is only detectable at
  08:30 PT on payroll morning, 30 minutes before the deadline — which is how this
  defect class has now escaped twice. Not built here; flagged in ADR-0019.1 Am. 2.

- **Verified.** Both chains re-queried; all 12 user references across both sites now
  resolve to `is_active=true` accounts (postcondition enforced inside the
  transaction). Three `audit_log` rows written with full before/after. No Eugene
  amendment requests were pending, so nothing stranded. 663 bonus tests green.

## 2026-08-11 (8:00 AM PT) — INCIDENT: the hauls screen called your own load somebody else's (ADR-0091)

Woodland operator Pablo Ledezma could not finish the Costco-Innovel-Sacramento
load (**H-136311**). The hauls screen told him it was _"Already started by another
operator."_ He had started it himself at **06:46 AM PT**, and the row said so:
`assigned_operator_id` was his.

- **Root cause — a missing field, not a failing guard.** ADR-0074 Am.1 (shipped
  the previous evening) gave the consumed-slot card a sentence and no control,
  and hard-coded that sentence for every open child. `ConsumedLoadRef` carried no
  holder identity, so the card could not have said anything else. Nothing
  rejected Pablo — `audit_log` and `idempotency_keys` show no 4xx/5xx after his
  06:48 AM PT write, just silence. The claim model and `assertOwn` were fine
  throughout; ADR-0082 takeover was fine (he had used it himself the day before).
  What was wrong is that the **queue** had a route back into an open load and the
  **hauls screen** did not, and the hauls screen is the one you use when you know
  the truck's name.

- **Fixed.** `ConsumedLoadRef` gains `loadId` + `holderUserId` + `holderName`. A
  new client-safe `consumed-slot-view.ts` owns the offer decision for both
  surfaces: `resume` (yours) and `held` (a colleague's, routing to the ADR-0082
  Take over panel) both link into `/operator/<site>/load/<id>`; `worked`
  (submitted and beyond) stays the read-only card Am.1 made it. New copy in en /
  es / ur.

- **Guarded.** A second source-level chokepoint test asserts every _rendering_
  surface calls `describeConsumedSlot`, alongside the existing one for
  `toConsumedLoad`. The two file lists differ — which is the argument for a
  shared function rather than a convention, and the reason these two screens
  broke identically twice.

- **Not fixed, and worth saying:** this makes an open load reachable; it does not
  stop one being claimed and abandoned. The survey run during triage found a
  **15-hour** stranded `in_progress` claim (H-136796, HWMA, held since 8/10
  5:12 PM PT) that nothing watches. No stale-claim watchdog is in this change.

## 2026-08-10 (8:45 PM PT) — CLOSE-OUT: four hand-audited data corrections, a drained queue, and one question sent

No code. The end of the day's operational tail, all executed under Bill's user id
with an audit row each, all recorded in `docs/OPEN-ITEMS.md` §0.AX.

- **H-136912's slot freed by RE-ATTRIBUTION, not a detach.** The 95-unit load
  worked 8/7 (13:38–14:19 PT) matches **H-136736** exactly — same transporter
  (Titan Concepts), same commodity, same 53' trailer, same 95-unit count, MRC
  **Delivered** 95, worked 68 minutes after H-136736's appointment — while
  H-136912 is MRC Confirmed/0. Moving `9e7c1cf4.expected_load_id` onto H-136736's
  empty slot closes the consumed slot AND H-136736's missing-work gap in one
  move. **This falsifies the 0.AV claim that "only the operator knows which truck
  it was" for this class:** carrier + commodity + trailer + unit-count + MRC-status
  matching identified the truck from data alone. The 159-unit orphan
  (`2b60d7ba`) is still unattributed — try the same method on it.

- **A stale future-dated aggregate deleted.** `2b460bb7`, 104 program units keyed
  to 2026-08-12 — H-136583's _pre_-ADR-0089 appointment day. The Am.1 re-key moved
  that haul's real units into the 8/6 aggregate, but the bridge never removes a
  day-row whose hauls migrate away. Left alone it would have phantom-added 104
  program units to the floor at Wed 00:00 PT. **The design gap is real and
  unbuilt: the bridge has no cleanup path for aggregate rows whose mirror
  day-group becomes empty.**

- **Six double-entered loads corrected — totals now match MRC exactly on all
  six.** H-135978 / 135313 / 136226 / 136232 / 136250 / 136664 each carried
  exactly 2.000× MRC's count. The replay-double-add theory was **falsified** by
  PR #227's real-Postgres tests (a queued `add_stack` carries its ORIGINAL
  `stackIndex`, so a replay converges or 409s — it can never land at a fresh
  index; and the ADR-0078 D7 branch recomputes rather than accumulates). The
  `load_stacks` rows proved plain DOUBLE-ENTRY: two identical rows per load, the
  signature of re-typing a total the operator believed had not saved. At Bill's
  instruction each duplicate stack was soft-voided (ADR-0090 semantics),
  `total_units` set to the true count, and verified `total_units ==
unit_count_at_unload == live stack sum` on all six. **The live-total display and
  the stack void that shipped in #227 are what prevent recurrence** — until that
  PR the floor had no way to take a stack back, which is consistent with six of
  these shipping.

- **The source reconcile queue drained, with curation** —
  36 approved / 13 aliased / **1 artifact rejected**, plus a corrected "Oakland
  Housing" entry (`scripts/one-off/2026-08-10-source-queue-curation.ts`). Approve
  is still the only write; nothing was auto-written to `sources`. One NEW pending
  item arrived at 7:01 PM PT ("Mt Diablo Pittsburg") — the queue working as
  designed; decide it with the next batch.

- **One question SENT, not answered.** Email to `morena.gomez@svdp.us` from
  `dr3-vision@svdp.us`, CC Bill, asking what the 2026-07-29 150-unit `ipad_floor`
  entry represented. That row occupies the unique (site, day) aggregate slot, so
  the MyMRC bridge could never land 7/29's real aggregate (10 delivered hauls,
  439 program / 382 non-program) — a **671-unit hole the hourly bridge can never
  fix**, and 7/29 has since slid out of the 10-day trailing window. **Do not treat
  the current −52 program floor as a physical deficit:** correcting 7/29 moves it
  to +237 / +1,398. **Second design gap, also unbuilt: there are no defined
  semantics for `ipad_floor` vs `mymrc_haul` contention over the aggregate slot.**

## 2026-08-10 (1:15 PM PT) — VERIFIED: the July Woodland COR clears both gates

The ADR-0089 recovery entry below predicted this and left it to be checked. It
was checked (`scripts/one-off/2026-08-10-adr0089-july-cor-verify.ts`): the July
Woodland Certificate of Recycling passes **both** the freshness gate and the
negative-ledger gate, at **512 units** end-of-month inventory. The block that had
stood since the floor went negative is gone. Nothing was filed — this was a
gate check, and a human still signs every COR (ADR-0042).

## 2026-08-10 (7:54 PM PT) — FEATURE: the floor can go BACK (ADR-0090 B, Amendment 1)

JT, Woodland, 2026-08-10:

> "You can't click the back button after clicking next... when you click a haul, take a
> pic, then enter weight, click enter or next, start unload, enter units received — if you
> want to go back to fix or check what you entered is correct, vision doesn't let you."

She was describing something structural. Stage dispatch was `load.status` plus three
ONE-WAY client latches, all seven stages rendered at one url, and the floor chrome's Back
pill goes to the hub by an explicit ADR-0065 decision never to use `router.back()`. There
was no back-edge anywhere in the state machine.

**Bill's product call, 2026-08-10, is what unblocked it: the unload duration FREEZES at
the first finish.** `unload_duration_seconds` ran `unload_started_at → now`, so a
re-finish after a reopen would have added the whole correction gap — and that figure feeds
throughput and productivity surfaces, where it reads as _how long the truck took_. An
operator who went back to fix a number would have shown up as an operator who unloaded
slowly, and would have stopped going back. The button's explainer copy says so out loud,
in all three locales.

- **Check what I entered — from every stage, always.** A read-only review of the BOL /
  weight-ticket / door-open photos, the weight, the stack list and the running total.
  Never gated on anything: it is the half of the ask that is always safe.

- **Fix the weight, in place.** An overwrite before `submitted` with NO status transition
  (routing it through the capture would push a counting load back to `weight_captured` and
  re-offer the door-open stage). The change **appends** a second audit row rather than
  editing the first — a manager reconciling against a scale ticket needs "it was 12,000 and
  then it was 21,000", and CLAUDE.md hard rule #6 makes the log append-only.

- **Take back a stack you counted wrong.** A SOFT void while `in_progress`: the row
  survives as evidence (struck through, still shown, so the total stays explainable) and
  leaves the billed sum. **Both** `finishUnload` sum sites filter through one shared
  constant — the ADR-0078 D7 late recompute runs on an already-finished load, so filtering
  one and not the other would let any keyed retry silently RESTORE voided units into a
  billed total. Stack indexes are monotonic over voided rows, which is what makes a P2002
  at a voided index provably a replay of the voided write — so `addStack` answers 409 there
  and the queue entry parks for a person, instead of reporting a false 201 and deleting a
  stack of mattresses out of a billed total with no record anywhere.

- **Go back to counting from Finish.** `finished → in_progress`, holder-only, audited
  (`reason: 'reopened_for_correction'`). The reopened load still CONSUMES its haul slot —
  it is live work again and the real truck must not check in underneath it, which is the
  exact opposite of the void. The count recomputes on the re-finish; the duration does not.

**The freeze is a WHERE clause, not a branch.** The timing columns are written by a
conditional `UPDATE ... WHERE unload_duration_seconds IS NULL`, so the freeze holds however
a second finish is reached — reopen, replayed queue entry, hand-crafted POST — and holds
under concurrency, where a read-then-write would not. `unload_finished_at` is frozen with
it so the pair cannot disagree; the instant of a re-finish is the audit row.

**Corrections are online-only and wait for this load's queue to drain.** Replaying a
correction hours later would apply it to a state that has moved on (ADR-0082 D5 / ADR-0090
D2.4). The reverse direction is the silent one — a stack or a finish queued BEFORE the
correction replays afterwards and lands on top of it — so the review panel withholds all
three corrections while `pendingActionsForLoad` is non-zero and SAYS WHY, re-reading on a
3 s tick so the controls return as the queue drains. It fails closed: an unreadable
IndexedDB is not an empty queue.

**The stage is hidden, not unmounted, while reviewing.** Every stage holds operator work
in local state that exists nowhere else — the optimistic `tmp-` stacks queued offline, the
running total, the chosen count mode, a typed weight, a captured photo. Swapping it out
would have discarded all of it, which is a worse dead end than the one this removes.

Schema: `load_stacks` gains `voided_at` / `voided_by` (migration
`20260842_adr0090_back_navigation` — purely additive, idempotent, FK `ON DELETE SET NULL`
plus a pair CHECK, mirroring ADR-0084). Every existing stack is `voided_at IS NULL`, which
is what the new filters select, so no load already in the database changes its billed
total. `ALLOWED_PRIOR.in_progress` gains `finished` for the reopen edge, and
`transition()` gained an `allowedFrom` INTERSECTION so `beginUnload` cannot inherit it —
otherwise a hand-crafted `beginUnloadAction` POST would reopen a finished load with no
reopen reason on the audit row.

No new `LoadStatus` member, so the six hand-maintained allow-lists (OPEN-ITEMS AW-4) are
untouched and AW-4 stays open — bundling that six-file refactor with two billing-sum edits
was not a trade worth making. No new ADR-0047 rollout surface: every surface touched is
already gated on `ipad_queue`, re-checked rather than assumed.

Full reasoning, the deviations from the ADR-0090 §D3 design, and the one accepted residual
(an offline-queued `tmp-` stack cannot be voided — there is no server row to name):
`docs/adr/0090-floor-workflow-ergonomics.md` Amendment 1.

## 2026-08-10 (5:34 PM PT) — FEATURE: the floor can tell two trucks apart, and can close a load it never worked (ADR-0090 A + C)

Three things from the floor on 2026-08-10, all verified against production the same
night, all describing the same three loads — every open load at Woodland held by one
person, and on every operator surface all three read as "a load, from a site, with a
BOL":

| Haul     | Source     | Status        | What it actually was                                             |
| -------- | ---------- | ------------- | ---------------------------------------------------------------- |
| H-136796 | HWMA       | `arrived`     | tapped **19 seconds** before the Santa Rita check-in — a mis-tap |
| H-136917 | Pleasanton | `in_progress` | genuinely open                                                   |
| H-135311 | Wexler     | `in_progress` | a 13-day zombie from the pre-#225 early-start era                |

- **A — the haul number, everywhere a load is identified.** `haulNumberOf()`
  (`src/lib/loads/haul-number.ts`) is the single read, because the number lives in two
  columns (`expected_loads.external_mymrc_haul_id`, authoritative for dock work, and the
  nullable `inbound_loads` column the MyMRC bridge stamps). Now on the queue cards, the
  unfinished-loads rows, the held-by-others rows, the held-by panel and the load header —
  the five surfaces that lacked it. The "Coming up" hauls screen already had it, because
  it reads the MyMRC mirror rather than `expected_loads`. Rendered bare and mono, matching
  that screen: an identifier reads as itself, so no label was invented in three locales.

- **C — a load that should never have been started can be closed by the floor.** JT:
  _"I'm not able to fix the pending one under my name, it doesn't let me 0 it out."_ She
  was right, and it was not a missing button: `addStack` refuses `unitCount < 1` so a load
  cannot be zeroed, and no abandon path existed at any of the seven stages. Every such
  load to date has been closed by hand-audited DB surgery. Now: a two-tap void with a
  **required reason** (`wrong_haul` / `truck_never_arrived` / `other` + note), audited in
  the same transaction as the write, by the holder only (a manager voids by taking over
  first — ADR-0082 — so no second authorization path exists).

  **A void is not a zero.** A truck that arrived carrying nothing is a real delivery and
  belongs in `submitted`; a load that was never a truck must not appear in a delivery
  record at all (ADR-0077 D4's line between "not recorded" and zero). The reason picker is
  what keeps a UI problem distinguishable from a carrier problem.

  **The haul goes back on the queue.** `inbound_loads.expected_load_id` is UNIQUE and
  `startInboundLoad` is idempotent on it, so a voided child that kept its parent would hand
  every future tap back the dead load — the ADR-0074 Am.1 dead end, rebuilt. The void
  severs the link and records it in `voided_from_expected_load_id`.

  Implemented as a new **`LoadStatus` member**, deliberately inverting ADR-0084's column
  pair: every money path on this model already filters through a status ALLOW-list, so a
  new member is excluded by construction (opt-in), where a `voided_at` column would have
  required every one of those queries to add a predicate (opt-out). It also made
  `ALLOWED_PRIOR` a compile error until the transition was declared — the only automatic
  tripwire in the codebase for a forgotten status, and it fired on the first `tsc`.

  All 23 `inboundLoad` query sites were audited. The five status-BLIND readers a floor void
  can actually reach are patched through one greppable helper (`notVoidedLoadWhere`):
  compliance metrics 1/3/7 (a truck that never came would have degraded a **contractual**
  compliance grade forever), `loadsArrivedToday`, the workbook-promotion conflict scan and
  the MyMRC reconciliation matcher. The aggregate-row lookups are unreachable by a
  `b2b_haul` dock void and are documented as such rather than left silent.

- **B (the back button) is designed in ADR-0090 §D3 and NOT built.** The read-only review
  and the in-place weight correction are straightforward; the stack correction is a schema
  change plus two billing-sum edits plus a replay-convergence fix, and a half-tested
  version of that is how a load gets under-billed. With C shipped, a wrong count now has a
  floor-side remedy that needs no DBA. Two product calls are open for Bill (ADR-0090 "Open
  questions"), the load-bearing one being whether `finished → in_progress` may reopen at
  all given that it inflates `unload_duration_seconds`.

- Migration `20260841_adr0090_load_void` — purely additive, guarded, idempotent.
- No new ADR-0047 rollout surface: every surface touched is an existing operator screen
  already gated on `ipad_queue`, and the void inherits that gate.

## 2026-08-10 (later) — FIX: the floor could START a haul days early, and once it had, the card was a dead button forever (ADR-0074 Amendment 1)

The Woodland floor was blocked on the morning of 2026-08-10. The Santa Rita Jail truck
was on the dock, its card would not open, and no screen anywhere said why.

**Root cause — two conditions were never checked, and a third surface lied about it.**
The check-in affordance was offered on ONE test: "a non-cancelled `expected_loads`
sibling exists." It never asked whether that slot had already been worked, and the
pinned "Coming up" block (ADR-0074 D3) is deliberately unbounded in time. So on
2026-08-03 at 17:01 PT — **four minutes after `ipad_hauls` went live** — an operator
started **H-134743**, whose appointment was **seven days out** (2026-08-10 15:00 PT).
It was worked as if it were the truck on the dock and `submitted` on 08-05 with
**159 units**, against the wrong haul number. When the real truck arrived,
`startInboundLoad`'s idempotency on `expected_load_id` — **correct, and untouched** —
routed every tap into that five-day-old load. Floor unblocked by an audited manual DB
detach (`audit_log.actor_label = 'system:santa-rita-detach'`, 15:42 PT), leaving load
`2b60d7ba` orphaned with its 159 units.

- **Fix 1 — `src/lib/loads/consumed-slot.ts` (new).** The "has this slot been worked?"
  question, answered once. BOTH check-in surfaces were independently blind to it and
  the code was not shared, so fixing one would have left the other. A structural test
  asserts every surface selects the `inbound_load` child and routes through the helper.
- **Fix 2 — `src/lib/loads/portal-hauls.ts`.** `expectedLoadId` is now a **decision**,
  not a raw id: non-null only when the sibling is live, **unconsumed**, and due on the
  **current Pacific day**. New `consumedLoad` carries what was worked. The day bound is
  the same column, window and helper (`currentPacificDayWindow`) the queue already used
  — see the ADR for why bounding was chosen and what the alternative was.
- **Fix 3 — `src/app/operator/[site]/queue/page.tsx`.** Its `where` was
  `{site_id, cancelled_at: null, expected_arrival_at in today}` and nothing else, so on
  the day an appointment finally came round it could not tell a waiting slot from a
  worked one. Now selects the child and renders consumed rows **read-only**. Rows are
  NOT filtered out — a vanished row tells an operator standing next to a truck nothing,
  which is the silence ADR-0065 Am.1 and ADR-0082 both exist to end.
- **Fix 4 — `src/app/operator/[site]/load/[id]/load-workflow.tsx`.** The
  `submitted`/`rejected` branch rendered `"Load {{status}}. Returning to the name
picker…"` and returned **nowhere** — no link, no button, no redirect, no timer, in
  three locales. It was justified as "rare because the submit action redirects"; it is
  reachable **without submitting anything**, which is how the Santa Rita operator hit it
  on every tap. Now a real link to the queue. Key `workflow.load_done_returning`
  **deleted**, not merely unused.
- **Fix 5 — `src/app/operator/[site]/load/[id]/held-by-panel.tsx`.** `STATUS_KEY` held
  only the five open dock statuses and fell back to "Counting", so a `submitted` load
  was shown as being counted **right now** beside a disabled takeover — reading as
  "a colleague has this and I am locked out" when the load had been finished for five
  days. All eleven `LoadStatus` values now have distinct labels; the fallback is
  `queue.open_status_unknown`.
- **i18n (hard rule #4):** three new `floor.common.*` keys and seven new
  `queue.open_status_*` labels across en/es/ur; one key removed. Parity test green.
- **No migration, no schema change.** `expected_loads.inbound_load` is an existing
  relation on an existing unique key.
- **Tests:** 28 new, all written failing first. Includes an explicit **control** case —
  "an UNCONSUMED sibling whose appointment is today still gets the button" — because a
  fix that removed every button would have replaced one outage with another. Full suite
  **4,878 passed / 51 skipped across 432 files**; `tsc --noEmit` 0 errors;
  `next lint --max-warnings 0` clean.
- **Data deliberately untouched.** The four other early-started loads are not modified
  in code or data. Two have appointments still ahead (H-136912, H-136583) and are
  recorded as watch items; the 159-unit reconciliation is an open decision for Bill.
  See `docs/OPEN-ITEMS.md` §0.AV.

## 2026-08-10 (late) — FIX: an expired session on the iPad answered 403, and the reject stage said "retry" forever (ADR-0086 Amendment 1)

Woodland's first-ever load rejection failed on the floor. Bill: _"Kept telling us to
retry rejection evidence after taking a picture. Underneath it says mint failed (403)."_
The photo bytes were never queued and load `54ad7a11` stranded at `unload_started` with
no rejection evidence.

**Not a rejection-specific rule** — `kind='rejection'` minted successfully through the
same route the same morning, and the ADR-0086 grant path was never involved (the live
capture sends no `X-Upload-Grant`).

- **Root cause — the session husk.** Auth.js answers the 5-minute operator idle window
  (and the ADR-0053 D2 kill-switch) with an EMPTY token, not a null one, so a guard is
  handed a session whose `user` is truthy and whose `id`/`role` are undefined.
  `load-photo-guard.ts` tested `!session?.user`, fell through to
  `undefined !== 'operator'`, and threw **403** for an unauthenticated request — the only
  one of fifteen identity guards in the repo that did. iOS suspends the page while the
  camera sheet is up, so a capture involving a walk outlives the window; a first
  rejection is exactly that capture. Line unchanged since `a98d2f37` (2026-05-06) —
  latent for three months because nothing else made an operator sit still mid-write.
- **Fix 1 — `src/lib/load-photo-guard.ts`.** Predicate split: no `session.user.id` ⇒
  **401 `unauthenticated`**; wrong role ⇒ 403 (unchanged); cross-site ⇒ 403 (unchanged,
  hard rule #2 untouched). Both photo routes move together. 401 is what
  `offline-queue.ts`'s `isAuthResponse` classifies as `auth:` — the ADR-0078 G7/G8c
  "sign in and everything drains" recovery, which a 403 can never reach.
- **Fix 2 — `photo-input.tsx`.** The LIVE capture path had no auth classification at all
  (the drain path has had one since ADR-0078 G7), so a corrected 401 would still have
  read `mint failed (401)` + bare retry. A 401 now **queues the photo** (nothing is lost)
  and says _"✓ rejection evidence saved — sign in to send"_; it does **not** advance the
  stage, because Submit behind a dead session is a second, redacted failure. 403 and 500
  keep their old behaviour. Copy added in en/es/ur (hard rule #4).
- **Fix 3 — the recovery destination.** `operator/[site]/load/[id]/page.tsx` and
  `queue/page.tsx` were husk-blind too and sent an idled-out operator to the MANAGER
  Microsoft sign-in via `HOME_ROUTE`; they now route to the PIN screen.
  `operator/[site]/actions.ts` splits the same predicate (it already answered 401 for the
  husk, but reached it via the role check, so a non-operator got 401 too).
- **Tests.** New `session-husk.test.ts` proves the husk against the REAL Auth.js
  callbacks; new `photo-input.auth.test.tsx` and a floor-wide source scan
  (`floor-session-husk-coverage.test.ts`). The pre-existing "no session" guard case
  asserted 403 and is **corrected** — it was agreeing with the bug, and mocking `null`
  alone could never have caught it because `null` 403'd too.
- **NOT changed: the 5-minute idle window.** Camera suspension vs operator idle timeout
  are in structural tension; that is a security-posture decision for Bill (OPEN-ITEMS).
- **Operator action:** the floor must **re-capture** the rejection evidence for load
  `54ad7a11` after deploy — those bytes are not recoverable.

## 2026-08-10 (night) — ADR-0089 RECOVERY EXECUTED: the Woodland floor is positive again

Operational run + docs; no code changed. PR #223 merged (`b3d552c`), deployed,
and the full D4 recovery sequence executed at Bill's instruction, 12:45–12:55 PT:

- **Re-detail**: cursor cleared (7,335 rows, audited) → enrich swept 74 batched
  POSTs → **7,314/7,314 Delivered hauls carry `recycler_reported_delivery_date`
  — zero dateless** (sole error: the known portal ghost).
- **Delta report** (read before bridging): 35 hauls ADDED (+639 program /
  +1,790 non-program — ADR-0089's exact prediction) and 30 hauls RE-ATTRIBUTED
  (3,087 program units to their true delivery days, max 9 days earlier than the
  appointment; the phantom future day 2026-08-12 emptied onto 08-06).
- **Re-bridge** (gate passed at 11,437 ≥ 5,000): 16 days → 2 inserted /
  13 updated / 1 skippedGuarded (manager-owned day; precedence held) /
  0 dateless; 15 in-transaction audit rows.
- **Floor before → after: −1,166 program / −505 non-program (−1,671 total) →
  +479 / +903 (+1,382 total).** Freshness reads business day 2026-08-10 on the
  COALESCE key. July COR negative-ledger block expected to clear — **VERIFIED
  clear the same afternoon at 512 units EOM; see the 1:15 PM PT entry above.**
- Residual (cosmetic): `fix-woodland-inbound.sh` heredoc emits two harmless
  `command not found` lines from backticks in a SQL comment — pre-existing.

## 2026-08-10 (evening) — ADR-0089 BUILT: inbound re-keyed on the true delivery date (D1–D3 + D4 tooling)

Bill: "go ahead and start the build." D1–D3 implemented TDD-first, D4 tooling
built; the D4 recovery RUN stays operator-sequenced (see OPEN-ITEMS). Deploying
this build moves NO business figure by itself: every pre-deploy mirror row has a
NULL delivery date and the COALESCE falls back to the appointment date, so
behavior is byte-identical until the re-detail sweep runs.

- **D1 — the field is requested and stored.** Migration
  `20260840_adr0089_recycler_delivery_date` adds `recycler_reported_delivery_date`,
  `transporter_reported_delivery_date` (defensive; null in practice) and
  `unit_count_at_unload` (F-3 groundwork) to `mymrc_hauls_mirror`;
  `HAUL_OPTIONAL_FIELDS` +3; `mapHaulRecord` (noon-UTC date convention) + both
  detail write paths.
- **D2 — the bridge keys on `recycler_reported_delivery_date ?? docking_appointment_date`.**
  `haulsUndated` now means GENUINELY dateless (both fields null), and that
  residual is ALERTABLE: new `findDatelessDeliveredHauls` — narrowed to
  detailed + recently-seen rows so the pre-deploy backlog can never storm —
  wired into the hourly scrape, pager kind `dateless_hauls`, per-site
  fingerprint, 24 h cooldown, `dr3-vision-system` (hard rule #5: an integration
  data-quality event, not an operational staff signal).
- **D3 — freshness measures the SAME key**: raw
  `max(COALESCE(delivery, appointment))` over Delivered (`max(COALESCE)` ≠
  `GREATEST(max,max)` — an early delivery against a late appointment must count
  as its real day). The COR inbound gate inherits through `measureFeedFreshness`
  unchanged; its test fake now pins BOTH guard properties in the SQL text.
- **D4 tooling (build only; the run is Bill-gated):**
  `2026-08-10-adr0089-redetail-sweep.sh` (clears only the `detail_fetched_at`
  scraper cursor, audited, dry-run default) and
  `2026-08-10-adr0089-rekey-delta-report.sh` (read-only; separates NEW days
  from RE-ATTRIBUTED days per Am.1 §3 — Bill reads this before any re-bridge).
  `fix-woodland-inbound.sh` read-side SQL re-keyed to the same COALESCE so its
  falsification gate cannot diverge from the bridge.
- Tests: 4,823 passed / 0 failed; tsc + eslint clean; migration replay against a
  scratch PG16 clean (`yard_trailers` FK drift pre-exists on main, not touched).

## 2026-08-10 (later still) — ADR-0089 Am.1: the delivery-date field is PROVEN, the fallbacks are dead, and the appointment date lies even when present

Field-proof executed same day at Bill's instruction ("deep dive and make sure
this is our path forward"). **No pipeline code changed; a read-only probe +
docs only.**

- **Probe:** `scripts/one-off/2026-08-10-adr0089-field-probe.mjs` — drives the
  same batched `getRecordWithFields` transport as the enrichment engine but
  never touches the upsert; run once in the one-shot scrape container
  (~11:04 AM PT, between hourly ticks). Sampled 14 hauls across 5 classes
  (canonical undated / collection-network undated / dated comparators /
  Confirmed controls / pre-anchor). **14/14 fetched, 0 errors.**
- **`Recycler_Reported_Delivery_Date__c` is populated on 12/12 Delivered
  hauls** — every undated collection-network haul (Golden Bear, Vasco,
  Petaluma, Ikea ×2, Solano) and both pre-anchor rows from 2023/2024 (so the
  D4 re-detail recovers real dates on the whole 3,330-row backlog). Null on
  both Confirmed controls, correctly. Bare `YYYY-MM-DD`, same shape as the
  appointment date.
- **Both fallback candidates are dead in practice**:
  `Transporter_Reported_Delivery_Date__c` and `Actual_Pickup_Date__c` are null
  on all 14 — the COALESCE leans on the recycler date alone.
- **NEW finding (Am.1 §3):** 2 of 3 dated comparators were delivered up to a
  week BEFORE their appointment date (H-136583 dock 08-12 / delivered 08-06;
  H-136271 dock 08-10 / delivered 08-03). D2's re-key therefore also
  re-attributes some already-bridged dated hauls to earlier days —
  re-attribution scope is now an explicit build-session decision, with a
  gated re-bridge + before/after per-day delta report required.
- Bonus: `Unit_Count_at_Unload__c` populated on all Delivered rows and
  diverges from the program count on collection hauls — the natural F-3
  cross-check input; added to D1's request set.
- **Path forward CONFIRMED: D1–D5 stand** (D1 gains two fields; D2/D4 gain the
  re-attribution decision). Docs: ADR-0089 Am.1 + OPEN-ITEMS O-3 updated.

## 2026-08-10 (later) — MRC confirmed no delay: the inbound gap is ours, and inbound is keyed on a scheduling field (ADR-0089, Proposed)

Diagnosis only. **No pipeline code changed; docs only.**

Bill spoke to MRC directly (~10:26 PT): MRC **has** haul data entered after
2026-07-21 and reports **no issues or delays**. That retires the last upstream
explanation this project was carrying, and a re-measurement on prod the same
morning found the mechanism.

### The mirror is not stale — that part is fixed and stayed fixed

7,334 haul rows; newest delivered dock date **2026-08-12**; newest `first_seen_at`
**2026-08-10 10:00 PT** (17:00 UTC); detail coverage **7,333/7,334** (one portal-side
ghost, inert); hourly cron `status='ok'` on all four feeds. Delivered hauls dated
07-22→08-12 = **93 hauls / 10,134 program units**, every weekday populated. The
07-21 cliff closed on 2026-08-03 and has not reopened.

### What MRC's confirmation falsifies

- **OPEN-ITEMS O-3 candidate 1 — "further MRC marking lag (22 hauls still Confirmed,
  dated 08-04+)" — is DEAD.** Only **16** Confirmed hauls remain mirror-wide, and
  **12 are dated 2026-08-10 or later** (today/future, legitimately undelivered). Four
  carry a past dock date. Twenty-two became four with no MRC chase; MRC reports no
  backlog. It cannot account for ~1,900 units.

### The real leak: we key inbound on the wrong field

**3,330 of 7,334 rows (45%) carry a NULL `docking_appointment_date`** — 3,328
Delivered, **206,684 program units**, every one skipped by the ADR-0059 bridge.

ADR-0059 and `src/lib/mymrc/inbound-bridge.ts` both assert that "every undated haul
is historical (pre-anchor) and inert for the live floor" and that "the live/forward
path is fully covered." **Both are false.** Undated Delivered hauls keep arriving:

| First seen (PT)       | Hauls  | Program | Non-program | Weight         |
| --------------------- | ------ | ------- | ----------- | -------------- |
| 2026-07-31            | 16     | 228     | 727         | 52,525 lb      |
| 2026-08-01 → 08-07    | 18     | 301     | 1,063       | 75,020 lb      |
| 2026-08-10            | 1      | 110     | 0           | 6,050 lb       |
| **Post-anchor total** | **35** | **639** | **1,790**   | **133,595 lb** |

Thirty-five real deliveries — 2,429 units, 67 tons — reached DR3 Woodland since the
anchor and never touched the floor ledger. Not lag, not upstream: mirrored correctly
with correct unit counts, then dropped by our own bridge. They are the CA collection
network (Ikea Emeryville/West Sac/Palo Alto, Recology ×4, Golden Bear, Vasco
Republic, MT Diablo, Sonoma Transfer Station, Outlaw Hauling, CRDN), each payload
naming `Recycling_Center_Lookup__r.Name = "DR3 Woodland"`.

**Root cause.** `Docking_Appointment_Date__c` is a **scheduling** field, populated
only when a haul books a dock slot. Route collections book none, so MyMRC leaves it
null — verified in H-137017's raw payload (Delivered, 110 program units, 6,050 lb,
Golden Bear): `"Docking_Appointment_Date__c": {"value": null}`. The bridge calls that
field "the delivery-day key." It is not a delivery date. The correlation is exact:
**every haul with a `Collection_Source__c` set is undated — 886/886.**

MyMRC has the field we need. Our own Phase-0 deliverable
`docs/mymrc-discovery-2026-07-22.md` enumerates **`Recycler_Reported_Delivery_Date__c`**
as both a list column and one of the 52 detail fields (alongside
`Transporter_Reported_Delivery_Date__c`, `Actual_Pickup_Date__c`,
`Unit_Count_at_Unload__c`). `HAUL_OPTIONAL_FIELDS` requests **none** of them;
`grep -rn "Recycler_Reported_Delivery_Date" src/ scripts/ prisma/` returns nothing.
We enumerated the delivery date on 2026-07-22, wrote it down, and never asked for it.

**The guard shares the blind spot.** `FRESHNESS_COLUMN` keys _both_ haul feeds on
`docking_appointment_date`, so the COR inbound gate would report the delivered feed
**fresh** while 100% of collection-network intake went unbridged. ADR-0070 fixed
_which rows_ we measure; it did not fix _which column_.

### Recorded

- **`docs/adr/0089-inbound-is-keyed-on-a-scheduling-field.md` (Proposed)** — the
  diagnosis, the five proposed decisions (request the delivery date; key inbound on
  `COALESCE(delivery, appointment)`; move freshness to the same key; re-detail +
  backfill the recovered window; leave pre-anchor units alone), and the alternatives
  rejected.
- **OPEN-ITEMS O-3 updated** with the falsified candidate and the new prime suspect.

### Still unproven — do this first

We have **not** observed a populated value in `Recycler_Reported_Delivery_Date__c`.
Enumeration proves the field exists, not that MRC fills it, and the captured fixtures
predate it. Prove it on one haul (H-137017) — add the field, clear `detail_fetched_at`,
run `scripts/mymrc-enrich-details.mjs`, read the value — before committing to the fix.
Committing first would repeat the exact error this ADR exists to correct.

### Note for the record

2026-07-31, 2026-08-03 and today all opened with "it's upstream" and closed with a
Vision-side cause. On this integration the upstream hypothesis is **0-for-3** and
should carry the burden of proof, not the presumption of it. Billing exposure from
this defect is in the safe direction: unbridged inbound understates what DR3
received, so MRC was not overbilled.

## 2026-08-10 — ADR-0088 throughput-gap nudge ramped LIVE at Woodland

Operational flip + docs; no code deployed.

- **`equipment_throughput_gap` flipped `pilot → live` at Woodland** at Bill's
  written instruction ("flip live the no terex numbers alert - that should be
  good to go"), through the audited `flipRolloutSurface` path — one-off
  `scripts/one-off/2026-08-10-throughput-gap-flip-live.ts` (dry-run-first,
  `--apply`), actor label `system:throughput-gap-flip`, criteria note carrying
  the pilot evidence. Verified live post-flip: `rollout_surfaces` row
  `live`/attributed/stamped, matching `audit_log` row. **Eugene stays `pilot`**
  as a recorded "no" (no machine; ADR-0088 D3 row 4), per the terex-ledger
  precedent.
- **The ramp decision had real evidence behind it**: the watchdog's first
  scheduled pass (2026-08-10 08:30 PT — the first working morning after the
  #222 deploy) found **Friday 2026-08-07 unrecorded** and delivered the
  pilot-mode nudge 1/1 to admins. Instrument proven end to end: cron fired on
  time, D2 walked Monday back to Friday, the ledger row landed
  (woodland, 2026-08-07, `notify_mode = pilot`), mail delivered. The 0.AQ
  first-morning verify is closed by the same query.
- **Effect from the next gap found**: the morning nudge goes to Woodland's
  `alert_recipients` roster (Morena + Janette) instead of admins. No
  back-alerting; days already nudged in pilot are ledger-blocked from re-send.
- Docs: ADR-0088 status updated; OPEN-ITEMS 0.AQ ramp + verify items closed.

## 2026-08-08 — evening close-out: registers reconciled, Terex gap diagnosed, all six campaign PRs merged

Docs only. The day's operational record, landed after the final merge so no
in-flight branch conflicts with it:

- **All six campaign PRs merged + deployed**: #216 (ADR-0082), #217 (ADR-0085),
  #218 (ADR-0083/0084), #219 (Am.1 pair + the month-page pay-path fix), #220
  (ADR-0086, `photo_grants_ok: true` verified live), #222 (ADR-0088, renumbered
  from a 0087 collision with #221, which also merged). Every PR passed
  adversarial pre-merge review; the campaign's through-line: most defects that
  mattered were false claims in DOCUMENTATION, not broken code.
- **Walkthrough decisions executed**: `ipad_dropoff` LIVE both sites; void
  site-scoped; saves editable in amendments; ADR-0086 accepted+built; trailer
  list reclassified `trailer_list` (96 rows absorbed on the next sweep); Kelsey
  login kept active by decision, re-check 2026-08-22.
- **Terex gap diagnosed** (§0.AT): workbook stopped 7/24, floor never stopped —
  nine-day paperwork gap; capture era one working day old and un-entered (JT
  used the downtime form by mistake). Option B chosen: sheet re-fill → final
  import; instruction email sent via `dr3-vision@svdp.us`.
- **Email channel rule codified**: NEVER barnardhq.com to @svdp.us recipients;
  Vision-related mail sends from `dr3-vision@svdp.us` (Graph, app credentials).
- **Register hygiene**: duplicate `0.AO` renumbered → `0.AS`; VLM section
  renumbered `0.AP`→`0.AR` at merge; claim-the-number-first rule added to the
  ADR index after the third numbering collision.

## 2026-08-08 — VLM equipment decision register opened (ADR-0087, Proposed)

Docs only, `[skip-deploy]`. Locks the VLM↔DR3 equipment normalization/sync work
into a durable decision mechanism instead of chat approvals.

- **ADR-0087 (Proposed, NOT accepted)** — VLM equipment identity + normalization
  policy: `vlm_legacy_id` as the sync key, canonical match key preserving `-`/`#`
  (both VIN-proven load-bearing), merges require VIN/make corroboration, nightly
  CDC upsert, AP request-resolution similarity gate. Corrects ADR-0075 D5 (the
  Terex merges were never executed).
- **Decision register** — `docs/plans/2026-08-08-vlm-equipment-decision-register.md`
  - 5 replica-generated CSV worksheets (492 ghost units, 146 blank types, 48
    alias candidates, 39 type mappings, 6 `-ACC` values) with `decision` columns
    and bulk-rule support; regeneration SQL committed alongside. Nothing executes
    until rows are decided (ADR-0087 D7).
- OPEN-ITEMS §0.AR records the waiting-on-Bill state.

## 2026-08-08 — nine days of silence, and the instrument that reads the gap (ADR-0088, born pilot)

Bill asked why the Terex sheet went unfilled for nine working days without anyone
noticing. The answer is uncomfortable, because **nothing was broken**.

ADR-0079 got the hard part right. It made "nobody wrote a number down" a first-class
state — the ABSENCE of a row, deliberately never a `0` (ADR-0077 D4) — and every
consumer honours it. The trend page drew all nine of those days as `not_recorded`,
faithfully, for nine days running. ADR-0081 then imported the workbook's own history
into the same table without ever letting the sheet overwrite a manager's row. All of
that was correct and all of it was **passive**.

The complete list of detectors for a capture gap in this system was: Bill opens the
chart and notices. That is not an instrument — it is a person doing an instrument's
job, and it failed for exactly as long as it takes a habit to stop being a habit.
Post-cutover the manager surface inherits the identical silence: JT types the number
into Vision instead of Excel, and if he stops, the page keeps drawing "not recorded"
and keeps telling nobody. **What was missing was never the data model. It was a
reader.**

**One question, once a working morning, per site.** Did the PREVIOUS WORKING DAY get
a live throughput row for the machine the registry resolves here? If not, one email.
That is the whole feature.

- **It asks about ROW EXISTENCE and never about magnitude.** A recorded
  `units_processed = 0` is a RECORDED day — the machine ran and produced nothing,
  which is a measurement, and ADR-0077 D4 exists to keep it distinguishable from
  absence. A `> 0` test would nudge a manager who did exactly what was asked. The
  query carries **no units predicate at all**, and a test asserts the shape of the
  where-clause so the right answer cannot be reached for the wrong reason. Falsified
  RED against a `units_processed: { gt: 0 }` mutation before shipping — and the fake
  DB was rewritten mid-build to _evaluate_ the where-clause rather than assume its
  shape, because the first version returned the right answer to a wrong query and
  the outcome assertion stayed green. A fake that ignores predicates it wasn't told
  about is a rubber stamp, not a test double.
- **The mirror case:** a day whose only row was soft-voided counts as MISSING. Not a
  judgement call — ADR-0079's partial unique index already says a voided row does not
  hold the day's slot.
- **Monday looks back to FRIDAY, not Sunday.** A naive "yesterday" makes every Monday
  scan a Sunday, find nothing (there never is anything), and alert every single week
  — an alert that fires on schedule regardless of the facts. Falsified RED: replacing
  the working-day walk with plain "yesterday" reds 12 tests.
- **Holidays are SITE-scoped**, deliberately unlike `ap/business-clock.ts`'s
  fleet-wide clock. That module is person-scoped and pauses only when BOTH sites
  observe a holiday; this watchdog is site-scoped end to end, so Woodland closed for
  a California holiday did not fail to record anything.
- **Four hard never-fires:** pre-cutover days (`< 2026-08-07` is the sheet era,
  ADR-0079 Am.1), pilot sites (`equipment_entry` not live — nobody there can even
  reach the form), weekends (suppressed as gap days _and_ as run days), and sites with
  no machine (Eugene resolves to null; site-DERIVED, never hardcoded).
- **The nine July days are NOT back-alerted.** Opening a new channel with a burst of
  mail about days nobody can act on is how a channel gets muted in its first week.

**It is a staff nudge, not a page — and the reasoning, not just the conclusion.**
Hard rule #5 reserves ntfy for Bill and for SYSTEM events; a manager who did not type
a number is the paradigm operational event that rule excludes. So it rides
`notifyStaff()` on its **own** registered surface, `equipment_throughput_gap`, born
pilot — its own rather than `alert_digest` because the digest is an 18:00 PT
many-findings rollup a manager may reasonably skim, and Bill must be able to ramp the
morning nudge at Woodland without ramping the digest. The audience is the existing
`alert_recipients` roster (the site managers — exactly who types this number); a
second roster table would be a second thing to keep current and get wrong. **The one
thing that does page** `dr3-vision-system` is the nudge failing to deliver (0 of N),
the same carve-out `alert-digest.ts` makes, on the **same existing topic** — no new
ntfy topic, because a topic nobody is subscribed to would be a particularly ironic
way to ship a watchdog.

**Severity `default`, and the ADR-0037 gate answered honestly.** It fails
5-minute-actionable and customer-visible, and the sharp edge is _why_: ADR-0079 D4
REFUSES a prior-day entry, so the missed day **cannot simply be typed in**. An email
that only said "please enter it" would send the manager to a screen that tells them
no. The body says three things and stops — which day was missed, that today's numbers
can still be entered freely, and that the missed day goes through the office. What is
immediately actionable is the habit, and the habit is what actually failed.

**Idempotency is a database constraint, not a cooldown.** `equipment_throughput_gap_alerts`
is unique on **(site_id, gap_date)** — keyed on the MISSED day, not the run day — so a
working day is nudged exactly once, ever, regardless of re-fires, restarts, or a
duplicated cron container. An in-process cooldown lives in container memory and
re-arms on restart; this is strictly stronger than the ADR-0037 floor. A ledger row is
written only after a real send decision, so an M365-disabled no-op or an empty roster
leaves the nudge still owed.

- **The middleware exemption is load-bearing here more than anywhere.**
  `/api/internal/equipment/` joins `public-paths.ts` (TEN → ELEVEN). Without it the
  middleware 307s the session-less POST to `/login`, the daemon logs a 200 for the
  login page, and the ledger stays empty — **and an empty ledger reads as "no gaps
  found."** That is the original defect reproduced inside its own fix. The daemon uses
  `redirect: 'manual'` as the second defence.
- **Its own cron container at 08:30 PT**, rather than riding the 18:00 PT daily-report
  tick as ADR-0043 D5 does. That ADR's binding constraint was "no new container" and
  it paid with a documented deviation from its own timing requirement. Here the fire
  time IS the feature: a nudge about yesterday arriving at the END of today is
  useless, because the only action it enables has already expired. Verified
  DST-correct across both 2026-11-01 (fall back) and 2027-03-14 (spring forward).
- **Ships DARK.** Until Bill flips `equipment_throughput_gap` to `live` per site at
  `/admin/rollout`, the mail goes to admins only — which is also what lets him read a
  week of them before any manager does.

Gates: `tsc --noEmit` clean, ESLint clean, 4,812 unit tests green (30 new for the
watchdog, 3 for the route), every migration replayed on a clean PG16, and the unique

- CHECK constraints proven live by trying to violate them.

## 2026-08-08 — a photo captured under login A carries its own right to land (ADR-0086, accepted)

Bill accepted ADR-0086 at the 2026-08-08 walkthrough. It is now built.

The residual it closes is narrow and its failure mode is permanent. ADR-0078 G7 fixed
the auth failure that _looked_ like success and Amendment 1 loosened the photo gate
from load-owner to site — but a queued photo **still needed a live signed-in session
at the same site in order to drain**, and on iOS there is no closed-app execution to
fall back on. If the last operator of a shift signs out while photos are still in the
device's IndexedDB, they sit there. The bytes exist in exactly one place. A wipe, a
reset, a replaced iPad, or a device that goes back in the drawer at the end of a
season, and the evidence is gone. The ADR-0078 build met the 99-photo-parked case
live; those photos survived only because somebody was still signed in when the CORS
repair landed.

**The correction that is the substance of the ADR.** The design recorded in
OPEN-ITEMS §0.AJ signed the grant over `storage_key` and required the request's fields
to match exactly. That is circular and unbuildable: the client treats a presign as
stale at 8 minutes, and re-minting produces a brand-new key because `mintUploadUrl`
embeds a fresh `randomUUID()` — so every photo the feature exists for would fail the
grant's own field check, and the drain would die one step earlier anyway, because the
re-mint is itself a call to the session-gated route. The grant **cannot** be a claim
about one R2 object, because the object is not stable across the queue's lifetime. So
it is a claim about _the right to attach one photo of one kind to one load_, and object
identity is constrained **structurally, by key prefix**, instead. The §0.AJ paragraph
is left in the register unedited, behind a "do not build from this" fence — deleting it
would leave the correction with nothing to correct.

What the credential is: a 14-day bearer token, minted at capture while a session
provably exists, authorising exactly one write — one photo, of one declared kind, to
one named load, under one already-claimed idempotency key. It cannot read, cannot
enumerate, and cannot write a count, a bonus entry, an inventory row or money.

- **Both photo routes moved together, in the same commit, by the same predicate.** The
  mint call site has carried the instruction for a year: a relaxed mint with a strict
  confirm PUTs bytes to R2 and is then refused the row — an orphaned object, no record,
  and a queue row that still cannot drain, which is strictly worse than doing nothing.
  A test drives the same five grants through both handlers and fails if their verdicts
  ever diverge, so that constraint is now structural rather than two files agreeing by
  habit.
- **Revocation is a hard requirement, and it is the reason a 14-day bearer token is
  acceptable at all.** Signature verification does not consult the `users` table, so
  without a redemption-time read "revoke this person's access" would be untrue for a
  fortnight — a claim the compliance surface makes. Every redemption re-reads
  `is_active`, `deleted_at`, `role` and `primary_site_id` **live**. Kelsey Ruhland's
  availability ended 2026-08-08; a grant minted on 08-07 would otherwise still have
  authorised a write on 08-21, attributed to her.
- **Attribution gets MORE truthful, which runs opposite to the usual direction for a
  bearer credential.** Under a grant `uploaded_by` becomes the capture-time operator —
  the person who actually took the photo — rather than whoever happened to be signed in
  when the queue drained.
- **No middleware exemption.** Neither route is in `PUBLIC_PATHS`. That file carries
  ten `/api/internal/*` exemptions, each with a comment recording the same shape: a
  session-less POST 307s to `/login`, `fetch` follows it, a 200 carrying the login page
  comes back, and the caller logs success for work that never happened. What the
  feature needed instead is a keyhole — exact path, POST only, a syntactically
  well-formed header — on the `!req.auth` branch alone, with the route still doing the
  verifying. **The ADR's own stated mechanism for this was stale:** D4 says the routes
  are reached because the client sends `redirect: 'manual'`, but ADR-0078 G7 had
  already replaced the 307 with a **401**, which no redirect mode can survive. Recorded
  in ADR-0086 §10.2 rather than quietly worked around.
- **A refused grant never breaks a working upload.** If a grant is presented and
  refused but a session exists, the request proceeds on the session. A design where a
  stale credential broke a path that works today would be worse than not shipping.
- **A refused grant with no session answers 401, not 403**, in the `auth:` family under
  its own `auth:grant_refused` — because a sign-in genuinely fixes it, and that keeps
  the ADR-0078 G8c one-tap recovery working. Distinct from `auth:session_expired`, so
  the queue screen can still say which; never folded into the generic retry, which is
  the conflation that let 97 photos accumulate invisibly behind a CORS 403.
- **The grant is bound to one idempotency key**, and a grant-auth confirm presenting a
  different key — or none — is refused. That is what "single-use by construction" means
  operationally: without it, one captured grant authorises an unbounded number of rows.
  Proven against real Postgres: one grant redeemed twice, with a deliberately re-minted
  storage key, writes ONE `load_photos` row. Falsified there by dropping the claim —
  two real rows appear.
- **No migration and no queue-schema bump.** The grant is a stateless HMAC, so nothing
  is persisted server-side. `upload_grant` on the queue row is additive, nullable and
  unindexed, and there is **nothing to backfill it with** — a grant can only be minted
  against a live session. A v4 bump would walk every row in a blob-carrying store to
  stamp `null`, for no benefit, while re-opening the interleaving hazard that once
  silently reverted the ADR-0078 G2 key backfill. Guarded by a v1 → current upgrade
  test that checks the blob, the byte size and the G2 key all survive.
- **Rotation is survivable by construction (D6).** A single-key swap would invalidate
  every grant in every iPad at once — turning a routine credential rotation into
  exactly the evidence-loss event this feature prevents, silently. `v` selects the key;
  the verifier accepts `N` and `N-1`; the minter only issues `N`; `N-1` retires no
  sooner than 14 days later. Exercised by a test that rotates two real keys and then
  retires the old one.
- **Rider, found while wiring the capture path:** the LIVE `/api/photos/confirm` call
  sent no `Idempotency-Key` — only the replay did. So a confirm that landed and lost
  its response was queued under a key the server had never seen, and the replay wrote a
  second `load_photos` row. That is the ADR-0078 D3 defect, still open on the one path
  that hands work to the queue. Closed here.

**Ships INERT.** Nothing changes on the floor until the operator provisions
`PHOTO_GRANT_SECRET` on CHAD-HQ (`docs/OPEN-ITEMS.md` §0.AP). Absent, the app mints no
grants — never unsigned or fixed-key ones — and the photo flow behaves exactly as it
did yesterday. `/healthz` gained `photo_grants_ok` so the inert state is visible; it is
deliberately **not** part of the healthz verdict, because this feature's first deploy
necessarily lands before the secret file does and gating on it would roll that deploy
back. Which also means it will never announce itself: check it explicitly after
provisioning.

## 2026-08-08 — the void gate was wrong on a shared iPad, and the "one funnel" claim was not true (ADR-0084 Am.1 + ADR-0083 Am.1)

Two small items Bill ordered off the 2026-08-08 walkthrough, one branch. Neither
touches the schema; no migration.

### ADR-0084 Amendment 1 — "Widen to site."

The same-day count void shipped OWNER-scoped: 403 `not_your_count` unless the
caller was the operator named on the count's original insert audit row. It was
flagged as an open question the same day rather than decided unilaterally,
because the precedent was not automatic — ADR-0078 Am.1 had loosened the photo
gate from load-owner to SITE one week earlier, but **a photo upload is additive
and a void is destructive**: it withdraws the anchor the entire floor is computed
from. Given three options — keep owner-only, widen to site, widen with a manager
confirm — Bill picked the middle one.

The gate is a real loosening and is recorded as one rather than described as a
refactor. **Given up:** an operator can withdraw any live same-day count at their
own site. **Gained:** the mistake is correctable on the shift that made it. A
floor iPad is a shared kiosk with per-operator PIN sign-in; a duplicate keyed at
14:00 could not be withdrawn by whoever PIN'd in at 15:00, and since a void is
same-day only there was no next-day path either — the mistyped anchor simply
stood overnight.

**Attribution went from one id to two.** The audit row now carries
`actor_user_id` (who withdrew it), `after.entered_by` (whose count it was) and
`after.cross_operator` — written on **every** void including self-voids, because
a field present only on the cross-operator case is ambiguous between "the same
person" and "an older build that did not record it", and this history is read
years later by someone with neither the code nor the deploy dates. `entered_by`
is NULL when no insert row exists and is never backfilled from `voided_by` — the
same "we do not know is true" reasoning as ADR-0078 Am.1's `uploaded_by`.

**The widened gate ships with the disclosure, not before it.** A count somebody
else entered is labelled with their name, and the confirm step says so and states
that the withdrawal will be recorded under the signed-in operator's name. Remove
that sentence and you have to re-narrow the gate.

`SnapshotNotYoursError`, `not_your_count`, the client branch that rendered it and
`floor.count.void_err_not_yours` in all three locales were **deleted, not
disabled**, and `listTodaysVoidableCounts` became `listTodaysVoidableCountsAtSite`
— a disused check reads as one somebody forgot to call, and the next reader puts
it back. EN/ES/UR copy was re-voiced from second person to neutral ("Counts **you
entered** today", "before **you** entered it"), which is actively false on a
colleague's row.

Unchanged and pinned: cross-SITE is still a 404 — falsified with the ORIGINAL
ENTERER as the actor, so the surviving refusal is demonstrably the site check and
not a leftover of the ownership one, and the message names both sites. Dropping
the site check goes red with _"a session at site `site-eugene` was allowed to void
snapshot `snap-wood`, which belongs to site `site-woodland`"_. Restoring the owner
gate goes red on the cross-operator case, so the new tests measure the loosening
rather than passing either way. A cross-operator **prior-day** void is still 409:
the amendment widened WHO, never WHEN.

### ADR-0083 Amendment 1 — saves in the amended-month editor

`AmendmentPanel` is the ONLY editor that reaches an already-signed period (the
primary grid refuses a locked month), and it shipped posting
`{bonus_employee_id, mattress_count, note}`. So a mis-keyed saves figure inside a
signed period had no correction surface anywhere in the app. Nothing was ever
lost by that — the service reads an absent `saves` as UNCHANGED, never zero — but
the deadline was real: no signed period contains a non-zero save yet, and the
first one closes at the end of the current bi-weekly period.

Fifth column, `saves` in the POST body, modelled on `DailyEntryGrid` down to the
three semantics that are easy to get subtly wrong: the field is always sent
(a blank box is an explicit `0`, or clearing a value would be impossible from the
one screen that reaches a signed period); a row is keyed if EITHER box has a
value (a resale shift with a zero processed count is a real, paid day); and the
day total tiers ONCE over `count + saves`.

**Checking the deadline turned up a second defect nobody had reported.**
`paid-units.ts` opens by claiming the grid, the signed PDF, the sign-time lock,
the CSV export, the month list, the aggregates and the reconcile tripwire all
route through `dailyPaidUnits`, so the screen, the PDF and the reconciler cannot
diverge. `/bonus/months/[id]/page.tsx` did not. Its per-employee monthly totals
AND its read-only grid totals called `calculateDailyBonusCents(mattress_count, rule)`
— understating every processor's month by the entire cash value of their saves,
on the very page an admin unlocks a signed month from and reads the corrected
total on. The number was well-formed, the page rendered, the suite was green.

So the claim was made structural instead of asserted.
`paid-units-callers.guard.test.ts` reads the actual source of every
`calculateDailyBonusCents` call in `src/` and fails the build on any caller
outside the funnel that is not allowlisted with a written reason and a
`mustContain` token proving its compensating control survives. It asserts its own
call-site count (a rename or a broken glob otherwise reports green while matching
nothing) and strips comments before matching, because every call site in this
repo documents itself in a comment naming the function — the ADR-0084 guard was
already burned once reading the prose that explained a token instead of the
token.

**On four-eyes, the brief's premise was wrong and is recorded as such.** The
change order described this editor as "the same `shouldRequireAmendment` path".
It is not: that predicate is reached only from `upsertDailyEntries`, the primary
grid's path, and `upsertAmendedMonthEntries` has never imported it. That is by
design — this surface is reachable only after an admin unlocks a signed month
with a written reason, which CLEARS BOTH SIGNATURES, and the corrected month must
be re-signed by two signers before it pays. The four eyes are the two
re-signatures over the whole corrected month. What must not become true is that
this path moves a signed month without that unlock; that is pinned behaviourally
(locked month → `month_locked`, nothing written) and structurally (an assertion
that `amendment.ts` does not reference the predicate, so wiring it in has to be
deliberate). §6's own gate is re-pinned from the saves angle so widening this
editor cannot become an argument for relaxing that one.

### Falsifications (every one run, each named by its red)

| Falsification                                                     | Red                                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Drop the site check from `voidSnapshot`                           | names both sites and the snapshot id                                                     |
| Restore the pre-Am.1 owner gate                                   | cross-operator void fails `not_your_count`                                               |
| Remove `entered_by` from the void audit payload                   | self-void case fails the both-ids assertion                                              |
| Drop `saves` from the panel's POST body                           | 4 red, incl. `expected undefined to be +0` on clear-to-zero                              |
| Seed the panel's saves box blank                                  | 3 red; note-only edit posts `saves: 0` for a day that had 9; `$7.50` total reads `$0.00` |
| Make an absent `saves` mean `0` in the service                    | 2,000¢ → 1,325¢ — **$6.75 under-paid on one day**, silently                              |
| Restore `calculateDailyBonusCents(count, rule)` on the month page | 3 red in the guard, naming the file, the line and the fix                                |
| Tier the two columns separately                                   | a 45 + 20 day pays $7.50 summed and **$0.00** tiered twice                               |

### Verified

`tsc --noEmit` clean, `eslint src` clean (0 warnings — warnings are errors here),
full `vitest run` **4,717 passed / 49 skipped / 1 failed**. The one failure is
`src/lib/ap/stamp-render-gate.test.ts`, a chromium-semaphore timing test in
untouched code (`git status` shows no change under `src/lib/ap/`); it passes on
its own and flakes only under the fully-parallel run. The payroll pre-push gate
(`vitest run src/lib/bonus`) is **660 passed / 42 files**, up from 643 — the 17
new tests are this branch's.

## 2026-08-08 — campaign close-out: the F-3 design was unbuildable, and the Kelsey option is dead (PR #215 + register reconciliation)

Docs only, `[skip-deploy]`. PR #215 landed two artifacts as files-only (deliberately
touching no shared register while three feature PRs were in flight); this entry is
the deferred register reconciliation it listed as follow-ups.

- **ADR-0086 (Proposed, NOT accepted)** — capture-time photo upload grants (F-3).
  Corrects the design recorded in OPEN-ITEMS §0.AJ, which was unbuildable as
  written: it signed the grant over `storage_key`, but the drain re-mints a fresh
  random key for any photo older than 8 minutes, so 100% of the population F-3
  exists for would fail its own field check. The corrected grant binds the right
  to attach one photo of one kind to one load. Decision-ready for Bill.
- **Layer-B commodity reconciliation re-scoped**
  (`docs/plans/2026-08-08-layer-b-commodity-reconciliation-rescope.md`). The
  Kelsey-method-capture plan is dead (availability ended 2026-08-08, capture
  never happened) — and checking killed three more premises: the tracker encodes
  _that_ audits happened, not _how_; Shannon never initialled one (Rick and
  Janette hold the interviewable evidence); and the vendor-invoice data leg is
  entirely empty in prod (six tables, 0 rows) — so Kelsey was never the only
  blocker. New sequence: 4a interviews (~2026-08-22), 4b data leg, 4c rules.
- **AK-5 (C-43)** given a decision-by date: **2026-10-01**, one month ahead of
  the `sharedWithMe` 2026-11-01 sunset.
- **OPEN-ITEMS corrections:** AK-1/AK-2 are operator-classified (no longer
  "unconfirmed"); #205 reads ALL FIVE PHASES SHIPPED; three new rows — the
  Kelsey login access review (awaiting Bill), the confirmed-class-with-no-absorber
  silent gap found via the trailer list (open defect), and the S-7
  `recycling_rates` seed question.

## 2026-08-08 — a drop-off is a label, a count and a photo; the money default was the bug (ADR-0085)

JT wanted a button. _"A tile or static button on the iPad; hitting it prompts
Public Drop Off or Incentive Drop, then asks for total units and a photo."_
People walk mattresses up to the gate and nothing captured them at the door.

Bill scoped it in one line, and the scoping turned out to be the substance:
**no money, no PII — including for Incentive.** Its $3/unit is tracked elsewhere,
deliberately.

**The obvious implementation would have paid out $12 a mattress-load.** Not
metaphorically. `src/lib/dropoffs/service.ts` read:

```ts
if (kind === 'incentive') return null;
return units * UNPAID_DROPOFF_CENTS_PER_UNIT; // 300¢/unit
```

An allowlist of **one**, guarding the wrong side of the decision. Read as policy
it says _every drop-off kind mints $3/unit of Bye-Bye-Mattress check money except
the single named exception_, so **any** new `ConsumerDropoffKind` fell straight
through to `units × 300`. Adding two enum values — the whole of the obvious
change — would have written 1,200¢ on a four-unit walk-up, at both sites, on the
one flow that had just been specified as recording no money at all. Nothing in
the types, the tests or the schema would have said a word. It has been in that
shape for a year and nobody has been paid wrongly only because nobody has added
a kind.

The predicate now names the kinds that **do** mint and refuses everything else,
with two independent guards: a **`never` exhaustiveness assertion** that makes
the next `ConsumerDropoffKind` a **compile error** (TS2322) in that file, and a
trailing `return false` for the case the compiler cannot see — a migration that
ships a label before the code that knows about it.

That assertion was missing from the first cut and review caught it. A covered
`switch` followed by `return false` type-checks fine when a new member appears —
every path still returns `boolean`, so it falls through to the floor and `tsc`
exits 0. Verified both ways against an extra enum member: without the assertion
`tsc` passes; with it, `service.ts(141,9): error TS2322`. Money could not have
leaked either way, but the hole pointed the other direction and cost the same — a
future kind that SHOULD pay would have **silently paid nothing**. `money-minting.test.ts` presents a
kind the enum does not contain and proves it mints nothing, then runs the OLD
predicate beside it returning `true` on the same input, so the regression is an
executed fact rather than a paragraph.

**Then the guarantees were made structural.** Three CHECK constraints, because
"the current callers are careful" is exactly what was true of the money default
for a year:

```
consumer_dropoffs_floor_no_money_or_pii        no cents, no name, no check, no paid_at
consumer_dropoffs_floor_requires_photo         no floor drop-off without a photo
consumer_dropoffs_non_floor_requires_person    the manager kinds still need a payee
```

That third one is the half people skip. Relaxing `person_name` from NOT NULL is
a **loosening**, and an unscoped loosening is just a hole — so the old invariant
was pinned back in place for `incentive`/`unpaid`/`illegal` and only the two
label-only kinds are exempt. Each falsification was run with its constraint
dropped and each went red naming the actual value: `expected 1200 to be null`,
`expected 'Jane Doe' to be null`. A falsification that stays green is measuring
the mock.

**On the anonymous rows and the daily cap** — asked, answered, and written down
rather than assumed. The per-person cap simply cannot see them: it matches
`person_name = <string>` and in SQL nothing equals NULL. That is the correct
direction, not a gap. If floor rows _were_ visible, a stranger's walk-up would
silently consume a named collector's daily allowance and **under-pay them**. And
the cap cannot be dodged by omitting a name, because reaching that code requires
`kind = 'incentive'` and a nameless incentive row is refused. NULL is also the
**compliant** choice, not the convenient one: `person_name` is MRC Personal Data
(Exhibit I / ADR-0010) carrying breach-notification scope and a 10-business-day
deletion obligation, and a gate with no payout has no name to attach it to.

**The photo.** Columns on the row rather than a side table — one photo, always
present, is not a collection, and a CHECK cannot be written against another
table's absence. `photo_uploaded_by` is populated from row one, which is
ADR-0078 Am.1's lesson taken early: `load_photos` enforced who _may_ upload and
kept no record of who _did_, so all 85 rows drained yesterday carry
`uploaded_by IS NULL` and backfilling them would be inventing a name. A new
site-scoped mint endpoint rather than a widened `/api/photos/upload-url` — that
path held zero rows for months and was drained yesterday through three stacked
faults, and widening a hard-won working path is how it acquires a fourth. The
key it returns is re-checked against the site prefix on submit, because it
arrives from an iPad's IndexedDB days later and the constraint only cares that
it is non-null, not _which_ object it names.

**Offline, the blob and the units queue as ONE row** (queue schema v2 → v3) and
replay PUT-then-submit in that order, under the key minted at the operator's tap.
The photo key is deliberately **excluded** from the idempotency request hash: a
queued drop-off re-mints a fresh key because the presign expired, and hashing it
would make that replay look like key reuse and answer 409 — turning the
exactly-once fix into a louder bug, which is the identical trap
`/api/photos/confirm` records having hit. Pinned by a real-Postgres test that
replays with a changed photo key and asserts one row.

**No double-count.** The write touches `consumer_dropoffs` and nothing else — not
`inbound_loads`, not `processed_units_daily`. `onHand` already sums drop-off
units into the program pool with no `kind` filter, so the new kinds arrive with
no aggregation taught about them. The risk was never the enum; it was writing the
same mattresses into a second leg, since `onHand` adds both with no dedup. A day
carrying both a walk-up and a MyMRC-sourced **closed** processed row is asserted
to resolve to one row of each.

Born `pilot` on its own `ipad_dropoff` surface; the flag hides the page and the
hub card, the API is gated independently, and a bookmarked URL degrades to the
translated "not turned on yet" block rather than dying. EN/ES/UR.

**Rider, because infrastructure-as-scrollback is a defect.** The R2 bucket's CORS
policy was repaired by hand yesterday from a shell that has since closed. It is
now checked in — `infra/r2-cors.dr3-vision-photos.json` plus an idempotent apply
script with a `--check` diff and no token in it, naming where the credential
lives (the `cfat_` account-scoped one; the zone-scoped `api_token` 403s on every
R2 admin call). This ADR adds a second writer to that bucket, which makes "the
policy is whatever it currently happens to be" an answer that would reproduce
yesterday's zero-rows outage across two features instead of one.

**Found in passing, deliberately not fixed here:** `upsertProcessedUnits` writes
`source: 'manual'` on create only, so a human editing a day the MyMRC bridge
created leaves `source = 'mymrc'` and the next hourly run silently overwrites the
edit. That is a live defect in someone else's path; folding a fix into a drop-off
PR would hide it. Filed in `docs/OPEN-ITEMS.md`.

---

## 2026-08-08 — a saves column that pays, and a count you can take back (ADR-0083 + ADR-0084)

Phases 3 and 4 of the #205 floor handoff, one branch. Both are JT asks; both turned
out to be sitting on a live defect that did not fail loudly.

**Saves (ADR-0083).** JT: _"add a space for saves — they also get paid for every
mattress saved to sell — a dedicated saves field beside processed."_ A `saves`
column now sits next to `mattress_count` on the same bonus daily entry, under the
same amendment rules.

The pay basis is `mattress_count + saves`, tiered **once**. The alternative
everyone reaches for first — bonus each column separately — applies the 50-unit
threshold twice and pays **$0.00** for a 40-processed / 20-saved day. It does not
throw, does not warn, and would have meant "we added a saves column and nobody was
ever paid for a save" for every processor whose split straddled the threshold,
which is most of them. At 60/60 it under-pays by $36.50 in a single day for a
single person. All nine pay read paths now funnel through one `paid-units.ts`
definition, so the grid, the signed PDF, the sign-time lock and the reconcile
cannot disagree about what a paid unit is.

Saves are **paid** units, not **processed** units, and the difference is load-bearing:
the daily production report and the ADR-0071 throughput quota deliberately still read
`mattress_count` alone. A saved mattress was diverted to resale, not torn down, and
those production figures sit next to MRC billing. Two disjoint columns is what makes
the double-count structurally impossible rather than merely avoided.

**Two live bypasses were closed on the way in, each falsified RED against shipped code.**
The four-eyes prior-day gate compared `mattress_count` only, so a manager changing
_only_ the saves figure on a prior day computed `countChanged === false`, fell into
the `note_only_edit` branch, and wrote an unapproved change to somebody's pay — no
approver, no justification, nothing in the review queue. And the amendments endpoint's
zod schema listed `mattress_count` and `note`: zod strips unknown keys silently, so a
correctly-posted saves amendment would have had the field deleted at the edge, the
approver would have reviewed a change that never mentioned it, and the apply path
would have left saves untouched — a payroll correction that silently did not happen,
with a fully green audit trail saying it did.

The second falsification **corrected the test that was meant to catch it**. The first
draft asserted against a schema pasted into the test file, which would have stayed
green through any change to the real endpoint. That only came to light by actually
attempting the falsification. The schema now lives in `src/lib/bonus/amendment-schemas.ts`
and the route and its tests import the same one.

`NOT NULL DEFAULT 0` is a **true** zero, not a not-recorded modelled as one: no save
was ever paid before the column existed, so that is what the payroll record already
means. That truthfulness is what keeps every already-signed period at **zero reconcile
drift** — had it been nullable, or backfilled with anything else, every signed period
in the system would have reported drifted on its next PDF render, paged Bill URGENT,
and refused to produce payroll.

A save also becomes resale stock, as the **first-ever writer of `unit_status_movements`**
— a table that had sat in the schema with no writers at all. Movements are written as
**deltas** (10 keyed then corrected to 14 appends `+4`, not a second `+14`), a downward
correction reverses direction rather than recording negative units, and the row lands on
the same transaction as the entry. A save deliberately does **not** decrement the live
floor balance — Rick's model, binding: saved units stay physically on the floor until a
store transfer — and writes nothing to the three-writer `processed_units_daily`.

**Same-day count void (ADR-0084).** JT: _"if we accidentally entered the count twice, we
should be able to remove one."_ Re-scoped (G3) away from bonus entries, which was the
wrong target twice over: operators cannot reach the bonus grid at all, and
`@@unique(bonus_employee_id, entry_date)` makes a duplicate bonus entry structurally
impossible — a second write UPDATEs the row it would duplicate. The surface that
genuinely double-enters is the floor physical count, which is the inventory **anchor**:
a mistyped count does not produce a wrong count, it silently moves the entire floor.

Voiding is soft, never a delete, and same-day only in Pacific — a prior-day attempt is
refused and routed to the office. The filter is centralised rather than trusted to
diligence: a guard test reads the source off disk and fails the build if any
`siteInventorySnapshot` query appears without it, because a missed reader silently
anchors the floor on a count somebody took back.

**Verification.** `tsc --noEmit` clean; ESLint clean; the payroll-critical bonus suite
**658/658** and the inventory/audit suites green — all run **by hand**, because the husky
pre-push gate does not execute in a git worktree and a clean `git push` is therefore not
evidence it ran. Three falsifications were executed against shipped code and confirmed
RED before being restored.

## 2026-08-08 — the load nobody could reach, and the zero that was a tautology (ADR-0082)

JT, in the floor feedback: _"Whoever started the load has to be the one to close the
load … need to keep it open to somebody to close it in case 1st driver goes to
lunch."_

The first half of that sentence had been enforced since the dock workflow shipped,
**to the letter and past the point of usefulness.** `inbound_loads.assigned_operator_id`
already existed, already had an index, and was already stamped by `startInboundLoad` —
starting a load has always claimed it. `assertOwn` then refused every stage action from
anyone else. So nothing about this entry is a new claim mechanism. It is the three
things that were missing around one that was already there.

**The defect was silence, not failure.** `load/[id]/page.tsx` handled a second operator
with `redirect('/operator/<site>/queue')` and a comment saying a manager would sort it
out. What that produced on the floor is a loop with no message inside it: tap the load,
land on the queue, tap the load, land on the queue. Nothing errored, nothing logged, and
the holder's name appeared on **no screen on the device** — the queue listed only your
own open loads. The only way to find out what was happening was to ask the room.
`startInboundLoad`'s idempotent branch handed B **A's load id**, so B was redirected
_into_ the load and immediately bounced back out of it.

**What production was actually holding, measured this morning rather than assumed —
query published at `docs/queries/2026-08-08-open-dock-loads.sql` so it can be re-run and
argued with:** **9 open dock loads across 4 operators**, all Woodland, every one claimed
on an earlier Pacific day than the day of measurement, the oldest **2026-07-28 — eleven
days** — and one at `finished` carrying **148 units** counted and never submitted, so
outside inventory and billing. Every one of those was reachable only by the person who
had walked away from it.

"Open" is not "stranded", and the label must not do work the query cannot: `in_progress`
cannot distinguish an abandoned load from a truck being unloaded right now — the AGE of
the claim is what carries that, which is why the published query reports it. Two figures
in the first draft of this entry were wrong and are corrected here: it is **four**
holders, not five (the first count summed overlapping per-status distinct counts), and
the `finished` load's 148 units were omitted.

**And a number that lies if you quote it without its cause.** Across 40 submitted loads,
`submitted_by_id <> assigned_operator_id` **zero times**. That is not evidence that
handovers do not happen on this floor. It is evidence that the software made them
impossible to record: `assertOwn` refuses the submit, so the closer could only ever be
the claimer. The column was a tautology. It is now a measurement.

**Two atomicity guarantees, and the mechanism named for each — because "we wrapped it in
a transaction" would have read well and done nothing.** Postgres runs READ COMMITTED, so
two concurrent transactions both see the pre-state and both proceed; the serialisation
has to come from somewhere specific. Claiming is serialised by the **unique index** on
`expected_load_id`: the in-transaction re-read closes the common sequential window (A
committed seconds ago, B's page has not re-rendered) and a narrow `P2002` branch —
matched on `e.meta.target`, not a bare code — closes the concurrent one, where the loser
used to get a raw Prisma error out of a server action and a 500 in the log. Takeover is
serialised by **Postgres re-evaluating an UPDATE's WHERE after it unblocks**: the
re-stamp is a compare-and-swap on `assigned_operator_id`. Drop that one predicate and
two simultaneous takers both "succeed" and write **two audit rows each claiming to have
taken the load from A** — a false history in an append-only table, which is the exact
thing hard rule #6 and the `mergeEquipment` actor-context work exist to prevent.

**The audit tells the truth or it is not worth writing.** The actor is the person who
pressed the button, never a system label. `before` carries the outgoing operator _and_
their `assigned_at`, so the whole chain of custody survives even though the row only
holds the current holder. The row is written **inside** the transaction with `ip` and
`user_agent` — `load-service.ts` has historically written its audits afterwards on the
global client and dropped both, and that pattern was not copied. Taking over a load you
already hold writes **nothing at all**: re-stamping your own claim time for an action
that changed nothing would put an A→A row in the log that reads like a handover.

**One failure this feature created, found by looking for it.** Making claims movable
makes `assertOwn`'s 403 routine: A comes back from lunch to an iPad still on the counting
screen and taps +1. On the live path the stage components render `e.message`, and a
Server Action's throw arrives **redacted in production** — the reason is not unhelpful,
it is structurally unavailable. So the client now asks the one question it cannot answer
locally and, only if the claim moved, refreshes into the held-by panel, which names the
new holder. A blanket refresh was rejected: it would have swallowed genuine save
failures, trading an opaque message for no message. On the replay path the entry was
already parked correctly and never retried — but the conflicts screen said **"Your
sign-in expired before this was sent,"** which is false and sends the operator to
re-enter a PIN that cannot help. New code `conflict:load_taken_over`, matched _before_
the generic 403 branch; the ordering is the fix.

**The queue widened from your loads to the site's**, split by holder, which reverses
ADR-0065 Am.1's operator filter — and that filter existed _because_ the load page
redirected a non-assignee, so listing someone else's load would have rendered a link
that bounces. Removing the redirect removes the reason; what the filter did afterwards
was hide the nine loads that need a taker. The current-Pacific-day window on expected
hauls is untouched: that rule is about browsing, and an unfinished load is current work
whose timestamp happens to be in the past.

**Takeover is online-only, and that is a decision (D5).** It is not in `FLOOR_SCOPES` and
is never enqueued. A takeover is a contention action — replaying one hours later settles
a contest that is already over — and it captures no operator data, so refusing it offline
costs a tap where refusing a count costs a count. A test asserts its absence from the
allowlist, so "let's make this consistent" has to be deliberate.

**On the verification, since it is the reusable part.** Both race guards are falsified
against **real Postgres**, and both race tests are deterministic rather than hopeful: a
bare `Promise.all` is not a race test, because if the transactions happen to serialise
then both takeovers legitimately succeed and the suite passes just as happily with the
guard deleted. The interleave is forced with a third transaction holding
`SELECT … FOR UPDATE` on the contested row while both contenders finish reading and block
on writing. Removing the CAS predicate reds with _"expected […] to have a length of 1 but
got 2"_; removing the P2002 branch reds with _"Unique constraint failed on the fields:
(expected_load_id)"_; restoring the redirect reds with _"the load page redirects to the
queue again"_; moving the conflict reason behind the generic 403 reds on the byte offset.

**No migration.** The columns, the index and the `AuditAction` value all already existed.
Prefix `20260835` was assigned to this work and is deliberately unused — recorded so the
gap looks like a decision rather than a lost file.

**Amendment 1, same day, from review of the ADR rather than the code.** The panel
contradicted its own neighbour. `use-claim-loss-guard.ts` exists BECAUSE a Server
Action's throw is redacted in production — and two files away the takeover panel
recovered its error copy with `e.message.includes('load_claim_moved')`. Both cannot be
true. Since the redaction is real, that match could never fire live: `takeover.error_moved`
was **dead code in all three locales**, and every operator who lost a race saw the generic
"That did not go through. Try again." — a push back into a contest already settled, which
is the loop D5 declines to queue. It had no test, which is why it survived a review of the
diff and died on a review of the prose. Fixed structurally: the action now RETURNS a
discriminated outcome (return values are not redacted), so the panel switches on data and
the winner's NAME — which the service was already computing and throwing away inside an
error string — reaches the screen. A second test now pins the in-transaction placement of
both re-reads, which D1 and D2 assert and nothing checked: moving `tx.` to `prisma.` reads
fine in review and leaves every real-DB test green, because the compare-and-swap and the
unique index are write-side guards.

Docs: `docs/adr/0082-load-claim-takeover-and-honest-attribution.md`, `docs/adr/README.md`,
`README.md`, `CLAUDE.md` (ADR count 86 → 87), `docs/OPEN-ITEMS.md`,
`docs/queries/2026-08-08-open-dock-loads.sql`.

---

## 2026-08-08 — the day the photos landed: five merges, and a queue that had never once emptied (docs reconciliation)

No code shipped today. This entry is the capstone on 2026-08-07 — five PRs merged,
built, deployed and verified against production, final live SHA `1bbc8c3` — written
the morning after with the numbers re-measured rather than remembered.

**The arc.** `load_photos` had held **zero rows since the day the photo feature
shipped**. Not one. As of this morning it holds **85 photos across 34 loads**, and
nothing about the camera, the queue schema or the storage bucket was rewritten to
get there. Three separate faults were stacked on top of each other, each one hiding
the next, and each had to be pulled off in order:

1. **R2 CORS was never set.** Every browser upload died at the preflight — before
   any request reached the server, which is why nothing anywhere logged a failure.
   Hand-repaired via the Cloudflare API. `0 → 4`.
2. **A 307 to the login page counted as success.** `/api/*` answered an expired
   session with a redirect, and the queue read a 2xx-after-follow as "delivered"
   and dropped the row. ADR-0078 G7 makes those routes **401**. Silent loss became
   a visible conflict.
3. **The sweep was tied to a screen.** Draining only happened while the operator
   sat on the page that owned the queue. ADR-0078 lifts it to an app-level engine.
   `4 → 47`.

Then the wall nobody had modelled: JT drained to 47 and stopped, because
`requireOperatorOwnsLoad` demanded the load's **assigned operator** be the one
signed in. On a shared floor iPad that is not an edge case — it is the end of every
shift. Bill, mid-drain: _"we need to drain all users regardless of who is signed
in."_ ADR-0078 Amendment 1 scoped the gate to the **site** and started recording
`uploaded_by`, which is the trade stated plainly rather than dressed up as a
refactor: the gate loosened, and attribution went from none to recorded. `47 → 85`.

**About eighteen rows are still parked** on the device and want one more Retry-all.
All 85 rows carry `uploaded_by IS NULL` — every one predates the flip, and there is
no record of who took them. That column starts telling the truth with the next photo,
and backfilling it would be inventing a name.

**Alongside it, the machine got its history.** ADR-0079 Am.1 put the sheet era back
on the Terex chart as the floor's number; ADR-0081 replaced the estimate with the
workbook's own: **319 rows, 2025-01-02 → 2026-07-24, 44,663 units / 2,045.59 run
hours**, idempotency re-proven live. Two months refused to reconcile and the defect
turned out to be in the spreadsheet, not the reader — `March25` and `Dec25` publish
SUM ranges shorter than their own data. Widening the tolerance until they passed
would have taken roughly 19%; that is not a tolerance, it is a blindfold. And
`March25` day 29 reads 131.75 pocket coils, so it was **left unimported** — 319 rows
and not 320 — because 132 invents a quarter of a mattress and 131 discards one.
ADR-0080 landed the same day: discovery now states what it could and could not see,
and the commodity tracker was absorbed as audit **coverage**, because it carries no
money at all.

**On the discipline, since it is the reusable part.** Five PRs, five ADRs or
amendments, five CHANGELOG entries, one merge at a time with CI green on each — and
#214 deliberately held merge until the drain it enabled was observed clean rather
than merged on the strength of a passing suite. Two things that wave produced are
worth keeping: a renumbering (ADR-0078 → 0079) was accepted as its own PR rather
than smuggled into a feature branch, and three handoff premises were checked and
found **false** before being built on — the amendment workflow was never a reusable
house pattern, the commodity tracker holds no figures, and a tenant search is a
reachability probe and must never become the enumeration.

Docs reconciled: `docs/OPEN-ITEMS.md` (drain saga closed out, two sections
mis-numbered `0.AK` split, a spliced residual rewritten, rollout states re-read from
`rollout_surfaces`), `docs/adr/README.md`, `CLAUDE.md`, `docs/operator/rollout-gate.md`.
Every figure above was re-measured against production, not carried forward.

---

## 2026-08-07 — nineteen months of the machine's own numbers, off Janette's sheet (ADR-0081)

ADR-0079 Am.1 put the sheet era back on the Terex chart a few hours earlier — as the
**floor's** number, hatched, because that was the only pre-cutover figure Vision held.
It was never the only one that existed. Bill:

> _"use the excel sheet to pull in the historical data - then STARTING TODAY you will
> just take in the data that JT enters here but ALL OF THAT DATA needs to be
> aggregated and displayed IN THIS PAGE."_

Measured against the real R2 artifact — 490,670 bytes, sha256
`36308cbc54e6…cc14fa6b`, byte-identical to the stored `content_sha256`, fetched from
inside the cluster because the workstation has no R2 credentials:

```
sheets: 40 (2,080 rows)      allowlisted monthly tabs: 24 (Jan25 … Dec26)
importable rows: 319          duplicate dates: 0
date range: 2025-01-02 … 2026-07-24
skipped: 16 — 4 out_of_scope_2024 · 12 not_a_monthly_tab (incl. all three decoys)
```

### The sheet fights back in five ways

**There is no date column.** The day is a bare number in an _unlabeled_ column A; the
month and year live in the title row (`Terex Operating Data | July | 2026`). The date
is composed from a **cell**, never a row ordinal — an ordinal survives every tab that
starts on row 3 with day 1, then mis-dates everything after the first inserted line.

**Three decoy tabs wear byte-identical canonical headers** — `Aug25(1)`, `Template`,
`Template (2)`. `Aug25(1)` is a half-finished draft with real-looking operator notes,
an instructional `Example` row, end-hour readings in the day-hours column, and a total
of **3,683.95 hours in a month that has 744**. So tab selection is an explicit
24-name **allowlist**, cross-checked against the month and year the tab's own title
row claims — every pattern that admits the 24 real tabs also admits `Aug25(1)`, and
all three decoys say `MONTH`/`YEAR` literally.

Also: the 2024 tabs are four bespoke schemas (out of v1, named); units are three
columns summed (`Pocket coil` + `Springs` + `Wood`); and row counts vary 36–102, so
the data block is bounded by the day cells rather than by a count.

### Two months refused to reconcile, and the defect was in the workbook

R5 hard-stopped on `March25` and `Dec25`. Both are arithmetic errors in the source
spreadsheet:

```
March25  units SUM(B3:B30)/SUM(C3:C30)  ← stops at row 30
         hours SUM(G3:G33)               ← covers the whole block
         omits row 31 (day 29, 131.75 coils) + row 33 (day 31, 157 coils)
         published 1483 + 57 = 1540      extracted 1540 + 288.75 = 1828.75

Dec25    units SUM(B3:B32)  hours SUM(G3:G32)  ← BOTH stop at row 32
         omits row 33 (day 31) — 182 coils, 7.45 hours
         1675 + 182 = 1857        67.99 + 7.45 = 75.44
```

Hours reconciling **to the cent** on `March25` while units were out by exactly 288.75
is the tell. The fix: reconcile over the row range the workbook's **own SUM formula
declares**, parsed from the formula text. That is the true like-for-like question —
_did I read the same rows the same way Excel did?_ — and it is strictly **stronger**
than the whole-tab compare: a cell mis-read _inside_ the range still fails, and the
rows outside it are reported as a `coverageGap` finding rather than silently dropped.

**Rejected:** widening the ±0.5% tolerance until both passed. It would have needed
roughly **19%** — not a tolerance, a blindfold.

Two more findings, both filed for Bill/Janette: exactly one fractional-unit cell
exists workbook-wide (`March25` day 29 = **131.75** pocket coils against an INTEGER
column — skipped, never coerced, because 132 invents a quarter of a mattress and 131
discards one; that is why 319 rows and not 320), and `OVERVIEW2026` row 12 computes
July's "High" units/hour with **`MINIFS`**. The OVERVIEW bug is why OVERVIEW-derived
checks are advisory: a hard gate there would let the workbook's own bug block a
correct import.

### JT's entry is never overwritten — and the database is what says so

The history lands in `equipment_daily_throughput` behind a new `source` column
(`'manager' | 'workbook_import'`, DB-CHECKed), **not** a sibling table. A sibling
table puts the imported day outside ADR-0079's partial unique index
`(equipment_id, throughput_date) WHERE voided_at IS NULL`; both sources could then hold
the same day, nothing in the DB would object, and "JT wins" would degrade from a
constraint into a convention every read path has to remember — the identical failure
shape ADR-0079 D2 rejected for `equipment_events`.

```sql
ON CONFLICT ("equipment_id","throughput_date") WHERE "voided_at" IS NULL
DO UPDATE SET … WHERE "equipment_daily_throughput"."source" = 'workbook_import'
```

A read-then-write would be a **TOCTOU** — a manager saving that day between the SELECT
and the UPDATE would have their entry silently replaced by the sheet. The asymmetry is
the directive: the sheet cannot overwrite a manager, a manager overwrites the sheet.
History is a floor to build on, not a ceiling.

`import_version_id` carries **no** foreign key deliberately: `doc_source_versions`
cascades from `doc_sources`, so RESTRICT makes doc removal impossible for unguessable
reasons, CASCADE lets removing a document **delete production throughput**, and SET
NULL strips provenance off rows still claiming `source='workbook_import'`. A DB CHECK
pairs the two columns instead. Re-importing the same revision is a no-op; a newer
revision deletes and reinserts the import's own rows in one transaction, manager rows
untouched, never additive — a hard delete because an imported row is a _projection of
a document revision_, not a person's claim, and the batch is audited so the
supersession stays append-only. Actor is `system:workbook-import` with `created_by`
NULL (ADR-0036/0077 discipline). `processed_units_daily` is never written — there is
no code path, and a client-spy test proves it.

### The means now blend — this supersedes ADR-0079 Am.1 D10

**ADR-0081 supersedes Am.1's D10 era-purity rule ("means never blend across the era")
for the entered/workbook pair.** Am.1 was **right** to refuse blending: what it
refused to blend was the whole **floor's** output (1,000–1,250 units/day at Woodland)
with one **machine's** (a few hundred) — different physical quantities, so an average
across them describes nothing. The workbook figure is not that. It is the machine's
own units against the machine's own hour-meter hours, the identical measurement JT now
types into Vision, taken from the sheet Vision is replacing. **Like blends with like.**

`legacy_derived` is **still never blended**; `legacyMean7`/`legacyMean30` are unchanged
and remain a disjoint proxy-only series. Every blended mean carries its composition —
`"7-day mean — 5 sheet, 2 entered"` — so a blended figure is never shown without saying
what is in it. And units/run-hour is **real** on workbook days, because the sheet
carries true hour-meter hours; legacy days still get no rate (Am.1 §5 stands).

### The admin tile stops saying "Equipment" — without making a label lie

Bill: _"this tile is only for terex data - and in the admin area the tile STILL say
'Equipment' can you finally fix all of this please."_ Honoured, but `/admin/equipment`
is a genuine cross-site asset master — `listEquipment()` queries the whole `equipment`
table across **both** sites over all five categories (`vehicle forklift baler terex
other`) and it is the AP approver's fleet picker. So the `/admin` hub tile and the list
page title became **"Terex & equipment assets"** (leads with Terex, stays truthful
about the rest); the `/dashboard/[site]/equipment` launcher tile — which _is_
Terex-only — became simply **"Terex"**; the dead `equipment.navLink` key (zero
consumers) was deleted rather than renamed. `siteMachineLabel()`'s `'Equipment'`
fallback was **deliberately left alone**: it is site-derived, so a site with no Terex
keeps the generic name honestly instead of advertising a machine it does not have, and
it is load-bearing as a sentinel in three call sites. The dashboard page's description
(_"Throughput is derived from the daily processed-units close"_) was **false** after
ADR-0079 and is corrected.

Migration `20260833_adr0081_throughput_source` is purely additive and idempotent
(ADR-0035): two columns, two CHECKs, one partial index; every existing row becomes
`'manager'`, which is what all of them are.

## 2026-08-07 — discovery was under-reporting, and nothing could say so (ADR-0080)

`sharedWithMe` returned **one item on each of the 902 sweeps** since 2026-07-29.
Three documents were being watched. **Eleven were readable.** Every other layer of
this pipeline has a staleness guard — sweep freshness, subscription expiry, ctag
comparison, the loud zero — and discovery, the layer that decides what the
pipeline is even looking at, had none. So "we can see one document" and "one
document exists" rendered identically, which is the exact ADR-0057 D9 shape.

**Vision now compares what it can reach against what it is watching, every
scheduled sweep, and says the difference out loud** — on
`/admin/doc-ingest/health`, as a `discovery_gap` anomaly that NAMES the files, and
as a line in the 06:00 digest. First run reports a gap of **8**, including
`DR3 Machine List (2).xlsx` — an Outlook-attachment share that appears in no
enumeration route at all, yet resolves fine on a direct fetch. It was always
ingestable. It was never discoverable.

### Search is the probe. It is not, and will never be, the enumeration.

The plan was to move discovery onto the Search API, because search is the one
route that sees the missing file. Measured against the live tenant, unscoped
search returns **11,442 items** — the whole tenant, because Vision holds
`Sites.Read.All`. It answers "what can this identity read", not "what was shared
with it". Wiring discovery onto it would have Vision downloading and archiving
Night Shelter case-management packets and HR W-9 lists. That is not a feature
with a rough edge; it is an incident.

So search informs a human and never feeds the watch list. **Nothing is registered
automatically.** The probe is scoped to the tenant's personal-OneDrive host and to
spreadsheets — measured, that returns exactly the 11 documents of DR3's universe
and nothing else — and the **exact query string is stored with each scan and
rendered beside the counts**, because a number whose bound is unknown is not
evidence of anything.

### "We could not look" is not "there is nothing to see"

Three states, and only one is quiet: never scanned, scan failed, scan clean. A
failed probe recording a gap of zero would rebuild the illusion the whole change
exists to destroy, so `reachabilityGap` is `number | null` and the digest speaks
up for the first two. Same rule as ADR-0077's downtime and ADR-0076's headcount:
**not recorded is not zero.**

### The `sharedWithMe` sunset date was ours, not Microsoft's

Microsoft published "November, 2026" — a month, no day. The constant keeps
2026-11-01 as the conservative reading and now carries
`SHARED_WITH_ME_SUNSET_IS_INFERRED`, and the health page says so. Two further
findings, both load-bearing for the decision due before November: `/me/insights/shared`
— the obvious successor, and correctly scoped at 10 items — is deprecated on the
**same date** and can be silently switched off tenant-wide; and
`SharedWithUsersOWSUser`, the documented "shared with this person" narrowing,
returns **total = 0** against this tenant. Both legacy paths die together, no
replacement is announced, and the only survivor answers a wider question.

### The commodity tracker is not the document we thought it was

The "Woodland Data Auditing Tracker" was to be absorbed as commodity figures
cross-referenced against vendor invoices. Read against the live bytes, **it
carries no tonnage and no money.** It is an audit-_coverage_ matrix: which
commodity stream was audited in which month, by whom, when. Its stored
`parse_summary` had also detected the title banner as the header row, so the
existing detection does not resolve it.

Three requirements rested on the wrong premise and are recorded rather than
faked: nothing here touches `processed_units_daily` (workbook-sync remains its one
writer), the requested side-by-side against Vision's figures **is not buildable**
from a document with no figures, and preview-then-confirm stays — but because a
newly-understood layout must not silently become fact, not because of money. What
the document _does_ answer, and nothing previously could: the 2026
`DAILY LOG/MYMRC/SPREADSHEETS` stream — the audit of Vision's own numbers — is
unaudited.

The workbook also turned out to be **stacked** — several header blocks per sheet,
at different row _and_ column offsets, 12 commodity streams in 2026 and 9 in 2025
rather than the 7 and 6 the top block advertises. The first extractor read only
the top block and filed the lower blocks' months under the wrong streams: **60
duplicate `(stream, month)` pairs on one sheet, 36 on the other**, five streams
missing outright. Its unit tests were green, and the row TOTAL was identical
either way, so no count would have caught it. Running it against the real archived
bytes did. That check is now a permanent guard.

The new table is **version-scoped from its first row**, unique on
`(version, sheet, stream, month)`, with the double-count falsification pinned in
tests. ADR-0077's $231,203.82-for-a-$77,067.94-document lesson, applied before the
incident instead of after.

### The Terex cost residual, closed (ADR-0077 Amendment 3)

ADR-0077 fixed "not recorded ≠ zero" for downtime and **explicitly left cost**,
because cost is only _partly_ unpopulated — 7 of 68 events carry one — which read
as the weaker case. It is the stronger one. An all-null column eventually makes
somebody suspicious; a column that clearly works does not. `totalCostCents` summed
a series that drops null-cost events, so an unpriced window reduced to `0` and
rendered **`$0.00`** on the equipment tile and the ops-overview card: a machine
that had cost the organisation nothing.

It is `number | null` now, decided on the **events** rather than on a truthy sum,
and an absent cost reads "not recorded". **A real recorded `0` still reads
`$0.00`** — a warranty repair that genuinely cost nothing is a fact. Both
directions are pinned and both were falsified.

### Also

- COR month-end headcount showed `—` because it read
  `processed_units_daily.employees_count`/`processors_count`, **null on all 989
  production rows** and never written by any of their four write paths. It now
  derives the real figure from the payroll source (ADR-0076). A month with no
  entries is a real `0`; an uncomputable month stays `null`. `employeesCount`
  deliberately stays not-recorded — bonus entries cover processors only, and
  substituting one for the other would be a fabricated compliance figure.

## 2026-08-07 — drain regardless of who is signed in (ADR-0078 Amendment 1)

The drain worked. `load_photos` went from **zero rows, ever** to **47 across 20
loads** in under two hours — and then hit a wall that was ours.

`requireOperatorOwnsLoad` required the signed-in operator to BE the load's
assigned operator, so a photo queued by one operator could not be confirmed while
another was signed in. On a shared floor iPad that is not an edge case, it is the
normal end of a shift. Bill, watching it stall at 47/103: _"we need to drain all
users regardless of who is signed in... let's just not have this have to be a
issue in the future."_

**The gate is now the SITE, not the load's owner** — `requireOperatorAtLoadSite`,
renamed with the behaviour so nobody later mistakes the removed check for an
oversight and restores it.

**The trade, stated plainly: the gate loosened from owner to site; attribution
went from none to recorded.** An operator can now attach a photo to any load at
their own site. In exchange the evidence survives — photo blobs live in ONE
iPad's IndexedDB and a permanently parked row is evidence that dies when that
device is wiped. And `load_photos` now carries `uploaded_by` on every confirm,
where before it had no uploader column at all: the strict gate enforced who was
_allowed_ to upload and then kept no record of who _did_. Accountability is
strictly better after this change than before it.

**Cross-site is still refused** — Eugene and Woodland are separate MRC contracts
in separate jurisdictions, and with the owner check gone that is the only control
left, so it is the falsification this amendment turns on. Deleting the site check
by hand: `a Eugene operator reached a Woodland load: expected 200 to be 403`.

**Mint and confirm moved together, mandatorily.** Relaxing the mint alone would
have been worse than doing nothing: presigned URL granted, bytes PUT to R2, row
refused — an orphaned object, no record, and a queue entry that still cannot
drain. Reverting confirm's guard alone: `confirm refused a principal that mint
accepts: expected 403 to be 200`.

**The audit row marks the exception, not every upload** (ADR-0037). A row per
confirm would add ~100/day of "operator did the thing they were assigned to do"
and bury the case a person would actually go looking for. Forcing one on every
confirm: `an audit row per confirm buries the exceptional case`.

**`uploaded_by` is not backfilled.** The 47 existing rows have a genuinely
unknown uploader; inferring it from `assigned_operator_id` would look tidy and
would be a fabrication about a named person in a table that feeds billing
evidence. NULL means "we do not know" — the same choice as ADR-0077's "not
recorded" over a fake `0.0`.

## 2026-08-07 — the history stayed after all (ADR-0079 Amendment 1)

The cutover shipped a few hours earlier applied "entered replaces derived" to
**all of history**, so the Terex page went blank. Bill: _"that should have all
stayed and just been added to."_ He is right. Measured against production:

```
WINDOW 90d : entered=0/90 days | derived AVAILABLE=67/90 days
90d window: 67 days carry a derived figure that is currently RENDERED BLANK.
derived range in window: 415 .. 1249
```

989 close-days exist at Woodland going back to 2023-01-02. **No data was lost** —
`derivedFloorUnits` was computed throughout; this was display semantics only.

Worth naming: the original ADR _predicted_ this ("on the day this ships, every day
reads 'not recorded'") and called it the visible signature of the fix. Predicting
a consequence is not the same as validating it. Nobody checked whether a blank
history was what Bill wanted.

### The boundary is a constant, and history is labeled rather than hidden

`TEREX_CAPTURE_CUTOVER_ISO = '2026-08-07'`. Before it, the sheet era; from it on,
the capture era. **Deliberately never derived from the data** — a
"first-entered-day" boundary would move the moment anyone backfills, so one
manager entering 2026-07-15 would blank a month of chart as a side effect of a
single entry.

Every day now carries `source: 'entered' | 'legacy_derived' | 'not_recorded'`.
Pre-cutover days render the floor figure **labeled**; post-cutover gaps stay
loudly "not recorded" and are _never_ backfilled from the floor; and **entered
always wins on both sides of the boundary** — a backfill has replaced the floor's
guess with the machine's real number, which is exactly "just be added to".

### The label is structural, not tonal

Legacy bars are hollow — hatched fill, dashed outline. Entered bars are solid.
**Solid always means entered.** Tone was rejected as the carrier: a lighter green
does not survive a projector, a screenshot, a colour-blind reader, or a print-out.
Plus an always-visible legend whenever legacy bars render (not a tooltip — a
reader who never touches the chart must still be told) and a per-bar title reading
`floor-wide total, not Terex-specific (legacy)`.

The axis fix is the literal bug: `maxUnits` scaled off `unitsDay` alone, so with
zero entered days it collapsed to `1`. It scales to what is drawn.

### Means never blend across the era

`mean7`/`mean30` and the tile stay **entered-only, unchanged**; `legacyMean7`/
`legacyMean30` are separate fields over legacy days only, and stop at the
boundary. The eras measure different things — the whole floor (1,000–1,250/day)
versus one machine (a few hundred) — so a straddling average describes nothing
while sitting on the machine's line. In the seven-day straddle test the forbidden
blend is **701.28**, asserted absent from every mean field on every day.

The tiles were deliberately not widened: a single number has nowhere to carry the
label, and "7-day units/day: 1,063" would be a bare claim about the machine, wrong
by ~5×. They disclose coverage instead — "1 of 7 days recorded". Legacy days still
get **no** units-per-hour: reviving the assumed-8h rate, even labeled, would
publish a fabricated denominator.

### The falsification

Deleting the source branch in the bar renderer goes red naming the leak:

```
AssertionError: expected '<rect data-testid="bar-2026-07-20" da…'
                to contain 'fill="url(#legacyHatch)"'
Received: "<rect ... data-source="legacy_derived" ... fill="#8fbf3f" ...>"
```

A bar tagged `legacy_derived` wearing the entered fill — the unlabeled leak, named
concretely rather than as a missing field.

**Verified against production:** 67 legacy days restored; July days draw
1,158–1,249 with `unitsDay` still null (not laundered) and rate still null; the
post-cutover day stays `not_recorded`; no day carries both means. Rejected and
recorded: labeled backfill into the machine's table (permanent conflation risk +
would weaken `run_hours NOT NULL`), and a dual-series peer view (filed as the
future reconciliation view, not built).

## 2026-08-07 — the iPad stops losing work, and starts saying when it can't (ADR-0078)

JT asked for one thing: _"make sure the connection isn't dropping … error-free
and bulletproof for the iPad."_ The audit found the reliability layer ADR-0006
describes was, in several places, **not connected to anything.**

**`enqueueAction` had zero callers, and `replayAll` was POSTing to
`/api/queue/replay` — a route that did not exist.** Next answered 404, the
queue's hard-4xx branch classified that as a permanent conflict, and conflicts
are never retried. Every queued action would have been stuck on its first
attempt, forever, with nothing surfacing it to anyone. The blast radius was zero
only because the other end was equally unwired; fixing one without the other
would have turned a dormant bug into a live one.

**A count typed on a dropping connection was discarded.** `inbound`, `processed`
and `count` all had a bare `catch { setError(…) }` and no queue import at all.
The operator's work survived as a sentence telling them to type it again from
memory. All three now queue, and — this is the part that matters — a queued entry
shows a state that is visually distinct from Saved. Green means server-acked.
Always.

### The anchor was chosen by the query planner

`site_inventory_snapshots` had no tiebreaker, and the floor route stores every
count at **Pacific midnight** — so two counts on the same day are byte-identical
in `snapshot_at`. Both anchor selectors ordered by that column alone. Which count
became the inventory anchor, the number every downstream balance is computed
forward from, was left to whatever the planner felt like.

Production has not been bitten: two physical snapshots exist, on different days,
and the duplicate-instant query returns zero groups. But **`ipad_count` is LIVE
at both sites**, so a second count on any single day reached this today. A
`created_at` column now breaks the tie on the recorded insertion instant — the
count entered LAST wins — and existing rows backfill to their own `snapshot_at`,
which makes the tiebreaker a strict no-op for every row that already existed.
Pinned across 20 runs; reverting the `orderBy` returns **111 where 999 is
correct**.

### Exactly-once, claimed inside the write's own transaction

Every floor write now carries a client-minted key, claimed with
`INSERT … ON CONFLICT (key) DO NOTHING` **in the same transaction as the business
write**. Both failure directions explain why that is not negotiable: a claim that
commits without its write burns the key and answers the retry with success for a
count that vanished; a write that commits without its claim simply has no
defence. Removing the claim's gate produces `[ 'wrote', 'wrote' ]` — two writes,
the real defect.

A replay is pinned to its original **actor, scope and payload hash**. A key is a
bearer string, and "unguessable" is a probability where an owner check is a fact.

**A double-tap was a lie in both directions.** The unique index on
`(load_id, stack_index)` correctly refused the second insert — and the UI
rendered that refusal as "couldn't save" for a write that had landed, so the
operator's natural next move is to re-enter a count that already exists. Same for
Finish: retrying after a successful commit hit an illegal-transition error for
the one thing that definitely worked.

### Two live incidents, mid-build — the same class this ADR exists to close

**`load_photos` held ZERO rows. Ever.** Every browser upload since the feature
shipped had failed the CORS preflight against the R2 bucket (403 — no CORS rule
existed). One iPad had silently accumulated 97 photos. The server could not see
it, because a request that dies at the preflight never arrives. On the device, a
blocked preflight is an opaque `TypeError` — **byte-identical** to the one an
offline device throws — so the queue called it "offline" and retried patiently
for weeks. Fixed in infrastructure (preflight now 204).

**And the parked rows still would not drain.** Any re-mint 4xx was flagged
`conflict:` and then skipped by every future sweep, with nothing in the shipped
app able to see or clear the flag. Photos queued against a load owned by a
_different_ operator login get 403 on re-mint and park permanently — while still
being counted as pending. The device read **99-and-not-draining**.

Both now have names. `blocked:` is distinct from offline and is inferred from
evidence we already have: if the mint (our endpoint) succeeded and the PUT died
at the network layer, the device demonstrably reaches the app and not storage.
The badge counts what is still **trying**, separately from what is parked,
because a number that sits at 99 across shifts teaches operators that the number
means nothing. And every conflict now has a screen, a plain-language reason, and
two honest buttons: **Retry** (which also discards the cached presign — a
weeks-old URL would 403 the entire opening of the drain) and **Discard**, audited
server-side _before_ the local row is removed, because a refused entry exists
nowhere else.

### Connection state, on every screen

One hook, one component, mounted once in `FloorChrome` — so it is on all
operator screens by construction, and a filesystem-enumerated test keeps it that
way. It replaces two near-identical sweep loops that had grown on separate
screens (the queue drained on the load workflow and merely _displayed_ on the
queue page) and neither of which showed connection state at all.

`navigator.onLine` is not trusted on its own: on iPadOS it reports whether an
interface exists, not whether anything is reachable, so an iPad on an access
point with a dead uplink reports `true` — which is precisely JT's complaint. Each
sweep also pings the app itself.

### Notes

- **The day pin refuses; it never retargets and never drops.** A replayed entry
  for a day that is no longer today is held for a person. Both silent
  alternatives are money errors: retargeting files a count against the wrong
  production day, dropping loses the work.
- **A day-addressed replay carrying NO day is now refused, not exempted.** The
  earlier `if (day !== null)` shape let an old-format entry skip the pin
  entirely — through the one path with no operator watching it.
- **`countDate` is optional in the schema on purpose.** The iPads are kiosks
  whose service worker does not `skipWaiting`, so the previous bundle persists
  until someone accepts the update prompt — and it sends no `countDate`.
  Requiring it would have 422'd every count at **both sites** for the whole
  update window: an outage caused by the reliability fix. The live route defaults
  it (behaviour-identical to before) and logs when it did; the replay path
  refuses instead, because "now" is not a queued entry's day.
- **Legacy queued photos get a key during the IndexedDB upgrade.** Without that,
  the duplicate-confirm fix would have had a hole shaped exactly like the bug,
  for precisely the ~99 rows it was built for. v1 rows are never dropped: uploads
  keep their blobs, undispatchable v1 actions are flagged rather than deleted.
- **Badge counts are answered from an indexed `state` scalar.** Counting by
  scanning records deserialises every queued photo Blob — hundreds of
  multi-megabyte reads per minute, on the single tab holding data that exists
  nowhere else, to render a number.
- **Typed errors.** `assertOwn` / `ctx` threw bare `Error`s that
  `loadsErrorResponse` cannot map, so "this load isn't yours" was reported as a
  500 — wrong for the operator, wrong severity in the log, and buried in the 500
  rate.
- **R2 bucket CORS is hand-set infrastructure, not code.** Recorded in
  OPEN-ITEMS; it is currently reproducible only from a shell history.
- **CI's `migrations` job asserted nothing.** It stood up a real Postgres 16,
  applied the whole chain, and threw the database away. It now runs the real-DB
  suites against it — because the core claims here are claims about Postgres, and
  a mocked Prisma would have been enforcing the very rules the tests check.
- **One falsification came back GREEN and that was the most useful result.** The
  double-tap test, written with a single shared key, passed with the P2002
  tolerance deleted: `withIdempotency` short-circuits before the insert, so the
  assertion was measuring the idempotency path and not the constraint path it
  named. Rewritten with two keys — which is what a real double-tap mints — it
  goes red with the actual unique-constraint violation.

### The drain now happens no matter what screen you're on

Bill, mid-build: _"drain should happen no matter what page its on and it should
make sure all data is always pushed down - not as an afterthought."_ Replay used
to live inside screens — the load workflow ran a sweep, the queue page ran a
different one, every other screen ran none — so whether a queued count went
anywhere depended on which page an operator happened to be looking at. There is
now ONE engine, mounted above all nine screens, triggered on mount, `online`,
tab-visible, BFCache `pageshow`, a foreground-only 30s interval, **and
immediately after every enqueue** — which is what makes the queue a retry path
instead of a waiting room. `replayAll` has exactly one caller in app code, and a
test greps the source to keep it that way.

Background Sync is registered where it exists and is a **no-op on iOS**, because
WebKit has never shipped it. Stated plainly rather than implied: on an iPad the
queue drains whenever the app is open on any screen and resumes the instant it
is foregrounded; there is no closed-app execution.

### The auth redirect that looked like success

The primary blocker of the 99-photo drain, and it never looked like a bug.
Operator sessions idle out after five minutes and `/api/photos/*` is not public,
so a session-less replay got `307 → /login`; fetch follows redirects, /login
returns **200 text/html**, and `res.ok` was true. The mint "succeeded", parsing
the login page as JSON threw a SyntaxError, and that became a generic _retryable,
unlabelled_ error. The R2 PUT was never reached. This is the ADR-0036 class that
bit the reminder-tick in July, arriving through the photo queue.

The middleware now answers `/api/*` with **401 JSON** (page navigations keep
their redirect — sending a person to /login is what it is for), and every queue
fetch uses `redirect: 'manual'` and treats a redirect, a 401, or a 2xx carrying
HTML as an expired session. That is its own class, deliberately not a conflict:
nothing needs adjudicating, somebody needs to sign in. The badge says so and
carries a return path.

### And a second review caught the fix reversing the fix

The G8 refactor nearly turned the offline badge green again. `replayAll`
early-returns a fully-formed result when the device is offline, and the new
observer read "a result with no auth and no blocked rows" as a successful sync —
so one engine trigger would repaint a red badge green and stamp a "last sent"
time for a sweep that never left the device. A sweep now reports whether it
actually **reached** the server: `false` when nothing got through, `true` when
something answered (a 409 counts — reachability and success are different
questions), and `null` when nothing was attempted, because an empty queue is no
evidence and must not be read as health.

Also from that pass: signing back in now RETURNS the operator to the screen they
were on, validated against an open redirect (`//evil.example` is
protocol-relative and navigates off-site despite starting with a slash — the
exact bypass a naive `startsWith('/')` check misses); a capture made _during_ a
long drain no longer waits for the next tick; and the middleware's 401 was
verified not to touch `/api/auth/*`, which is how the PIN keypad signs anyone in
at all.

### The review caught three of these in the fix itself

An adversarial pass before merge found three defects **of the same class this
change is about** — a billed count vanishing while the UI says saved — all three
introduced by the fix. `addStack`'s duplicate-tolerance absorbed a genuinely
different stack at a colliding index (it keyed off "a key was present", never off
whether the existing row _is_ this write); a queued stack could land after Finish
with `total_units` never recomputed; and _Re-submit to today_ would have
**overwritten** today's confirmed inbound with a stale day's number, because that
write is an absolute SET on the day key. All three are fixed and pinned. Two more
would have defeated the feature quietly: the service worker cached `/healthz`, so
the reachability ping would have returned a cached 200 on a dead uplink and shown
green; and every Retry on a Tier-2 count minted another manager hold.

### Premises that died on checking

- **"Add `conflicts` to `WORK_SEGMENTS` or the page renders black."** False as
  built: `resolveFloorNav` keys on the _second_ path segment and the screen nests
  under `/queue`, so it inherits back and Log Out untouched. Pinned by a test.
- **"The locale-parity test enforces EN/ES/UR."** Both a runtime test _and_ a
  compile-time `Widen<T>` do; a missing key fails `tsc` before any test runs.
- **"ADR-0012 §4 — no new deps."** ADR-0012 §4 is the `next-pwa` → Serwist swap
  and imposes no dependency freeze. `offline-queue.ts` has been citing a
  constraint that does not exist.

## 2026-08-07 — the Terex number is entered now, not inferred (ADR-0079)

The Terex's throughput has been the **whole floor's output wearing one machine's
name**. ADR-0044 D2 computed it as `stripped_program + stripped_non_program` and
reasoned that throughput "needs NO new capture". The reasoning was careful and the
premise was wrong: that is not a second artifact of the same fact, it is a
different fact. On 2026-08-06 the "Terex" processed **1,063 units** — 769 program
plus 294 non-program — which is every machine and every hand-stripper on the
floor. **A manager now enters the number, daily, and that entry is the throughput.**

**Run hours are entered with it, and that is the half that matters.** Units-per-hour
divided by `assumed_day_hours − hours_down`, where `assumed_day_hours` is a
constant equal to 8 and `hours_down` is — per ADR-0077 — `NULL` on all 67
non-voided Terex events ever written. So the rate was not merely assumed against a
guess; it returned `null` on every real production day. It means something now.

### A day nobody entered says so

`unitsDay` is `null` on an unrecorded day and renders **"not recorded"** — on the
equipment tiles and on both ops-overview throughput cards, which previously showed
`—`. Never `0`, never the floor total. Two of the three possible behaviours here
look entirely reasonable on screen: a `0` makes a working machine look broken, and
a silent fall-back to the floor number makes it look like a hero while the office
believes a figure nobody entered.

The guard was **falsified before being trusted**. The derived fallback was wired
back in deliberately and the suite re-run; three tests went red naming the real
wrong value:

```
AssertionError: expected 1063 to be null
- Expected:  null
+ Received:  1063
```

`1063` — the actual Woodland floor total — not an `undefined` that would only have
proved a field was missing. The fixtures carry production magnitudes for exactly
this reason.

**On the day this ships, every day reads "not recorded"** until the first manager
entry. That is the visible signature of the fix, not a regression.

### A dedicated table, because three queries would have swallowed it

The obvious home was a sixth `equipment_events` kind. Three read paths query that
table with **no kind filter** and would have absorbed a daily row: the tile's
`findFirst` (a row written every working day becomes "the LAST equipment event"
forever, burying the downtime the tile exists to show), `listEquipmentEvents`
(~250 rows/yr flooding the maintenance log), and the Terex ledger — which selects
`hours_down` with no kind filter and sums it into `downtime.totalHours`.

That last one is the sharp edge. Carrying run hours in `hours_down` — the tempting
reuse — would report **the hours the machine RAN as the hours it was DOWN**:
ADR-0077's defect inverted and worse, because it manufactures a measurement rather
than mis-rendering a missing one. `run_hours` and `hours_down` are now in
different tables so no query can ever confuse them.

`equipment_events` also has no equipment FK at all (`equipment_code` is free
text), so "unique per machine per day" was not expressible there. The new table
takes a real FK and the ADR-0077 identity rule resolves it — category **plus** AP
links, because the ADR-0062 seed uses `terex` as the category for shear machines
and production carries five such rows. `7e35a4aa` appears nowhere in the source.

The unique index is **partial** (`WHERE voided_at IS NULL`) so a mistaken entry can
be voided and the day re-entered. Its key columns are both `NOT NULL` — only the
predicate is nullable, which is the difference between an index that constrains
and one that constrains nothing. Proved by insertion against a real PG16, not by
reading the DDL: the duplicate raised, the void released the day, `run_hours` of
`0` and `25` were refused, `-1` units was refused, a recorded `0` was accepted, and
the machine could not be deleted out from under a recorded day.

### The amendment workflow could not be reused, and the handoff's premise was wrong

Same-day entry and edit are free and audited. A **prior day is refused** with
`409 requires_amendment` and an honest message routing the manager to the office.

The plan was to route prior-day edits through the bonus amendment workflow. It
cannot be: `resolveAmendmentApprover` sources the approver from
`bonus_signature_chains` — the payroll signature roster — and **throws a 403 for
anyone who is not a bonus payroll signer.** A Woodland equipment manager is not
necessarily one, so reuse would hand the exact audience this feature exists for a
403 they could do nothing about. The table also carries two `NOT NULL` FKs to
bonus tables with no polymorphic targeting, and `applyApprovalInTx` writes
`bonusDailyEntry` literally.

The handoff described this as "the third surface to inherit that pattern". **There
is exactly one consumer.** `processed_units_daily` — the presumed second — uses a
_lock_, not a four-eyes gate. The ~40 files mentioning "amendment" are
overwhelmingly ADR-revision naming. Rather than fork a parallel approval system
for one field, the gap is reported as OPEN-ITEMS **F-2** with the smallest
generalization proposed.

### Notes

- The derived number is **retained and still computed** as a latent cross-check
  (`derivedFloorUnits`, and the exported `legacyDerivedUnitsPerRunHour`). It is
  never shown as a competing throughput figure; the CSV column is named
  `derived_floor_units_all_sources`, because a column called `units_day` would
  re-tell the lie the tile used to tell. **No divergence rules in v1** — that
  needs a rule, and the rule is reconciliation-layer work.
- The entry control rides the existing `equipment_entry` surface (live at
  Woodland), not a new born-pilot gate. The audience is identical to the one
  already entering equipment events on that screen; a new gate would have hidden
  the sheet's replacement from the managers being asked to stop using the sheet.
- Eugene is untouched: zero `equipment_events`, zero `processed_units_daily`.
- Migration `20260831_adr0079_equipment_daily_throughput` is purely additive. **No
  history was backfilled from the derived series** — every backfilled day would be
  a fabricated manager entry, indistinguishable from a real one, in the one table
  whose whole point is that the number is authoritative.

## 2026-08-06 — one Terex, and the downtime that was never there (ADR-0077)

Woodland had three records for one machine. It has one now — `7e35a4aa`,
`Terex`, category `terex` — and the two duplicates are deactivated, stamped
with the survivor's id, and kept, because their invoice links are
financial-approval evidence.

**Four links moved onto one row and the money did not change: 202,492 cents
before, 202,492 cents after.** Measured with
`COALESCE(confirmed_amount_cents, amount_cents)` — all four of these invoices
carry their money in the confirmed column with `amount_cents` NULL, so a ledger
reading `amount_cents` alone reports zero and proves the conservation of
nothing. All four resolved equipment requests followed.

OPEN-ITEMS **O-10 had the direction backwards**, and the reason is a property of
the merge: a merged-away row **keeps its name**. Merging into `Terex Machine`
would have left the survivor permanently called that, with the name Bill wants
frozen on a dead row the unique index then forbids anyone from reusing. The
rename everybody assumed would follow the merge was never on the table.

### The machine nobody ever measured

Bill asked how long the Terex has been down. **The workbook does not record it.**
All 40 sheets swept: no downtime column, no days-down, no synonym. The
maintenance-log header is `Date · Time · Issue · Measures taken · Estimated
repair time/cost · Estimated cost · Notes · Actual Repair Cost · Amount
Credited`, and `Estimated repair time/cost` sums to **2** across ~90 populated
rows because it holds things like "2 weeks". The ADR-0048 importer recorded
`downtime: null`. `equipment_events.hours_down` is NULL on all 68 Terex rows —
the column has never once been written.

The tile summed that to `0`, showed **"0.0 hrs"**, and the ops-overview card
painted it **green**. An unmeasured machine was being displayed as a flawless
one. Absence now says so: `totalDowntimeHours` is `number | null` and renders
**"not recorded"** in a neutral tone — the same rule the TEREX preview screen
already states in words about money. A recorded zero is still a zero; both
directions are pinned, and the null branch was falsified before being trusted.

The monthly tabs do carry `Day Total Hrs Used` — hours the machine **ran**, on
sheets where workbook-sync is the sole writer. Not downtime, and not going to be
invented into it.

### A write with no human behind it says so

The merge had no signed-in admin: `requireAdmin()` gates the button, and this
ran from a script under Bill's written instruction (PR #197). The shortcut was to
stamp his `users.id`, which writes a false claim into an append-only table that
hard rule #6 means we can never take back. `mergeEquipment` and `updateEquipment`
now take `ActorContext | SystemActorContext`, mirroring ADR-0036's `SystemActor`:
`actor_label` set, `actor_user_id` and `merged_by` NULL. The HTTP routes are
unchanged — both still require an admin session.

### Notes

- **The TEREX absorption is not blocked by what we thought.** The handoff named
  "the ADR-0072 guardrail"; ADR-0072 is the iPad anchor guardrail, and the
  doc-ingest one (ADR-0067 D6/D7) turns out to be flagging a parse _improvement_:
  the previous revision had no `headerRowIndex` at all and read each sheet's
  title banner as its header row. The ~92 "removed columns" are those banners
  disappearing. On the two sheets absorption reads, the only removal is
  `TEREX MACHINE MAINTENANCE LOG` itself.
- **The real blocker was that `TEREX.xlsx` had never been classified** —
  `doc_class` and `site_id` were both NULL on the source row, so `absorbVersion`
  refused at Gates 1 and 2. That is why `doc_terex_maintenance_rows` held 0 rows
  despite two revisions having been applied on 2026-07-29. **RESOLVED the same
  day** — Bill ordered it classified and accepted; see the absorption entry above.
  The figure that was pinned and waiting is the figure that landed: `77,067.94`
  repair and `4,025.36` credited, identical on both sheets because the 2025 one is
  a strict subset (absorb both without `dedup_key` and it reports $154,135.88,
  exactly double).

### One machine, one page — shipped dark

`/dashboard/<site>/equipment/<id>` is the Terex's whole story: every invoice
tagged to it, its maintenance log, and its downtime. A **detail view under** the
existing equipment tile, reached from it — not a parallel tile — with one
cross-link from `/admin/equipment` (which says what a thing _is_) to the ledger
(which says what it has _cost_).

It ships **born pilot**: admin-only until Bill flips `equipment_terex_ledger`.
Two of its three panels are live right now — four invoices totalling **$2,024.92**
on the newly-canonical record, and downtime honestly reading "not recorded". The
third waits on the classification below and **says so in words** rather than
rendering blank: _"an empty inbox, not a machine that has never needed a repair."_

**Nothing is joined that is not actually joined.** All four invoices are the same
vendor within six days, so matching them to individual repairs by date or amount
would invent connections rather than find them. The two lists sit side by side
with the absence stated out loud. The `linked <= total` invariant is asserted
anyway — trivially true at zero — so the guard is already there the day matching
arrives.

**Who sees it:** admin, or a manager holding `can_resolve_equipment_requests`
with reach to the machine's site — exactly Bill, Morena and Janette. Three more
obvious gates were rejected and are now pinned as negative tests: `role ==
manager` + reach admits Daven and Kelsey through `all_sites`; the `ap_approvers`
roster admits Shannon; and matching people by **name** walks into the
duplicate-account trap (a second, inactive "Bill Barnard" row exists). The flag is
read fresh from Postgres every request, and site reach comes from the **equipment
row**, not the URL.

**The math is pinned, and the pins were made to fail on purpose.** $77,067.94
repair / $4,025.36 credited / 202,492 cents AP / downtime-null-not-zero /
linked ≤ total. The fixture leaves the subset-sheet rows in the table as `staged`,
so deleting the confirmed-only filter does not fail for the boring reason — it
makes the total read exactly **15413588**, the real double-count. Reading
`amount_cents` instead of the confirmed column drops the AP total to **+0**. Both
reds were produced deliberately before the guards were trusted.

- **Read-only.** No new writer to any production table; the API route is GET and
  has no write verb.
- **"The Terex operates exclusively at Woodland" turned out to be a code fix, not
  just a fact.** Bill said it; the registry did not agree. `category: 'terex'` is
  the ADR-0062 seed's category for **shear machines**, so five rows carry it —
  `EQ24/EQ43/EQ74 — Shear Machine` at Woodland and `EQ65 — Sheer Machine Shear
Machine` at **Eugene** — and only one is the machine. Since the maintenance log
  is keyed by SITE and the events by a free-text code, opening the ledger on any
  of those four would have shown the Terex's money and history under a shear
  machine's name. The ledger now refuses a row unless the Terex invoices resolve
  to it, and both cross-links use the same rule. Pinned by tests naming the real
  Eugene row; falsified by dropping the invoice half of the check.

### The workbook is absorbed, accepted, and live — and it tried to count itself three times

Bill: _"you need to classify and accept everything."_ Done. `TEREX.xlsx` is
registered as a `terex_maintenance_log` at Woodland, its newest revision applied
and absorbed, and **80 maintenance rows accepted at $77,067.94 repair /
$4,025.36 credited** — matching ADR-0069 Am.2 to the cent.

It did not go as scripted, and that is the useful part. **Registering the source
made all three applied revisions absorbable at once**, so the sweep took all
three: 240 staged rows, **$231,203.82** — exactly 3 × $77,067.94.

The absorber was not wrong. Per revision it is perfect, and the subset-sheet
de-duplication is visibly working inside each one (55 rows from the 2025 sheet
carry every dollar; the 2026 sheet adds only its 25 non-duplicate rows, all
costless). That de-duplication is **within** a version — the unique key is
`(version, sheet, row)`, so two confirmed revisions of one document coexist by
design. What would have been wrong is the **ledger**, which summed every
confirmed row for the site.

So the two superseded revisions were **discarded** — through the same audited
decision path as an accept, each recording the $77,067.94 it was worth — and
`computeTerexLedger` is now **version-scoped**: newest absorption wins. The
second fix is the one that matters, and the tests say so by leaving all three
revisions confirmed in the fixture. A total that is only right when somebody
remembered to tidy up is not a guarantee. Removing the version filter turns it
red at `expected 23120382 to be 7706794`.

**The hard stop is why this was caught at all.** The one-off refuses to accept
anything unless the staged batch reads to the cent, and its read-only `check`
step must be run and read before `accept`. A wrong number here does not stay a
wrong number — it becomes accepted money.

**The ledger is LIVE at Woodland.** Eugene stays `pilot` permanently, and its row
stays: an _unregistered_ surface resolves to admin-only through a caught
exception, so deleting the row would make a deliberate "no" look like a lookup
that quietly failed.

### What "Estimated repair time/cost" actually contained

Every distinct value in the column, now that the rows exist:

```
Unknown - more than a week, less than a month
unknown
unknown, but 'soon'
```

Not one is a duration. The downtime verdict is stronger than it was written: the
column does not merely fail to be _reliable_ downtime — it holds **no time
information at all**. The as-written rendering needed no change.

Two more live figures the rendering rules were written for, neither hypothetical:
**72 of 80 rows carry no cost** (rendered "not recorded", never `$0.00`) and
**16 carry no parsable date**, one of them the `"09/16 or 17"` the schema comment
predicted, shown exactly as written.

### The downtime capture path did not need building — it needed turning on

Bill: _"ok build the downtime capture path."_ It was already built, and had been
since ADR-0044. `hours_down` exists on `equipment_events`, bounded and validated
(`assertEquipmentShape` refuses it on non-downtime kinds and outside `[0, MAX]`),
written inside an audited transaction, correctable through a soft void that never
deletes, exposed by the API with `.nonnegative().max(999.99)`, and surfaced by an
entry form that reveals the hours input the moment you pick a downtime kind.

**What did not exist was a Woodland manager who could reach it.**
`equipment_entry` was `pilot` — admin-only — so Morena and Janette had never seen
the form. That is the entire reason `hours_down` was NULL on all 68 rows: not a
missing feature, an unreachable one. The 61 maintenance + 7 repair events came
from the ADR-0048 importer, not from a person.

`equipment_entry` is now **live at Woodland** (Eugene stays pilot — no Terex).
The ledger's downtime panel flips from "not recorded" to a real number the moment
someone records one; no code change was needed for that, it was already wired.

Three tests pin the far end: a captured event moves the total, a voided one stops
counting (and can return it to "not recorded" rather than 0.0), and voiding one of
several leaves the rest. **The first falsification came back green** — the mock
filtered voided rows unconditionally, so the guard was measuring the mock, not the
code. Fixed; the red is now real (`expected 103 to be 4`). Second time in this
ADR's work that a first-pass falsification proved nothing, which is the pattern
worth remembering: a guard that cannot be made to fail has not been tested.

### The surface is named for the machine now (ADR-0077 Amendment 1)

Bill: _"also the labelling is not updated - check the original spec and make sure
this is complete."_ He was right. The spec said **rename the tile to Terex**; the
first pass kept the tile generic and put the name only on the detail page. That
was a deliberate call and it was outranked — a surface that says "Equipment" when
the site has one machine everybody calls the Terex is named after a database
table, not after the thing in the yard.

Nav, tile heading, overview band, cost card, entry form and both ledger
cross-links now read **Terex** at Woodland. **Eugene stays generic** — the label
is derived from whether the site actually has the machine (same invoice evidence
the ledger guard uses), never from a hardcoded site code, so Eugene never
advertises a machine it does not have and a Terex arriving there tomorrow renames
that site with no code change. `/admin/equipment` keeps its name: it is the asset
master for 554 rows across both sites, and "Equipment" is correct there.

The falsification came back green a third time — the mock enforced the
invoice-evidence rule itself. Fixed; the real red reads
`expected 'EQ65 — Sheer Machine Shear Machine' to be 'Equipment'`, which is what
Eugene's nav would have said.

## 2026-08-05 — the report counted mattresses and never counted people (ADR-0076)

On the night of August 4th, nineteen processors worked the Woodland floor. The
report that went out at 8pm listed all nineteen by name and never once said
"nineteen."

Two places in the schema claim to hold that number. `processed_units_daily` has
`employees_count` and `processors_count` columns — **NULL on all 987 rows**, never
written by any of their four write paths, no Eugene rows in the table at all (the
COR month-end pre-fill reads them and renders `—`; follow-up logged).
`bonus_employees.is_active` is the other, and it says Woodland has 40 active
processors: eight have not produced in 43–537 days, one never has.

The number was always in `bonus_daily_entries`, exactly, for free: unique on
`(employee, date)`, so a day's row count **is** its headcount.

### Added

- **A Processor Headcount panel** on the daily production report, in the same
  cream-and-gold shell as Trend: processors today, distinct month-to-date, same
  period last month, same day last year. Bill picked the windows same-day
  ("worked that day"; last-month/last-year comparisons yes; **all-time
  declined**). Comparisons inherit `include_comparisons`; today + MTD always
  render. Today's figure costs no query — it is the table you are already
  looking at.
- **`bonus_daily_report_log` remembers it** — `processors_today` and
  `processors_mtd`, written in the same claim-before-send that records
  `total_today` and `mtd_total`. Nullable: the three hundred sends before
  tonight genuinely did not carry these figures.

### Notes

- A processor who worked twenty days counts **once** per window. The
  distinct-once guard was falsified before being trusted (group by
  (employee, date) → red). Along the way the test mock was taught to honor
  Prisma's `by` argument — the first falsification pass silently proved nothing,
  which is exactly why the proof step exists.
- Headcount and units do not reconcile and are not meant to: ADR-0032
  adjustments move units with no processor attribution. The panel's footnote and
  a pinned test both say so.
- `skip_if_zero` unchanged (a lone zero-count entry still skips — pinned).
  No config flag, no rollout surface: same email, same recipients, same cadence.

## 2026-08-04 — a duplicate name stops being a dead end (ADR-0075)

This morning an approver filed an equipment request reading `Terex machine`, hit
**"An asset with that name already exists at this site…"**, and 39 seconds later
inserted a row anyway — resolving the request 34 ms after that. The gap is the
shape of someone retyping, not deliberating. Woodland now carries **three records
for one Terex machine** (`Terex`, `Terex Machine`, `Terex machine`), each cited by
a different approved invoice.

That is not an operator error. `resolveEquipmentRequest` had exactly one verb —
_create_ — so an approver whose asset was already in the registry under a slightly
different spelling had no legal move at all. The refusal named no alternative, and
the one instruction it did give ("Open /admin/equipment…") **403s for site
managers**, who are most of the people who can ever read it. And the uniqueness is
case-_sensitive_, so retyping around the wall works and reports success. Given a
wall, a text box and a job to finish, lower-casing the name is rational.

A collision is now a fork: _use the one that exists_, or _rename yours_.

### Added

- **Resolve against an asset that already exists.** `resolveEquipmentRequest`
  takes `mode: 'existing'` with an `equipmentId` — stamping the request and
  backfilling the invoice link without creating anything. The target is loaded
  inside the transaction and checked for existence, merged-status, and **site
  reach re-derived from the equipment row, never the payload**. `Reactivate and
use` flips an inactive target, audited as its own `restore`.
- **Collisions arrive with the rows they collided with.** A `409` now carries
  `existing[]`, and the panel renders each candidate as _name · category · site_
  with **Use this one** / **Rename mine**. Inactive and already-merged rows are
  included and badged — a merged one is shown but not offerable, so its name
  never looks lost.
- **A debounced similar-name lookup** (`GET /api/admin/equipment/similar`) that
  surfaces the near-miss _before_ the submit that would fork it. Gated by
  `requireEquipmentRequestAccess()`, not `requireAdmin()` — admin-gating it would
  have rebuilt the original dead end one layer down.
- **`mergeEquipment` + `merged_into_id`** (migration
  `20260827_adr0075_equipment_merge`, purely additive). Repoints
  `ap_equipment_links` and `ap_equipment_requests.resolved_equipment_id` onto a
  survivor, deactivates and stamps the loser, and audits it all in one
  transaction with both repoint counts. **It never writes `ap_requests`** — not
  the status, not the amounts, not `decided_by`/`decided_at`. The approval already
  happened and the money already moved. That invariant is held by a test that
  spies the `apRequest` writers and asserts they are never called at all; the test
  was **falsified** during development (adding an `ap_requests` write turns it
  red) rather than merely written. Merge is admin-only, refuses self/cross-site/
  already-merged, and deletes nothing.
- **A site code in the approve-time equipment picker.** It has been fleet-wide
  since 2026-07-28, so two similarly-named assets from different yards were
  previously indistinguishable in one flat list.

### Changed

- **One collision wording, in `messages.ts`.** Three copies existed and
  disagreed; the inline literals in `lib/ap/equipment-requests.ts` and the resolve
  route's P2002 backstop are gone. The "Open /admin/equipment" instruction is
  deleted — remediation is buttons now, not prose pointing at a 403.
- **`suggestName` stops seeding invoice prose into asset names.** It used to
  offer the first 60 characters of the description; production shows what that
  produces — `Fix and repair trailer: 53489, 5340, 35, 282859 going to Oregon
Stores` is a work order covering four trailers. It now strips leading work-order
  verbs and returns **nothing** for a comma list or anything sentence-length. An
  empty field beats a pre-filled bad name, which only asks the resolver to approve
  a suggestion instead of writing an answer.
- **The seed follows `merged_into_id`.** `seed-equipment-master.mjs` keys on
  `(site_id, display_name)` and a merged loser keeps its name — so a re-run after
  a merge would have written `is_active = true` back onto it and silently
  re-split the rows an admin just joined. It now resolves one hop to the
  survivor, and skips rather than resurrects if the survivor is missing.
- Merged rows drop out of the admin list (**including the `all` status view**),
  the AP picker, and its validator.

### Not changed — deliberately

- **The `(site_id, display_name)` unique index stands, unweakened.**
- **No case-insensitive unique index was added, and none should be.** Production
  holds a violating group _right now_ (`Terex Machine` / `Terex machine` — exactly
  one such group fleet-wide, verified today), and migrations run in the deploy's
  **init container**. A `CREATE UNIQUE INDEX` that cannot build would not fail a
  review — it would **crash-loop the deploy**. Case-folded duplicates are
  _detected_ and offered; they are not refused by the database. Merging the live
  duplicates (O-10) is the prerequisite for anyone revisiting this.
- **No merge was executed and no request was resolved here.** Both need a human
  to confirm physical facts — they are O-10 and O-11.

## 2026-08-03 (night) — the iPad stops showing 5 of 7,285 portal hauls (ADR-0074)

Bill's directive today: on-site iPad operators must be able to see **any** pending haul or
load from the MyMRC portal — searchable, newest to oldest. Measured against production at
13:17 PT, the floor could see **5 rows out of a 7,285-row mirror — 0.07%**. The iPad's only
window onto MyMRC was `/queue`, which lists `expected_loads` (718 rows) bounded to the
current Pacific day. An operator with a truck at the door and a haul number on a BOL had no
way to look it up.

`/operator/[site]/hauls` is that lookup. **Additive and READ-ONLY** — the check-in flow and
every write guard are untouched.

### Added

- **`/operator/[site]/hauls`** — every portal haul for the site, newest first, searchable by
  haul number / carrier / collection site / collection source (case-insensitive), 50 to a
  page. The 19 `Confirmed` hauls pin to the top in an unpaginated block, labelled with the
  fact that MyMRC reports **0 units until delivery**. An `Undated (N)` chip reaches the
  3,316 rows carrying no docking date. View state is entirely URL state (`?q=&page=&undated=`)
  so a shared iPad handed to the next shift reproduces exactly what is on the screen.
  Controls are 56px, the palette is the ADR-0008 floor green, offsets are logical (`ms-*`)
  for the Urdu RTL build, and instants render through the Pacific-pinned `formatTime` /
  `formatDate` (ADR-0065 Am.1 A1.1).
- **`src/lib/loads/portal-hauls.ts`** — the read service. `findMany` / `count` only.
- **`ipad_hauls` rollout surface**, born **`pilot`** per ADR-0047 #3 (migration
  `20260826_adr0074_ipad_hauls_surface` + `prisma/seed.mjs`, both idempotent). Its own row,
  so ramping it cannot touch the dock queue, the inbound confirm screen or the manager
  desktop — and pulling it back cannot take them down.
- **Hub card** on `/operator/[site]/today`, badged with the pending-haul count. The hub
  itself stays ungated (Bill: "do not strand anyone").
- **Index** `mymrc_hauls_mirror_site_docking_idx` on `(site_id, docking_appointment_date DESC)`
  — additive, `IF NOT EXISTS`. The site-only index left the sort unindexed on a table that
  grows forever.
- **`floor.hauls.*` + `floor.hub.card_hauls_*`** in all three locales (en / es / ur).

### Changed

- **ADR-0065 D5 is partially superseded — the READ half only.** Bill's earlier words
  ("vision on the ipad is only going to show hauls from the current day … no historical or
  future views") were about the **actionable queue**, and that scoping is fully preserved:
  `assertCurrentPacificDay`, the ADR-0060 D5 `per_load_exists` refusal, the partial unique
  index and the day-scoped inbound API are all untouched. D5 now reads: the actionable queue
  and every write are current-Pacific-day scoped; reading the portal catalogue is not.
- `'hauls'` added to `WORK_SEGMENTS` in `floor-nav.ts` — without it the route resolves as a
  user id and renders a black pre-auth page with no back and no Log Out.

### Recorded

- **`disappeared_at` is deliberately NOT a filter, and it is load-bearing.** 5,455 of the
  6,269 `Delivered`/`General` rows carry the stamp (6,453 of all 7,285). Per ADR-0070 Am.1 §3
  it means "absent from the last swept LIST VIEW", not "gone" — filtering on it would hide
  **87% of the delivered hauls**, reproducing in disguise the exact blindness this closes.
  Guarded by `portal-hauls.test.ts` case (a), which was **falsified by hand before commit**:
  adding the filter turned that case red and left the other eight green.
- **Four measured premise corrections**, in ADR-0074's context section: zero NULL-status rows
  today (tolerance kept anyway), `Inactive` is an **undocumented fifth status**, Eugene has
  **zero** mirror rows by construction (no portal feed — the honest empty state, not a bug),
  and the live type string is `Consumer Dropoff`, unhyphenated.
- **Accepted residual:** the 3,316 undated hauls are now **visible, not fixed**. This surface
  makes an upstream MyMRC gap legible to the floor for the first time; closing it is an
  operational chase with MRC. OPEN-ITEMS 0.AE.

### Money safety

Read surface, **zero writes**. Nothing in the new code creates an `ExpectedLoad` or an
`InboundLoad`. A row offers the existing `QueueRow` / `startLoadAction` check-in **only**
where a live, non-cancelled `expected_loads` sibling already exists; every other row renders
read-only with no control at all. Synthesizing a sibling to make a button possible is
forbidden (ADR-0074 D5) and pinned by test case (f).

### Operator action

- **Bill flips `ipad_hauls` to `live` at `/admin/rollout`** once the deploy's migrate step has
  run. Until then the surface degrades honestly to the translated "not turned on yet" block,
  with back and Log Out intact. OPEN-ITEMS **O-6**.

## 2026-08-03 (evening, second pull) — Rick corrected 07-30 + 07-31 too; 870 units reclassified total; the remaining gap is now a TOTAL-units problem reclassification cannot fix

Re-pulled the processed window on Rick's word: **07-30 → 808/352, 07-31 → 1,063/95**
(portal-confirmed, re-detailed, bridged, audited; 07-29 was already in). **07-27 and 07-28
still read all-program (1,163/0, 1,165/0) in the portal** — either pending or judged correct;
O-5 item 1 stays open for exactly those two days.

Running totals: **870 program units reclassified** to non-program across 07-29/30/31 —
that is 870 fewer billable program units (nothing invoiced, still zero exposure). Floor:
**−1,541 program / +16 non-program / −1,525 total.**

**The load-bearing observation:** reclassification is pool-neutral — it can never move the
TOTAL floor, which sits at −1,525. And the non-program pool is now at +16, nearly drained:
further reclassification (e.g., 07-27/28) would drive it negative, because MRC's recovered
inbound hauls are recorded 100% program (5,522/0) while Woodland demonstrably strips
non-program units daily — the same split-classification problem, mirrored on the INBOUND
side. The remaining −1,525 total therefore needs real missing inbound (undated hauls,
unmarked deliveries, the 07-29 iPad-150-vs-MRC-371 day) or a fresh physical count — no
amount of portal reclassification closes it.

Rick (Transportation Manager, by email via Bill): the 07-29 processed entry was keyed 1,249
all-program, but only 826 program mattresses were on the floor; he corrected the MRC portal
record (M-183347) to **826 program / 423 non-program** to prevent overcharging MRC (billing
bills `stripped_program`).

The correction could not reach Vision on its own — the **processed mirror has the same
frozen-detail defect** the hauls fix (below) closed: details fetched once per row, ever, so
a portal edit after first detail is invisible. Absorbed manually through the sanctioned
path: re-detailed M-183347 (mirror 1,249/0 → **826/423**, portal-confirmed), processed
bridge re-run for 07-29 (dry-run: exactly 1 update, neighbors unchanged; applied +
audited). `processed_units_daily` 07-29 now **826.0 / 423.0**. Floor: **−1,988 program /
+463 non-program / −1,525 total** (a pool reclassification — total unchanged; billable
program units −423). Nothing had been invoiced (0 invoice rows), so no overbilling occurred.

### Flagged, not edited (operator/manager decision — billing consequences)

The same impossible pattern exists on **07-27, 07-28, 07-30, 07-31**: the running program
pool crosses zero on 07-27 and every stripping day deepens it, meaning those days' all-program
entries also could not have been satisfied by program stock as recorded. If Rick's 07-29
observation generalizes, each needs the same portal-side reclassification; once corrected in
MRC, re-detail + bridge absorbs them (same path as above). Recorded in OPEN-ITEMS O-5.

### Also recorded

- **Rick's standing ask** — "keep track of that daily to prevent overcharging the MRC":
  the Half-B negative-pool alert (PR #196 §3.3) covers exactly this class (stripping more
  program than the pool holds must be loud, same-day). Logged as the acceptance shape for
  that work in OPEN-ITEMS O-5.
- The processed/outbound frozen-detail class is now **proven live** (M-183347), not
  hypothesized — the hauls-only fix below needs a sibling for Materials edits (no status
  transition to key on; needs a design decision, e.g. re-detail a trailing-N-day window).
  Folded into the Half-B scope note.

## 2026-08-03 (later) — the O-3 verdict was wrong: MRC HAD delivered; OUR mirror froze the transition. Recovered +4,306 units through the gates

**Correction of record.** The morning entry below (and OPEN-ITEMS O-3, and the 07-31 "NOT a
Vision defect" conclusion) blamed upstream: "MRC has not marked a single Woodland haul
Delivered since 07-21." **False — a Vision-side artifact.** Bill asked "are you completely
sure this is on MRC?" and checking killed the premise:

- The hourly ACTIVE view listed only **20** hauls while **83** mirror rows carried
  `status='Confirmed'` — most "Confirmed" rows were not in the scheduled view at all.
- **34 window hauls' `last_seen_at` equaled the `haulsCompleted` run's exact instant** —
  MRC's _delivered_ list was serving them, hourly. MRC had done their paperwork.
- Root cause: **a detail was fetched once per row, ever** (`idsNeedingDetail` filtered
  `detail_fetched_at IS NULL`). The list pass records only "I saw this id"; status and unit
  counts live on the detail. A haul detailed while scheduled kept `Confirmed`/0 units
  permanently — the 07-31 claim "Vision will pick them up within the hour once MRC marks
  them delivered" listed the transition but could never absorb it.

**One-haul proof** (Bill-ordered, before any bulk write): H-134015, mirror-frozen
`Confirmed`/0 since 07-22, re-detailed → **`Delivered` / General / 106 program units /
5,830 lbs**, docking 07-27.

**Recovery, through the script's gates:** cleared `detail_fetched_at` for all 83 Confirmed
rows → enrich re-detailed 82/82 reachable (one id errors in every view — portal-side ghost,
stays null-stamped and inert) → **61 hauls flipped Confirmed→Delivered**; the mirror window
07-22→08-06 now holds 50 Delivered General hauls / 5,393 program units. `fix-woodland-inbound.sh
--dry-run`: recoverable **5,022** ≥ 5,000 — **gate PASSED** (07-29's 371 correctly skipped:
the ipad_floor aggregate owns that day slot). `--apply` bridged 10 day-aggregates
(idempotent, audited): ledger inbound 150 → 4,456. Floor **−6,287 → −1,981 program
(−5,401 → −1,095 total)**; the tile shows **−2,439 / −1,553** today because the 08-04/08-06
deliveries count on their own days.

### Fixed

- **`sync.ts` — a detail is not forever.** `idsNeedingDetail` is now feed-aware: a row
  listed by `completed_hauls` whose stored status is not yet `Delivered` (NULL included) is
  re-detailed, absorbing the Confirmed→Delivered transition and its unit counts. The active
  view keeps the null-only filter (re-detailing every scheduled haul hourly buys nothing).
  Query-level regression test per the 07-31 lesson — reverting the filter goes red; proven
  by actually reverting it.
- `fix-woodland-inbound.sh` floor blocks now bound `arrived_at <= now()` so future-dated
  bridged days don't inflate the reported floor.

### Still true / still open

- The floor remains negative (**−2,439 program** today). The ledger says stripped 8,034 vs
  available anchor+inbound ≈ 6,131 — a ~1,900-unit reconciliation gap that no feed currently
  explains: candidates are further MRC marking lag (22 hauls still Confirmed, dated 08-04+),
  the 2,319 undated-haul defect, or stripped over-count. A fresh physical count (diagnosis
  §8 option 3) remains the clean reset if the July COR cannot wait; the COR gates (morning
  entry) keep it unfileable meanwhile — now via the **negative-ledger** refusal, since the
  delivered feed measure is fresh again.
- The frozen-detail class likely also applies to the processed/outbound mirrors
  (status flips like Active→Inactive) — for the PR #196 Half-B campaign's per-feed
  freshness contract, not rushed here.

## 2026-08-03 — the Woodland recovery script ran its gates and correctly wrote nothing; the COR can no longer file a frozen-feed figure

The PR #196 Half-A remediation, executed under its own falsification gate — which **tripped at
zero**. Run against prod (read-only until a gate passes; none did):

| verify block              | measured                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| floor (onHand replicated) | **−6,287 program / +886 non-program / −5,401 total** (was −3,083 on 07-30; stripped since anchor now 8,034 vs 150 verified inbound)                     |
| delivered-hauls freshness | newest delivered haul still **2026-07-21**; `last_seen_at` refreshing hourly (the `haulsCompleted` feed works; `hauls` honestly reports `stale_mirror`) |
| the guard trap            | whole-table max 2026-08-10 (future Confirmed) vs delivered-only 2026-07-21 — the 07-31 delivered-only fix measures the right signal                     |
| `completed_hauls` cursor  | re-armed + re-run 2026-07-31 18:19 (6,000/6,256) — NOT drained-stale                                                                                    |
| recoverable window        | **0 Delivered General hauls dated ≥ 07-22, 0 program units** (bridge dry-run concurs: `days=0`)                                                         |

**Falsification gate (< ~5,000 recoverable): TRIPPED at 0 — no write.** The drained-cursor theory
is dead: the missing units are not sitting in the mirror waiting to be bridged; MRC has not marked
a single Woodland haul Delivered since 07-21 (~60 hauls dated 07-22 → 08-10 sit `Confirmed` at 0
units — units populate on delivery). This is upstream delivery-marking lag / intake loss
(OPEN-ITEMS O-3), not a Vision defect, and no DB write can honestly fix it.

### Added

- **`scripts/fix-woodland-inbound.sh`** — the remediation script, corrected against the real
  schema before first run. The diagnosis-era guesses it replaces: `ingest_cursors` →
  `mymrc_backfill_cursors`; `program_units`/`non_program_units` → `program_unit_count`/
  `non_program_unit_count`; a per-haul `ON CONFLICT (mymrc_haul)` writer → **no such column and
  no such grain**: the ADR-0059 bridge writes one aggregate row per (site, delivery day)
  arbitrated by the partial unique index `inbound_loads_aggregate_site_day_key`, so the script
  delegates every write to `dist/mymrc.bridgeInboundHaulsToInventory` (absolute-set, idempotent,
  precedence-guarded, audited) and ships no SQL writer of its own. `source_note` → not needed:
  bridge rows are structurally identified by `load_source_type='mymrc_haul'` + the bridge's
  `audit_log` rows, which is what `--rollback` keys on. Ladder: `--verify-only` (default) →
  `--dry-run` → gate → `--apply` → `--rollback`; `--allow-partial` waives the gate only once the
  upstream cause is understood (MRC marking deliveries in batches). It exists precisely because
  the hourly scrape only re-bridges a trailing **10-day** window — every frozen-window day has
  now slid out of it, so when MRC late-marks those hauls Delivered, the mirror will update but
  the floor will NOT self-heal without this script (or a wider manual bridge run).
- **The COR stale-feed block (PR #196 §2.3)** — `src/lib/cor/inbound-gate.ts`, wired into BOTH
  `computeCorPrefill` (end-of-month path, before anything is computed) and `finalizeCor` (before
  the reconcile tripwire). Two refusals: `CorInboundStaleError` (409) when the delivered-hauls
  feed is stale — measured delivered-only, the same signal the 07-31 guard fix measures — and
  `CorLedgerNegativeError` (422) on a negative balance, which is never a fileable figure.
  Mid-month filings (inventory blank) are untouched; an empty mirror stays bootstrap-not-stale.
  The July Woodland COR is therefore now **mechanically unfileable** until inbound recovers —
  previously only a warning in a diagnosis document. The incident is the acceptance fixture
  (`inbound-gate.test.ts` + prefill/service suites): delivered frozen at 07-21 with Confirmed
  rows dated 08-10 must refuse; a green gate on that fixture is a test failure. 4,143 tests pass.

### Not done here, still PR #196's scope

Half B beyond §2.3 — the per-feed freshness contract generalization, the `onHand`/floor-tile
stale-inputs + negative-pool banners, and the 06:00 digest wiring — remains open for the
campaign session. The expected ≈ +1,500 floor is NOT achievable from Vision's side today;
it lands when MRC marks the ~60 Confirmed hauls Delivered (≈3,600–6,000 units at July's
~106/haul), at which point `--apply` bridges anything older than the 10-day window.

## 2026-07-31 — verified live: the completed-hauls feed runs, and the disappeared churn stopped

Proof rather than assertion. After deploying, the sync was run and the ledger checked.

```
haulsCompleted newest-first list → 800 ids over 4 pages (totalCount=6258, stop=page_cap)
woodland/haulsCompleted list WINDOWED (800 ids) — disappeared-detection SKIPPED
woodland/haulsCompleted ok — listed=800 complete=false
```

`mymrc_sync_runs` now carries **four** feeds where it carried three; the `completed_hauls` list-view id resolved with no `PortalContractDriftError`.

**The scoping is measurable**, comparing against the baseline taken before deploy:

| rows carrying `disappeared_at` | before          | after     |
| ------------------------------ | --------------- | --------- |
| Delivered                      | **7,190** (all) | **6,447** |
| Confirmed                      | 56              | **2**     |

743 delivered hauls un-stamped by the history feed refreshing them, and the active feed can no longer sweep them. The hourly churn over ~7,190 rows has stopped. The bounded walk behaved as designed — newest-first, 800 of 6,258, `stop=page_cap`, `complete=false`, so disappeared-detection correctly skipped rather than over-marking the unseen tail.

`hauls` still reports `stale_mirror`, correctly: `max_appt` for Delivered is still 2026-07-21 because MRC has not marked those hauls delivered.

### Docs reconciled

- **ADR-0070 Amendment 1** records all of it: the masked guard, the root cause, the now-fixed over-broad disappeared-marking, and the half-added feed.
- **ADR-0073** (manager load corrections) landed as **proposed — design only**.
- **OPEN-ITEMS 0.AD** captures the end-of-day state and every decision waiting on Bill; **0.AC** carries the ADR-0073 research items L-1…L-9.
- **Correction:** ADR-0069 Am.1/Am.2 and `terex-extract.ts` asserted `processed_units_daily` has a "sole writer". It does not — three paths write it under a **precedence** rule (`source='mymrc' AND closed_at IS NULL`). Corrected in place. The same overstatement is baked into applied migration `20260825`, which is checksum-locked and must stay as-is; ADR-0069 Am.1 is the correction of record.

## 2026-07-31 — the new feed was declared but never run

Caught by running the sync instead of trusting the diff. `haulsCompleted` was added to the type, the list-view bindings, the adapters and the field map — and did not run. `syncSite` and the deadman each carried their own hardcoded `['hauls', 'processed', 'outbound']`, so the constant said four feeds and the runner iterated three. The sync reported a clean run throughout.

**A feed that exists but is never iterated is indistinguishable from a feed that was never added.**

### Fixed

- `syncSite` and `checkDeadman` now iterate `FEED_NAMES`. The constant is the single source of truth, so the next feed cannot be half-added.
- The deadman's `expect(calls.length).toBe(3)` became `toBe(FEED_NAMES.length)` — it read `3` and passed while a feed was silently unchecked.

### The test lesson, again

The first guard asserted `FEED_NAMES` contained the right entries — and reverting `syncSite` to its hardcoded list **still passed**. Asserting the constant is not asserting the loop. A second test now drives `syncSite` with a fake transport and checks the list call fires once per declared feed; reverting the loop goes red.

That is the third time today a guard failed to falsify on the first attempt — each time by testing the thing adjacent to the defect rather than the defect itself.

## 2026-07-31 — the hourly sync never watched the view that says a haul was delivered

The root cause behind the frozen inbound feed. The hourly sync polled three list views — `docking_appointments_rc`, `processed_active`, `outbound_active`. A haul sits in the _docking appointments_ view while it is **scheduled**, and **leaves it** when MRC marks it Delivered, appearing instead in `completed_hauls`. Nothing polled `completed_hauls`. So the mirror could never observe the transition: `Confirmed` rows refreshed hourly and looked healthy while the delivered half sat frozen since 2026-07-22, and `inbound_loads` is bridged from **delivered** hauls.

### Added

- A **`haulsCompleted`** feed reading `completed_hauls` — same object, same mirror, same page, a different list view. It is the only feed that can see a haul become Delivered.

### The thing that made this more than an additive change

**`markDisappeared` swept the whole haul mirror**, and only runs when a list completes. The active view is ~73 rows, so it _does_ complete — meaning every hourly run already stamped all ~7,190 delivered hauls as disappeared. Pre-existing (ADR-0070), and harmless only because `inbound-bridge.ts` deliberately ignores `disappeared_at`.

With two views over one mirror that stops being harmless: each feed would take turns declaring the other's records vanished. **"Not in this list" no longer means "gone."** Each feed is now scoped to the statuses its own view can contain — the active view can never declare a Delivered haul gone, and the history view can only speak about Delivered ones. A NULL status is excluded by `in`/`notIn` semantics, which is the money-safe direction: a haul we have not detail-fetched is never declared gone on the strength of a list it may not belong to.

### Corrected

The freshness docstring still carried the reasoning that caused yesterday's masking — "a healthy hauls feed reports a negative age and can never be stale… the appointment recedes into the past on its own." That is wrong: the appointment only recedes if the _whole_ feed stops, and what actually happened is that the delivered half froze while the scheduled half kept booking into the future. A false explanation left standing next to fixed code is the same defect as a false assertion in the UI.

### Verification

Guards falsified before being kept: unscoped sweep (the ~7,190-row over-mark) ✅, both feeds sharing the active scope ✅, freshness measuring all statuses again ✅.

That third one **initially failed to fire** — the regression test only exercised the pure arithmetic, so the actual `where: { status: 'Delivered' }` filter was untested and could have been silently reverted. A query-level test was added; the break then goes red. Full suite 4,128 passing.

## 2026-07-31 — the mirror-freshness guard could not see the outage it was written for

Shipped 2026-07-30 to catch a frozen MyMRC feed. It measured `max(docking_appointment_date)` across the **whole** haul mirror — and a haul is `Confirmed` when it is _scheduled_, with the appointment dated into the future. Measured live mid-outage:

|                                          | newest date | age          |
| ---------------------------------------- | ----------- | ------------ |
| all hauls (what shipped)                 | 2026-08-10  | **−9 days**  |
| delivered hauls (what it should measure) | 2026-07-21  | **+10 days** |

Future-dated scheduling **permanently masked** a delivered feed that had been frozen for nine days. The guard read healthy throughout and would have gone on reading healthy forever. `inbound_loads` is bridged from _delivered_ hauls, so that frozen half is exactly what drove the Woodland floor to **−3,493**.

### Fixed

- The hauls guard now measures **delivered** hauls only. Against the same live data it reports 10 days stale and fires — it would have fired on **day 5** of the nine-day freeze.

### Also

- Re-armed the `completed_hauls` backfill cursor, which had been `completed` since 2026-07-22 and therefore never ran again. The re-walk recovered **16** genuinely missing historical hauls.

### What it did NOT fix, and why

The negative floor is **not** a Vision sync failure. 34 hauls dated 07-23→07-31 are still `Confirmed` in MRC's own portal and carry **0 units** — units populate only on delivery. July's delivered hauls average ~106 units each, so those 34 represent roughly **3,600 units** against a 3,493 deficit: essentially the whole gap. Vision is faithfully reporting what MRC says. The units will land when MRC marks the hauls delivered.

### Known gap, deliberately not rushed

The hourly sync polls `docking_appointments_rc` (active) but **not** `completed_hauls`, so a haul's transition to _Delivered_ is only ever observed by the one-shot backfill. That is why the feed can freeze at all. Fixing it properly means a second haul list-view in the hourly envelope resolution — a real change to the sync core, scoped rather than rushed at the end of a long session.

## 2026-07-31 — TEREX maintenance absorbs, and absorbing it naively would have doubled the money (ADR-0069 Am.2)

The second document kind, and the one the preview-then-confirm rule was written for. `Estimated cost`, `Actual Repair Cost` and `Amount Credited` are real dollars, so rows land **staged** and count only once a human accepts them.

### The finding

The workbook has **40 sheets**. Two are maintenance logs — and they are not two years of data. `Maintenance Log 2025` is a **strict subset** of `Maintenance Log2026`: 55 shared events, **zero** unique to 2025, and both sheets total **$77,067.94**. Absorbing "every sheet that resolves" — which is exactly what the trailer extractor correctly does for a one-sheet workbook — would have reported **$154,135.88, precisely double**.

So this extractor de-duplicates across sheets and says so on the preview screen, because someone looking at two maintenance-log tabs will reasonably expect ~$154k, and the smaller number is only believable if the screen explains itself. Against the real file: 40 sheets scanned, 2 treated as logs, 80 events, 57 duplicates removed, **$77,067.94** actual repair and $4,025.36 credited.

### The other 38 sheets are deliberately untouched

28 monthly operating tabs, two OVERVIEW pivots, three derived rollups, two blank Templates, a duplicate, and `diesel`. The summary tabs are **derived from** the monthly ones — absorbing both double-counts by construction. And the monthly tabs carry per-day processed units, which is `processed_units_daily` territory with workbook-sync as sole writer. A sheet is a maintenance log because its **headers** say so, never because its name mentions Terex.

### What else the real data forced

- **Row 3 is an instructional example** — column A literally reads `example`, describing a Powerscreen call that never happened. Absorbing it manufactures a maintenance record.
- **132 scaffold rows** carry only a year or a month name. They are section headings, not events.
- **The date column can't be trusted into a DATE.** Of 81 events: 64 real dates, 6 free text (including `"09/16 or 17"` — the operator genuinely didn't know which day), one **1900-01-14 Excel epoch artefact**, 10 blank. Dates are kept only when plausible; the raw text is always kept. Guessing `"09/16 or 17"` invents a day someone deliberately refused to pick.
- **A blank cost is NOT RECORDED, never $0** — a repair nobody priced is not a free repair.

### The confirm step

`/admin/doc-ingest/terex` shows the totals, the sheets read, the de-duplication and the undated count; accept or discard per batch, attributed. A `confirmed` row must name who confirmed it — enforced by a CHECK, because money data whose acceptance can't answer "who accepted this?" isn't an audit trail. Re-absorption refreshes only staged rows; it never un-accepts what someone already accepted.

### Verification

12 new tests, full suite 4,122 passing, every guard falsified before being kept — including removing the de-duplication and watching the $77k→$154k defect reappear. The `ABSORBABLE_KINDS` tripwire fired for the second time today and was updated to the new exact set rather than loosened.

## 2026-07-31 — the first document kind actually absorbs, and a parser fix can reach old documents (ADR-0069 Am.1)

Two gaps closed: Fix 3 of the absorption audit (left specified, not shipped, because the recommended target turned out to be the wrong file), and the fact that Am.8's header fix could not reach any document already in the system.

### Added

- **Trailer-list absorption, end to end.** A confirmed trailer workbook's rows become real columns in `doc_trailer_rows` — entry date, trailer #, material, weight, driver, days in yard, exit date, notes — visible at **`/admin/doc-ingest/trailers`**. This is the audit's core finding closed: parsed values now reach a queryable Vision table.
- **A re-parse action.** `parse_summary` is computed at parse time, and a parse only happens on a NEW revision — so the three documents waiting since 07‑29 would have kept their title-row headers until somebody happened to edit a file. A code fix that reaches the data only by luck isn't a fix. Admin-only, per source.

### Verified against the real file

96 rows, 28 blank spacers skipped, 723,051 lbs total, 19 rows with no weight, 14 with no entry date — every figure reconciling with an independent profile taken before the extractor existed (77 numeric + 11 blank + 6 dash + 2 non-numeric = 96).

### Guarded

- **A blank or `"-"` weight is NULL, never 0.** Nineteen of ninety-six rows have no weight; zeroing them would invent nineteen trailers weighing nothing and drag every average down. The raw cell text is kept so `-` stays recoverable.
- **Columns resolved by MEANING, never position.** The live sheet has its header on row 2, data starting in column B, a header with a trailing space and another with an embedded newline. Ordinal mapping survives none of that, and a silently-shifted column is a wrong number rather than an error.
- **Material is stored VERBATIM.** The file mixes `pocket coil`/`Pocketcoil` and uses the column for origins (`Recology SF`) as often as materials. Normalising would invent a taxonomy nobody agreed to; mapping it to program/non-program would invent a billing fact.
- **`Days in yard` is the sheet's own formula result, never recomputed** — showing a number the spreadsheet doesn't show is how two systems start disagreeing about a figure neither owns.
- **Zero rows is never a successful absorption of nothing** — each sheet reports why it declined.
- **The re-parse action creates no revision and touches no `ctag`.** The content didn't change, only our reading of it; minting a revision would claim Kelsey edited a file she didn't touch and drag the whole delta machinery through a change that never happened. It also leaves STAGED revisions alone, and a parse failure never overwrites a good summary with nothing.
- **Single-writer rule intact.** `doc_trailer_rows` is reference data written only by the absorption bridge; nothing operational reads it, and `processed_units_daily` keeps its sole writer.

### The tripwire fired, as designed

`expect([...ABSORBABLE_KINDS]).toEqual(['daily_log_workbook'])` — written as "widening this set is a deliberate act" — broke on this change. It was updated to the new exact set rather than loosened to `toContain`: adding a kind without its extractor and its typed table must keep breaking a test.

### Still open

TEREX (next, and needs preview-then-confirm because it carries costs) and the commodity tracker (a compliance record of who audited what — worth a decision from Bill on whether it's worth absorbing at all). And no comparison against Vision's own numbers yet: the natural one, material weight against outbound records, needs Rick or Kelsey to confirm the counterpart figures.

## 2026-07-31 — the header guess was wrong on every real document (ADR-0067 Amendment 8)

`parse.ts` took the first non-empty row as the header, with a comment claiming that was "correct for every workbook this pipeline has seen". The 2026-07-30 audit falsified it 3 of 3. Not cosmetic: the classifier's structure rules match on column names (so classification was **filename-only**), and the aggregate-variance guardrail's monitored-column regex can't match a title string — so a "clean guardrail verdict" meant _there was nothing to compare_, not _the change was safe_.

### Fixed

- **The header row is now detected, not assumed.** Emphatically not "use row 2" — that reproduces the same defect one row lower. It scans the first 12 rows and takes the first that is both **wide** (≥60% of the widest row) and **label-like** (≥60% non-numeric, short cells). Which row it chose, how confident it is, and the skipped title rows are all recorded, because the reason the old behaviour survived is that nothing ever showed what it had picked. Same detection on the CSV path — an exported CSV carries the same merged title line.
- **The `/admin` doc-ingest tile now carries an awaiting-confirmation badge.** The tile route and the onward links to anomalies/health were already shipped (contrary to the handoff); the badge was what was missing. A tile that looks identical whether or not three documents are waiting is how three documents waited from 2026-07-29 with nothing in the app saying so.

### Verified against the real files, not a summary of them

The three live workbooks were pulled out of R2 and parsed. All resolve `strong`, and the header rows are **2, 2, 3 and 4** across the four sheets — any fixed-row assumption is wrong on at least one. `Weight (lbs)`, `Estimated cost`, `Actual Repair Cost` and `Amount Credited` now reach `headers[]`, so the aggregate guardrail has real signal for the first time.

### The finding that changes Fix 3

The handoff recommends the commodity-audit tracker as the first absorption type, for its reconciliation value against vendor invoices. **Reading the actual file shows it doesn't contain that.** It's banded — title, commodity band (METAL/WOOD/TOPPERS/FOAM/TRASH/XTRACTION), vendor band, then on row 4 a repeating `Audited | Initials | Date | 2nd Audit | Initials | Date` per commodity. No weight, no amount, no invoice number, no variance. It's an audit **checklist** — who ticked which box — not the commodity figures. Absorbing it would produce a queryable table of ticked boxes and the _appearance_ of absorption.

The better first type is the **trailer list** (`Material`, `Weight (lbs)`, `Date of Entry to Yard`, `Exit Date` — real operational data with a natural Vision comparison), with TEREX second and money-touching, so under preview-then-confirm. **Fix 3 is specified against this evidence rather than shipped against the assumption.**

### Corrected

`absorb.ts` asserted in a comment that `parse.ts` "takes the first non-empty row … wrong on 3 of 3 live workbooks". That is now false, and a false assertion in a comment is the same defect as one in the UI. Corrected in place.

### Verification

11 tests, every guard falsified before being kept. The "assume row 2" break initially **passed** — a defect in the test, not safety in the code: on a header-is-row-1 sheet the variant still landed on row 1 via the weak fallback, and the test asserted only the index. It now asserts `confidence === 'strong'`, and the break goes red.

## 2026-07-31 — iPad physical count is live at both sites, behind a tiered guardrail (ADR-0072)

`ipad_count` was the last high-value floor surface still at pilot. It is now **live at both sites**. The reason it needed more than a flag: a physical count becomes the inventory **anchor**, and every downstream number is computed forward from it — so a mistyped digit doesn't produce a wrong count, it silently moves the entire floor. Woodland's anchor is a known-good 2,483; one fat-fingered tap would have replaced it with no trace beyond a snapshot row nobody looks at.

### Added

- **Three tiers, proportional to the damage.** Tier 0 (no anchor yet) writes straight through — that's every Eugene count today and we want it frictionless. Tier 1 (swing ≤ 20%) shows one confirm screen with current-vs-new and the change **in words**, because "2,483 → 2,150" is exactly what reads as fine at a glance. Tier 2 (swing > 20%) is **held for a manager**. Threshold is a setting seeded at 20 — Bill tightened it from a proposed 40, where a single tap could move ~1,000 units.
- **Two release paths.** A manager approves by PIN on the same iPad, or remotely from their own screen when nobody is on the floor. The path taken is recorded — "a manager approved this" and "a manager approved this while standing at the iPad" are different facts six months later.
- **`/admin/inventory/anchors`** — anchor history per site, the pending holds (otherwise visible only to the operator at the iPad that produced them), and restoring a prior anchor.

### Guarded

- **The operator who entered a count can never release it** — enforced in the service, in the route, and by a `CHECK` constraint, because the rule that matters most is the one a future code path cannot forget. The self-release check runs _before_ the PIN check, so a refusal can't be used to probe whether a PIN is right. And it binds the person, not the surface: a manager who entered the count on the floor can't release it from their desk either.
- **Enforced server-side, not in the dialog.** The tier is recomputed from live state on every write. A hand-crafted request that skips the confirm meets the same check and a Tier 2 write without approval is refused with a 422. The UI is a courtesy; the server is the control.
- **A held count is held, not rejected** — it keeps the entered values until a manager releases it or someone explicitly discards it with a reason. Never silently dropped, never auto-written.
- **The swing is recomputed at release**, not read from the hold. The anchor may have moved in between, and writing a stale figure against a changed baseline is how a guardrail becomes theatre.
- **Recovery appends, never erases.** Re-activating a prior anchor writes a _new_ snapshot carrying its figures. Deleting the mistake would leave a history that never contained it, and the next person asking "why did the floor jump 1,200 units?" would find nothing.

### Scope

`ipad_processed` and `ipad_today_summary` are untouched and remain pilot. The migration's UPDATE names `ipad_count` alone — it must not become the one that quietly turned on three surfaces because they were adjacent in a table.

### Divergence from the handoff

The handoff asks to keep `assertCurrentPacificDay()` on the count write. **That function is not on this path and never was.** The count route accepts no date input at all — it pins the anchor server-side to Pacific midnight of today, which is stronger than asserting a client-supplied date, because there is no client-supplied date to assert. Shipped code wins; nothing was reverted.

### Verification

26 new tests, every guard falsified before being kept. Real-number cases: 2,483 → 2,150 is Tier 1 (13%); 2,483 → 1,200 is Tier 2 (52%); a count of **0** against a real anchor is a 100% swing and is held; re-entering the identical figure is a zero swing and is never held; a **zero** prior anchor is Tier 1 rather than an infinite swing, or a site that once counted empty would hold every count forever.

## 2026-07-31 — processor production quota alert (ADR-0071)

An **exception alert**, not a dashboard. Nobody watches numbers; the system watches and speaks up only when a Woodland processor finishes a Monday–Sunday week with two or more days below the daily quota. It reads the per-processor daily counts the bonus system already captures — the same production data from a different angle, not a new measurement.

### Added

- Weekly digest naming each flagged processor **with their miss days and the actual counts** ("Tuesday — 62, Thursday — 48"), because the numbers are what separate a slow slide from two bad days. Sent through `notifyStaff()`; recipients and quota are settings, not literals.
- `/admin/processor-quota` — the detail behind the alert: every processor's daily counts for a selectable week, misses highlighted, admin-only. Deliberately **not** merged into the daily production report (that report is a production figure a wide audience reads; this one names individuals) and on **no** operator or iPad surface.

### Guarded

- **A day with no recorded production is never a miss.** PTO, a day off, any non-worked day is skipped entirely. Verified against live data: of 5,733 entries exactly **one** carries a zero, so keying a 0 is not how a day off is recorded and evaluating only days that have a row is safe. Exactly 75 is MET, not missed.
- **No email when nobody flags.** An "all clear" every Monday trains recipients to archive it unread, and the week it says something real goes with it. But a suppressed week still writes a log row recording that it _was_ evaluated — otherwise "nobody missed twice" and "the cron never ran" are the same observation from an inbox.
- **Read-only.** Writes nothing to `processed_units_daily` (sole writer: workbook-sync) or any bonus table. It owns three tables of its own and nothing else.
- **Cannot double-send.** Idempotent per (site, week) via a unique index — which is also why the cron fires _daily_ for a weekly digest: Monday sends, Tue–Sun no-op, and a Monday lost to a redeploy self-heals on Tuesday rather than losing the week silently.

### The number Bill needs before enabling it

**At quota 75, this flags 13 of 18 Woodland processors** — measured against the real week of 2026-07-20. That is a roster, not an exception list, and it defeats the "silence means fine" design. Lowering the quota alone does not fix it: 60 → 10 flagged, 50 → 8, and even at **40** — half the stated quota — 4 still flag. The sensitivity is coming as much from the 2-miss threshold on a 5-day week as from the quota. **So it ships DISABLED**, surface at `pilot`, nothing reaching anyone; the report screen is live and accurate now so thresholds can be tried against real weeks first.

### Caught by checking

The recipient seed initially used `morena.chavez@` and `janette.gonzalez@`. Both wrong — the roster has `morena.gomez@` and `janette.tomas@`. A guessed address doesn't fail loudly; it silently seeds a list missing two of the three people who need the alert. The seed now also guards on `is_active` and a non-empty address, because all three recipients _also_ hold operator accounts with empty emails (PIN-only floor login).

## 2026-07-31 — the prior month stopped being readable the moment it ended (ADR-0049 Am.4, B1)

Monthly rollover was automatic and total: on the 1st the sync began reading the new file and **nothing ever read the old one again**. A daily-log workbook isn't finished on the last day of its month — Kelsey closes the month in the days after it, filling a missed day, correcting a mis-keyed figure, completing the last day's close the next morning. Every one of those edits was invisible to Vision, permanently, and silently: no error, no ledger row, no alarm. The file just stopped being looked at. Shipped before the 8/1 rollover, which is the last moment it could have helped July.

### Added

- **A five-business-day grace window.** The prior month's workbook keeps being polled alongside the current one through the 5th business day of the new month, then stops — an unbounded window means an accidental edit to a February file in November silently rewrites February. Business days, not calendar days: a five-calendar-day window opening on a Friday gives one working day. Holidays are deliberately not modelled; the effect is bounded and in the safe direction, and a stale holiday table would make the window silently wrong rather than merely short.
- **A separate watermark for the prior month** (`grace_file_id/name/ctag`). Two files are in flight during the window and one cTag slot cannot answer "unchanged?" for both — the polls would alternate and re-download every time. The dangerous direction is worse: a grace read advancing the current-month watermark would make a real August change arriving between two grace polls read as `unchanged` and **dropped silently**.
- **`workbook_sync_runs.grace_window`.** Without it a July-dated run sitting among August runs is indistinguishable from the A2 stale-month defect Amendment 3 was written to catch.

### Guarded

- **A day an approved invoice already covers is never rewritten.** Only the grace path can reach one. When the workbook disagrees with an invoice MRC already has, quietly moving the Vision figure would leave no trace — it would just make Vision stop matching what was sent. The day is left as billed and counted on `rows_skipped_billed`; resolving it is a human decision (the ADR-0041 supersede chain). Draft invoices don't count; a draft has been shown to nobody.
- **A grace poll never touches health and never pages.** `last_success_at` / `consecutive_failures` / `last_polled_at` answer "is the _live_ feed working?", and a successful read of last month's file is not evidence that this month's is being read — letting it reset the counter would mask a dead current-month feed for the first week of every month. And the prior month's file gets archived or renamed as a matter of routine, so a grace `not_found` is the expected end state; paging on it would fire on every source, every month, on schedule (ADR-0037 Q1/Q2).

### Verification

24 new tests. Every guard was **falsified before being kept** — broken on purpose, observed red, restored. One break (`priorMonthAnchor` = `now − 30 days`) initially _passed_, which was a defect in the test rather than safety in the code: every case tried landed on the 3rd, and the 3rd minus 30 days is inside the prior month for any month length. The separating case is **1 March → 30 January** — the sync would re-poll January while claiming to catch up February. The test now asserts days 1–8 of all twelve months, and the break goes red.

### Known gap

`grace_window` and `rows_skipped_billed` are on the ledger and in the logs but **not yet on any screen**. A non-zero `rows_skipped_billed` means a spreadsheet and a sent invoice disagree, and today that is only discoverable by querying.

## 2026-07-31 — the MyMRC mirror was frozen for 9 days behind 216 green runs (ADR-0070)

MyMRC is the only **independent** witness for validating `workbook-sync` before cutover — the doc-ingest reconciliation surface can't do it, because both its sides derive from the same extractor. That witness had stopped moving. The processed and outbound mirrors had not gained a row since 2026-07-22 while every hourly run recorded `ok`.

### Fixed

- **The hourly list pass was reading the OLDEST records in the view, forever.** The steady-state transport is passive — it navigates the list page and reads whichever `getItems` window the portal's own UI fired, which is the view's **default sort**. A read-only probe established that default is **ascending**: `processed_active` returned `M-000300@2024-03-01 … M-000590@2024-03-07` and `outbound_active` `M-000264@2024-03-01 …`, both with `hasMoreData:true` over 985 / 4559 records. So every hour the sync re-read page 0 of an ascending list — 50 ids it already held, `detail:0` because they all had details, `ok` — and a record created after 2026-07-22 could **never** enter the window. Hauls escaped only by size (18 records = one page). The list pass now replays `getItems` with `sortBy:'-Id'` over a bounded offset walk. Verified live through the real code path: processed returned business dates 2026-07-21…2026-07-29 and outbound 2026-07-20…2026-07-30, none of which existed in the mirror.
- **`hasMoreData:false` could have mass-marked 2559 live records as disappeared.** Found while testing the fix at pageSize 2000: `outbound_active` returns 2000 ids with `hasMoreData:false` while `totalCount` is 4559 — the portal clamps to its 2000 cap and then reports no-more-data. That would have handed the sync `complete:true` for a 44%-complete list, and `markDisappeared` stamps everything unseen. A list is now complete only when `hasMoreData:false` **and** the ids account for `totalCount`; otherwise it reports `short_of_total`, `complete:false`, and warns. Disappeared-detection is strictly more conservative than before, never less.
- **`ok` stops meaning "nothing happened".** New run status `stale_mirror`: a run that doesn't throw but leaves the feed's newest business record past the freshness threshold records that, with the measured date, instead of `ok`. Every pre-existing guard was blind to this by construction — zero-anomaly fires on 0 listed (we listed 50), the deadman fires when no run _succeeds_ in 26h (216 succeeded), and the windowed-list warning fires on `hasMoreData`, which is normal for a large view. All three measure the scraper; none measured whether what we hold is current.

### Added

- **A mirror-freshness alarm.** Measured on the record's own business date (`entry_date`, `docking_appointment_date`) — never `detail_fetched_at` / `last_seen_at`, which refresh when we re-read a record we already hold and so stayed green through the entire freeze. Threshold 96h clears a weekend plus a holiday Monday and would have fired on **day 5** of the 9-day freeze. Graded per ADR-0037: `high`, one fingerprint per site+feed with a 24h cooldown, tier-2 click to `/admin/mrc-scrape` — deliberately not a per-run page. A freshness query that throws fails the run loudly rather than degrading to `ok`.
- **A bounded catch-up.** `MYMRC_LIST_PAGE_SIZE` / `MYMRC_LIST_MAX_PAGES` widen the walk for a one-shot catch-up instead of an unbounded re-scrape; an invalid value warns and falls back. Measured outstanding gap at full depth: **7 processed + 69 outbound + 0 hauls = 76 records.**
- `stale_mirror` is rendered on the `/admin/mrc-scrape` status surface (amber, not green).

### Investigated, not changed

- **`undated:2301` on the inbound bridge is a genuine source gap, not a parse failure.** All 2301 rows carry `Docking_Appointment_Date__c` with a JSON `null` value and the companion time field as the empty template `"// : PT"`; dock door is null on 2301/2301. Across the whole table there are **0** cases of a payload date failing to reach its column (3955 → 3955). 1326 of the 2301 form one contiguous 100%-undated block (`H-060000`–`H-075999`).
- **Hauls disappeared-marking is over-broad** (pre-existing): the hauls view is a narrow 18-record active view but `markDisappeared` spans the whole table, so every unscheduled haul is stamped `disappeared_at`. The inbound bridge ignores that column, so ADR-0059 is unaffected; `expected_loads` does not. Documented in ADR-0070, not fixed here.

## 2026-07-31 — workbook-sync's five activation blockers are closed (ADR-0049 Amendment 3)

`workbook-sync` owns `processed_units_daily` and is running in production with Woodland's source `is_syncing = false`. The 2026-07-30 pre-activation assessment found five things that had to close before that flip: one that refused the real workbook outright, two that could write wrong figures silently, one that made the whole sync capable of going quiet with nobody told, and one that would have destroyed Vision-captured data. All five are closed. **`is_syncing` is unchanged — the flip is still the operator's call.**

### Fixed

- **The real June workbook was being REFUSED IN FULL, and now parses.** Amendment 1 correctly stopped the extractor coercing a blank cell to `0` on the billed production figures. But column E on Kelsey's actual Processed sheet is _blank_, not `0` — June had no non-program stripping and it was left empty — so post-Am.1 code produced 0 rows and `all_days_unusable` on all 23 days, which with `is_syncing` on is a refusal every 10 minutes and ~28 pages per business day forever. Measured against the archived June bytes: 0 rows before, **23 rows after, `failure === null`, `sum(stripped_program) === 17126`** — matching the workbook's own Processed SUM-row total and the MyMRC mirror at delta 0.0 on every one of the 23 days. A blank `stripped_program` still skips the day; only a blank _non-program_ cell on an otherwise-complete close reads as "none", and it is recorded as INFERRED (`stripped_non_program_inferred` on the audit row) so the trail never claims the sheet said zero.
- **A stale copy-forward row can no longer date a whole month into the previous one.** The parser derived the workbook's month from the _first_ dated inbound row it met and compared it to nothing, while the file name states the month and the engine already held it. One surviving July row in August's cleared-down file would have written every August day into July — over closed, billed figures, under workbook-wins, with the run recorded `ok`. The two are now cross-checked and a mismatch REFUSES (`month_mismatch`); any close date outside the file's own month is rejected. The file name also now _supplies_ the month when the workbook has no dated row yet, so the normal early-month shape works instead of failing; where no month exists at all the run is `skipped`, not failed, and pages nobody.
- **The billed columns are resolved from the sheet's header band, not from fixed ordinals.** `STRIPPED_PROGRAM = 4 / STRIPPED_NONPROG = 5 / MATERIAL = 10` rested on a comment noting the columns were stable across June and July (n = 2) — while the DAY inbound grid in the same file had always resolved by header text. One inserted column moved both ordinals onto different, still-plausible numbers, and nothing downstream could tell. Resolution now mirrors `findDayInboundHeader` (two-row band, leftmost match, so the repeated "Mid-month totals" labels don't win); an unrecognisable band REFUSES (`processed_columns_unrecognised`) rather than falling back. The material ticket has no header on the real sheet and is resolved by content instead; finding none means the workbook stated no ticket, which is null, not a refusal.
- **A renamed file no longer goes silent forever.** `not_found` logged at `info` and the ntfy calls lived only in the `catch` block it never reaches, so a rename, typo, stray `… (1).xlsm` copy or moved folder was invisible indefinitely. Staleness now pages: no successful read for 5 days, `high`, once per site per day. Five days rather than two because polling is Mon–Fri, and via duration rather than status because `not_found` on the 1st of a month is the correct expected state and identical per-poll to a rename.
- **An unreadable rollout state is no longer recorded as `ok`.** It was written `status: 'ok'` + `cutover_noop: true` — a row asserting a site was cut over when that is exactly what could not be read, while the sync silently stopped feeding Vision. The fail-safe direction is unchanged (an unknown cutover state still skips the poll); the recording is now `skipped` with `cutover_noop: false` and the reason on the ledger.
- **The refusal page-flood is fixed by moving the cooldown into the database.** The 30-minute per-fingerprint window lived in `src/lib/ntfy.ts`'s process-local `Map`, which every container restart wiped — hence ~28 identical pages per business day on a stuck refusal. `workbook_sources.last_alert_at` is a column. Regression-tested: 28 consecutive 10-minute polls against a permanently refused workbook publish one page.
- **A sync can no longer destroy a Vision-captured headcount, or silently transfer ownership of a row.** The workbook has no employees/processors columns, so the adapter reported `null` and `upsert.ts` treated that as a disagreement — nulling out numbers the manager close screen captures and the COR prefill consumes. Worse, `disagrees()` fired on the headcount _alone_, which rewrote `source` to `import` and permanently locked the ADR-0058 MyMRC bridge out of that row with no production figure changed. Workbook-wins is now per field: the stripped figures win unconditionally; `material_ticket_number` and `saved_units` win only when the workbook states a value; the headcounts are out of the payload and out of the comparison entirely.

### Changed

- `WorkbookSyncStatus` gains `skipped` — "nothing ran, and nothing is wrong". `workbook_sources` gains `last_success_at`, `consecutive_failures` and `last_alert_at` (migration `20260819_adr0049_workbook_sync_activation_guards`, purely additive, replayed on an empty PG16). "We polled" was a recorded fact and "we last got data on \_\_\_" was not, so a source dead for three weeks looked identical to a healthy one.
- The file watermark now advances only when the workbook was actually READ, so a `skipped` poll re-reads next time rather than marking the file done.
- `DailyProductionRow` no longer carries `employeesCount` / `processorsCount`. The real sheet has no such column and the sync never writes them; an always-null field is an invitation to wire it back up.
- The mock fixture can now model an inserted Processed column and an unrecognisable header band, so both sides of the A3 guard are exercised.

### Known cost, stated rather than left to be found

A row can now be **mixed-provenance** — production figures from the workbook, headcount from Vision — while `source` remains a single scalar reading `import`. `source` therefore describes the production figures, not the whole row; the per-field audit trail remains the record of what changed.

### Still open

`is_syncing` remains `false`. Prior-month grace window, backoff on re-_downloading_ an unchanged failing file, and ledgering the date range a run wrote are unclosed (ADR-0049 Am.2 B1–B3). The MyMRC scraper has produced nothing since 2026-07-20 and is still the only independent witness to whether the extraction is right.

## 2026-07-30 — workbook-sync's daily adapter now DERIVES its columns (ADR-0049 Amendment 1)

`workbook-sync` is the system of record for `processed_units_daily`, it is running in production, and its daily adapter was still matching a sheet named exactly `daily` with fixed columns A–G — a layout no real Woodland workbook has. Against Kelsey's file that produces either zero rows (silent) or the wrong columns written into production figures under workbook-wins. Meanwhile the engine already called the layout-aware `parseWorkbook` on the same bytes and threw away everything except `templateGeneration`, which it used in a log line.

### Changed

- **The adapter derives its rows from the layout-aware parse instead of guessing columns.** `deriveDailyRows` decodes the `daily_close` staging rows the semantic extractor produces from the Processed sheet — resolved by MEANING (row-2 section label → header signature → prefix-stripped name), which is what survives Kelsey renaming a tab. The adapter addresses no cell, column letter or sheet name of its own, and the bytes are now parsed once per poll rather than twice.
- **`templateGeneration` is load-bearing.** An `unknown` generation is refused rather than parsed hopefully.
- **The mock fixture mirrors the real workbook shape.** It used to build an invented `Daily` A–G sheet that cannot occur in production, so it proved nothing about production — it only made the broken adapter look green. It now builds a Processed sheet + DAY sheets, and deliberately carries no employees/processors columns because the real sheet has none.

### Fixed

- **A missing production figure is no longer written as 0.** `stripped_program` and `stripped_non_program` are billed figures; a blank cell now SKIPS and counts that day (the D11 mid-edit path, extended with a per-day reason and cell provenance) instead of defaulting. The section extractor was coercing both to `?? 0` in the staging payload; it now emits only what the sheet carries, so the ADR-0048 promotion decode refuses such a day too rather than consuming a manufactured zero.
- **"Cannot read" can no longer be recorded as "nothing to write".** Zero usable rows from a workbook with content now FAILS the run with the reason on `workbook_sync_runs.error_text`, writes nothing, and does not advance the file watermark: `unknown_template_generation`, `daily_section_unresolved`, `all_days_unusable` (names the day and the cell), `conflicting_duplicate_days`. A Processed section that resolved with zero day rows is the one clean zero — an empty month. This is the same silent-zero class as a null ctag read as "unchanged" and a missing baseline read as "no variance".
- **A workbook belonging to another site is refused.** The engine binds `site_id` from `workbook_sources`, so a mis-pointed `folder_path` would have written another site's figures under this site's key. When every source name the file resolves (via `source_aliases`, so spelling drift is tolerated) belongs to a different site, the sync refuses. A single in-site match or an unresolvable name clears the check — it fires only on affirmative evidence.
- **`saved_units` is read from the DAY sheets' own labelled "Saved" cell** (ADR-0037 §A.2) instead of being permanently null.

### Still gated

- **`is_syncing` remains `false`.** This change closes ADR-0049's D12 parser gate only; enabling real polling is the operator's flip.
- **One decision is open before that flip:** the workbook carries no employees/processors columns, so the adapter reports them null — and `upsert.ts`'s workbook-wins comparison will null out a Vision-captured headcount (audited, but destroyed). Narrowing workbook-wins to the fields the workbook actually carries is an operator decision, not a parser one. See ADR-0049 Amendment 1.

## 2026-07-30 — document ingestion now ABSORBS, and can measure itself (ADR-0069)

Shared-document ingestion captured but did not absorb. A document terminated at one `file_drops` row with `status: 'received'`; no parsed value reached a queryable table, a report, or any comparison against Vision's own numbers. `parse_summary` could not close the gap — it stores shape, not data, and on all three live documents it contains no usable figure at all.

### Added

- **`doc_reference_rows` — reference data, never operational data.** A confirmed daily-log workbook is now re-read from its archived R2 object and extracted into typed per-day rows with full provenance: which document, which revision, which sheet, which site. `workbook-sync` (ADR-0049) remains the **only** writer of `processed_units_daily`. There is no source discriminator that would let both pipelines write one table and no "upsert when workbook-sync hasn't" fallback — either would be a second writer wearing a disguise, and the collision would be discovered in payroll.
- **The reconciliation, at `/admin/doc-ingest/reconciliation`.** Per site and period: where the spreadsheet and Vision agree, where they differ and by how much. This is the instrument the migration was missing — "has Vision taken this over yet?" previously had no answer that was not a guess. Manager-reachable (site reach enforced server-side), because the person who can say which side is right for a given day is the manager who was there.
- **Extraction uses the layout-aware parser**, not `parse.ts`'s header guess. That guess takes the first non-empty row and is wrong on 3 of 3 live workbooks — every real one opens with a merged title row — so anything built on it would be built on sand.

### Fixed

- **Zero extracted rows now raises an anomaly instead of passing as success.** A zero is not "the document was empty"; far more likely the row adapter's layout assumption failed. The message names the template generation and the sheets actually seen. Every previous defect in this module was a zero or a null read as good news — a null ctag as "unchanged", a missing baseline as "no variance", a failed archive as "applied".
- **A document with no site REFUSES to absorb, loudly.** A NULL site is unclassified, never a guess. The refusal deliberately does not latch, so confirming the site on the queue is the entire fix — no re-trigger needed.
- **Every doc-ingest page is reachable by clicking, for the first time.** The single admin tile pointed at the connect page, whose only outbound link was back to `/admin`; the sources list, confirm queue, anomalies and health pages had no inbound link from anywhere in the app. Three documents had been waiting in a queue nobody could navigate to.

### Assessed and deliberately NOT done

- **`workbook-sync` was assessed for enablement and left off.** It is fully wired already — compose profile, cron daemon, internal route, business-hours gate, admin control — so this was never a wiring gap. It is blocked on substance: its daily-row adapter is still the Addendum-B fixture's column mapping by its own declaration (ADR-0049 D12), and the transport silently falls back to a fixture-seeded mock when Graph credentials are absent without the engine gating on it. Enabling it today risks writing fixture or mis-mapped figures over the 976 production rows. Conditions for enabling are in ADR-0069 §4. The absorption bridge is how the extractor gets validated against production first, at zero operational cost.
- The `parse.ts` header-row defect is real and still open. This change routes around it entirely rather than bundling a fix.

## 2026-07-30 — documentation: notify.ts coverage and ADR-0068 Amendment 1 corrections

### Fixed

`notify.ts` shipped with zero test coverage on the money path. The absence is now covered by assertions that prove the control works in both directions — approvals route to accounting, rejections and holds route to the manager, submissions route to the second approver, and the submitter is never on any list.

- **Mutation-tested for real.** Three defects were injected into the codebase and all three were caught by the suite: leaking the approved mail to the submitter, removing the beneficiary exclusion from `routing.ts`, and silencing the empty-audience report. The tests run the real `resolveReimbursementApproval` over a fake Prisma, mocking only the email transport itself.
- **An audit field now records what actually happened.** `sent_to_accounting_at` was stamped unconditionally after send, so an empty audience or disabled mail transport both read as success. It is now stamped only when the mail had a real recipient and the transport was live. Both failure modes push a `problems` entry naming the consequence.
- **The empty-recipient path is loud, not silent.** It returns `not_sent`, names the amount and beneficiary, says nobody was asked to sign, and sends no mail.

### Changed

ADR-0068 Amendment 1 corrects documentation-only contradictions between the record and production.

- **Production is live at both sites**, not in a staged pilot ramp. The ADR body described a ramp that does not exist and will not happen.
- **Reimbursement tile is now gated per site** via `UI_SURFACE.REIMBURSEMENT_TILE` in the rollout table. Eugene and Woodland can ramp independently without a deploy. The gate was created by the migration but nothing read it until now.
- **Proof the gate is wired, not merely present.** Service tests prove the decision path consults the rollout gate — that `canApproveReimbursement` is actually called, not a resolver nobody invokes.

## Unreleased

### Added — 2026-07-30 (reimbursements: primary-dashboard tile, digest, escalation, stamped PDF — ADR-0068 Amendment 2)

- **The tile is now on the PRIMARY dashboard.** Operator directive: _"the reimbursement tile is
  NOT a ipad surface it is a manager surface in the primary dashboard."_ It shipped only on the
  per-site dashboard, which looked fine in testing because a plain manager lands on their own
  site page — Bill does not. His account is admin with `primary_site_id = NULL` and
  `all_sites = false`, so he always lands on the picker and never saw it. One entry per
  reachable site, each with a live pending count; `N waiting for your signature` is counted from
  `routed_to_user_id` and gets the alerting colour, because that is the number that changes what
  you do next.
- **06:00 digest fold-in** as its own section, not merged into the invoice list — a
  reimbursement has no vendor, is aged from `submitted_at`, and needs two signatures at every
  amount. A pending reimbursement alone now sends the digest; otherwise the case that matters
  (empty invoice queue, unsigned reimbursement) would be suppressed as "nothing to report".
  Aged ones raise the whole digest and say why: _"Somebody is owed money."_
- **The 24-hour weekday timeout escalation**, riding the existing hourly AP tick rather than a
  second cron — a second scheduler is a second thing to notice has stopped. A row escalated
  IMMEDIATELY at submit time can never be re-escalated, because `escalated_at IS NULL` is both
  the candidate filter and the claim condition. Widening never relaxes the control.
- **The stamped decision PDF**, deliberately NOT via `ap/stamp.ts`: that renderer prints the
  FIRST party as "Approved by <name>", and on a reimbursement the first party is the SUBMITTER
  — so reusing it would print "Approved by Janette" on the document Mary files, which is the
  exact manufactured audit evidence this feature exists to delete. The segregation statement is
  VERIFIED before it is printed, and where it cannot be verified (free-text beneficiary, no id
  to compare) the document says so rather than overclaiming.

### Changed — 2026-07-30 (the AP-queue reimbursement badge is REJECTED, not deferred)

ADR-0068 §D7 wanted reimbursements interleaved into the AP queue. **It should not be built as
specified.** The AP queue has no site filter and gates on roster membership, so interleaving puts
a named employee, the amount they are personally owed, and a free-text purpose (which can carry
medical or financial-hardship detail) in front of managers at the other site. The two visibility
models point opposite ways: the AP queue is org-wide _because_ it is first-action-wins, while a
reimbursement can be acted on by exactly one person. It would grant four people read access to
personal financial data so one person can act — pure exposure, zero operational gain. Recorded as
rejected so it does not read as merely unfinished; a viewer-scoped count is the buildable form,
and it needs Bill's decision first.

### Fixed — 2026-07-30 (reimbursement notifications: the untested money path — ADR-0068 Amendment 1)

`notify.ts` shipped with **zero test coverage** while being the most dangerous file in the
feature: 269 lines, on the money path, fail-soft over an empty recipient set. Fail-soft over an
EMPTY audience is indistinguishable from success, and this repo has already been bitten by that
exact shape — `resolveSlotSigner` had tests that mocked the database into AGREEING with a
production-wrong query, and ops signers were never emailed while every surface reported success.

- **20 tests now cover it**, built to avoid that failure mode: the REAL
  `resolveReimbursementApproval` runs over a fake Prisma, and only `notifyStaff` (the email
  transport) is mocked — echoing its arguments back, so assertions are made against what the
  code really asked to send. Reimbursement suite total: **44 tests** (16 routing + 8 service +
  20 notify).
- **D6 is asserted in both directions, negatively as well as positively.** "Mary was emailed" is
  only half the control; "the submitter was NOT emailed" is the half that fails silently.
  Approved → Mary as sole primary and never the submitter; rejected/held → the submitting
  manager and never Mary; submission → only the routed second approver.
- **The empty-recipient path is asserted LOUD**, not silent: it returns `not_sent`, names the
  amount and the beneficiary, says "nobody has been asked to sign it", and emails no one.
- **Mutation-tested rather than trusted for being green.** Three defects were injected and all
  three were caught: leaking the approved mail to the submitter, removing the beneficiary
  exclusion from `routing.ts` (proving the real resolver is genuinely in the loop), and
  silencing the empty-audience report.
- **An audit field was recording deliveries that never happened.** Found while writing the
  tests: `sent_to_accounting_at` was stamped unconditionally, so an empty audience OR a disabled
  mail transport both left the row reading "handed off to accounting" when nothing was sent. It
  is now stamped only when the mail really had somewhere to go, and both failure cases report an
  explicit problem naming the consequence. The field has no readers anywhere in the codebase, so
  nothing depended on the old behaviour.

### Changed — 2026-07-30 (ADR-0068 corrected where it contradicted production)

Documentation-only. The control did not change; what the record says about it did.

- **Reimbursements are LIVE at both sites** — operator-ratified 2026-07-30, and
  `mary.scott@svdp.us` confirmed correct. The ADR body and the migration's "born pilot" comments
  described a staged pilot ramp that production is not in and is not going to be. Recorded in
  ADR-0068 Amendment 1 §A against the live rollout table.
- **The flip bypassed the audited `/admin/rollout` path**: `flipped_by`, `flipped_at` and
  `criteria_note` are NULL on all four rows, so the table cannot say who ramped it or on what
  criteria. Same pattern on `ipad_queue` and `ipad_inbound`. Tracked, not fixed — Amendment 1 §B.
- **The migration comment could not be corrected in place.** An applied migration is
  checksum-locked in `_prisma_migrations`; editing it would fail the `prisma migrate deploy` init
  container on the next deploy and the `migrate status` hard CI gate. The ADR is the correction
  of record — Amendment 1 §C.
- **Two wrong counts and a dangling decision numbering fixed.** Commit `decad39` claims FIVE
  CHECK constraints; there are **four**. This ADR claimed 16 unit tests; there were **24**.
  `notify.ts` and `routing.ts` cited `D8`/`D10`/`D6`/`D4` from an earlier draft numbering — the
  ADR only ever had D1–D7, so those comments pointed at decisions that exist in no document.
  Renumbered onto the real decisions. Amendment 1 §F.

### Added — 2026-07-29 (employee reimbursements: dual approval — ADR-0068)

Mary Scott escalated a real segregation-of-duties failure: Janette was approving her own
reimbursement submissions. Vision had no concept of who ORIGINATED a request — it knew who
forwarded it (Mary) and who approved it (Janette), while the originator existed only as ink
inside a scanned PDF. The approval stamp was manufacturing audit evidence for a review that
never happened, which is worse than having no control at all.

- **The Employee Reimbursement tile** is live on the site dashboard, with a structured intake
  form that retires the paper form. Because the submitter is authenticated, "who originated
  this" becomes a stored fact — which is what turns "the submitter cannot approve" from a
  detection problem into a constraint.
- **Two signatures on every reimbursement, no dollar threshold.** Deliberately stricter than
  vendor invoices, where only >= $1,000 needs a second: a reimbursement pays an insider
  against a form an insider wrote, with no external counterparty.
- **Enforced in THREE layers** — a database CHECK, the server-side resolver, and the UI.
  Verified by replaying the whole migration chain on an empty PG16 and driving hostile INSERTs
  at it: Janette-approves-Janette refused, Janette-submits/Morena-approves accepted.
- **The beneficiary can never approve either**, which Bill's stated rule did not cover: Morena
  submitting FOR Janette would otherwise route straight to Janette. That escalates to an admin
  IMMEDIATELY, not after 24h — no valid local approver exists, so waiting achieves nothing.
- **Free-text beneficiary names fail safe**: an ambiguous single-token match escalates rather
  than guessing, because a wrong answer pays someone against their own signature.
- **Approved goes to Mary as sole recipient**, never back to the submitter. Rejections and
  holds go to the submitting manager with the note.
- One routing table, one resolver — a thin wrapper over ADR-0066's, not a fork. Forking would
  recreate the outage shape with a third answer.

Deferred and tracked in ADR-0068 (none weakens the control): the AP-format stamped PDF, the
plain 24h timeout escalation, the 06:00 digest fold-in, and the AP-queue type badge.

### Fixed — 2026-07-29 (the delta pass was silently freezing ingestion — ADR-0067 Amendment 6)

Found by an independent architecture review, then **confirmed on the live database**: the one
document in the system had already stopped being ingested, permanently, while every sweep
reported `status: ok`.

- **A delta page may SUPPLY a content marker, never REMOVE one.** Microsoft omits `ctag` from
  delta results on OneDrive for Business, and `applyDeltaItems` wrote it back unconditionally
  — blanking a good marker on every pass. `ingestSource` then read the null and returned
  `unchanged`, which is indistinguishable from success. Live evidence before the fix:
  `doc_sources.ctag = NULL` while the version row held
  `c:{58DD7F92-…},2977`. This is the exact silent-staleness class ADR-0067 exists to prevent
  (ADR-0057 D9), sitting inside the mechanism built to prevent it.
- **A missing marker now RECOVERS or ALARMS.** `ingestSource` re-reads the item from Graph to
  recover the marker, and raises a `download_failed` anomaly if it cannot. "I no longer know
  whether this changed" must never be reported as "nothing to do". This second fix matters
  more than the first: it closes every future cause, not just the known one. **A test had
  pinned the defect in place**, asserting `unchanged` for a null ctag — replaced.
- **Confirmation gates interpretation, not intake — and three shipped strings said otherwise.**
  `doc_class` gates no admission anywhere in `ingest.ts`; an unconfirmed document is downloaded,
  archived and applied like any other. `messages.ts`, `SourcesClient.tsx` and a live anomaly
  Bill reads all claimed _"nothing is ingested until you confirm"_, and a test asserted the
  false string. The behaviour is right — capture-then-label, landing in the operator inbox at
  `status: 'received'`, never a computed figure — so the copy was fixed, not the code.
- **One transient Claude timeout no longer freezes a proposal forever.**
  `classification_attempted_at` was stamped even on a failed fallback, and the staleness gate
  then suppressed every retry until new content landed. Only a completed attempt counts now.
- **Correction: Amendment 4 §D over-generalised.** "There is nothing to subscribe to, at any
  permission level" is false; the true claim is narrower (no target for _item-level shares in
  personal OneDrives_). A SharePoint **list** is subscribable at `/sites/{id}/lists/{id}` on
  delegated **`Sites.Read.All`** — which we already hold. Push is available today, with no
  scope widening, for documents in a library. C-44 remains correctly closed.

### Added — 2026-07-29 (register a shared document by URL — ADR-0067 Amendment 5)

`sharedWithMe` returns **one** item in this tenant while at least two documents are
genuinely shared with the service account — the second is an Outlook-attachment share that
appears in no enumeration route at all. Amendment 3's proposed replacement (`remoteItem`
shortcuts under `/me/drive/root/children`) was measured live and is **empty**: switching to
it would have taken discovery from one source to zero. Bill's constraint is the reason —
_"I shared files not folders"_ — and nobody should have to click "Add shortcut to My files"
for a document to be seen.

- **Paste a document URL at `/admin/doc-ingest`** and Vision resolves it through
  `GET /shares/u!{base64url}/driveItem`, then registers it via the **same `upsertSource`**
  discovery uses — so classification, the confirm queue, the guardrail, the audit trail and
  the kill switch behave identically however a document arrived. Admin-only, audited with
  `registered_via: 'sharing_url'`, idempotent.
- **Read-only, enforced by an omission.** The documented `Prefer: redeemSharingLink` header
  would grant durable access to the item — a permission change — so it is never sent, and a
  test asserts it. No scope widening: this runs on the `Files.Read.All` already held.
- **Four failures get four sentences.** A revoked share (403), a deleted file (404), a
  mistyped link (400) and a halted connection (503) need four different things from Bill.
- **`owner_upn` is finally populated.** `sharedWithMe` carries no owner facet, so every
  source had NULL and the "owner left the org" alert — which buckets by owner and skips
  nulls — could never fire. One `getItem` when a file first appears fills it from
  `createdBy` (never from `sharedBy`: the colleague who forwarded a workbook is not its
  owner, and the alert names the person who left). The first cut of this was **inert**
  despite passing every create-path test — the update branch rewrote `owner_upn` from the
  null-bearing projection on the next sweep, silently erasing it 15 minutes later. Now a
  known owner is only replaced by another known owner, and existing NULLs are backfilled.

### Fixed — 2026-07-29 (first live document exposed five defects — ADR-0067 Amendment 4)

TEREX.xlsx, the first real document through the pipeline, was proposed `unknown` with the
reasoning _"the workbook is completely empty"_ — about a workbook whose own stored parse
summary recorded **40 sheets and 2,117 rows**. Reported as a parser bug. It was not one:
`parse.ts` needed no change and is unmodified.

- **Classification ran before the document was fetched.** `sweep.ts` called
  `classifySourceIfNeeded` before `ingestSource`, but ingest is what creates the version
  row holding `parse_summary` — so every brand-new source was classified from `null`. The
  anomaly asserting emptiness was written **1.5 s before the parsed content existed**. The
  comment justifying the order was wrong on its own terms (it cited the guardrail, which
  reads `doc_class`, a column classification never writes). Ingest now runs first;
  `classifySourceIfNeeded` **refuses** a file with no version at all; and the prompt now
  renders `NOT AVAILABLE` distinctly from a parsed-but-empty document, with an explicit
  instruction not to infer emptiness. A model asked to judge nothing will confidently
  describe nothing, and that reads exactly like a finding.
- **A stale anomaly outlived its evidence.** The second sweep classified correctly, but
  nothing closed the `unclassified` anomaly — only Bill's confirmation did, which he would
  never give while the surface told him the file was empty. Two operator surfaces
  disagreeing about one document. Now reconciled automatically.
- **Re-classification is gated on new content.** It re-ran every sweep for every
  unconfirmed source: ~96 Claude calls/day per document, each silently overwriting the last
  proposal.
- **The subscription table leaked a row per sweep, unbounded.** The existing-row lookup
  matched only `pending`/`active`, so a `failed` row matched nothing and a fresh row was
  inserted every cycle — 96/drive/day, each one adding a delta pass to the sweep. Now one
  row per drive, retried **into** on exponential backoff (one sweep interval → one day),
  preserving `delta_link`. Of everything here this was the only defect that degraded
  without bound.
- **The 403 explanation was FALSE and its advice was dangerous.** `SUBSCRIPTION_SCOPE_NOTE`
  claimed Microsoft requires delegated `Files.ReadWrite.All` for driveItem subscriptions and
  invited Bill to trade tenant-wide **write** access for lower latency. Microsoft documents
  **`Files.Read.All`** — which Vision already holds — and explicitly does not accept write
  permissions where read permissions suffice. The real blocker is the resource: on OneDrive
  for Business a subscription may only target a **drive root**, never an individual file,
  and Vision reaches these documents through item-level shares. No grant fixes it. It went
  unnoticed because the detection regex (`/403|forbidden|accessDenied/i` against a message
  reading `access denied for POST /subscriptions`) could never match, so the wrong
  explanation was never shown. Detection is now by error type; the note warns **against**
  the grant it used to recommend. **C-44 is closed, not decided.**

### Added — 2026-07-29 (shared-file document ingestion PIPELINE — ADR-0067 §3.2 D4–D8 / §3.4, PR #179 Phase 3)

The foundation (2026-07-29, same ADR) landed the delegated Entra connection and the five
tables. This is the part that actually ingests: discovery, change subscriptions, the delta
sweep, the classifier, and the anomaly guardrail.

- **The delta sweep is the correctness path, and it is not optional.** A new
  `doc-ingest-sweep` container runs `runDocIngestSweep` every 15 minutes on a schedule that
  is **independent of webhook health** — it never checks whether a subscription exists and
  never skips because a notification arrived. §3.2 D4 forbids a webhook-only path for a
  specific reason: push fails SILENTLY when a subscription lapses or a notification is
  dropped, which is exactly how MyMRC ingested nothing for months while every surface
  reported success (ADR-0057 D9). Push buys latency; the sweep buys correctness. A
  `doc_ingest_sweep_runs` ledger row is written on **every** run including a throw, so
  "the sweep has not run since Tuesday" is visible instead of silent.
- **Discovery keyed on the immutable driveItem id (D8).** A rename is not a new file, a
  move is not a new file, and two people sharing one document is not two documents.
  `projectDriveItem` unwraps the `remoteItem` facet so a source is keyed on the drive that
  really hosts it, not on the local stub `sharedWithMe` hands back. Shared FOLDERS are
  traversed to a configurable depth (default 5) so files added later are picked up — and
  hitting the depth limit raises `depth_limit_reached` rather than quietly excluding them.
- **Change subscriptions + the validation handshake**, with `clientState` minted per
  subscription, stored **only as a SHA-256 hash**, and verified in constant time on every
  inbound notification. `/api/doc-ingest/notifications` is the one route here that cannot
  be loopback-gated (Graph must reach it), so that secret IS the authentication.
  Auto-renewal runs 24 h ahead of expiry. **§A.9: a failed handshake never silently
  degrades to polling-only** — it is reported, with the latency cost stated plainly.
- **Classifier (D5) — classify once, confirm once, then LOCKED.** Local heuristics first
  (filename, folder path, sheet names, header vocabulary), Claude API fallback only on weak
  local confidence, reusing the ADR-0046 Amendment 5 D-M5-2 hybrid shape and the existing
  `ANTHROPIC_API_KEY`. A non-null `doc_class` IS the lock — there is no second boolean to
  drift out of agreement with it, and the pipeline never re-asks. `unknown` is a
  first-class, graceful outcome (Bill pre-registers nothing, so it is the NORMAL path for a
  new share): it queues and waits for him, it does not error, and it never pages.
  A **vendor invoice is recognized so it can be REFUSED** — it is not routed here, and the
  flag names `ap@svdp.us` (ADR-0046) as the correct address.
- **Auto-flow (D6) + the anomaly guardrail (D7).** After confirmation, changes propagate
  automatically — per-change approval would defeat the feature. The guardrail replaces that
  gate by catching _abnormal_ changes: an aggregate past the variance threshold, a
  previously-populated column emptied, more than 10 % of rows lost, or a document that no
  longer parses as its registered classification. Those STAGE and page; everything else
  flows, and **every auto-applied change writes a full before/after `audit_log` entry in
  the same transaction as the state change.**
- **One variance concept in the system, not two.** The aggregate check calls
  `evaluateVariance` from ADR-0046 Amendment 5 (D-M5-4) — the same pure either-trips
  function and the same $50-flat / 15 % constants the AP approver panel enforces, imported
  rather than redefined. A test pins both values so a future tuning cannot silently fork
  them.
- **Every D8 condition has a test and a defined non-silent behaviour**: share revoked
  (`access_denied`, deliberately NOT folded into "disappeared" — they need different
  operator action) · owner leaves (`owner_lost`, inferred from every one of that owner's
  shares vanishing at once, and the alert NAMES them) · renamed · moved · deleted
  (last-known state retained) · shared twice (deduped, with the count as evidence) · folder
  shared (later additions picked up) · nested folders (depth limit) · **`.xlsm` macro
  workbooks parsed WITHOUT executing macros** (exceljs has no macro engine; tested against
  real OOXML bytes) · password-protected (marked, paged once, then LATCHED — never retried
  in a loop) · oversize (streamed with a cap; exceeding it PAGES rather than silently
  truncating, because a truncated workbook parses cleanly and yields wrong numbers) ·
  subscription lapse · tenant auth failure (halts cleanly, never a silent no-op).
- **Surfaces (§3.4)**: `/admin/doc-ingest` (sources + the confirm queue),
  `/admin/doc-ingest/anomalies` (before/after diff, apply or discard),
  `/admin/doc-ingest/health` (sweep freshness FIRST — a page that led with "3 active
  subscriptions" would look healthy while the correctness path was dead).
  `/admin/file-drop` now shows the ingest source for non-manual rows.

### ⚠ Two findings from the live Microsoft documentation that Bill must decide on

- **`GET /me/drive/sharedWithMe` is DEPRECATED.** Microsoft deprecated it (and
  `/me/insights/shared`) in November 2025; both "operate in a degraded state until
  November 2026, after which [they] stop returning data", and Microsoft has published **no
  one-to-one replacement**. That API _is_ discovery — the entire D1 premise rests on it.
  Discovery therefore goes through a `SharedItemSource` seam so the enumeration can be
  swapped without touching traversal, dedup or reconciliation, `/admin/doc-ingest/health`
  renders a live countdown, and it is logged in `docs/OPEN-ITEMS.md` as **C-43**. A
  speculative Search-API replacement was deliberately NOT shipped: it cannot be verified
  against the live tenant today, and an unverified fallback that silently returns a
  DIFFERENT set of sources is worse than a loud countdown.
- **Change subscriptions need `Files.ReadWrite.All`.** Microsoft's own permissions table
  for `PATCH /subscriptions` lists the delegated permission for a `driveItem` subscription
  on OneDrive for Business as **Files.ReadWrite.All**. This integration holds
  **Files.Read.All** by design (ADR-0067 D5, read-only, no write path anywhere). So Graph
  is expected to refuse subscription creation with a 403 — the code still attempts it (so
  the day the scope changes, push starts working with no code change), records the refusal
  with that explanation, and leaves the sweep carrying correctness exactly as D4 requires.
  Granting write access across every drive shared with the account, permanently, to save
  minutes of latency on data the sweep already delivers, is **Bill's call, not a defect to
  fix** — logged as **C-44**.

### Added — 2026-07-29 (AP equipment ESCAPE HATCH — ADR-0046 Amendment 9, PR #179 Phase 2 §2)

An approver holding an invoice for a machine the fleet registry does not carry had
exactly two options, and both were lies: pick a wrong-but-plausible asset, or tick
"Not equipment-related". Either way the invoice was filed against the wrong thing and
nothing recorded that the registry was incomplete. Per **C-28** that is not a corner
case — the ADR-0062 seed is a coarse jurisdiction mapping of an SVdP machine list with
no "DR3 Eugene" facility at all.

- **A third, equally explicit choice on the Approve panel** — _"Equipment not in list —
  describe it"_ — three-way mutually exclusive with the multi-select and "Not
  equipment-related". A REQUIRED free-text description unblocks the approval and files a
  tracked `ap_equipment_requests` row **in the same transaction as the decision**.
  **Not a bypass:** it costs more than the two lies it replaces, not less, and every other
  Amendment 5 requirement (vendor, explanation, confirmed amount, variance ack) still applies.
- **The exactly-one-disposition rule moved into Postgres.** `ap_equipment_links` now carries
  a CHECK over all three dispositions — the invariant used to be app-enforced, and a third
  option is exactly the change a pairwise app check silently outgrows. A second CHECK
  requires a `resolved` request to name the asset it produced and a `rejected` one to carry
  a non-blank note. **Both replayed against live production inside `BEGIN; … ROLLBACK;`:**
  all 17 existing link rows satisfy the new constraint, and four negative cases were each
  rejected by Postgres.
- **`/admin/ap/equipment-requests`** — the resolution worklist, linked from the equipment
  hub. Ages are **Pacific calendar days** (ADR-0065 helpers; the container runs UTC and
  would otherwise report this afternoon's request as a day old). **Resolve** reuses the
  EXISTING ADR-0063 create form, pre-filled from the description, and — the payoff —
  **repoints the original `ap_equipment_links` row at the new asset**, so the historical
  invoice ends up correctly attributed. Create + stamp + backfill are one transaction
  (`createEquipmentInTx`); a second transaction would strand an orphan asset on failure and
  wedge the retry on the `(site_id, display_name)` unique. **Reject** requires a note and
  **leaves the invoice approved** — bookkeeping cleanup, never a reversal. Nothing is ever
  hard-deleted.
- **ACCESS is admins PLUS site managers** — a deliberate, documented exception to
  "`/admin/*` is admin-only", gated on a narrow `users.can_resolve_equipment_requests` flag
  in the `can_view_ap_history` shape. The people who know the fleet are the site managers;
  funnelling every unknown asset through the one admin rebuilds the bottleneck the hatch
  exists to remove. Admin **powers** still gate on `role === 'admin'`; the flag unlocks this
  worklist and nothing else, is read fresh from Postgres every request, and site reach is
  re-derived from the ROW in the API so a single-site manager cannot act on the other site.
  Seeded for Morena, Janette (Woodland) and Rick (Eugene) — **matched on email, never name**,
  because each also has an email-less operator PIN account a name-keyed seed would hit.
- **EMAIL ONLY to the site managers, Bill CC'd** (hard rule #5 — no ntfy for staff), through
  `notifyStaff()` on its OWN rollout surface `ap_equipment_request`, per-site, born `pilot`
  so Bill can ramp it independently of the AP new-invoice broadcast. The copy leads with the
  ask and credits the approver by name: this is a request to create a properly-formed asset
  record, not an error report, and if it reads as one the next approver goes back to ticking
  "Not equipment-related". With no granted manager at a site the mail goes TO the admins —
  ADR-0066 §B.5 is the record of what a fail-soft send to nobody costs.
- **Ops Dashboard tile** with an open-count badge, site-scoped. Distinct from the AP badge:
  two queues, two owner sets.

### Added — 2026-07-29 (Shared-file document ingestion FOUNDATION — ADR-0067 + Amendment A, PR #179 Phase 3)

Bill hand-uploads every document Vision needs. This lands the foundation for stopping that:
files **stay where they live in Microsoft**, shared to `docs-dr3@svdp.us`, and Vision reads
the **live document**. An emailed attachment is a _snapshot_ — it stopped tracking its source
the instant it was sent. A shared file is _current state_. That distinction is the whole ADR,
and it is why the schema is version-aware rather than drop-shaped.

- **Auth is delegated authorization-code + refresh token. NOT ROPC.** Amendment A supersedes
  the directive's §3.5 entirely. §3.5 reasoned "unattended operation ⇒ non-interactive sign-in
  ⇒ ROPC ⇒ negotiate Conditional Access with IT"; every step after the first is wrong.
  Unattended _operation_ does not need unattended _sign-in_. Bill signs in **once**,
  interactively, in a browser, as `docs-dr3@svdp.us`, completing MFA — and the refresh token
  is redeemed indefinitely with nobody present. **No CA change needed**: the MFA claim rides
  the token chain. An IT policy negotiation is replaced by one browser click.
- **The service-account password is NOT a runtime credential**, and there is deliberately no
  column, field, or env var for it anywhere. It is typed once into Microsoft's own sign-in
  page. This is the regression check: if a future change needs it at runtime, that change has
  reverted to ROPC and is wrong.
- **The signed-in account is ASSERTED against Graph `/me`, and a mismatch is REFUSED** with no
  token persisted. This is the control that matters. Bill is already signed into Entra; the
  browser would happily reuse that session and the flow would **succeed** — leaving Vision
  reading _his personal OneDrive and everything shared with him_ instead of the service
  account's curated shares. It would look like it worked. Three layers guard it:
  `prompt=login` (no silent SSO reuse), `login_hint` (right thing is the easy thing), and the
  server-side `/me` assertion (the actual control). The connect page names the account
  explicitly in both states, and says plainly which wrong account was used on refusal.
- **`reauth_required` halts ingestion LOUDLY.** Any refresh failure attributable to a dead
  token pages `dr3-vision-system` immediately on the transition (ADR-0057 D9 posture), raises
  a banner + Reconnect, adds a line to Bill's 06:00 digest until resolved, and stops. Nothing
  degrades quietly. **Only a dead token latches** — `invalid_grant` / `interaction_required` /
  `consent_required` / `login_required`; a network blip, 429 or 5xx is recorded and retried,
  because paging for a hiccup teaches the operator to ignore the page that matters. The dedup
  ledger is the Postgres column `reauth_paged_at`, **not** the ntfy helper's per-process cache
  — ingestion spans the app and a worker and containers restart, and a per-process cooldown
  would either re-page on every restart or suppress the _first_ page after one.
- **Schema, all additive; every existing row keeps working.** `doc_sources`,
  `doc_source_versions`, `doc_ingest_subscriptions`, `doc_ingest_anomalies`, plus
  `doc_ingest_connections` (the Amendment A addition), plus `file_drops.ingest_source`
  (`manual` | `email` | `shared_file`, default `manual`) and `file_drops.doc_source_id` FK NULL.
  No backfill: pre-existing drops **were** manual uploads, so the defaults are simply true.
  `id` columns are **TEXT, not `uuid`** — a `uuid` id passes CI (no migrations there) and fails
  only on deploy. **Validated against LIVE PROD in a `BEGIN; … ROLLBACK;`**: all 5 existing
  `file_drops` rows read `manual`/NULL, all 18 id-shaped columns are `text`, the
  `(drive_id, item_id)` natural key rejects a dupe, and the anomaly partial-unique dedups
  OPEN rows while still permitting a RESOLVED row with the same fingerprint.
- **§A.5 — OneDrive provisions asynchronously, and a 404 is NOT an error.** The drive is created
  by the account's first interactive sign-in — the very one this flow performs. `probeDefaultDrive`
  never throws and never fails the connect; a 404 renders as "still provisioning, this is normal".
- **One app registration, one secret, and a coupling worth remembering.** Reuses
  `2da92424-…` — the same registration AP mail (ADR-0046) and Graph Files (ADR-0049) use;
  `readClientSecret()` falls back to `MSGRAPH_MAIL_SECRET` specifically so nobody mints a
  second secret. ⚠ `DR3-Vision Production` is valid to **2028-05-05**, and it is shared: a
  silent expiry stops AP mail polling **and** document ingestion at the same moment, presenting
  as two unrelated outages. Surfaced on the connect page; belongs in the rotation runbook.
- **New surfaces:** `/admin/doc-ingest/connect` (admin-only) + `POST /api/admin/doc-ingest/oauth/start`,
  `GET …/oauth/callback` (the registered redirect URI), `GET …/status`. CSRF state and the PKCE
  S256 verifier ride a sealed AES-256-GCM httpOnly `SameSite=Lax` cookie rather than a table —
  no TTL sweeper for data needed for one round trip. Lax specifically: the callback is a
  top-level GET from `login.microsoftonline.com`, and Strict would withhold the cookie and fail
  every attempt. Status responses SELECT no ciphertext column, so they cannot leak a token.

**Not built here** (next phase): Graph change subscriptions, the delta sweep, the classifier,
and the anomaly guardrail. Tables, enums and indexes exist for all four; `acquireAccessToken()`
is the auth seam and `latchReauthRequired()` / `recordTransientRefreshFailure()` are the failure
seams.

**Unverified:** nothing here has executed against the live tenant. The migration is proven
against live prod (rolled back); the flow is proven against stubbed Entra/Graph responses.
First contact happens when Bill clicks Connect.

### Added — 2026-07-29 (AP second-approval escalation runs on a weekday clock — ADR-0066 §1.5)

The backstop half of ADR-0066. Person-to-person routing decides _who_ a second approval
goes to; this decides what happens when that person does not act. An hourly scanner
(`scripts/ap-escalation-scan.mjs` → `/api/internal/ap/escalation-scan` →
`runApEscalationScan`) reads every open `pending_second_approval` with
`escalated_at IS NULL` — exactly the `ap_requests_pending_second_escalation_idx` partial
index — and escalates anything past its routing pair's `fallback_after_hours`.

- **The clock is a weekday clock.** Bill's decision verbatim: _"weekdays only. The clock
  pauses Friday evening and resumes Monday."_ A request first-approved **Friday 4pm does
  not escalate Saturday — it escalates Monday 4pm**, the 24th business hour. Asserted
  directly, at all three instants. Accrual reuses the shared `business-clock.ts`
  (`businessHoursElapsedExceeds`) rather than introducing a second calendar; holidays pause
  it only when observed at **every** site, since escalation is per-person and no longer
  carries a site.
- **Escalation is ADDITIVE, never a transfer.** The originally routed peer stays able to
  sign; the fallback approver becomes _additionally_ able; whoever acts first completes it.
  The widening itself is not re-implemented here — it is
  `resolveSecondApproval(…, { escalated: true })`, the same function the authorization
  check consumes. Re-deriving it is how the two halves drifted apart in the first place.
  A test signs in as the peer **after** escalation and asserts they are still authorized.
- **Idempotent on `escalated_at IS NULL`,** enforced twice: in the candidate query and
  again as a conditional predicate on the claiming `updateMany`. The second is the one that
  matters — two overlapping scans (a slow run meeting the next hourly fire, or a restart
  mid-run) can both _read_ a row, but only the write that flips a still-NULL row wins.
  Proven by running the scan twice and asserting **exactly one notification and exactly one
  audit row**.
- **No routing row ⇒ escalate immediately** (§1.4, no 24h wait) and raise the routing
  alarm. The scanner reads the resolver's `outcome: 'fallback_no_routing_row'` rather than
  re-deriving the condition.
- **Staff are notified by EMAIL, never ntfy** (hard rule #5). A new
  `notifySecondApprovalEscalated()` routes through `notifyStaff()` (ADR-0047 chokepoint,
  `ap_notify` gate) filtered by each person's `second_approval_request` pref — it exists
  precisely _because_ reusing `notifySecondApprovalNeeded()` would have pushed a staff
  workflow nudge onto Bill's phone every hour. Only the people escalation **added** are
  emailed; the peer already has the original request and is not re-sent it hourly. The copy
  leads with "this is additive, not a hand-off," because that is the semantic operators
  get wrong.
- **Fail loud (§B.8 / ADR-0057 D9).** A scan that cannot run **pages `dr3-vision-system`
  and re-throws** so the route 500s — it never returns a clean, empty result
  indistinguishable from a healthy backlog, which is the exact shape of the outage this ADR
  exists to fix. A single poisoned row is contained (the rest of the backlog still
  escalates) but still pages. 6h cooldown, mirroring the AP poll deadman class.
- **Every escalation is audited** in the same transaction as the stamp
  (`actor_label='system:ap-escalation-scan'`, before/after JSON). The `after` records
  `still_authorized` so an auditor can read straight off the row that the peer was never
  removed.
- **Compose:** `dr3-vision-ap-escalation-scan`, mirroring `ap-approver-expiry` (thin
  scheduler, `cron.env` bearer, `INTERNAL_BASE_URL: http://app:3000`, healthcheck disabled,
  `mem_limit`/`pids_limit`). It deliberately does **not** mount `ntfy.env` — the two
  system-level pages this feature raises are published by the `app` container; mounting it
  here would document a path that does not exist. Guarded by a compose-wiring test.
  Deploy is manual on svdp-dev; **not deployed by this change.**
- Unlike every sibling daemon the scheduler carries **no Pacific offset-reprobe math** —
  it fires hourly, and an hour is an hour in every zone. Pinned across both DST transition
  days so nobody "fixes" it back into wall-clock arithmetic.

### Added — 2026-07-29 (`/admin/ap/routing` + `/admin/ap/notifications` — the AP configuration screen — ADR-0066 §1.4/§1.6, Amendment 1)

ADR-0066 shipped person-to-person routing and per-user notification prefs as **data with no
UI**. Both tables could only be changed by writing a migration — wrong for a design whose
premise is "staff change, code should not" — and the resolver's own warning already told
admins to "configure the pair at `/admin/ap/routing`", a route that did not exist.

- **One screen behind two routes.** `/admin/ap/routing` and `/admin/ap/notifications` render
  the same component; the route only decides which tab reads as current. Bill: _"two separate
  pages for six rows of config is worse."_ The routing filter is carried across the
  cross-link by one serializer (`src/app/admin/ap/config/list-url.ts`) per ADR-0017
  Amendment 1; saves `router.refresh()` and never navigate, so the URL view state survives.
- **The pickers are keyed on REACHABILITY — active, manager/admin, and holding an email.**
  This is the same lesson the migration seed had to learn the hard way: Bill, Janette and
  Morena each have a second, **email-less operator PIN account with the same name** (created
  2026-07-28 for the iPad rollout). A name-keyed picker would let an admin select one and the
  routing table would read as fully populated while every notification resolved to nobody —
  the outage, reintroduced through its own admin screen. Every option is labelled with its
  email so two same-named accounts are distinguishable at the point of choice, and the
  excluded namesakes are **disclosed** in the UI rather than hidden.
- **Self-approval is impossible at three layers**: the picker never offers the first approver
  as their own peer, the server rejects the pair before writing, and the DB
  `CHECK (first_approver_id <> second_approver_id)` backstops both. The constraint violation
  is caught by name and returned as a readable 422, not a 500.
- **The totality requirement is now visible.** The screen enumerates active manager/admin
  accounts, diffs them against active routing rows, and renders the gap in the same words the
  resolver reports to the 06:00 digest. Graded `error` for an admin or an `ap_approvers`
  roster member (they can first-approve today) and `warning` for an approver-role account
  that would degrade silently the day they are added. Unreachable second approvers and
  unreachable fallbacks are reported the same way.
- **Prefs render EFFECTIVE values.** A user with no row shows the column defaults badged
  "Defaults" — a missing row means defaults, never "notify nobody", and blank checkboxes
  would misrepresent what the sender does. The first write materialises the row **from the
  defaults**, so flipping one event never switches the other three off.
  `second_approval_request` is captioned in full because the obvious reading of it is wrong:
  it is never a broadcast, and the toggle can only remove a person from their OWN routed
  requests.
- **`decision_outcome` is rendered and refused** — disabled, badged "Not wired", and rejected
  by the API. It has no send path; making it writable would promise an email nobody sends,
  and hiding it would leave the column undocumented exactly where it is configured.
- Every mutation writes its `audit_log` row (`ap_approval_routing` / `ap_notification_prefs`,
  before/after JSON) **in the same transaction** as the write. Admin-gated on
  `role === 'admin'` at both the page and API layers — never the `all_sites` reach flag.
- New `/admin` hub tile. 44 tests across the API, the screen and the URL serializer.

### Fixed — 2026-07-29 (AP second approvals reached nobody — person-to-person routing — ADR-0066)

Invoices >= $1,000 transitioned to `pending_second_approval` correctly and then sat
indefinitely with **no ntfy and no email**. Root cause is an authorization/notification
divergence: `canFulfillSecondApproval()` accepted admin-eligibility, while
`activeSecondApproversForSite()` queried the `ap_second_approvers` site roster **alone**.
Bill was deliberately never given a `woodland` roster row _because_ admin-eligibility
covered his authority — so every Woodland second-approval resolved to an **empty
recipient set**, and because the notify path is fail-soft it sent nothing and raised
nothing. Shannon (an explicit `eugene` row) was notified normally, which is why it looked
healthy from the Eugene side.

- **Routing is now person-to-person** (`ap_approval_routing`), keyed on who signed first:
  Janette<->Morena, Kelsey->Morena, Rick<->Shannon, Bill->Morena. Data-driven, with a DB
  `CHECK (first_approver_id <> second_approver_id)` so self-approval is impossible at the
  storage layer. The table is total — an approver with no row falls back **immediately**
  (no 24h wait) and raises a digest warning.
- **One shared resolver** (`src/lib/ap/second-approval-resolver.ts`) is consumed by BOTH
  the authorization check and the notification lookup, so they cannot drift apart again.
  **The invariant — recipients non-empty whenever authorization is non-empty — is asserted
  directly**, for every roster member and for an approver with no routing row.
- **Empty recipient set is now an error condition**, not silence. Fail-soft still never
  rolls back an approval, but the resolver reports `problems` and the caller alarms on
  them. The alarm **emails Bill as well as paging ntfy**, as defence-in-depth: an alarm
  about undelivered notifications should not itself depend on a single delivery path.
  **Correction (same day):** the ADR originally guessed Bill's ntfy topic subscription was
  why second-approval pages never reached him. That is FALSIFIED — a diagnostic publish to
  `dr3-vision-system` (HTTP 200, id `mgTbY3HYWq5P`) arrived on his phone and `noc-reader`
  holds read access to `*`. The ntfy leg's historical failure is unexplained and recorded
  as an open question rather than a guessed cause; the app container has since been
  recreated, so the deciding logs are gone. The EMAIL leg's empty recipient set is proven
  and is what this change fixes.
- **Per-user, per-event notification prefs** (`ap_notification_prefs`) replace what would
  have been a hardcoded exception. **Shannon now receives exactly one kind of email — a
  second-approval request on Rick's first signature — and nothing else, asserted in a
  test.** `decision_outcome` ships as a column, all false: nobody is notified.
- `ap_second_approvers` is **deprecated, not dropped** — we stop reading it, the data stays
  for audit continuity. Supersession recorded in ADR-0046's amendment history.
- **Near-miss caught pre-deploy:** the first seed matched users by NAME. Bill, Janette and
  Morena each have two live accounts — their manager account, and an **operator PIN account
  created 2026-07-28 with no email at all**. A name match took the newest row and selected
  the operator accounts, which would have made the routing table look populated while every
  recipient resolved to a non-existent address — the same empty-recipient bug, reintroduced
  by its own seed. Now keyed on email with a role guard; validated against live prod in a
  rolled-back transaction asserting 0 unreachable approvers and 0 prefs on email-less
  accounts. A regression test models the email-less operator account explicitly.
- **Wired end-to-end:** `decideSecondApproval`'s eligibility check and the first-leg
  notification now both call the shared resolver; the site-roster lookup is no longer read
  on the decision path. `ap_second_approvers` is deprecated in ADR-0046 **Amendment 8**
  (kept for audit continuity). `secondApproverSiteLabel()` is retired from this path — under
  person routing "Eugene (Shannon Rockwell)" implied Shannon was reached because of the
  site, when she was reached because Rick signed first; the resolved person's name is used.
- **Per-user pref filtering** applies AFTER routing, so a pref can only subtract a person
  from their own routed request — it can never turn a targeted request into a broadcast.
  A missing prefs row takes column defaults rather than silently excluding the user.
- Checks A-D reported: backlog **empty** (Bill had cleared it manually on Jul 27 in one
  batch), roster confirmed Shannon/eugene only, `ap_notify` live at both sites.

### Added — 2026-07-29 (AP morning digest, 06:00 PT weekdays — ADR-0066 §1.7)

Bill's oversight mail. Ships **live**, not pilot — _"we want that daily digest to go live
as well - its time."_ One email, one recipient, weekdays only, and **nothing at all when
there is nothing pending**.

- **`scripts/ap-morning-digest.mjs`** (thin Pacific scheduler) →
  **`/api/internal/ap/morning-digest`** (loopback-guarded) → **`src/lib/ap/morning-digest.ts`**
  (the work), plus the **`dr3-vision-ap-morning-digest`** compose service. Same split as the
  board-pack digest: the daemon fires DAILY, the route decides whether to send.
- **Recipient by pref, never by name.** `dailyDigestRecipients()` reads `notify_daily_digest`
  (§1.6). A test asserts the digest re-targets when the pref moves — the roster is data.
- **Coverage is everything pending:** invoices awaiting a second signature (each naming the
  individual who owes it, resolved through the §1.4 shared resolver — never re-derived here),
  invoices with no first approval, Holds stale at 3+ days, and escalations since the last
  digest. Every row deep-links to `/dashboard/ops/ap?request=<id>` (ADR-0036 tier-1); that URL
  policy is now **exported from `notify.ts`** instead of re-declared, so digest and
  notification links cannot drift.
- **Two warning classes.** Any **active approver with no `ap_approval_routing` row** is named
  — that is how a missing pair gets noticed (§1.4: the table must be total). Any invoice **3+
  days old** raises a line AND marks the whole mail `importance: high` with an
  `ACTION NEEDED` subject.
- **Suppressed entirely on an empty state** — asserted on the send path (`notifyStaff` is
  never called), not merely on a payload flag. One deliberate refinement: a routing-coverage
  warning over an empty queue still sends. Suppressing it would keep a real misconfiguration
  invisible until an invoice happened to arrive, which is the exact shape of the outage this
  ADR exists to remove.
- **Pacific-correct ages.** Both sites are Pacific and the container is UTC, so ages count
  **Pacific calendar days** (ADR-0065 day key). A UTC count rolls the boundary at 4/5 PM PT
  and would trip the 3-day alarm a full day early on every evening arrival.
- **No UTC cron.** 06:00 PT is 13:00 UTC in PDT and 14:00 UTC in PST, so no fixed cron
  expression can express it — either literal is wrong for half the year and would put the
  "morning" digest at 05:00 PT all winter. The daemon re-derives the next 06:00 Pacific
  wall-clock instant every iteration from the tz database; pinned in
  `cron-dst-schedule.test.ts` against both absolute instants and the fall-back seam.
- Weekday/holiday gating reuses the shared §1.5 `isBusinessDayNow()` — no second calendar.
  Sent through `notifyStaff()` on the **existing (live) `ap_notify`** surface, so it needs no
  new rollout row and no migration; a new surface would be born pilot and would not ship live.

### Added — 2026-07-28 (`/admin/equipment` — the equipment master is maintainable from the UI — ADR-0063)

ADR-0062 seeded 554 assets and closed the empty-picker problem, but it closed it with a
**script**: every future fleet change (new truck, scrapped trailer, re-categorised machine)
needed another run of `scripts/seed-equipment-master.mjs` against production. The AP code has
always called the registry "admin-managed" and `/api/ops/ap/equipment` is read-only "because
creation is admin-only" — but the admin surface was never built. That was **C-27**, now closed.

- **`/admin/equipment`** — list with site / category / status filters plus search, all four
  living in the URL (`?site=&category=&status=&q=`). **`/admin/equipment/new`** — create.
  **`/admin/equipment/[id]`** — edit + activate/deactivate. New tile on the `/admin` hub.
- **`POST /api/admin/equipment`** + **`PATCH /api/admin/equipment/[id]`**
  (`{action:'update'|'deactivate'|'reactivate'}`), plus a `GET` list. Every handler re-checks
  `requireAdmin()` — the API never leans on the page-layer gate — and every mutation writes its
  `audit_log` row (`table_name='equipment'`, before/after) inside the **same** transaction
  (hard rule #6).
- **Nothing is ever hard-deleted.** `ap_equipment_links.equipment_id` is `onDelete: Restrict`
  and those rows are financial-approval evidence, so `is_active=false` is the only removal —
  which is exactly what `listSiteEquipment()` already filters on for the approver's picker.
  The `[id]` route ships **no `DELETE` handler at all** (unlike `/api/admin/users/[id]`, which
  aliases it to deactivate), so no client can form a request that even looks like a delete.
  A test asserts the export is absent.
- **`(site_id, display_name)` is now a real DB constraint** (migration
  `20260813_adr0063_equipment_display_name_unique` + `@@unique` in the schema). The seed
  script's idempotency was already keyed on that pair, but only by convention — once humans
  can create rows, a duplicate would make the next seed re-run insert a third copy instead of
  updating, and would put two indistinguishable options in front of an approver. Names are
  normalised on write (trim + collapse whitespace) so the key means something; the index is
  **unconditional** (covers inactive rows — reactivate a returning asset, don't re-create it);
  the app pre-checks for a readable 409 and catches P2002 as the same reason for the race.
  Verified against prod before writing the migration: 554 rows, **zero** duplicate groups —
  which matters because `prisma migrate deploy` runs at container start, so a violation would
  crash-loop the app rather than fail a build step.
- **Every field stays editable, `site_id` included — even on assets an approval cites**
  (ADR-0063 D4). This screen was first built with a site-LOCK on cited rows; ADR-0046
  **Amendment 7** (PR #181, same day) made the AP selector fleet-wide, which killed the
  lock's premise (`listSiteEquipment()`/`assertEquipmentForSite()` no longer read `site_id`,
  so no asset is one an approver "could never have been offered") and made it harmful —
  correcting the coarse C-28 jurisdiction guess is a core reason this screen exists, and the
  lock would have made the _most-cited_ assets the ones nobody could fix. Both the decision
  and its reversal are recorded in ADR-0063 D4 rather than quietly dropped. A transfer is
  still bounded by per-site name uniqueness, and every edit is audited before/after.
- **`is_active` is now the ONLY thing scoping the approver's picker** (ADR-0063 D4a, a
  consequence of Amendment 7). The picker used to be narrowed by site _and_ status; it is now
  `is_active: true` and nothing else. So deactivate/reactivate is the sole mechanism that adds
  or removes an option from a financial-approval surface, and it hits **both sites at once** —
  the confirm dialog and helper copy now say so, and the tests assert removal against
  `listSiteEquipment()`'s exact predicate rather than a generic flag check.
- **Known latent exposure, recorded not fixed:** the uniqueness key is per-site while the
  picker is now fleet-wide, so two sites _could_ produce identical labels side by side in one
  picker. Verified zero such duplicates among active rows in prod. The constraint stays
  per-site deliberately — a global index would forbid distinct assets at different facilities
  sharing a unit number (the roster already repeats 5) and would break the seed's idempotency
  key. If duplicates ever appear the fix is naming/grouping in the multi-select.
- **Search, not pagination** (ADR-0063 D2). Every maintenance task starts from a unit number
  on a work order, and a `?page=` is view state that goes stale on mutation — deactivating a
  row under the default `status=active` filter shifts every later row up a page, so the admin
  returns to a page that no longer holds their record. `?q=` has no such failure mode.
- **Born with the ADR-0017 Amendment 1 contract** rather than retrofitted with it: create/edit
  carry the filters back on save, cancel and the back-link, and the create form's site select
  seeds from `?site=` instead of `sites[0]` — which, ordered by name, is always DR3 Eugene, so
  creating from a Woodland-scoped list would otherwise register the asset in the wrong site's
  picker. `src/app/admin/equipment/list-url.ts` is a deliberate sibling of the users module,
  not a generalisation of it (D5).
- Verification: `npm test` 3212 passed / 2 skipped (311 files), `tsc --noEmit` 0 errors,
  `next lint --max-warnings 0` clean, `next build` green. 76 new tests across the serializer,
  the create form (jsdom) and the API routes.

### Fixed — 2026-07-28 (the iPad queue used the UTC day, not the Pacific day — ADR-0065)

**Correctness fix, independent of any scoping request.** The operator queue computed "today"
with `new Date(); d.setHours(0,0,0,0)` — **server-local** midnight. The app container runs UTC
with no `TZ` set; both sites are Pacific (Woodland CA / Eugene OR). From **5:00 PM Pacific
onward UTC has already rolled to the next day**, so an evening-shift operator's queue would
silently switch to the WRONG DAY mid-shift — hiding the loads they were actually working and
showing tomorrow's. It would have misfiled evening loads.

- **New `currentPacificDayWindow()`** in `@/lib/time` returns the half-open `[start,
endExclusive)` instant window for the current Pacific day, built from the same
  `pacificDayStartInstant` that `floor-inbound`, `bulk-inbound`, `onHand` and the MyMRC bridge
  already key on. **No second day-key definition was introduced** — the queue was the odd one
  out, and now agrees with billing.
- Covered by `src/lib/pacific-day-window.test.ts`, which asserts the exact failing case: at
  6:00 PM Pacific (= 01:00 UTC the next day) the window still resolves to the Pacific day and
  excludes tomorrow's loads. PST (winter, UTC-8) is covered too.

### Changed — 2026-07-28 (the floor iPad shows the current day only — ADR-0065)

Bill: _"vision on the ipad is only going to show hauls from the current day … no historical or
future views."_ Live prod on 2026-07-28 had **14 uncancelled expected loads** in the queue's
window (1 today, 13 across 07-29 → 08-07) because the filter was an unbounded `gte`.

- **Queue** bounded to the current Pacific day. The per-row date badge is deleted — every row
  is today by construction.
- **`/inbound` (F-2)** lists 1 day, not 14. The hub's "unconfirmed" badge counted a **14-day
  lookback** — exactly the historical view being ruled out — and is now scoped to today.
  `listFloorInboundDays` / `countUnconfirmedInboundDays` also gained an **upper** bound at the
  next Pacific midnight (they had only a window start), so no future-dated row can render as a
  selectable day. Both are floor-only callers — the office paths are untouched.
- **Server-side pin:** `assertCurrentPacificDay()` rejects (422 `date_not_today`) any floor
  write naming another day. UI scoping is not a control: the floor APIs take the target day in
  the request body, so a hand-edited or replayed offline-queue entry could otherwise reach
  another day. It **refuses** rather than silently retargeting to today — silently rewriting
  the day would file units against the wrong production day.
- Swept `/operator/**` for other date affordances: there are no date pickers, day steppers or
  date query params. `/count` is on-hand-now (no date); `/processed` was already today-only and
  is now pinned server-side too.

### Added — 2026-07-28 (per-surface iPad rollout gates — Bill can turn one screen off with no deploy — ADR-0065)

Every iPad floor surface shared ONE rollout code, `loads_inventory` — which also gates the
**manager desktop** loads-inventory + processed-units-close tabs and every loads write. It is
`live` at both sites, so there was no way to disable a single iPad screen without dropping the
managers' tabs.

- **Five new `kind='ui'` surfaces**, each read by the screen _and_ the write path it governs:
  `ipad_queue` (queue + `/load/[id]` + the dock server actions), `ipad_inbound`, `ipad_count`,
  `ipad_processed`, `ipad_today_summary` (the F-1 on-hand block only).
- **Seeded per Bill's decision:** `ipad_queue`/`ipad_inbound` **live**; `ipad_count`,
  `ipad_processed`, `ipad_today_summary` **pilot** (off). Migration
  `20260813_adr0065_ipad_per_surface_rollout_gates` is additive + idempotent (`ON CONFLICT DO
NOTHING`, TEXT ids) and never reverts an admin flip; `prisma/seed.mjs` carries the same five.
- **Deliberate ADR-0047 deviation, documented:** decision #3 says new surfaces are born pilot.
  `ipad_queue`/`ipad_inbound` are seeded `live` because these gates are **retrofitted over
  already-live functionality** — born-pilot protects _new_ exposure, it is not a mandate to
  take a _working_ surface down. See ADR-0065 D2.
- **The hub is never gated** ("leave the site picker do not strand anyone"). PIN success lands
  there, so only its content is gated — the F-1 block and each card, now **including the truck
  queue card**, which was previously hardcoded un-gated. With everything off the hub still
  renders a heading, an explanation and Log Out.
- **Writes are gated, not just pages.** `requireActivatedOperator` now requires an explicit
  surface code (no default, so a caller cannot silently re-couple to the master gate). Most
  importantly `operator/[site]/actions.ts` — the dock workflow — had **no rollout gate at
  all**; it writes `inbound_loads`, which feeds `onHand` and billing, so a bookmarked
  `/operator/<site>/load/<id>` could drive it regardless of the hidden card.
- Re-enable path: `/admin/rollout` → flip the row → save. Verified the panel lists any
  registered surface, so the new rows appear with no code change.

### Added — 2026-07-28 (back + Log Out on every screen — ADR-0065, extends ADR-0064)

Bill: _"we also need a back button and a log out button on every screen"_ and, for the iPad,
_"switch user should be titled Log Out — make it available and easier to see from any page."_

- **`ManagerChrome`** (dashboard / bonus / admin / `/`) extends the ADR-0064 back bar with a
  sign-out. The manager surface previously had **no sign-out control anywhere** — a manager's
  only way out was clearing cookies. Mounted in the three group layouts + `VisionShell`; zero
  page edits. Logout is a **local** sign-out to `/login?signedout=1` (with a new "You've been
  signed out" confirmation); the Entra/M365 session in the same browser is deliberately left
  alone, so this is **not** a shared-device logout.
- **`FloorChrome`** (operator) is a separate component because the auth models differ: PIN on a
  shared device, and sign-out lands on the site's **name picker**, never `/login` — operators
  have no SSO account and `/login` would strand them. Mounted once in the operator layout, so
  all 9 screens inherit it. `/operator/[site]/load/[id]` — a 7-stage workflow whose only exits
  were submit and reject — finally has a way out.
- Back is always an **explicit destination, never `router.back()`**: the offline queue plus
  `revalidatePath`/`redirect` make history unreliable.
- **The green theme is preserved (hard rule #3 / ADR-0008).** The shared `NavPill` primitive
  owns geometry only (`min-h-[44px]`, border, focus ring); the palette is passed in, with
  `GREEN_TONE` living in `operator/_components/floor-tone.ts`. Putting a green tone in a shared
  `_components` file tripped the ADR-0051 office dark-theme sweep — correctly — so the floor
  palette physically lives in the floor tree.

### Fixed — 2026-07-28 (operator surface alignment — ADR-0065)

- **Locale switcher no longer overlaps page content.** It was `fixed end-3 top-3` and floated
  over whatever the page drew: it covered the logo on the site picker (`py-10`) and sat on top
  of the sign-out button on the queue (`py-8`). It now lays out inside the sticky chrome band,
  so the overlap class is gone rather than papered over with per-page padding.
- **Top clearance moved into the shell.** `FloorShell` owns `min-h-screen`, the ADR-0014
  background split (black pre-PIN trio / green working screens) and clearance; all 9 pages
  dropped their ad-hoc `pt-20` / `py-10` / `py-8` / `py-6`.
- **Touch targets ≥44px (ADR-0060)** on the controls Bill asked about: the operator sign-out
  (was `px-4 py-2` ≈40px), the `/inbound` `/count` `/processed` back links (≈40px, now supplied
  by the chrome), and the load-workflow pending pill (was `px-3 py-2 text-xs`).
- **Three incompatible operator header markups** collapsed into `FloorPageHeading`.
- **RTL:** the back chevron was a hardcoded left-pointing path — wrong direction in Urdu. It
  now mirrors via `rtl:rotate-180`, and the `'← Back'` glyph was stripped out of
  `floor.common.back` (key removed; the chevron is rendered, not translated).
- **Redundant back links removed** from `dashboard/billing-variance`, `bonus/standings` and
  `bonus/page` now that the chrome is universal. Legitimate second-level parent links (e.g.
  `← Admin`) are untouched.
- New i18n keys in EN/ES/UR for both namespaces (`nav.sign_out*`, `nav.back*`, `nav.log_out*`,
  `auth_login.signed_out`); the CI locale-parity gate passes.

### Added — 2026-07-28 (ADR backfill)

- **`docs/adr/0064-always-visible-back-bar.md` written** — six source files cited ADR-0064 but
  the file was never committed with PR #163. Reconstructed from the shipped implementation.
- `docs/adr/README.md` index backfilled with the missing rows for **0051, 0052, 0053, 0054,
  0062**, plus 0064 and 0065.

### Changed — 2026-07-28 (AP equipment selector is fleet-wide — ADR-0046 Amendment 7)

Operator directive, overriding ADR-0046 Amendment 5 (D-M5-6). The Approve-panel
equipment multi-select and its server-side validator no longer filter by site.

- An invoice at either site can be for any asset (over-the-road trailers, tractors,
  machines that move between facilities), and the registry has **no trustworthy site
  attribution to filter on**: it was seeded (ADR-0062) from a machine list with no
  `DR3 Eugene` facility and only 21 `DR3 Woodland` rows out of 554, so `site_id` came
  from a coarse jurisdiction fallback. Filtering on a heuristic field produced
  confidently wrong results — it hid the very asset the approver was looking at.
- **Both sides moved together.** `listSiteEquipment` and `assertEquipmentForSite`
  must agree on scope; changing only the picker would leave cross-site picks
  rendering fine and then failing 400 on save. A test now asserts the pairing
  ("every option the picker returns passes the validator").
- `assertEquipmentForSite` is still a real trust boundary — ids must exist and be
  active. Only the site predicate was dropped. The decision itself is still filed to
  one site (or `filed_not_dr3`), still approver-gated, still audited.
- Picker now offers ~521 active options. If that proves unwieldy, the answer is
  search/grouping — not reinstating a filter on untrustworthy data (C-28).

### Fixed — 2026-07-28 (operator queue: current Pacific day only + a DST money-path bug)

The iPad queue went live on the floor today. Two date defects, the second of which
reaches billing.

- **The queue showed the entire future.** `expected_arrival_at` was filtered with an
  open-ended `gte` and no upper bound, so every future expected load sat on the
  operator's queue — 14 rows on the day this was found, of which 1 was actually
  today's. It is now bounded to the current Pacific day only: no historical, no
  future (operator directive, 2026-07-28).
- **The day boundary was UTC, not Pacific.** The lower bound was
  `new Date().setHours(0,0,0,0)` — server-local midnight — and the deployed
  container runs with no `TZ` set (UTC), while both sites are Pacific. Between
  5 PM and midnight Pacific the UTC day has already rolled, so the queue silently
  switched to **tomorrow mid-shift**, hiding the loads the evening crew was working.
  Now uses `pacificDayStartInstant`, the same DST-correct boundary `onHand`'s inbound
  window, `bulk-inbound`, the MyMRC bridge and the floor-confirm path already key on —
  so the iPad's "today" is byte-identical to what billing counts.
- **`pacificDayStartInstantPlus` was broken on the DST fall-back day — a money-path
  bug found by the test written for the above.** It stepped `days * 86_400_000` and
  re-snapped to Pacific midnight; on a 25-hour fall-back day (next: 2026-11-01)
  base + 24h lands at 23:00 PST, still inside the SAME Pacific day, so the re-snap
  returned the base instant and `pacificDayStartInstantPlus(1)` produced a
  **zero-width window** (measured: 0h instead of 25h; spring-forward happened to be
  correct at 23h, which is why it went unnoticed). It now steps on the Pacific
  calendar, which cannot be perturbed by an offset. Affected callers:
  `src/lib/invoices/generation-inputs.ts:99` (the **invoice generation window** — a
  zero-width `lt` bound drops every row in range), the manager loads date filters
  (`dashboard/[site]/loads/page.tsx`), and the new queue window.
- Tests: `src/app/operator/[site]/queue/queue-window.test.ts` (6 — incl. the 6 PM
  Pacific evening-shift case the old code got wrong) and 4 new cases in
  `src/lib/time.test.ts` pinning 25h/23h/24h spans, backward stepping across the
  fall-back boundary, and midnight-landing for every offset.

### Added — 2026-07-28 (equipment master seeded — the AP approval picker finally has options — ADR-0062)

The AP Approve panel's equipment multi-select was backed by an **empty table**. All 12
`ap_equipment_links` rows written since AP go-live are `is_not_equipment_related=true` — not
because the invoices were non-equipment, but because approvers had **nothing to pick**. The AP
code calls the registry "admin-managed", but no create surface was ever built, so there was no
path (UI or API) to populate it.

Seeded from `DR3 Machine List (2).xlsx` (file-drop `580024f8`, sha256 `4ffff995…`) — the
SVdP-wide fleet register, 554 assets across 35 locations.

- **554 equipment rows live in prod** — eugene 413, woodland 141; 521 active / 33 inactive.
  By category: 459 vehicle, 39 forklift, 19 baler, 4 terex (shear machines, incl. Woodland's
  `EQ74`), 33 other. Verified: 554 rows, 554 matching `audit_log` rows.
- **Site mapping is by JURISDICTION** (the charter's own axis): California → `woodland`,
  everything else → `eugene`. The workbook has **no `DR3 Eugene` facility** and only 21
  `DR3 Woodland` rows, so this is deliberately coarse and operator-directed ("load all of this
  in for all sites — just no better way for now"). It is **not** a claim that Cleveland
  Warehouse is DR3 Eugene. Tracked as C-28; see ADR-0062 for the full reasoning.
- **Stockton assets load without violating hard rule #1** — the `equipment` model has no
  location column, so no location text is persisted for any row and the string "Stockton"
  never enters a stored or rendered value. Satisfied by construction, not by dropping assets.
- **Normalization:** `display_name` = `"<Unit #> — <Make> <Type>"` with `(#n)` suffixes for the
  5 repeating unit numbers; 91 blank-Type rows resolved via Make (Great Dane/Fruehauf/Strick =
  trailers, Freightliner/Volvo = tractors) and `F##` → forklift, leaving **29 genuinely unknown
  rows as `other`** rather than guessing; Scrapped/Sold/Inactive/Out-of-Service/Transferred →
  `is_active=false` (kept for historical link resolution, filtered out of the picker).
  Ownership (Owned/Leased/Rented) is not persisted — no column, not an approval-time attribute.
- **`scripts/seed-equipment-master.mjs`** — one-shot, idempotent (keyed on
  `(site_id, display_name)`), audited (`actor_label='system:equipment-seed'`, source sha in the
  `after` payload). Re-run verified: 0 created, 554 unchanged. Parse and write are split
  (`--emit-json` / `--json`) because the deployed standalone image ships `@prisma/client` but
  not `exceljs`.
- **Still open:** there is no admin UI to maintain this registry (**C-27**) — every future fleet
  change needs another script run until `/admin/equipment` ships.

### Fixed — 2026-07-28 (admin user list keeps its view across create/edit — ADR-0017)

Creating a user from a site-filtered user list no longer throws the admin back to the unfiltered
all-users list, and no longer defaults the new user to the wrong site. Reported from the real
workflow: filter `/admin/users` to Woodland → **+ Add user** → save → land on the list of ALL users.

- **Post-save navigation preserves the working view.** `UserCreateForm` pushed a hard-coded
  `/admin/users` on save and on cancel, discarding the `?site=&role=&status=` filters that ARE the
  list's state (ADR-0017 already specified URL-driven filters; the create round trip just never
  carried them). Save/cancel now return to the exact filtered list. Same fix applied to the edit
  form's cancel and to both back-links.
- **The site select now defaults to the site you were filtered to.** It seeded from `sites[0]`,
  and because sites are ordered by name, `DR3 Eugene` sorts before `DR3 Woodland` — so `sites[0]`
  was _always_ Eugene. An operator created from a Woodland-scoped list was born in Eugene unless
  the admin noticed and flipped the select, which crosses the Eugene/Woodland separation line
  (CLAUDE.md hard rule #2) and puts the operator on the wrong name-picker with PIN-uniqueness
  checked against the wrong peer set. **No bad data resulted** — a prod audit of every user row
  found no wrong-site user; the three Woodland operators created 2026-07-28 all landed correctly.
  This closes the footgun before it bit.
- **New shared serializer** `src/app/admin/users/list-url.ts` (`pickUsersListParams` /
  `buildUsersListHref` / `withUsersListQuery`) is now the single parser + serializer for the list's
  view state, used by the list, create and edit surfaces. Params are **whitelisted** to
  `site|role|status`, so nothing else rides the round trip into a `router.push`.
- **Scoping note:** this is a UX/data-entry fix, not a leak. `/admin/users` is gated by
  `requireAdmin()` (admin powers, not the `all_sites` reach check), so the only viewer of the
  all-users list was already a global-reach admin.
- **Tests:** `src/app/admin/users/list-url.test.ts` (11 cases — round trips, default-status
  omission, whitelist) and `src/app/admin/users/new/UserCreateForm.test.tsx` (8 cases — Woodland
  default, `sites[0]` fallback, POSTed `primary_site_id`, filtered-list redirect, no-navigate on
  save failure). No schema change, no API change.

### Fixed — 2026-07-25 (iPad / floor surface i18n parity — ADR-0061)

Makes the existing en/es/ur translations actually REACHABLE for floor PIN operators. The iPad already
shipped the same language set as the Vision main portal and every operator surface was fully translated
with correct RTL — but a Spanish/Urdu-reading floor operator had no way to SELECT or PERSIST their
language, and the sign-in screens they must read first were hard-forced to English. This closes that gap
without touching auth/PIN logic. See ADR-0061 and `docs/plans/2026-07-25-ipad-i18n-parity.md`.

- **Floor locale switcher (D-1/D-2)** on the operator shell (`src/app/operator/_components/floor-locale-switcher.tsx`,
  mounted in `operator/layout.tsx`), present on every operator screen including the pre-auth sign-in trio
  and mid-shift. Three ≥44px targets, each label in its own script, top-corner chrome (logical `end`),
  out of the RTL-forced numeric zones. Floor staff never reach `/login`, so this is their only path in.
- **Session-first locale resolution (D-4)** — `getLocale`/`resolveLocale` now prefer the signed-in
  operator's `users.locale` over the device-global `dr3_locale` cookie: `?lang=` > session > cookie
  (pre-auth hint only) > `en`. On a shared iPad, language follows the OPERATOR, not the device — one
  person's pick can no longer pin or mask another operator's language for a year.
- **Per-operator persistence (D-3)** — the switcher writes `users.locale` directly when signed in
  (`setFloorLocaleAction`); a pre-auth pick sets a short-lived explicit-pick marker cookie that
  `mirrorLocaleCookie` folds into `users.locale` on sign-in (then consumes). Every future shift renders
  in the operator's language on any iPad.
- **Shared-device anti-corruption (D-4)** — `mirrorLocaleCookie` no longer folds the ambient device
  `dr3_locale` cookie into `users.locale`; only an EXPLICIT pre-auth pick (marker) persists. This removes
  the "one manager's pick overwrites every operator's stored preference on each sign-in" corruption.
- **CI-blocking key-parity gate (D-5)** — new `src/i18n/locale-parity.test.ts` fails the build if any
  locale file drifts (missing/extra key, or empty translation) from `en` in either namespace, ignoring
  inert `_meta.*` notes. The false `as Dictionary` casts in `dictionary.ts` are replaced with a `Widen<>`
  type so a key added to `en` but forgotten in es/ur is again a hard `tsc` error.
- **Soft-deleted operators excluded from the name-picker** (`deleted_at: null`): a soft-deleted but still
  `is_active` operator could be selected and pass the PIN, then get bounced by the revocation kill-switch
  into a dead-end empty session. They no longer appear.
- **No migration** — `users.locale` (`UserLocale @default(en)`) already exists. No schema change.

### Added — 2026-07-25 (iPad floor inventory-validation surfaces — ADR-0060)

Builds the day-to-day inventory-validation layer the floor was missing: operators can now confirm/correct/
enter the day's inbound haul counts, take a physical on-hand count, and confirm the day's processed counts —
all on the existing operator iPad PIN shell, completing the ADR-0059 confirmation contract. Before this the
contract existed only as a backend function reachable from the manager DESKTOP (prod: 610 provisional
`mymrc_haul` rows, 0 confirmations of any kind). See ADR-0060 and
`docs/plans/2026-07-25-ipad-floor-surfaces-buildout.md`.

- **Three floor surfaces + a hub** on the operator PIN shell (iPad/green/i18n en·es·ur, ≥44px tap targets,
  on-screen number steppers — no hardware keyboard): `/operator/[site]/today` (hub + on-hand headline;
  the post-PIN shift landing), `/operator/[site]/inbound` (confirm/correct/enter the day's inbound),
  `/operator/[site]/count` (physical on-hand → new anchor), `/operator/[site]/processed` (confirm processed
  count). Each respects the ADR-0047 per-site `loads_inventory` rollout flag; the per-load dock queue stays
  reachable from the hub regardless of rollout state.
- **New floor endpoints** under `/api/operator/[site]/**` (inbound GET+POST, count POST, processed POST),
  gated by a new `requireOperatorForSite` helper (operators-only, single-site) + `requireActivatedOperator`
  (rollout gate). Every write re-derives operator + site from the session server-side.
- **Inbound confirmation** completes the ADR-0059 D4 contract: `src/lib/loads/floor-inbound.ts`
  `confirmFloorInboundDay` retires the day's `mymrc_haul` provisional and installs one aggregate row
  `load_source_type='ipad_floor'` (new tier; precedence `ipad_floor > paper_bulk > mymrc_haul`), reusing the
  delete-then-write + absolute-SET + audited-in-tx money-safety pattern. A day owned by an office
  `paper_bulk` row is refused (409 `office_owned`); the floor never clobbers office data.
- **On-hand / processed** reuse `reconcilePhysicalCount` / `upsertProcessedUnits` with the operator as actor
  (establishes Eugene's first anchor); close/lock stays admin-only.
- **Money-safety (D5):** `onHand` sums all verified inbound regardless of source type, so an aggregate row
  plus per-load `b2b_haul` rows for the same day would double-count (the partial unique index only bars two
  _aggregate_ rows). The floor confirm path refuses such a day (409 `per_load_exists`), and the ADR-0059
  MyMRC inbound bridge now closes the same latent gap (`inbound-bridge.ts` skips days with verified per-load
  rows — `skippedPerLoad`). Both guards are covered by tests.
- **One additive migration** (`20260812_adr0060_ipad_floor_inbound_source`): `ipad_floor` enum value +
  widen the ADR-0059 partial unique index to `IN ('paper_bulk','mymrc_haul','ipad_floor')`. Clean-replay +
  idempotent, verified on a fresh PG16.

### Added — 2026-07-23 (MyMRC hauls → inventory INBOUND bridge — ADR-0059)

Wires the recycler's received-count feed to inventory as PROVISIONAL inbound. Before this,
the running balance's `Inbound` leg was fed only by manual `paper_bulk` manager entries, so
on-hand never **rose** from real intake, only fell from processing (ADR-0058). MyMRC haul
counts become provisional inbound now; a manager `paper_bulk` entry or a future iPad
floor-confirmation upgrades a day to confirmed. See ADR-0059 and
`docs/plans/2026-07-23-mymrc-inbound-inventory-bridge.md`.

- **Bridge `mymrc_hauls_mirror` (Delivered, General) → `inbound_loads`.** New bundle-safe
  `src/lib/mymrc/inbound-bridge.ts` (Prisma-injected, no `@/`) aggregates (SUMs)
  `status='Delivered' AND type='General'` mirror rows per (site, `docking_appointment_date::date`)
  into `program_unit_count`/`non_program_unit_count`/`total_units`, keyed to `arrived_at` =
  Pacific-midnight of the delivery day (exactly as `bulk-inbound.ts`), `status='verified'`,
  `count_mode='total'`, `load_source_type='mymrc_haul'`. **The single most important divergence
  from ADR-0058: it filters on `status='Delivered'` and does NOT exclude `disappeared_at`** —
  Delivered hauls scroll off the rolling list, so ~7,191/7,215 are `disappeared_at`-stamped;
  excluding them would capture almost nothing. `type='Consumer Dropoff'` is excluded (a separate
  leg). Grain is per-(site, day) aggregate, never per-haul, to coexist with `paper_bulk` without
  double-count.
- **One migration** (`20260810_adr0059_mymrc_haul_inbound_source`): adds `mymrc_haul` to
  `enum LoadSourceType` and **generalizes** the ADR-0037 paper_bulk partial unique index to
  `(site_id, arrived_at) WHERE load_source_type IN ('paper_bulk','mymrc_haul')` — the DB-level
  "one aggregate inbound row per (site, day)" invariant that makes a paper_bulk↔mymrc_haul
  double-count physically impossible. Additive, idempotent, clean-replay proven on a fresh PG16.
- **Idempotent, precedence-guarded, audited writer.** Single atomic
  `INSERT … ON CONFLICT (site_id, arrived_at) WHERE load_source_type IN ('paper_bulk','mymrc_haul')
DO UPDATE … WHERE load_source_type='mymrc_haul' AND (values IS DISTINCT FROM …)` with
  absolute-value SETs (double-count-proof) + `xmax`-discriminated `RETURNING`. A `paper_bulk`
  (manager) row is left byte-identical with no error; precedence is iPad-confirmed > paper_bulk >
  mymrc_haul. Every real write emits an `audit_log` row (`actor_label='mymrc-inbound-bridge'`).
- **Confirmation supersedes provisional (write side).** `upsertBulkInboundDay`
  (`src/lib/loads/bulk-inbound.ts`) now DELETEs any `mymrc_haul` row for the (site, day) before
  installing the manager's `paper_bulk` row, in one transaction, delete audited — the same
  delete-then-write contract the future iPad floor-confirmation endpoint reuses.
- **Runs hourly on MyMRC scrape completion** (`scripts/mymrc-scrape.mjs`, right after the ADR-0058
  processed bridge, best-effort/non-fatal — no new container). Hourly path re-aggregates only a
  ~10-day trailing window.
- **Anchor-safe one-shot backfill** (`scripts/mymrc-inbound-bridge-backfill.mjs`;
  `--backfill`/`--since`/`--site`/`--dry-run`). Proven inert for the live floor: `onHand` sums
  inbound with `arrived_at >= Pacific-midnight of the day AFTER the anchor`, and the latest dated
  Delivered General haul is 2026-07-21 ≤ the 2026-07-22 Woodland anchor, so all backfilled rows
  are excluded. **Gated on the ADR-0058 MANDATORY pre/post `onHand(now)` byte-identical invariance
  assertion** (floor-probe route); drift aborts non-zero + pages `dr3-vision-system`. Historical
  backfill is honestly **partial** — 2,301 undated Delivered General hauls (all pre-anchor, inert)
  are skipped and counted (`haulsUndated`).
- **Report labels provisional inbound honestly.** `EodInventorySnapshot` gains a derived
  read-only `inboundProvisional` flag (one cheap read of rows `onHand` already sums, no
  arithmetic); the Daily Production Report labels such a day **"Inbound: provisional — from MyMRC
  haul counts, pending floor confirmation"** in the muted tone, and the honesty footer +
  tonight-accuracy caveat are amended. The label drops automatically once a `paper_bulk`/iPad
  confirmation replaces the provisional row; the resend fingerprint fires on that flip.
- **Backfill reconciliation (read-only, prod)** — 610 (site, day) aggregate rows,
  439,357 program / 0 non-program (dated Delivered General; 2,301 undated skipped); all-Delivered
  General program 629,973 ≈ 0.970 × processed 649,428; latest bridged delivery day 2026-07-21 <
  Woodland anchor 2026-07-22; Eugene inbound empty; current Woodland floor 1597/886/2483 unchanged
  by the backfill. **The operator runs the migration + real backfill + on-box floor-invariance
  verification.**

### Fixed — 2026-07-23 (ADR-0058 floor-probe gate unreachable — middleware auth redirect)

- Added `/api/internal/inventory/` to the middleware public-path allow-list
  (`src/lib/public-paths.ts`). The ADR-0058 anchor-safety gate calls the
  session-less `/api/internal/inventory/floor-probe` route over loopback, but the
  route was never exempted from the NextAuth middleware, so every gate call was
  307'd to `/login`. The bridge fails closed on the non-200, so the backfill —
  and the recurring hourly bridge — could never write. The route self-checks the
  bearer token and 404s any `cf-connecting-ip` request, so the exemption is the
  same loopback-guarded posture as the survey/bonus/ap crons. Regression case
  added to `src/__tests__/public-paths.test.ts`. This is the ADR-0036 class of
  bug the allow-list comments warn about, caught on first live run.

### Added — 2026-07-23 (MyMRC processed → inventory bridge + single 8pm production-report send — ADR-0058)

Wires the authoritative MyMRC processed feed to inventory and consolidates the daily
production-report send to a single 8:00pm PT email. Money-critical: `processed_units_daily`
(the running balance's `Stripped` leg) was **empty (0 rows on prod)** so inventory on-hand
never decremented from production. See ADR-0058 and
`docs/plans/2026-07-23-mymrc-processed-inventory-bridge.md`.

- **Bridge `mymrc_processed_mirror` → `processed_units_daily`.** New bundle-safe
  `src/lib/mymrc/processed-bridge.ts` (Prisma-injected, no `@/`) aggregates (SUMs) `Processing`,
  non-`disappeared` mirror rows per (site, `processed_date::date`) into
  `stripped_program`/`stripped_non_program` (explicit split, legacy `units` → program-only
  fallback), keyed to the Pacific `@db.Date` production day (noon-stamp ⇒ drift-free).
  `source='mymrc'` (existing enum value — **no migration**; the `(site_id, production_date)`
  unique index already exists on prod). Aggregation is mandatory — multi-row days are real.
- **Idempotent, precedence-guarded, audited writer.** Single atomic
  `INSERT … ON CONFLICT (site_id, production_date) DO UPDATE … WHERE source='mymrc' AND
closed_at IS NULL AND (values IS DISTINCT FROM …)` with absolute-value SETs (double-count-proof)
  and an `xmax`-discriminated `RETURNING`. A `manual` close or workbook `import` row — or any
  closed day — is left byte-identical with no error. Every real write emits an `audit_log` row
  (`actor_label='mymrc-processed-bridge'`); a guarded no-op writes none.
- **Runs hourly on MyMRC scrape completion** (`scripts/mymrc-scrape.mjs`, after
  `feedReconciliationQueue`, best-effort/non-fatal — no new container). The hourly path
  re-aggregates only a ~10-day trailing window.
- **Anchor-safe one-shot backfill** (`scripts/mymrc-processed-bridge-backfill.mjs`;
  `--backfill`/`--since`/`--site`/`--dry-run`). Proven inert for the live floor: `onHand` sums
  only `production_date > anchorDay` and the latest Woodland anchor is 2026-07-22, so all
  backfilled rows (≤ 2026-07-20) are excluded. **Gated on a MANDATORY pre/post `onHand(now)`
  byte-identical invariance assertion** via a new internal `POST /api/internal/inventory/floor-probe`
  route (`guardInternalCron`); drift aborts non-zero + pages `dr3-vision-system`.
- **Single 8:00pm PT production-report send.** Removed the on-save re-send — the multi-email
  cause (`maybeSendDailyReportOnSave` call sites in `api/bonus/entries` + the amendment-approve
  route; retired `src/lib/bonus/daily-report-late.ts`). The already-configured 20:00 PT scheduled
  fire (`runDailyReportFire`, `send_time_pt=20:00`) is now the sole send, per site. **Supersedes
  the 2026-07-21 on-save-primary amendment** (ADR-0019 §2 / ADR-0030). Safety net = the 8pm
  missing-data ntfy; escape hatch = the operator backfill (`POST /api/internal/bonus/daily-report`).
- **8pm missing-data ntfy — verified, not rebuilt.** `scripts/bonus-eod-check.mjs` fires at
  20:00 PT per site and pages on zero bonus entries, confirmed ADR-0036/0037-compliant (topic
  `dr3-vision-system`, `[DR3-Vision]` title, Bearer, `high`, tier-3 click, per-(site,day) dedup,
  primary→fallback, weekend/holiday skips). No change.
- **Tonight's report accuracy under mirror lag.** The report presents three labelled facts —
  reconciled floor (as of the anchor date), processed-today (bonus daily total, "confirmed in
  MyMRC in 1–3 days"), and an explicit **estimated** post-production floor (floor − today,
  program pool) with lag + inbound caveats — without polluting the authoritative running balance.
  Collapses once the bridge catches up (`movementToday`). Eugene's processed leg stays empty
  until ADR-0057 C-21 (Switch-Account) — not a bug.
- **Tests:** aggregation/multi-row-day, `disappeared_at` + `type` exclusion, idempotency
  (re-run no double-count), precedence vs manual/import/closed, program/non-program split +
  legacy fallback, noon-key → Pacific `@db.Date`, `sinceProductionDate` window, dry-run;
  onHand anchor-boundary inertness (backfill ≤ anchor changes floor by 0); backfill floor-gate;
  floor-probe route; the same-day reconciliation render; and the removed-on-save-send route
  assertions.

### Added — 2026-07-23 (Non-program mattress classification — the MRC billing split)

The definitive program vs non-program source rule (Rick/Morena), the LAST item on
`feat/loads-inventory-real-data`. Money-critical: MRC is billed on PROGRAM units only, so
a mis-classified source silently mis-states the billable pool.

- **The rule, in ONE shared helper.** `src/lib/inventory/source-classification.ts` —
  `isSourceNonProgram(source, recyclerState)`: a source is NON-program if EITHER its
  explicit `is_non_program` flag is set, OR its generated-location `state` is KNOWN and
  differs from the recycler's operating state (out-of-state). A NULL/blank state falls back
  to the flag only — a missing state is never treated as out-of-state. Recycler state comes
  from the site's jurisdiction (`recyclerStateForJurisdiction`: california→CA, oregon→OR) —
  no hard-coded site-id map. Wired into BOTH classification paths so the two rules can never
  drift: the verify gate's default split (`verify-gate.ts`) and the workbook-promotion alias
  resolver (`site-alias.ts` → `resolveInboundSplit`). `defaultProgramSplit` stays a pure
  boolean→split mapping; the caller passes the effective determination. (paper_bulk carries
  an explicit split with no source, so it has no classification point.)
- **11 explicit non-program "charging" collection sites seeded.** CA (Woodland): Golden
  Bear, Monte Diablo, San Martin, Martinez, Petaluma, Sonoma, Annapolis, Healdsburg, Vasco,
  Brentwood; OR (Eugene): Recyclops. (Roseburg already existed — untouched.) All
  `is_non_program=true`, `site_type=collection_site`, `active_billing=false` (zero MRC
  invoice lines — money-safe, matches Roseburg / the SVDP stores), `is_active=true`, `state`
  CA/OR. All 10 CA sites are in-state, so only the explicit flag classifies them (the
  out-of-state rule can't catch an in-CA site — exactly why the list is needed). Idempotent
  migration `20260809_adr0037_nonprogram_charging_sources` + dev/CI seed parity
  (`seedNonProgramChargingSources`, `NONPROGRAM_CHARGING_SOURCES`). Applied LIVE to PROD in
  one transaction with an `audit_log` row per insert (`actor_label='adr-0037-nonprogram-sources'`,
  13 rows) — an explicit operator directive is its own approval (overrides the ADR-0057 D4
  reconcile-queue routing for these sources).
- **Source aliases:** the only surviving MyMRC/workbook variants were `Recology Sonoma`→
  Sonoma and `Recology Healdsburg`→Healdsburg (Golden Bear appears verbatim; the other 8
  have no variant). Verified against the June workbook staging (`workbook_import_rows`) and
  the CA disambiguation set.
- **No anchor regression:** the June (2026-06-30 = 3748/229/**3977**) and current
  (2026-07-22 = 1597/886/**2483**) Woodland physical snapshots are `measured` direct
  snapshots and were untouched; `onHand` reads frozen per-load split columns, so
  classification is orthogonal to the anchors. 0 `inbound_loads` reference the new sources.

### Fixed — 2026-07-23 (Loads & Inventory correctness close-out — D-3 boundary + EOD report truthfulness)

Three remaining correctness items on `feat/loads-inventory-real-data`, all money-critical
(the inventory figure is the MRC billing basis). Every number still rides the single
`onHand` running balance.

- **D-3 count-day boundary was timezone-broken (major).** The physical anchor was stamped
  at UTC-midnight (`${date}T00:00:00Z` = 17:00 PT the prior day) while the four outflow
  tables are `@db.Date` — so the count day's own stripping/outbound/landfill was dropped
  (`> anchor`) while same-Pacific-day inbound (`arrived_at`, a timestamptz) was included:
  a permanent overstatement of the count day. New physical snapshots are now stamped at
  **Pacific-midnight** (00:00 PT) of the counted day, and a shared `anchorFlowBounds`
  derives Pacific-calendar-consistent flow windows — `@db.Date` outflow strictly after the
  anchor's Pacific day, `arrived_at` on/after Pacific midnight of the following day — used
  by BOTH `onHand` and the audit's `startBalance` (the D-4 "one shared function" rule).
  The two existing PROD anchors (Woodland 2026-06-30 = 3748/229/3977, 2026-07-22 =
  1597/886/2483) had `snapshot_at` corrected 00:00→07:00Z with an `audit_log` row each;
  every unit/pool value is untouched (migration `20260807`, idempotent). `onHand` verified
  live: 3748/229/3977 as of the June close, 1597/886/2483 now.
  `src/lib/inventory/running-balance.ts`, `src/lib/audit/leg-fetchers.ts`,
  `src/app/api/manager/[site]/snapshots/route.ts`.
- **EOD report-send gates made the inventory line truthful (major).** The on-save resend
  key compared only mattress totals, so an inventory change never re-sent → the "End-of-Day
  Inventory" was a stale mid-day number; and `skip_if_zero` suppressed the whole report on a
  zero-bonus day even when a physical count or flow happened. Now: the resend decision
  carries a compact EOD-inventory fingerprint (`bonus_daily_report_log.eod_inventory_sig` —
  state + both pools + flow-recency; migration `20260808`), so an inventory change re-sends
  even when the mattress totals are identical; a zero-bonus day with real inventory activity
  today still reports; and freshness now grades on **flow-recency** (`flowThrough`), not
  anchor age alone, so a measured anchor kept current by daily flows stays fresh while an old
  anchor with no flow goes stale on schedule. An inventory-read failure already degrades to a
  dropped section (never kills the report). `src/lib/loads/eod-inventory.ts`,
  `src/lib/bonus/daily-report-late.ts`, `src/lib/bonus/daily-report-runner.ts`.
- **Storage-limit warning disposition (operator-cleared).** Confirmed the split Phase 5
  already implemented: Woodland OUTDOOR 5,000 warning removed (outdoor concept gone), Woodland
  INDOOR 3,500 and Eugene TOTAL 6,000 preserved. No residual outdoor-keyed warning remains;
  disposition recorded in ADR-0037 §A.4.5.

### Fixed — 2026-07-22 (Loads & Inventory code-review remediation — money-safe boundaries)

Four review findings against `feat/loads-inventory-real-data`; every figure stays on the
single `onHand` running balance (no second inventory total is ever committed).

- **Promotion inbound reconciliation (major).** When a workbook carries its own
  authoritative Processed ledger, the close is computed from the ledger but `onHand`
  re-derives the live floor from the inserted `inbound_loads` rows. The raw DAY
  per-shipment grid can over-sum inbound (June DAY23 Recology Healdsburg's 85-unit
  non-program row, netted out of the billing close), so the stored close and the live
  query-backed balance diverged (4,062 vs 3,977). `promoteWorkbookImport` now calls
  `assertPromotedInboundReconciles` before any write and refuses the promotion
  (`PromotionInboundReconciliationError`, 422) unless the promoted inbound sums exactly to
  the ledger inbound. No-op without a ledger. `src/lib/audit/workbook-promotion.ts`.
- **paper_bulk `arrived_at` boundary (major).** Bulk daily inbound wrote `arrived_at` at
  UTC midnight; the D1 promotion conflict detector keys on Pacific-midnight instant
  bounds, so a first-of-month paper row sat one Pacific day early and escaped that month's
  promotion-refusal (silent double-count). Now written at Pacific midnight of the business
  day (`pacificMidnightInstantOfDayISO`) — the exact bound the window uses; UTC-day
  running-balance/EOD math is unchanged. `src/lib/loads/bulk-inbound.ts`.
- **Physical-count anchor off-by-one (major).** `snapshot_at` is written by the manager
  API as `${date}T00:00:00Z` (a @db.Date key, not a true instant). `daysSinceAnchor` and
  the count-date display re-shifted it through the Pacific zone, printing the count one day
  early and tripping the stale band a day early. Both now treat it as a @db.Date key
  (render/age in UTC). `src/lib/loads/eod-inventory.ts`,
  `src/lib/bonus/daily-report-notifications.ts`.
- **Outdoor-removal regression test typecheck (blocker).** Already resolved at `ccf1fbd`
  (bracket access for index-signature Record fields; TS4111 cleared).

### Added — 2026-07-22 (ADR-0037 Phase 4 — End-of-Day Inventory on the Daily Production Report)

Spec §4 / §A.6. The ADR-0030 daily production email now answers "what is on the floor
tonight?" per site, without opening the app. Written against the post-Phase-5 schema.

- **New module** `src/lib/loads/eod-inventory.ts` — `getEodInventorySnapshot(site, date)`
  returns program / non-program / total on hand, delta from yesterday's EOD (net
  inbound − outbound), the program/NP split %, days since the last physical count, and
  that count's date + counter (resolved from the append-only audit row, not a
  denormalised column). Every figure is read from `onHand` / `computeRunningBalance`
  (ADR-0037 D6) — no second inventory computation exists.
- **Freshness gate** — `EOD_INVENTORY_STALE_DAYS` (default 14). HEALTHY requires a
  `measured` physical anchor inside the window; otherwise the report renders the
  "Inventory pending physical count" warning band with the last anchor date + age, and
  NEVER the healthy figures (a drifted balance read as fact is a mis-billing hazard —
  MRC is billed on program units). A site with no anchor and no movement renders a
  neutral ZERO band so pre-backfill sites read gracefully.
- **Wire-up** — `buildDailyReport` attaches the snapshot; `renderHtmlBody` renders the
  per-site "End-of-Day Inventory" panel after the Trend block. An inventory read failure
  logs and drops the section rather than blocking the production report.
- **Docs** — ADR-0030 amendment (section spec, gate, asOf discipline, config) +
  `docs/operator/daily-production-report.md` (EOD section, the three states, how to
  clear a stale band, window tuning) + `.env.example`.

### Removed — 2026-07-22 (ADR-0037 Phase 5 — outdoor storage removed from Vision)

Bill's directive: _"we will also remove the units outdoor we are never allowed to store
units outside. this can't be in the system."_ DR3 never stores units outside, so the
concept is gone from schema, UI, math, warnings and docs.

- **Schema** — migration `20260806_remove_outdoor_from_site_inventory_snapshots` drops
  `site_inventory_snapshots.units_outdoor` and `sites.max_units_outdoor`. Any non-zero
  outdoor count is first folded into `units_indoor` with an `audit_log` row per fold
  (`actor_label = 'adr-0037-outdoor-removal'`) — no unit is destroyed. The production
  pre-migration audit returned 0 non-zero rows, so no fold ran there. Clean-replayed
  end-to-end on an empty PG16.
- **Math** — `snapshotTotalUnits()` (running balance), the audit leg fetchers, COR
  prefill and workbook promotion now sum `indoor + total + in_processing`. The
  physical-count API drops `units_outdoor` from its Zod schema; the Loads & Inventory
  physical-count panel drops the outdoor input (and the `units_outdoor_label` string in
  all three locales).
- **Warnings** — CA 3,500 is INDOOR-based and OR 6,000 is TOTAL-based; both preserved.
  CA 5,000 was OUTDOOR-specific and is removed with the column, so compliance metric 6
  now grades Woodland against the 3,500 indoor cap instead of the old 8,500 indoor +
  outdoor sum. Classification evidence recorded in the ADR-0037 addendum.
- **Regression** — Woodland's corrected June close still computes 3,977 (3,748 program +
  229 non-program) after the removal.

### Added — 2026-07-22 (ADR-0037 Phase 3 — paper-bootstrap manager surfaces)

Woodland and Eugene run the floor on paper daily logs; there are no operator iPads on
the dock yet, so nothing writes per-load inbound and the daily close bottlenecked on
Bill. Phase 3 makes the whole Loads & Inventory surface operable from paper without
weakening the money-safe boundary.

- **Bulk daily inbound (§3.2 option b)** — new tab on `/dashboard/<site>/loads-inventory`.
  A manager enters the day's inbound as ONE synthesized `inbound_loads` row per site per
  day: total units + a program / non-program split validated to sum (the program pool is
  the billed pool). Written as `load_source_type = 'paper_bulk'`, `count_mode = 'total'`,
  `status = 'verified'`, `arrived_at` at UTC midnight of the business day — the exact
  shape `onHand()` counts as inbound, so the D6 inflow arithmetic is preserved without
  per-load detail. Re-entering a date AMENDS that day (never a second row): enforced by a
  partial unique index and by the service's amend-in-place path, both audited. New
  service `src/lib/loads/bulk-inbound.ts`; new API `GET|POST /api/manager/<site>/bulk-inbound`
  behind the existing `requireActivatedManager` (site-scoped + D7 gate). Converts to
  per-load capture with no schema change when the iPads arrive.
- **Manager daily-close ENTRY (§3.3 Option B)** — new manager route
  `/dashboard/<site>/processed-units-close` mirroring `/admin/processed-units` for entry
  and amendment ONLY, plus `GET|POST /api/manager/<site>/processed-units`. Managers can
  amend a day right up to close; `upsertProcessedUnits` refuses any write once the day is
  closed (409 `closed`).
- **Close-and-lock authority is unchanged and unshared.** `/admin/processed-units` and
  `POST /api/admin/processed-units/<id>/close` are untouched and remain super-admin only.
  There is deliberately NO close handler under `/api/manager/**` and no manager surface
  imports `closeProcessedUnitsDay` — `src/lib/loads/close-authority.test.ts` asserts that
  boundary structurally so it cannot erode by accident.
- **Migration `20260806_adr0037_paper_bulk_inbound_source`** — purely additive:
  `LoadSourceType` gains `paper_bulk`, plus the partial unique index
  (`site_id, arrived_at WHERE load_source_type = 'paper_bulk'`) and the manager-list
  lookup index. Clean-replays on an empty PG16.
- **Docs** — `docs/operator/loads-inventory-foundations.md` gains the paper daily
  workflow (six input streams, who enters what, a manager's day) and stubs BOTH §3.1
  ongoing-capture models — anchor-daily vs. backfill-and-run — with the trade-offs, for
  Bill to pick operationally. The stale D7 "admin-only" section is corrected to the
  data-driven rollout surface now live at both sites.

### Fixed — 2026-07-22 (ADR-0046 Amendment 6 — AP attachment preview reliability, DESKTOP)

Approvers reported the AP invoice preview as unreliable ("can't see the invoice").
Two independent defects, one proven against the live DB. Desktop-scoped: AP review is
managers/admins via Entra SSO; the floor iPads are 403 on the AP surface, so no
iPad-specific handling was added. No schema change, no new dependency, no CSP change,
and the app still never proxies attachment bytes (hard rule #7).

- **The strict MIME gate was hiding the Preview button entirely (PRIMARY, confirmed
  live).** Amendment 4 gated inline eligibility on an anchored `^application/pdf$`
  regex, but the stored `content_type` is Microsoft Graph's label persisted verbatim
  at ingest and never normalized. A live query found **2 of 41 file attachments are
  PDFs stored as `application/octet-stream`** (both `.pdf` by filename) — those
  rendered _no Preview button at all_, download-only. The anchored form also rejected
  `application/pdf; name="inv.pdf"`. The gate now strips `;`-parameters and falls back
  to the filename extension for the genuinely ambiguous types
  (`application/octet-stream` / empty). It stays a positive allowlist: an
  octet-stream `.xlsx` still keeps a plain download.
- **`src/lib/ap/inline-preview.ts` (new)** — the broadened predicate lives in ONE
  shared, pure module imported by BOTH the server route and `ApQueueClient.tsx`, so
  the two copies of this rule can no longer drift (Amendment 4 hand-wrote it twice).
- **Canonical Content-Type on the wire.** The presign previously set
  `ResponseContentType` from the _stored_ type, so an octet-stream `.pdf` served
  `inline` would still download rather than frame. The route now signs with — and
  echoes — `effectiveInlineContentType()` (`application/pdf`, `image/jpeg`, …), and
  its Prisma `select` gained `filename` to make the fallback possible server-side.
- **Expired presigned URLs blanked the frame on the _second_ look (SECONDARY).** The
  URL is minted on expand (so the first view was always fresh), but the client cached
  it forever while the TTL was 300 s — a collapse/re-expand >5 min later, or a
  read-then-download, replayed an expired URL → R2 `403` → blank iframe / dead link.
  TTL raised 300 → **900 s** (route passes it explicitly and returns it in the body so
  the client never hard-codes a drifting value; the `r2.ts` default is raised to match),
  and the client cache now carries `mintedAt`/`expiresIn` and **re-mints** once within
  60 s of expiry instead of returning the cache unconditionally.
- Rejected on purpose: proxying bytes through the app (violates hard rule #7, would
  stream invoice PDFs through load-sensitive CHAD) and adding pdf.js (desktop renders
  inline cross-origin PDFs natively). CSP was audited and is not the blocker — the
  live header already allows `frame-src https://*.r2.cloudflarestorage.com`.
- Still unverified: an end-to-end render of a real signed AP PDF in a desktop browser
  (needs an authenticated approver session behind CF Access). Post-deploy check in the
  ADR.

### Changed — 2026-07-22 (ADR-0037 D7 — Loads & Inventory GO-LIVE)

- **`loads_inventory` rollout surface flipped `pilot → live` for Woodland + Eugene** (audited, attributed to Bill). Managers/operators are now activated at both sites; the `assertLoadsInventoryActivated` gate reads this per-site surface at request time, so the change is immediate (no deploy). Reversible via the inverse flip at `/admin/rollout`.
- Both D7 ops preconditions closed: **P1-3 restore drill MET** (`d4917d0`, passed twice vs real R2 snapshot), **P1-4 RESTIC_PASSWORD off-box CONFIRMED** via the Fleet 1Password item (SHA-256 matches on-box). Reconciled the `OPEN-ITEMS.md` O-3 / `restore-drills.md` / ADR-0037 contradiction — all now CLOSED.
- Follow-up captured: `outbound.ts` `allocation_pct` semantics "pending Kelsey" (nullable, does not affect the running balance) — resolve before her 2026-08-01 departure.

### Added — 2026-07-22 (Navigation — always-visible "← Dashboard" bar across the manager surface)

Closed a long-standing navigation gap: 30 of the 57 manager-surface pages had NO
in-app path back to the Vision Dashboard (`/`) — you were forced onto the browser
Back button. Root cause: the `/bonus` and `/dashboard` route-group layouts rendered
no home nav, and `/admin/**` had no group layout at all. Fixed centrally (one shared
component wired into the three route-group layouts) rather than patching each page.

- **`src/app/_components/back-to-dashboard.tsx`** (new) — the shared nav bar. A real
  `<Link href="/">` styled to the dr3 deep-space theme (bordered pill + chevron), a
  ≥44px touch target for the floor iPads (WCAG 2.5.5), high-contrast with a persistent
  (non-hover-only) affordance and a visible focus ring. Two exports: `BackToDashboardBar`
  (presentational, explicit label — used by English-only `/admin`) and
  `BackToDashboardNav` (resolves EN/ES/UR via `useT()` — used by bonus/dashboard).
- **`src/app/bonus/layout.tsx`** + **`src/app/dashboard/layout.tsx`** — render the
  i18n nav bar at the top inside the existing `I18nProvider` (bonus keeps its
  `SiteSwitchBanner` below it).
- **`src/app/admin/layout.tsx`** (new) — first-ever `/admin` route-group layout;
  renders the bar for all ~27 admin pages. English-only per ADR-0017 (no `I18nProvider`).
- **`src/i18n/locales/{en,es,ur}/manager.json`** — new `nav.back_to_dashboard` +
  `nav.back_to_dashboard_aria` keys (CLAUDE.md hard rule #4).
- **`src/app/_components/vision-shell.tsx`** — the landing-page logo is now a
  `<Link href="/">` (aria-labelled), visually unchanged (belt-and-suspenders home path).
- Coverage: all 55 pages under `/bonus` (8), `/dashboard` (20), `/admin` (27) now reach
  `/` via the inherited layout bar; residual gapped pages = 0. Deliberately excluded:
  `/` (is the dashboard), `/login`, `/operator/**` (PIN iPad flow), `/internal/**`
  (headless PDF), `/survey/[token]` (public). Pages with their own page-level back-link
  (e.g. "← All sites") are untouched — the layout bar sits cleanly above them (different
  targets: page links go up one level, the bar goes to `/`).
- Tests: `back-to-dashboard.test.tsx` (4) + one layout test each for admin/bonus/dashboard
  asserting a link to `/`. 7 green. Verified visually with Playwright at the iPad viewport
  (768×1024): `/bonus`, `/admin/users`, `/dashboard/[site]/compliance`.

### Changed — 2026-07-22 (ADR-0057 D3 addendum — MyMRC billing-field capture: batched getRecordWithFields transport)

Replaced the racy per-record `/s/detail/<id>` navigation-interception detail fetch
(which captured ~0.4% of billing unit-counts because the billing-bearing
`getRecordWithFields` response frequently landed outside the settle window) with a
batched direct Aura POST that replays `getRecordWithFields` — ~100 record-ids per
POST — reusing the list-page framework envelope. Proven live (200 actions/POST →
200/200 SUCCESS, ~0.5 s). Transport swap only — mappers, upsert, and mirror schema
unchanged. Architecture: `scratchpad/mymrc-field-capture-architecture.md` (Terry).

- **`src/lib/mymrc/record-fields-client.ts`** (new) — the batched transport: pure
  codec (`buildGetRecordWithFieldsMessage`/`…FormFields`,
  `parseGetRecordWithFieldsResponse` correlating each action by its echoed `action.id`
  → recordId, per-action SUCCESS/ERROR isolation), the `optionalFields` sets matching
  each mapper (FLS-safe, bounded payload, incl. relationship fields like
  `Haul_Request__c.Recycling_Center_Lookup__r.Name`), and `createRecordFieldsClient`
  (bounded exponential backoff on non-200 / Aura EXCEPTION, one logged-out self-heal
  that rebuilds + re-logs-in + re-captures the envelope, then fails LOUD with
  `AuthFailedError`).
- **`src/lib/mymrc/enrich-details.ts`** (new) — `sweepTargetDetail` (the ONE shared
  batch-sweep primitive) + `enrichDetails` (whole-backlog runner). Resumable off
  `detail_fetched_at IS NULL`; a zero-SUCCESS batch or a logged-out session pages
  `dr3-vision-system` (ADR-0038 D4).
- **`src/lib/mymrc/sync.ts`** + **`backfill.ts`** — the steady-state hourly detail
  pass AND the backfill detail sweep now use the batched transport (both previously
  fetched detail per-record on a shared page — the same root-cause race). The batch
  client is built over the SAME admin session as the list client
  (`PortalClient.getSession()`), so one login still serves list + detail.
- **`scripts/mymrc-enrich-details.mjs`** (new) — one-shot backlog enrichment runner
  with a BEFORE/AFTER coverage reconciliation report.
- Tests: `record-fields-client.test.ts` (18), `enrich-details.test.ts` (9); the
  backfill/sync/scrape suites updated for the transport swap. 348 mymrc tests green.

### Added — 2026-07-22 (Bonus daily entry — total processed mattresses in the footer)

Operator (Bill) asked to see the total processed mattresses alongside the existing
dollar Day total on the Daily Bonus entry grid.

- **`src/app/bonus/DailyEntryGrid.tsx`** — the `<tfoot>` "Day total" row now shows
  the live sum of the per-employee mattress counts under the Mattresses column, next
  to the existing dollar total under the Bonus column. The sum (`totalMattresses`) is
  a `useMemo` over the same input state that drives `totalCents`, so it ticks as the
  operator types — and on the read-only/locked path too. It sums the RAW parsed
  counts (what was processed), NOT the calculator's bonus floor, so a fractional
  entry (e.g. 40.5) is reflected exactly. The figure is `font-mono` bold, right-
  aligned to match `grid-total`, carries a "mattresses" caption plus an exact
  `aria-label` (`data-testid="grid-total-mattresses"`) so it can't be mistaken for a
  dollar amount, and is iPad-legible.
- **`src/app/bonus/months/[id]/ReadOnlyGrid.tsx`** — for visual consistency, the
  locked month grid's "Total payout" footer now fills its previously-empty Mattresses
  cell with the period's total processed mattresses (column sum of each row's month
  total; `data-testid="readonly-total-mattresses"`).
- **`src/app/bonus/DailyEntryGrid.test.tsx`** — new coverage: the mattress total
  renders and equals the sum of entered counts, contributes 0 for blank inputs,
  updates live when a count changes, sums raw (not floored) fractional counts, and
  renders on the read-only path.

### Fixed — 2026-07-22 (ADR-0057 — MyMRC scrape worker: re-auth reliability + activation)

Two fixes to the hourly `mymrc-scrape` worker, surfaced once it began running
against the live portal. This feeds the billing mirror — both changes preserve the
money-safe persistence invariants.

- **`src/lib/mymrc/portal-client.ts`** — mid-run re-authentication no longer fails
  intermittently. The Salesforce portal drops the admin session mid-tick almost every
  hour (the `mymrc_sync_runs` ledger alternated `ok`/`auth_failed`); the old
  `ensureAuthenticated` re-logged-in on the SAME, now-dirty browser context, which is
  unreliable. It now recovers exactly the way `bootstrap` recovers a poisoned
  persisted state — tear the dirty context down, rebuild a CLEAN one
  (`newSessionContext(false)` + new page), log in, and verify a positive auth marker
  — via a shared `rebuildAndLogin` helper, wrapped in a bounded retry
  (`reauthAttempts`, default 3, with a short `reauthBackoffMs`) to absorb transient
  `net::ERR_ABORTED` nav flakiness before purging state and failing loud with
  `AuthFailedError`. All money-safe gates unchanged (`mayPersistState`, `purgeState`
  on final failure, positive-marker `looksLoggedOut`). New coverage:
  `src/lib/mymrc/portal-client.reauth.test.ts` (clean-context heal succeeds; heal on
  a later retry; retries-exhausted → purge + throw).
- **`docker-compose.yml`** — the `mymrc-scrape` worker is now ALWAYS-ON. It carried
  `profiles: ['mymrc']`, which excluded it from the deployer's default
  `docker compose up -d`, so the hourly sync NEVER ran in production (empty
  `mymrc_sync_runs` ledger; data only from manual `--profile mymrc run` backfills).
  With the admin credential now provisioned in the DB store, the profile gate is
  removed so the swarmpilot deployer starts and keeps it up (`restart: unless-stopped`).
  Command, healthcheck, resource limits, volumes, and `MYMRC_CRED_KEY` wiring are
  unchanged; the `ap` and `workbook-sync` profiles are separate and stay gated.
  Follow-up: add `mymrc-scrape` to the noc-master service-registry for fleet monitoring.

### Fixed — 2026-07-22 (ADR-0046 Amendment 5 — pre-go-live hardening pass, Eugene iPad go-live)

Focused fixes on the AP money module ahead of the Eugene iPad go-live. Each was
surfaced by an adversarial verify pass.

- **`src/app/dashboard/ops/ap/ApQueueClient.tsx`** — iPad AP PDF preview no longer
  renders blank. iOS/iPadOS Safari (WebKit) has no inline `<iframe>` PDF viewer, so
  the framed invoice was blank on the Eugene iPad. PDF attachments now always render
  a prominent, touch-sized "Open PDF in new tab" action; on iOS that replaces the
  dead frame, on desktop it rides above Chromium's working inline viewer. Image +
  HTML-body previews unchanged.
- **`src/lib/ap/extraction/claude-fallback.ts`** — the combined body + attachment
  text sent to the metered Anthropic API is now capped at 60,000 chars (`MAX_TEXT_CHARS`,
  mirroring the baseline-import structuring path), closing an unbounded-input cost/DoS
  vector. Images were already size- + count-capped.
- **`src/lib/ap/variance.ts`** — a per-vendor `variance_percent_override` of EXACTLY
  0 is now honored (any variance trips) instead of being silently dropped in favor of
  the 15% global default. Matches the flat-override semantics; treats "override is
  set" as not-null, not truthy. A 0 override is a legitimate tightening control.
- **`src/lib/ap/baselines.ts`** — `trailingWindowStart` no longer overflows on a
  Feb-29 (leap-year) anchor. The 12-month window now clamps the day to the last valid
  day of the target month (Feb 29 → Feb 28 of the prior non-leap year) instead of
  rolling forward to Mar 1, which had excluded late-February invoices from the window.
- **`src/lib/ap/stamp.ts`** — the dual-approval decision PDF meta block now shows
  BOTH approvers + timestamps (First approval / Second approval), consistent with the
  authoritative stamp band line, instead of showing only the first approver and
  mislabeling the first-approval time as the terminal "Decided" time (spec §D-M5-3).
- **`src/lib/ap/approvals.ts`** — the Reject / NOT-DR3 decide path no longer writes
  the DEPRECATED `ap_requests.vendor` / `amount_cents` columns even when a legacy
  client supplies them (hard rule #1: write-stopped on ALL decide paths, columns kept
  for historical data). Reject / Hold / NOT-DR3 keep only their single `decision_note`.
- **`src/lib/ap/variance.test.ts`** — synthetic invented vendor names replace
  real-world company names in fixtures; added money-control boundary tests (established
  gate at exactly 3 invoices; strict-`>` fire/no-fire at exactly the flat and percent
  thresholds; the 0-override regression). Plus Feb-29 window tests
  (`baselines.test.ts`), dual-approval meta-block tests (`stamp.test.ts`), and the
  write-stop assertion (`approvals.test.ts`).
- **migration `20260805_ap_amendment_5_...`** — corrected two inaccurate comments
  (DDL unchanged): the table count ("four" → "five" new tables) and the `ALTER TYPE`
  claim that the DB enum value order matches schema.prisma (it can't — `pending_review`
  was appended out of order by an earlier migration; Postgres enum value order does not
  affect Prisma correctness regardless).

### Fixed — 2026-07-22 (ADR-0046 Amendment 5 D-M5-3 — override-reject email dropped first-approver context)

- **`src/lib/ap/approvals.ts`** — a second-approver override REJECT email no longer
  drops the FIRST approver's `explanation` and equipment linkage. On a structured
  Approve the narrative lives in the `explanation` column (`decision_note` stays
  null), so the `effectiveNote` fallback resolved to NULL on a reject and the
  forwarder + CC'd first approver got the override reason but not what the
  transaction was for. The rejection email now renders the first approval note and
  the first approver's equipment linkage explicitly, per spec §D-M5-3 (line 680:
  vendor + explanation + amount + equipment + note). Regression covered in
  `second-approval.test.ts`.

### Docs — 2026-07-22 (ADR-0046 Amendment 5 finalize — operator runbook brought current)

- **`docs/operator/ap-approvals.md`** now documents the FULL Amendment 5 approver
  flow end-to-end: the structured four-field Approve (vendor freeform / explanation
  / confirmed-amount / equipment multi-select with explicit "Not equipment-related"),
  the intake auto-extraction confidence badges (HIGH/MEDIUM/LOW/FAILED) + the
  `anthropic.env` operator handoff, the variance block-until-acknowledged gate, the
  $1,000 second-approval routing (Woodland → Bill, Eugene → Shannon), and the
  `/admin/ap/baselines` + `/admin/ap/history` (`can_view_ap_history`) access model.
  Reject / Hold / NOT-DR3 documented as unchanged (single reason field). No code
  change — runbook only.

### Added — 2026-07-22 (ADR-0046 Amendment 5 D-M5-4/D-M5-5 — vendor baselines + invoice history)

- **Vendor-baseline aggregation** (`src/lib/ap/baselines.ts`): a pure trailing-12-month
  roll-up per normalized vendor (mean/median/min/max/stddev/count, anchored on the
  vendor's most-recent invoice) feeding `ap_vendor_baselines`, which variance detection
  reads. A baseline is **established** (used to flag) at 3+ invoices.
- **`rebuildVendorBaselines`** recomputes every vendor from `ap_vendor_baseline_history`
  and **preserves admin per-vendor threshold overrides** (`variance_flat_override_cents`,
  `variance_percent_override`) — the aggregate columns are upserted, the override columns
  are never touched. Runs **nightly** (new `ap-baseline-rebuild` cron → internal route
  `/api/internal/ap/baseline-rebuild`, 01:30 PT) and **on demand** (admin "Refresh"
  button).
- **Baseline freshness feed**: every TERMINAL `approved` transition (sub-$1K in
  `decideRequest`; the ≥$1K second-approve in `decideSecondApproval`) appends a
  `vision_approval` row to `ap_vendor_baseline_history` in the same transaction — so
  baselines stay current between Bill's re-uploads. Rejects and the second-approval hop
  do **not** feed.
- **Baseline import** (`/admin/ap/baselines/import`, admin-only): pick a Bill-uploaded
  AP-report PDF from file-drop → **preview** parsed rows (local pdf-parse tabular parse +
  Claude structuring fallback when configured, `src/lib/ap/baseline-import.ts`) →
  **confirm** to write `bill_upload` history and rebuild. The preview is the human guard
  (no DB-level dedupe); drop bad rows before confirming.
- **Per-vendor override management** (`/admin/ap/baselines`, admin-only): set stricter/
  looser flat-$ + percent thresholds per vendor; changes are audited.
- **Invoice history search** (`/admin/ap/history`): union of Vision-decided invoices
  (`ap_requests`) + Bill-uploaded history (`ap_vendor_baseline_history` where
  `source='bill_upload'`; the `vision_approval` feed is excluded to avoid double-counting).
  Filters: vendor typeahead, date range, amount range, site, approver, source. Per-row
  detail modal. No aggregate dashboards (per spec).
- **New scoped read gate** `can_view_ap_history` (`requireApHistoryRead`/
  `checkApHistoryRead`): admins + designated second approvers only — the general
  `ap_approvers` roster is excluded (hard rule #2, mirrors `can_view_billing_verify`).

### Added — 2026-07-22 (ADR-0046 Amendment 5 D-M5-3 — $1,000 second-approval workflow)

- **A structured Approve whose confirmed amount is ≥ $1,000 no longer terminates.**
  It moves to a new `pending_second_approval` state, stamping the first approver
  (`first_approver_id`/`first_approved_at`) + all four required field values, and
  pages/emails the SITE-appropriate second approver (Woodland → Bill, Eugene →
  Shannon Rockwell from `ap_second_approvers`). **NOT-DR3 and every Reject/Hold — and
  every sub-$1,000 Approve — are unchanged** (single-action, first-action-wins). The
  decision email + stamped PDF fire ONLY on the terminal `approved`/`rejected` state.
- **Second-approver decisions** (`POST /api/ops/ap/[id]/second-approval`,
  `decideSecondApproval`): Approve → `approved`; Reject → `rejected` (override), with
  `second_approver_note` and the first approver **CC'd** on the rejection email. The
  approved decision email + stamp now carry **BOTH** approver names + PT timestamps
  ("Approved by [First] on [T1 PT] via DR3-Vision; second approval by [Second] on
  [T2 PT]"). First-action-wins among second approvers (atomic conditional flip).
- **Authorization is server-side only.** Eligible = admin role OR an active
  `ap_second_approvers` row for the decision's site. The first-approver == would-be
  second-approver case (decision (c)) still fires the state but requires an explicit
  re-confirmation click AND a 30-second minimum wait since first approval, both
  enforced in `decideSecondApproval`.
- **UI:** a distinct "awaiting 2nd approval" tab + status badge; a second-approval
  panel showing the first approver's decision read-only, gated to the site's eligible
  second approver, with the self-fulfillment re-confirm + 30s countdown UX; a decided
  ≥ $1,000 row shows both approvers. The `/` AP tile badge folds in the awaiting-2nd
  count for second approvers (admins see all; a rostered second approver sees only
  their site(s)).
- **Notification:** `notifySecondApprovalNeeded` pages `dr3-vision-system` (row id +
  site only, ADR-0045) + emails the routed second approver through the `ap_notify`
  pilot gate ([PILOT] → admins until live). Fail-soft — never fails the first
  approval.
- **Operator handoff (§4):** provision Shannon Rockwell — insert an
  `ap_second_approvers` row `{ user_id: <Shannon>, site_id: 'eugene', active: true }`
  (Bill/Woodland needs no row; admin-eligibility covers it). See the runbook.
- Tests: state-machine transitions, site routing, eligibility, override-reject CC,
  first==second re-confirm + 30s-wait edge case, first-action-wins, dual stamp line
  (`second-approval.test.ts`, 18 cases).

### Added — 2026-07-22 (ADR-0046 Amendment 5 D-M5-1/4/6 — structured Approve + equipment linking + variance banner)

- **The AP Approve path is now STRUCTURED.** A real-site Approve (Woodland/Eugene)
  requires four non-empty fields — vendor freeform (with the exact "check spelling
  and capitalization…" helper prompt), an explanation (replaces the single note on
  Approve only), a confirmed amount pre-filled from the extraction result with a
  HIGH/MEDIUM/LOW/FAILED confidence badge (approver-overridable), and an equipment
  multi-select (site-filtered typeahead over the new `equipment` master, with an
  explicit mutually-exclusive "Not equipment-related" option; at least one selection
  required; writes `ap_equipment_links`; NO inline creation). **Reject / Hold /
  NOT-DR3 keep their single reason/note field unchanged** (§5.4 #4). Extraction only
  pre-fills; the approver confirms every field (§5.4 #5).
- **Variance banner + block-until-acknowledged gate (D-M5-4).** When the typed vendor
  matches an ESTABLISHED baseline (`ap_vendor_baselines`, invoice_count ≥ 3) and the
  confirmed amount trips the $50-flat OR 15%-percent thresholds (either-trips,
  per-vendor overrides honored), a RED banner shows the baseline mean, invoice count,
  and last 3 invoices, and the Approve button is disabled until the approver clicks
  "I've verified the variance" (stamps `variance_acknowledged_by`/`_at` + optional
  note; rides the decision email + stamped PDF footer).
- **Server-side enforcement (never trust the client).** `src/lib/ap/variance.ts`
  (pure either-trips evaluation + baseline/threshold resolution) and
  `src/lib/ap/equipment.ts` (site-scoped active-equipment validation) back the decide
  route: it re-validates all four required fields, re-checks equipment ids against the
  site, and re-evaluates the variance — refusing an above-threshold trip that was not
  acknowledged. New read endpoints `GET /api/ops/ap/equipment?site=` and
  `POST /api/ops/ap/variance-check` feed the panel. `decideRequest` persists the
  structured columns (`vendor_freeform`/`explanation`/`confirmed_amount_cents`/variance
  state), writes `ap_equipment_links` atomically with the flip, and STOPS writing the
  deprecated `vendor`/`amount_cents` (kept, per hard rule #1); the decision email +
  stamp now read the structured columns (falling back to the legacy columns for
  pre-Amendment-5 rows). Tests: `variance.test.ts`, `equipment.test.ts`, structured
  cases in `decide/route.test.ts` + `approvals.test.ts`, and the rewritten
  `ApQueueClient.test.tsx` gating test. (D-M5-3 dual-approval routing is a separate
  slice.)

### Added — 2026-07-22 (ADR-0046 Amendment 5 D-M5-2 — intake auto-extraction pipeline)

- **New `src/lib/ap/extraction/` module: hybrid invoice amount/vendor extraction
  at intake.** `pipeline.ts` (`extractFromRequest`) runs during `runApPoll` (inside
  `ingestMessage`, after body sanitize + attachment fetch, before the queue insert)
  and lands its `ExtractionResult` on `ap_requests.extraction` (jsonb) atomically at
  insert. Ordered hybrid: `local-parser.ts` does pdf-parse text extraction + regex
  heuristics against the four canonical labels (Total / Amount Due / Balance Due /
  Grand Total) and scores HIGH / MEDIUM / LOW / FAILED exactly per spec §2;
  `claude-fallback.ts` fires the Anthropic SDK **only** on LOW/FAILED local
  confidence (model from `AP_EXTRACTION_CLAUDE_MODEL`, default `claude-sonnet-4-6`;
  30s timeout; structured-JSON prompt; logs `cost_cents` per invoice). Fully
  fail-soft — never blocks or fails the poll; a hard failure lands
  `confidence:'failed'` with `error` populated. Extraction only PRE-FILLS the decide
  panel — the approver still confirms every field (hard rule #5).
  `ap_requests.extracted_haul_numbers` is left empty (Phase-2 hook only, gated on
  ADR-0057). New deps: `@anthropic-ai/sdk`, `pdf-parse`. New Anthropic-key secret
  mount (`~/.dr3-vision-secrets/anthropic.env`) enables the fallback; absent → local
  low-confidence lands as-is for manual entry. Fixture-tested for all four tiers +
  scanned-image / plain-text-email / multi-page + mocked Claude API
  (`extraction.test.ts`, 22 cases; all fixtures synthetic).

### Fixed — 2026-07-22 — MyMRC backfill truncated the two big views at 2050 rows (SOQL OFFSET 2000 ceiling)

The historical backfill (ADR-0057 D3) paged the Salesforce Experience Cloud list
views by `offset = pageIndex * 50`. **Salesforce hard-caps the SOQL `OFFSET` at
2000**, so at offset 2050 the portal returned a degenerate `SUCCESS` (no
`recordIdActionsList`, just a "list view isn't available in Lightning" `message`)
that the loop mis-read as end-of-data. The two large views were silently truncated
at **2050 rows** (confirmed live: `completed_hauls` and `outbound_active` both
stuck at 2050 with a drift error); every view under 2000 finished clean.

Replaced offset pagination with **sort-flip** (`src/lib/mymrc/list-page.ts`,
`backfill-portal-client.ts`). CONFIRMED LIVE 2026-07-22 against `mrc-us.my.site.com`:
`getItems` has no cursor token and the org's UI-API is disabled, but pageSize 2000,
`sortBy:'Id'`/`'-Id'` (a stable total order by Record ID), and `getCount:true`
(→ absolute `totalCount`) are all honoured. Ascending Id reaches the first 4000
rows (offsets 0 + 2000), descending the last 4000; their union is the whole view
when `totalCount ≤ 8000` (overlap dedups on the `salesforce_record_id` upsert key).
A view above 8000 pages every reachable window then **wedges LOUD** — never a silent
cap, never a false "complete". `total_records_estimated` now stores the true
`totalCount` (not the overlap-inflated running count).

- Live re-pagination result (verified against portal `totalCount`):
  `completed_hauls` **2050 → 6185 of 6185**, `outbound_active` **2050 → 4490 of
  4490**; all six other views unchanged and still complete. Mirror rows:
  hauls 3072 → 7207, outbound 2074 → 4514.
- Pinned the live-captured `outbound_active` list-view id (`00B4p000005DAqkEAG`).
- Hardened `parseGetItemsResponse` to raise a CLEAR offset-ceiling error on the
  degenerate past-2000 response instead of a misleading "no getItems action".
- Tests: sort-flip plan + coverage math (`list-page.test.ts`), and an end-to-end
  faithful-fake run proving it pages PAST the old 2050 ceiling and wedges loud on a
  view beyond coverage (`backfill-portal-client.test.ts`). Detail enrichment
  (`detail_fetched_at`) is unchanged — the standing hourly/backfill sweep fills it.

### Added — 2026-07-22 — quarterly off-host RESTORE DRILL (proves the backup lane is restorable)

Closes the "a backup nobody has restored is a rumor" gap for the DR3-Vision
lane — the one that carries bonus/payroll/PII. Proves the encrypted restic/R2
backup leg (`scripts/dr3-pg-backup.sh`) is actually _restorable_, on a schedule,
without anyone having to remember. Clones the proven DroneOps restore-drill
template, adapted from its aws-cli/gzip R2 path to our restic/`pg_dump -Fc` path.

- **`scripts/restore-drill.sh`** — pulls the newest `dr3-vision`-tagged snapshot
  from the dedicated R2 restic repo, refuses to certify anything **>48h old**,
  streams `restic dump` → `pg_restore` into a throwaway `dr3_vision_restore_drill`
  DB on the live `dr3-vision-postgres` container, asserts key tables non-empty
  (`audit_log`, `bonus_daily_entries`, `bonus_employees`) **and** the largest
  table (`audit_log`) restores to **≥90% of live**, then drops the scratch DB via
  an EXIT `trap` (guarded to that exact constant name, even on failure paths).
  Mirrors the template's spine: `set -euo pipefail`, `fail()` → ntfy + `exit 1`,
  `PIPESTATUS`-gated restic failure, atomic freshness-metric stamp **only** on
  full success. ntfy is FAILURE-ONLY (ADR-0037) → `infrawatch-alerts` (`high`,
  6h cooldown, dedup `dr3-vision-restore-drill`); a healthy drill is silent.
- **`scripts/systemd/dr3-vision-restore-drill.{service,timer}`** — `Type=oneshot`
  service (User `bbarnard065`, `TimeoutStartSec=30min`) + quarterly timer
  (`OnCalendar=*-01,04,07,10-16 18:13:00 UTC`, `Persistent=true`). On full success
  stamps the node-exporter textfile metric
  `dr3_vision_restore_drill_last_success_timestamp_seconds` (written atomically to
  `/var/lib/node_exporter/textfile_collector/`, scraped by BOS Prometheus as
  instance `CHAD-HQ`) — so a silently-dead timer is itself alertable via staleness.
  Installed + enabled on CHAD-HQ; next fire 2026-10-16 18:13 UTC.
- **Install-time verified** (2026-07-22): `systemctl start` → `Result=success`,
  exit 0, `audit_log=9920/9995` (99.2%), scratch DB dropped, metric live in
  Prometheus.

### Added — 2026-07-22 (ADR-0020 — Operations Dashboard re-enabled for the Eugene iPad go-live)

- **The Operations Dashboard tile is `active` again** (`src/lib/dashboard-tiles.ts`,
  `key: 'operations'`, still `manager+`). It was paused to `coming-soon` 2026-06-06
  "while the underlying surfaces are reworked"; those surfaces (processed-units
  daily close, loads/inventory running balance, Terex throughput/downtime/cost,
  the MyMRC mirror backfill, commodity-payment aging, the compliance slate, bonus
  close) have since landed, so `/dashboard` now leads with a comprehensive,
  legible overview instead of a bare site list. Re-enable is the one-field flip the
  registry comment always promised.
- **New per-site Operations Overview** (`src/app/dashboard/[site]/page.tsx` now
  leads with `overview/OpsOverviewPanel.tsx`, fed by
  `src/lib/dashboard/ops-overview.ts` → `computeOpsOverview`). At-a-glance cards +
  compact tables for: today's active/arrived loads, processing-close status (open
  vs closed = billing-ready), floor inventory (program / non-program / total),
  Terex throughput (7- & 30-day units/day), 30-day downtime + cost, contract
  recycling/recovery rates, the seven-tile compliance slate summary, commodity-
  payment aging (outstanding $, awaiting-invoice > 30d, invoiced-unpaid > 45d,
  disputed), bonus-period standing, and **MyMRC sync freshness** per feed
  (hauls/processed/outbound + shared dock schedule) with last-synced relative +
  absolute Pacific time so staleness is visible. Each panel deep-links to its
  source surface and degrades to an explicit note (never a crash) on read failure.
  The aggregation is a thin orchestrator over the existing source-of-truth modules
  — it re-derives no billing/compliance number.
- **Combined both-sites view** on the `/dashboard` picker for admin / all-sites
  managers (`computeSiteSummary`): Eugene + Woodland side-by-side (on-dock,
  arrived-today, on-floor, processing state, commodity outstanding, worst MyMRC
  freshness) above the site links. Single-site managers are unaffected.
- **iPad-first legibility:** dark Vision palette (ADR-0014), no sub-12px real-data
  text, WCAG-AA contrast, ≥44px touch targets, no hover-only affordances, tables
  scroll inside their own container (zero horizontal page scroll verified at
  768×1024 / 1024×768 / 390 / 1440 via Playwright), every figure labeled with a
  unit, times shown in Pacific. Refresh is the 30s ops cadence (`OverviewPoller`)
  — lighter than the old 5s dock poll now that the surface aggregates heavier
  analytics.
- **Site isolation preserved** (hard rule #2): every read is scoped to the
  resolved site id; the mirror `site_id IN {this site}` filter also excludes
  not-yet-resolved NULL rows; the shared MyMRC dock schedule is labeled "all sites"
  since it carries no site discriminator. The 403 gate for off-site managers is
  unchanged.
- Tests: `src/lib/dashboard/ops-overview.test.ts` (freshness grading + commodity
  aging buckets), `src/app/dashboard/[site]/overview/OpsOverviewPanel.test.tsx`
  (rendered legibility contract + degraded-panel handling), and updated
  `src/lib/dashboard-tiles.test.ts` for the flip. Full suite green (2731 passed).

### Fixed — 2026-07-22 (ADR-0057 D3 — backfill full history: Completed Hauls + inactive-materials views)

- **MyMRC backfill now pages ALL list views per object — active AND history —
  so it pulls full history, not just active records.** Caught during the live
  first backfill: the worker paged only the active/default views, so **"Completed
  Hauls" (the ~720+ historical trailer deliveries)** and the inactive-Materials
  views were never pulled. `BACKFILL_LIST_VIEWS` (`src/lib/mymrc/list-page.ts`)
  gains 3 history cursors — `completed_hauls` (→ `mymrc_hauls_mirror`,
  `00B4p000005DAqSEAW`, paginates — the bulk of haul history), `processed_inactive`
  (→ `mymrc_processed_mirror`, `00BUJ000001sJxx2AE`), `outbound_inactive`
  (→ `mymrc_outbound_mirror`, `00BUJ000001sJuj2AE`) — all captured live 2026-07-22.
  `buildBackfillTargets` (`backfill-targets.ts`) enumerates all 8 cursors; the
  offset loop, resumable per-view cursors, and dedup-by-`salesforce_record_id` are
  unchanged. A haul id that appears in both an active view (Docking/Consumer) AND
  Completed Hauls **upserts once** (mirror key) and its detail is fetched once
  (`detail_fetched_at IS NULL`, targets run sequentially). Inactive Materials still
  route by `Type__c` to processed/outbound — the inactive VIEWS only widen
  coverage. **No migration:** cursor rows are created lazily by the worker on first
  run (`mymrc_backfill_cursors` upsert). Config-drivable: `MYMRC_LISTVIEW_IDS`
  keys the new views (`completed_hauls` / `processed_inactive` / `outbound_inactive`);
  adding a further view later is a one-line map entry. Residual: the Hauls picker's
  "More" menu may expose further uncatalogued views (OPEN-ITEMS C-25) — captured +
  added only once an id is in hand (ids are never guessed).

### Added — 2026-07-22 (ADR-0057 Phase 1 — real MyMRC ingestion, informed by the inaugural Phase-0 discovery)

The first authenticated MyMRC pull (Phase 0, 2026-07-21) returned a real object
catalog nothing like the original ADR guess — so Phase 1 was built against the
**real** Phase-0 shapes (`docs/mymrc-discovery-2026-07-22.md`), not a guessed
mirror schema. This feeds production billing; correctness and reliability were
the bar. Schema foundation landed in `4057d0f`; this block is the ingestion
wiring on top of it.

- **Mappers adapted to the real object catalog** (`src/lib/mymrc/mappers.ts`).
  `mapHaulRecord` now reads every real `Haul_Request__c` field (billing-authoritative
  `Recycler_Program_Unit_Count__c`, `Recycling_Center_Lookup__r.Name` site
  discriminator, transporter/collection/commodity/container, consumer-drop-off
  units, docking date). Fixed two latent placeholder bugs: `weight_lbs` read the
  non-existent `Weight__c` (always null) → now `Recycler_Weight__c`; the unit count
  read a _Materials_ field → now the correct haul field. `mapProcessedRecord` /
  `mapOutboundRecord` map `Materials__c` (ONE object, split by `Type__c` at ingest
  via new `classifyMaterialsType`); `weight_lbs` is hard-null (Materials has no
  weight field). New `mapDockAvailabilityRecord` for the new
  `Dock_Availability_Schedule__c` object (raw multipicklist codes; SF Time strings
  kept verbatim, never `Date.parse`d). All mappers read `value` for identity, never
  `displayValue`; the full raw record is preserved in `payload`.
- **Windowed backfill worker** (`src/lib/mymrc/backfill.ts` + `backfill-targets.ts`)
  — schema-agnostic engine: per object×list-view, pages `getItems` by
  offset/`hasMoreData` to `hasMoreData:false`, persisting a
  `mymrc_backfill_cursors` row after every page (resumable mid-pagination), then a
  bounded (≤3) detail sweep of rows with `detail_fetched_at IS NULL`. Idempotent on
  SF-id upsert keys; a pagination wedge fails loud (cursor error + ntfy) while a
  per-record detail failure retries next run. 5 cursors wire the 4 real objects
  (Haul ×2 views, Materials ×2 views, Dock ×1).
- **Offset-pagination transport — backfill is now LIVE, no longer inert**
  (`src/lib/mymrc/list-page.ts`, `backfill-portal-client.ts`,
  `scripts/mymrc-backfill.mjs`; closes OPEN-ITEMS C-24). The `getItems` OFFSET
  pagination was CONFIRMED LIVE 2026-07-22: an Aura
  `ListViewDataManagerController.getItems` action with
  `{filterName, entityName, pageSize:50, layoutType:"LIST", sortBy:null,
getCount:false, enableRowActions:false, offset:N}` returning
  `{records, offset, hasMoreData}`, looped to `hasMoreData:false`. `list-page.ts`
  encodes the request/response codec + list-view id resolver PURE (unit-tested);
  `createBackfillPortalClient` maps the engine's 0-based `pageIndex → offset =
pageIndex*pageSize` (a pure function of the resumable cursor) and replays the
  getItems POST, reusing the live aura framework envelope the browser sent
  (immune to `fwuid` drift) — chosen over DOM infinite-scroll for determinism.
  The shared, self-healing admin session was extracted to `openAdminSession`
  (both the steady-state client and the backfill transport reuse it — one auth
  path). List-view ids: 2 captured live (Docking, Processed); the other 3 resolve
  at RUNTIME from the browser's own getItems request, or via a
  `MYMRC_LISTVIEW_IDS` operator override — an id that resolves to NONE fails LOUD
  per-target (a resumable wedge + ntfy), never guessed. Run one-shot:
  `node scripts/mymrc-backfill.mjs` (resumable + idempotent; safe to re-run).
- **Hourly sync wired to the real objects** (`src/lib/mymrc/sync.ts`). Site scoping
  moved from the login to the DATA (ADR-0057 D1 / recon B §6): a single admin
  session lists ALL records globally (`site_id` NULL at list time), and each row's
  site is derived + stamped on the DETAIL pass from its discriminator
  (`recycler_name`/`account_name` → `sites.code`), stamped **only when resolved**
  (never a NULL over a prior attribution). All new mirror columns are populated.
  **`expected_loads` join fixed (money-critical):** joins on the real
  `Collection_Site__c` (the old code used `Rate_ID__c` and matched nothing) and
  bills the authoritative `program_unit_count` (was the always-null `units`).
- **Stale-session self-heal** (`src/lib/mymrc/portal-client.ts`). Fixes the live
  bug where a tick ending logged-out wrote anonymous cookies over the good
  `storageState`, poisoning every subsequent tick. `storageState` is now persisted
  **only** after a positive auth check (money-safe latch); bootstrap proves auth up
  front, discards a logged-out persisted state and re-logs-in, and purges the
  poisoned file before failing loud on a hard auth failure. Bounded nav retries
  absorb transient blips without an unbounded loop.
- **Reconciliation-feed wiring** (`src/lib/mymrc/reconcile-feed.ts`,
  `reconcile-detect.ts`). After each sync tick the scrape feeds unknown
  collection-site / account names (real discriminators `Collection_Site__c` /
  `Account__r.Name`) into the Wave-2 `mymrc_reconciliation_queue` as `new_record`
  candidates for operator approval — **queue only, never a direct `sources` write**
  (ADR-0057 D4). Dedups within a pass, across feeds, and across runs. `apply.ts`
  now resolves the hauls mirror's site too, so hauls candidates are approvable; an
  unresolved `site_id` throws `ReconNotFoundError` rather than approve an unscoped
  `sources` row (money-safe invariant preserved through the nullability widening).
- **Discovery fixture redaction hardened** (`src/lib/mymrc/discovery.ts`). Closes
  the 143-name leak class — flat person-name audit/lookup fields (`*_By__c`,
  `…ById`, `Owner`/`Manager`, `Employee_*`) are now scrubbed while opaque
  Salesforce ids and all business fields (site/vendor/transporter names, counts,
  dates) are retained. The raw disc3 fixtures were read for structure only; the
  committed `__fixtures__/phase1/` set is fully synthetic (DR3 Testville / Synthetic
  Hauling Co / fabricated ids). (Correction: a few real DR3 record numbers had
  leaked into inline test data / schema comments outside that dir — scrubbed in the
  2026-07-22 review remediation below.)

### Fixed — 2026-07-22 (ADR-0057 Phase 1 review remediation — pre-deploy, same branch)

Review of the Phase-1 branch before deploy caught four issues; all fixed here.

- **BLOCKER — windowed list mass-marked the haul tail as disappeared (billing
  loss).** The hourly sync ran disappeared-detection (`markDisappeared`, an
  `updateMany` over every active row NOT in the listed set) against whatever
  `fetchListRecordIds` returned — but the transport only returns the FIRST Aura
  window when a feed exceeds one page (Haul/Materials routinely do). Once the
  mirror held more than one window (guaranteed the moment backfill drains the
  tail), every tick stamped `disappeared_at` on the unseen tail, and
  `feedExpectedLoads` (which filters `disappeared_at: null`) silently dropped those
  hauls from the billing queue. Fix: `fetchListRecordIds` now returns
  `{ ids, complete }` (`complete = !hasMoreData`), and `syncFeed` runs
  disappeared-detection **only on a proven-complete list**; a windowed page skips it
  (never over-marks — a truly-removed record stays active until a complete list is
  seen, the money-safe direction). New tests lock both branches.
- **DR deadman false-green for Eugene.** The scrape looped `['eugene','woodland']`
  against ONE global admin session (C-21: the session sees a single recycler
  context). The now-global list pass let the vestigial `eugene` pass "succeed" and
  write an `ok` `mymrc_sync_runs` row, so `checkDeadman` reported Eugene healthy
  forever despite zero Eugene records. Fix: the scrape resolves the **active
  recycler context** (`resolveActiveSites`, default `woodland`, overridable via
  `MYMRC_ACTIVE_SITES`) and syncs + deadman-watches only that set — no false-green.
- **Backfill worker was orphaned + PII in new test files.** The backfill surface
  (`runBackfill`/`buildBackfillTargets`) is now exported from the `@/lib/mymrc`
  barrel (was omitted despite the "export the surface" commit); it remains INERT
  pending a production paginating portal adapter (OPEN-ITEMS C-24). And a few real
  DR3 record numbers from the Phase-0 pull (a haul number, a dock-schedule number,
  and one real Account id) that had been copied into newly-committed test/schema
  files were replaced with the established synthetic values
  (`H-900001`/`DA-900001`/`001460000SYNTHTVLAAQ`) — correcting the earlier "fully
  synthetic" claim for this branch.

### Changed — 2026-07-21 (ADR-0019 §2 / ADR-0030 amendment — later-shift bonus timing: 8pm entry deadline + report-on-save)

The team now works a later shift. The bonus entry deadline moves to **8:00 PM
Pacific**, and the per-site production report is now primarily an **on-save**
event ("the report goes out for each site as soon as the data is entered and
saved"). No schema change — all timing lives in the daemon fire hour, the on-save
path's send gate, and the `send_time_pt` config value.

- `scripts/bonus-eod-check.mjs` — entry-deadline / "no entries" late-notification
  daemon fire hour `FIRE_HOUR_PT` 17 → **20** (8pm PT). DST-correct via the existing
  offset-reprobe `nextFireInstant` (no hardcoded UTC offset). Per-site ntfy for a
  zero-entry site is unchanged apart from the hour.
- `src/lib/bonus/daily-report-late.ts` — `maybeSendLateDailyReport` →
  **`maybeSendDailyReportOnSave`**. The report now fires on **every** successful
  save (removed the `!isPastScheduledSend → not_late` gate). Lateness (past the 8pm
  deadline / a prior day) no longer gates the send — it only sets `late_submission`
  and the LATE banner/subject. New outcomes `sent` / `resent` (on-time) alongside
  `sent_late` / `resent_late`. Still fail-soft (never fails the save), still
  idempotent per `(site, report_date)` via the log-row unique + resend-on-changed-
  totals — a re-save of the same numbers never double-sends.
- Callers updated: `src/app/api/bonus/entries/route.ts`,
  `src/app/api/bonus/amendments/[id]/approve/route.ts`.
- `prisma/seed.mjs` — daily-report `send_time_pt` seed 18:00 → **20:00** PT: the
  value now means the 8pm deadline / lateness threshold, and the ADR-0030 scheduled
  daemon becomes a pure end-of-window backstop (whichever path claims the log row
  first sends; the other skips — no double-send).
- **Signing escalation tiers (07:10 / 07:30 / 08:30 auto-sign / 09:00) are
  UNCHANGED** — those govern the morning-after signing chain (ADR-0019 §-signing /
  `bonus-escalation-check.mjs`), a separate concern from entry.
- **Operator action for prod:** set each enabled site's daily-report `send_time_pt`
  to `20:00` via Admin → Daily Report Config (the seed only affects fresh/CI DBs).
  Until then the on-save report still fires on save; only the "late" flag threshold
  stays at the old value. The 8pm not-entered ntfy is hardcoded in the daemon and
  already correct.

### Fixed — 2026-07-22 (ADR-0057 Phase 0 — MyMRC scrape/discovery against the REAL portal)

First live run of the ADR-0038/0057 code (written against synthetic fixtures, never run
live) revealed four divergences from the real `mrc-us.my.site.com` portal. Selectors
bumped `2026-06-22` → `2026-07-22`. Branch `fix/mymrc-scrape-live-portal`.

- **Login now fills by PLACEHOLDER + submits by ROLE.** The Lightning login fields have no
  `name` and dynamic numeric ids; the only stable hook is the placeholder ("Username" /
  "Password"), and the button reads "Log In". `src/lib/mymrc/selectors.ts` +
  `portal-client.login()` + `scripts/mymrc-discovery.mjs` now use
  `getByPlaceholder(...)` / `getByRole('button', { name: /log ?in/i })`. Fixes silent
  logged-out no-op affecting BOTH the hourly sync and discovery.
- **Hardened `looksLoggedOut` to a POSITIVE auth-marker check.** `/s/home` is a 404 "Error"
  page for authed + anon sessions alike (no password field) — the old check read it as
  "logged in", so `AuthFailedError` never fired on a failed login. Logged-in now requires
  a Switch-Account / "viewing as DR3" banner or ≥2 object nav links AND no visible "Log in"
  control. The discovery runner delegates to the shared, fixture-tested predicate.
- **Discovery enumerates via the NAV → per-object list pages, not `/s/home`.** New pure
  helpers in `discovery.ts` (`objectSlugFromHref`, `objectPagesFromHrefs`,
  `extractNavMenuHrefs`, `resolveObjectPages`) resolve the object slugs (`hauls`,
  `illegal-dump-cip-`, `processed-materials`, `outbound-materials`, `availability`,
  `outbound-vendors`, `records-review`) from the `getNavigationMenu` Aura response / DOM
  links (Home/FAQs/Support/Reports filtered), with a static allowlist fallback. Auth is
  verified at `/s/` (the real authenticated landing), never `/s/home`.
- **Discovery output dir configurable via `MYMRC_DISCOVERY_OUT_DIR`** (defaults to repo
  root). Fixes the `EACCES` the first run hit writing under the container's read-only
  `/app` as uid 1001; point it at a writable mounted volume.
- Fixtures: rewrote `authed-shell.html` to the real `/s/` shell, added `home-404-page.html`
  (the `/s/home` trap), `discovery/nav-getnavigationmenu.json`, `discovery/hauls-list-page.json`.
  New unit tests cover nav→object-page resolution, per-object-page enumeration, and the
  logged-in detector (authed-nav vs login-form vs `/s/home` 404). No schema/migration change.
- **FOLLOW-UP flagged (not implemented):** "Switch Account" (DR3 Woodland ↔ DR3 Eugene) —
  the hourly scrape may need to iterate both account contexts to pull both sites' data.

### Added — 2026-07-22 (ADR-0057 D1/D9 — MyMRC admin credential store, encrypted DB surface)

Foundation for the MRC-Scrape credential surface: Bill's MyMRC admin login now lives in
an encrypted single-row DB table instead of a `.env` file (operator rule — no `.env` for
these creds). This is the store the admin entry UI writes and the scrape reads; it
unblocks Vision's first-ever MyMRC pull.

- `prisma/schema.prisma` — new `MymrcAdminCredential` model → `mymrc_admin_credentials`.
  Single row (`id='singleton'`, CHECK-enforced): `username` (plaintext login id),
  `password_ciphertext` / `password_iv` / `password_auth_tag` (base64 AES-256-GCM),
  `key_version`, `updated_by` (bare audit-actor id), timestamps.
- `prisma/migrations/20260802_adr0057_mymrc_admin_credentials/migration.sql` — additive
  CREATE TABLE (ADR-0035 clean-replay), singleton CHECK constraint.
- `src/lib/mymrc/credential-store.ts` — server/scrape module (dual-compiled under
  `tsconfig.mymrc.json`, so no `@/` alias / no `server-only`): `setMymrcCredentials`
  (encrypt + upsert + password-free audit row), `getMymrcCredentials` (decrypt; scrape
  read path; fail-closed on tamper), `getMymrcCredentialStatus` (no password/ciphertext,
  safe for the UI). Password is write-only across every boundary.
- **Encryption key = dedicated `MYMRC_CRED_KEY`, NOT `NEXTAUTH_SECRET`** (scrypt +
  fixed app salt). The scrape container is deliberately stripped of `NEXTAUTH_SECRET`
  (ADR-0053 addendum); a dedicated key lets both the app (writer) and scrape (reader)
  decrypt without reversing that hardening. INTEGRATION PREREQ: `MYMRC_CRED_KEY` must be
  injected into BOTH the `app` and `mymrc-scrape` runtime env (tracked with O-12).
- `src/lib/mymrc/credential-store.test.ts` — 21 tests: round-trip, status leaks nothing,
  tamper/auth-tag/wrong-key/key_version fail closed, empty/whitespace rejected, missing
  key aborts, migration↔schema parity.

### Added — 2026-07-22 (ADR-0057 D4 / Addendum A — MyMRC reconciliation queue + CA source disambiguation + two-haul-mode gate)

The reconciliation layer that stands between MyMRC mirror data and Vision's operational
tables. Vision NEVER auto-updates `sources` / `source_aliases` / `state_program_rules` from
a MyMRC pull: the sync detects candidate changes, writes them to a review queue, and only an
explicit admin **approve** applies one to an operational table (reject writes nothing, snooze
defers 7 days). Every decision carries a required note and is audited in the same transaction
as the state flip (first-action-wins). Built now, populates at the first post-Phase-0 backfill
for Bill's bulk-approve — nothing here writes to an ops table until he acts.

- `prisma/schema.prisma` — `MymrcReconciliationQueue` model → `mymrc_reconciliation_queue`
  (generic field-level rows: `mirror_table`/`mirror_record_id`/`target_table`/`field_name`/
  `mymrc_value`/`vision_value`/`change_kind`/`status`/audit + `snooze_until`), plus enums
  `ReconChangeKind` (`new_record|field_update|disappeared`) and `ReconStatus`
  (`pending|approved|rejected|snoozed`). Additive; 3 indexes (pending view, classifier dedup,
  target lookup).
- `prisma/schema.prisma` — `CollectionEvent.dr3_hauled Boolean @default(true)` on
  `collection_events`. Default `true` reproduces current invoice output on the additive
  backfill (all existing events carry billed freight) — the money-adjacent safe direction;
  `false` is the new customer/third-party-haul exception.
- `prisma/migrations/20260803_adr0057_reconciliation_queue/migration.sql` — additive: both
  enum types, the `dr3_hauled` column, the queue table + indexes.
- `src/lib/mymrc/reconcile-detect.ts` — pure, dual-compiled `new_record` classifier: a mirror
  source name matching NEITHER `sources.name` (verbatim) NOR a normalized `source_aliases.alias`
  becomes one queue candidate (reuses the byte-identical `normalizeSourceName` the upsert path
  uses). Emits only `new_record`/`sources` this wave (accounts mirror is Phase-0-pending).
- `src/lib/reconcile/apply.ts` — decision engine (approve/reject/snooze); the ONLY operational
  write (`source.create`) is inside the approve branch of one transaction. Required-note gate
  (`assertReconcileNote`, ≤2000), unsupported-target refusal (never silent no-op), plus
  `bulkApproveReconciliations` (per-item tx so one bad apply fails alone) and
  `pendingReconcileCount` for the tile badge.
- `src/app/api/admin/mymrc/reconcile/**` — admin-gated (`requireAdmin`) pending-list GET,
  per-item decide POST, and bulk-approve POST (all note-gated + length-capped).
- `src/app/admin/mymrc/reconcile/` — admin review page + client; `mymrc-reconcile` dashboard
  tile (admin-only, `Scale` icon).
- `src/lib/mymrc/ca-source-seed.ts` — Rick's 2026-07-21 CA (Woodland) disambiguation constant
  (`CA_SOURCE_DISAMBIGUATION`, 7 confirmed rows; `CA_SOURCE_DISAMBIGUATION_PENDING`, 5 hints
  still awaiting Rick's exact canonical names). Pure/dual-compile-safe; the operator's canonical
  reference when approving CA `new_record` candidates. No canonical name or address is invented.
- `prisma/seed.mjs` + `prisma/seed/addendum-b-data.mjs` — §A.8.2 CA office aliases (woodland-
  scoped, self-activating: each no-ops until its canonical Source clears the D4 queue); §A.4
  Covanta seeded `is_active:false` with NO recycling rate (WTE % pending Rick).
- `src/lib/commodity/fetch.ts` — an inactive vendor's name never reaches the customer-facing
  commodity attachment (falls through to free-text buyer).
- §A.3 two-haul-mode gate: `src/lib/invoices/{types,event-leg,generate}.ts` sum event freight
  (`B16.event_freight` → `MILES 0`) only for `dr3_hauled` events (provenance still stamps all);
  `src/lib/event-billing/tonu.ts` refuses TONU for a non-DR3-hauled event
  (`not_dr3_hauled`). Labor/EVENTO (B8) fires in both modes.
- §A.5 verify: `Xtraction × metal = 0.8100` pinned with a test guarding against silent drift.

### Added — 2026-07-22 (ADR-0057 D1/D9 — MRC-Scrape credential surface + auth transition)

The admin UI/DB surface for the credential store above, plus the scrape's transition off
per-site `.env` logins onto the single DB-backed admin identity. With this, Bill can enter
his MyMRC admin login at `/admin/mrc-scrape` and the hourly scrape decrypts it — the last
step before Phase 0 discovery (O-12).

- `src/app/admin/mrc-scrape/` — admin-only page (`/admin/mrc-scrape`) composing the
  write-only credential form (`MrcScrapeForm`, no `<form>` per hard rule #10) and the
  read-only status panel (`ScrapeStatus`) via a `MrcScrapePanels` shell that refetches
  status on save. Password is never pre-filled, never returned, never logged.
- `src/app/api/admin/mrc-scrape/credentials` (POST, save) + `.../status` (GET, read-only
  state: credential-configured, last run, per-object mirror counts + `neverRun`). Both
  admin-gated; neither returns the password/ciphertext.
- `src/lib/dashboard-tiles.ts` — lit up the `mrc-scrape` admin tile (was a coming-soon
  placeholder) → route `/admin/mrc-scrape`, `scope: admin-only`.
- `scripts/mymrc-scrape.mjs` / `mymrc-cron.mjs` — single admin login (no per-site loop);
  **D9 fail-loud**: unconfigured/undecryptable creds page `dr3-vision-system` and exit
  non-zero (was silent skip + exit 0). New `scripts/mymrc-healthcheck.mjs` +
  compose `healthcheck` report UNHEALTHY until a credential row exists.
- `src/lib/mymrc/credentials.ts` / `portal-client.ts` — auth model swapped from
  `SiteCredentials`/per-site auth-state to the DB store + single admin session
  (`~/.dr3-vision/mymrc-admin/auth.json`); `CredentialsNotConfiguredError` (D9).
- `docker-compose.yml` — **end-to-end key path wired**: `mymrc-cred-key.env`
  (`MYMRC_CRED_KEY`) mounted on BOTH `app` (encrypt on save) and `mymrc-scrape`
  (decrypt), both `required: false` (deploy-before-provision). Retired the per-site
  `mymrc.env` mount + `MYMRC_{EUGENE,WOODLAND,OR,CA}_*` vars.
- `src/app/api/health/subsystems/route.ts` — the MyMRC subsystem pill now reads the DB
  credential store (`getMymrcCredentialStatus`) instead of the retired `MYMRC_*_USERNAME`
  env greps, so it reflects real configured state; a store read error degrades that one
  tile to amber rather than reddening the whole footer.
- Tests: credential + status routes, form + status components, D9 orchestration, and a
  compose-wiring guard asserting BOTH `app` and `mymrc-scrape` mount `MYMRC_CRED_KEY`.

### Added — 2026-07-21 (ADR-0057 accepted — MyMRC full-object ingestion via admin-user creds)

Ships the ADR-0057 decision (from the 2026-07-21 handoff): retire the never-honored
per-site service-account MyMRC auth, move to Bill's single admin-user credentials,
extend ADR-0038's 3 hardcoded feeds to N discovered Salesforce objects, add a manual
reconciliation queue as the write gate to operational tables, and convert the
missing-creds path from a silent skip to a fail-loud `CredentialsNotConfiguredError`
(D9). Historical framing preserved: Vision has never pulled a byte from MyMRC — all
three mirror tables are empty and Phase 0 is first contact.

- `docs/adr/0057-mymrc-full-object-ingestion.md` — Accepted (2026-07-21).
- `docs/adr/0038-mymrc-ingestion-rebuild.md` — annotated: auth model superseded by
  ADR-0057; documents the never-created service accounts + silent-no-op history.
- **NOT IMPLEMENTED YET.** Phase 0 discovery + Phase 1 foundation are HALTED on the
  credential prerequisite: `MYMRC_ADMIN_USERNAME` / `MYMRC_ADMIN_PASSWORD` are not yet
  provisioned into the `mymrc-scrape` runtime env (only the old, never-honored
  `MYMRC_WOODLAND_*` / `MYMRC_EUGENE_*` vars exist). Per operator rule these will NOT
  be a committed `.env` file — Bill injects them via the approved secrets mechanism
  when ready (security confirmed 2026-07-22). Tracked as OPEN-ITEMS **O-12**. No
  code/schema/auth changes in this PR — decision doc only.

### Fixed — 2026-07-21 (admin user creation rejected valid operator/manager payloads — ADR-0017)

`POST /api/admin/users` returned **"Invalid request payload"** (422) when creating an
operator (and managers were affected too). Root cause: the `optionalEmail` /
`optionalProcessorRole` / `optionalPin` Zod schemas used `.optional()`, which accepts
only `undefined` — but `UserCreateForm` sends an explicit **`null`** for any field that
doesn't apply to the chosen role (an operator's email + processor*role, a manager's pin).
The schema's own comment already documented that null must be allowed; the implementation
didn't. Fixed by switching the three optional fields to `.nullish()` (nullable + optional).
The existing operator test used `email: ''` (empty string, which the old schema \_did*
accept), so it never caught the real form's `null` — added regression tests using the
exact null-field payloads the form sends (operator and manager). Reproduced against prod
(422 with `fieldErrors: email, processor_role`) before the fix; no schema/DB change.

### Fixed — 2026-07-21 (ADR-0048 D3 — Terex importer date plausibility + silent-drop surfacing)

Confirmed prod bug: the Terex maintenance-log importer stored a garbage
`equipment_events` row with `event_date = 1900-01-14`. When an operator leaves a
stray number in a date-FORMATTED Date cell (typing the real date into the note
instead), exceljs surfaces it as an Excel-epoch `Date` and `parseFlexibleDate`
happily returned `1900-01-14`. Verified against Janette's real workbook: 1 of the
68 imported events carried the 1900 date (its note held the real `01-15-2026`).

- **Plausibility floor/ceiling on `parseFlexibleDate`** (`src/lib/equipment/import.ts`):
  a parsed date outside `[2000, 2100]` is treated as NOT a valid date (returns
  `null`). Applied consistently, so the strict CSV path (`rowsToEvents`) now fails
  loud on an Excel-epoch date instead of storing a 1900 event, and the
  maintenance-log path stops producing the garbage row.
- **Never silently drop a real event.** A maintenance-log row that carries
  descriptive TEXT (issue/measures/notes) but no plausible date is no longer
  discarded: it is collected into a new `warnings` array (sheet, 1-based row,
  raw Date cell, content preview) and returned through `TerexImportResult` → the
  admin import API response. Money-only, dateless rows (SUM/subtotals) still skip
  silently. This surfaced a SECOND, larger data-loss pattern in the real file:
  the entire January 2026 block was entered with dates in the Issue column (or
  human formats like `Jan.6,2026`), and the old importer silently dropped all
  ~18 of those real events. They now appear as warnings for source correction.
- **Persisted `equipment_history_imports.rows_warned`** (additive migration
  `20260801_adr0048_terex_rows_warned`) + the count in the batch audit row.
- **Hardened `worksheetToGrid` cell unwrap**: exceljs formula/richText/hyperlink/
  error cells were previously leaked downstream as `[object Object]` for any shape
  other than `{result}`; all object shapes are now unwrapped (uncached formula /
  error → `null`), preventing silent note/cost corruption.
- Tests: fixture gains an Excel-epoch content row asserted into `warnings` (not
  events); plausibility-window, strict-CSV-epoch, and subtotal-not-warned cases.

Re-import hazard (operator action required): the existing prod batch
(`import_id 42d0ebdd`) already contains the 1900 garbage event. Re-uploading a
corrected file will recover the ~18 dropped January events but will NOT remove the
1900 orphan, and will create a duplicate for that incident (the corrected
`2026-01-15` row keys on a different date, so it won't dedup against the 1900 row).
Soft-void the single garbage event (`event_date=1900-01-14`, `import_id=42d0ebdd`)
BEFORE re-importing. Do not delete-and-reimport the whole batch.

### Changed — 2026-07-21 (AP approvals now require an explanatory note — ADR-0046 amendment)

Approving an AP invoice now REQUIRES a non-empty note describing what the transaction
was for and any additional context — matching the existing reject-requires-note and
NOT-DR3-requires-reason gates. Previously approvals were note-optional, leaving no
recorded transaction purpose on plain approvals (audit-trail gap). Operator directive:
_"on the AP module let's not allow approval without a note — the user needs to enter
data about what the transaction was for and explain additional context before being
able to approve the invoice."_

- **Service** — `assertDecisionNote` (`src/lib/ap/approvals.ts`) now throws
  `ApNoteRequiredError` (400) for an approval with no/blank note, same trimmed
  minimum as rejection, with an approval-specific message. NOT-DR3's own
  reason-required guard is unchanged and still enforced.
- **Route** — `/api/ops/ap/[id]/decide` continues to validate the note BEFORE any
  state change; the extended rule maps to a typed 400 with no DB write.
- **UI** — the approver panel disables **Approve** until a non-empty note is present
  (mirroring Reject/Hold); the Note field is relabeled **(required)** and prompts for
  "what this transaction was for + any additional context".
- Tests: `assertDecisionNote` unit tests + a decide-route test (approve-without-note
  → 400, no decide) + a new `DetailPanel` interaction test (Approve disabled without
  a note). No e2e/Playwright harness exists for the AP page — behavior is covered by
  the interaction test instead.

### Fixed — 2026-07-21 (full-stack audit — P1-3 backup-failure alerting)

Confirmed audit finding P1-3: the DR3 restic backup lane's failure alerting had
been dead for a month. `scripts/dr3-pg-backup.sh` (run by the `dr3-vision-pg-backup`
user-systemd timer daily) called `ntfy-publish.sh` with **positional args** against
a **flags-only** helper — every call exited 2 and was swallowed by `|| true`, so a
silent backup stoppage (R2 cred rotation, lost restic env) would have left the timer
green while data-loss exposure grew unbounded. Additionally the `--topic
dr3-vision-backup` the script intended is **not reachable** from the CHAD host token
(chad-hq-publisher scope) — it 403s.

- **ntfy contract fixed** — all publishes now use the ADR-0036 flag syntax
  (`--topic/--title/--priority`); verified delivering (exit 0) end-to-end on CHAD.
- **Fail-loud** — a missing/incomplete restic env now PAGES `high` and exits 1
  (was: log + `exit 0`, timer stayed green). Injected-failure tested: missing env
  and incomplete env both page + exit 1.
- **Snapshot-age deadman** — after the push, the script asserts the newest
  `dr3-vision` snapshot is < 26h old; any silent-skip path (env drift, wrong repo)
  now fails the run loudly.
- **Topic** — defaults to host-scoped `chad-hq-backup` (token-reachable; same topic
  the sibling host backup driver uses). Override `NTFY_TOPIC` to the per-service
  `dr3-vision-backup` only if the dr3-vision-publisher token is placed on the host.
- Verified against the live repo: full run pushed snapshot `c7cd38a2`, prune +
  deadman + OK page all succeeded.

### Changed — 2026-07-21 (Terex importer finalized + Woodland source-alias backfill)

Two ADR-0048 D3 / source-alias items. No money moved; no rates/IDs/classifications
invented; pilot mode untouched.

- **Terex equipment-history importer finalized against Janette's real file**
  (`src/lib/equipment/import.ts`, ADR-0048 D3). The pre-receipt flexible header
  detector failed on the real workbook (`could not find a date column ... TEREX
MACHINE MAINTENANCE LOG`). The real file is a 41-sheet `.xlsx`; the importer now
  targets its `"Maintenance Log <year>"` sheets (recognized by name), skips
  unrelated sheets (prices / diesel / monthly tabs), and fails loud (typed 422,
  listing the sheets it saw) ONLY when zero maintenance-log sheets are present. It
  handles the real layout — banner row, asterisk headers with an unlabeled col A,
  the literal `example` row, month-separator / year-marker / subtotal / bare-date
  noise rows (skipped, not thrown) — and maps `Actual Repair Cost` → `cost_cents`
  (kind=repair), cost-less entries → kind=maintenance, with `Amount Credited`
  preserved in the note (the model has one money column; a credit is never a
  negative cost). Contracts unchanged: `source=import`, `import_id`, `source_sha256`
  re-upload no-op, `(site, event_date, kind, note-hash)` idempotency, admin-only
  route, one audit row per batch. The generic CSV path is unchanged. Sanitized
  exceljs fixture (`src/lib/equipment/__fixtures__/build-terex-log.ts`) + tests pin
  per-sheet counts, noise exclusion, skip-sheets, zero-log fail-loud, money/cost_cents
  parsing, and sha idempotency. Real-file dev-loop parse (not committed): Maintenance
  Log 2025 → 55 events, Maintenance Log2026 → 68 events (7 with cost each), 123 total.
  Post-acceptance note added to `docs/adr/0048-june-operational-backfill.md`.

- **Woodland (CA) source aliases backfilled into the repo seed** so a rebuilt DB
  keeps them. 30 evidence-confirmed Woodland-workbook nicknames were inserted
  directly into prod `source_aliases` on 2026-07-21; they now live in
  `WOODLAND_SOURCE_ALIASES` (`prisma/seed/addendum-b-data.mjs`, seeded by
  `seedSourceAliases`) AND a prod-path migration `20260731_woodland_source_aliases`
  (`ON CONFLICT DO NOTHING`, woodland-scoped) — mirroring how the eugene/OR aliases
  were done. Each resolves to a verbatim woodland `sources.name`; a data-invariant
  test guards the 30-count, global-uniqueness (no OR-alias collision), canonical
  resolution against `sources.csv`, and migration parity. `docs/OPEN-ITEMS.md` S-10
  records the 15 still-unresolved June Woodland names (Rick), which block the June
  Woodland promotion (import `ba3beeeb-442d-46ed-ad30-b1a7975906f9`).

### Fixed — 2026-07-21 (Full-stack security/reliability audit — wave 1)

Adversarially-confirmed audit findings, fixed on `fix/audit-wave1`. No money
moved, no rates/IDs/classifications invented, pilot mode untouched.

- **P1-1 — Transportation invoice under-billing (`src/lib/invoices/generation-inputs.ts`)** —
  `resolveTransportationInputs` filtered inbound loads on `status: 'verified'` exactly,
  while the MRC Monthly Invoice export treats four statuses as billing-ready. Any load
  advanced to `submitted`/`submitted_to_mymrc`/`processed` silently dropped its freight
  - CA fuel surcharge from invoice generation. Now reuses the canonical
    `INVOICE_STATUSES` set verbatim (`src/lib/exports.ts`) so generation and the MRC
    export are structurally incapable of drifting. Inventory's `VERIFIED_INBOUND_STATUSES`
    is deliberately left distinct (billing vs verified-on-hand are different contracts).
    DB-idiom test seeds a load in every `LoadStatus` and asserts exactly the billing-ready
    set reaches both the freight and CA-fuel legs.
- **P1-4 — Payroll escalation cron could silently fail on payroll morning
  (`scripts/bonus-escalation-check.mjs`, `src/lib/bonus/escalation.ts`)** — a failed
  tier fire was logged "retry next tick" and dropped; the t4 backstop paged _through the
  app_ (the thing that's down when fires fail); and a period whose whole window was
  missed was keyed to `period_end == yesterday` and stranded forever unpaged. Fixes:
  bounded in-window retry (3 attempts / 15-min spacing, off the daemon's own timers);
  an app-independent direct-to-ntfy backstop page (primary→fallback, fingerprinted, no-op
  when publisher token unset); and t4 broadened to `period_end <= yesterday` so a stranded
  live-deadline period pages every 09:00 run until an operator resolves it (t3 keeps its
  tight `== yesterday` scoping — no late auto-sign). Does not auto-sign late; operator
  intervention is the policy-correct action.
- **P2 — Uncosted collection event silently zeroed its invoice line
  (`src/lib/invoices/event-leg.ts`)** — `fetchEventCostRows` coalesced null `*_cents` → $0,
  zeroing the EVENTO/B8 line and event-freight for an uncosted-but-real event. New pure
  guard `assertEventCosted` (`src/lib/invoices/event-leg-guard.ts`) refuses a component
  only when its billable quantity is present but the paired stored cost is null (per-diem
  only when `overnight`); a stored `0` remains a valid $0 line and zero-activity events
  pass unchanged. Throws typed `EventUncostedError` (status 422) naming the event +
  uncosted components, before the null→0 map. Full `computeEventBilling` wiring stays
  out of scope (seam C-18).
- **P2 — OpenTelemetry W3C Baggage DoS + unbounded Chromium render concurrency
  (`package.json`, `src/lib/chromium-semaphore.ts`)** — bumped `@opentelemetry/*` to the
  fixed, peer-clean paired set (core 2.9.0 line) clearing GHSA-8988-4f7v-96qf and its 26
  cascade advisories (`npm audit --omit=dev` 38 → 12). Added a process-wide single-slot
  FIFO Chromium render semaphore (`withChromium`, typed `ChromiumBusyError` 503 on
  max-wait timeout, permit always released) wrapping all three Playwright launch sites
  (COR PDF, payroll PDF, AP stamp) so concurrent PDF renders can no longer exhaust host
  memory.
- **P2 — Cron containers over-scoped on secrets (`docker-compose.yml`)** — the 10
  internal-cron daemons mounted the app's full `auth.env` (incl. `NEXTAUTH_SECRET` and
  Entra client secret) though they consume only `INTERNAL_CRON_TOKEN`. Split to a new
  single-secret `cron.env` (required, so a missing file fails `docker compose config`
  loudly and non-destructively rather than reproducing the 2026-07-16 silent cron
  blackout as runtime 404s); the app additionally mounts it after `auth.env`. Removed the
  unconsumed `msgraph-*.env` "parity" mounts from ap-poll/workbook-sync. Operator
  follow-ups (create `cron.env`, strip the line from `auth.env`, rotate `NEXTAUTH_SECRET`)
  documented in the ADR-0053 addendum and OPEN-ITEMS O-11 — the secret is contained by
  this change but not un-exposed until rotated.

### Fixed — 2026-07-21 (Addendum-B rollup — review close-out, minor findings)

Close-out pass on the Addendum-B rollup branch before PR. No money moved, no
rates/IDs/classifications invented, pilot mode untouched.

- **TONU state logic (`src/lib/event-billing/tonu.ts`)** — the no-dispatch guard now
  runs FIRST, so a stray `diverted`/`cancelledAt` flag on a never-dispatched order no
  longer bills the haul rate (Rick §5.3: TONU requires a dispatch). The
  dispatched-but-not-cancelled/not-diverted verdict now returns a distinct
  `dispatched_no_bill` reason instead of mislabeling a real dispatch as
  `not_dispatched`. Tests added for both.
- **Event-billing input validation (`src/lib/event-billing/compute.ts`)** —
  `computeEventBilling` now rejects negative/NaN/Infinity `laborHours` and
  `driverOnsiteHours` (finite ≥ 0) and non-integer/negative/NaN `perDiemDays` (Int
  column) with `RangeError`, matching the module's fail-loud money discipline.
  Fractional hours (Decimal(5,2)) still accepted. Tests added.
- **OR collections GP export (`src/lib/invoices/export-json.ts`)** — a `manual`
  adjustment line on an `or_collection_site_count` invoice is no longer stamped with
  the `OREGON MATTRESS` per-mattress item code; it now uses the canonical
  `itemCodeForLineCode` map (→ `null` for `manual`). `GpExportLineV2.item` widened to
  `GpItemCode | null`. Total still reconciles (ADR-0033 tripwire). Test added.
- **Kelsey AP-approver migration guard (`20260730b_addendum_b_seeds/migration.sql`)** —
  the 8/1 → 8/8 `active_until` bump now guards on `active_until::date = '2026-08-01'`
  (day match, TZ-independent on the TIMESTAMP(3) column) instead of exact-timestamp
  equality, so a differing time component no longer silently no-ops (which would let
  the expiry reaper delete Kelsey on 8/1). Still refuses to clobber a manual change to
  another day; idempotent; clean-CI no-op. Post-deploy verification query added to the
  migration comment.
- **Docs** — `SourceSiteType` doc comment no longer lists `Sponsors` as a
  `third_party_inbound` example (§2 reclassified it as a provenance agency).
  `docs/OPEN-ITEMS.md`: S-4 corrected to state OR billing-source `site_type`
  classification is NOT done (folded into the C-16 wiring gate); new **S-9**
  (per-location container-rental roster from Rick — CA $10,800/44, OR $900/6 incl. The
  Dalles $100) and **C-20** (rewire `onHand()` to the `unit_status_movements` ledger).

### Added / Changed — 2026-07-21 (MRC billing Addendum-B rollup — Rick/Mary/Kelsey answers)

Integrates the four Addendum-B workstreams from the 2026-07-21 rollup handoff
(`docs/handoffs/2026-07-21-mrc-billing-addendum-rick-mary-kelsey-rollup-2026.md`).
Pilot mode is untouched; **no live customer rates seeded** and **no mode flipped**.
No monetary values, rates, or IDs were invented — anything unstated is seeded
null/unset and tracked in `docs/OPEN-ITEMS.md`.

**Schema foundation (ADR-0037 amendment + ADR-0056; migrations
`20260730_adr0037b_addendum_b_schema` + `20260730b_addendum_b_seeds`):**

- **Loads/inventory ledger surface** — new `unit_status_movements` (aggregate,
  status-bucketed movement ledger; `UnitStatus` enum `on_floor | saved |
processed | sold | landfilled`, reusing existing `LandfilledReason` where "wet"
  ⇒ `water_logged`), `provenance_agencies` + `inbound_loads.provenance_agency_id`,
  and the 5th `SourceSiteType.svdp_internal_store`. Bare-scalar-FK convention (no
  Prisma relations; constraints in migration SQL), matching existing tables.
- **Event-billing schema** — `event_legs` (+ `EventLegType` enum), `event_vehicles`,
  `collection_events.{driver_onsite_hours, per_diem_days, overnight}`, and
  `tonu_billing`. Added `StateProgramRuleKind.irs_mileage_rate` (no rate rows
  seeded — figures not in the handoff).
- **Seeds** — 5 OR sources renamed id-preservingly to verbatim MyMRC names (incl.
  the verbatim typo "Glenwood Central Recieving Station"); 14 new eugene rows
  (11 `svdp_internal_store` billing-off + The Dalles/Rifes/Roseburg parked);
  22 `source_aliases` rows (retired names + §12 month-to-month variants →
  canonical); 3 provenance agencies (incl. Sponsors, reclassified from a source);
  Kelsey AP approver `active_until` 8/1 → **8/8**.

**Event billing + TONU (ADR-0056 — pure compute layer, `src/lib/event-billing/`):**

- `computeEventBilling` prices the six §5.3 components (per-leg tier transport,
  labor wages, driver wages, per-diem, IRS mileage) and `assessTonu` the TONU
  verdict. Fail-loud on billable-but-unseeded rate (`EventRateUnavailableError` 409) — never silent $0; a zero-activity event totals $0 with all rates null.
  Driver-vs-labor no-double-count is structural. Not yet wired into the invoice
  generator (EVENTO/MILES-0 membership deferred — see OPEN-ITEMS C-18).

**Invoice generation + commodity attachment (ADR-0040/0041 amendments):**

- v2 GP presentation rewritten to the real §10 PDFs: 7 LOCKED GP item codes
  (`LOCATION`/`UNITSMO`/`REIMBO`/`EVENTO`/`MILES 0`/`FUEL`/`OREGON MATTRESS`,
  spaces significant), MILES-0 transportation aggregation + FUEL, and
  REIMBO/EVENTO subtotal lines. Reconciles all four real June invoices.
- Kind-aware PO builder `buildPoNumberForKind` (`M/DD/YY DR3 W` / `DR3 OREGON` /
  `TRANS` / `TRANS OR`, `M/YY OR COLLECTIONS`) and `seedGpSiteBillingConfig`
  corrected to the confirmed identifiers (Woodland `DR3W`→`DR3 W`; Eugene
  null→`MRCL001`/`DR3 OREGON`), `update` branch now re-applies them.
- Invoice-combination guard (`assertValidInvoiceCombination`) rejects illegal
  mid-month/discount pairings; EOM-processing commodity breakdown rendered as a
  computed attachment (`src/lib/commodity/`, pdf-lib, Letter-landscape). Metal→
  Steel/Xtraction-Landfill/Covanta-WTE split awaits Rick (OPEN-ITEMS S-8).

**Floor-inventory dashboard tile (ADR-0037 §3):**

- New per-site floor tile (`src/lib/dashboard/floor-inventory-tile.ts`,
  `src/app/dashboard/[site]/floor-inventory-tile.tsx`) consuming the single
  ADR-0037 `onHand()` pool computation + trailing-7-day closes; program/
  non-program/total on-floor + optional days-remaining projection; refreshes via
  the existing DockPoller. Degrade-never-throw.

**Intake alias normalization (ADR-0037/0038 amendments):**

- `sourceAliasResolver` extended to return `sourceId`, so intake LINKS records.
  Workbook promotion now resolves every inbound `site_name_raw` (writing
  `inbound_loads.source_id`) and REFUSES promotion on any unresolved name
  (`PromotionUnresolvedSourceError` 422, deduped list) — closing a silent-drift
  gap where explicit program splits bypassed resolution. MyMRC upsert gains a
  normalized alias fallback (verbatim `source_name_at_sync` retained on miss).

### Changed — 2026-07-21 (ADR-0037 D7 activation gate → admin-flippable rollout surface)

The loads/inventory + floor-operator activation gate becomes admin-controllable
without a redeploy, reusing the ADR-0047 rollout-surface mechanism. The operator
flips it from the same `/admin/rollout` surface they already use.

- **New rollout surface** `loads_inventory` (UI, per-site) registered in the
  ADR-0047 registry (`src/lib/notify/rollout.ts` `UI_SURFACE`), seeded **born
  `pilot`** (admin-only — today's behavior). State→behavior: `pilot` = admin-only;
  `live` = operators/managers activated for that site.
- **`assertLoadsInventoryActivated` rewired** (`src/lib/loads/record-guards.ts`)
  from hardcoded admin-only to reading the persisted surface via `isUiSurfaceLive`.
  Admin ALWAYS passes (no DB read); operator/manager pass only when the surface is
  `live`; otherwise throws `LoadsInventoryNotActivatedError` (403) exactly as
  before. **Signature change:** now `async` and takes `(role, siteId, db?)`. The
  sole caller — the chokepoint `requireActivatedManager` — awaits it with
  `ctx.siteId`; **no manager route signature changed** (all 14 thread through that
  one call). The loads-inventory dashboard page gate consults the same surface.
- **Default-safe guarantee:** default/unset/unregistered/read-error ⇒ admin-only
  (fail-closed) — a fresh deploy changes nothing until an admin flips it.
- **Migration** `20260729_adr0037_loads_inventory_rollout_surface` — purely
  additive (ADR-0035 clean-replay; sorts after `20260728_ap_not_dr3_location`),
  idempotent (`ON CONFLICT DO NOTHING`), inserts the two per-site rows born `pilot`
  so the surface appears on `/admin/rollout` without a manual re-seed. `seed.mjs`
  also lists it for first-deploy/dev parity.
- **How to activate:** at `/admin/rollout`, flip `loads_inventory` (per site) from
  `pilot` → `live` with a criteria note (admin-only + audited); revert is the
  inverse flip. No code deploy.
- **Docs:** ADR-0037 D7 amended; ADR-0047 records `loads_inventory` as a surface.
- **Tests:** `src/lib/loads/record-guards.test.ts` (admin-always-passes/no-DB-read,
  operator+manager blocked at pilot/unregistered/read-error [default-safe],
  allowed at `live`, 403 shape, registry sync) + a `loads_inventory` flip case in
  `src/lib/notify/__tests__/flip.test.ts` (pilot→live, audited).

### Added — 2026-07-20 (ADR-0046 amendment: third AP location disposition "NOT DR3 — See Reason")

Accounting-critical. The AP approval portal's location dropdown (Woodland / Eugene)
gains a third option, **NOT DR3 – See Reason**, for an invoice that is not for a DR3
location at all (mis-addressed, wrong entity, a parent-org bill). Choosing it requires
a reason and records the decision WITHOUT filing it against a real site's books.
Migration `20260728_ap_not_dr3_location` (purely additive, ADR-0035 clean-replay;
sorts after `20260727_adr0041_pilot_mode_gp_export`; default false backfills every
existing row as a normal site-filed decision).

- **Schema.** `ap_requests.filed_not_dr3 Boolean @default(false)` + a partial DB CHECK
  (`NOT (filed_not_dr3 = true AND site_id IS NOT NULL)`) enforcing the "never both"
  half of the location invariant (deliberately partial so historical NULL-site rows
  stay valid).
- **Location invariant (app-enforced in `decideRequest`).** A decided row is EXACTLY
  ONE of: site-filed (`site_id` NOT NULL, `filed_not_dr3 = false`) OR NOT-DR3
  (`filed_not_dr3 = true`, `site_id` NULL, reason required) — never both, never
  neither. New `ApLocationConflictError` (400) guards "both"; the reason requirement
  reuses `ApNoteRequiredError` (400). The existing site-required path is unchanged.
- **Route** `POST /api/ops/ap/[id]/decide` accepts `notDr3?: boolean`: rejects
  `notDr3 + siteId` (mutual exclusion, 400), rejects `notDr3` without a non-empty note
  (400), and files NOT-DR3 without resolving/asserting a site.
- **UI.** The `NOT DR3 – See Reason` option (field relabeled **Location**) shows an
  inline "reason required" hint, disables Approve until a reason is entered, and posts
  `notDr3: true` instead of a `siteId`.
- **Accounting surfaces.** So Mary never mistakes it for a DR3-site invoice, the
  decision email (subject `— NOT DR3`; body `NOT DR3 — see reason: <reason>` leading
  the facts) and the stamped PDF/cover/image (per-page stamp line `— NOT DR3 (see
reason)`; meta block `Location: NOT DR3 — see reason: <reason>`) render the
  disposition in the same slot the site name occupies today.
- **Tests.** NOT-DR3 persistence (filed_not_dr3=true + site_id NULL), reason-required
  (rejects empty note, approve AND reject), mutual-exclusion rejection, mail/PDF NOT-DR3
  rendering, and a regression that the Woodland/Eugene path still requires a real site.
  Full suite green: 2214 passed, 2 skipped.

### Added — 2026-07-18 (ADR-0041 amendment: SIMPLIFIED invoice generation — pilot mode, program split, GP v2 export; rollup §A.1/§A.7/§4.2/§8.3)

Billing-critical, launch-facing. Extends the accepted ADR-0041 invoice engine (nothing
rebuilt — the immutable-version discipline, pure math, trust gate, and credit-memo /
void-and-reissue state machines are unchanged and verified to still integrate). Migration
`20260727_adr0041_pilot_mode_gp_export` (purely additive, ADR-0035 clean-replay; sorts
after `20260726_adr0040_rate_infrastructure`; `invoices.mode` defaults `pilot` so every
pre-existing row backfills safely — nothing on file can reach MRC until an admin flips it).

- **B10-5 CLOSED (§A.1).** The invoice math is single-line (`program_units_processed ×
rate + trade_discount`) — no commodity→invoice-block mapping is required for billing.
  Compliance commodity classification (recycling rate) stays a separate concern
  (ADR-0043/0055). Both ADR-0041 and ADR-0043 doc references updated.
- **Pilot / production mode (§3.4) — the launch safety net.** `InvoiceMode` enum + the
  `mode` column (default `pilot`). `src/lib/invoices/delivery.ts`: `planInvoiceDelivery`
  is a TOTAL function on `mode` with NO branch that yields MRC recipients / `sendsToMrc`
  for pilot — a pilot invoice is structurally undeliverable to MRC; `assertProductionForMrc`
  is the tripwire a future sender calls. Pilot previews route to `invoice_pilot_recipients`
  (Bill + Rick, seeded). `invoice_mode_config` (per site+kind; no row ⇒ pilot) is the admin
  flip via `POST /api/manager/[site]/invoices/mode` (authorized like approval). No live MRC
  sender exists yet — the boundary ships first (mirrors the frozen export contract).
- **Program vs non-program split (§8.3).** `invoices.program_units_processed` (billable
  basis, == B6/B20 line quantity) + `invoices.non_program_units_processed` (tracked,
  off-invoice). Aggregated from `processed_units_daily.stripped_program` /
  `stripped_non_program` and persisted on processing invoices.
- **Two-line GP export v2 (§4.2), C-1 bump.** `invoiceExportV2` ships ALONGSIDE the FROZEN
  v1 (`export-json.ts`); `GET …/export?format=json&v=2` (v1 stays default). Carries the
  §4.2 two-line processing structure (header + "MRC-Processed Units DR3 <Site>" UNITSMO)
  - Subtotal/Misc/Tax/Freight/Trade-Discount/Total, the GP header identifiers, the split,
    and the trade-discount fields; the v1 leaf lines are also carried (nothing lost). GP
    total reconciles to `invoice.total_cents` (ADR-0033 tripwire).
- **GP identifiers (§4.2).** `gp_billing_config` (singleton: MRC Bill-To/Ship-To — Attn
  Ryan Trainer, 501 Wythe Street, Alexandria VA 22314; Sales ID 34; Net 30) +
  `gp_site_billing_config` (Woodland: Customer ID MRCL001, PO suffix DR3W). OR MRC Customer
  ID + Eugene PO suffix left NULL — pending Mary, never invented. CA processing rate reuses
  `state_program_rules` ($16.50/unit), not re-seeded.
- **Tests:** delivery (pilot never reaches MRC, structural) · gp-identifiers (PO format,
  null-unknown rule) · export-v2 (two-line shape, EOM subtracts mid-month, reconciliation,
  v1 frozen, OR/Eugene null) · program/non-program split on the composer. Suite 2173 green.

### Added — 2026-07-18 (ADR-0040 amendment: MRC billing rate infrastructure; rollup §8.2 + §3.3/§3.5/§3.6/§3.7)

Billing-critical. Extends the accepted ADR-0040 rate infrastructure with the MRC
billing-composition + transitional-freight rules. Migration
`20260726_adr0040_rate_infrastructure` (purely additive, ADR-0035 clean-replay) —
ONE enum + ONE table only; the rest is resolver code over EXISTING rate tables.

- **Per-source OR service rates (§3.3).** New `source_service_rates` table +
  `SourceServiceRateKind` enum (`trans`/`trailer`/`per_mattress`/`mrc_unit`) — per-source,
  effective-dated rates for the OR billing components, mirroring the existing
  `account_haul_rates` shape. Resolver `src/lib/billing-rates/service-rates.ts`
  (`resolveSourceServiceRateCents`) picks the in-force row, detects same-`effective_from`
  ties, and throws `ServiceRateUnresolvableError` when none is in force (never a silent $0).
  **No rows seeded here** — the §7 seed PR loads the OR sources (The Dalles effective
  2026-06-01; the rest 2026-01-01) after this merges.
- **Per-site-type billing composition (§3.2/§8.2).** `src/lib/billing-rates/site-type-billing.ts`
  (`resolveSiteTypeBilling`) maps a source's `site_type` → the component set
  (mrc_inbound = trans+trailer+MRC unit; cvp_retailer = trans+trailer; collection_site =
  trans+trailer+per-mattress+MRC unit; third_party_inbound = MRC unit only), then applies the
  ADR-0037 `bill_trans`/`bill_trailer` overrides with **suppress-only** semantics (a flag can
  turn a defaulted component OFF, never ON — Cottage Grove pattern). `active_billing=false`
  suppresses all; an active source with no `site_type` throws `SiteTypeUnclassifiedError`.
- **Transitional Woodland freight (§3.5).** `src/lib/billing-rates/woodland-freight.ts`
  (`resolveWoodlandFreightCents`) — for any Woodland (CA) load, freight is ALWAYS priced off
  the source's Primary rate + Primary mileage regardless of site Assignment. Delegates to the
  audited `resolveFreightCents` (one money path): override = Primary rate; tier = Event Mile
  Rate fallback; else `FreightUnresolvableError`. Rejects a non-CA source with
  `WoodlandJurisdictionError`. The CA non-Woodland / normal-Assignment path is unchanged.
- **Event Mile Rate resolver (§3.7).** `src/lib/billing-rates/event-mile-rate.ts`
  (`resolveEventMileRateCents`) — the named, fail-loud mileage→flat-rate lookup used by the
  Woodland fallback. **No new table:** the Event Mile Rate tier IS the already-seeded CA
  `transport_rate_tiers` set (identical 7 bands, Variables!D6:F13), so this reuses those rows
  rather than forking a second source of truth for the same numbers. Out-of-range throws
  `EventMileRateOutOfRangeError`.
- **Container rentals never prorated (§3.6, closes C-10).** `src/lib/billing-rates/rental-billing.ts`
  encodes the policy explicitly (`monthWindowUTC`, `rentalOverlapsMonth`, `billedRentalCents`):
  any month-overlap bills the FULL monthly rate — a rental starting on the 28th and spanning
  into the next month bills full in BOTH months. `resolveRentals` (generation-inputs.ts)
  refactored to share the pure helpers so the DB query and the policy can't drift. This
  confirmed + locked the existing behavior (it already never prorated).
- **OR fuel surcharge skip (§6.5) — confirmed, no change.** The CA-only gate was already
  enforced by `resolveProgramRule` (throws `RuleStructurallyDisallowedError` for an OR
  fuel-surcharge lookup before any price is read) and covered by an existing test; the
  transportation composer also refuses `or_transportation_no_fuel`.

### Added — 2026-07-18 (ADR-0042 amendment: mid-month COR; rollup §4.1 + §8.4 + §9.2)

Billing/compliance. The COR (Exhibit 5) form is filed for BOTH the end-of-month
close and a mid-month period; Rick files the mid-month version with Inventory + FT +
PT **blank** (Signature + Date only). Migration `20260726_adr0042_midmonth_cor`
(purely additive, ADR-0035 clean-replay: one enum + one defaulted column + one
NOT-NULL widening). See `docs/adr/0042-cor-generator.md` "Amendment — 2026-07-18".

- **`period` discriminator.** New enum `CorPeriod { end_of_month, mid_month }` +
  column `cor_certificates.period NOT NULL DEFAULT 'end_of_month'`. The default
  backfills every existing row and caller — all current behavior is preserved.
- **Nullable inventory.** `cor_certificates.inventory_units` widened to `Int?`: a
  mid-month cert stores `NULL` (never a placeholder `0`). `inventory_source` stays
  `NOT NULL` with a typed `mid_month_blank_adr0042_amendment` marker (honest
  provenance, no fabricated figure).
- **Mid-month fork (EOM path untouched).** `computeCorPrefill` short-circuits before
  any ledger query for mid-month (inventory/FT/PT blank, signer only). The D2.1/D3
  reconcile tripwire (`assertCorInventoryReconciles`, in BOTH `finalizeCor` and
  `generateCorPdf`) is **end-of-month only** — mid-month returns a passing `skipped`
  result. `finalizeCor` requires the FT/PT split ONLY for end-of-month. The internal
  print page renders inventory/FT/PT/total **literally blank** for mid-month (no
  em-dash, no `0`), suppresses the balance note, and labels "Mid-month filing". The
  display-only **capacity banner is end-of-month only**.
- **Period-scoped version chain.** A mid-month and an end-of-month certificate for
  the same `cover_month` are independent immutable-version chains and never void one
  another (`generateCorDraft` + `getCorDetail` filter on `(site, cover_month,
period)`; supersede stays in-period).
- **UI + API.** `POST /api/manager/[site]/cor` accepts `period`; the manager COR
  surface adds a filing-period selector and renders mid-month certs with blank
  figures + a "mid" chain tag.
- **Fixtures → 3,977.** All COR fixtures updated from the stale **4,062** to the
  ADR-0037-corrected **3,977 (3,748 program + 229 non-program)**; `prefill.test.ts`
  now reproduces it through the D6 running balance using the same Processed-ledger
  totals as the §2.3 close (cross-validating `onHand` vs `computeInventoryClose`).
  New mid-month tests: prefill blanks + signer, reconcile skip, finalize without
  headcount, and the end-of-month gates still firing.
- **Signer title** "Transportation Manager" (Richard Albritton) confirmed correct —
  no change.

### Added — 2026-07-18 (ADR-0055: recycling-rate configuration + outbound stewardship derivation; rollup §A.4)

Answers the workbook `B10-5` / `%` column. Recyclers count different fractions of a
load as recycled vs landfilled (Green Zone metal 100%; Xtraction metal 81%/19%;
Biomass wood 100%). These splits feed CalRecycle stewardship (O-7) — they are NOT
billed (ADR-0041). Migration `20260726_adr0055_recycling_rates` (purely additive).

- **`outbound_vendors`** — GLOBAL recycler master (mirrors `transporters`, not the
  site-scoped `sources`). Formalizes the free-text `outbound_materials.buyer`.
  `outbound_materials` gains a nullable `vendor_id` FK (legacy `buyer` retained for
  backfill/reconciliation).
- **`recycling_rates`** — effective-dated `recycling_percent` (`Decimal(5,4)`, DB
  `CHECK [0,1]`) per `(vendor, commodity)`, commodity reusing the existing
  `OutboundCommodity` enum (**steel → `metal`**; Biomass is a `wood` vendor — no
  parallel enum). Resolver `src/lib/loads/recycling-rates.ts` mirrors the
  `state_program_rules` pattern (latest covering `effective_from` wins). Overlap is
  guarded three ways: partial-unique on open windows + a transactional
  advisory-locked write guard (`createRecyclingRate`) + a resolver throw on any
  double-cover.
- **Outbound derived fields** — `recycled_lbs`, `landfilled_lbs`,
  `recycling_percent_applied` (durable snapshot), `recycling_rate_id` (provenance),
  computed at entry time from `(vendor_id, commodity, ship_date)` and re-derived on
  edit. Rounding rule: `recycled = round_half_up(weight × pct)`, `landfilled =
weight − recycled` (**complement by subtraction → exact sum, no pound drift**).
  Worked example: 5,541 lb @ 0.81 → **4,488 recycled / 1,053 landfilled** (see the
  ADR's flagged 1-lb delta vs Kelsey's verbal 4,487/1,054 — an 80.98% split, not
  the nominal 0.81; seeded rate stays 0.81 pending confirmation).
- **No-rate policy** — when no rate covers `(vendor, commodity, date)`, derived
  fields are left **null and flagged**, never assumed 100% (would over-report to
  CalRecycle).
- **Seeds** — the three confirmed rates only; other wood-recycler rates PENDING
  Morena (not invented).
- **iPad outbound entry** — recycler picker + live recycled/landfilled preview
  (`GET …/outbound/{vendors,rate-preview}`) wired to the same resolver the save path
  uses, plus two new table columns.
- **O-7 seam** — CalRecycle stewardship reporting consumes these fields; the
  reporting surface is a separate feature (not built here).

### Added — 2026-07-18 (ADR-0037 amendment: inventory + sources foundation; rollup §8.1)

Billing-critical. The MRC billing tune-and-launch foundation. Migration
`20260725_adr0037_inventory_foundation` (purely additive, ADR-0035 clean-replay).

- **Correct-arithmetic inventory close (§2.3).** New `src/lib/inventory/inventory-close.ts`
  (`computeInventoryClose`) computes the month close via the CORRECT arithmetic —
  `program_close = program_open + program_inbound − program_stripped`;
  `non_program_close = non_program_open + non_program_inbound − non_program_stripped −
saved_units`; `total = program_close + non_program_close − sold − landfilled` — NEVER
  the workbook's latently-buggy `D45`/`D48` formulas. The authoritative pool aggregates are
  read from the workbook's own **Processed sheet** (per-day F/G/D/E/H/I + opening D5/F5 +
  the DAY `Saved` box), exposed on `ParsedWorkbook` as `inventoryLedger` + `inventoryClose`.
  **The corrected June workbook (SHA `1eeeccb…`) closes to 3,977 (3,748 program + 229
  non-program)**, verified against the real oracle: programInbound 19,451, nonProgramInbound
  229, programStripped 17,126; cross-checked against the DAY31 Ending-inventory cell (3,977).
  This SUPERSEDES the prior 4,062 figure — that was the raw DAY per-shipment grid over-sum
  (+85 from DAY23's `NP`-marked Recology Healdsburg row, which the workbook's `F = I38 − L39`
  accounting nets out). The parser stages an `inventory_ledger` staging row and the ADR-0048
  promotion close (D2) reads it, so `expectedCloseTotal` for June Woodland is now 3977.
- **§1.1 sequential depletion** (`sequentialDepletion` / `depleteSeries`): program-first —
  non-program is stripped only once the program pool is exhausted (no-op for June, E40 = 0).
- **§A.2 `saved_units`** wired into the shared `computeRunningBalance` — subtracts from the
  non-program pool (was previously excluded from all inventory math). `onHand` + the
  promotion close pick it up (0 for June).
- **Sources site-billing taxonomy (§3.2):** `Source.site_type` (`SourceSiteType`:
  mrc_inbound/cvp_retailer/collection_site/third_party_inbound), `Source.active_billing`
  (Roseburg pattern), `Source.bill_trans` + `Source.bill_trailer` (Cottage Grove overrides).
- **Pool routing (§3.2, §A.5):** `src/lib/inventory/pool-routing.ts` — the single
  inbound-channel → pool map. Illegals + unpaid + collection + events → program pool;
  non_program → non-program pool. No new `illegal_dropoff` enum — `ConsumerDropoffKind.illegal`
  already carries it.
- **Consumer drop-off traceability (§1.3):** `ConsumerDropoff.consumer_name` (optional CIP
  PII) + `incentive_amount_cents` (explicit unpaid check amount, default `units × 300`¢,
  overridable). Wired through the dropoffs service + manager API.
- **§A.6:** the stale `Summary!` / `Trans Summary!` tabs are advisory only and never feed
  billing aggregation — surfaced via the `[summary-stale]` parse flag.
- **Docs:** new `docs/parsers/woodland-daily-log-schema.md` (§2.2 cell-reference table + the
  F9/D45/D48 workbook-bug notes); ADR-0037 amendment section.
- **Tests:** `inventory-close.test.ts` (incl. the explicit June 3748/229/3977 assertion +
  the D45-bug guard), `pool-routing.test.ts`, and new woodland reconciliation assertions.
- **STAGING ONLY** — no promotion WRITE path was run or modified (operational-table inserts
  are unchanged; only the close-VERIFICATION math is now authoritative). tsc + full vitest +
  prod build green.

### Fixed — 2026-07-17 (CRON incident: missed daily report + silent 503)

Production-hardening follow-up to the 2026-07-16 cron outage. Root cause: the
audit's new `guardInternalCron` fail-closed branch returns **503 for every
internal cron when `INTERNAL_CRON_TOKEN` is unset in prod** — and the token had
**never been provisioned**, so ALL internal crons 503'd. The daily production
report was missed for both sites (2026-07-16) and the 503 was silent until a
human spotted the gap. Token is now provisioned in `auth.env`; these two changes
let us backfill the miss and prevent a silent recurrence.

- **Date-parameterized daily-report BACKFILL.** `runDailyReportFire(now, opts)`
  gained an optional `{ forDate?, siteCodes?, force? }`. With `forDate` (a Pacific
  `@db.Date` key) it uses that day directly as the `dayKey` and **bypasses the
  "not due yet" send-time gate** (a past day is always due) while keeping every
  other guard — weekend (read on the TARGET day in UTC, not the run instant),
  holiday, `skip_if_zero`, `(site, report_date)` idempotency, recipient
  resolution, the REAL (non-`[TEST]`) subject, the roster send, and the
  `bonus_daily_report_log` row write. `force` re-sends over an existing row
  (reuses it — the unique constraint forbids a second — and re-finalizes
  delivery). No `forDate` → behavior is byte-identical to the scheduled path.
  Exposed on `POST /api/internal/bonus/daily-report` (behind `guardInternalCron`):
  an optional JSON body `{ date?: "YYYY-MM-DD", siteCodes?: string[], force?: bool }`.
  No body → the unchanged scheduled tick (daemon sends none). A body runs ONLY
  the targeted backfill (the alert/update-digest riders are the scheduled tick's
  concern, keyed to "now", and are not re-fired for a historical re-send).
  Idempotent: a second call is `skipped_already_logged` unless `force`.
  Files: `src/lib/bonus/daily-report-runner.ts`,
  `src/app/api/internal/bonus/daily-report/route.ts`.
  _This is the tool used to re-send the 2026-07-16 report to both sites after
  deploy._

- **Unset `INTERNAL_CRON_TOKEN` in prod is now LOUD.** `guardInternalCron`'s
  503-unconfigured branch fires a fail-soft ntfy page (`dr3-vision-system`,
  priority `high`, tags `cron,config,dr3-vision`, fingerprint
  `dr3-vision-internal-cron-token-unset`, 30-min cooldown per ADR-0037) so a
  missing token can't silently strangle every cron again. The 503 stays
  (fail-closed is correct); the alert is non-blocking (fire-and-forget — the
  guard stays synchronous across its 12 call sites) and never throws out of the
  guard. File: `src/lib/internal-auth.ts`.

- **Tests.** Backfill: past-day `forDate` sends+logs to the roster (real subject,
  not-due bypassed), idempotency (second call skips unless `force`), `force`
  reuse-over-existing (+ P2002 race), weekend/holiday/zero still skip on the
  target day, `siteCodes` filter, route body wiring (forDate/siteCodes/force,
  422 on bad date/site, no-body unchanged, digests not re-fired). Guard: unset-prod
  path attempts the page (mocked) and still 503s, publish-throw still 503s,
  token-set + non-prod never page.

### Changed — 2026-07-17 (ADR-0048/0049 §8.2: source inbound from the DAY grid — close now reconciles)

Billing-critical follow-up to the parser finalization below (operator-approved).
The first pass sourced promotable `inbound_loads` from the category sheets
(`inb_trans_charges`/`inb_no_trans_charge`/`nonprogram`) — only the **B2B/trans
subset** (June 5220 units / 57 loads), so a flow-recompute of the close was
wildly wrong (June −10209 vs authoritative 4062). Fixed: `inbound_loads` **and**
`consumer_dropoffs` now come from the **DAY per-day INBOUND grid** (the complete
all-channel inbound — B2B hauls + unpaid/incentive/illegal drop-offs), located
below each DAY sheet's inbound header and bounded by the OUTBOUND single-list /
OUTBOUNDS marker. The `commodity` column classifies each row's channel. The
staged inbound-unit total now equals the workbook's own per-day INBOUND total
**exactly** (June 19765, July 8822), and the flow-recomputed close **reconciles
to the authoritative workbook close: June = 4062, July = 2577** (verified via
`decodeStagingRows` → `computeRunningBalance` against the real oracles). The
category sheets (+ `incentive_unpaid`) are the same rows re-categorized for
billing — now staged as **evidence** (section `detail`), never promoted, so
there is no double-count. Fixture gained a DAY inbound grid; new
reconciliation + inbound-sourcing tests. Residual flags retained (processed date
construction, drop-off `personName`, opening-inventory non-program begin).
STAGING ONLY — no promotion write invoked. tsc + full vitest (2084) + build green.

### Changed — 2026-07-17 (ADR-0048/0049 §8.2: finalize the workbook parser against the REAL Woodland files)

Billing-critical. `parseWorkbook` matched sheets by exact lowercase name
(`summary`/`inbound`/`outbound`/`inventory`) — sheets the real Woodland daily-log
workbooks do not have — so it returned **0 staging rows** and
`templateGeneration='unknown'`. Rewired the parse path to address sheets by
`classifyWorkbookSheets` **semantic type** (new `section-extractors.ts`), so the
real June + July files now parse into promotion-consumable `StagingRow`s
(June: 273 rows, July: 237) that `decodeStagingRows` accepts. Extractors:
inbound (`inb_trans_charges`/`inb_no_trans_charge`/`nonprogram` → `inbound_loads`),
outbound (DAY0–31 per-shipment grid → `outbound_materials`, incl. DAY6's 9th
COTTON block), processed (`Day N` close → `processed_units_daily`), drop-offs
(`incentive_unpaid` → `consumer_dropoffs`), opening inventory, and best-effort
Summary figures (still feed `recomputeSummary`/`resolveInboundSites`).
Rollup sheets (`commodities`/`renovation`/`all`) are staged as **evidence only**
(section `detail`, promotion-skipped) — they are the DAY grid rolled up, so
promoting them would double-count. The **authoritative month-close** is now read
from the workbook's own "Ending inventory" cell (June = **4062**, July = **2577**;
July's opening = June's close, cross-validated) rather than the stale hardcoded
`4062`. Fixed a real crash: `cells.ts` `cellText` threw `RangeError` on invalid
Date cells present in the real files. Reconciled `day-sheet-layout.ts` to the
real grid (blocks anchor col **3** not 4; 7 standard fields not 8; DAY6 cotton at
col 68 + `revenue`). Backward-compatible: the legacy ADR-0039 synthetic path is
kept (branched on the `figure_key` Summary signature); all prior parser/resolver/
day-sheet/summary-recompute tests stay green. New `parser-woodland.test.ts` +
synthetic Woodland fixture. **STAGING ONLY** — no promotion write path was
invoked or modified. Every ambiguous mapping (nonprogram=inbound-not-outbound,
inbound-completeness gap, processed date construction, drop-off `personName`,
DAY-outbound `subCategory` default) is surfaced in `ParsedWorkbook.flags` for
operator review before promotion. tsc + full vitest (2082) + prod build green.

### Security — 2026-07-16 (D3: nonce-based CSP — drop `script-src 'unsafe-inline'`)

Operator-directed. Replaced `script-src 'unsafe-inline'` with a **per-request
nonce** so CSP is a real XSS control on this finance app (ADR-0053 D3). The CSP
moved out of `next.config.js` into `src/middleware.ts` (single source): the
middleware mints a base64 nonce per request (Web Crypto, edge-safe), forwards it
on the request headers so Next auto-stamps its own bootstrap scripts, and sets
the response CSP. `script-src` is now `'self' 'nonce-…' 'strict-dynamic'` with no
`'unsafe-inline'`; added `object-src 'none'`, `base-uri 'self'`, `form-action
'self'`. `style-src 'unsafe-inline'` kept (Tailwind, no code-exec). The login
FOUC guard now carries the nonce via `next/headers`. Per-route `frame-ancestors`
survey exception + `X-Frame-Options` distinction preserved. New unit tests
(`src/lib/csp.ts` builder + middleware wiring). tsc + full vitest + prod build
green. ADR-0053 D3 → done. Auth/middleware logic unchanged.

### Added — 2026-07-16 (O-2: admin file-drop inbox)

Operator-directed (O-2): _"just allow me to upload [files] in the vision portal
and then you can settle out what they are and where they belong… I can just dump
the data there."_ New admin-only **File Drop** capture inbox at
`/admin/file-drop`. Bill drops ANY file (any content-type, ≤100 MB); the system
stores it in R2 under `file-drops/<id>/<sanitized-name>` and records one manifest
row. Downstream classification/routing stays a human step (Claude Code reads the
manifest + downloads objects) — this ships **only** the capture surface, no
parsing/promotion.

- **Schema:** additive `file_drops` table + `FileDropStatus` enum (migration
  `20260724_admin_file_drops`, ADR-0035 clean-replay; sorts after `20260723`).
  `uploaded_by` is a bare audit-actor id (no FK, like AP `held_by`/`decided_by`).
- **Upload:** server-buffered multipart (matches the workbook/AP server-side R2
  put path — admin uploads from a browser). New `putFileDrop` / `signFileDropDownload`
  helpers in `src/lib/r2.ts`; R2 is fail-soft (unconfigured → `pending-r2-filedrop-…`
  placeholder key so capture never fails).
- **Classification:** `classifyFileDrop` pure fn (advisory `detected_kind` hint —
  `.xlsm`/`.xlsx`→workbook, `.pdf`→pdf_document, `.csv`→csv, `image/*`→image,
  else other). Never routes anything.
- **Routes** (all admin-gated, audited): `POST/GET /api/admin/file-drops`,
  `PATCH /api/admin/file-drops/[id]` (status/note), `GET …/[id]/download`
  (presigned). Create + status/note changes write `audit_log` rows
  (`table_name = file_drops`).
- **Surface:** deep-space themed `/admin/file-drop` page + client (dropzone,
  multi-file picker, manifest list with per-row download / status / note; no
  `<form>` per hard rule #10). Discoverable via a new admin-only **File Drop**
  dashboard tile (`Upload` icon) and an Admin-hub link.
- **Docs:** `docs/operator/file-drop.md`.

### Security — 2026-07-16 (D4: AP sender-trust comments corrected; DMARC verified)

Verified `svdp.us` DMARC is `p=reject` — external forgery of `@svdp.us` into
the AP mailbox is blocked upstream by DMARC + EOP. Corrected the misleading
"authenticated envelope" comments in `ap/senders.ts` + `msgraph-mail/normalize.ts`
to state that sender trust rests on the From header + the DMARC/EOP posture
(a documented hard precondition), not a cryptographic envelope. ADR-0053 D4 → done.

### Security — 2026-07-16 (ADR-0053 D2: session revocation kill-switch)

Operator-directed. Closes the audit's `JWT` high — a demoted / deactivated /
fired manager kept full token-cached powers (approve amendments, void invoices,
exports, `/admin/*`) until the 12h idle / 30d absolute cap. New additive
`users.sessions_invalidated_at` column (migration
`20260723_user_sessions_invalidated_at`, ADR-0035 clean-replay) is bumped in the
same audited mutation whenever an admin changes a token-cached claim (`role` /
`all_sites`) or deactivates / soft-deletes a user. The Auth.js jwt callback (Node
pass) now re-reads `is_active` / `deleted_at` / `sessions_invalidated_at` fresh
on every request and empties the token — forcing re-auth — when the user is
inactive/deleted or the switch post-dates the token's `iat`. Off-boarding is
effectively **instant**; a demotion re-mints fresh claims on the forced re-auth.
The DB read is a Node-only injected checker, so the edge middleware stays
Prisma-free (Middleware bundle unchanged). Defense-in-depth on top of the Entra
`signIn` gate; idle/absolute timeout preserved. Residual: an `is_super_admin`
demotion (raw-SQL only, no app path) must set `sessions_invalidated_at` in that
SQL to revoke a live super-admin session. tsc + full vitest (+19 tests) + lint +
prod build green. ADR-0053 D2 → done.

### Security — 2026-07-16 (D1+D5: Next.js off the middleware-bypass advisory + CVE clear)

Operator-directed. Bumped `next` 15.5.15 → 15.5.20 (patched < 15.5.18;
non-breaking within `^15.5`), clearing the App-Router middleware/proxy-bypass
and Server-Components DoS **high** advisories on the auth-boundary framework.
Non-force `npm audit fix` cleared the remaining in-range prod highs
(form-data, ws) + moderates without any framework/breaking change. Residual
high/critical are dev-only vite/vitest (not shipped). ADR-0053 D1/D5 → done.

### Changed — 2026-07-16 (ops-ledger task assignee widened to managers)

Operator call: the ledger task-assignee picker (shipped same day scoped to
admins only) now offers **admins + managers** (`listAssignableOwners` /
`assertAssignableOwner`), so site/all-sites managers like Daven can own
follow-ups. Operators remain non-assignable; the server still 422s a
non-assignable id.

### Added — 2026-07-16 (ADR-0052 BUILT: commodity payment reconciliation v1)

Bill approved D1–D3 as proposed and ordered the build. New
`outbound_material_payments` companion table (additive migration
`20260721_commodity_payment_recon`), forward-only status transitions with
audited provenance, `/dashboard/ops/commodity-payments` view (org reach —
admin/all-sites; both sites, aging, CSV) + launcher tile, and the
`m3_commodity_payment_aging` audit check (30d ship→invoice / 45d
invoice→paid, per-buyer rollup, bootstrap-gated on first payment entry,
digest-routed). ADR-0052 → Accepted.

### Added — 2026-07-16 (ops ledger: email link + assign-to-admin, ADR-0045 amendment)

The daily digest now always carries an "Open the ops ledger" button (was
tasks-only) so the team can reach the ledger from any digest email. Ops tasks
can be assigned to a particular admin — create-form + per-row admin picker,
server-validated (`assertAssignableAdmin`, 422 on a non-admin), audited
reassignment (`reassignTask`), owner shown in the queue. Ledger tile was
already live (manager+, alert_digest surface).

### Fixed — 2026-07-16 (money-path & audit-integrity audit batch — 2026-07-16 full-stack audit)

Remediated the money-path & audit-integrity findings from
`docs/security/2026-07-16-full-stack-audit.md` (branch `fix/audit-money-integrity`):

- **H1 (HIGH) — Amendment approve/reject had no CAS.** `applyApprovalInTx` /
  `applyRejectionInTx` now flip `pending→approved/rejected` via a guarded
  `updateMany({ where: { id, state: 'pending' } })` as the first mutation; the
  loser gets a `count 0` → `request_not_pending` (409) and its daily-entry
  mutation + audit never run. Closes the window where two reviewers could both
  pass a check-then-act gate and leave an entry mutation standing under a
  `rejected` state with a falsified `before: pending` audit. Group approve/reject
  CAS each member via the shared helpers.
- **M2 (MEDIUM) — AP decide flip + audit not atomic.** `writeAudit` gained an
  optional `{ tx }` client (all existing callers unchanged); `decideRequest`'s
  winning flip + its audit now commit in one `prisma.$transaction`, so a crash
  between them can no longer strand a live, unaudited decision. Email/stamp/R2
  work stays outside the tx (a committed decision never rolls back on a mail
  failure).
- **M1 (MEDIUM) — Late daily-report immediate-send not atomic.** Both the on-save
  (`daily-report-late`) and scheduled (`daily-report-runner`) paths now
  claim-before-send: they atomically create (or CAS-`updateMany`) the
  `(site_id, report_date)` log row as the claim BEFORE the Graph send; a P2002 /
  `count 0` bails without sending. Prevents duplicate production reports from a
  double-click or an on-save/scheduled race. Delivery columns finalized after the
  send; fail-soft preserved.
- **M3 (MEDIUM) — Credit memos had no cumulative cap.** `createCreditMemo` now
  enforces `Σ(applied + in-flight non-terminal memos) + amount ≤ invoice.total_cents`
  (aggregate + pure `assertWithinCumulativeCap`, typed `cumulative_exceeds_invoice`
  422). Per-memo and single-open guards retained.
- **L2 (LOW) — Credit-memo tail write unaudited.** `transitionCreditMemo`'s
  `superseding_invoice_id` write is folded into a `$transaction` with its audit
  row — the last unaudited credit-memo mutation is now on the trail.
- **M4 (MEDIUM) — AP client truncated comma currency.** `ApQueueClient` now
  normalizes the amount via `parseUsdToCents` (strips US thousands separators,
  rejects `$`-prefixed/ambiguous input with a message instead of silently coercing
  `1,234.56`→`$1.00`); `inputMode="decimal"` retained.
- **F7-AP (LOW) — AP free-text uncapped.** The decide route caps `note` (≤2000)
  and `vendor` (≤200), returning 400 on overflow before any state change.

Unit tests added/extended for each fix; `tsc` clean, full `vitest` suite green,
lint clean on changed files. Survey/input/infra findings are owned by the
parallel hardening pass and untouched here.

### Security — 2026-07-16 (input-validation + infra hardening — audit 2026-07-16)

Remediated the input-validation / infra findings from
`docs/security/2026-07-16-full-stack-audit.md` (branch `fix/input-infra-hardening`).
Money/AP-integrity findings (H1/M1/M2/M3/M4) are a separate parallel batch.

- **SSRF (HIGH)** — the body-only AP decision PDF re-render no longer fetches
  attacker URLs server-side: remote `<img>` src is rewritten to `about:blank`
  before render (`neutralizeRemoteImageSrcs`), the Playwright renderer intercepts
  and aborts every non-`data:`/`about:` request, and `waitUntil` moved from
  `networkidle` (30s) to `load` (15s bounded). Stamped-original pdf-lib path
  unchanged. (`src/lib/ap/stamp.ts`)
- **CSV formula injection (MED)** — `escapeCsvField` now prefixes a `'` to any
  field starting with `= + - @` / tab / CR before RFC-4180 quoting; one fix covers
  all finance exports. (`src/lib/exports.ts`)
- **Photo upload MIME (MED)** — `content_type` constrained to an image allowlist
  (`z.enum`) at the boundary, matching R2 `SAFE_EXT`. (`api/photos/upload-url`)
- **Health authz (MED)** — `/api/health/subsystems` now role-gates to
  manager/admin (403 otherwise). (`api/health/subsystems`)
- **Internal cron routes (MED) + constant-time (LOW)** — new shared
  `src/lib/internal-auth.ts`: `INTERNAL_CRON_TOKEN` is mandatory in production
  (unset → 503; fail-open only in non-prod), and the bearer is compared with
  `timingSafeEqual`. Applied across all 12 `/api/internal/**` routes; contact-intake
  reuses the same `constantTimeEqual` helper.
- **Unsandboxed iframes (LOW)** — `sandbox=""` added to the digest and invite
  `srcDoc` preview iframes. (`DigestsClient.tsx`, `InvitePreview.tsx`)
- **Free-text caps (LOW)** — survey draft `answer_text` capped at 10k;
  `answer_json` replaced with a depth/size-bounded schema. (`survey/[token]/draft`)
- **Committed secrets (MED)** — `legacy/` (dead predecessor PHP with a bcrypt admin
  hash + MySQL creds) deleted from the tree.
- **No `.dockerignore` (MED)** — added; excludes `.git/objects`+`.git/logs` (the
  secret-bearing history) from the builder `COPY . .` layer while keeping
  `.git/HEAD`/refs so the deploy-identity SHA bake still resolves.
- **No container limits (MED)** — conservative `mem_limit` + `pids_limit` added to
  the app (1500m/512) and the Chromium-invoking cron services (1024m/256) as a
  blast-radius cap on the shared host. (`docker-compose.yml`)

Tests added/extended for every code-level fix (stamp SSRF, CSV guard, upload
allowlist, health authz, internal-auth guard, survey caps, both iframes).

### Changed — 2026-07-16 (office dark-theme sweep executed — C-16 / ADR-0051)

Operator directive (Bill): "everything goes to the new look except the floor
iPads." Repainted every remaining green office/manager surface to the Vision
deep-space theme (`dr3-space`/`dr3-mist`/`dr3-cyan`/`dr3-steel`), following the
AP reference (PR #99) as an in-place token swap: all `/dashboard/[site]/*`
pages + clients (cor, equipment, invoices, invoices/[id], loads-inventory, ops,
yard), `/dashboard/ops/digests`, `/admin/processed-units`,
`/admin/production-report`, `/bonus/amendments`, the `/login` locale picker, and
the app-global chrome (`layout` PWA themeColor, `global-error` fallback, the
`UpdatePrompt` banner CTA). `/login` is the office Entra SSO door (the floor PIN
path is under `/operator`), so it goes dark. The floor (`/operator/*`) and the
COR PDF renderer keep the ADR-0008 green. New `office-dark-theme-sweep.test.tsx`
statically guards the "no green office pages" invariant. Closes OPEN-ITEMS C-16.

### Added — 2026-07-16 (ADR-0052 drafted: commodity payment reconciliation, Proposed)

Per the Daven Stetson personnel-wiring handoff (§4 as corrected by §7):
payment-tracking companion table for `outbound_materials`, Daven-facing aging
view (born pilot), one ADR-0039 audit check riding the 0043 digest. Status
Proposed — D1 (aging thresholds), D2 (expected-amount optionality), D3
(per-buyer rollup) presented to Bill; build starts on his answers. Numbering
per §7.4: claimed 0052 at draft time; OPEN-ITEMS O-7/S-2 corrected to stop
reserving numbers for undrafted ADRs.

### Fixed — 2026-07-15 (approver note now displays on the returned invoice PDF)

Operator directive: the decision note must be visible on the output invoice
accounting receives. The pdf-lib overlay (real-PDF path) never drew it — only
the email body and the Playwright stamp paths did. The stamp band now grows
to carry the note (wrapped, 3-line cap + ellipsis; full note stays in the
email body) on every page, both decisions. Note field labeled accordingly.

### Decided — 2026-07-15 (floor UI stays GREEN — O-9 fully closed)

Operator decision: the warehouse-floor iPad surfaces (`/operator/*`) keep the
ADR-0008 green theme; deep-space stays office/manager-only (ADR-0051
post-acceptance note). With the site-tag requirement shipped the same day
(PR #105), both halves of OPEN-ITEMS O-9 are closed. Docs-only change.

### Changed — 2026-07-15 (AP decisions: site tag now REQUIRED)

Operator directive: every AP decision must carry the Woodland/Eugene site tag
(was optional; accounting files each invoice against a site in GP). Enforced
service-side (`assertDecisionSite` → `ApSiteRequiredError` 400 before any
state change), route-side (resolve + refuse pre-CAS), and in the queue UI
(required select + client guard). Closes O-9(a); ADR-0046 post-go-live
amendment note.

### Ops — 2026-07-15 (AP MODULE LIVE — production)

Operator order following the same-day validation pass: all test requests
purged (DB + R2 + mailbox; audit retained) and `ap_notify` flipped to LIVE at
both sites (audited, criteria note on the rows). Real routing now in effect:
new-invoice alerts → the 4-approver roster; decision mail → the original
forwarder with Mary CC'd; stamped originals attached and archived. Rollback
is a pilot flip on /admin/rollout.

### Validated — 2026-07-15 (AP module operator sign-off)

Bill's live test runs passed end-to-end ("working perfectly"): ingest → tile →
dark queue → inline preview → site-tagged decision → decision email carrying
the actual stamped original, R2-archived. Validation record in ADR-0046; the
go-live flip (both sites) is O-1 in docs/OPEN-ITEMS.md.

### Fixed — 2026-07-15 (AP decision mail returns the ACTUAL invoice, not a body render)

Live defect caught by Bill in today's operator test (request `c38909b2`): an
approved invoice with a real PDF attachment **and** a forward body came back as a
stamped **body render** instead of the Hertz invoice, and
`original_attachment_sha256` was NULL — the pdf-lib overlay never ran.
`buildDecisionStamp` gave the **body precedence**, and a forwarded invoice always
has a body, so the overlay path was dead for the exact case it was built for.

- **Attachment-first precedence.** Real file attachments now win: each is stamped
  (true pdf-lib / Playwright overlay) and returned; the body render is the fallback
  for body-only invoices. When attachments exist the mail is **docs-only** — the
  approver's note is already stamped onto every attachment, so accounting files the
  actual document into GP, not the forward wrapper. Zero caller changes;
  `original_attachment_sha256` auto-populates.
- **Inline-image filter (ship-now heuristic).** Forwarded signature/logo images
  (`image/*` under 50 KB) are excluded so a stamped `logo.png` never rides the mail;
  PDFs and non-image files are always kept, and the filter never empties a decision
  mail that has real files. Durable follow-up (capture Graph `isInline` into a new
  `ap_attachments.is_inline` column, retiring the size heuristic) noted in ADR-0046.
- **Filename collision de-dup** for multi-attachment mails
  (`approved-invoice.pdf`, `approved-invoice-2.pdf`) so neither MIME part clobbers
  the other. See ADR-0046 post-amendment note (2026-07-15).

### Added — 2026-07-15 (site tag unmissable on AP decisions)

Operator directive (Bill): when an approver tags a site (Woodland/Eugene) at
decision time, accounting must see it without hunting. The site now rides the
decision email SUBJECT (`DR3-Vision AP decision (approved — Woodland) — …`),
leads the decision facts in the body (`Site: Woodland`), and is printed in the
per-page stamp line of the returned document (`… via DR3-Vision — Site:
Woodland`) plus the stamped page's meta block. Untagged decisions are
unchanged (the tag stays optional).

### Added / Changed — 2026-07-15 (AP module overhaul — functional & robust, operator-directed)

Bill: "let's do this now — functional and robust." Ships behind AP pilot mode
(ADR-0047). ADR-0046 Amendment 4 (items 2/3/5) + ADR-0051 (item 1) + ADR-0020 note
(item 6). `pdf-lib@1.17.1` added (pure-JS, MIT).

- **AP queue repainted to the Vision deep-space theme** (ADR-0051). The AP page
  shell + `ApQueueClient` tabs/selection accents move from `dr3-green-deep`/white to
  `dr3-space`/`dr3-mist`/`dr3-cyan` (chartreuse → cyan), with the dashboard's nebula
  atmosphere for continuity. The floor (`/operator/*`) stays green per ADR-0008; the
  rest of the office is a follow-up sweep. Message-body iframe stays `bg-white`.
- **Inline attachment preview** — approvers preview PDFs/images **in-panel** instead
  of a download round-trip. The attachment route enforces an inline allowlist
  server-side off `content_type` (`pdf`, `png/jpeg/jpg/webp`) and signs with
  `Content-Disposition: inline`; PDFs render in a cross-origin `<iframe>` (no
  `sandbox=""` — it kills Chromium's PDF viewer), images in `<img>`; per-attachment
  collapse/expand; >15 MB opens in a new tab. **CSP** gains
  `frame-src 'self' https://*.r2.cloudflarestorage.com` (`next.config.js`).
- **GP matching keys stripped from email bodies** — the decision, hold-notice, and
  new-request emails no longer repeat request id + original subject as body lines.
  The keys survive on the **subject line** and the **stamped decision PDF** (and the
  request id in the deep-link URL). Bodies now read as human decision notices.
- **Stamp the ORIGINAL invoice, both decisions** — reverses the §C10 no-PDF-lib
  constraint. `stampOntoOriginalPdf` overlays a visible stamp band + diagonal
  APPROVED/REJECTED watermark onto **every page** of the original PDF (pdf-lib, true
  overlay, reproducible sha via pinned metadata dates); image originals overlay via
  Playwright; **each** file attachment is stamped (multi-attachment loop). The
  stamped original(s) are attached to the decision email and archived to R2
  (`ap/{requestId}/decision/…`). The row records a **dual-sha tamper record**
  (`decision_pdf_sha256` + `original_attachment_sha256`) + `decision_pdf_r2_key`
  (migration `20260720_ap_decision_artifacts`, purely additive). Fail-soft preserved:
  a stamp/download/R2 failure never blocks the decision email; R2-unconfigured
  degrades to the stamped cover page.
- **AP Approvals dashboard tile + condensed grid** (ADR-0020 note) — new
  `ap-approvals` tile under a new `ap-approver` scope (admin OR active roster member,
  via `canActOnApRequest`), with a live pending-count cyan badge. Tiles condensed
  (`p-4`, `h-9` icon chip, `line-clamp-2`, `min-h-[88px]`) and the grid widened to
  `xl:grid-cols-4` for office-iPad tap density.

### Ops — 2026-07-14 (RAOP mail incident CLOSED — proper sender restored)

O-0 executed: `dr3-vision@svdp.us` added to the RAOP scoping group (Bill,
Exchange device-code session; pwsh + ExchangeOnlineManagement now live on the
workspace host at `~/.local/pwsh`). Post-propagation probe 201, the 2026-07-10
temporary sender unwound (`M365_MAIL_FROM_ADDRESS` back to
`dr3-vision@svdp.us`), app recreated, live test report delivered from the
proper identity. Daily/late reports and payroll mail send as DR3-Vision again;
AP decisions keep their approvals-dr3 identity by design.

### Added — 2026-07-11 (late bonus entry still sends the daily report, immediately)

Operator directive (Bill, 2026-07-11, effective immediately): "even if a site
does not get their bonus entered by the required time the report still goes
out as soon as they hit save … the production data still has to get out to
the team regardless of when it gets put in — there should just be a flag on
there that says what time it was submitted."

- **On-save late path** (`src/lib/bonus/daily-report-late.ts`): after every
  successful daily-entry save — and after every approved amendment — if the
  entry's day is past its site's scheduled Pacific send time (a prior day is
  always past), the production report goes out RIGHT THEN, flagged with the
  submission time (amber banner + " — LATE ENTRY" subject suffix; re-sends
  say the report supersedes the earlier one). Weekend/holiday skips do not
  apply to this path: data entered means work happened.
- **Idempotent per content:** re-saving unchanged numbers never re-sends; a
  save that CHANGES a day's totals after a report already went out re-sends
  the corrected numbers (subject " — UPDATED (late entry)", `resend_count`
  bumped) so the team always ends the day with the real figures.
- **Fail-soft by contract:** the late send can never fail or delay the
  manager's save (errors log loud; the save has already committed).
- Migration `20260719_daily_report_late_flag` (additive): `late_submission`,
  `data_entered_at`, `resend_count` on `bonus_daily_report_log`.
- The scheduled ADR-0030 fire is unchanged and still owns the on-time case.

### Ops — 2026-07-10 (RAOP mail incident: daily reports 403 since the 7/9 policy)

The 2026-07-09 ApplicationAccessPolicy (IT-permissions execution, PR #86)
scoped the Graph app to the approvals scoping group — which does not contain
`dr3-vision@svdp.us`, the payroll/daily-report sender. First fire after the
policy (7/9 6 PM PT daily reports) failed 403 at both sites with zero
deliveries; P15 payroll mail (7/21) would have failed identically. Mitigated
same-day by pointing `M365_MAIL_FROM_ADDRESS` at `approvals-dr3@svdp.us`
(in-policy; verified delivered via the internal test-send). PROPER FIX is an
operator action — add the dr3-vision mailbox to the scoping group and restore
the env (docs/OPEN-ITEMS.md O-0). Discovered during the 2026-07-10 sweep's
follow-through, not by an alert: a 403'd report writes a log row and pages
nothing — a delivery-failure alert is a candidate hardening item.

### Added — 2026-07-10 (open-items register)

- **`docs/OPEN-ITEMS.md`** — the single live register of everything hanging
  (operator actions incl. the AP go-live flip and the §7 file-fetch decision,
  stakeholder blocks, accepted code residuals from the 2026-07-10 sweep, and
  the §8.2 queue). Anchor deadline recorded: Kelsey's window ends 8/1. Sessions
  append loose ends there and move closed items to Done.

### Fixed — 2026-07-10 (production-readiness stack sweep — ops + 3-subsystem audit)

Operator-ordered top-to-bottom sweep (Bill, 2026-07-10) ahead of AP go-live:
CHAD ops audit + parallel code audits of the AP module, the 10 cron daemons /
internal routes, and the billing/workbook money code. Ops fixes applied live
same-day; code fixes below. Migration `20260718_billing_hardening` is purely
additive (two unique indexes; both tables empty in prod).

**AP module (go-live blockers):**

- **Live poll now hydrates the FULL message body** via `transport.getMessage`
  before ingest — the Graph delta `$select` has no `body`, so every live-mode
  invoice would have persisted a ~255-char `bodyPreview` as its content
  (body-only invoices truncated silently; masked by mock fixtures that carried
  full bodies — the mock now mirrors the real body-less delta projection).
  Duplicates are pre-checked before hydration (no wasted Graph round-trip).
- **Queue page no longer locks out single-site approvers.** It still gated on
  the pre-amendment org-reach rule (admin/all_sites) while the routes had
  moved to the ap_approvers roster — Rick (Eugene) would have gotten "Access
  denied" from the very deep link the new-invoice email sends.
- A follow-up arriving while a request is ON HOLD threads as a follow-up
  (was: created a duplicate request + second all-approver alert).
- Decision email + queue banner + queue UI timestamps are Pacific (were raw
  UTC / browser-zone).
- A poison message now quarantines (`ingest_error`) instead of stalling the
  mailbox's delta token forever; an auth failure still fails the run closed.

**Cron daemons / internal routes:**

- `mymrc-cron` recurring timer un-`.unref()`'d — the daemon exited after one
  scrape and `unless-stopped` turned "hourly" into a continuous scrape loop
  (service currently profile-disabled; safe to re-enable now).
- The three bonus daemons (daily-report, period-close, escalation-check) now
  follow the ADR-0036-addendum fetch contract (`redirect:'manual'`, non-200
  throws) — they were the last daemons that would have followed a login 307
  to a fake 200 while payroll close/auto-sign silently no-op'd.
- The naive "DST-correct" fire-time helper (double-fire on fall-back, 1h late
  on spring-forward) replaced with the offset-reprobe pattern in all seven
  daemons that carried it; DST-transition-day tests added for every schedule.
- Period-close gains bounded same-day retry (30-min × 6) — a transient 07:00
  failure on payroll day no longer permanently skips the close. (Widening the
  route's `period_end == yesterday` matcher was evaluated and REJECTED: past
  `draft` periods are legitimate — a wider matcher would mass-close them and
  mass-email signers on fresh seeds/onboarding.)
- Route-guard regression tests added for board-pack/send, workbook-sync/poll,
  bonus/generate-pdf; explicit public-paths case for bonus/daily-report.

**Billing / workbook money code:**

- **CA fuel surcharge fails loud instead of billing $0** when an
  override-priced source has no `canonical_mileage` (was: `miles ?? 0` →
  $0.00 `applied:true` per load, forever).
- **Workbook promotion writes `arrived_at` as the Pacific-midnight instant**
  (was: @db.Date UTC-midnight = 4/5 PM Pacific the PREVIOUS day — a promoted
  June-1 load fell into May's billing window and priced fuel off the prior
  ISO week). Conflict scans on the two instant columns (`arrived_at`,
  `snapshot_at`) now bound by the Pacific-day window.
- **A billing-gate override is no longer a permanent skeleton key**: it covers
  only findings first-detected before it was recorded; a newer blocking
  finding re-blocks the window and demands a fresh audited justification.
- **CA EOM refuses to compose a NEGATIVE total** (mid-month exceeds the
  revised gross) with a typed error pointing at the credit-memo path.
- Invoice approve/void are atomic CAS transitions (concurrent transition →
  typed 409, never approve-over-void); void of an APPROVED invoice now
  requires the D4 approver rule (was reach-only — an all-sites manager could
  cancel any site's approved invoice) and APPENDS its reason to notes instead
  of overwriting the generation note.
- DB backstops (`20260718_billing_hardening`): unique version per
  (site, kind, month) chain; ONE open credit memo per invoice (partial unique
  index; service maps the conflict to the typed error).
- Haul-rate admin refuses inverted windows (`effective_to < effective_from`
  silently never matched — the negotiated override quietly fell back to the
  tier rate) and duplicate `effective_from` per source; the freight resolver
  detects override/tier ties as typed errors instead of coin-flipping.
- Workbook-sync fails SAFE on an unreadable cutover state (skip the poll —
  never workbook-wins-overwrite a possibly-cut-over site); cutover also flips
  `is_syncing=false` as durable belt; the naming-pattern regex tolerates a
  repeated `{MONTH}`/`{YEAR}` token; manual invoice lines are magnitude-capped.

**Observability:**

- Prod logs, OTel traces, and boot alerts now carry the REAL deploy sha —
  next.config's env inlining rewrites only dotted `process.env.X`, and the
  repo's bracket-access convention (`noPropertyAccessFromIndexSignature`)
  silently missed the inline everywhere, stamping `version:"dev"` since the
  mechanism shipped. Fixed via a `ProcessEnv` declaration merge + dotted
  access in one `buildInfo()` source.

**Ops (applied live on CHAD 2026-07-10, no deploy needed):**

- `ap-poll` was running the previous day's image: the deployer's plain
  `up -d` never includes the `ap` compose profile, so every deploy stranded
  the profile-gated service on the old build. Recreated on the current image
  and made durable via `COMPOSE_PROFILES=ap` in the host `.env`.
- Prod seed run (idempotent): the 3 Eugene paper-form sources landed
  (111→114); everything else no-op.

### Added — 2026-07-09 (rollup §8.1 build queue — ships-without-files subset)

The OPERATOR-ordered §8.1 build queue of the 2026-07-09 full rollup
(`docs/handoffs/2026-07-09-full-rollup-mary-morena-july-terex-eugene-2026-07.md`,
PR #91): everything buildable before the real workbook files land on titan
(§8.2 promotion/fuzzing/close-balance wait on a §7 fetch method). Migration
`20260717_trade_discount_credit_memos_verify` is purely additive and
clean-replays on empty PG16.

- **Row-2 section-label resolver (ADR-0049/0048, rollup §3.2).** July's workbook
  dropped the month prefix from category tab names ("June26 Commodities" →
  "Commodities"), killing sheet-name matching. New
  `src/lib/audit/workbook/section-resolver.ts` classifies sheets into
  `worksheet_semantic_type` by (1) DAY-name regex, (2) row-2 section label,
  (3) header-row signature, (4) month-prefix-stripped name fallback — never
  throws, returns `unknown`. June + July tab names resolve identically; the
  full row-2 label set finalizes against real bytes in §8.2 (TODO markers
  distinguish confirmed vs inferred labels).
- **DAY-sheet cotton block encoded (rollup §3.1 / ADR-0037 note).**
  `day-sheet-layout.ts`: every DAY sheet carries 8 outbound commodity blocks;
  DAY6 carries a PERMANENT 9th COTTON block at cols 68–75 (confirmed in both
  June and July — not an anomaly). Taxonomy already had `cotton`; this encodes
  the structural expectation the §8.2 parser finalization asserts against.
- **Explicit GP Trade discount (ADR-0041 addendum, rollup §1.3).**
  `invoices.trade_discount_cents` + `trade_discount_reference_invoice_id`
  populated on CA-EOM generation; offset-line description + summary render now
  speak GP (gross month total → Trade discount → balance due). Totals, line
  codes, and the frozen export-v1 contract unchanged.
- **Credit-memo correction path (ADR-0041 addendum, rollup §1.4).**
  `credit_memos` + typed state machine `proposed → sent_to_mrc → accepted |
rejected → applied | void_and_reissue_triggered` (MRC acceptance REQUIRED
  before apply; rejection composes with the existing supersede chain). Service
  `src/lib/invoices/credit-memos.ts` + manager routes; admin UI is a follow-up.
- **Billing verification view for Mary (rollup §1.2).** Read-only
  `/admin/billing/verify`: latest non-void invoice per (kind, month) for the
  current + previous PACIFIC billing months, each with its ADR-0039 window
  posture (green = approved + clean / yellow = findings or still-a-draft /
  red = gate-blocked) and the GP three-line structure on CA-EOM. New
  `users.can_view_billing_verify` flag — MANAGER-ONLY with the exact
  `can_manage_rates` coercion (hard rule #2; operators never; cleared on role
  change), site reach per rule #2 (all_sites managers + admins see both
  sites). Grant Mary manager + all-sites + this flag once her account exists.
  The page reads one findings fetch per site feeding both the gate and the
  rendered list (light and list can never disagree; constant 4 queries/site).
- **Seeds.** `sources.csv` +3 Eugene paper-form sites from the rollup §4.3
  sample (Thompsons Sanitary Service, Stayton Community Center, Deschutes —
  names/addresses to confirm with Rick); `Glenwood TC 143/144` documented as
  aliases of the seeded Glenwood station and `Illegal Drop`/`Sponsors` as
  drop-off kinds, not sources. `seedWorkbookSync` + `WorkbookSource` docs now
  state Eugene is DEFINITIVELY paper-only (rollup §4.2) — never add a source row.
- **Fixture-based parser tests (rollup §5/§8.1-7).** The §5 real-byte samples
  saved verbatim at `tests/fixtures/adr-0048/sample-rows.json`; 19 new vitest
  cases round-trip them through exceljs and pin the known-good rows (Bass Hill
  2026-06-19 · 52 units · $1,619.14 total; EIA fuel week 2026-03-02 @ 4.534).
- **Review-pass hardening (same day, 8-angle review).** Credit-memo
  transitions are atomic compare-and-swaps (typed 409 on a lost race; reissue
  claims-then-supersedes with compensation on failure); memo amounts bounded
  to the invoice total + one open memo per invoice; the mid-month offset
  reference is APPROVED-invoices-only (a draft's total was never invoiced);
  no phantom $0.00 Trade discount fields; a write-time tripwire asserts the
  column mirrors the stored offset line; migration backfills the columns from
  pre-existing B22.offset lines; the GP "Balance due" framing keys on the
  STORED offset line (not the kind) across xlsx + manager detail + verify;
  shared `KIND_LABEL` (types.ts) + `formatUsdCents` (format.ts) + workbook
  `cells.ts` replace per-file copies; the section resolver runs
  header-signatures before row-2 labels (a data row containing a label word
  can't out-vote a sheet's own header fingerprint) and short-circuits DAY
  sheets; historical B22.offset rows keep the old description — `line_code`
  is the only stable join key.
- **Docs.** Post-acceptance notes on ADR-0037 (cotton permanent), ADR-0039
  (read-only findings surface), ADR-0041 (addendum above + §D review items),
  ADR-0046 (outgoing stewardship AP stays out of scope — ADR-0051 candidate).

### Added — 2026-07-09 (dr3-intel-2026-06 survey export — campaign closure)

- **Survey campaign `dr3-intel-2026-06` closure completed.** Mary Scott (final
  outstanding respondent) self-submitted 2026-07-07 12:29 PM PT after 5 automated
  reminders; ADR-0036 auto-close fired 3 minutes later. Response export (9
  respondent files + `_summary.md`) generated from the prod DB in `buildExport`
  format and committed under `docs/operations-intel/dr3-intel-2026-06/` — the
  close route builds but does not push the export (ClaudeSync push is still a
  follow-up), so this commit is the export artifact. Operator runbook campaign
  log updated with the final standing.

### Added — 2026-07-09 (ADR-0046 Amendment 3 — AP go-live features)

Operator-directed (Bill, 2026-07-09) ahead of AP going LIVE ~2026-07-11. Amends
ADR-0046 §C5; mock-first transport architecture unchanged. Migration
`20260716_ap_hold_and_notes` is purely additive and clean-replays on empty PG16.
All AP mail still routes through `notifyStaff('ap_notify')` (born pilot — reroutes
to admins until Bill flips it live).

- **New-invoice notification to ALL active approvers, enriched.** The one-per-request
  new-request email (already sent to the full expiry-aware roster, excluding any
  approver past `active_until`) now carries the requester, subject, received-at
  (Pacific), attachment count, and a **tier-1 deep link** to the specific queue item
  (`/dashboard/ops/ap?request=<id>`).
- **Approval / rejection notes.** A **rejection now REQUIRES a note** (plain-English
  400 at the decide route + disabled Reject until a note is present); approvals stay
  note-optional. The note rides the decision email, the **stamped decision PDF**, and
  the audit row.
- **`pending_review` (hold) status.** An approver may place a pending request **on
  hold** with a required hold note (`ap_requests.held_by`/`held_at`/`hold_note`,
  enum value `pending_review`). Accounting (the original forwarder) is emailed that
  it is held (who + note + "a final decision follows"). The queue shows an amber
  **ON HOLD** chip with holder + note visible to all approvers. From hold, any
  approver may approve/reject (first-action-wins unchanged) or update the hold note.
  Held items are excluded by design from any future staleness alert (none exists
  today). Every transition is audited.

### Added — 2026-07-09 (planning rollup 2026-07-08 — build-now subset)

The OPERATOR-ordered build-now subset of the 2026-07-08 planning rollup
(`docs/handoffs/2026-07-09-planning-session-decisions-rollup-2026-07-08.md`). Four
features + two proposal ADRs. Every new staff-facing surface is **born pilot**
(ADR-0047); no email is sent by anything added here in pilot (decision/board-pack
mail reroutes to admins). Migrations `20260715_pool_split` +
`20260715b_rollup_ap_boardpack_yard` clean-replay on empty PG16.

- **ADR-0037 §3 — inventory pool split.** `site_inventory_snapshots` gains
  `program_units` / `non_program_units` (`Decimal(7,1)`) + `pool_attribution`
  (`measured` | `legacy`). Physical counts record the program and non-program pools
  separately; a `measured` count is validated `program + non_program == total`
  (typed `PoolSplitMismatchError`, 422). Existing rows backfilled `legacy`
  (all-to-program). The count-entry UI gains the two fields + a live running-total
  helper + plain-language mismatch error (EN/ES/UR). `running-balance.ts` `onHand()`
  uses the measured split as the anchor when present, else legacy fallback;
  `{ program, nonProgram, total }` return shape unchanged.
- **ADR-0046 §3 — AP mailbox expansion.** Explicit `ap_approvers` roster (Morena,
  Rick, Janette, Kelsey; Bill acts as admin) with `active_until` — single-site
  managers are now full approvers (queue permission = admin OR active approver).
  Kelsey auto-removes 8/1 via a daily `ap-approver-expiry` cron (audit + Bill ntfy).
  Optional site tag at decision (`ap_requests.site_id`). Decision email routes to
  the original internal `@svdp.us` forwarder (intake sender validation unchanged),
  carrying a visible-stamp PDF (no crypto) whose sha256 is a tamper record
  (`ap_requests.decision_pdf_sha256`); stamping reuses the repo's Playwright→PDF
  mechanism (no PDF library added — see the ADR §3 amendment for the deviation).
- **ADR-0045 §3 — board-pack digest.** New org-wide `board_pack_digest` notification
  surface (born pilot) sent via `notifyStaff`. `board_pack_recipients` roster
  (Bethany + Bill; Bethany is a documented placeholder). Fires the 2nd Wednesday +
  preceding Monday (Pacific, reusing `digest-calendar.ts`), one send/month
  (`board_pack_send_log`). Payload: prev-month processed units, MTD, YoY, P&L
  placeholder, no safety section. First LIVE send targets 2026-08-10 (ships pilot).
- **Trailer/yard list scaffold (rollup §1.8).** Manager `/dashboard/<site>/yard`
  view behind the new `yard_list` UI surface (born pilot ⇒ admin-only). Reads
  `container_rental_sites` + on-hand context; `yard_trailers` table (label,
  location, status) with add/edit (audited). EN/ES/UR.
- **ADRs 0049 (workbook sync bridge) + 0050 (compliance-admin ledger)** drafted as
  Proposed (no code) and indexed. ADR post-acceptance notes added to 0030 / 0028 /
  0029 / 0047 (Q-0047 grandfather resolutions).
- **ADR-0049 — Woodland workbook → Vision sync bridge (BUILT, mock-first).** Status
  → Accepted (2026-07-09 operator build-all order; parser finalization + enable flip
  gated). The `Files.Read.All` tenant grant landed 2026-07-09 (app
  `2da2…`). Mirrors each site's monthly Woodland daily-log workbook from Kelsey's
  OneDrive into `processed_units_daily` every 10 min (business hours, PT). New
  `src/lib/msgraph-files/` READ-ONLY Graph Files transport (live + fixture mock; creds
  fall back to the shared `MSGRAPH_MAIL_*` app — one app, two capabilities) and
  `src/lib/workbook-sync/` engine: current-month discovery + auto rollover (D5), cTag
  delta (no re-download when unchanged, D2), **workbook-wins** upsert with an audit row
  per Vision-overwrite (D3), mid-edit skip+count (D11), `workbook_sync_runs` ledger
  (mymrc shape, always written), 403 fail-soft (log + ntfy, no crash, D6). Cutover flip
  (in `/admin/rollout` OR `/admin/workbook-sync`) stops sync + fires R2 archival to
  `workbooks/{site}/{yearMonth}.xlsm` (D8), soft-gated on Rick's parity signoff (D7).
  `/admin/workbook-sync` admin surface (sources add/edit/enable, run ledger, cutover).
  10-min cron (`scripts/workbook-sync-cron.mjs`) + business-hours-enforcing internal
  route + public-paths exemption (+ regression test) + `workbook-sync` compose profile.
  Migration `20260716b_workbook_sync` (`workbook_sources` + `workbook_sync_runs`,
  `RolloutSurfaceKind` gains `workbook_sync`) clean-replays on empty PG16. Seed adds the
  Woodland source (born `is_syncing=false`) + `workbook_sync` surface (born `pilot`),
  idempotent. GATED: the per-day parser mapping (`daily-adapter.ts`) reads the
  Addendum-B fixture layout until Kelsey's real `.xlsm` lands (D12); each source is
  born disabled pending a deliberate operator enable.

### Fixed — 2026-07-07 payroll-morning hotfix

- **Signature-chain cache TTL (30s).** The per-site chain cache was keyed on the
  prisma singleton and lived for the process lifetime — the 2026-07-07 chain
  repair (override actors pointed at a deactivated duplicate admin user) was
  invisible to the t3 auto-override until an app restart. Config repairs now
  take effect within 30s.
- **Future-period close guard.** The manual "ready to sign" close now refuses
  (409, plain-English) any period whose end date is still in the future —
  Eugene's current P15 was closed by mistake during the P14 signature scramble,
  locking daily bonus entry site-wide. Early close on the final day remains
  allowed.

### Added — 2026-07-07 (ADR-0047 — staff-output rollout gate + ADR-0039 A1 bootstrap gating; INCIDENT)

Response to the 2026-07-06 incident (the ADR-0043 digest emailed a site manager
two true-but-useless bootstrap findings the day the feature merged). Two
release-discipline fixes, deployed together.

- **`notifyStaff()` chokepoint (`src/lib/notify/`).** The ONLY sanctioned path to
  non-admin recipients. Resolves the `(surface_code, site)` rollout state:
  `pilot` reroutes to admins with a `[PILOT — would have sent to: …]` subject +
  body banner (validates content AND targeting); `live` sends to the real
  recipients; an unregistered surface throws `UnregisteredSurfaceError` (never a
  silent send). Every decision is audited + logged.
- **Rollout registry (`rollout_surfaces`, migration `20260713_rollout_gate`).**
  One row per staff-facing surface × site, default `pilot`. Notification
  surfaces seeded pilot (alert_digest, task_reminders, contact_intake_notify,
  invoice_approval_notify, cor_notify, ap_notify) except the grandfathered
  production surfaces (bonus_signature_chain, survey_sends) → live. UI surfaces
  (workbench_manager_read, loads_events_or_tabs, equipment_entry, equipment_trend)
  seeded pilot (admin-only, the ADR-0037 D7 template made data-driven).
- **Rewired through the gate:** the ADR-0043 alert digest (which still fires in
  pilot for admin validation even while the roster is muted), ADR-0045
  contact-intake routing, ADR-0046 AP notifications (new-request + quarantine +
  decision email). Task reminders ride the digest.
- **Repo guard (`src/lib/notify/__tests__/no-direct-mail.test.ts`).** Scans the
  real `src/` tree and fails if feature code imports `@/lib/m365-mail` outside the
  allowlist (transport core, notify layer, auth, payroll delivery, and the
  grandfathered signature-chain + survey + daily-report + amendment senders).
  Proven with an in-memory synthetic-import test-of-the-test.
- **Admin panel `/admin/rollout`** (admin role) — every surface × site with
  state + last-flip evidence; flip requires a criteria note; audited + immediate;
  rollback = inverse flip (no code).
- **Bootstrap gating (ADR-0039 Amendment 1, `src/lib/audit/bootstrap-gate.ts`).**
  `c4_billing_basis` / `m1_missing_close` / `m2_missing_snapshot` (registry-driven)
  emit findings only once their leg (billing/close/snapshot) has ever had data
  OR an admin `go_live_date` (`audit_bootstrap_gates`) has passed. Suppressed
  counts land in `audit_runs.suppressed_bootstrap` (visible in admin, never
  silent). Comparators untouched. Existing bootstrap findings auto-resolve with
  cause `bootstrap_suppression` + provenance via migration
  `20260713b_bootstrap_resolve` (never deleted).

### Changed — 2026-07-07 (bonus period-close moves to payroll-day 07:00 PT — ADR-0019.1 amendment)

- **Period close now fires 07:00 PT on the payroll day (the day AFTER
  `period_end`)**, not 17:30 on `period_end` itself. `scripts/bonus-period-close.mjs`
  fire time 17:30 → 07:00 (`msUntilNext1730Pacific` → `msUntilNext0700Pacific`);
  the close route predicate moved from `period_end == appToday()` to
  `period_end == previousDayKey(appToday())` (idempotency preserved — still filters
  `state = 'draft'`). Escalation tier **t1 moved 06:00 → 07:10** (a post-close
  nudge; t2 07:30 / t3 08:30 / t4 09:00 unchanged). Pacific date matrix + DST
  boundary tested; the escalation route already keyed off yesterday, so its logic
  is unchanged.
- **Amendment error messages** are now plain English at the UI layer
  (`src/lib/bonus/amendment-error-messages.ts`) — no more raw `period_not_draft`
  codes on the request-creation + approve/reject surfaces; every
  AmendmentRequestError code has a sentence (period_not_draft references the new
  7:00 AM payroll-day close window).
- **Report-email logo fix.** `SVDP_LOGO_URL` in the daily production report now
  points at our own asset `https://dr3-vision.svdp.us/brand/svdp-logo-white.png`
  (checked in at `public/brand/svdp-logo-white.png`), not the dead
  `svdp.us/wp-content` WordPress hotlink. No other live hotlinked logo exists (the
  bonus-PDF uses an embedded data URI; the audit digest has no logo).

### Added — 2026-07-07 (ADR-0048 — June operational backfill + Terex history import)

- **Staging→operational promotion (`src/lib/audit/workbook-promotion.ts`).** The
  ADR-0023 historical-import discipline (SHA gate + idempotency + provenance +
  audit) applied to loads/inventory. `promoteWorkbookImport(importId, scope)`
  reads a workbook's parsed staging rows (ADR-0039 `workbook_import_rows`) and
  promotes them, in ONE transaction, into `processed_units_daily`,
  `inbound_loads`, `outbound_materials`, `landfilled_units`, `consumer_dropoffs`,
  and the anchor `site_inventory_snapshots` — every row `source=import` (or, for
  `inbound_loads` which has no RecordSource column, tagged by `import_id`) with the
  promotion id stamped in a new bare `import_id` column on each table.
  - **Idempotent** on `workbook_promotions.import_id` (UNIQUE) — a re-run is a
    no-op that returns the prior counts; a re-run whose staged content changed is
    REFUSED (SHA mismatch).
  - **Conflict refusal** — any live (non-import) row in the (site, table, window)
    is a typed `PromotionConflictError` listing table + dates; no partial merge.
  - **Scope enforcement** — table-driven allow-list (`backfill-scopes.ts`):
    Woodland Jun 1–30, Eugene Jun 24–30; rows outside the window are clipped.
    Enforced in the promote ROUTE (a request may only promote an allowed window).
  - **D2 live assertion** — the June-1 opening inventory is promoted as the
    physical anchor and the June-close balance is recomputed via the shared
    `computeRunningBalance`; the transaction REFUSES COMMIT unless Woodland closes
    to exactly **4,062** (the expected total is scope config, not a hardcode).
  - One audit row per promoted table with counts (append-only, hard rule #6).
- **Terex history import (`src/lib/equipment/import.ts`).** Admin upload
  (xlsx/csv) → `equipment_events` (`source=import`). Flexible header detection
  (date/notes/hours/downtime); downtime rows → `kind=downtime` (hours where
  stated), everything else → `kind=note`. FAILS LOUD (typed `TerexParseError`,
  listing what it saw) on an unrecognized shape — never guesses rows. Idempotent
  on (site, event_date, kind, note-hash); re-uploading the identical file is a
  no-op (`equipment_history_imports.source_sha256` UNIQUE). The mapping is
  **finalized against Janette's real file on receipt** — the upload UI says so.
- **Admin surfaces.** Promotion panel on the workbook-import detail
  (`/admin/audit/workbook/[importId]`): scope options → dry-run preview (per-table
  counts + conflicts + recomputed close vs the known figure) → commit. Terex
  upload page (`/admin/equipment/import`). Both admin-only, both audited.
- **Migration `20260714_june_backfill`.** Purely additive: two ledger tables
  (`workbook_promotions`, `equipment_history_imports`) + a nullable `import_id`
  column (with a sparse partial index) on each of the seven promotable operational
  tables. Clean-replays on an empty PG16.
- **Blocked on Bill's three files (ADR-0048 D4):** the June Woodland `.xlsm`, the
  Eugene June log, and Janette's Terex spreadsheet. Until supplied, everything
  ships tested against Addendum-B-shaped fixtures. Click-path in
  `docs/operator/june-backfill.md`.

### Ops — 2026-07-06

- **Restore drill PASSED (readiness P1-3 closed).** Latest restic/R2 snapshot restored into a throwaway postgres and verified against prod on five invariants (migration head, entry counts, paid-payroll cents exact). Two DR-procedure gotchas discovered and documented in `docs/operator/restore-drills.md` (R2\_\* env mapping; the postgres init-server race that yields a silent empty restore). Remaining D7 activation gate item: RESTIC_PASSWORD off-box confirmation (operator).

### Added — 2026-07-06 (ADR-0046 — vendor-invoice approval via Graph mailbox ingestion)

- **ADR-0046.** Vision's FIRST inbound-email transport. Accounting mails an
  approval request to `approvals-dr3@svdp.us`; Vision polls the mailbox by
  Microsoft Graph delta, turns each valid message into an approval request,
  Morena/Janette (as data: org-reach approvers) decide inside Vision
  (first-action-wins, atomic), and Vision mails the decision back to a FIXED
  recipient list for Mary's Great Plains filing. Built **mock-first**: it runs
  complete against a fixture-driven transport and flips to live creds with
  configuration only (SVdP IT delivers the mailbox + Graph app + tenant consent +
  ApplicationAccessPolicy — the 8/1 risk is IT lead time, not code).
- **Generic transport `src/lib/msgraph-mail/`** (deliberately NOT AP-scoped —
  Morena's parked dispatch↔Outlook ask consumes it later): a `MailTransport`
  interface (`listDelta`/`getMessage`/`listAttachments`/`moveMessage`, typed
  `AuthFailedError`/`GraphContractDriftError`), `graphTransport`
  (client-credentials via `@azure/identity` + plain `fetch` against Graph v1.0 —
  no heavy Graph SDK, `MSGRAPH_MAIL_{TENANT_ID,CLIENT_ID,SECRET,MAILBOX}`,
  `Mail.ReadWrite`), and `mockTransport` (the DEFAULT until creds land). Mode is
  self-reported at startup + in every ledger row; the transport NEVER sends
  (outbound stays `sendSystemEmail`). Delta tokens persist per mailbox+folder
  (`ap_delta_tokens`); a lost token degrades to a full resync, absorbed by
  idempotency.
- **Sanitization (C10.2, non-negotiable):** email HTML is allowlist-sanitized
  with `sanitize-html` AT INGEST into `body_html_sanitized` (raw HTML is never
  stored for render); the queue additionally renders it inside a maximally
  restrictive `<iframe sandbox="">`. Regression test asserts a
  script/onerror/iframe/style-url fixture renders inert.
- **Pipeline (D3):** every polled message reaches exactly one terminal state
  (created/followup/quarantined/duplicate). Sender validation on the
  authenticated envelope sender (forwarder rule, C10.4); full Graph attachment
  taxonomy (fileAttachment → R2 `ap/`; itemAttachment unwrapped one level, deeper
  nesting kept as a visible marker; referenceAttachment recorded, NEVER fetched);
  idempotency on `internet_message_id` UNIQUE; same-conversation follow-ups;
  move-to-Processed hygiene; **quarantine-never-drop** with a Bill page/email
  carrying row id + sender DOMAIN only (no body/attachment/amount — PII-absence
  tested).
- **Approvals (D4):** `/dashboard/ops/ap` queue (org reach — admin or all_sites),
  atomic first-action-wins (`updateMany` count; loser sees "already decided by
  {actor} at {time}"; both attempts audited), optional vendor/amount at decision,
  decision email to the FIXED `ap_decision_recipients` (refuses + pages when the
  list is empty — never the inbound Reply-To), new-request notification to
  approvers, and a pending-AP count line on the ADR-0043 daily digest.
- **Daemon + ops (D5):** thin `scripts/ap-poll-cron.mjs` (10-min tick) →
  loopback-guarded `/api/internal/ap/poll` (+ `public-paths.ts` exemption with a
  mandatory regression test). Profile-gated compose service `ap-poll`
  (`profiles: [ap]`) cloned from `mymrc-scrape`'s shape. Poll-run ledger
  (`ap_poll_runs`) ALWAYS written incl. throw paths; 45-min deadman page.
- **Schema (one additive migration `20260712_ap_approvals`, sorts after
  `20260711_ops_ledger_intake`; clean-replays on empty PG16):** five enums +
  `ap_requests` (org-level, not site-scoped) / `ap_attachments` / `ap_followups` /
  `ap_sender_config` + `ap_sender_entries` (mode `tenant_wide` default |
  `explicit_list`) / `ap_decision_recipients` (seeded EMPTY) / `ap_delta_tokens` /
  `ap_poll_runs`.
- **Dependency:** `sanitize-html` (+ `@types/sanitize-html` dev). Operator doc
  `docs/operator/ap-approvals.md`; `.env.example` gains `MSGRAPH_MAIL_*` +
  `AP_QUARANTINE_EMAIL`.

### Added — 2026-07-05 (ADR-0044 — P4 Terex equipment module)

- **ADR-0044 (P4).** The Terex operational record moves out of a side spreadsheet
  and hallway conversation into Vision: one capture table for
  downtime/maintenance/repair/cost/notes, a derived-throughput trend view, and a
  small site-dashboard tile. Throughput needs NO new capture — it is DERIVED from
  the daily processed-units close (the same number billing bills from). No new
  container, no second entry path.
- **Schema (one additive migration `20260710_equipment_events`, sorts after
  `20260709_alert_recipients`; clean-replays on empty PG16):** the
  `EquipmentEventKind` enum (`downtime`/`maintenance`/`repair`/`cost`/`note`) +
  `equipment_events` (`equipment_code` String default `'terex'`, `event_date`
  @db.Date, `hours_down` Decimal(5,2)?, `cost_cents` Int?, `vendor`, `notes`,
  `source`, audit-actor columns, `voided_at`/`voided_by`). There is **no
  `locked_at`** — events are freely editable and the full history lives in
  `audit_log`; removal is a **soft-void** (never a hard delete, hard rule #6).
  `equipment_code` is a plain string so a second machine is a data value, never a
  migration.
- **Service (`src/lib/equipment/service.ts`, TDD):** `create`/`list`/`update` +
  `void` (soft, audited, idempotent) — no delete. Site-scoped; every write emits an
  `audit_log` row. Validation: `hours_down` only meaningful for
  downtime/maintenance/repair (rejected on cost/note), `cost_cents >= 0`.
- **Derived throughput (`src/lib/equipment/throughput.ts`, pure builders + one
  aggregator, TDD):** units/day (`stripped_program + stripped_non_program`),
  units/run-hour where downtime hours exist (`assumed_day_hours − hours_down`, the
  8h assumption a labeled module constant — not a config table), 7/30-day rolling
  means (null days skipped, never counted as zero), monthly cost series, downtime
  bands, and the `pocketcoil_estimate` overlay series. Downtime hours for the
  run-hour denominator + red bands use `kind=downtime` only (planned
  maintenance/repair hours are captured but not folded in — documented decision).
- **Tile (`src/lib/equipment/tile.ts`, TDD):** last event + 7-day units/day mean,
  site-scoped.
- **Routes (`/api/manager/[site]/equipment` + `[id]`):** manager-scoped
  (`requireManagerForSite` — NOT the ADR-0037 D7 activation gate). GET lists events
  or (`?view=throughput`) the derived series; POST creates; PATCH edits; DELETE
  soft-voids.
- **UI (`/dashboard/[site]/equipment`):** English-first office surface, green/black
  palette, `onClick` handlers (no `<form>`, hard rule #10). Trend chart (units/day
  bars + 7-day mean line + red downtime bands + pocketcoil overlay), monthly-cost
  bars, CSV export, and an event entry row + audited log with soft-void. Plus the
  launcher **Equipment** tile (manager+) and the site-dashboard tile.
- **Docs:** operator guide `docs/operator/equipment.md`; ADR-0044 post-acceptance
  implementation notes.

### Added — 2026-07-05 (ADR-0045 — P5 ops ledger + Updates digest + contact routing)

- **ADR-0045 (P5).** Three of Kelsey's residual functions become thin, audited
  surfaces over existing machinery (no new pipeline, no new container): a
  meeting-notes + task-follow-up ledger, a Vision-drafted / human-sent DR3 Updates
  digest + board pack, and website contact-form routing. Everything human-sent stays
  human-sent — Vision never impersonates Morena/Bethany.
- **Schema (one additive migration `20260711_ops_ledger_intake`, sorts after
  `20260709_alert_recipients` and the parallel ADR-0044 `20260710_`; clean-replays on
  empty PG16):** four enums (`OpsTaskStatus`, `OpsTaskSource`, `UpdateDigestStatus`,
  `UpdateDigestKind`) + five tables — `ops_notes`, `ops_tasks` (source
  manual/meeting/contact_form, `note_id` FK), `update_digests` (draft/finalized, no
  send column), `contact_intakes` (visitor-PII columns), `contact_routes` (seeded
  idempotently in-migration: `tour*` → rick.albritton@, `*` → morena.gomez@). Sibling
  FK columns (`site_id`, audit-actor cols) are bare DB-level constraints per the
  ADR-0040/0041/0042 precedent; the two intra-block relations (`ops_tasks.note`,
  `contact_intakes.task`) carry Prisma relations.
- **Ledger (`src/lib/ops/`, TDD):** notes + tasks services with hard-rule-#2 reach
  (site rows site-scoped; `site_id = NULL` rows org-wide, admin/all_sites only),
  the meeting → action-items motion (one note + N tasks in one transaction), audited
  status transitions, and `dueSummaryForSite` (overdue / due-today). Dashboard tile
  - `/dashboard/[site]/ops` surface (notes list/editor, task queue with filters). The
    ADR-0043 daily digest gains a second **Follow-ups due** section and now sends when
    findings OR due tasks exist (a quiet day still sends nothing).
- **Updates digest + board pack (`src/lib/ops/update-digest.ts`, D2):** weekly draft
  on the Monday tick + board pack on the 2nd-Wednesday-and-preceding-Monday cadence
  (`digest-calendar.ts`, pure, TDD incl. month/year edges), composed from
  closes/movement/open-findings/completed-tasks and equipment events via an injected
  provider with a documented **absent-table fallback** (ADR-0044 equipment table not
  in this worktree — see MERGE-WIRING note). Review surface `/dashboard/ops/digests`
  (admin/all_sites): markdown edit, audited finalize, copy-ready HTML + copy button.
  The module has **no mail path** (a test scans the source and fails on any send).
- **Contact intake (`src/lib/intake/`, D3):** `POST /api/intake/contact` — public,
  fail-closed shared-secret (`x-intake-token`, absent env → 503), honeypot, in-memory
  per-IP rate limit, zod validation; routes via `contact_routes` (first active match,
  `*`-suffix glob) → creates an `ops_task` + `sendSystemEmail` to the routed address.
  PII discipline: name/email/phone never logged (row ids only; log-absence test).
  Middleware exemption `/api/intake/` + `public-paths.test.ts` case. `.env.example`
  gains `INTAKE_TOKEN`.
- **Docs:** operator runbook `docs/operator/ops-ledger-and-intake.md` (incl. the WP
  form wiring), ADR-0045 post-acceptance notes.

### Added — 2026-07-04 (ADR-0043 — P3 rate alerts + missing-record detection)

- **ADR-0043 (P3, first post-P2).** Early warning before MRC computes the official
  numbers: recycling/recovery rates and missing daily records become four new check
  codes on the existing ADR-0039 audit engine (same nightly sweep, same findings
  lifecycle, same `audit_check_config` thresholds, same review surface) — plus two
  dashboard rate tiles and one daily digest email. No new pipeline, no new container.
- **Schema (one additive migration `20260709_alert_recipients`, sorts after
  `20260708_cor_certificates`; clean-replays on empty PG16):** four `AuditCheckCode`
  enum values (`r1_recycling_rate`, `r2_recovery_rate`, `m1_missing_close`,
  `m2_missing_snapshot`) + `alert_recipients` (digest roster, `active` toggle,
  admin-editable) + `alert_digest_logs` (the `(site, digest_date)` idempotency
  ledger). Recipients seeded idempotently: Morena + Janette → Woodland, Rick →
  Eugene (emails from `prisma/seed/users.csv`).
- **Rate computations (`src/lib/rates/`, pure, TDD):** `recyclingRate` (by weight —
  non-`trash` outbound ÷ total; `trash` counted DISPOSED conservatively pending
  Addendum B10-5, so the alert fires early, never late; landfilled units × the
  55-lb `unit_weight_estimate` carry an `estimated` marker) and `recoveryRate` (by
  units, renovation whole-units credited). Both return
  `{ rate, numerator, denominator, components, estimatedInputs }`; a zero
  denominator yields a typed no-data result — never `NaN`, never a throw-through.
- **Four checks (`src/lib/audit/comparators/`, registered exactly like C1–C7):**
  R1/R2 grade the rolling ~9-month rate against `floor + margin` (CA 75 / OR 70,
  warn +3 pts · high +1 pt — all data in `audit_check_config`), window-normalized
  so a persisting low rate UPDATEs one finding instead of duplicating. M1 flags a
  business day (site-calendar-aware via `site_holidays` + weekend logic) with
  inbound activity but no daily close past a 1-business-day grace; M2 flags no
  physical snapshot within 35 days. R-findings link any concurrent open M-finding
  ids into their detail (explain-don't-flag: a low rate over a data gap is likely
  data, not operational).
- **Dashboard (`/dashboard/[site]`):** two site-scoped rate tiles — current rolling
  rate vs floor, trend arrow vs the prior equal-length window, an `estimated` badge
  when the 55-lb estimate contributed; the whole tile links into the site audit
  queue filtered to the R-check.
- **Digest (`src/lib/audit/alert-digest.ts`):** rides the existing daily-report
  cron tick (the internal route runs it after the production-report send) — one
  SVdP-shell email per site per day, ONLY when open R/M findings exist, to the
  `alert_recipients` roster via `sendSystemEmail` from `dr3-vision@svdp.us`,
  idempotent through `alert_digest_logs`. A total delivery failure pages
  `dr3-vision-system` (fingerprint `alert-digest-failed:<site>`, 6-h cooldown); a
  healthy send is silent; ntfy is otherwise untouched (hard rule #5).
- **Operator doc:** `docs/operator/rate-alerts.md` (editing thresholds via
  `audit_check_config`, editing recipients, what the tiles mean, the estimate
  caveat).
- **Deviation from the ADR (documented):** the digest rides the existing daily-report
  tick, which fires at each site's `send_time_pt` (18:00 PT today), not the 07:00 PT
  the ADR assumed — there is no separate 07:00 tick and the ADR mandates no new
  container. The dedup ledger keeps it to one email per site per day regardless.

### Added — 2026-07-04 (ADR-0042 — COR generator: Exhibit 5 pre-fill + human-signs-always boundary)

- **ADR-0042 COR generator (P2, third of three).** Generates the monthly CA
  Certificate of Recycling, Employment and Inventory (Exhibit 5) with every number
  pre-filled from provable Vision data — a human reviews, enters the FT/PT split,
  and **signs the printed copy** (Vision never auto-certifies; the rendered
  signature block is empty). CA-only: an Oregon site gets a typed error / 404 (no
  Exhibit 5 exists there).
- **Schema (one additive migration `20260708_cor_certificates`, sorts after
  ADR-0041's `20260707_…`; clean-replays on empty PG16):** `cor_certificates`
  (immutable-versioned artifact with a `supersedes_id` chain — draft regenerates
  freely, finalized is immutable, corrections are new versions) + `cor_site_config`
  (site-scoped signer) + enum `CorStatus`. `site_id` FKs are DB-level (migration),
  keeping the ADR block self-contained (no back-relation on `Site`), mirroring
  ADR-0040/0041.
- **Service (`src/lib/cor/`, TDD):** `prefill.ts` pre-fills the three numbers with
  provenance — inventory = the ONE pool-aware running balance (ADR-0037 D6) as of
  month-end + anchor-snapshot ref + reconcile delta (`inventory_source`); headcount
  = the month-end daily-close totals + the full month series (`headcount_source`),
  the FT/PT split entered by the preparer at review with the pre-fill retained.
  `lifecycle.ts` finalize / supersede / void mirror the ADR-0041 immutability
  discipline (manager-of-site or admin; audited). A **pre-render reconcile tripwire**
  (ADR-0033 style) recomputes inventory via the one balance function and refuses on
  mismatch with both numbers, in both finalize and PDF render.
- **Render (D3):** internal loopback-guarded print route `/internal/cor-pdf/[id]`
  (added to the middleware public-paths allowlist + its regression test — the
  mandatory ADR-0036 lesson) rendered to PDF via the bonus-PDF Playwright pipeline
  FROM the stored row, stored to R2 under `cor/`. The **signature block renders
  EMPTY** — Rick prints, signs, submits.
- **UI (D4):** `/dashboard/[site]/cor` (CA-only; hidden/404 for OR) — month picker,
  the three numbers with drill-down (inventory → balance ledger + snapshot;
  headcount → the daily-close series), FT/PT entry, display-only capacity banner,
  version diff, penalty-of-perjury finalize confirmation, print-and-sign download.
- **Observability (D5):** generation / finalize / supersede / reconcile-refusal log
  with certificate id / month / site / actor; typed errors carry the numbers. No PII.
- **June acceptance fixture (§7-b):** `prefill.test.ts` reproduces the Woodland June
  2026 inventory of **4,062** from the balance function's own semantics.
- **Config choice (D2.3):** signer implemented as a simple site-scoped `cor_site_config`
  row (Rick Albritton / "Transportation Manager"); the title is flagged **TBC with
  MRC** (`docs/QUESTIONS.md` Q-5) — a one-row edit to confirm, never a code change.

### Added — 2026-07-04 (ADR-0041 capture half — collection events, OR counts, DR3# sequences)

- **ADR-0041 capture half (P2; the invoice-engine half ships separately).** Closes the
  two capture gaps the invoice math needs — collection events and the DR3#
  document-number sequence — plus Oregon collection-site counts. **Schema (one
  additive migration `20260706b_events_and_sequences`, sorts after ADR-0040's
  `20260706_…` and before the engine half's `20260707…`; clean-replays on empty
  PG16):** three new tables — `collection_events` (daily-log Events tab: freight,
  driver/labor hours + wages, mileage, per diem, misc — money in cents, dates
  `@db.Date`), `or_collection_site_counts` (Oregon monthly per-location unit counts),
  `document_sequences` (per-`(site, sequence_code)` atomic counter) — plus a nullable
  `inbound_loads.dr3_number` column. FK constraints are DB-level (migration) so the
  capture block stays self-contained (no back-relation fields on the sibling-touched
  `Site` model), mirroring ADR-0040.
- **Collection events (`src/lib/events/service.ts`, TDD):** create / list /
  update-before-lock. **Wages are stored as entered**; the B5 rules (`driver_hourly`,
  `general_labor_hourly`, `per_diem_nightly`, via the ADR-0037 program-rule resolver)
  only DEFAULT blank wages from `hours × rate` — deviation is derivable, never flagged;
  a missing rule leaves the wage null rather than blocking capture. **Mileage is
  captured twice:** `mileage` (informational miles) + `mileage_cents` (the billed
  dollars that feed the §3.1 B8 event total); freight is a distinct B8 term.
  `EventCostRow` (`src/lib/events/types.ts`) + `eventMiscCents` are the cross-agent
  seam the invoice engine codes against.
- **Oregon collection-site counts (`src/lib/events/or-counts.ts`, TDD):** Eugene-scoped
  create / list / update-before-lock; a non-Oregon site is refused with a typed
  `JurisdictionNotAllowedError`. The $2.25/unit rate stays in `state_program_rules`;
  no invoice math here (the engine half consumes at merge).
- **DR3# issuance (`src/lib/events/sequences.ts`, TDD + real-DB concurrency proof):**
  `issueDocumentNumber` hands out a per-site number via a single atomic
  `UPDATE … RETURNING` (row-lock serialized; a 64-way concurrent test against Postgres
  yields 64 unique contiguous numbers). Woodland-style (CA) inbound loads get a
  Vision-assigned DR3# at the office **verify** step (inside the verify transaction,
  so a failed verify rolls the counter back); Eugene (OR) gets none; **Material # is
  MyMRC-owned and never issued by Vision**. Trigger is `jurisdiction == california`
  with a `TODO(B10-6)` to become a per-site config flag.
- **Manager surfaces:** `/api/manager/[site]/events` (+ `[id]`) and
  `/api/manager/[site]/or-counts` (+ `[id]`), and two new tabs (**Collection events**,
  **OR collection counts**) on the loads/inventory page — admin-only behind the same
  ADR-0037 D7 activation gate.
- **Seed:** Woodland `dr3_number` counter seeded at a **safe-high `5000`** (> the June
  daily-log ceiling 4805). **⚠ Operator action before go-live: align `next_value` to
  the real current counter** (runbook: `docs/operator/events-and-sequences.md`).
  Eugene gets no counter.

### Added — 2026-07-04 (ADR-0041 — invoice generation, engine half)

- **Invoice engine (ADR-0041, P2; second of 0040/0041/0042).** Vision now generates
  what Rick assembles by hand from several spreadsheets — the six-invoice set with
  line-level provenance, immutable-once-approved versioning, Rick's approval gate, and
  the Great-Plains export boundary. Every number on an invoice is a query result with
  a `rate_ref` + `source` provenance trail (Rick's typo class, survey Q8, dies at the
  root). **Schema (one additive migration `20260707_invoice_generation`, clean-replays
  on empty PG16):** two new tables — `invoices` (six-kind enum with NO
  `or_processing_mid_month` by construction; `billing_month @db.Date`; `version` +
  `supersedes_id` self-chain; `status draft|approved|void`; `total_cents` DERIVED but
  stored for query efficiency with a service-layer Σ-lines invariant enforced on every
  write and re-asserted at approval) and `invoice_lines` (`line_code`, `quantity`,
  `rate_ref` jsonb, `amount_cents` incl. negatives, `source` jsonb, `position`).
  Site-FK is a bare DB-level constraint (self-contained block, mirrors ADR-0040).
- **Math (§3.1 verbatim, pure + TDD).** `generate.ts` composers: B6 processing
  (stripped_program × effective `processing_rate`), B7 incentives, B8 event misc
  (via the `EventCostRow` interface — INTEGRATION-PENDING on the sibling's
  `collection_events`), B15 = B6+B7+B8, B20 mid-month (1st–15th inclusive, Pacific
  calendar), B22 = B15 − B20 rendered as an explicit NEGATIVE offset line (the
  "$118,239 trade discount" artifact becomes an honest subtraction). B16
  transportation = per-load `resolveFreightCents` (ADR-0040, per-load ref in source)
  - event freight + fuel surcharge (`fuel.ts`, CA-only, missing-week = typed error)
  - Σ active `container_rental_sites`. OR: EOM-only, transportation with NO fuel line
    (structural guard, tested), collection-site count = manual lines (`source.manual`).
    Zero-guard: a 0¢ processing charge on nonzero units → typed `InvoiceZeroError`.
- **Trust gate + lifecycle.** Approval enforces the ADR-0039 `gateForWindow`
  (refuse-with-finding-codes; super-admin override with audited justification),
  the `can_manage_rates`-is-NOT-sufficient approver rule (manager-of-site or admin),
  and immutability (approved rows never mutate — corrections are a superseding new
  version). Draft regenerate voids the prior draft and takes the next version.
- **Renders + surfaces.** xlsx Summary (exceljs, processing + transportation kinds;
  commodity blocks excluded per D5) + neutral `invoice_export` JSON (frozen v1
  contract) as the GP boundary. Routes `/api/manager/[site]/invoices` (list/generate)
  - `/[id]` (detail w/ inline gate findings + prior-version diff) +
    `/[id]/{approve,void,supersede,export}`. Manager UI at
    `/dashboard/[site]/invoices` (list/generate + line drill-down to source rows,
    approve-with-confirmation). D6 structured logging on every path; no PII in lines
    or logs.
- **INTEGRATION-PENDING (wired at merge with the CAPTURE half):** the events (B8 /
  event-freight) leg — `event-leg.INTEGRATION-PENDING.ts` (ts-nocheck, excluded from
  tsc/eslint/vitest) maps `collection_events` → `EventCostRow`; until wired,
  generation prices events at 0¢ with `source.pending = 'events-integration'` (never
  silently absent).

### Added — 2026-07-03 (ADR-0040 — billing rate infrastructure)

- **Billing rate infrastructure (ADR-0040, P2; first of 0040/0041/0042).** Puts every
  rate the invoice layer needs that isn't already in `state_program_rules` into
  effective-dated tables so ADR-0041 invoicing becomes pure computation. **Schema
  (one additive migration `20260706_billing_rate_infrastructure`, clean-replays on
  empty PG16):** four new tables — `transport_rate_tiers` (freight ZONE table,
  jurisdiction `CA|OR`, mileage band → flat `rate_cents`, effective-dated),
  `account_haul_rates` (per-account freight override, FK→sources, effective-dated),
  `container_rental_sites` (monthly trailer rentals, FK→sites/sources, `active`,
  effective-dated), `fuel_prices` (`week_of @db.Date UNIQUE`, `usd_per_gal
Decimal(5,3)`, source `eia_api|manual`, `fetched_at`) — plus `users.can_manage_rates`
  (scoped rate-write flag). FK constraints are created at the DB level (migration) so
  the ADR-0040 schema block stays self-contained (no back-relation fields on the
  sibling-owned `Source`/`Site` models).
- **Seeds:** the CA freight zone table (7 tiers, effective 2026-01-01) is seeded;
  `account_haul_rates` and `container_rental_sites` seed **empty by design** (Rick
  populates from the workbook after confirming current values — seeding contested
  numbers would launder a discrepancy into "truth"); **no OR tiers** are seeded (the
  freight resolver returns a typed error for OR until they exist).
- **Money-path libraries (`src/lib/billing-rates/`, all TDD):** `tier-validation.ts`
  (a proposed tier set must be contiguous-from-0, non-overlapping, no gaps — typed
  problems name the offending rows); `freight-resolver.ts` (`resolveFreightCents` —
  account override → tier by `Source.canonical_mileage` → typed
  `FreightUnresolvableError`, with provenance ref for the retro-audit; never a silent
  $0); `fuel.ts` (Monday-of-week normalization, `price > $5.05` trigger predicate,
  `(price/mpg)×miles` surcharge, typed `MissingFuelPriceError`; OR guarded by the
  existing `RuleStructurallyDisallowedError`); `eia.ts` (EIA API **v2**
  `petroleum/pri/gnd` weekly West-Coast PADD-5 ULSD fetch; **fail-open** — absent
  `EIA_API_KEY` never crashes).
- **Weekly fuel fetch:** `scripts/fuel-price-cron.mjs` (thin Pacific daemon, Tue 06:00
  PT) → internal route `/api/internal/billing/fuel-fetch` (loopback-guarded; **added
  to `public-paths.ts` + its test on day one** per the ADR-0036 lesson) → upserts
  `fuel_prices` (manual entries never overwritten; a fetch failure pages
  `dr3-vision-system` fingerprint `fuel-fetch-failed`, success silent). New compose
  service `fuel-price-fetch`; `EIA_API_KEY` wired fail-open in `app` env +
  `.env.example`.
- **Scoped rate-write access (D5):** `users.can_manage_rates` grants writes to the four
  rate tables ONLY (never any admin power — enforced by construction:
  `requireAdmin` checks role, the flag is never in the session and is read fresh from
  the DB in `requireRateManager`). Grantable from `/admin/users` (mirrors the
  `all_sites` toggle, manager-only). Admin rate-table CRUD under
  `/api/admin/billing-rates/*` (write = admin|can_manage_rates, read = manager+); every
  write emits an audit row + structured log (actor, table, before→after).
- **Variance report (D6):** `/dashboard/billing-variance` + CSV export
  (`/api/manager/billing-rates/variance?format=csv`) — per trans-charge source,
  tier-now vs tier-last-billed, per-haul delta, monthly leakage. Last-billed history
  reads through a provider seam; until the ADR-0039 audit-engine workbook staging
  lands the report shows an honest empty state (tier-now only) with a TODO banner.

### Added — 2026-07-03

- **Loads & inventory foundations (ADR-0037, P1 groundwork; reconciled to mission
  Addendum B).** Takes the loads/inventory/commodity layer from built-but-dormant
  toward production, CA-first, in the **Addendum B** shape (operator-directed,
  2026-07-03; docs/QUESTIONS.md Q-4 ANSWERED). **Schema (one additive migration
  `20260703b_loads_inventory_foundations`, clean-replays on empty PG16):** five new
  tables — `state_program_rules` (effective-dated rate/rule table; rates are DATA,
  never code), `consumer_dropoffs` (CA CIP drop-offs, with a
  `kind` incentive|unpaid|illegal), `outbound_materials` (commodity × sub-category —
  renovation folds the old renovator channel in), `landfilled_units`,
  `processed_units_daily` (the daily close) — plus a `source_aliases` table and
  `sources` flags (`is_non_program`, `is_trans_charge`, `canonical_mileage`),
  `inbound_loads` extensions (`retrac_id` indexed, `slip_number`, `transport_charged`,
  `freight_cents`, `fuel_surcharge_cents`, `program_unit_count`,
  `non_program_unit_count`), `site_inventory_snapshots` extensions (`snapshot_kind`
  physical|computed, `reconciled_delta`, `source`), and `LoadSourceType` + `event`.
  `outbound_materials.commodity` is the **daily-log 9** (`trash, toppers, foam, metal,
wood, cardboard, plastic, shoddy, cotton`), with `sub_category`
  (renovation|baled|shredded) + nullable `whole_units`/`program_units`/
  `non_program_units` on renovation rows. `processed_units_daily` carries
  `stripped_program`/`stripped_non_program`, `saved_units` (captured, EXCLUDED from
  inventory math — B10-2 open), and daily-close metadata (`material_ticket_number`,
  `employees_count`, `processors_count`, `pocketcoil_estimate`). All ids TEXT; money
  integer cents; unit counts Decimal(7,1). Idempotent `state_program_rules` seed
  (Addendum B5): CA processing effective-dated 2025=1600¢/2026=1650¢/2027=1700¢, OR
  processing 1700¢, OR satellite 225¢, CA collector_incentive 300¢ cap 5/day, CA
  fuel_surcharge formula-driven with a $5.05/gal trigger — **never seeded for
  Oregon** — plus CA driver_hourly 12500¢, general_labor_hourly 9000¢,
  per_diem_nightly 27500¢, and `unit_weight_estimate` {lbs:55, estimate_only} both
  sites. No mattress/foundation categories anywhere; no DR3#/Material# sequence
  issuance yet (B10-6 open).
  **Libs (TDD):** `program-rules/resolver.ts` — strict effective-date resolver; OR
  fuel surcharge structurally disallowed at BOTH layers (never seeded AND the
  resolver throws `RuleStructurallyDisallowedError`, reading site jurisdiction, not
  hardcoding ids); fuel computation refuses (typed error).
  `dropoffs/incentive.ts` — pure per-person-per-day cap function (cap on UNITS paid;
  incentive kind only). `inventory/running-balance.ts` — the ONE shared pool-aware
  balance `End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled`
  (WholeUnitsSold reads renovation-sub-category outbound; baled/shredded never
  subtract; saved excluded) + `reconcilePhysicalCount` (records
  `reconciled_delta = physical − computed` with an audit row). `loads/verify-gate.ts`
  — server-side enforcement that a load cannot reach `verified` unless
  `program + non_program == total_units`, with the DEFAULT split derived from the
  load's source `is_non_program` flag (manager override wins, B7).
  `loads/processed-units.ts` — daily close derives whole-units-sold + landfilled
  from the day's renovation outbound + landfilled rows for confirmation (never
  entered twice). **Surfaces:** super-admin `/admin/processed-units` daily close
  (stripped split + saved + close metadata; close writes audit; post-close edits
  blocked → amendment path); admin-gated manager `/dashboard/<site>/loads-inventory`
  CRUD-lite for drop-offs / outbound (commodity × sub-category) / landfilled + a
  running-balance readout; all site-scoped, `onClick` handlers (no `<form>`), audit
  row in the same transaction as every mutation. Drop-off `person_name` is CIP PII
  (Exhibit I / ADR-0010) — kept off every export. New surfaces linked from the
  dashboard tile matrix but **admin-only for now** (ADR-0037 D7 activation gate — the
  manager audience opens once the restore-drill + off-box-backup ops gates close).
  **Investigation findings (1a/1b):** (1a) there was **no** verify action on `main`
  at all — `submitted → verified` existed only in the load-service state table with
  no implementation, so the new columns are the persistence and this build adds the
  gate; (1b) `processed_units_daily` is a NEW site-level billing record, distinct
  from the ADR-0030 daily production total (a query over `bonus_daily_entries` +
  adjustments) — it does not duplicate the payroll tables and does not touch payroll.
  **Reconciled to Addendum B** (PR #47, workbook reverse-engineering): dropped
  `renovator_shipments` (folded into `outbound_materials.sub_category = renovation`),
  re-based the commodity taxonomy to the daily-log 9, added `sub_category` +
  whole-unit pool columns, `consumer_dropoffs.kind`, `LoadSourceType` + `event`,
  site-driven program-ness (`sources` flags + `source_aliases` + verify-gate
  default), the restructured daily close (stripped + saved + metadata; whole-sold +
  landfilled derived), the `End = Start + Inbound − Stripped − WholeUnitsSold −
Landfilled` balance, and the Addendum B5 rate seeds. Still open per B10: outbound→
  invoice block mapping (B10-5), `saved_units` semantics (B10-2), DR3#/Material#
  sequences (B10-6), CA fuel COMPUTATION (P2). ADR-0037 "Post-acceptance revision —
  Addendum B" itemizes every change vs the accepted text. Operator guide:
  `docs/operator/loads-inventory-foundations.md`. (ADR-0037)
- **MyMRC ingestion rebuild — JSON transport, mirror tables, loud failure (ADR-0038).** The MyMRC feed (0 rows because the old DOM scraper broke silently twice — most recently landing logged-out on a 404 and reporting "ok") is rebuilt on the Salesforce **Aura/JSON** transport. New migration `20260704_mymrc_mirrors` adds four additive tables: `mymrc_hauls_mirror`, `mymrc_processed_mirror`, `mymrc_outbound_mirror` (raw audit-evidence mirrors keyed by Salesforce record id, with `external_*_id` UNIQUE, full `payload` jsonb, and first/last_seen/disappeared/detail_fetched lifecycle) and `mymrc_sync_runs` (per-site-per-feed run ledger, status `ok|auth_failed|contract_drift|error`). New `src/lib/mymrc/`: `portal-client.ts` (the ONLY transport — Playwright login + in-page Aura interception; typed `AuthFailedError`/`PortalContractDriftError`; **hardened `isLoginPage()`** that catches the 404/logged-out shell), `mappers.ts` (JSON record → mirror rows; DST-correct Pacific parse of `Docking_Appointment_Time__c`), `sync.ts` (one run per site per feed: list → mirror upsert with disappeared detection → bounded ≤3 detail pass → run-ledger row ALWAYS, incl. on throw; **zero-anomaly** rule = 0 listed where the last success listed >0 ⇒ error), and `ntfy.ts` (self-contained `dr3-vision-system` pager with per-fingerprint dedup). Hauls also feed `expected_loads` via the existing upsert, now with **source=manual overwrite protection** (operator/manual rows — any non-`H-` id — are never scrape-cancelled). Deadman (no successful run >26h) pages per tick. The old `parser.ts` (HTML) + `scrape.ts` were deleted and replaced by fixture-tested JSON mappers (fixtures captured LIVE 2026-07-03, person names redacted, under `src/lib/mymrc/__fixtures__/`). Transport ladder decided empirically = in-page interception (#2); raw fetch-replay (#1) proven viable but deferred (fwuid-fragile) — see the ADR post-acceptance notes. The `mymrc-scrape` compose service is rebuilt but stays profile-gated (`mymrc`); enabling is an operator action per the new `docs/operator/mymrc-ingestion.md`. A green run with no data is now impossible by construction. (ADR-0038)
- **Survey daily reminders + campaign auto-close (ADR-0036).** For every OPEN survey campaign, a new 09:00 America/Los*Angeles daemon (`scripts/survey-reminder-cron.mjs`) POSTs an internal, loopback-guarded route (`/api/internal/survey/reminder-tick`) that sends **one reminder per day** to each still-unsubmitted invite until it completes, then **auto-closes** the campaign once the last response lands. Reminder copy is tiered on the invite's live state: opened-with-saved-answers ("your progress is saved" → \_Finish your survey*), opened-but-empty (friendly nudge → _Open your survey_), and sent-but-never-opened (original subject + a "resending in case it got buried" line). A 20h DB gate (`survey_invites.last_reminder_at`/`reminder_count`, additive migration `20260703_survey_invite_reminder_tracking`) makes reminders idempotent — a restart or slightly-early fire never double-sends, and a no-op fires cleanly when no campaign is open. Auto-close closes under a system actor (`actor_label: 'system:survey-reminder-cron'`), fires a `dr3-vision-system` ntfy (fingerprint `survey-campaign-autoclosed:<id>`), and does NOT run the export — the admin Export button still works after close. Drafts do not block auto-close; approved/sent/opened invites do. Reminders are unbounded by design (operator directive) — stop them by closing the campaign in the admin UI or `docker stop dr3-vision-survey-reminder`. New compose service `survey-reminder` (no `db.env` — the daemon reads nothing). The invite + three reminder tiers now share one branded email shell. (ADR-0036)

- **3-way audit engine + Audit Workbench + retro-audit (ADR-0039).** The third P1 ADR. Compares three structurally-independent legs — Vision operational data (ADR-0037), MyMRC mirrors (ADR-0038), and billing (P2 / historical workbooks) — via pure comparators, so no leg feeds another. New tables (migration `20260705_audit_engine`, additive, clean-replays standalone): `audit_findings` (fingerprint UNIQUE, status/cause_category enums, lifecycle), `audit_check_config` (per-check tolerance/severity DATA not code — seeded defaults incl. C3 EOD+1 grace and the C4 45-day vendor window), `workbook_imports` + `workbook_import_rows` (retro-audit staging with tab/row/col provenance), and the `audit_runs` ledger. **Comparators C1–C7** (`src/lib/audit/comparators/`) are pure `(window, legA, legB, config) → Finding[]` functions with distinct finding kinds (missing_counterpart / value_mismatch / date_mismatch): C1 inbound, C2 processed, C3 outbound (EOD+1 grace), C4 billing basis, C5 program/non-program conservation (passes Rick Q11's 150P+25NP-legal / 151P-illegal worked example), C6 inventory continuity (Addendum B §B4 equation + the Friday→Monday / DAY6 roll-break class), C7 business-day deadline clocks (3d inbound / 1d processed / 3d outbound-from-EOD, reusing `compliance.addBusinessDays`). **Findings lifecycle**: upsert-by-fingerprint (stable across runs + windows), last_seen refresh, auto-resolve when legs agree, auto-reopen on recurrence, manual acknowledged/resolved/not_an_issue transitions with cause_category + note — every transition audited in the same transaction (append-only, hard rule #6). **Retro-audit**: an admin uploads a historical monthly workbook (`exceljs` added — the repo had no xlsx lib; papaparse is CSV-only); the parser tolerates ≥3 template generations and the Summary-recompute check reproduces the §4.1 sum-range drift — recomputing every Summary figure from the workbook's own detail rows and flagging the rows the template's SUM range clipped (the fuel-rows-71–130 "money already dropped" class, caught by a synthetic fixture). Site names resolve through an alias interface; unresolvable names emit an `unresolved_site` finding, never a dropped row. **Nightly sweep**: thin 02:30 PT daemon (`scripts/audit-sweep-cron.mjs`, `redirect:'manual'`) → internal loopback-guarded route (`/api/internal/audit/sweep`) with the middleware exemption added on day 1 (`/api/internal/audit/` in `src/lib/public-paths.ts` + regression test — the ADR-0036 lesson); it writes a run record and pages `dr3-vision-system` only on sweep failure. New compose service `audit-sweep`. **UI** (`/dashboard/[site]/audit`, site-scoped, English-first office surface): findings queue with check/status/severity filters, per-finding expected/actual JSON + provenance + classify/act controls (onClick, not `<form>`), and a Workbench tab rendering three rollup frames from a typed provider + drill-down wiring points. **Billing trust gate** (`src/lib/audit/billing-gate.ts`): pure `gateForWindow` + audited super-admin override for P2 to consume. **Integration complete (2026-07-03):** the DB-fetch layer (`src/lib/audit/leg-fetchers.ts`, `buildRunChecksForWindow`) maps the merged ADR-0037/0038 Prisma models onto the comparator interfaces and is wired into the sweep, so the nightly sweep and a new **on-demand run** action (`POST /api/audit/<site>/run`, site-scoped manager/admin) audit the LIVE legs. Real sibling shapes forced adjustments: C7's "entered in MyMRC" instant derives from the matched mirror row (no Vision-side submit column exists); C2's program/non-program sub-checks degrade to the total-units comparison (the processed mirror carries no split); the outbound Material-# join is `external_materials_id` (the outbound mirror has no ticket/units columns and uses `shipment_date`); the inbound-load provenance is `manual` with the site name from the `source` relation (no scalar record-source). C5/C6 internal-invariant inputs derive per-day from the operational rows anchored at, and reusing, the ONE shared `computeRunningBalance` (cross-checked in tests); C6 gained an `npStripped` term to model Woodland non-program co-processing (`stripped_non_program`). The Workbench is **live** over the real tables (`dbWorkbenchProvider`) with honest empty-window states; historical workbook site names resolve through the `source_aliases`-backed resolver (canonical `Source.name` first, then the alias table; unresolved → `unresolved_site` finding). The audit `Commodity` type was corrected to the daily-log-9 (Addendum B §B1) to match the merged `OutboundCommodity` enum. (ADR-0039)

### Fixed — 2026-07-03

- **P1 observability & correctness hardening of the just-merged ADR-0037/0038 code
  (operator-directed: "make sure error logging is baked into everything so we can
  diag later easily").** One pass, TDD where behavior changed, all diagnosable now.
  - **Loud, structured logging on every non-2xx.** The `processed_units_daily`
    routes (GET/POST + `[id]/close`) now emit a request-correlated (`x-request-id`
    child logger) `warn`/`error` line — `{op, actor, site, status, reason}` — on
    every rejection incl. `forbidden`/`invalid_input`/`site_not_found`/service
    errors/unexpected 500s. `loadsErrorResponse` (the four manager resource families
    — dropoffs, outbound, landfilled, loads-verify) now logs the mapped error with
    `reason`/`status` (and an `error`-level line before re-throwing an unexpected
    500), threading a `{site, id, op, requestId}` context from every call site.
  - **MyMRC sync run correlation + failure logging (ADR-0038).** Each site+feed run
    mints a `runId` (crypto.randomUUID), prefixes every log line with it, and
    persists it on the `mymrc_sync_runs` row (new nullable `run_id`, additive
    migration `20260704b_sync_run_correlation`, clean-replays on PG16). The
    run-ledger write is now a real try/catch that logs the **error class** + run
    context (never a silent `.catch`); detail-fetch failures log the record's
    business `externalId` alongside the Salesforce record id. `upsertScrapedHauls`
    now logs (warn, once per run) the **deduped unmatched source/transporter NAMES**
    (a missing seed row → null FK) and returns them in `UpsertSummary`, not just
    counts.
  - **Verify-gate never defaults billing attribution blind (ADR-0037 D2).** When an
    inbound load has **no source** and no explicit split is supplied, `verifyLoad`
    now THROWS a typed `VerifyGateError('no_source_for_default')` (422) instead of
    silently crediting the whole load to the program (billed) pool; a source-driven
    default now logs `{loadId, defaulted:true, source flag}`.
  - **Daily-close negative-balance guard (ADR-0037 D6).** Closing a
    `processed_units_daily` day now computes the pool-aware running balance (the ONE
    `onHand`/`computeRunningBalance`) as of end-of-day; if either pool would go
    negative (an upstream inbound gap) it returns a typed 422 with the numbers —
    UNLESS `acknowledgeNegative: true` accompanies the request, in which case the
    close proceeds and the acknowledgment + balances are recorded in the close audit
    row (warn-and-confirm posture).
  - **Effective-dated rate resolution proven unambiguous (ADR-0037 D1).**
    `resolveProgramRule` now fetches all covering rows and throws a typed
    `AmbiguousProgramRuleError` (naming the tied row ids) when two rows share the
    winning `effective_from` — money math never coin-flips a rate. Legitimate
    supersession (distinct `effective_from`) is unaffected.
  - **Dropoff incentive failures fail loud + typed (ADR-0037 D3).** A missing
    `collector_incentive` rule (`NoActiveProgramRuleError`) is logged with
    `{site, date}` before re-throw; recovering prior paid units from a stored
    `incentive_cents` that no longer divides the rate now throws a typed
    `IncentiveComputationError` (500 with `{person, date, incentive_cents}` logged)
    instead of a bare `RangeError`.
  - **Efficiency (N+1 kills, behavior identical).** `listProcessedUnits` replaces
    per-row `deriveDailyOutflow` with two grouped aggregate queries over the date
    range (tests assert list == per-day-derive equivalence); `upsertScrapedHauls`
    replaces the per-haul `expectedLoad.findUnique` with one batched `findMany` +
    live map.
  - **Route-layer pagination clamp.** The manager list surfaces (dropoffs, outbound,
    processed-units) now clamp a client `?limit=` to `[1, 200]`, falling back to the
    default on absurd/non-numeric input, so no request can force an unbounded scan.
  - **Portal list completeness diagnostics (ADR-0038 D4).** The MyMRC Aura getItems
    payload carries no absolute record total (verified against the captured
    fixtures — only `hasMoreData`/`offset`), and `hasMoreData=true` is a NORMAL live
    state for large feeds, so a throwing count-guard would false-page every run;
    instead `extractListView` surfaces the `hasMoreData` window signal and the
    transport WARNs loudly when a list is windowed (disappeared-detection sees only
    that page), while the existing "no getItems action" / error-list-view / settle
    guards stand.
- **Survey reminder-tick was blocked by the auth middleware (ADR-0036 hotfix).** `/api/internal/survey/reminder-tick` was missing from the middleware public-path exemptions (only `/api/internal/bonus/` was listed), so the daemon's first 09:00 PT fire was 307'd to `/login` — and because `fetch` follows redirects by default, the login page's 200 made the tick log **success while sending nothing**. Three-layer fix: (1) the public-path predicate moved to `src/lib/public-paths.ts` (pure, edge-safe) with the `/api/internal/survey/` exemption added and a regression test over the whole exemption list (`src/__tests__/public-paths.test.ts`); (2) the daemon now uses `redirect: 'manual'` and treats any redirect or non-200 as a failure (a login 307 can never masquerade as success again); (3) response bodies in daemon logs are truncated to 300 chars (the failure had dumped a full HTML page). The route's own loopback/cf-connecting-ip + bearer guards are unchanged — the exemption only lets the session-less in-fleet caller reach them, same trust model as the bonus cron routes. After deploy the missed 2026-07-03 tick was re-fired manually (in-network POST), so the outstanding invites still got their day's reminder.
- **Pre-push gate (ADR-0033 / P0-4) no longer blocks deletion-only pushes.** `git push origin --delete <branch>` pushes no code, but the hook still ran the full tsc + payroll-suite gate — which blocked the 2026-07-02 stale-branch sweep on type errors from an unrelated stale generated Prisma client. The hook now reads the ref list git supplies on stdin and skips the gate only when EVERY pushed ref is a deletion (all-zero local sha); a mixed push (deletion + real ref) still gets the full gate. Regression tests in `src/__tests__/pre-push-hook.test.ts` cover deletion-only, empty-ref, mixed, and normal pushes.

### Fixed — Sprint 6

- **Migration ordering: clean-replay invariant (ADR-0035)** — `prisma migrate deploy` replays migrations in lexical directory-name order. On disk, `20260616_amendment_submission_group` sorted _before_ `20260616_amendment_workflow`, so a clean/DR replay ran the `ADD COLUMN submission_group_id` ALTER before the `CREATE TABLE bonus_amendment_requests` it depends on → `P3018 / 42P01 relation … does not exist`. The **live** DB was never affected (it applied them in the correct order: `_amendment_workflow` 2026-06-15 21:51, then `_amendment_submission_group` 2026-06-16 01:39). Renamed the directory to `20260616_amendment_workflow_submission_group` (byte-identical SQL — checksum unchanged), which provably sorts between `_amendment_workflow` and `20260617_daily_production_report`. Clean replay now applies all 16 migrations with `migrate status` up to date. The new `migrations` CI job (clean Postgres 16 replay) is the gate that caught this and now enforces the invariant. **Live ledger reconciliation required before next deploy** — single pure-rename `UPDATE _prisma_migrations SET migration_name='20260616_amendment_workflow_submission_group' WHERE migration_name='20260616_amendment_submission_group';` (1 row; no schema/data change); see ADR-0035 for sequencing.

### Added — Sprint 6

- **Operational intelligence survey system (ADR-0034)** — Vision-native survey for structured intelligence gathering across the DR3 team. New tables `survey_campaigns`, `survey_invites`, `survey_questions`, `survey_responses`. Public token-gated route `/survey/{token}` with no auth (token IS the access). Super-admin route group `/admin/operations/intel` for campaign management with per-invite approval gate and send confirmation interstitial that requires matching `confirmed_recipient_count`. Email send via existing M365 path, extended to support per-campaign sender display name, reply-to, and CC. SVdP-branded email shell matching the daily production report style. Idempotent seed pre-loads the DR3 Intel 2026-06 campaign with all 10 recipient packets (Bethany, Leisha, Shannon, Mary, Rick, Janette, Morena, Kelsey, Juan, Patrick) in draft status. Closing question "What are we missing?" appended to every packet. On campaign close, responses export as markdown to `docs/operations-intel/{slug}/` via the same ClaudeSync handoff mechanism used for sprint work. (#34)

### Fixed / Changed — Sprint 6 (survey launch hardening, 2026-06-23)

- **Public survey form (`/survey/[token]`)** — required-field validation now runs client-side: submitting with unanswered required questions no longer bounces the respondent off a bare server 422; the first gap is scrolled into view, focused, and every gap is outlined in red with an inline "required" note. Submit now opens a confirmation step before locking (irreversible action guard). Accessibility: inputs are associated with their prompt via `aria-labelledby`/`aria-describedby`, required fields carry `aria-required`/`aria-invalid`, radio/checkbox groups use `role="radiogroup"`/`role="group"`, and the save-status line is an `aria-live` region. A select question that reaches a respondent with no configured options now renders a clear empty-state instead of a blank gap (and does not trap the required gate). An `already_submitted` race now refreshes cleanly into the thank-you view.
- **Invite editor** — saving a packet with an empty prompt, or a `single_select`/`multi_select` with zero options, is now blocked client-side with a precise inline message (previously POSTed an invalid packet and surfaced a bare "save failed: 422"). Server error reasons are translated to human text. Added a Label|value hint under select kinds.
- **Campaign detail** — header now shows a status pill and a roster summary (invites / approved / submitted); the Send button explains why it is disabled and a hint guides the operator to approve first; Export/Close actions give typed success/error feedback that auto-clears; busy states are reflected on every action button.
- **Survey input legibility + mobile (post-launch hotfix)** — respondents reported the text they typed was nearly invisible. Cause: the `<input>`/`<textarea>` set no explicit `color`/`background`/`color-scheme`, so a device in dark mode (common on phones) painted the field text with a light system color, and `fontSize:14` triggered iOS zoom-on-focus. Fixed by setting explicit `color:#1a1a1a` (+ `-webkit-text-fill-color` to defeat iOS/autofill light text), `background:#fff`, and `colorScheme:'light'` on both text fields, bumping field text to `16px` (no zoom-on-focus, more legible), and adding a dark base `color` + `colorScheme:'light'` on the page `<main>` so inherited-color text (select-option labels, radios, checkboxes) is also high-contrast on the cream theme regardless of OS dark mode. Input behavior (value/onChange/aria) unchanged — no inputs broken; SurveyForm tests green.
- Added component tests for the survey-form required-gate + select empty-state and for the invite-editor validation guards. Full gate green (tsc, eslint, vitest, next build).
- **Admin survey preview now renders (2026-06-23)** — the invite-preview "Survey page" tab (`InvitePreview.tsx`) embeds the survey in a same-origin `<iframe src="/survey/{token}?preview=1">`, but a global `X-Frame-Options: DENY` in `next.config.js` forbade _all_ framing — including same-origin — so the iframe came up blank ("vision won't connect"). Fixed by adding a more-specific `/survey/:path*` header block that sets `X-Frame-Options: SAMEORIGIN` and appends `frame-ancestors 'self'` to the (otherwise identical) CSP, while every other route keeps the hard `DENY` via a negative-lookahead `source` so the global block never re-emits `DENY` onto the survey route. Verified against the _emitted_ response headers (not config intent) and with a headless same-origin iframe load. Separately, the survey page now SKIPS `markInviteOpened` when `?preview=1` is present, so an admin previewing a sent invite never flips its status to `opened` or stamps `first_opened_at`. New regression test asserts the resolved header blocks (`src/__tests__/next-config-headers.test.ts`).

### 2026-06-23 — Payroll incident resolved + enterprise P0 hardening

Resolved the 2026-06-22→23 Woodland P13 incident: the delivered payroll PDF was
always correct ($2,125.50, verified from R2 bytes); only the internal
`total_payout_cents` field was wrongly $0 (Decimal type bug). **Audited backfill**
0→212550¢ (audit_log row, fresh restic snapshot). Three root causes fixed
(`5192345`, `526f46d`). Four P0 guardrails added (ADR-0033, `6d14406`): payout
reconciliation tripwire, implausible-$0 delivery guard, loud payroll-failure ntfy,
and a pre-push/CI correctness gate. Enterprise-readiness gameplan + buildout
checklist: `docs/handoffs/2026-06-23-current-state-and-buildout-readiness.md`.

### 2026-06-23 — Payroll-correctness guardrails: reconciliation tripwire, zero-payout guard, loud failures, correctness gate (ADR-0033)

Four P0 enterprise-hardening guardrails closing the OUTER RING around the
payroll-critical path, all on top of the Decimal-lock fix below. No payout/period
data touched; no calculator math changed. **NOT deployed** — operator coordinates
deploy after the in-flight signature.

- **P0-1 — Reconciliation tripwire.** New invariant: for a `signed`/`paid` period,
  the recomputed grand total MUST equal the locked `total_payout_cents`. Pure
  logic in `src/lib/bonus/reconcile-payout.ts`; independent recompute + page in
  `src/lib/bonus/reconcile-fetch.ts`. Wired into `generateBonusPdf` (pre-upload)
  and `triggerPayrollDelivery` (pre-mail) so a mismatched PDF can never reach R2 or
  payroll. On mismatch → refuse + URGENT ntfy `payout-reconcile-mismatch:<monthId>`.
  Exact integer equality of the same computation → no false positives by design.
  This is the assertion that would have caught tonight's $0-lock-vs-$2,125.50-PDF
  disagreement.
- **P0-2 — Implausible-(zero)-payout delivery guard.** Predicate: block delivery
  iff `lockedTotalCents === 0` AND `recomputedTotalCents > 0`. A `$0` that AGREES
  with the entries (everyone sub-threshold, e.g. Timothy Elich 24 mattresses) is a
  real `$0` and is ALLOWED; a `$0` that DISAGREES is blocked + URGENT ntfy
  `payout-zero-suspected:<monthId>` for human confirmation.
- **P0-3 — Loud payroll failures.** ntfy pages added to previously log-only paths:
  signer unresolvable / no email (`signer-unresolved`), signature-request mail
  failed (`signer-mail-failed`), PDF generation failed for a signed period
  (`payroll-pdf-failed`), missing `pdf_storage_key` (`payroll-pdf-missing-key`),
  R2 unconfigured (`payroll-r2-unconfigured`), sign-route notify threw
  (`signer-notify-threw`). Per-fingerprint cooldowns. CONFIG-ABSENT (M365 unset)
  stays SILENT and fail-open — the app still boots without M365 (hard rule #5).
- **P0-4 — Correctness gate.** `.husky/pre-push` runs `tsc --noEmit` + the
  bonus/payroll vitest suite, blocking the push on failure, and SKIPS cleanly when
  `node_modules` is absent (the in-container deploy clone can still commit/push).
  `.github/workflows/ci.yml` runs `tsc` + lint + full `vitest run` + `next build`
  on push/PR (targets `ubuntu-latest`; self-hosted runner labels unconfirmed —
  switch `runs-on` if desired). This is the gate the original `total_payout_cents:
number` type-lie would have tripped.

Tests: `reconcile-payout.test.ts` (pure matrix), `reconcile-fetch.test.ts`
(recompute coercion + mismatch pages + zero-guard agree/disagree),
`payroll-delivery.test.ts` (P0-3 pages + pre-send blocking), and additions to
`signature-notifications.test.ts` (P0-3 signer pages, config-absent stays silent).
See `docs/adr/0033-payroll-payout-reconciliation-guards.md`.

### 2026-06-23 — Payroll-correctness fix: sign-time payout lock zeroed by Prisma Decimal

Confirmed payroll-correctness defect. When a bonus pay period reached `signed`,
the sign-time lock in `src/lib/bonus/signatures.ts` (the `if (fullySigned)` block)
passed each entry's `mattress_count` **raw** into `calculateMonthlyBonusCents`.
`mattress_count` is a `Decimal(5,1)` — Prisma returns a `Decimal` object, not a JS
number — and the calculator's `Number.isFinite()` guard rejects a non-number, so
**every entry contributed 0 and the period locked to `total_payout_cents = 0`**.
The on-screen / PDF / CSV paths coerce with `.toNumber()` and computed the correct
figure, which is why the screen showed a real bonus while the locked (and paid)
total was $0. Woodland period `9b3dc951-4c0c-4c2c-b68c-e3e7ac726211` (2026-06-09→22,
99 entries) locked **$0** but should be **$2,125.50 (212550 cents)** — verified by
reproducing the corrected formula against the live entries + active rule.

Why static typing didn't catch it: the `SignatureDb` structural type declared
`bonusDailyEntry.findMany` as returning `{ mattress_count: number }[]` (a type lie),
so `tsc` saw a number and the number-based mock in `signatures.test.ts` never
exercised a real `Decimal`.

**Fixes:**

- **Lock site:** coerce via a new `toCount()` helper before calling the calculator
  (`entries.map((e) => toCount(e.mattress_count))`), mirroring the `.toNumber()`
  coercion the on-screen/PDF/CSV paths already use so the signed total can never
  diverge from the displayed total. `SignatureDb.bonusDailyEntry` retyped to the
  truthful `DecimalLike` (`number | { toNumber(): number }`).
- **Calculator hardening:** `calculateDailyBonusCents` now THROWS `TypeError` on a
  non-`number` `units` (Prisma `Decimal`, numeric string, object) instead of
  silently returning 0 — a payout calc must never silently yield $0 from a type
  error. Existing numeric behavior is unchanged: genuine `NaN` / `Infinity` /
  negative / below-threshold numbers still return 0.
- **Regression tests:** `signatures.test.ts` feeds real `Prisma.Decimal` counts
  through the sign-time lock path and asserts the correct non-zero total (FAILS on
  pre-fix code: locks `+0`); `calculator.test.ts` asserts non-number input throws.

NOT deployed. **No payout / `bonus_pay_periods` data mutated** — the operator
re-triggers the recompute via the amendment flow once this fix ships.

### 2026-06-23 — Payroll-signing incident fixes: signer-notification + PWA stale-shell

Two confirmed defects from the 2026-06-22 payroll-signing incident (contributed
to a missed deadline). NOT yet deployed — held until payroll clears (a deploy
re-triggers the PWA shell swap).

**Defect 1 — signer notification resolved the WRONG signer (signers never emailed).**
`resolveSlotSigner` (`src/lib/bonus/signature-notifications.ts`) resolved the ops
signer by a legacy heuristic (`primary_site_id IS NULL`), which disagreed with the
authoritative `bonus_signature_chains` row used by the sign route and the month
page. Woodland's ops signer (Morena Gomez) has a non-null `primary_site_id`
(Woodland), so the null query returned nobody and she was **never emailed her
signature request** ("no email for the responsible signer; skipping", signer_id
null). Fix: resolve the signer from `getSignatureChain(siteId)` (the same source
`naturalSlotFor` / the month page / `signer-names.ts` use), then load that user by
id. Regression test added (ops signer with a non-null `primary_site_id` must still
be found + emailed). No payout/`bonus_pay_period` data touched.

**Defect 2 — PWA stale-shell stranded signers after a deploy (read-only error).**
`src/app/UpdatePrompt.tsx` (ADR-0027) only detected a waiting SW on `updatefound`
(navigation / ~24h browser cadence), so an open signer tab could keep serving the
stale read-only shell indefinitely. Hardened: poll `registration.update()` every
60s and on tab-visible; **auto-promote** the waiting worker silently when the tab
is hidden (safe — operator not mid-entry), keeping the explicit reload banner only
while the tab is visible. `skipWaiting:false` and the offline-queue caching are
unchanged. See ADR-0027 addendum.

### 2026-06-22 — DB backups + MyMRC portal-redesign login fix

**Backups (NEW — DB previously had NONE):** nightly encrypted Postgres backups to
Cloudflare R2 via restic — `scripts/dr3-pg-backup.sh` + systemd
`dr3-vision-pg-backup.{service,timer}` (03:45 PT, retention 7d/4w/12m/5y, AES-256).
First snapshot verified. RESTIC_PASSWORD (recovery key) → 1Password. See
`docs/operator/backups.md`.

**MyMRC:** MRC redesigned the Salesforce portal; the old scraper silently failed
(logged-out 404 parsed as "0 hauls ok"). Login selectors fixed + verified live, no
MFA (SELECTOR_VERSION 2026-06-22). Data pages moved/expanded (`/s/hauls`,
`/s/processed-materials`, `/s/outbound-materials`); parser rebuild + loads/inventory
ingestion handed off to claude.ai. See `docs/MYMRC-PORTAL-REDESIGN-2026-06-22.md`.

### 2026-06-22 — SVdP ad-hoc mail sender (scripts/send-svdp-mail.sh)

Added `scripts/send-svdp-mail.sh`: sends ad-hoc Vision email **from dr3-vision@svdp.us**
via Microsoft Graph, reusing the running app container Entra credentials, with To + CC
support (the in-app `sendSystemEmail` has no CC field). Vision is the Society of St.
Vincent de Paul — a separate org from BarnardHQ — so Vision correspondence must originate
from an @svdp.us identity; this is the sanctioned channel for one-off reports. Used to
re-deliver the Woodland June 1–8 reconciliation report to morena.gomez@svdp.us
(cc bill.barnard@svdp.us) from the correct org identity.

### 2026-06-20 — Reporting-only production adjustments, decoupled from bonus math (ADR-0032)

**Headline.** Woodland **production totals** (daily-report month-to-date and the annual year-over-year aggregate) now reflect the operator's true paper figures, **without moving any bonus/payout dollar**. The closed pay period 2026-05-26…2026-06-08 stays frozen at `legacy_total_payout_cents = 96475` ($964.75), byte-for-byte. Operator decision 2026-06-19 ("Option B": reporting-only, keep payroll frozen).

**Mechanism.** A new, additive table `bonus_reporting_adjustments` (migration `20260620_bonus_reporting_adjustments`) — one signed unit delta per site per day (`UNIQUE(site_id, entry_date)`, TEXT ids/FKs per convention). Chosen over a "phantom employee" (would leak — bonus paths don't filter `is_active`) and over a `reporting_only` column on `bonus_daily_entries` (would force a filter onto every bonus-dollar query; high blast radius). **No bonus-dollar read path queries this table**, so an adjustment is structurally incapable of reaching payroll math.

**Invariant.** Production-QUANTITY read paths INCLUDE adjustments; every bonus-DOLLAR read path EXCLUDES them. Wired the complete production-quantity set: `sumRangeOrNull` in `daily-report.ts` (covers MTD, prior-month, **and same-day-last-year** YoY); the annual page `totalMattresses` (new `annualAdjustmentUnits` helper in `aggregates.ts`); the annual CSV export (a single `"Reporting adjustment (ADR-0032, production-only)"` provenance row, mattress column carries the delta, bonus column `0.00`). Left untouched: `employeeHistory`, per-employee `annualTotals` rows, `pdf-data.ts`, the bonus-PDF page, and `current-period.ts` standings — all bonus dollars / per-employee.

**Launch-month load.** Five Woodland adjustments — 6/1 −4, 6/2 +13, 6/4 +694, 6/5 +653, 6/8 +451 (net **+1,807**). Reason recorded on each row: _"Launch-month backfill: missing-day production (6/4,6/5,6/8) / paper reconciliation (6/1,6/2); reporting-only, payroll frozen per operator 2026-06-19."_

**Proof (before → after).**

- Frozen closed-period payout `legacy_total_payout_cents`: **96475 → 96475** (unchanged).
- Annual 2026 bonus-dollar total for Woodland: **unchanged** (adjustments never enter it).
- Woodland June MTD through 2026-06-18: **9,067 → 10,874**; per-day 6/1→940, 6/2→695, 6/4→694, 6/5→653, 6/8→451.
- Annual 2026 production-quantity aggregate: **+1,807** (now includes the adjustments).

**Test.** New cases in `daily-report.test.ts` (MTD includes ±adjustments; same-day-last-year non-null on adjustment-only window; bonus-dollar totals invariant under a large adjustment) and `aggregates.test.ts` + `export.route.test.ts` (`annualAdjustmentUnits` year/site scoping; CSV provenance row present/absent/negative; export integration). Suite **928 green**; `tsc` 0; ESLint clean. Migration auto-runs on deploy.

### 2026-06-17 — Hotfix: per-employee history 500 on historical periods (ADR-0031 / ADR-0023)

**Bug.** Opening a processor's history (`/bonus/employee/[id]`) — newly prominent via the ADR-0031 standings drill-in — returned the generic error page ("The error has been reported…"). Root cause from the app log: `NoActiveRuleError: no active processor_bonus_rules row for site …`. `aggregates.ts` (`employeeHistory` / `annualTotals`) resolved each period's rule with the **strict** `resolveActiveRule`, but the ADR-0023 historical import seeded entries back to **Jan 2025** while the `processor_bonus_rules` table only goes back to **2026-01-01** (verified on prod: 27 Woodland periods pre-2026 with 3,092 entries). Any processor with 2025 entries threw and 500'd the whole page. The same class was already fixed for the historical-PDF path in ADR-0023; the aggregate views were missed.

**Fix.** `ruleResolver` now uses `resolveRuleForHistorical` (the ADR-0023 fallback): a pre-rule period resolves to the site's earliest rule instead of throwing; live periods still resolve strictly. One-line behavioral change; also un-breaks the annual aggregate for prior years. (The new current-period standings/banner were never implicated — they resolve only the open period, which always has a rule.)

**Test.** Failing-first regression in `aggregates.test.ts` reproducing the prod `NoActiveRuleError` (rule effective 2026-01-01 + a 2025 period with entries), now green; the rule mock was upgraded to honor `effective_date`/`end_date` so the fallback path is actually exercised. Suite **919 green**; `tsc` 0; ESLint clean; `next build` ok. No migration.

**Status (ADR-0031 set).** All three pieces — live standings + per-employee banner, canonical `Period N · <range>` labels, and this historical-rule hotfix — are shipped to prod (svdp-dev) and **operator-confirmed 2026-06-17** (Bill confirmed the history page loads).

### 2026-06-17 — Current pay-period standings (ADR-0031)

**Headline.** Adds a live, in-progress view of where every processor stands in the **open** bi-weekly pay period — the piece the cross-period history and closed-period reports never surfaced. Fixes the Reports "Per-employee history" card, which linked to the employee **roster manager** (`/bonus/employees`) and showed no bonus data: it now opens **"Current pay period — live standings"** (`/bonus/standings`).

**What you see.** Per active processor for the open period (e.g. _Period 13 · Jun 9–22_): **units so far · days qualified · days short of the minimum · bonus accrued**. "Days short" = a keyed day whose bonus is $0 because units didn't exceed the rule's daily minimum (Woodland: >50/day); `daysQualified + daysShort = days keyed`. Days with no entry count on neither side. The qualifying threshold is read from the effective `processor_bonus_rules` row, never hardcoded.

**Surfaces (the operator's "both").**

- `/bonus/standings` — new `force-dynamic` report: live all-processor table, name-sorted, each row drilling into that processor's full history. Same `tryBonusAccess` gate as the other bonus surfaces; Eugene + Woodland via `?site=`. "No open period" empty state when today falls outside every seeded period.
- `/bonus/employee/[id]` — now leads with a **Current pay period** banner (the four live metrics, marked _in progress_) above the existing YTD + last-12 + history.

**Service layer — `src/lib/bonus/current-period.ts`** (new, isolated, read-only). Resolves the period covering Pacific "today" by the daily grid's date-range contract, then tallies every keyed entry through the shared `calculateDailyBonusCents`, so standings can never diverge from the daily grid or the signed PDF (hard rule #3). `currentPeriodStandings(siteId)` returns all active processors (a processor with no keyed day yet shows at zero, so the full roster is visible); `currentPeriodForEmployee(siteId, employeeId)` is a focused per-employee query (correct for a since-deactivated processor; never loads the roster).

**Reports card.** "Per-employee history" → **"Current pay period — live standings"** pointing at `/bonus/standings`. The roster manager stays reachable from the `/bonus` landing ("Manage Employees"), so nothing is orphaned.

**History-table labels fixed (same ADR).** The cross-period history table on the detail page had labeled periods by calendar month (`monthLabel`, e.g. "June 2026"), a pre-cadence artifact — so two bi-weekly periods in one month rendered **duplicate** labels. Now a shared `src/lib/bonus/period-label.ts` is the single source of truth for the canonical `Period 13 · Jun 9–22, 2026` label, used by the standings table, the current-period banner, and the history table alike. `employeeHistory` emits `label` (full) + `shortLabel` ("Period 13", for the trend bar list); detail-page copy corrected ("Last 12 months" → "Last 12 pay periods", "Monthly totals" → "Per-period totals", "Month" column → "Pay period"). The PDF/email surfaces keep their own labels (separate concern, untouched).

**Gates.** New `current-period.test.ts` (8 cases) + a duplicate-label regression test in `aggregates.test.ts` + updated `BonusReports.test.tsx`. Full suite **918 green** (was 909); `tsc --noEmit` 0; ESLint clean; `next build` ok. No migration (read-only over existing tables).

### 2026-06-17 — Sprint 5: daily production report (ADR-0030)

**Headline.** Replaces Morena Gomez's manual 6 PM Pacific daily processing email for Woodland and adds the same automation for Eugene. Both sites are independently configurable from a Bill-only admin tile (`/admin/production-report`). Recipients, send time, subject template, and skip rules are all editable through the UI; every config change is audit-tracked. Email body includes per-employee mattress count + bonus dollars + total processed + total bonus paid + four comparison lines (same day last year, MTD, prior month same period, percentage delta).

**Migration `20260617_daily_production_report`:** three new tables — `bonus_daily_report_config` (per-site, unique on site_id), `bonus_daily_report_recipients` (child table, unique on (config_id, email)), `bonus_daily_report_log` (per-day idempotency, unique on (site_id, report_date)). Plus a new `is_super_admin` boolean column on `users`, defaulting false, with the seed flipping Bill to true.

**Seed:** Both sites enabled at 18:00 Pacific. Woodland recipients: bill, bethany, morena. Eugene recipients: shannon, bill, bethany, rick. Re-running the seed is idempotent (`ON CONFLICT DO NOTHING` on recipients; `ON CONFLICT DO UPDATE` on config).

**Service layer:**

- `src/lib/bonus/daily-report.ts` — pure aggregation. Per-employee bonus via `calculateDailyBonusCents` against the site's effective `processor_bonus_rules`. Date math handles leap years, year boundaries, and short-month clamping. Comparison totals return `null` on empty windows so Eugene's sparse history renders gracefully.
- `src/lib/bonus/daily-report-config.ts` — config + recipient CRUD with in-transaction audit logging. Email validation app-side (lowercase normalization, regex). Time validation accepts `HH:MM` or `HH:MM:SS`.
- `src/lib/bonus/daily-report-notifications.ts` — subject + HTML body rendering, per-recipient `sendSystemEmail`. Header reads "DR3 - {Site} Automated Production Report" + dated subtitle. Color-codes the pace delta (green up, red down). Conditional sections honor `include_bonus_dollars` and `include_comparisons`. **SVdP-branded** (operator request 2026-06-17): St. Vincent de Paul Society of Lane County palette from `svdp.us` — red `#a3151a` masthead with the white SVdP wordmark, gold `#ffcc69` accent, cream `#f7f3ea` panels. Table-based, inline-styled, ≤600px for Outlook/M365 fidelity. (Deliberately the SVdP parent-org palette, distinct from the DR3 green/black in-app brand.) Default subject tightened to `DR3 Daily Production Report — {site} — {date}`.
- **Math-correctness hardening (correctness audit, 2026-06-17):** floor each `Decimal(5,1)` entry consistently across per-line units, the bonus basis, and every range sum — so `totalToday` always reconciles with MTD and per-line bonus equals the signed payroll PDF (`month-list.ts` floors raw). Collapsed the redundant MTD double-query/`?? totalToday` fallback to a single range read. Masthead title is now `{Site} Daily Production Report` (DR3 led the subject + footer — no longer duplicated). Regression tests added (fractional reconciliation, tier-boundary bonus parity, MTD left boundary, pace-edge). Accepted limitation: month-end "pace vs last month" compares against the clamped prior-month window (informational; absolute totals authoritative).
- `src/app/api/internal/bonus/daily-report/test/route.ts` — loopback+bearer-guarded internal **test-send** (`POST { siteCode, to, date? }`); returns a clean 422 for a back-dated day with no active rule. Renders the production-identical email and sends to one address with a `[TEST]` subject prefix; writes **no** log row, so it never blocks the scheduled fire. Lets an operator preview branding/quality from the host without a browser session.

**Daemon:**

- `scripts/bonus-daily-report.mjs` — long-running thin Pacific scheduler, same shape as `bonus-period-close.mjs`. Imports only `@prisma/client` (no `tsx`, no `.ts` import — the prod image is `npm ci --omit=dev` and `tsx` is a devDependency). Reads each enabled config's `send_time_pt`, sleeps until the soonest next-fire across all sites, then POSTs to the loopback+bearer-guarded internal route `/api/internal/bonus/daily-report`, which runs the tested TS runner `src/lib/bonus/daily-report-runner.ts` (`runDailyReportFire`) inside the Next app — mirroring the `bonus-period-close.mjs` → `/api/internal/bonus/close-months` pattern. The runner fires per site within a 60-second wake window (handles two sites configured for the same time). Idempotency via `bonus_daily_report_log` uniqueness; container restart cannot re-send a delivered report.

**Admin UI:**

- `/admin/production-report` route gated on `session.user.is_super_admin`. Per-site card with enable toggle, send time picker, subject template, recipient chips (add/remove), skip rule checkboxes, include flag checkboxes, Save/Send Test/View Recent buttons.
- "Recent sends" table shows last 30 sends across all sites with delivered_count vs attempted, today's total + bonus, and last Graph HTTP status for diagnostics.

**Auth plumbing:** `is_super_admin` propagated through next-auth `jwt` and `session` callbacks; `next-auth.d.ts` extended.

**docker-compose:** New `bonus-daily-report` service alongside the three existing bonus daemons.

**Operator action on first deploy:**

1. `prisma migrate deploy` applies the additive migration.
2. Seed runs (or run `npx prisma db seed`) to populate both configs and the super-admin flag.
3. `docker compose up -d` starts the new daemon.
4. Bill verifies via `/admin/production-report`; first scheduled fire is the next 18:00 PT.

**Tests:** ≥ 32 new vitest cases — aggregation, date math, comparison nulls, config CRUD with audit assertions, notification rendering with conditional sections, route-level super-admin gating (Bill 200, Kelsey 403).

### 2026-06-17 — Fix: EOD bonus alert now fires only when a site has zero entries (ADR-0019 §2)

Bill was being paged whenever **any** active processor lacked a bonus entry by
the 5:00 PM PT cron — but not every processor has a bonus every day (different
position, day off), so the alert false-fired on normal partial days. The check
now pages only when a bonus-enabled site has **zero** entries for the Pacific
day (nobody logged anything). A partial day never pages.

- `src/lib/bonus/eod-check.ts` — `evaluateEod` now alerts iff `enteredCount === 0`;
  the `all_entered` skip reason becomes `has_entries`; `missingCount` →
  `enteredCount`. The pure decision and its tests are the source of truth.
- `scripts/bonus-eod-check.mjs` — `checkSite` fires only when the site has no
  entries; the ntfy title/body now read "No bonus entries for &lt;site&gt;"
  instead of an N-processors-missing count. Fingerprint (`bonus-entry-missing:…`)
  and dedup behaviour unchanged.
- Weekend / holiday / no-active-employees skips and the fire-once-per-day
  fingerprint guarantee are unchanged.

### 2026-06-16 — Feature: amendment notification batching — one notification per root action (ADR-0029)

ADR-0028 modelled each amended line item as its own request, so a manager
correcting N rows in one save fired N approval emails to the approver, N pushes
to Bill, and would need N approve-clicks + N result emails. A real 16-line
correction sent Morena 16 emails. ADR-0029 groups the requests submitted
together and notifies once per root action (applies the ADR-0037 "deduplicate
against root cause" rule).

- **Schema (`prisma/schema.prisma` + `prisma/migrations/20260616_amendment_submission_group/`):**
  adds a nullable `submission_group_id TEXT` column (+ index) to
  `bonus_amendment_requests`. **TEXT, not UUID** — all ids/FKs in this DB are
  TEXT (the UUID/TEXT mismatch is what broke prod in the ADR-0028 migration).
  The migration is additive + idempotent (`ADD COLUMN IF NOT EXISTS` /
  `CREATE INDEX IF NOT EXISTS`), safe against the existing live-test pending row.
- **Batch submit → ONE notification (`src/lib/bonus/amendment-requests.ts`,
  `src/app/api/bonus/amendments/route.ts`):** the submit endpoint now accepts a
  batch body (shared `bonusPayPeriodId` / `targetEntryDate` / `justification` +
  an `items[]` array) as well as the legacy single-item body. `submitAmendmentBatch`
  creates all N rows in one transaction, stamps the shared `submission_group_id`
  (null for N=1), writes a per-row audit row for every item (hard rule #6), and
  fires exactly one `notifyAmendmentBatchSubmitted` (one approver email, one ntfy
  to Bill).
- **Single batch modal (`src/app/bonus/RequestEditBatchModal.tsx`,
  `DailyEntryGrid.tsx`):** the per-item modal **queue** is replaced by one batch
  modal that lists every pending prior-day change, takes one ≥20-char
  justification, shows who it routes to, and POSTs the whole batch in one request.
  `RequestEditModal.tsx` (the per-item modal) is removed.
- **Batch approve/reject → ONE result notification
  (`AmendmentQueue.tsx`, `[id]/approve`, `[id]/reject`):** the queue groups
  pending requests by `submission_group_id` and offers **Approve all** /
  **Reject all** (reject shares one reason, entered inline — no `window.prompt`).
  `approveAmendmentGroup` / `rejectAmendmentGroup` apply every item (each with its
  own entry write + per-item audit, in one transaction) and fire one
  `notifyAmendmentBatchDecided`. All ADR-0028 invariants (four-eyes eligibility,
  requester≠approver, period-still-draft, Patrick carve-out, ping-Bill) hold per
  request. The queue's prior **red** buttons/banner are corrected to DR3
  green/black (hard rule #3).
- **In-app discoverability (`src/app/bonus/page.tsx`):** a "Pending Amendments"
  nav link with a pending-item count, shown only to admins (all-site) and
  managers who are a signature-chain signer at their site (Patrick / non-signers
  never see it).
- **Tests:** batch submit creates N rows + ONE notification + a shared group id;
  N=1 submit is a null-group singleton; batch approve/reject applies all + fires
  ONE result notification; one bad item rolls the batch back; the grid pivots to
  ONE batch modal (not a queue) and POSTs a single `items[]` request.
- **Deployed & verified (2026-06-16, svdp-dev prod):** merged to `main` (PR #28),
  built + deployed; the `migrate` init container applied
  `20260616_amendment_submission_group` (column verified `submission_group_id text
YES`). Typecheck clean, 536/536 tests pass.
  - **Legacy-backlog note (important):** amendment requests created **before** the
    migration carry `submission_group_id = NULL` and — by design — behave as
    singletons, so each fires its own notification. When the first approver cleared
    the ~13-row pre-migration backlog right after rollout it produced one email per
    row. **This is expected, not a regression** — only un-grouped legacy rows do
    it, and the backlog is now drained (0 pending). New multi-line saves get a
    shared group → one email.
  - **Live prod self-test:** a 3-line grouped batch was submitted + approved
    against the production DB (data layer only, no notifications fired), confirming
    one shared `submission_group_id` across all rows and atomic group approval,
    then **fully reverted** with a verified before==after row-count assertion
    across `bonus_amendment_requests` / `bonus_daily_entries` / audit rows (zero
    residue). Confirms one-notification-per-batch holds on real prod data.

### 2026-06-15 — Fix: complete the ADR-0028 amendment client wiring + remove the stale today-only gate

The Sprint 4 amendment workflow (ADR-0028, PR #26) shipped the server side, but
the client glue was missing and a stale gate blocked the feature end-to-end. A
non-admin Woodland manager (Janette) trying to edit a prior day's bonus record
hit `403 "Entries may only be recorded for today"` — the change never reached
the amendment routing.

- **Gate fix (`src/app/api/bonus/entries/route.ts`):** the pre-ADR-0028
  today-only gate (`date !== appToday()` → 403) is replaced with a future-only
  gate. A non-admin may now POST for **today** (direct write) or a **prior day**
  (the data layer routes it through the four-eyes amendment workflow and returns
  `409 requires_amendment`); only a **future** date is rejected `403`. Admins
  keep unconstrained back-dating. The client stays untrusted — all draft/period/
  prior-day scoping is re-enforced in `upsertDailyEntries` →
  `shouldRequireAmendment`; a prior day in a closed period still returns
  `month_locked` (409) and an uncovered day still returns `NoOpenPayPeriodError`
  (409).
- **409 payload carries `approverName`:** the route resolves the counterpart
  signer via the signature chain (`resolveAmendmentApprover`) and looks up the
  user's display name, surfacing it top-level on the `requires_amendment` 409 so
  the modal can show "sent to X for approval". A requester structurally outside
  the workflow (Patrick / non-chain manager) is surfaced as the 403 the
  amendment submit would itself return, rather than dangling an unsubmittable
  modal.
- **Client wiring (`src/app/bonus/DailyEntryGrid.tsx`):** `handleSave` now
  detects the `409 requires_amendment` response and pivots to the previously
  orphaned `RequestEditModal` instead of showing the raw error string. Each
  pending change becomes a modal payload, mapping `bonus_employee_id → full_name`
  from the grid's own rows and old/new values from `pending[i].existing` /
  `.proposed`. Multiple pending changes are handled as a **queue** — one modal at
  a time; submit or cancel advances to the next; the last one drained triggers
  `router.refresh()`. Uses `onClick` (no `<form>`, hard rule #10); brand styling
  preserved.
- **Tests:** route — non-admin prior day → 409 `requires_amendment` with
  `approverName`, non-admin future → 403, admin prior day → direct write; grid —
  a 409 opens the modal with the mapped payload and a multi-pending queue
  advances one modal at a time. Full suite green (830 tests), tsc 0, eslint 0,
  `prisma validate` clean, `next build` succeeds.

This completes ADR-0028's intended flow; no new ADR.

### 2026-06-16 — Fix: amendment-workflow migration used UUID columns against a TEXT-id schema

The Sprint 4 migration `20260616_amendment_workflow` (ADR-0028) declared every
id/FK column as `UUID`, but this database stores all primary keys as `TEXT`
(Prisma `String @default(uuid())` → `text`). On deploy the migration failed at
`bonus_amendment_requests_period_fk` (Postgres 42804: "Key columns
bonus_pay_period_id and id are of incompatible types: uuid and text"), which
(a) blocked the deploy's `migrate deploy` step and (b) left the app container
unable to start. The CI gate (tsc/eslint/vitest/`next build`) never executes the
migration against a real Postgres, so it passed while the migration was broken.
Fix: all id/FK columns in `migration.sql` are now `TEXT` (and the
`gen_random_uuid()` default removed — ids are generated client-side by Prisma,
matching every other table). Recovered on prod by cleaning the partial state +
re-running the corrected migration; the table, both enums, and all existing data
verified intact. The Prisma schema (`String`) was already correct; only the raw
`migration.sql` was wrong.

### 2026-06-16 — Added: prior-day bonus amendment workflow + manager date picker + bi-site EOD check (ADR-0028)

Morena Gomez asked (2026-06-15) what the correct process is to fix a prior day's
bonus entry. There wasn't one. Within a `draft` pay period, a manager could
silently rewrite any prior day; closed periods had no manager path at all. This
sprint defines the answer: a **four-eyes prior-day amendment workflow**.

- **Workflow (Sprint 4):** within the current `draft` period, a non-admin
  manager's change to a prior day's `mattress_count` (an `update`, or an
  `insert` of a missed day) no longer writes directly — it opens a Request Edit
  modal requiring a ≥20-char justification and routes to the signature-chain
  counterpart for approval. Approval applies the entry change, writes the
  entry-audit row (`actor_label='system:amendment-approved'`), marks the request
  `approved`, and links the applied audit id back into the request — all in one
  Prisma transaction. Rejection requires a reason. Bill is notified (ntfy +
  email) on **every** approval and rejection. A requester whose approver is
  unavailable can "Ping Bill" to add the Director as a second eligible approver
  (soft control; the audit log records ping timing for abuse detection).
- **Carve-outs:** same-day corrections, note-only prior-day edits, and admin
  writes stay direct. Patrick Dills (Eugene Lead processor) is excluded from the
  workflow by separation of duties — his prior-day grid is read-only. Closed
  periods stay immutable for managers; Bill keeps the existing audit-labeled
  admin escape valve in `src/lib/bonus/amendment.ts` (unchanged).
- **Concurrency:** a new request from the same requester for the same
  `(target_entry_date, bonus_employee_id)` auto-cancels their prior pending
  request (audit-tracked, `superseded_by_new_request`).
- **Date picker:** the admin-only `AdminDatePicker` is replaced by
  `BonusDatePicker`, visible to all managers and constrained to the current
  draft window (`min=period_start`, `max=today` Pacific); admins remain
  unconstrained. Both the client `min/max` and the server-side `resolveEntryDate`
  enforce the bound. The PR #25 grid date-key remount fix is preserved.
- **Bi-site EOD check:** the 5 PM Pacific missing-entries notification, formerly
  Woodland-only and not wired into the production stack, is now bi-site (iterates
  every site with an active signature chain) and runs as a long-running
  `bonus-eod-check` docker-compose daemon alongside `bonus-period-close` and
  `bonus-escalation-check`. `missingFingerprint(siteCode, dateIso)` and
  `evaluateEod` are now site-scoped so Woodland and Eugene alerts never collide.
- **Migration `20260616_amendment_workflow`** (pure additive): one new table
  (`bonus_amendment_requests`), two enums, five DB-level CHECK constraints
  (requester ≠ approver, justification ≥20, decided rows have a reviewer,
  rejected rows have notes), five indexes.
- New service modules (`amendment-approvers`, `amendment-requests`,
  `amendment-notifications`), five routes
  (`GET/POST /api/bonus/amendments`, `POST .../[id]/(approve|reject|cancel|ping-bill)`),
  three UI components (`BonusDatePicker`, `RequestEditModal`, `AmendmentQueue`)
  and the `/bonus/amendments` queue page. ADR-0028 + operator runbook
  `docs/operator/bonus-amendment-workflow.md` document the design and deploy/verify/rollback.

### 2026-06-15 — Fix: bonus daily-entry grid now repopulates when the admin changes the date

Picking a different business day in the admin date picker left the grid showing
the **previous** day's counts (or blanks) until a manual page reload. Root cause:
`DailyEntryGrid` seeds its input state from `rows` in the `useState` initializer,
which runs once per mount; client-side date navigation (`router.push`) passes new
`rows` but React reuses the same instance, so the seed never re-ran. Fix: a
`key={entryDate}` on the grid in `src/app/bonus/page.tsx` forces a remount on date
change, re-seeding from the new day's rows. Save/`router.refresh()` is unaffected
(same date → same key → no remount, in-progress edits preserved). New
`DailyEntryGrid.test.tsx` (+3) pins the seed-on-mount contract and documents why
the key is required. Suite 762 → 765 green.

### 2026-06-15 — Added: PWA "update available — tap to reload" prompt (ADR-0027)

An installed, always-open PWA never reloads on its own, so after a deploy it
kept serving the **old precached app shell** — whose hashed
`/_next/static/chunks/*.js` references 404 against the new deploy, rendering
blank pages. This once read to the operator as "all my data is gone" (nothing
was lost; the shell was simply stale). DR3-Vision now surfaces an explicit,
user-controlled update prompt so a stale shell can never silently strand anyone.

- **SW change (minimal):** `src/app/sw.ts` flips `skipWaiting: true` →
  `false` so a freshly installed SW parks in the `waiting` state where the page
  can detect it. `clientsClaim` stays `true`; the existing `SKIP_WAITING`
  message handler is retained and now drives the user-initiated promotion. The
  **offline-queue / BackgroundSyncPlugin runtime caching is untouched.**
- **New client component:** `src/app/UpdatePrompt.tsx` watches the SW
  registration (`getRegistration()` + `updatefound`/`statechange`, and checks
  `registration.waiting` on mount), and shows a non-intrusive bottom banner —
  "A new version is available. Reload" — only on a real update (worker
  `installed` **and** a controller already exists), never the first install.
  Tap **Reload** → posts `SKIP_WAITING` to the waiting worker, then reloads
  **once** on `controllerchange` (guarded against reload loops). **Dismiss**
  defers. Never auto-reloads (operators may be mid data-entry). SSR-safe;
  no-ops where service workers are unsupported.
- **Mounted in the root shell** (`src/app/layout.tsx`) so it appears on every
  surface (operator, manager, bonus). The root layout has no `I18nProvider`, so
  the prompt is wrapped in a scoped `I18nProvider` with the operator dictionary
  (smallest correct integration; no collision with route-group providers).
- **i18n:** `update_prompt.{title,body,reload,dismiss}` added to the operator
  namespace in **en/es/ur** (CLAUDE.md #4). Banner uses brand green/cyan on the
  dark space surface (#3) with `onClick` handlers, not `<form>` (#10).
- **Tests:** `src/app/UpdatePrompt.test.tsx` — banner renders the translated
  strings + fires callbacks on tap; the prompt surfaces on a waiting worker,
  posts `SKIP_WAITING`, and reloads exactly once on `controllerchange`.

### 2026-06-15 — Added: Employee # surfaced end-to-end in Manage Employees UI (ADR-0026)

ADR-0026 added the `bonus_employees.employee_number` column + backfill but no UI
or API read or wrote it (`grep employee_number src/` returned nothing). The
"Manage Employees" screen (`/bonus/employees`) now **shows and manages** the
field — closing the gap ADR-0026 flagged ("no UI consumes it yet" + "a future
write path must add the app-level per-site uniqueness check").

- **Display:** each employee row shows `Employee #: <number>` or an italic
  "No Employee #" empty state (most rows have none — only the 21 legacy Woodland
  imports carry one).
- **Create:** the Add-employee row gains an optional "Employee # (optional)"
  input alongside the name.
- **Edit:** a per-row "Edit #" inline editor sets or clears the number
  (clearing = empty input → stored `null`). Uses `onClick` handlers, no `<form>`
  (CLAUDE.md #10).
- **Validation:** `employee_number` stays a `String?`; when present it must match
  `^[0-9]{4}$` (the live prod data format — all 21 rows are exactly 4 digits).
  Per-site uniqueness is enforced at the **app layer** among **active** rows
  (`deleted_at IS NULL`, mirroring the §9a rehire freeing) — no DB constraint,
  per ADR-0026. Duplicate → 409; bad format → 422; both surface inline.
- **Audit:** the new `set_number` PATCH action writes an `update` audit row with
  before/after DTO snapshots in the same transaction, exactly like the §9b
  rename path. The append-only audit log is never mutated destructively
  (CLAUDE.md #6).
- **i18n:** the bonus surface had no `I18nProvider` and shipped English-only
  hardcoded strings. Wired the manager-namespace dictionary into the `/bonus`
  layout (mirroring `/dashboard`) and added a `bonus_employees` namespace to
  `en` / `es` / `ur` (RTL) `manager.json`; the Manage Employees page + component
  are now fully translated (CLAUDE.md #4). Brand stays DR3 green/cyan dark
  surface — no red/navy/gold introduced (#3).

Files: `src/lib/bonus/employees.ts` (DTO + `setEmployeeNumber` +
`normalizeEmployeeNumber` + `findByEmployeeNumber`), the two
`api/bonus/employees` routes, `app/bonus/employees/{page,EmployeeManager}.tsx`,
`app/bonus/layout.tsx`, the three `manager.json` locales, and the two test
files (+21 new cases; `npm test` 755 green, `tsc`/ESLint/`prisma validate`
clean).

### 2026-06-15 — Added: `employee_number` on bonus processors (ADR-0026)

New nullable `bonus_employees.employee_number` column + `(site_id,
employee_number)` index. Migration `20260615_bonus_employee_number` backfills the
21 legacy DR3 Woodland rows whose display name carried a trailing 4-digit employee
number, strips the number out of `full_name`, and records the original name in
`previous_names` (`reason: employee_number_extracted`). Idempotent;
behavior-neutral (no UI consumes the column yet). Per-site uniqueness enforced at
the app layer, not the DB. **Deployed and verified live on prod 2026-06-15** —
migration `20260615_bonus_employee_number` applied at 18:05 UTC (11:05 AM PDT) via
the auto-deploy `migrate deploy` step; post-deploy verification on the live DB:
21/107 rows extracted, 0 names still numbered, 21 distinct numbers, 0 bad formats
(one soft-deleted row included, by design).

### 2026-06-11 — Fix: manager bonus UI shows the SITE's signers (no hardcoded Woodland names)

The manager-facing bonus UI hardcoded the WOODLAND signature-chain names, so a
**Eugene** pay period rendered **Janette Tomas / Morena Gomez** (the Woodland
facility/ops signers) instead of Eugene's **Rick Albritton / Kelsey Ruhland**.
Kelsey — reaching Eugene via the ADR-0024 `all_sites` flag — opened a Eugene
report and saw the wrong signers. Ground truth (who signs which slot at which
site) lives in the `bonus_signature_chains` data; the data layer was already
site-scoped everywhere, and the **bonus-pdf page already resolved names from the
chain correctly** — only these three presentation surfaces
