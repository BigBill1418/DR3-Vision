# ADR-0085 — The walk-up drop-off is a label, a count and a photo. Nothing else.

**Date:** 2026-08-08
**Status:** Accepted, implemented, **born PILOT** (dark until Bill flips `ipad_dropoff` at `/admin/rollout`)
**Supersedes:** nothing. **Amends:** ADR-0037 Addendum B1 §1.3 (the drop-off money default), ADR-0078 (a third floor write class + queue schema v3)

---

## Context

JT, via Bill (handoff `2026-08-07-floor-and-ipad-bulletproof-reliability-plus-four-o.md`, Phase 5):

> *"a tile or static button on the iPad; hitting it prompts Public Drop Off or Incentive Drop, then asks for total units and a photo; contributes to daily inbound and inventory."*

People walk mattresses up to the gate. Some are ordinary public drop-offs; some
come through the Incentive programme. Today neither is captured at the door at
all — they reach inventory, if they reach it, through somebody remembering.

Bill scoped it down hard, twice, and the scoping is the interesting part of this
ADR:

> **No money. No PII.** Both types are identical except the label — units and a
> photo only. Incentive's $3 payout is **not** tracked here.

So the feature is small. The hazards it walks past are not.

### Hazard 1 — the money default was an allowlist of one, guarding the wrong side

`consumer_dropoffs` already exists (ADR-0037 D3), already reaches inventory, and
already has a manager API. Reusing it was obviously right. But
`src/lib/dropoffs/service.ts` contained:

```ts
if (kind === 'incentive') return null;
return units * UNPAID_DROPOFF_CENTS_PER_UNIT;   // 300¢/unit
```

Read as policy: *every drop-off kind mints $3/unit of Bye-Bye-Mattress check
money except the one named exception.* An allowlist of one, on the wrong side of
the decision. **Any** new `ConsumerDropoffKind` fell straight through to
`units × 300`.

A version of this feature that only added enum values — the obvious
implementation, and the one the first draft reached for — would have written
1,200¢ on a four-unit walk-up, at both sites, on a flow Bill had just said
records no money. Nothing in the type system, the tests or the schema would have
objected. It has been in this shape for a year and nobody has been paid wrongly
only because nobody has added a kind.

### Hazard 2 — `person_name` is NOT NULL, and it is CIP PII

`person_name String // CIP PII — Exhibit I / ADR-0010; never exported`. Required.
The no-PII surface therefore could not write this table as it stood, and the
column is load-bearing for the `@@index([site_id, person_name, dropoff_date])`
that serves the per-person daily incentive cap.

### Hazard 3 — the photo has to be required, and the last time photos were
### involved they silently did not work at all

`load_photos` held **zero rows** from the day the feature shipped until
2026-08-07, across three stacked faults (missing R2 CORS, a 307-as-success, a
screen-tied sweep). "Photo required" on a surface with that history has to mean
something stronger than a disabled button.

---

## Decision

### D1 — Two new label-only enum values, not a reuse

`ConsumerDropoffKind` gains `floor_public` and `floor_incentive`. They are
identical in every respect except the word the operator tapped.

Reusing `unpaid` for Public was the tempting shortcut and would have minted the
$3/unit default on every walk-up. **The label is what keeps the money off**, so
the label is new.

### D2 — The money predicate is inverted: deny by default, with a runtime floor

`mintsCheckMoneyByDefault(kind)` now names the kinds that **do** mint
(`unpaid`, `illegal`) and refuses everything else. Two independent guards:

- a **`never` exhaustiveness assertion** (`const unclassified: never = kind`)
  after the switch, so the next `ConsumerDropoffKind` is a **compile error**
  (TS2322) in that file and whoever adds it must state whether it carries money;
- a trailing **`return false`** for the case the compiler cannot see — a
  migration that ships a label before the code that knows about it, a value
  arriving through an `as` cast, a row written by an older deploy.

The compile error makes the decision explicit. The runtime deny holds when the
decision was never made.

**The `never` assertion is load-bearing, and the first version of this ADR
wrongly claimed the switch alone provided it.** It does not. A covered `switch`
followed by `return false` type-checks perfectly happily when a new enum member
appears — every path still returns `boolean`, the new member falls through to the
floor, and `tsc` exits 0. Caught in review on PR #217 and verified both ways
against the shipped shape plus an extra member: without the assertion `tsc`
passes; with it, `service.ts(141,9): error TS2322: Type
'"temp_falsification_kind"' is not assignable to type 'never'`.

