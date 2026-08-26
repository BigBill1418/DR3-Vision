# ADR-0128 — Three things the record could not tell you

- **Status:** Accepted
- **Date:** 2026-08-25
- **Follows:** ADR-0090 C (the void); ADR-0037 D2 (the Inbound-tab split); ADR-0115 F-4 (the zero-row freight warning); ADR-0125 (the `transport_charged` writers); ADR-0066 §1.7 (the 06:00 digest)
- **Closes:** OPEN-ITEMS §0.BO — BO-6, BO-7; instruments BO-4
- **Grading:** ADR-0037 — the new signal is **digest-tier, not a page**

## Context

The 2026-08-25 Lake County correction (§0.BO) was executed successfully. What it
exposed while being executed were three separate places where `inbound_loads`
holds a record that **cannot answer the question asked of it**. None is about
that load. All three are systemic, all three were invisible, and all three were
found by a person reading rows.

| #    | The record says                                | The truth is                                       |
| ---- | ---------------------------------------------- | -------------------------------------------------- |
| BO-6 | `voided_by = Janette Tomas`                    | Bill decided it; a script executed it              |
| BO-7 | `external_mymrc_haul_id` NULL on all 774 loads | Every dock load has a haul number; none was stored |
| BO-4 | `transport_charged = false` on all 774         | Nobody has ever said whether it should be true     |

ADR-0126 is the immediate prior art and the reason these are one ADR: it is the
same shape — _a state nothing in the system was capable of reporting, found by a
human reading the table._

## BO-7 — no dock-captured load was reconcilable

`inbound_loads.external_mymrc_haul_id` was written by exactly two things: the
MyMRC inbound bridge and the EOD add-line. Neither touches a dock capture. So the
column was **NULL on all 774 production loads** (measured 2026-08-25).

The monthly MyMRC reconciliation upload matches DR3 loads to external haul rows
**on that column** (`reconciliation.ts`, `categorizeRows`). So every truck the
floor has ever counted came out of a reconciliation as `missing_in_dr3` — "MyMRC
has this haul and we do not" — against a load sitting in the same table with the
same units. The reconciliation was not wrong about anything it could see. It
could not see any of them.

**D1 — A load stamps its haul number at check-in.** `startInboundLoad` copies
`expected_loads.external_mymrc_haul_id` onto the child it mints. The parent column
is NOT NULL and UNIQUE and `inbound_loads.expected_load_id` is UNIQUE, so the
mapping is 1:1 by construction — there is nothing to choose between.

**D2 — The value is COPIED, not read through the link.** A void severs
`expected_load_id` (ADR-0090 C). If the number were only reachable _through_ that
link, the void would take the answer with it, and a re-pointed load would
silently start reporting a different haul than the one it was worked against.
What a load carries is the haul it was booked against _at the moment it was
worked_.

**D3 — And the void therefore severs the number too.** This is the non-obvious
consequence of D1 and it had to be found before it bit somebody.
`inbound_loads.external_mymrc_haul_id` is UNIQUE. A voided load that kept its
number would hold it against the whole table, so the re-check-in the void exists
to make possible would die inside `startInboundLoad` on a `P2002` that
`isExpectedLoadClaimCollision` correctly refuses to absorb — **a raw 500 on the
one tap the operator has just been told to make.** That is ADR-0074 Am.1's dead
end, reintroduced through a different column. `voidLoad` NULLs it alongside the
slot; the audit row names it, and `voided_from_expected_load_id` still points at
the slot, so "which haul did they mis-tap?" stays answerable.

**D3a — And the concurrent double-tap can now lose on EITHER unique index.**
The second non-obvious consequence, found the same way as D3 — by asking what
else a new UNIQUE column touches. `isExpectedLoadClaimCollision` recognised only
`expected_load_id`, deliberately narrow so that an unrelated constraint could not
be reported as "someone else claimed it". But both operators in an ADR-0082 race
now compute the SAME haul number, because it is derived 1:1 from the slot — so
the loser can lose on either index, and which one Postgres reports is index
ordering, not a fact about what happened. The narrow predicate let a raw `P2002`
out of the server action: the opaque digest ADR-0082 spent a whole section
removing, re-armed by adding a column.

Both columns are now recognised. Widening is safe because the recovery is
already conditional — the caller re-reads by `expected_load_id` and RE-THROWS
when nothing is there, so a haul-id collision that is genuinely something else
still surfaces as itself.

**This was caught by `load-claim.db.test.ts` against a real Postgres and by
nothing else** — every mocked suite was green. It is also why the branch is
pinned by a DETERMINISTIC test rather than by that race: re-running the race with
the narrow predicate restored went green, because that run happened to lose on
the other index. A guard that is only sometimes reached is not a guard.

