# ADR-0110 — An untaught kind, an unguarded door, and a number the building cannot hold

- **Status:** Accepted, implemented 2026-08-18 (Pacific)
- **Context:** Handoff #270 — "on-hand inventory is constantly wrong, especially on
  the production report, and it goes negative on both sites"
- **Supersedes / amends:** nothing. Extends ADR-0037 D6 (the one running balance),
  ADR-0072 (the tiered anchor-overwrite guardrail) and ADR-0089 (the delivered signal).

## Context

On-hand inventory is the single most recurring failure in this system. The July
−5,401 floor, the −2,439 program gap, the "1,900 units no feed explains". Bill's
framing was that the balance formula must be broken.

**It is not.** The formula

```
End = Start(anchor) + Inbound + Drop-offs − Stripped − WholeUnitsSold − Landfilled
```

is arithmetically sound, and a live diagnosis on 2026-08-18 confirmed it ties to
the unit at Woodland: anchor 2,483 (2026-07-22) + inbound 18,392 + dropoffs 92 −
stripped 20,128 = **839**, which is exactly what both code paths render.

Two of the four suspected causes **died on measurement**, and this ADR records
that as its most useful finding:

1. **The report does NOT compute on-hand a second way.** The standing suspicion
   was that `getEodInventorySnapshot` (loads/eod-inventory.ts) re-derived the
   balance independently of `onHand` (inventory/running-balance.ts) — "two modules
   = two chances to disagree". Measured: the report already delegates _both_ day
   balances to `onHand`, and the live figures are identical on both paths
   (Woodland 442 program / 397 non-program / 839 total). Its own aggregate queries
   are `_max` **date** keys for freshness, not units. There was nothing to unify.
2. **Woodland's inbound is not under-fed today.** No negative in the trailing 14
   days; zero undated hauls against 7,372 Delivered; the 15 `Confirmed` hauls are
   _future_ appointments, which is what a healthy scheduling feed looks like.

A third finding reframed a site rather than fixing it: **Eugene is EMPTY, not
negative.** No anchor has ever been set, `inbound_loads` is empty all-time, and
there are no mirror or processed rows. Its `0` is not a measurement of an empty
building; it is the absence of any measurement at all.

That leaves what is _actually_ wrong. Three things, and none of them is the
equation.

## Decision

### D1 — An untaught drop-off `kind` must fail loud, never sum

`onHand` aggregated consumer drop-offs with `_sum: { units }` and **no `kind`
predicate**. Every kind — present and future — landed in the PROGRAM pool by
default. That is not a policy; it is the absence of one. ADR-0085 added
`floor_public` and `floor_incentive` to the enum and this reader absorbed them
into the billing pool without anyone deciding it should. It happened to be
correct. Nobody checked, and nothing would have said so if it were wrong.

MRC is billed on program units, so a mis-routed kind is a mis-invoice that is
**indistinguishable from a correct one**.

Two gates now stand between a new kind and the floor, because the enum can grow
through two different doors:

- **Compile time.** `DROPOFF_KIND_POOL` is a total `Record<ConsumerDropoffKind,
'program'>`. Adding a member to the Prisma enum fails `tsc` with `TS2741` until
  someone writes down which pool it belongs to. This is the door a normal
  `prisma migrate` + `generate` comes through.
- **Run time.** `sumTaughtDropoffKinds` throws `UnknownDropoffKindError` on any
  kind the database returns that this module was never taught. This is the door a
  hand-written `ALTER TYPE … ADD VALUE` comes through, where the generated client
  never learns the member and the compile-time gate is blind.

The value type is the **literal** `'program'`, not the pool union. Every kind
today is program-pool, and `computeRunningBalance` receives them as one scalar.
A future non-program kind therefore _cannot_ be expressed by editing the table
alone — it fails to typecheck, forcing the author to the place where the pool
split actually lives instead of silently widening the map.

The query became `groupBy(['kind'])` on the same table, window and round trip.
The grouping buys no arithmetic — every taught kind still sums to the identical
total — it buys the reader the ability to **see** what it is adding up.

### D2 — The report/`onHand` equivalence is PINNED, not refactored

Since the premise died (see Context 1), there is no unification to do. But the
equivalence is currently a property of one `await onHand(...)` call that any
future edit could quietly replace with a local aggregate, and nothing in the
suite would have noticed.