Money could not have leaked either way — the runtime floor denies. The hole was
the **opposite** direction and just as expensive: a future kind that SHOULD pay
would have **silently paid nothing**, the same class of quiet-money defect as the
inversion this function was rewritten to fix, pointed backwards. `dropoffKindToChannel`
in `pool-routing.ts` already had this property for free (no trailing return, so
TS2366 fires); this function needed it stated. `service.money-minting.test.ts` presents a kind the enum
does not contain and proves it mints nothing; it also runs the OLD predicate
alongside and shows it returning `true` for the same input, so "the old code
minted money on new kinds" is an executed fact rather than a claim in a document.

### D3 — Three layers keep money and PII out, and the bottom one is a constraint

1. **`createFloorDropoff` has no money or name parameter.** A caller cannot pass
   one; the type does not have the field. It is a separate module from
   `createDropoff` for exactly this reason — a parameter you must remember not to
   pass is a rule that survives only as long as everyone remembers it, and
   Hazard 1 is what that looks like after a year.
2. **Explicit `null`s in the `create`**, written out rather than omitted. Prisma
   would default them anyway; stated, they read as a decision instead of an
   oversight, and the next reader's instinct on an "oversight" in a money column
   is to fill it in.
3. **`consumer_dropoffs_floor_no_money_or_pii`** — a CHECK constraint. A raw SQL
   write, a future service, or a workbook promotion that ignores all of the above
   is still refused.

Layer 3 is the one that matters in two years. Layers 1 and 2 are what make it
readable now.

### D4 — `person_name` becomes nullable, and the loosening is SCOPED

`ALTER COLUMN person_name DROP NOT NULL`, plus
`consumer_dropoffs_non_floor_requires_person`: the manager kinds
(`incentive`/`unpaid`/`illegal`) still require a name exactly as they did when the
column was `NOT NULL`. An unscoped loosening is just a hole.

**How the per-person daily cap treats the anonymous rows: it does not see them,
and that is correct rather than a gap.**

- The cap is a **money** control — it bounds how many units one person may be
  PAID for in a day. Floor rows are never paid: no rule is resolved, no
  `incentive_cents` computed, and the CHECK refuses a cents value outright. A cap
  on an unpaid row would be a cap on nothing.
- **They cannot be pooled into anyone's cap.** The `priors` query matches
  `person_name = <string>`; in SQL nothing equals NULL. If they were visible, a
  stranger's walk-up would silently consume a named collector's daily allowance
  and **under-pay them**.
- **The cap cannot be bypassed by omitting a name.** Reaching that code requires
  `kind === 'incentive'`, and an `incentive` row with a NULL name is refused by
  the constraint above. There is no path that pays money to nobody.
- The index is unaffected: a Postgres btree stores NULLs, they simply never
  satisfy an equality predicate.

**Why NULL is the COMPLIANT choice, not merely the convenient one.**
`person_name` is MRC Personal Data (charter Exhibit I / ADR-0010): it carries
breach-notification scope and a 10-business-day deletion-on-termination
obligation. A walk-up at the gate has no payout to attach a name to, so
collecting one would extend that obligation over people the programme has no
reason to hold records about. Not collecting it is the smaller footprint and the
smaller duty — the minimisation ADR-0010 exists to enforce, applied at the point
of capture rather than at the export boundary.

### D5 — The photo lives in COLUMNS on the row, not a side table

`photo_storage_key`, `photo_content_type`, `photo_byte_size`, `photo_uploaded_by`,
`photo_captured_at` — mirroring `load_photos` including the uploader.

There is exactly one photo and it is mandatory, so a 1:1 side table would add a
join and a nullable FK to model a relationship with neither cardinality. More
importantly, columns are what make
**`consumer_dropoffs_floor_requires_photo`** expressible: a `NOT EXISTS` against
another table is not a CHECK. "No drop-off without a photo" becomes a storage
fact rather than a convention.

`photo_uploaded_by` is written on row one. ADR-0078 Am.1's lesson, applied
early: `load_photos` enforced who *may* upload and then kept no record of who
*did*, so all 85 pre-flip rows carry `uploaded_by IS NULL` and backfilling them
would be inventing a name.

Explicitly NOT done: bolting drop-off photos onto `load_photos` with a synthetic
load id. A fabricated foreign key is a lie that every future join inherits.

### D6 — A new site-scoped mint endpoint, not a widened one

`POST /api/operator/[site]/dropoff/upload-url`.

`/api/photos/upload-url` authorises via `requireOperatorAtLoadSite` — it derives
the site **from the load**. A walk-up has no load, so the site must come from the
session. Putting the endpoint under `/api/operator/[site]/…` makes the site
structurally part of the address, so no shape of this route forgets to scope
itself.

A separate route rather than an optional `load_id`: that path is the one that
held zero rows for months and was finally drained on 2026-08-07 through three
stacked faults. Widening its signature to serve a second caller is how a
hard-won working path acquires a new failure mode.

