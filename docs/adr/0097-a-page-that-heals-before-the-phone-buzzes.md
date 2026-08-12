# ADR-0097 — A page that heals before the phone buzzes

**Date:** 2026-08-11 (Pacific)
**Status:** Accepted
**Amends:** ADR-0095 (the ledger recorded the attempt, not the page) — closes the
gap its §3 fix left open
**Implements:** the two gradings ADR-0095 §5 deliberately left to the operator
**Extends:** ADR-0037 (fleet notification noise policy), ADR-0067 D9 (the anomaly ledger)
**Incident:** 2026-08-11 ~10:00 PM PT — _"I'm still getting notifications that
document ingestion is not working and failed to get files. All of that needs to
be working completely and without issue."_

---

## 1. What Bill actually received tonight

ADR-0095 answered the 5:51 PM version of this question. The 10 PM version is a
different question, and it has a different answer, so start with the bytes.

ntfy's server-side cache on BOS-HQ retains seven days. Every DR3-Vision message
it holds for tonight, converted to Pacific:

| PT          | Topic               | Prio    | Title                                          | Verdict                                                                                     |
| ----------- | ------------------- | ------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 4:13 PM     | `dr3-vision-system` | high    | Document ingestion - sweep failed              | Graph 503 on `sharedWithMe`; next sweep clean. **Gate-failing noise.**                      |
| 4:43 PM     | `dr3-vision-system` | default | Document ingestion - discovery gap             | 11 readable, 3 watched. **Real, by design, needs a decision.**                              |
| 4:58 PM     | `dr3-vision-system` | default | Document ingestion - download failed           | Graph 503 on TEREX content; recovered 5:13 PM. **Real, healed in 15 min.**                  |
| 5:13 PM     | `dr3-vision-system` | high    | Document ingestion - aggregate variance        | TEREX 328.40 → 444.50. **Real; the guardrail working.**                                     |
| **7:42 PM** | `dr3-vision-system` | default | Document ingestion - subscription renew failed | **The only one after the ADR-0095 deploy.** Structural Graph limit. **Gate-failing noise.** |

The first four are the ones ADR-0095 already dissected. **Only one page has
arrived since that deploy landed at 7:11 PM PT**, and it is the
`subscription_renew_failed` re-page — precisely the second of the two alerts
ADR-0095 §5 flagged as failing the ADR-0037 gate and deliberately left untuned
pending Bill's call.

So the honest answer to "why am I still getting these" is: **you got one more,
and it is the one we told you we had not fixed yet because it was your call to
make.** There is no new failure. There is no undiagnosed breakage. Nothing in
the ingestion path has regressed since 5:13 PM, and no document is stale.

Worth saying plainly because the container-start pages make the night look
busier than it was: the other DR3 traffic tonight (`dr3-vision-container`,
eleven "Container started" messages) is deploy noise from a very active
evening — PRs #235–#241 — not ingestion.

## 2. The tuning Bill approved, and why the code does not do quite what he asked

Both of ADR-0095 §5's items are now accepted. Neither is implemented as a blunt
mute, because in each case the blunt version would take a real guard with it.

### §1 — `sweep_failed` pages on the SECOND consecutive failure

Measured, not estimated. `doc_ingest_sweep_runs` over the seven days to
2026-08-12 05:31Z:

| status    | runs |
| --------- | ---- |
| `ok`      | 684  |
| `failed`  | 4    |
| `partial` | 1    |

689 runs, a **0.58% failure rate** — and the shape matters more than the rate:
the four failures fell on **08-06, 08-09, 08-10 and 08-11**, days apart. **No two
were consecutive.** Every one self-healed on the next 15-minute run. Two were
Graph 503s on `sharedWithMe`, two were `This operation was aborted` timeouts.

So paging on the first failure bought Bill roughly **one page every other day**,
each describing a condition that was over before his phone buzzed — a textbook
failure of ADR-0037's third gate, _"has the system tried to self-heal first?"_

Under the new grading **all four would have been suppressed and zero pages sent**,
because each one's row was resolved by the following successful sweep before it
could reach occurrence 2. That is the whole intent: the only thing that survives
the filter is a sweep that is still failing fifteen minutes later.

The delay costs one sweep interval and nothing else. The ADR-0057 D9 guard — a
silently dead sweep is the failure this whole subsystem exists to prevent — is
fully preserved: a sweep that is genuinely down still pages `high`, fifteen
minutes later than it used to.

**The consecutiveness was already in the ledger and did not need to be built.** A
successful sweep calls `resolveAnomaly('sweep_failed', 'sweep')`, which closes the
open row. So an open row can only reach `occurrences = 2` via two failures with no
success between them. The implementation is one comparison against a per-kind
`pageAfterOccurrences`, read off the row the raiser already has.

Two consequences worth stating because they are easy to get wrong:

- The threshold is checked **before** the 24-hour re-page window, so the
  suppressed first failure leaves `last_paged_at` NULL. That is what lets the
  second failure page immediately instead of waiting out a day — the exact
  self-suppression trap ADR-0095 §2 was written about.
