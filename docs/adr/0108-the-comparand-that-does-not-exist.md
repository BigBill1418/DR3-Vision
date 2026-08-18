# ADR-0108 — The comparand that does not exist, and the outlier that does

**Date:** 2026-08-18 (Pacific)
**Status:** Accepted and implemented.
**Asked for by:** Bill, via handoff #264 — reconcile the outbound weights that ADR-0104 absorbed, and flag the variances.
**Builds on:** ADR-0104 (the absorbed outbound weights and the coverage read), ADR-0077 (the triple-count and the version pin), ADR-0071 (`processor_quota_config` — the runtime-tunable config table this copies), ADR-0080 §D7 (a guess made first becomes the default by inertia), ADR-0069 Am.2 (a blank is not a zero).
**Deliberately does NOT do:** settle AK-4c; render any verdict; open any alert, email or ntfy path; build dollar-side matching; promote a staged batch; touch any operational table.

---

## Context

Handoff #264 asked for two things. Item 5 was verification: confirm that the §12
reconcile module and coverage page ADR-0104 promised actually shipped and match
their contract. Item 6 was new work: **expected-vs-actual variance flagging** on
outbound loads, with editable thresholds.

Item 5 verified green (§1 below). Item 6 did not survive contact with the data,
and most of this ADR is about what replaced it.

---

## 1. Item 5 — the reconcile view, verified clause by clause

Verified 2026-08-18 against `main` at `cbab98b1` and against prod
(`dr3-vision-postgres` on CHAD-HQ). Every clause of plan §12:

| §12 clause                                                           | State               |
| -------------------------------------------------------------------- | ------------------- |
| `OutboundScope = 'confirmed' \| 'staged'`, **never a union**         | green               |
| `latestVersion(siteId, scope)` on the `commodity-ledger.ts` contract | green               |
| `computeOutboundCoverage(...)` exported                              | green               |
| Version pinned FIRST, aggregation only inside it (ADR-0077)          | green               |
| `versionId` returned and **rendered on the page**                    | green               |
| Per calendar month: mirror loads, with weight, without, summed lbs   | green               |
| Commodity breakdown, inside the pinned revision                      | green               |
| Join on `doc_outbound_load_rows.external_materials_id` ↔ mirror      | green               |
| No threshold, no tolerance, no `ok`/`mismatch` verdict, no alert     | green               |
| Page read-only and says so in the header                             | green               |
| Uncovered count stated plainly and expected to be large              | green               |
| Uncovered count **labelled expected-out-of-range, not data loss**    | amended by this ADR |

The last row was the one gap. The footer paragraph explained the uncovered count
correctly, but the stat tile at the top of the screen — the number a reader
actually sees — carried the hint _"no watched document supplies these"_, which is
true and reads like a fault. It now reads **"expected — outside the workbook's
range, not missing data"**, and a test asserts that string. The distinction
matters because the number is ~3,850 and a reader who takes it for data loss goes
hunting a bug that is not there (P-47).

Prod state at verification, staged scope, pinned revision
`7829de7b-1ac9-4e65-b209-588b79496ec5`:

```
 status |         doc_source_version_id         | rows | with_weight |   lbs
--------+--------------------------------------+------+-------------+---------
 staged | 7829de7b-1ac9-4e65-b209-588b79496ec5 |  831 |         831 | 5619037

 mirror_rows | mirror_weights |  ids
-------------+----------------+------
        4685 |              0 | 4685
```

Both ADR-0104 batches are still **staged** — Bill has not confirmed them
(OPEN-ITEMS §0.BB). The coverage page therefore reads empty at `confirmed` scope
by design and shows the figures at `staged`. Everything this ADR adds follows the
scope the page is rendering and **never promotes staged to confirmed**.

---

## 2. The premise of Item 6 is dead, and it is worth recording why

Handoff #264 assumed a comparand: an expected weight in `mymrc_outbound_mirror`
to hold the workbook's absorbed weight against. Measured against prod before any
code was written:

| Claim to check                                    | Measured 2026-08-18 |
| ------------------------------------------------- | ------------------- |
| Mirror rows                                       | 4,685               |
| Mirror rows with `weight_lbs` set                 | **0**               |
| Mirror rows whose payload text mentions "weight"  | **0**               |
| Joined loads (workbook ∩ mirror, pinned revision) | 831                 |
| …of those, with a **positive** unit count         | **1**               |
| Workbook total-vs-parts drift, per load           | **0 on 831 of 831** |