The mint is gated on `ipad_dropoff` — the **same** surface as the write it feeds.
A mint reachable while the write was gated would hand out signed URLs for a flow
that then refuses the row: bytes in the bucket, nothing in the table, a queue
entry that cannot drain. ADR-0078 Am.1's rule — mint and confirm move together.

**The returned key is re-checked on submit** (`isValidDropoffStorageKey`). It
arrives from an iPad's IndexedDB, possibly days later; the CHECK constraint only
requires it to be non-null and has no opinion about *which* object it names.
Without the check, a drop-off could cite another site's object — or a vendor
invoice under `ap/` — as its evidence.

### D7 — Idempotency: the photo key is deliberately NOT in the request hash

`operator.dropoff.create` joins the ADR-0078 `FLOOR_SCOPES` allowlist:
day-addressed, gated on `ipad_dropoff`, claimed in the write's own transaction.
It is an append with no natural key — two four-unit walk-ups on one day are an
ordinary Tuesday — so the claim is the only thing between a double-tap and two
rows.

The hash covers **day, label, units, site**. It excludes `photoStorageKey`,
which is load-bearing rather than lazy: a queued drop-off re-mints a **fresh** R2
key before replaying, because the presign expired. Hashing it would make that
replay look like key reuse and answer 409 — turning the exactly-once fix into a
louder bug, which is the identical trap `/api/photos/confirm` records having hit.
The identity of the write is what the operator counted; the photo is evidence
attached to it.

### D8 — The offline queue carries the blob and the units in ONE row (schema v3)

`pending_uploads` gains a `subject: 'load' | 'dropoff'` discriminator, a nullable
`load_id`, and a `dropoff` payload. `DB_VERSION` 2 → 3 backfills `subject:'load'`
on existing rows, and every read defaults to `'load'` as well — belt and braces,
because this upgrade runs once per device and an interrupted refresh mid-upgrade
is a real thing on a floor iPad holding the only copy of a photo.

A drop-off cannot exist without its photo key, so the R2 PUT must succeed before
the submit is attempted, and offline neither can happen. Splitting them across
the two stores was the alternative and is worse in every direction: two rows, two
keys, an ordering dependency the queue cannot express between stores, and a
window where the photo has drained and the drop-off has not — which reads
downstream as a photo of nothing.

Riding the existing store rather than adding a third also means drop-offs inherit,
already proven in the field, the badge counts, the conflicts screen, Retry-all,
the `blocked:`/`auth:` classification and the backoff. A third store would have
needed all of that re-implemented, and whichever parts were re-implemented wrong
would have been invisible.

`load_id` is **null**, never a synthetic value: `replayAll` halts a load's
remaining steps on any failure, and a placeholder would make every drop-off halt
behind every other one.

### D9 — Inventory: one row, one table, one leg

The write touches **only** `consumer_dropoffs`. Not `inbound_loads`, not
`processed_units_daily`.

`onHand` already sums `consumer_dropoffs.units` into the **program** pool with no
`kind` filter, so the new kinds reach inventory with no aggregation taught about
them. The double-count risk here was never the enum — every inventory aggregation
is kind-blind, so a new kind cannot be silently excluded. **The risk is writing
the same physical mattresses into a second leg**, since `onHand` adds
`inbound_loads` and `consumer_dropoffs` with no dedup between them. That is why
`mymrc/inbound-bridge.ts` excludes `type='Consumer Dropoff'`, and this flow
avoids it by writing one row to one table.

On the handoff's Correction 1 (`processed_units_daily` has three-to-four writers
under a precedence rule, and anything adding to inventory must respect it): **this
flow never writes that table**, so there is nothing for it to have an opinion
about. Pinned anyway — a day carrying both a walk-up drop-off and a
MyMRC-sourced, closed processed row is asserted to resolve to exactly one row of
each, drop-off added once and processed subtracted once.

### D10 — Born pilot on its own surface

`ipad_dropoff`, born `pilot` per ADR-0047 #3. The flag hides the page and the hub
card; the API is gated independently on auth + site + the same surface, so a
bookmarked URL or a hand-rolled POST is refused regardless of what the UI
rendered. The page **degrades to the translated "not turned on yet" block** — a
bookmarked URL on a floor iPad must never become a dead end.

### D11 — The R2 CORS policy is checked in (rider)

`infra/r2-cors.dr3-vision-photos.json` + `infra/apply-r2-cors.sh`.