The same run exposed a latent fixture leak: `load-claim.db.test.ts` reset
`inbound_loads` by the `tk-` id prefix, but loads the tests create through
`startInboundLoad` carry a UUID, so every run leaked its own claims. Harmless
while `expected_load_id` was the only UNIQUE column — the leaked rows were
detached from any slot the next seed recreated — and immediately fatal once a
second one existed. The reset is now scoped by the fixture's own site ids as
well.

**D4 — Backfill only what is DERIVABLE.** 133 loads had a live parent slot and
were stamped from it (130 `submitted`, 3 `rejected`, all Woodland; zero UNIQUE
collisions). The other 641 are aggregate and paper rows that never had a slot;
they are not touched and not synthesised. A haul number invented for an aggregate
would be indistinguishable from a real one and would make the reconciliation
match a row that does not correspond to a truck. **An unreconcilable aggregate is
honest; a wrongly-reconciled one is not.**

Verified after the run, on production: 133 of 133 stamped, and **133 of 133 match
a row in `mymrc_hauls_mirror`** — so they are genuinely reconcilable, not merely
non-null.

## BO-6 — a void could not name a non-operator actor

`voidLoad` took one `operatorUserId` and used it for two unrelated jobs: the
ownership check (_may this caller void?_) and the attribution (`voided_by`, and
the audit row's `actor_user_id`). `voidLoadAction` — an operator server action —
was its only caller, so nothing had ever needed the distinction.

The correction needed it. It voided the duplicate through the shipped path
deliberately, to keep the transition guard, the slot severing and the ADR-0090 C
audit shape rather than hand-rolling five column writes. The cost was that
`voided_by` came out naming **Janette Tomas** for a decision Bill authorized and
a script executed. A supplementary audit row under
`actor_label = 'system:bo-lake-county-repoint (…)'` recorded the truth, and §0.BO
said plainly what remained wrong: _"A reader of `inbound_loads.voided_by` alone
will still get the wrong answer."_

**D5 — Authorization and attribution are two arguments.** `operatorUserId` keeps
its one job: it is the holder, the ownership check is unchanged, and a void with
no `actor` is byte-identical to every void written before this ADR — which is
what the floor's own void panel wants, because there the holder IS the actor.
`actor` is who decided.

**D6 — A non-user actor gets a LABEL, not a borrowed `users.id`.** New nullable
column `voided_by_label`, in the `audit_log.actor_label` shape the repo already
uses (`system:<slug>`), which is also the rule the 2026-08-06 terex one-offs
wrote down. When a label actor is supplied, `voided_by` is set to **NULL** rather
than left on the holder — a reader of that column alone must get _no answer_, not
a wrong one.

**D7 — Exactly one of the pair, enforced at the table.** A CHECK constraint:
a `voided` row has exactly one of `voided_by` / `voided_by_label`, and a row that
is not voided has neither. Stated in SQL rather than left to the service because
`voidLoad` is not the only thing that has ever written these columns — the August
hand-audited corrections wrote them directly and the next one will too. It lands
VALIDATED, not `NOT VALID`: measured on production, all 774 rows already satisfy
it, and a constraint that skips the rows that already exist protects nothing.

**D8 — An `actor` that names nobody is REFUSED** (`422 void_actor_required`)
rather than normalised back to the holder. Falling back would silently reinstate
the exact bug this argument exists to fix.

**D9 — The 2026-08-25 void is corrected through the new mechanism**, not by hand
(`scripts/one-off/2026-08-25-bo6-void-actor-correction.ts`, guarded on the full
before-state, one row, attribution only — the void's status, reason, instant and
severed slot are untouched).

## BO-4 — a freight leg nobody has ever decided about

Measured on production 2026-08-25:

```
sources.is_trans_charge = true          0 of 176 sources
inbound_loads.transport_charged = true  0 of 774 loads
freight_cents / fuel_surcharge_cents    NULL on all 774
third-party-carried and uncharged       103 loads / 11,734 units / 7 carriers
                                        in the trailing 30 days (all Woodland)
```

**No Ron Lawrence haul has ever carried a freight charge in Vision.** Seventy-two
of them, since 2026-07-29.

The research finding matters and is not what §0.BO assumed. Three of the four
inputs the freight leg needs **do** exist, seeded and tested:

- the CA mileage-tier zone table (`prisma/seed.mjs` `seedTransportRateTiers`, 7
  tiers, $425 → $3,000, effective 2026-01-01);
- the CA fuel-surcharge formula (`state_program_rules`, `(EIA $/gal ÷ 6.5) ×
miles`, trigger $5.05 — OR is structurally impossible by design);
- the resolver chain (`billing-rates/freight-resolver.ts`), which fails loud
  rather than silently billing zero.

The fourth does not exist **anywhere in this repo**: _which_ sources are
transport-charged, and how many miles each is. That lives in the Woodland
workbook's `list` tab (~47 trans-charge sites) and `variables!Mileage_Table` (61
rows), and ADR-0037 defers it explicitly: _"Deferred (needs Rick's data, out of
scope here) … left at the `false` default so no false trans-charge variance rows
are produced."_ `account_haul_rates` is seeded EMPTY for the same reason.