There is no expected-vs-actual **weight** pair. There is no lbs-per-unit
denominator to manufacture one from — 1 of 831 loads carries a positive unit
count, so any per-unit rate would be an extrapolation from a single observation.
And the workbook's own internal check — total weight against the sum of its
commodity columns — is already reconciled at **zero drift on every one of the 831
loads**, because that reconciliation happened at absorption time (ADR-0104 §D2).
Re-reporting it would be a screen that can only ever say "0".

Building an expected side anyway would mean inventing it, and an invented number
that arrives first becomes the definition by inertia — ADR-0080 §D7, the same
mechanism that gave the commodity tracker a shape nobody had agreed to.

### 2.1 The near-miss, recorded so nobody re-derives it

39 mirror rows **do** carry per-commodity pound figures, under Salesforce keys
named for the commodity rather than for weight — `Waste__c`, `Wood__c`,
`Steel__c`. This is why a key-name search for "weight" returns nothing while a
comparand column does, in principle, exist.

It is not usable, for a measured reason: those 39 rows are all **March 2024**
(`2024-03-01` to `2024-03-21`), and their overlap with the workbook's Jan–Jun
2026 loads is **zero**. Detail capture ran on all 4,685 rows, but only 39 came
back carrying commodity fields.

**If detail coverage were ever extended over the workbook's range, a real
expected-vs-actual pair would exist and this ADR should be revisited.** That is a
concrete, checkable condition rather than a vague future.

---

## 3. What the data does support

A weaker, honest comparison: **a load's commodity weight against the other loads
of the same commodity.** That needs no external comparand — the distribution is
the comparand — and it surfaces the thing a human actually wants to see, which is
a row that looks mis-keyed.

Measured distribution, pinned revision `7829de7b`, 869 commodity rows carrying a
weight above zero (of 1,699 absorbed; the other 830 are recorded zeros, which are
a claim of "carried none" and not a weight — ADR-0069 Am.2):

| Commodity                        |   n | Median (lb) | Linear MAD (lb) | Spread step (×) |
| -------------------------------- | --: | ----------: | --------------: | --------------: |
| Waste                            | 334 |       4,150 |             810 |          1.2235 |
| Steel                            | 268 |       7,380 |           1,110 |          1.1709 |
| Wood                             | 220 |       3,170 |             790 |          1.3026 |
| Foam                             |  29 |      36,300 |           2,660 |          1.0766 |
| Quilt and Toppers                |  10 |      35,144 |           1,620 |          1.0481 |
| Cotton                           |   3 |         126 |              71 |          2.2909 |
| Cardboard                        |   2 |       3,604 |           1,410 |          1.4650 |
| Shoddy/Felt                      |   1 |      21,000 |               0 |          1.0000 |
| Plastics                         |   1 |       4,426 |               0 |          1.0000 |
| Whole Mattresses and Foundations |   1 |          55 |               0 |          1.0000 |

Two corrections to the figures the handoff carried, both minor and both recorded
so the next reader does not re-derive them: the brief cited _n = 1,699 rows > 0_,
which is the **all-rows** count — rows above zero are **869**; and it omitted the
two singleton commodities `Shoddy/Felt` and `Whole Mattresses and Foundations`.
Every per-commodity `n` in the brief matched exactly.

Real keying-error-shaped rows exist. `Wood 40 lb` against a 3,170 lb median.
`Foam 1,251 lb` against 36,300 — both on the **same load**, `M-177843`.
`Cotton 55 lb` alongside `Cotton 23,820 lb` in a three-row population.

---

## 4. The decision, and the measurement that changed its shape

The obvious form is a symmetric `median ± k × MAD` bound in pounds. **Measured,
it cannot work**, and the reason is structural rather than a matter of tuning.

Load weights are strictly positive. So the largest low-side deviation any row can
physically have is the median itself, and the low side is capped at `median / MAD`
deviations:

| Commodity | Median |   MAD | Low-side cap |
| --------- | -----: | ----: | -----------: |
| Wood      |  3,170 |   790 |   **4.01** σ̃ |
| Waste     |  4,150 |   810 |       5.12 σ̃ |
| Steel     |  7,380 | 1,110 |       6.65 σ̃ |