- Two _isolated_ blips hours apart never page, because the success between them
  resolved the row. That is the intent, not a hole.

### §2 — `subscription_renew_failed` is demoted per-OCCURRENCE, not per-KIND

Bill approved demoting this to a dashboard surface, and the reasoning in
ADR-0095 §5.2 is sound: the code itself documents the condition as a structural
Microsoft Graph limit that must not be "fixed" by granting a broader scope. On
OneDrive for Business a subscription may only be created on a drive **root**;
Vision reaches these documents through item-level shares, so there is no legal
subscription target. Microsoft's 403 is the correct answer to a question we are
not entitled to ask. Under ADR-0037 gate one — actionable within five minutes? —
it is a tile, forever.

**But `subscription_renew_failed` is not only that condition.** The same kind is
raised when an existing subscription fails to _renew_ for any other reason, and
that one is actionable. Silencing the kind wholesale would have bought quiet
tonight and blinded the push path permanently — "how guards quietly stop
guarding", in ADR-0095's own words.

So the demotion is attached to the occurrence, at the raise site that already
knows which variant it caught (`isScope`, long since computed and recorded in
`context.scopeRelated`). A new `dashboardOnly` flag on `raiseAnomaly` suppresses
the page for that occurrence only.

The flag is deliberately **one-directional**: it can suppress a page, never
create or escalate one. The worst a wrong caller can do is make
`/admin/doc-ingest/health` quieter than the grading intends — visible on the
surface, and incapable of manufacturing an alert.

## 3. The defect this incident exposed: ADR-0095 §3 did not go far enough

ADR-0095 found that `download_failed` was resolved only on the **applied** path,
so a source that recovered but whose revision the guardrail **staged** never
cleared. It moved the resolve above the guardrail branch.

That fix is live and it is still not enough, which the ledger says out loud: the
`download_failed` row TEREX opened at 4:58 PM tonight was **still open at 10 PM**,
on a source that had downloaded cleanly at 5:13 PM and was verified byte-identical
to what Graph serves right now.

The resolve is above the guardrail branch, but it is still below the **unchanged
early return** — the path that the overwhelming majority of sweeps take:

```ts
if (existingVersion) return { outcome: 'unchanged', ... };   // ← returns here
…
await resolveAnomaly(prisma, 'download_failed', subject, 'Download succeeded.');
```

So a healed `download_failed` clears only on the next **content change**. TEREX's
ctag has not moved since 5:13 PM, so nothing since has been able to clear it —
and under the 24h re-page it would have paged Bill daily, indefinitely, about a
Graph blip that healed in fifteen minutes. This is the same shape as ADR-0095's
own finding, one branch further up: **a recovery that is only recognised on the
rarest path is not a recovery mechanism.**

### Fix

Resolve on the unchanged path too. Reaching that line means the live content
marker matches a revision already archived — _"my copy of this document is
current"_, which is a **stronger** claim than _"a download succeeded"_ and
squarely answers the condition.

Guarded on `r2_key` being present: a revision whose archive write failed is one
`applyVersion` raises `download_failed` **for**, so clearing it there would put
the two into a resolve/raise loop and assert we hold bytes we do not.

## 4. TEREX: the staged backlog is real, verified, and safe — with one caveat

Five revisions have been staged behind the variance guardrail since 08-10. The
guardrail staged them because it could not verify the change was real. It has now
been verified against the source, and the verification is worth recording in full
because it exonerates the extractor and indicts a unit.

**The archive chain is intact end to end.** The live file pulled from Graph
tonight hashes to
`0dea4156aac563c7add45e8c8182a63b270c26455c41338b3b62eba88775533d` (491,583 B),
**byte-identical** to the newest staged revision `6adeed4b`. All six archived R2
objects hash exactly to their recorded `content_sha256`.

**The change is real.** Sheet `Jul26`, column G ("Day Total Hrs Used"), rows
3–33 are the 31 daily rows of July. They now sum to **222.25**, which is also
what the workbook's own totals cell `G34` says. The applied baseline was
**164.20**. July was simply filled in — monotonic throughout, all 31 days
entered, four legitimate zero days.

**The 5698.4 outlier was the workbook briefly telling the truth.** In revision
`fb8aa241` (08-10 16:40) day 29 had an End Hours meter reading of 2665.95 with
Start Hours still blank, so the sheet's own `End − Start` formula returned the
raw meter value. Fifteen minutes later Start Hours was entered, G31 became 11.2,
and the column returned to 222.25. Not corruption, not a partial upload, not a
header shift — a half-entered row, caught mid-keystroke by a 15-minute sweep.

### The caveat: every SUM-totalled aggregate is exactly 2×

`parse_summary.numericTotals` counts the sheet's **own totals row as a data
row**, so it sums the column and then adds the column's total to itself.
`444.50 = 2 × 222.25`. `328.40 = 2 × 164.20`. Pocket coil `7040 = 2 × 3520`.
Springs `942 = 2 × 471`.