**D10 — NO SEED IS WRITTEN, and none is proposed.** `is_trans_charge = false` on
all 176 sources is not wrong data; it is the **absence** of data. Seeding a guess
would launder that absence into truth, which ADR-0040's consequences already
forbid. The remedy is a person entering the classification at `/admin/sources`
(which now exists, per ADR-0125 D7, and writes both `is_trans_charge` and
`canonical_mileage` with an audit row). **Owner: Bill.**

**D11 — But the silence gets an instrument.** `loads/uncharged-freight.ts` counts
billing-ready loads on a third-party truck with no transport charge over the
trailing 30 Pacific days, and contributes one line to the 06:00 AP digest.

- **Keyed on the TRANSPORTER, not the source.** `verify-gate.ts` derives
  `transport_charged` from `source.is_trans_charge` and leaves the column
  untouched on a load with no source — a deliberate refuse-to-guess — so the
  source side cannot distinguish "classified as free" from "never classified":
  both read `false`. `transporters.is_internal` can, and is populated: one
  internal carrier (the DR3 parent account) and ten third-party ones.
- **It rides `warnings`, not an items list.** An uncharged freight leg produces
  no AP items — the invoice line is never written — so an items-gated finding
  would be invisible on exactly the mornings it matters. Same reasoning as the
  two doc-ingest lines already in that slot.
- **Digest-tier, not a page** (ADR-0037). No ntfy publish, and it does not raise
  the digest to high priority. It fails the 5-question gate on Q1 and Q3: the
  remedy is a data-entry session against a workbook, not a five-minute action,
  and there is nothing to self-heal. A permanent high-priority flag on every
  morning's mail is how a priority stops meaning anything.
- **It will appear every weekday until the classification is entered.** That is
  the instrument working. This class went unnoticed for the entire life of the
  system precisely because nothing repeated it.

**D12 — This does not duplicate ADR-0115 F-4.** That warning fires once a month,
into a log, at the moment the invoice is cut, when the freight leg resolves zero
rows. This is the same fact, per-load, weeks earlier, in a surface a human opens
daily. Neither replaces the other. ADR-0115's comment claiming
`transport_charged` "has no writer anywhere in the codebase" was **stale** — it
has had two since ADR-0125 — and is corrected in place; the conclusion is
unchanged and the reason moves one layer down to the unpopulated classifier.

## Alternatives rejected

**Host BO-4's finding in the audit-sweep comparator chain** (`audit_findings` →
the 18:00 per-site alert digest). Architecturally the closer fit — it is per-site,
load-domain and data-quality-shaped. Rejected because the sweep emits one finding
per row, and this condition is uniformly true of ~40 loads in any 14-day window:
forty findings a night for one unmade decision is noise, and ADR-0037's rule is
that anything below `default` is a dashboard, not a notification. One aggregate
line in a digest one person reads, whose decision it is, is the honest shape.

**Set `transport_charged = true` on the Lake County load by hand.** Refused
during the correction itself and still refused. It would make that row the ONLY
`true` in the table and therefore the sole input to
`resolveTransportationInputs` — with a NULL `freight_cents` — a sharper
distortion than the consistent understatement it shares with its 74 siblings.

**Backfill `external_mymrc_haul_id` onto voided loads from
`voided_from_expected_load_id`.** A void asserts the load was never a truck. It
must not appear in a reconciliation at all.

**A `NOT VALID` CHECK for D7.** See D7 — the table is small, the predicate is
already satisfied, and an unvalidated constraint protects only future rows.

## Consequences

- One new nullable column and one CHECK constraint
  (`20260857_adr0128_void_actor_label`). No enum change, no index.
- 133 production loads gained a haul number and became reconcilable for the first
  time. **The next MyMRC reconciliation upload will behave differently** — dock
  loads that previously fell out as `missing_in_dr3` will now match, and may
  surface real `count_mismatch` / `weight_mismatch` items that were hidden behind
  the blanket non-match. That is the point, and it should be expected rather than
  read as a regression.
- The 06:00 digest will carry the uncharged-freight line every weekday from the
  first tick after deploy until somebody classifies the sources. Expect it.
- `voidLoad`'s signature grew an optional argument; every existing caller and
  every existing voided row is unaffected.

## Follow-ups

- **BO-4 is Bill's decision** and is not closed by this ADR. Either the
  classification is entered at `/admin/sources` for the ~47 trans-charge sites
  and 61 mileages, or a decision is recorded that these hauls carry no DR3
  freight leg — in which case the instrument should be told so rather than
  silenced.
- **BOL-photo OCR** as a second mis-card layer (ADR-0127, rejected for scope).
- **ADR-0073** (manager load corrections) inherits D5/D6: it is the path that
  will most often void on somebody else's behalf, and it now has a way to say so.