A linear bound at any `k ≥ 4.01` **can never flag a low Wood weight, however
absurd** — a Wood row of 1 lb is 4.01 MAD out and a Wood row of 0.001 lb is also
4.01 MAD out. And `Wood 40 lb`, the canonical keying-error row this was built to
surface, sits at **3.96** — just inside. At `k = 5` linear it does not flag; at
`k = 4` it barely does, and 42 other rows come with it. A detector structurally
incapable of reporting the defect it exists for is worse than no detector,
because its silence reads as health.

**So the deviation is measured in log space.** `median` and `MAD` are computed
over `ln(lbs)`, which makes the bound multiplicative and genuinely two-sided:

```
low  = median / ratio^k        high = median × ratio^k
```

`Wood 40 lb` then lands **16.5 steps** out. The form also reads better to the
people who will retune it: `spread_ratio` is one MAD step as a multiplier, so the
sentence is _"a typical Waste load is within a factor of 1.22 of 4,150 lb, and
the line is six steps out"_ rather than an opaque `k`.

### 4.1 Why k = 6

Measured flag volume across the whole pinned revision, log space, floor n ≥ 20:

| k     | Flagged rows | Flagged loads | % of 831 |
| ----- | -----------: | ------------: | -------: |
| 3     |           95 |            94 |    11.3% |
| 4     |           61 |            60 |     7.2% |
| 5     |           42 |            41 |     4.9% |
| **6** |       **15** |        **14** | **1.7%** |
| 8     |            6 |             5 |     0.6% |

`k = 6` is the choice, for three reasons stated in order of weight:

1. **Volume a human will actually read.** 14 loads is an exception list. 41 is a
   report, and 60 is a spreadsheet nobody opens twice. The value of a
   look-at-this collapses the moment it stops being exceptional.
2. **It still catches every keying-error-shaped row the measurement named** —
   `Wood 40 lb` (16.5 out), `Foam 1,251 lb` (45.6), `Waste 280 lb` (13.4),
   `Steel 24,840 lb` (7.7).
3. **It sits at the conventional extreme-outlier line.** `MAD × 1.4826` estimates
   σ for a log-normal, so six MAD steps ≈ 4.05σ. Under log-normality that is
   about 1 in 20,000 by chance; observing 1.7% says the tails are real
   operational spread and real errors, not noise — which is exactly why a
   3σ-equivalent line (`k ≈ 4.4`) would drown the list.

`k` is a column, not a constant. This is a starting point, not a finding.

### 4.2 Why a minimum-n floor of 20

Below 20 observations the spread is not estimable and a bound derived from it is
a guess wearing a number. The live data makes the point without argument:

- **Cotton, n = 3** — spread step ×2.29, i.e. a "typical" load varies by a factor
  of 2.3. Its `k = 6` band computes to **1 lb – 18,215 lb**, which excludes
  nothing and would still have flagged the 23,820 lb row on the strength of three
  observations.
- **The three singletons** — `Shoddy/Felt`, `Plastics`, `Whole Mattresses and
Foundations` — all have a spread step of exactly **1.0000**, so their band is
  zero-width and would flag every load that is not _precisely_ the median.

The floor turns flagging off for six of the ten commodities and leaves
Waste/Steel/Wood/Foam live — 851 of the 869 weighted rows. The screen **says** a
commodity is unflagged and why, rather than leaving a silent gap: an absent rule
is not a passing grade. The zero-width case is caught separately (`no_spread`)
because it can be reached by an operator's edit as well as by the seed.

---

## 5. The dollar side is BLOCKED, and nothing was built for it

Handoff #264 also asked for expense-to-load matching. **No join key survives
measurement**, so none was built. Measured 2026-08-18:

| Candidate join                              |   Overlap |
| ------------------------------------------- | --------: |
| Expense rows total / with an invoice number | 332 / 262 |
| Distinct normalized invoice numbers         |       233 |
| Distinct normalized mirror BOL ids          |     4,628 |
| **Normalized invoice # ↔ mirror BOL id**    |     **4** |
| **Normalized invoice # ↔ Materials ID**     |     **0** |
| **`commodity_raw` ↔ Materials ID**          |     **0** |
| Expense rows carrying a `haul_ref`          |     **6** |

Every one of those is a refusal:

- **4 of 233** against a 4,628-row candidate pool is collision territory, not a
  signal. Both sides contain bare numerics (`743833` against `1339567`), so a
  handful of accidental equalities is the expected result of comparing two
  unrelated numbering schemes. Shipping a match on it would fabricate four
  load-to-invoice links that mean nothing, and they would be indistinguishable on
  screen from real ones.
- **`commodity_raw` holds 12 distinct commodity _names_**, never an id. It was
  never a join key; the handoff's hypothesis was that it might carry one.
- **The 6 `haul_ref` values are all `H-` prefixed** (`H-130100`, `H-130826`, …) —
  **inbound** hauls. Outbound loads are `M-` prefixed. These are not the same
  namespace and matching them would be a category error.

This is reported blocked rather than approximated. Bill's standing rule is that
the data gets a veto, and a fabricated dollar match is worse than an empty
screen: an empty screen is obviously empty, and four wrong links look like a
working feature.

**To unblock:** the expense log would need a load or BOL reference written into it
at the point of entry, or MyMRC would need to expose an invoice number on the
outbound record. Neither exists today, and neither can be inferred from what does.

---

## 6. The honesty rails

These are the properties that make the flags safe to look at, each with the test
that holds it.

1. **Version-pinned.** `computeOutboundVariance` takes `versionId` as a
   **required, non-defaulted argument** — there is no code path that computes a
   flag without one, and the page hands over the pin `computeOutboundCoverage`
   already resolved rather than re-deriving it. Falsified: with the version
   clause deleted, the suite flags a 40 lb row that the winning revision had
   already corrected to 3,300 (§8).
2. **An uncovered load is NOT COVERED.** It has no absorbed row, so there is
   nothing to be unusual, and it is never flagged and never described as "0
   variance". Three separate tests: no row at all, a row whose weight cell was
   blank, and a **recorded zero** — the last matters because treating `0` as a
   weight would flag 830 rows that are stating "this load carried none of this
   commodity".
3. **No verdict.** The review object exposes no `ok`, `verdict`, `mismatch`,
   `tolerance`, `error` or `dispute` field, and a flag carries exactly seven
   keys: the load, the commodity, the weight, the band, the direction and the
   distance. The rendered copy is scanned for the vocabulary of blame and the
   test fails the build on any of it.
4. **No alert channel.** Neither surface may reference `ntfy`, `sendMail`,
   `sendEmail`, `notify` or `publishAlert`, asserted. A flag is something a
   person finds when they go and look. If that ever needs to change, it is a
   decision, and the decision will have to delete a test.
5. **Scope is carried, never widened.** Flags are computed at the same scope the
   page renders. A staged flag stays staged; looking at it promotes nothing.
6. **The seed does not revert an operator.** The migration's seed is
   `ON CONFLICT DO NOTHING`, verified on a fresh PG16: after an operator changed
   Wood's `k` to 3, re-running the seed left it at 3 and inserted no duplicate.

**AK-4c is untouched.** What a difference _means_, and at what size it matters,
remains Bill's decision with Rick and Janette — and has had no owner since
Kelsey's availability ended 2026-08-08. This ADR moves the line from "nothing is
surfaced" to "unusual rows are surfaced against a number you can change". It does
not decide anything.

---

## 7. What shipped

- `outbound_variance_config` — one row per (site, commodity), carrying
  `median_lbs`, `spread_ratio`, `k`, `min_sample_n`, `enabled`, plus provenance
  (`sample_n`, `seeded_from_version_id`, `seed_measured_on`). Additive migration
  `20260849_adr0108_outbound_variance_config`, replays clean on an empty PG16 and
  seeds **nothing** when no site exists.
- `src/lib/doc-ingest/outbound-variance.ts` — the read. Read-only, version-pinned
  by signature.
- `/admin/doc-ingest/outbound-variance` — the editing surface, admin-only, with
  the effect of every field restated in pounds as you type, because `k = 6` means
  nothing and `1,237 lb – 13,921 lb` means everything.
- `PATCH /api/admin/doc-ingest/outbound-variance` — admin-gated, logs who moved a
  line and from what to what.
- The coverage page gains a **"Loads to look at"** section and the corrected
  uncovered-count label.

### Seeded bands (k = 6, as they will render)