This is a genuine defect and it is **not** fixed here, deliberately:

- **It does not corrupt anything.** `numericTotals` is consumed in exactly two
  places — the guardrail's variance comparison and the anomalies display. It
  never reaches a business table. TEREX money rows come from a separate
  extractor (`terex-extract.ts`) that reads cells directly and stages rows for
  human confirmation.
- **It does not change any staging decision.** The doubling is consistent on
  both sides of every comparison, so the _percentage_ is exact:
  `222.25 / 164.20` and `444.50 / 328.40` are both +35.4%. Every revision that
  staged would still have staged.
- **Fixing it has a blast radius that does not belong in a midnight noise
  patch.** The moment the doubling is corrected, every stored baseline across
  every watched workbook is 2× its newly-computed successor — a −50% variance
  on the next sweep of every source, which would stage everything at once and
  page about all of it. That fix needs its own ADR and a baseline re-computation
  migration, not a same-night ride-along.

Recorded as follow-up. Until then, treat `numericTotals` as a change detector,
never as a business figure.

### Disposition

The newest revision `6adeed4b` is applied; it is byte-identical to what Graph
serves now, so it _is_ the current document. The four superseded intermediates
are discarded — they are earlier states of the same file, and applying them would
materialize stale content. Audit rows record the verification basis: the sha256,
the byte comparison against live Graph, the workbook's own `G34 = 222.25`, and
the 2× note, so the record says what the file says and not only what the parser
computed.

## 5. `column_nulled` on TEREX is a false positive from our own upgrade

Open since 07-31 with 92 occurrences, claiming column "Estimates for 2025" on
sheet "Annual Cost" was REMOVED. **It was not. It is in the live workbook right
now**, at `Annual Cost!A1`.

ADR-0067 Amendment 8 moved header detection from row 1 to row 2, which was
correct: row 1 holds three merged _section titles_, row 2 holds the real headers.
Annual Cost's column set went from 3 pseudo-columns (the titles) to 21 real ones
(`Month / Loan Pmt / Diesel / Maint / Labor / Forklift / Total`, ×3 blocks). The
guardrail compared pre-Am.8 headers against post-Am.8 headers and correctly
reported that every pre-Am.8 pseudo-column had vanished.

The 92 is not 92 events. Every `column_nulled` finding for one source collapses
to one fingerprint (`ingest.ts` sets `subject = ${sourceKey}:${finding.kind}`), so
the per-finding loop opens one row and bumps it for the rest — 92 bumps inside a
single sweep, which is why `first_seen_at` and `last_seen_at` are identical to
the millisecond and it has never re-fired since.

Resolved as a parser-upgrade artifact. No document changed.

## 6. `discovery_gap` is a decision for Bill, not a bug

Vision can READ 11 documents in scope and is WATCHING 3. Registration is manual
**by design** — nothing auto-registers, because a document entering the pipeline
is a decision about what the business treats as a record.

The 8 readable-but-unwatched documents, by name:

1. `Woodland Outbound Auditing 2026.xlsx`
2. `DR3 Data Tracking.xlsx`
3. `JOURNAL Woodland Facility.xlsx`
4. `Woodland Invoices tracking.xlsx`
5. `TEREX.xlsx` _(a second share of the already-watched workbook)_
6. `DR3 Task Lists for 2025.xlsx`
7. `DR3 Meeting Notes Log 2026.xlsx`
8. `DR3 Machine List (2).xlsx`

Discovery scope is
`(filetype:xlsx OR xlsm OR xlsb OR csv) AND path:"https://svdplanecounty-my.sharepoint.com"`,
and the list is not truncated — 8 is the whole gap.

**Nothing is auto-registered here.** The anomaly stays open until Bill says which
of these belong in the pipeline; it is the honest representation of an open
question. It pages `default`, once, and is the one item on the board that is
genuinely waiting on a human.

A separate `info` row (`unclassified`, opened 07-30, never pages) holds
`Woodland Data Auditing Tracker (1).xlsx` — a document Vision could not classify
automatically. Same shape of answer: the confirm queue on `/admin/doc-ingest` is
the surface, and a human decides. Left open deliberately.

## 7. Consequences

- Roughly one page per day disappears (`sweep_failed` on self-healing 503s) and
  one recurring 24h page disappears (`subscription_renew_failed` scope refusals).
  Neither condition becomes invisible: both remain open rows on
  `/admin/doc-ingest/health`.
- A genuinely dead sweep still pages `high`, 15 minutes later than before. A
  subscription failure that is _not_ the structural limit still pages.
- A `download_failed` that heals now clears on the next sweep rather than on the
  next content change.
- `numericTotals` is a change detector, not a business figure, until the 2×
  defect is fixed. **Whoever fixes it must re-baseline every watched source in
  the same change**, or the next sweep stages every document at once.
- The anomaly board's remaining open item is `discovery_gap`, which is a question
  for Bill rather than a fault.
