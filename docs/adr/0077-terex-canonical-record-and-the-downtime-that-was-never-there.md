# ADR-0077 — One Terex, and the downtime that was never there

**Status:** Accepted (2026-08-06)
**Supersedes:** OPEN-ITEMS **O-10**'s stated merge direction (see D1). Nothing else.
**Supplements:** ADR-0075 (the merge verb this drives), ADR-0063 (the equipment master), ADR-0044 (the equipment tile), ADR-0036 (the `actor_label` system-actor convention), ADR-0069 Am.2 (TEREX absorption, preview-then-confirm)
**Does NOT supersede:** ADR-0063 D3 (the `(site_id, display_name)` unique index stands), ADR-0069 Am.2 §5 (money acceptance still answers "who accepted this?")

## Context

Bill asked for one view of one machine: what the Terex has cost, what broke and
when, and **how long it was down**. Three things stood between that request and a
trustworthy number, and only two of them turned out to be what we thought.

The first was real and is now fixed: Woodland held **three `equipment` rows for
one machine** (ADR-0075's closing act), each cited by a different approved
invoice. Any total across them either triple-counts or, picking one, shows a
third of the money.

The second was real and is not what the handoff said it was.

The third does not exist, and saying so plainly is most of this ADR.

---

## D1 — The canonical Terex is `7e35a4aa` (`Terex`), and O-10's direction was backwards

O-10 recorded the intended merge as **`7e35a4aa` and `1125fb30` INTO `bee54def`**.
That direction is wrong, and the reason is a property of the merge itself:

> **A merged-away row keeps its `display_name`.** `mergeEquipment` repoints
> attribution and stamps the loser. It never renames anything.

So merging into `bee54def` would have left the surviving record permanently
called **`Terex Machine`** — the clumsier of the three names — while the name Bill
actually wants, `Terex`, sat frozen on a dead row that `(site_id, display_name)`
uniqueness then forbids anyone from reusing. The rename everyone assumed would
follow the merge was never available.

`7e35a4aa` is also the row the fewest facts have to move away from: it already
carried **2 of the 4** invoice links and **2 of the 4** resolved requests,
including the most recent human resolution (`Terex 815`).

O-10's caution was sound — `Terex` is a bare name that could plausibly be a
second unit, and canonical detection deliberately refuses to guess that
(ADR-0075 D3). It is a judgement, and Bill made it in writing (handoff PR #197).
What O-10 got wrong was only the direction.

**Result, verified in production 2026-08-06:**

| check                      | result                                             |
| -------------------------- | -------------------------------------------------- |
| active unmerged Terex rows | exactly one — `7e35a4aa`, category `terex`         |
| losers                     | `is_active=false`, `merged_into_id=7e35a4aa`, both |
| `ap_equipment_links`       | 4 of 4 on `7e35a4aa`                               |
| spend                      | **202,492 cents, before and after** — conserved    |
| `ap_equipment_requests`    | 4 of 4 resolve to `7e35a4aa`                       |

The conservation figure is measured with
`COALESCE(confirmed_amount_cents, amount_cents)`. All four of these invoices
carry their money in `confirmed_amount_cents` with `amount_cents` **NULL**, so a
ledger that reads `amount_cents` alone reports **zero** and "proves" the
conservation of nothing.

## D2 — Driven through the ADR-0075 service, never through hand-written SQL

The merge ran from `scripts/one-off/2026-08-06-terex-canonical-merge.ts` calling
`mergeEquipment` / `updateEquipment` — the same audited transaction the admin
Merge button drives. `requireAdmin()` is the **HTTP-layer** gate on that button;
Bill's written instruction is the authorisation. Repointing the rows by hand
would have skipped the cross-site guard, the already-merged-chain guard, and the
in-transaction audit write, all of which exist because this is money attribution.

The script is retained in the repo. It is the record of what ran — a changelog
sentence cannot be re-read by a future session the way a script can.

## D3 — A write with no human behind it says so, and does not borrow a name

Neither `mergeEquipment` nor `updateEquipment` had an actor shape for a
non-human caller: `ActorContext.actorUserId` was a required `string` written
straight into `audit_log.actor_user_id` and `equipment.merged_by`.

The available shortcut was to pass Bill's `users.id`. That writes a **false
claim into an append-only table** (hard rule #6): the audit row would read as
though he clicked Merge, and hard rule #6 means we can never take it back.

So both functions now accept `ActorContext | SystemActorContext`, mirroring
`SystemActor` in `src/lib/survey/types.ts` (ADR-0036) and the `actor_label`
convention already used by the MyMRC bridges, the AP poll and `notifyStaff`. A
labelled actor writes `actor_label` and leaves `actor_user_id` **NULL**;
`merged_by` is left NULL too, because the label is the record and there is no
user to point at. The production rows read:

```
actor_user_id  actor_label
(null)         system:terex-canonical-merge (ADR-0077, executed by Claude Code
               at Bill's written instruction, PR #197)
```

Four tests pin it, including that the human path is unchanged and that
authorship changes nothing about behaviour. Falsified before being trusted:
dropping the label to `null` turns the first one red.

## D4 — Downtime does not exist in the workbook, and "not recorded" is not zero

The handoff stated downtime was "on the sheet that you already scrape." It is
not on any of them. Four independent lines of evidence, each checked against the
live file or the live database:

1. **Header sweep, all 40 sheets.** No column named downtime, days-down, hours-down
   or any synonym. The maintenance-log header row (both sheets, `headerRowIndex: 2`,
   `headerConfidence: strong`) is exactly:
   `Date * · Time * · Issue * · Measures taken * · Estimated repair time/cost ·
Estimated cost · Notes* · Actual Repair Cost · Amount Credited`.
2. **`Estimated repair time/cost` is free text, not a duration.** Its
   `numericTotals` sum is **2** across ~90 populated rows — the column holds
   things like "2 weeks", which is why the schema keeps it as `String?`.
3. **The ADR-0048 importer recorded `downtime: null, hours: null`** for this file.
4. **`equipment_events.hours_down` is NULL on all 68 Terex rows.** The column has
   never been written, at either site, by any path.

The monthly operating tabs do carry `Start Hours / End Hours / Day Total Hrs
Used` — but those are hours the machine **ran**, not hours it was **down**, and
those tabs are `processed_units_daily` territory where workbook-sync is the sole
writer. There is also a per-day `condition*` column that might one day support a
derivation. Neither is downtime today, and neither will be invented into one.

**The consequence, which is the actual defect this fixes.** The tile summed a
100%-NULL column to `0`, rendered **"0.0 hrs"**, and the ops-overview card
painted it **green** (`tone: hoursDown > 0 ? 'warn' : 'ok'`). An unmeasured
machine was being displayed as a flawless one. `totalDowntimeHours` is now
`number | null`; absence renders **"not recorded"** in a neutral tone, matching
the convention already stated in words on the TEREX preview screen:

> "A repair with no cost in the sheet shows as 'not recorded', never $0 — a
> repair nobody priced is not a free repair."

The distinction the type has to carry is _nobody recorded any_ versus _somebody
recorded none_, and only the second is a zero. Both directions are pinned by
tests, and the null branch was falsified before being trusted.

## D5 — Phase 2's absorption is BLOCKED on a classification, not on the guardrail

The handoff said version `eed9d4cb` was blocked by "the ADR-0072 guardrail." Two
corrections, both material:

**(a) ADR-0072 is the iPad anchor-overwrite guardrail.** It has no bearing here.
The doc-ingest guardrail is **ADR-0067 §3.2 D6/D7** (`src/lib/doc-ingest/guardrail.ts`).

**(b) The guardrail's ~96 findings are a parse IMPROVEMENT, not a data loss —
and it is not the operative blocker anyway.** All 92 measurable removals are
`column_nulled`, and the diff between the last applied revision (`f1c2d68d`) and
the staged one tells the whole story:

| revision                  | `populatedColumns` on both maintenance-log sheets            |
| ------------------------- | ------------------------------------------------------------ |
| `f1c2d68d` (last applied) | `["TEREX MACHINE MAINTENANCE LOG"]` — one banner, no headers |
| `eed9d4cb` (staged)       | all 8 real data columns, `headerRowIndex: 2`, `strong`       |

The older parse had **no `headerRowIndex` at all** — it predates ADR-0067 Am.8's
header detection and mistook each sheet's title banner for its header row. The
"removed columns" are those banners disappearing as the parser learned to look
one row further down. On the two sheets that absorption actually reads, the
**only** removal is `TEREX MACHINE MAINTENANCE LOG` itself. Nothing was lost;
the staged revision is the first one that can see the data at all.

So the HARD STOP check on the guardrail **passes**. But absorption still cannot
run, for a different reason found only by reading the live row:

```
doc_sources: id=8a0246e7…  display_name='TEREX.xlsx'  doc_class=NULL  site_id=NULL
```

`absorbVersion` refuses at Gate 1 (`doc_class ∈ ABSORBABLE_KINDS`) and Gate 2
(`site_id IS NOT NULL`). That is why `doc_terex_maintenance_rows` holds **0 rows**
even though two earlier revisions were applied back on 2026-07-29 — they were
never queued. The guardrail was never the thing standing in the way.

**This ADR deliberately does not classify the source.** Gate 2 exists precisely
so that absorption refuses an unclassified document rather than guessing its
site (ADR-0069), and stating "TEREX.xlsx is a `terex_maintenance_log` belonging
to Woodland" is the same _kind_ of act O-10 was: a human asserting a fact about
the physical world. Bill's written instruction covered the merge that was
enumerated for him; it did not contemplate this, because nobody knew it was
required. The evidence points one way — the Terex is a Woodland asset and all
four invoices are Woodland — but a $77,067.94 acceptance chain should begin with
Bill saying so, not with us inferring it. Logged as an operator action.

The numbers are ready and pinned for when he does: `parse_summary.numericTotals`
on **both** maintenance-log sheets reads `Actual Repair Cost: 77067.94` and
`Amount Credited: 4025.36`. Identical on both because the 2025 sheet is a strict
**subset** of the 2026 sheet — absorbing both without `dedup_key` reports
**$154,135.88**, exactly double (ADR-0069 Am.2).

## D6 — The blended machine view is deferred, and why that is the right call

Phase 3's ledger blends three sources. One of them — confirmed maintenance
events — is **empty and will stay empty until D5's classification happens**. Its
two flagship reconciliation totals ($77,067.94 / $4,025.36) could only be
asserted against fixtures today, and the surface itself would render blank for
Bill on the day it shipped.

Shipping a management view whose headline half is empty, gated behind a rollout
flag nobody can usefully flip, buys nothing and costs a permanent surface. The
design work stands (detail view under the ADR-0044 tile at
`/dashboard/[site]/equipment/[equipmentId]`; a `can_resolve_equipment_requests`

- site-reach gate that resolves to exactly Bill, Morena and Janette; no
  event↔invoice matching in v1 because all four invoices share one vendor inside
  six days and any heuristic would manufacture links). It is recorded in
  OPEN-ITEMS and picks up the moment there is money to show.

The one piece of Phase 3 that did **not** depend on absorption — the honest
rendering of absent downtime — shipped here, because it is a live defect on a
surface Bill already reads.

## Alternatives considered

- **Merge into `bee54def` as O-10 said, then rename it `Terex`.** Impossible in
  one direction and unpleasant in the other: the loser keeps `Terex`, so the
  rename collides with the unique index until the dead row is renamed first.
  Two writes and a temporary lie in the registry to reach a state one merge in
  the other direction reaches cleanly.
- **Stamp Bill's `users.id` on the merge.** Rejected under D3. Convenient,
  unfalsifiable later, and permanent.
- **Add a system-actor path to the TEREX _confirm_ as well.** Deliberately not
  done. ADR-0069 Am.2 §5 makes admin-session acceptance of money a control, not
  an accident, and the confirm was never reached anyway (D5).
- **Classify `TEREX.xlsx` to Woodland ourselves and run the chain.** Rejected
  under D5. The evidence is strong; the authority is not ours to assume.
- **Widen `totalCostCents` to `number | null` in the same pass.** Not done. The
  cost column is genuinely populated (7 of 68 events), so `$0.00` is a far
  weaker claim than "0.0 hrs" on a never-written column, and the change ripples
  into `costUsd` on the overview panel. Logged as a residual rather than
  bundled.

## Consequences

- Woodland has **one** Terex record. Every future invoice, request and tile total
  resolves to `7e35a4aa`, and the case-insensitive-unique-index ADR that O-10
  blocked is now unblocked (no violating group remains).
- `mergeEquipment` and `updateEquipment` can be driven by a named non-human
  caller. The HTTP surface is **unchanged** — both routes still require
  `requireAdmin()`; only server-side callers gain the labelled shape.
- Any surface reading `summary.totalDowntimeHours` must now handle `null`. Two
  consumers were updated; the type makes a third impossible to miss.
- Downtime remains **uncollected**, not merely unreported. If Bill wants it, it
  needs a capture path — a `kind='downtime'` event with `hours_down`, or a new
  workbook column — not a derivation. No number will be invented from the run-hour
  columns to fill the gap.