| Commodity                        |   n | Band at k = 6      | Flagging                    |
| -------------------------------- | --: | ------------------ | --------------------------- |
| Waste                            | 334 | 1,237 – 13,921 lb  | on                          |
| Steel                            | 268 | 2,864 – 19,018 lb  | on                          |
| Wood                             | 220 | 649 – 15,485 lb    | on                          |
| Foam                             |  29 | 23,312 – 56,524 lb | on                          |
| Quilt and Toppers                |  10 | —                  | off — 10 loads, 20 needed   |
| Cotton                           |   3 | —                  | off — 3 loads, 20 needed    |
| Cardboard                        |   2 | —                  | off — 2 loads, 20 needed    |
| Shoddy/Felt                      |   1 | —                  | off — 1 load, and no spread |
| Plastics                         |   1 | —                  | off — 1 load, and no spread |
| Whole Mattresses and Foundations |   1 | —                  | off — 1 load, and no spread |

---

## 8. Falsification — the failures, quoted

Every guard below was observed failing against the naive implementation before it
was observed passing. A guard that has never failed proves nothing.

**The version pin.** Deleting `doc_source_version_id` from the module's `where`:

```
FAIL  src/lib/doc-ingest/__tests__/outbound-variance.test.ts > the version pin
      (ADR-0077) excludes a superseded revision > does not flag a load the
      winning revision already corrected
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   Object {
+     "commodity": "Wood",
+     "direction": "below",
+     "externalMaterialsId": "M-9",
+     "highLbs": 15485.419154842697,
+     "lowLbs": 648.9183857356218,
+     "stepsOut": 16.54018612813713,
+     "weightLbs": 40,
+   },
+ ]
```

The fixture is built so this cannot pass by accident: the superseded revision
says 40 lb and the winning one says 3,300 lb, both left `staged`, and a companion
test reads the superseded revision **on purpose** and asserts the 40 lb row _is_
flaggable there. Without that second test, a module that returned nothing at all
would also have passed the first.

**The copy guard caught its own author.** The first draft of the settings page
said a flagged load "is not called wrong, disputed or in error" — a disclaimer,
but it put two banned words on screen. The scan failed the build:

```
FAIL  the coverage page contains none of the verdict words
AssertionError: expected [ 'mismatch', 'dispute', 'error' ] to deeply equal []

FAIL  the settings page contains none of the verdict words
AssertionError: expected [ 'dispute', 'error' ] to deeply equal []
```

The fix was **not** to weaken the guard. Full-line comments are now excluded —
the file must be able to name the words it bans, and a guard that punishes its
own disclaimer teaches the next author to delete the disclaimer — and the
rendered sentence was reworded. The comment stripper is itself falsified twice:
once proving a verdict word in rendered JSX survives it, and once proving a line
containing `https://` is not truncated, because a naive strip-to-end-of-line
would hide any verdict word sitting after a URL.

**Also held, each failing first against the obvious wrong implementation:** a
recorded `0` is not a low outlier; a blank weight cell is not a low outlier; a
commodity below the floor never flags (and flags immediately when the floor is
lowered, proving the floor is what silences it, not an accident of the fixture);
a zero-width spread refuses rather than flagging everything; a commodity with no
config row is reported as unbounded rather than treated as within bounds; the
band moves when the config row moves, with no code change.

---

## 9. Consequences

- The coverage page acquires its first opinion-adjacent element. The wording and
  the test around it are the entire defence, and they are deliberately brittle:
  adding "mismatch" to that screen breaks the build.
- 14 loads will appear on the list on the first render at `staged` scope. That is
  the intended volume, and it is measured, not hoped for.
- **The numbers are a photograph.** They were measured from one revision of one
  workbook covering six months of one site. When Woodland's mix changes, or when
  a second site's workbook lands, they will be wrong — which is precisely why
  they are rows in a table and why §3 records what they meant.
- Retuning is a UI action with an audit line, not a deploy.

## What this does not fix

- **AK-4c.** Still open, still unowned since 2026-08-08.
- **Dollar-side matching.** Blocked on a join key that does not exist (§5).
- **The uncovered ~3,850 loads.** Still uncovered. P-47 is unchanged; only its
  label on screen improved.
- **The two staged batches.** Still staged, still Bill's (OPEN-ITEMS §0.BB).
  Nothing here confirms, promotes or counts them.
