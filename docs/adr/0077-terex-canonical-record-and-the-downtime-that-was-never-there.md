# ADR-0077 — One Terex, and the downtime that was never there

**Status:** Accepted, implemented, LIVE at Woodland (2026-08-06)
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

## D6 — The blended machine view, shipped DARK

Built and shipped, born `pilot` — nobody but an admin can open it until Bill
flips `equipment_terex_ledger` at `/admin/rollout`.

**Why ship it before D5's classification lands.** The view is not empty today.
Its **AP half is fully live**: four approved invoices, **$2,024.92**, all now
resolving to the one canonical row this ADR created. Its **downtime half is real
content** — "not recorded", which is the true and previously-unsaid answer. Only
the **maintenance half** waits on O-12, and it announces that in words rather
than rendering blank:

> **Maintenance log awaiting absorption acceptance.** …This is an empty _inbox_,
> not a machine that has never needed a repair — do not read it as a clean history.

Born-pilot is doing two jobs at once here. It is the ADR-0047 default for any new
staff-visible surface, and it is also what keeps a half-populated view off a
manager's screen while the code, the gate and the pinned math land and get
exercised. Shipping dark is the established convention (ADR-0074 did the same for
`ipad_hauls`), and the alternative — holding the whole feature in a branch until
an operator action completes — is how work rots.

**Shape.** A DETAIL VIEW under the ADR-0044 tile at
`/dashboard/[site]/equipment/[equipmentId]`, reached from it. Not a parallel tile:
the tile is the site's equipment surface and stays generically titled, because a
second machine joins it tomorrow. `/admin/equipment/[id]` — the asset master,
which says _what a thing is_ — gains one cross-link to the ledger, which says
_what it has cost_. The tile's link is rendered only for callers who can actually
open the target, so a manager is never offered a link to "Not yet activated".

**Three sources, deliberately not blended into one number.** `computeTerexLedger`
returns them side by side:

| source      | rule                                                                |
| ----------- | ------------------------------------------------------------------- |
| maintenance | `doc_terex_maintenance_rows`, **`status='confirmed'` only**         |
| AP ledger   | links on the canonical id, `confirmed_amount_cents ?? amount_cents` |
| downtime    | `equipment_events.hours_down`, Σ non-NULL, else "not recorded"      |

