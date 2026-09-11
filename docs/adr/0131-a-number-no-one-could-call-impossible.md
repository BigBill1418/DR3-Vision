# ADR-0131 — A number no one could call impossible

- **Status:** Accepted
- **Date:** 2026-09-10
- **Follows:** ADR-0037 (D6, the one shared running balance + the noise policy); ADR-0057/0059 (the MyMRC bridges); ADR-0078 D1 (the anchor tiebreaker); ADR-0084 (snapshot void + the reader guard test); ADR-0089 (inbound is keyed on a scheduling field); ADR-0102 (the fix that shipped in code while the row never moved); ADR-0130 (the durable `alert_cooldowns` ledger)
- **Grading:** ADR-0037 — §6 grades every alert this ADR introduces against the 5-question gate
- **Evidence:** `docs/2026-09-10-woodland-program-floor-overstatement.md`
- **Coordination:** the harness is implemented in parallel against **D1–D8 below**. This ADR is the contract; it was written first and deliberately.

## Context

Bill, 2026-09-10: _"the program units on hand are wildly and completely broken."_
He is right, and the number is worse than "wildly": Woodland's floor tile shows
**11,020 program units** in a building whose `sites.max_units_indoor` is **3,500**
and whose last physical count, 23 days ago, was **923 units total**. The true
figure is approximately **390**. The evidence document carries the full working.

The mechanism matters more than the number. Two haul rows in
`mymrc_hauls_mirror` carry unit counts that cannot happen:

| Haul     | Delivery day | `units`   | `Recycler_Weight__c` | Container   |
| -------- | ------------ | --------- | -------------------- | ----------- |
| H-138391 | 2026-09-04   | **6,020** | 331,100 lb           | 53' Trailer |
| H-139774 | 2026-09-09   | **4,840** | 266,200 lb           | 53' Trailer |

Every other Delivered General haul in the mirror — **6,549 of them** — is 342
units or fewer, and 99.8% are at or below 198. A 53' trailer since 2026-06-01
averages **114** units (n=468, median 113, range 27–209). 331,100 lb is 165 tons
of mattresses on a trailer whose legal gross is about 40 tons.

**Nothing in this repo is broken.** The scrape read Salesforce correctly — the
value is in MyMRC itself, `Recycler_Program_Unit_Count__c: 6020`. The ADR-0089
bridge keyed it on the right field. The ADR-0059 precedence guard held. The
ADR-0084 void filter held. `computeRunningBalance` added it up exactly as
ADR-0037 D6 specifies. Six correct components, each satisfying its own ADR,
composed into a number that is wrong by a factor of 28.

### The check that existed, and what happened to it

This repo already has a conservation check. `c5_conservation`
(`src/lib/audit/leg-fetchers.ts:932`) asks the right question — _did we process
more units than we could possibly have had?_ — and it had been firing
`critical` on Woodland almost daily for six weeks:

```
c5_conservation critical 2026-07-31→08-14  expected {"maxProcessable": 743}  actual {"programProcessed": 787}
c5_conservation critical 2026-08-21→09-04  expected {"maxProcessable": 878}  actual {"programProcessed": 957}
```

That 2026-09-04 row is the **last one it ever produced**. The sweep has run
every day since and found nothing, because `maxProcessable` is derived from
inbound — and 10,860 phantom program units bought six weeks of headroom in one
stroke. The check did not fail. It was **satisfied**, by the defect.

This is the general shape and it is why a bigger `audit_findings` backlog is not
the answer. A conservation check is one-sided: it can see too much going out, and
it is blind to too much coming in — and too much coming in is exactly what makes
too much going out look legal.

### Three instances of one meta-pattern, in one session

1. **ADR-0102** shipped a transport fix in code; the production row it was
   supposed to move never moved (P-63, BR-7 — twice).
2. **ADR-0130**'s predecessor cooldown was a correct assumption about replicas
   that became false when nineteen cron containers arrived.
3. **Tonight**: six correct components and an impossible answer.

And a fourth, found while writing this, which settles the question:

> The 2026-07-30 negative-inventory diagnosis (§ "billing", item 5) measured a
> **2,193-unit overstatement sitting in the billing path** — two MRC-voided
> duplicate processed records double-counted into `processed_units_daily`
> (2025-02-27: 2,120 where 1,060 is live; 2025-05-15: 2,266 where 1,133 is
> live). It named the remedy: re-run the processed bridge over those dates, which
> filters `disappeared_at IS NULL` and self-corrects downward.
>
> **Both rows are still in production tonight, unchanged.** `created_at =
updated_at = 2026-07-24 00:13` — they have never been rewritten. Forty-two days,
> a documented defect, a documented one-command remedy, and nothing ran it.

The common shape is not a coding defect. It is that **this repo has 6,100 tests
and every one of them runs against fixtures.** Nothing anywhere continuously
checks that production _data_ still satisfies what the code and the ADRs assume
about it. A fixture proves the code is right about a world we invented. It cannot
notice when the real world stops resembling it.

## Decision

### D1 — Two tiers, and the split is the whole design

The tempting move is one "data invariant suite" that reports everything it finds.
That is what `audit_findings` already is, and it currently holds **894 open rows
that nobody reads** (381 `c1_inbound`, 361 `c3_outbound`). A second undifferentiated
finding generator makes that worse, not better. So the suite has exactly two
tiers, with different homes, different consequences, and a hard numeric budget:

**Tier A — REFUSALS.** A statement that, if false, means some number is
_certainly_ wrong. Provable from the data alone, no judgement, no threshold.
Breaking one is an incident. It pages per ADR-0037, and where the invariant
guards a money path the code path itself refuses.

> **Budget: 15, for the lifetime of the project.** Adding a sixteenth requires
> deleting one or writing an ADR that argues the budget up. A refusal tier with
> forty members is an advisory tier wearing a costume.

**Tier B — IMPLAUSIBILITIES.** A statement that some value is outside anything
this system has ever seen. Statistical, thresholded, arguable. **It never pages.**
It writes an `audit_findings` row under a new check code and surfaces on `/admin`
and in the existing daily digest.

The reason both tiers must exist is tonight's defect, and it cuts against
intuition: **Tier A would not have caught it.** There is no provable statement
that 6,020 units on one haul is false — MyMRC asserts it, and MyMRC is the system
of record. Only Tier B catches it, and only as "this is 30 standard deviations
from every haul ever recorded, look at it." Conversely Tier B would never have
caught the 2,193-unit duplicate, which is an exact, provable double-count.

A suite with only Tier A is blind to the class of defect that actually happened
tonight. A suite with only Tier B is a backlog.

### D2 — Invariants live beside the code whose assumption they encode

Not in a central `invariants/` directory. The failure mode of a central registry
is that it becomes a second document maintained in parallel with the ADRs, and
drifts from both. Instead:

```
src/lib/inventory/invariants.ts      ← pins running-balance.ts's assumptions
src/lib/mymrc/invariants.ts          ← pins the bridges' assumptions
src/lib/cor/invariants.ts            ← pins the COR filing path's assumptions
src/lib/invariants/registry.ts       ← imports them; holds no invariants itself
src/lib/invariants/types.ts          ← the Invariant interface
src/lib/invariants/run.ts            ← the runner
```

A guard test fails the build when an `invariants.ts` exists that `registry.ts`
does not import. This repo already has exactly this pattern and it works —
`src/lib/inventory/__tests__/snapshot-void-readers.guard.test.ts` parses the
actual source of every `siteInventorySnapshot` read in `src/` and fails on any
that neither carries `NOT_VOIDED` nor appears in a reasoned allowlist. Copy it.

### D3 — Every invariant names the ADR it pins, and the link is enforced

```ts
export interface Invariant {
  id: string; // 'INV-INBOUND-PLAUSIBLE'
  tier: 'refusal' | 'implausibility';
  adr: string; // '0131' — must resolve to docs/adr/<n>-*.md
  /** The sentence from that ADR this invariant makes falsifiable. Verbatim. */
  assumption: string;
  /** Sites this applies to, or 'all'. */
  scope: 'all' | 'per-site';
  severity: 'urgent' | 'high' | 'default';
  /** One query. Returns the violating rows — empty means PASS. */
  check(db: PrismaClient, siteId: string | null): Promise<InvariantViolation[]>;
  /** What a human should DO. Not what broke — what to do about it. */
  remedy: string;
}
```

`assumption` is the load-bearing field and it is quoted **verbatim** from the
ADR. That is what makes the invariant and the ADR impossible to drift apart
silently: if someone edits the ADR sentence, the string no longer matches, and a
build test that greps the ADR for it goes red.