`eod-onhand-equivalence.test.ts` notices. It mocks `onHand` to return values
**nothing else in the system could produce** (1234.5 / 678.25 — fractional,
arbitrary, unreachable from any aggregate of the fixture's empty tables), so a
second computation path cannot coincidentally arrive at them. It asserts the
`onHand` **arguments** too: "the same number" is meaningless without "for the
same site and day", and a report that faithfully echoed `onHand` while asking it
for the wrong day would satisfy a value-only test while being just as wrong.

Falsified: adding `+ 1` to the report's `programOnHand` turns it red with
`expected 1235.5 to be 1234.5`. It detects a divergence of one unit.

### D3 — A negative on-hand is a diagnostic, never a figure

The building cannot hold −2,439 mattresses. A negative pool is not a small
quantity; it is **proof that an input is missing** — real processing subtracted
from incomplete intake.

`EodInventoryState` gains `'negative'`, checked **before** freshness. Precedence
matters twice over: a negative floor behind a _fresh_ anchor is the worst case,
not an acceptable one (the recent anchor is exactly what makes the wrong number
persuasive), and every existing `state === 'healthy'` guard downstream — notably
the ADR-0058 §3.3 "estimated floor after today" block — stops deriving from a
broken floor for free rather than each consumer needing its own check.

**Either pool counts, not just the total.** MRC bills on program units, so a −300
program pool inside a +900 total is a billing-grade error a total-only check would
wave through.

On both the production report and the manager floor tile, the figure is
**replaced** by the banner, not shown beside it. A negative printed anywhere gets
copied into a spreadsheet or a billing conversation; a banner next to the number
changes nothing. The magnitude appears exactly once, inside the sentence that says
it is not reliable. The tile's days-remaining projection is suppressed outright
rather than CSS-hidden — markup that is merely `display:none` still ships the
sentence to anything reading the page.

### D4 — Intake staleness is measured on INTAKE, reusing the ADR-0089 signal

`flowThrough` is the max over _every_ feed, so a site that keeps stripping while
intake is frozen reads perfectly fresh — the outflow rows hold the max up. That is
not hypothetical: it is precisely the 2026-07-22→31 Woodland outage, where the
delivered feed froze for nine days, processing continued subtracting, and every
freshness signal stayed green while the floor went negative. **A number starved of
intake is only detectable by measuring intake.**

`inboundThrough` / `inboundDaysSince` / `inboundStale` are surfaced from the
`_max: { arrived_at }` the existing freshness aggregate **already fetched and then
threw away** by folding it into one max. No new query, no second freshness system.

`inbound_loads.arrived_at` is the right column because it _is_ the ADR-0089
delivered signal: the bridge writes each load at Pacific-midnight of
`recycler_reported_delivery_date ?? docking_appointment_date`, the same COALESCE
the mirror-freshness guard keys on. Measuring anything else would certify a feed
we cannot see — the ADR-0089 D3 lesson.

`INBOUND_STALE_DAYS` is **derived from** `DEFAULT_MAX_AGE_MS` (96 h) rather than
chosen here, so this and the mirror-freshness pager cannot drift into disagreeing
about when intake has stopped. It is deliberately much tighter than the 14-day
anchor window: an anchor may age while daily flows keep the balance honest, but
intake stopping for four days **is** what makes the balance dishonest.

Unlike D3 the figure still renders — it is the best available number — but flagged
with why it is suspect.

### D5 — ADR-0072 is enforced on EVERY anchor-write door

**This is the defect found while verifying, and it is the one that mattered
tonight.**

ADR-0072 exists because "a mistyped count does not produce a wrong count, it
silently moves the entire floor". It was wired into the iPad floor-count path
(`countCreate`) and the hold-release path, and both were tested. `POST
/api/manager/[site]/snapshots` — the Loads & Inventory **desktop form a manager
actually uses**, called from `LoadsInventoryClient.tsx` — went straight to
`reconcilePhysicalCount` with no tier check at all.

Same table, same anchor, same total authority over the floor, none of the
friction. A 32% swing was accepted with `201` and written.

**A gated capability is only as gated as its least guarded entry point.** The
route now classifies server-side and holds Tier 2 exactly as the floor path does,
reusing `createHold` so the entry is preserved and the release is recorded against
whoever approves it — one control, two doors.

`newTotal` uses the `??` form (not `snapshotTotalUnits`'s additive sum) because
that is how `loadPriorAnchor` derives the PRIOR total. Measuring a swing between
two totals computed by different rules is the ADR-0078 D1 defect one level up: the
two sides of a comparison must be built the same way or the percentage is
meaningless.

## Consequences

- **No schema change and no migration.** Nothing about the data model was wrong.
- **No live number moves.** The grouped drop-off sum equals the old bare sum for
  any window of taught kinds; that equality is asserted directly, which is what
  lets this ship on the day of a physical count.
- **An untaught kind now takes the floor down rather than mis-billing it.**
  `UnknownDropoffKindError` surfaces through the existing read-failure paths — the
  report drops its inventory section with a logged error, the dashboard tile
  degrades to null. That is strictly louder than a wrong number, and deliberately
  not a 4xx: nothing the caller sent caused it, the data model grew past the reader.
- **Eugene remains out of scope and is honest about it.** Tonight's count gives it
  a first anchor (Tier 0 — no prior, no swing arithmetic, no block). After that its
  number is static until a feed exists. `inboundStale` is never true for a site with
  no inbound at all: "this site has no intake feed" is a different statement from
  "the feed died", and conflating them would put a permanent warning on Eugene.
- **The daily report resends on a fresh→stale-intake flip**, via
  `eodInventorySignature`. A report that renders a flag but never re-sends has not
  told anyone.

## Alternatives considered

- **Unify `eod-inventory.ts` into `running-balance.ts`.** Rejected: measurement
  showed they are already one computation. Refactoring for its own sake would have
  spent the day's risk budget on a premise that had already died.
- **A fifth state for stale intake.** Rejected: it would collide with `negative`,
  and the two are not mutually exclusive. Intake staleness annotates a figure that
  still renders; a negative replaces it.
- **Let the manager desktop write Tier 2 through, since a manager is the
  approver.** Rejected: `requireActivatedManager` is an activation gate, not a
  four-eyes check, and the person typing is the person who mistyped. Holding costs
  one release click and buys an audit row naming who approved a floor-moving swing.
- **A dedicated inbound-freshness module.** Rejected explicitly by the handoff and
  on the merits — the value was already being fetched and discarded.