The bucket's CORS rule was repaired by hand on 2026-08-07 from a shell that has
since closed. Infrastructure that exists only as somebody's scrollback is the
defect: this ADR adds a **second** writer to that bucket, so a bucket reset or a
third site's bucket would silently reproduce the original zero-rows outage across
two features instead of one. `PutBucketCors` replaces the whole configuration, so
the script is idempotent by construction, and `--check` diffs live against
declared. No token is embedded — the script documents its env contract and names
where the credential lives (`integrations.cloudflare.account_token`, the `cfat_`
account-scoped one, **not** the zone-scoped `api_token` that 403s on every R2
admin call).

---

## Alternatives considered

**Reuse `unpaid` for Public and `incentive` for Incentive.** Fewest moving parts,
no migration. Rejected: `unpaid` mints 300¢/unit and `incentive` resolves a payout
rule and a per-person cap on a flow that captures no person. Both write exactly
the money Bill excluded.

**Add the enum values and leave `defaultIncentiveAmountCents` alone, adding one
`if`.** Rejected: it fixes this instance and leaves the inversion in place for the
next author. The predicate, not the two new kinds, is the defect.

**Application-only enforcement; no CHECK constraints.** Rejected. Every argument
for it reduces to "the current callers are careful", which is what was true of
the money default for a year.

**A `dropoff_photos` side table mirroring `load_photos` exactly.** Symmetrical and
familiar. Rejected: one mandatory photo per row is not a collection, and the
constraint that makes "photo required" real is not expressible against a table's
absence. Recorded as a genuine trade — if drop-offs ever take multiple photos,
this becomes the wrong shape and should be revisited deliberately.

**Store the $3 for Incentive "so we have it later".** Rejected explicitly by Bill.
Recorded here because it is the single most likely well-intentioned regression: if
the payout is ever wanted, it is a separate, deliberate addition, not a default
somebody slipped back in.

**A third IndexedDB store for drop-offs.** Cleaner on paper. Rejected: it would
have required re-implementing the badge counts, conflicts screen, Retry-all,
error classification and backoff, and the parts re-implemented wrong would have
been invisible until a device stopped draining.

**Feed daily inbound by also writing an `inbound_loads` aggregate row.** Rejected:
`onHand` adds both legs with no dedup, so this is the double-count in its purest
form.

---

## Consequences

- Walk-up drop-offs are captured at the door, with evidence, and reach the
  program pool of the inventory ledger through the existing drop-off leg.
- The floor gains one more surface a bookmarked URL degrades from rather than
  dies on; `REQUIRED_GATE` in `floor-surface-coverage.test.ts` goes 7 → 8, and
  `WORK_SEGMENTS` in `floor-nav.ts` gains `dropoff`.
- `DropoffView.personName` is `string | null`. The manager loads/inventory table
  renders `—` for the anonymous rows. `updateDropoff` refuses a kind transition
  across the floor/manager boundary rather than letting it surface as a raw
  constraint violation.
- The manager desktop form deliberately does **not** offer the floor kinds: it
  cannot capture a photo, so offering them would produce a constraint violation
  instead of a record. Walk-ups are entered on the iPad.
- Invoice generation (`generation-inputs.ts`) filters `kind: 'incentive'`, so the
  new kinds are correctly excluded from incentive billing with no change.
- The audit workbench will show `dropoff_floor_public` / `dropoff_floor_incentive`
  rows once data exists; they inherit the raw-enum label until someone adds one
  to `INBOUND_SOURCE_LABELS`. Stated, not fixed — it is a display nicety and this
  ADR is not the place to guess at Kelsey's preferred wording.
- Queue schema v3 ships. Devices on the old bundle keep working; they simply have
  no drop-off button until they take the update (`skipWaiting: false`).

### Residuals, stated rather than buried

- **A re-minted R2 object is orphaned** when a replay's first attempt had already
  landed. The same accepted trade as `/api/photos/confirm`: an unreferenced object
  costs bytes, a duplicate row costs the floor's inventory being wrong. The
  retention purge already sweeps unreferenced keys.
- **`PendingUpload.kind` is inert for a drop-off row** (set to `'concern'`). It
  carries a value only because the field is non-optional and widening it would
  force a null check through every load-photo path. The real label is
  `dropoff.kind`.
- **No same-day correction for drop-offs.** Phase 4 covers counts; a mistyped
  drop-off is a manager job through the existing CRUD-lite path. Out of scope
  here, and named so it is a decision rather than an omission.
- **`upsertProcessedUnits` leaves `source` unchanged on update** (found while
  tracing the precedence rule for D9), so a human edit to a MyMRC-created day is
  silently overwritten by the next bridge run. Untouched by this ADR — it is a
  live defect in someone else's path and folding a fix into a drop-off PR would
  hide it. Filed in `docs/OPEN-ITEMS.md`.