**No event↔invoice matching in v1.** All four invoices are the same vendor inside
six days. A date-or-amount heuristic over that data would not _find_ links, it
would _manufacture_ them — and manufactured links on a management view are worse
than none, because they look authoritative. The two lists render side by side
with the absence stated out loud ("Invoices are not linked to individual
repairs"). The `linkedCents <= totalCents` invariant is asserted anyway, holding
trivially at 0, so the guard already exists the day matching arrives.

**No new writers.** The module opens no write path; the API route is GET-only and
deliberately has no write verb. Absorption remains the sole writer of the
maintenance rows, the AP decision path of the links, the ADR-0044 service of the
events.

## D7 — The gate is the equipment-request flag, and that couples two things

Access is `admin OR (can_resolve_equipment_requests AND site reach)`, read
**fresh from Postgres** on every request, never from the JWT — and reach is
re-derived from the **equipment row's** site, so editing the `[site]` URL segment
cannot reach the other jurisdiction's asset.

That resolves to exactly **Bill, Morena and Janette**, verified against the live
roster. Three more obvious gates were rejected because each selects the wrong
set, and each is now a pinned negative test:

| candidate gate               | who it wrongly admits                                                    |
| ---------------------------- | ------------------------------------------------------------------------ |
| `role === 'manager'` + reach | Daven and Kelsey, via `all_sites` (ADR-0024)                             |
| the `ap_approvers` roster    | Shannon — filing an invoice is not owning the asset                      |
| matching people by NAME      | the duplicate-account trap: a second, inactive "Bill Barnard" row exists |

`can_resolve_equipment_requests` fits because it already means "this person is
answerable for what equipment exists at their site" (ADR-0046 Am.9).

**The coupling is the consequence to know about:** granting that flag to a fourth
person also grants them this view. That is the right default — the person who
decides what an asset _is_ should see what it has cost — but it is now a second
effect of ticking a box that used to have one, and whoever ticks it should know.

**One deliberate asymmetry.** The AP-decision deep link goes to
`/admin/ap/history`, which is admin-only. Rendering it for Morena or Janette would
hand them a link that 403s — precisely the defect ADR-0075 opens on ("the one
instruction it did give 403s for site managers"). Non-admins get the invoice
identity inline instead; `decisionHref` is `null` for them, and a test pins it.

## D8 — The math is pinned, and the pins were made to fail on purpose

Five regression assertions, each with a fixture built so the failure it guards
against is actually _reachable_:

1. confirmed repairs **$77,067.94**, not $154,135.88
2. confirmed credited **$4,025.36**
3. AP total **202,492 cents** across 4 links on one id
4. downtime = Σ non-NULL `hours_down`; zero recorded rows ⇒ `null`, never `0.0`
5. `linkedCents <= totalCents` (v1: 0)

The subset-duplication fixture is the interesting one. The staged rows are left
_in the table_, mirroring the confirmed ones — so deleting the `status:
'confirmed'` clause does not make the test go red for the boring reason (an empty
list); it makes the repair total read **exactly 15413588**, the real
double-count. Proven, not asserted:

```
× 1. confirmed repairs total $77,067.94 — not $154,135.88
  → expected 15413588 to be 7706794
× excludes staged rows entirely — they are a proposal, not a fact
  → expected [ { id: 'm1', …(7) }, …(3) ] to have a length of 2 but got 4
```

And the money-column pin, falsified by reading `amount_cents` alone — the column
that is NULL on all four production rows:

```
× 3. AP total is 202,492 cents across 4 links on ONE id
  → expected +0 to be 202492
```

A first pass at the first falsification went red for the wrong reason (the test
mock filtered on an undefined status and returned nothing). That is the same
class of mistake ADR-0076 recorded — a falsification that proves nothing — so the
mock was corrected until the red output named the real number.

## D9 — One document, many revisions: the ledger reads ONE

Registering `TEREX.xlsx` (D5) and accepting its batch was ordered by Bill in
writing on 2026-08-06 and is done. It did not go as scripted, and the way it
failed is the most useful thing in this ADR.

**What happened.** Registering the source made every APPLIED revision absorbable
at once, so the backlog sweep absorbed **all three** — ctags `…2977`, `…2978`,
`…2979`. The table came back with **240 staged rows totalling $231,203.82**:
exactly **3 × $77,067.94**.

**The absorber was not wrong.** Per revision the arithmetic is perfect — 80 rows,
$77,067.94 / $4,025.36 each — and the ADR-0069 Am.2 de-duplication is visibly
doing its job inside each one: `Maintenance Log 2025` contributes 55 rows
carrying all the money, `Maintenance Log2026` adds only the 25 rows that are not
already in it, all of them costless. That de-duplication is **within** a version.
It was never meant to reach across revisions of the same document, and the unique
key `(doc_source_version_id, sheet_name, row_index)` means two confirmed
revisions coexist by design.

What would have been wrong is the **ledger**, which summed every confirmed row
for the site. So:

1. The two superseded revisions were **discarded** — not deleted — through the
   same audited decision path as an accept, each recording the $77,067.94 it was
   worth. A revision supersedes its predecessor; it does not add to it.
2. `computeTerexLedger` is now **version-scoped**: newest absorption wins.

Point 2 matters more than point 1, and the tests say so out loud by leaving all
three revisions CONFIRMED in the fixture. **A management total that is only
correct when somebody remembered to tidy up is not a guarantee.** Falsified by
removing the version filter:

```
× reports ONE revision — $77,067.94, not $231,203.82
  → expected 23120382 to be 7706794
```

**The hard stop is why this was caught.** The one-off refuses to accept anything
unless the staged batch reads `77067.94` / `4025.36` to the cent, and `check` is
a separate read-only step that must be run and read before `accept`. A wrong
number here does not stay a wrong number — it becomes **accepted money**.

**Accepted, verified live:** 80 confirmed rows, **$77,067.94 / $4,025.36**,
Woodland-scoped, `confirmed_by` carrying the run's label.

### What the free-text column actually held

`estimated_time_cost`, now that rows exist — every distinct value:

```
Unknown - more than a week, less than a month
unknown
unknown, but 'soon'
```

Not one of them is a duration. D4's verdict is stronger than it was written:
the column called "Estimated repair time/cost" does not merely fail to be
_reliable_ downtime, it contains **no time information at all**. The as-written
rendering needed no change.

Two more figures from the live data, both of which the rendering rules were
written for and neither of which was hypothetical: **72 of the 80 rows carry no
cost** (they render "not recorded", never `$0.00`) and **16 carry no parsable
date** — one of them the `"09/16 or 17"` the schema comment predicted, shown as
written.

## D10 — Live at Woodland, dark at Eugene

`equipment_terex_ledger` is **live for Woodland** (O-14), flipped through
`flipRolloutSurface` — the one audited place a rollout state changes — with the
acceptance figures as its criteria note.

**Eugene stays `pilot`, permanently, and the row stays.** Bill, 2026-08-06: _"the
terex machine operates exclusively at woodland — eugene has no use or need for
this data at all."_ Deleting the row would produce the same visible outcome by a
worse mechanism: an unregistered surface resolves to admin-only through a
_caught exception_, so a deliberate "no" would be indistinguishable from a
lookup that quietly failed. A `pilot` row is the decision, written down.

## D11 — The downtime capture path did not need building. It needed turning on.

Bill: _"ok build the downtime capture path."_ The honest answer is that it was
already built, and had been since ADR-0044.

Everything the capture needs exists and is production-grade:

| piece                         | state                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `equipment_events.hours_down` | `Decimal(5,2)`, nullable                                                              |
| validation                    | `assertEquipmentShape` — bounded `[0, MAX_HOURS_DOWN]`, refused on non-downtime kinds |
| write                         | `createEquipmentEvent`, audited **in the same transaction** (hard rule #6)            |
| correction                    | `voidEquipmentEvent` — soft void via `voided_at`/`voided_by`, never a delete          |
| API                           | `POST /api/manager/[site]/equipment`, zod `.nonnegative().max(999.99)`                |
| form                          | `EventEntry` reveals the hours input when `DOWNTIME_KINDS.has(kind)`                  |

**What did not exist was a Woodland manager who could reach the form.**
`equipment_entry` was `pilot`, which means admin-only, so Morena and Janette had
never seen it. That is the whole of why `hours_down` was NULL on all 68 rows: not
a missing feature, an unreachable one. The 61 maintenance + 7 repair events in the
table came from the ADR-0048 importer, not from a person.

So O-13 resolved to a rollout flip, executed under the same written order:
`equipment_entry` → **live at Woodland**. Eugene stays `pilot` (no Terex there).

**The design choice this ADR is therefore recording is the one ADR-0044 already
made, and it is the right one:** downtime is a `kind='downtime'` row in
`equipment_events` carrying `hours_down`, not a new column on some other table.
The alternative — a dedicated downtime table or a column hung off the maintenance
rows — was rejected implicitly then and explicitly now, because:

- `equipment_events` is already the machine's event log, already site-scoped,
  already audited, already voidable, and already what the tile and the ledger
  read. A second home for the same fact would need all of that again.
- Downtime is not a property of a _maintenance row_. The workbook has no downtime
  column (D4), so hanging one off the absorbed rows would mean inventing a field
  the source document does not have — and absorption is a single-writer path that
  a human must not be editing.
- A human enters the hours. **Nothing derives them.** There is no start/end
  timestamp pair to subtract, and the run-hour columns on the monthly tabs measure
  the opposite thing (D4). An unmeasured machine stays "not recorded".

**The far end is pinned.** Three new tests: a captured event moves the total off
"not recorded", a voided one stops counting (and can return the total to "not
recorded" rather than 0.0), and voiding one of several leaves the rest.

The first falsification of the void guard came back **green** — the test mock
filtered voided rows out unconditionally, so deleting the `voided_at: null`
clause from the module changed nothing and the guard was measuring the mock. The
mock now honours the query, and the red is real:

```
× a VOIDED event stops counting — and can return the total to "not recorded"
  → expected 6.5 to be null
× voiding ONE of several leaves the rest counted
  → expected 103 to be 4
```

That is the second time in this ADR's work that a first-pass falsification proved
nothing. It is worth naming as a pattern: **a guard that cannot be made to fail
has not been tested, and mocks are where the failure hides.**

## Amendment 1 (2026-08-07) — the surface is named for the machine

**Supersedes the D6 sentence "the tile heading stays generic."** That was a
deliberate call and it was wrong: the handoff spec (PR #197) says _"Rename +
upgrade the tile to Terex"_ and _"rename its Terex view to 'Terex'"_, and Bill
noticed it missing — _"also the labelling is not updated - check the original
spec and make sure this is complete."_

The original reasoning — the tile is the site's equipment surface and a second
machine could join it tomorrow — is not wrong, it is just outranked. A surface
that says "Equipment" when the site has exactly one machine, which everybody
calls the Terex, is a surface named after a database table rather than after the
thing in the yard.

**Derived, never hardcoded.** `siteMachineLabel(siteId)` returns the machine's
`display_name` where the site has one and `'Equipment'` where it does not, using
the same evidence as `isSiteTerexMachine` (a `terex`-category row the Terex
invoices actually resolve to). So Woodland reads "Terex", Eugene stays generic
rather than advertising a machine it does not have, and a Terex arriving at
Eugene tomorrow renames that site's surface with no code change. Hardcoding
`siteCode === 'woodland'` was rejected for the reason the whole ADR keeps
running into: the registry is the truth, and it changes.

| where                        | before                                     | after                                                              |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| dashboard nav                | `Equipment`                                | `Terex` (Woodland) · `Equipment` (Eugene)                          |
| tile `<h1>`                  | `Equipment — DR3 Woodland`                 | `Terex — DR3 Woodland`                                             |
| tile intro                   | "Terex throughput, downtime, and cost."    | "Throughput, downtime, and cost." (the name is in the heading now) |
| overview band                | `Throughput & equipment (Terex)`           | `Terex — throughput, downtime & cost`                              |
| overview cost card           | `Equipment cost · 30-day`                  | `Terex cost · 30-day`                                              |
| overview empty note          | "Equipment throughput is not available…"   | "Throughput is not available…"                                     |
| entry form                   | `Log an equipment event`                   | `Log a Terex event`                                                |
| tile → ledger link           | `Terex — maintenance, AP spend & downtime` | `Terex ledger — maintenance, AP spend & downtime`                  |
| `/admin/equipment/[id]` link | `View machine ledger — …`                  | `View the Terex ledger — …`                                        |

**`/admin/equipment` is deliberately NOT renamed.** It is the asset master for all
554 seeded rows across both sites; "Equipment" is its correct name. Only its
cross-link label changed, and only to name the machine it points at.

The third falsification of this ADR's work also came back green here — the test
mock enforced the invoice-evidence rule itself, so dropping it from the source
changed nothing. Fixed; the real red is
`expected 'EQ65 — Sheer Machine Shear Machine' to be 'Equipment'` — which is what
Eugene's nav would have said.

## Amendment 2 (2026-08-07) — three things the independent audit named

An independent verification pass (terry) returned CLEAN on all shipped scope.
Three observations are recorded here rather than fixed, because each is either
already honest or a deliberate boundary:

**The rollout flag hides the PAGE, not the API.** `equipment_terex_ledger` is
consulted by `/dashboard/[site]/equipment/[equipmentId]`; the GET route
`/api/manager/[site]/equipment/ledger` does **not** consult it. That is the
intended split and worth stating plainly: a rollout gate is a _visibility ramp_,
not an authorisation boundary. What bounds the audience is
`requireEquipmentLedgerAccess` + `ledgerReaches`, which the route enforces
independently — so a manager who guessed the API path during pilot would still be
refused unless they held `can_resolve_equipment_requests` AND reach to the
machine's site. Flipping the flag changes who can _find_ the data, never who is
_allowed_ it. Do not reach for a rollout flag when the requirement is access
control.

**`linkedCents <= totalCents` is tautological until matching exists.** v1 sets
`linkedCents` to a literal 0, so the invariant cannot currently fail. It is kept
deliberately — the guard should predate the feature it guards, so the day someone
adds event↔invoice matching the assertion is already in the suite rather than
being remembered. Disclosed in D6 and again here so nobody reads it as evidence
of a working matcher.

**A merge audit row should carry the money, not just the counts.** The ADR-0075
merge audit records `repointed_links` and `repointed_equipment_requests`. Both
were right, but proving spend was conserved still required re-deriving the cent
total from `ap_requests` afterwards. A future merge should stamp the
`COALESCE(confirmed_amount_cents, amount_cents)` total into the audit `after`
payload, so the audit row alone answers "did this move any money?" — which is the
question anyone auditing a merge actually has.

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
- **Hold the machine view until the classification lands.** Rejected on the
  second pass: the AP half is live _today_ and the downtime half is real content,
  so the only empty panel is one that says it is empty. Born-pilot already keeps
  it off a manager's screen, which is the protection holding it back was buying —
  and unmerged work rots.
- **Match invoices to maintenance events by date proximity + amount.** Rejected
  for v1 under D6. With one vendor and a six-day spread, the heuristic's output
  would be indistinguishable from guessing.
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
- The ledger surface exists and is **dark**. Bill flips
  `equipment_terex_ledger` (Woodland) once O-12 has been accepted; until then only
  admins see it, and its maintenance panel says why it is empty.
- `can_resolve_equipment_requests` now grants **two** things. Granting it to a
  fourth person also shows them one machine's whole invoice history.
- Downtime remains **uncollected**, not merely unreported. If Bill wants it, it
  needs a capture path — a `kind='downtime'` event with `hours_down`, or a new
  workbook column — not a derivation. No number will be invented from the run-hour
  columns to fill the gap.

## Amendment 3 (2026-08-07) — the cost residual, closed

D4 established "not recorded ≠ zero" and applied it to `hours_down`, which is
NULL on all 68 Terex events. It **explicitly left `totalCostCents` alone**, on the
stated grounds that cost is genuinely _partly_ populated (7 of 68 events carry
one) and was therefore "a weaker case".

That reasoning had it backwards, and this amendment reverses it.

Partly-populated is precisely when a fabricated zero is most convincing. An
all-NULL column eventually makes somebody suspicious; a column that clearly works
does not. `totalCostCents` summed `monthlyCostSeries`, which **drops null-cost
events**, so a window in which nobody priced anything reduced to `0` and rendered
as **`$0.00`** on the equipment tile and the ops-overview card — a machine that
had cost the organisation nothing. The identical shape as the downtime figure
that painted an unmeasured machine as a flawless one, one field over.

**Decision.** `EquipmentThroughput.summary.totalCostCents` and the
`OpsOverviewEquipment.costUsd` derived from it widen to `number | null`.

- Presence is decided on the **events**, not on the monthly series or on a truthy
  sum: `events.filter((e) => e.cost_cents != null)`. An empty series is ambiguous
  (it means "nothing priced" AND "no events" AND "every event priced at zero"),
  and collapsing those three is what manufactured the free machine.
- An absent cost renders **"not recorded"**, neutral — matching the downtime tile
  directly above it on both surfaces.
- **A real recorded `0` stays `$0.00`.** A warranty repair that genuinely cost
  nothing is a fact, and losing it would be the mirror-image error. Both
  directions are pinned in `throughput.test.ts`, and both were falsified: reverting
  the sum reds with `expected '$0.00' to be 'not recorded'`, and collapsing a real
  zero reds with `expected 'not recorded' to be '$0.00'`.

One assertion changed rather than being added: the empty-window test previously
asserted `totalCostCents` `.toBe(0)`. That assertion was pinning the defect.

**Sequencing note.** This landed after the ADR-0079 daily-throughput stream
merged, because both edit `src/lib/equipment/throughput.ts`. The originating
handoff named `terex-ledger.ts` as the target; that was wrong — verified by
reading the code — and the real target is `throughput.ts` plus `EquipmentClient`,
`OpsOverviewPanel` and `ops-overview.ts`.