### D4 — An ADR that makes a data assumption declares it, and CI enforces that

The ADR template gains one required section:

```markdown
## Data assumptions

| Assumption                                                           | Invariant               | Tier           |
| -------------------------------------------------------------------- | ----------------------- | -------------- |
| Every Delivered haul carries a `Recycler_Reported_Delivery_Date__c`. | `INV-HAUL-DATED`        | refusal        |
| A haul's unit count is a truckload, not a month.                     | `INV-INBOUND-PLAUSIBLE` | implausibility |
```

or, explicitly:

```markdown
## Data assumptions

None. (This ADR changes only rendering; it reads no field it does not write.)
```

`src/__tests__/adr-record-integrity.test.ts` already exists and already fails CI
when two ADRs claim one number. Extend it: fail when an ADR has no `## Data
assumptions` section, and fail when that section names an invariant id that no
`invariants.ts` declares. **That is the answer to "how does one get added when a
new ADR makes a data assumption" — it is not a process, it is a red build.**

One implementation note, because this ADR is its own counter-example: **the
parser must be fence-aware.** The two blocks above are fenced ` ```markdown `
samples, so a naive `grep '^## Data assumptions'` finds _three_ matches in this
file and exactly one of them is the real section (§ below, before
"Consequences"). Strip fenced blocks before matching headings, and pin that with
a test that runs the parser over ADR-0131 itself and asserts it finds one
section, not three. An ADR-parsing check that cannot read an ADR about
ADR-parsing checks is not worth having.

### D5 — When an invariant is itself wrong: quarantine, never delete

An invariant will eventually be wrong — encoding an assumption that was true when
written and has legitimately changed. That is not a failure of this design, it is
the thing it is for, and it must have a path that is faster than a deploy.

A small `invariant_state` table: `(invariant_id, mode, reason, expires_at,
set_by, set_at)`, written through an audited `/admin` action.

- Mode is **`observe`**, never `off`. An observing invariant still runs, still
  records, still appears in the digest; it simply does not page.
- `reason` is mandatory and free text. "Why do we currently believe this
  statement is wrong?"
- `expires_at` defaults to **14 days** and is capped at 90. **Quarantine expires;
  it does not persist.** An invariant that keeps needing re-quarantine is telling
  you to either fix the data or amend the ADR, and the expiry is what forces that
  conversation instead of letting an off-switch calcify.
- Every quarantined invariant is listed, with its reason and its remaining days,
  at the top of the weekly digest. A silent off-switch is how you get a second
  `c5_conservation`.

Deleting an invariant is also allowed, but only together with an amendment to the
ADR whose `assumption` it quoted — because the invariant's existence is the
evidence that someone once believed the sentence.

### D6 — Not a new storm

This is the constraint Bill actually asked about, and ADR-0130 shipped the
mechanism three days ago.

- **Storage:** the Postgres `alert_cooldowns` table (`src/lib/mymrc/cooldown-store.ts:82`),
  atomic conditional upsert. Not an in-process `Map` — the runner is a one-shot
  cron process and an in-process ledger dies with it, which is precisely the
  ADR-0130 defect.
- **Fingerprint:** `invariant:<id>:<site>`. Per-invariant, per-site.
- **Cooldown:** 24 h.
- **Transition-only paging.** Page on **PASS → FAIL**, and once on **FAIL → PASS**
  (the all-clear, `default` priority). A _still-broken_ invariant does not page
  again — it is not news, and ADR-0037's gate question 3 is exactly this. This is
  the single largest volume control in the design: tonight's defect would have
  produced **one** page on 2026-09-04, not one per day for six days.
- **Grading (ADR-0037 §5 rubric):** Tier A money-path invariants (the COR and
  billing ones) are `high`. Tier A non-money invariants are `default`. Tier B
  pages **never** — it is a dashboard tile and a digest line, which is what
  ADR-0037 says "below default" means.
- **Expected steady-state volume: zero.** A passing suite is silent. If this
  design produces a recurring page, the correct response is to fix the data or
  quarantine the invariant — never to widen the cooldown.

### D7 — Where it runs, and what it costs

On the **existing** `dr3-vision-audit-sweep` container
(`scripts/audit-sweep-cron.mjs`), immediately before the existing sweep. No new
container, no new image, no new cron entry.

**Measured, not estimated.** The eight candidate invariants in D8 were run
against the live production database tonight as a single `psql` script:

```
real    0m0.115s
```

115 ms for the full set, including process start. Every one is a single indexed
aggregate over a table the sweep already reads. The marginal cost of this ADR is
therefore _nil at the resolution the cron can measure_ — the audit sweep it rides
on already runs for minutes. **Cost is not a reason to skip an invariant**, and
this number is here so that nobody argues otherwise later.

### D8 — The seed set

Run tonight against production. Result recorded, because an invariant whose
first run is green is worth as much as one that fires — it converts a belief into
a measurement.

| #   | Id                            | Tier               | Statement                                                                                                                                                                                            | Result tonight                                             |
| --- | ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `INV-ANCHOR-POOLS-SUM`        | refusal            | A non-voided `measured` snapshot has `program_units + non_program_units = units_indoor + units_total + units_in_processing`.                                                                         | **PASS** (0 rows)                                          |
| 2   | `INV-ANCHOR-FRESH`            | refusal            | Every active site has a non-voided physical anchor newer than 14 days.                                                                                                                               | **FAIL** — Eugene has none ever; Woodland's is 24 days old |
| 3   | `INV-ANCHOR-UNIQUE`           | refusal            | No two non-voided physical snapshots share `(site_id, snapshot_at)`.                                                                                                                                 | **PASS** (0 rows)                                          |
| 4   | `INV-ANCHOR-PACIFIC-MIDNIGHT` | refusal            | Every non-voided physical anchor is stamped 07:00:00 or 08:00:00 UTC.                                                                                                                                | **PASS** (0 rows)                                          |
| 5   | `INV-SNAPSHOT-ONE-COLUMN`     | refusal            | No snapshot has both `units_indoor` and `units_total` set. (CA uses one, OR the other; nothing enforces it, and four surfaces read `units_total ?? units_indoor` while the balance reads their sum.) | **PASS** (0 rows)                                          |
| 6   | `INV-INBOUND-SPLIT-SUMS`      | refusal            | A verified inbound row has `program + non_program = total_units`.                                                                                                                                    | **PASS** (0 rows)                                          |
| 7   | `INV-WORKBOOK-PATH-TOKEN`     | refusal            | Every `workbook_sources.folder_path` contains a `{` token.                                                                                                                                           | **PASS** (1/1)                                             |
| 8   | `INV-INBOUND-PLAUSIBLE`       | **implausibility** | No Delivered General haul carries more units than the largest container can hold. Threshold **350** — the observed maximum ever is 342, over 6,551 rows.                                             | **FAIL** — H-138391 (6,020), H-139774 (4,840)              |

Two more that tonight's evidence demands and that were not in the starting
proposal:

| #   | Id                          | Tier               | Statement                                                      | Rationale                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------- | ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | `INV-FLOOR-WITHIN-CAPACITY` | **implausibility** | `onHand(site).total` does not exceed `sites.max_units_indoor`. | Woodland's floor has read **11,668 against a 3,500 cap** for six days and no surface said a word. This is the cheapest possible sanity check on the whole ledger and it did not exist.                                                                                                                       |
| 10  | `INV-COR-HAS-ANCHOR`        | **refusal**        | A COR cannot be generated for a site with no physical anchor.  | `computeCorPrefill` does not require one. With no anchor, `onHand` returns _every flow row since 1970_ and the only gate before that number is printed on the Exhibit 5 Rick signs is `assertCorInventoryNotNegative`. There is no upper bound and no anchor-presence check. **Eugene has no anchor, ever.** |

`INV-FLOOR-WITHIN-CAPACITY` is Tier B rather than Tier A deliberately: a floor
legitimately over capacity is an operational emergency, not a data error, and
paging `urgent` on it would be paging about mattresses rather than about numbers.

## Data assumptions

This ADR introduces the section, so it declares its own first.

| Assumption                                                                                                                             | Invariant                                        | Tier           |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------- |
| No Delivered General haul carries more units than its container can hold. Threshold 350; observed maximum ever is 342 over 6,551 rows. | `INV-INBOUND-PLAUSIBLE`                          | implausibility |
| A site's computed on-hand does not exceed `sites.max_units_indoor`.                                                                    | `INV-FLOOR-WITHIN-CAPACITY`                      | implausibility |
| A COR is never generated for a site with no non-voided physical anchor.                                                                | `INV-COR-HAS-ANCHOR`                             | refusal        |
| `invariant_state.mode` is only ever `observe`; no invariant can be switched off.                                                       | enforced by a CHECK constraint, not an invariant | —              |

The other seven seeded in D8 pin assumptions belonging to ADR-0037, ADR-0078,
ADR-0084 and ADR-0089. Those ADRs gain this section by amendment as each
invariant lands, quoting the sentence the invariant makes falsifiable — that
backfill is part of D8's implementation, not a separate task.

## Consequences

**What this buys.** The gap between "the code is correct" and "the number is
right" becomes measurable and gets a name. Tonight that gap was 10,630 program
units and six days wide. Every ADR from here carries a falsifiable claim about
production data instead of a paragraph of prose, and the claim is checked daily
by something that cannot forget.

**What it costs.** Ten more things that can page. Mitigated by the Tier A budget,
by Tier B's absolute prohibition on paging, by transition-only delivery, and by
the measured 115 ms. The honest residual risk is **budget erosion**: every future
session will believe its invariant is the important one. The budget is written as
a number here so that spending it requires amending this ADR.

**What it does not fix.** Three things, stated plainly so nobody assumes otherwise:

1. **It does not fix the data.** Two hauls in MyMRC are wrong, and no invariant
   can correct a value in someone else's Salesforce org. The suite converts a
   silent 28× error into a page within 24 hours. That is the entire claim.
2. **It does not read the 894 open `audit_findings`.** That backlog is a separate
   problem and Tier B will add to it. Whether an unread finding is better than no
   finding is a real question; this ADR bets that it is, _provided_ the tier that
   pages stays small enough to be believed. If the backlog is never triaged, Tier
   B's value is limited to being searchable after the fact — which is still more
   than tonight had.
3. **It does not close the second-implementation problem.**
   `src/lib/audit/leg-fetchers.ts:456` (`startBalance`) is a genuine second
   database implementation of `onHand`, with its own anchor query lacking the
   ADR-0078 `created_at` tiebreak and a bare drop-off sum that silently absorbs
   an untaught kind where `onHand` throws. ADR-0037 D6's premise was "ONE shared
   function … never two competing sums," and there are two. An invariant could
   compare their outputs; that is a candidate for the budget, not something this
   ADR ships.

**The falsification.** If this design is right, then re-running D8's seed set
against production on any day between 2026-09-04 and tonight fires
`INV-INBOUND-PLAUSIBLE` and `INV-FLOOR-WITHIN-CAPACITY`, and Bill learns on the
5th instead of the 10th. That is checkable and it is the standard this should be
held to.

## The one-off audit this ADR requires

Bill's narrower question — **"what else is a shipped ADR whose production data was
never moved?"** — is not answered by a suite that starts today. Every ADR that
claims a production data repair asserts a fact about the database at the moment it
was written, and none of those facts has been re-checked since.

Four were re-checked tonight, as the method's proof:

| ADR / doc                    | Claim                                                        | Tonight                                                          |
| ---------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| ADR-0089 D4                  | 0 dateless Delivered hauls remaining                         | **HOLDS** — 0 / 6,551                                            |
| ADR-0089 §5 residual         | stale aggregate rows whose mirror day-group is empty         | **HOLDS** — 0 rows                                               |
| ADR-0037 D-3                 | both prod anchors re-stamped to Pacific midnight             | **HOLDS** — 4/4 at 07:00Z                                        |
| ADR-0078 D1                  | pre-existing snapshots backfilled `created_at = snapshot_at` | **HOLDS** — the 2 pre-existing rows                              |
| 2026-07-30 diagnosis, item 5 | 2,193-unit duplicate processed overstatement to be re-run    | **FAILS — never executed.** Both rows untouched since 2026-07-24 |

One hit in five, found in a single query, forty-two days stale, in the billing
path. The full sweep is scoped as **`0.BS` item 3** in `docs/OPEN-ITEMS.md`: walk
every ADR and dated finding that claims a production data repair, re-assert it,
and record the result — HOLDS or FAILS — as a table in this ADR. Anything that
FAILS becomes either a data repair or a Tier A invariant, so that it can never go
stale unobserved again.

---

## Amendment 1 (PROPOSED — Bill decides; nothing below is built)

**Date:** 2026-09-11 · **Author:** Aegis · **Status:** Proposed, not accepted.

**The question asked:** is there a defensible mechanism for excluding a disputed
upstream row from the computed balance — something that keeps the mirror faithful to
MyMRC while the ledger stops repeating a number we have established is impossible?

### The recommendation, in order

**1. Take the physical count (BS-3). It is the answer to THIS incident, and it needs
no code.** A count today re-anchors the ledger; `anchorFlowBounds` then excludes
every flow before it, so both phantom hauls fall behind the anchor and the floor
self-corrects to the counted truth within one working day. This is not a workaround —
re-anchoring is precisely the mechanism ADR-0037 D6 built for "the ledger has drifted
from the building", and the `reconciled_delta` it produces _measures_ how wrong the
ledger was, which is evidence worth having. It also trips the 20% swing guardrail as
designed, which is the system asking a human to confirm on the way through.

**Build nothing until BS-3 has been tried.** A new mechanism for a problem an
existing mechanism already solves is how a system accumulates the second
implementations this ADR spent its Consequences section complaining about.

**2. If upstream disputes recur, build a dispute record — with six conditions.** One
bad haul is an incident; a pattern is a missing capability. The shape:

An `inbound_haul_disputes` table keyed on `external_haul_id`, recording the value
MyMRC asserts, the value DR3 believes, the evidence (BOL or dock paperwork
reference), the filer, and an expiry. The bridge consults it when writing
`inbound_loads` day aggregates.

The conditions are not decoration — without all six this is a second source of truth
for a billed quantity, which is the exact failure this ADR exists to prevent:

1. **The mirror is never touched.** Disputes live in their own table. ADR-0084's
   standing rule holds, and the next scrape would overwrite an edit anyway.
2. **A dispute is a DR3 ASSERTION, not a correction of MRC's record.** It says "we
   believe this row is wrong, here is why"; it does not claim MRC agrees.
3. **It cannot silently change a number.** Every surface rendering a figure derived
   from a disputed haul must say so, with the same discipline as the `legacy` anchor
   badge and the new over-capacity banner. A quietly-filtered ledger is worse than a
   loudly-wrong one, because nobody can see which they are looking at.
4. **It expires** — 30 days, capped, on the D5 quarantine model. A dispute that keeps
   needing renewal means nobody is chasing MRC, and the expiry is what forces that
   conversation instead of letting the filter calcify.
5. **Admin-only and audited.** One `audit_log` row per dispute, per ADR-0131 D5.
6. **It NEVER reaches the COR.** This is the condition that makes the rest
   defensible. A disputed haul in the filing window must **block** the COR, not
   change it.

### Why condition 6 is the whole design

The floor tile and the COR are different numbers with different audiences and
different consequences, and the current system conflates them. The floor tile tells
the crew what is in the building — being _approximately right and clearly caveated_
serves that. The COR is a regulatory filing against MRC's own system of record;
filing a number that silently disagrees with what MRC holds, without MRC having
corrected it, is a worse problem than filing late. Tonight the same
`computeRunningBalance` output feeds both.

So a dispute may correct the **operational** floor and is forbidden from touching the
**regulatory** filing. That split is worth having independently of whether disputes
are ever built.

### The tradeoff, stated plainly

**What it buys:** the iPad stops showing a number everyone knows is false, within
hours of someone noticing, without waiting on another company's ticket queue.

**What it costs:** a second place where a billed quantity can be decided, and a
filter between MyMRC and the ledger that did not exist before. Every reconciliation
against MRC's records gets harder, because DR3's number and MRC's number now differ
_by design_ and someone has to hold both. The six conditions bound that cost; they do
not remove it.

**The honest risk:** condition 3 is the one that erodes. Badges get dropped in a
redesign, and a dispute filter that has lost its badge is an invisible adjustment to
a billed number. If this is built, the badge needs a guard test on the same model as
`anchor-tiebreak.guard.test.ts`, not a code-review convention.

**What I would not do:** filter on a threshold. An automatic "ignore hauls over 350
units" rule would have fixed tonight and would silently delete a real 400-unit haul
the first time one arrived. `INV-INBOUND-PLAUSIBLE` exists to make a human look; it
must not become a mechanism that acts.
