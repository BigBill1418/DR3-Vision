# ADR-0089 — The delivery date we never asked for: inbound is keyed on a scheduling field

**Status:** Proposed (diagnosis complete, no code shipped) — 2026-08-10
**Site:** Woodland (the only site with a MyMRC portal feed)
**Builds on:** ADR-0059 (the inbound bridge and its undated-haul tradeoff), ADR-0057
(full-object ingestion + the Phase-0 discovery deliverable), ADR-0070 (newest-first
pagination + per-feed freshness), CHANGELOG 2026-08-03 (the frozen-detail fix)
**Falsifies:** the "undated hauls are all pre-anchor and inert" tradeoff in ADR-0059
§0/§4/Consequences and the same claim in `src/lib/mymrc/inbound-bridge.ts`; the
residual "further MRC marking lag" candidate in OPEN-ITEMS O-3

---

## Context

On 2026-08-10 (~10:26 PT) Bill spoke to MRC directly. MRC confirms **they have haul
data entered after 2026-07-21 and report no issues or delays on their end.**

That statement retires the last upstream explanation this project has been carrying.
It is the second time the same instinct has been wrong: on 2026-07-31 and again on
2026-08-03 (morning) we concluded "MRC has not marked a single Woodland haul Delivered
since 07-21 — not a Vision defect," and on 2026-08-03 (afternoon) checking killed the
premise. The root cause was ours (details fetched once per row, ever); 61 hauls flipped
Confirmed→Delivered and +4,306 units were recovered.

This ADR records what a re-measurement on 2026-08-10 found after that fix, with MRC's
confirmation in hand.

### The mirror is not stale — that part is fixed and stayed fixed

Measured live on prod (`dr3_vision`, 2026-08-10 ~10:00–10:30 PT):

| Signal                                  | Value                                                   |
| --------------------------------------- | ------------------------------------------------------- |
| `mymrc_hauls_mirror` rows               | 7,334                                                   |
| Newest `docking_appointment_date`       | 2026-08-12 (Delivered), 2026-08-14 (Confirmed)          |
| Newest `first_seen_at` / `last_seen_at` | 2026-08-10 10:00 PT (17:00 UTC)                         |
| Detail coverage                         | 7,333 / 7,334 (one portal-side ghost, inert)            |
| Scrape cadence                          | hourly, all four feeds, `status='ok'`                   |
| Delivered hauls dated 07-22 → 08-12     | 93 hauls, 10,134 program units, every weekday populated |

**The 07-21 cliff is gone.** Delivered hauls land every day. The hourly cron is healthy.
Nothing about the current state supports "stale after 7/21."

### What MRC's confirmation kills

OPEN-ITEMS O-3 left a **~1,900-unit reconciliation gap** with three named candidates.
Candidate 1 was "further MRC marking lag (22 hauls still Confirmed, dated 08-04+)."

Measured today: **16 Confirmed hauls remain in the entire mirror.** Twelve are dated
2026-08-10 or later — i.e. today and the future, legitimately not yet delivered. Only
four carry a past dock date (H-134621 07-24, H-135474 07-27, H-135312 08-04, H-136593
08-07). Twenty-two has become four, without an MRC chase, and MRC says there is no
backlog. **Candidate 1 is dead.** It cannot account for ~1,900 units.

### The real leak: we key inbound on the wrong field

**3,330 of 7,334 haul rows (45%) carry a NULL `docking_appointment_date`.** Of those,
3,328 are `Delivered` and carry **206,684 program units**. The ADR-0059 bridge skips
every one of them (`haulsUndated`).

ADR-0059 accepted that as a bounded historical tradeoff. Its exact words, echoed
verbatim in the bridge source:

> "every undated haul is historical (pre-anchor) and inert for the live floor, so the
> historical inbound backfill is partial by design and **the live/forward path is fully
> covered**."

**That is false, and it is now the load-bearing defect.** Undated Delivered hauls are
still arriving, every week, and they are not historical:

| First seen (PT)       | Hauls  | Program units | Non-program units | Weight         |
| --------------------- | ------ | ------------- | ----------------- | -------------- |
| 2026-07-31            | 16     | 228           | 727               | 52,525 lb      |
| 2026-08-01 → 08-07    | 18     | 301           | 1,063             | 75,020 lb      |
| 2026-08-10            | 1      | 110           | 0                 | 6,050 lb       |
| **Total post-anchor** | **35** | **639**       | **1,790**         | **133,595 lb** |

Thirty-five real deliveries — 2,429 units, 67 tons of mattresses — arrived at DR3
Woodland since the anchor and **never touched the floor ledger.** They are not lag.
They are not upstream. They were mirrored correctly, with correct unit counts, and then
dropped on the floor by our own bridge.

They are also not anomalies. They are the CA collection network: Ikea Emeryville / West
Sac / Palo Alto, Recology (San Martin, Petaluma, Healdsburg, Santa Rosa), Golden Bear,
Vasco Republic, MT Diablo, Sonoma Transfer Station, Outlaw Hauling, CRDN. Each payload
names `Recycling_Center_Lookup__r.Name = "DR3 Woodland"` and a SVdP DR3 transporter.

### Why they are undated — and why that is our bug, not MRC's

`Docking_Appointment_Date__c` is a **scheduling** field. It is populated when a haul
books a dock slot. Route collections from third-party sites do not book dock slots, so
MyMRC leaves it null — verified in the raw payload of H-137017 (Delivered, 110 program
units, 6,050 lb, Golden Bear): `"Docking_Appointment_Date__c": {"value": null}`.

The bridge calls that field "the delivery-day key." **It is not a delivery date. It is
an appointment date.** Every haul that was delivered without an appointment is
structurally invisible to the floor.

The correlation is exact: **every haul with a `Collection_Source__c` set is undated —
886 of 886** (Retailer, Other, Junk Hauler, Lodging, Military, Public Agency,
Educational Facility). The collection network is precisely the population we drop.

And MyMRC has the field we actually need. Our own Phase-0 discovery deliverable
(`docs/mymrc-discovery-2026-07-22.md`, line 24) enumerates the 52-field
`Haul_Request__c` detail set, which includes:

- **`Recycler_Reported_Delivery_Date__c`** — also one of the 12 enumerated list columns
- `Transporter_Reported_Delivery_Date__c`
- `Actual_Pickup_Date__c`, `Unit_Count_at_Unload__c`, `Recycler_Reported_Arrival_Time__c`

`HAUL_OPTIONAL_FIELDS` in `src/lib/mymrc/record-fields-client.ts` requests 18 fields and
**none of these five.** `grep -rn "Recycler_Reported_Delivery_Date" src/ scripts/ prisma/`
returns nothing. We enumerated the delivery date on 2026-07-22, wrote it down, and never
asked for it.

### The guard is blind to the same class

`FRESHNESS_COLUMN` (`src/lib/mymrc/freshness.ts`) keys **both** haul feeds on
`docking_appointment_date`. The ADR-0070 fix correctly narrowed the measure to Delivered
hauls only — but it still measures them by appointment date. A haul with no appointment
contributes nothing to freshness whether it arrives or not.

So the COR inbound gate (`src/lib/cor/inbound-gate.ts`), which reads that same signal,
would report the delivered feed **fresh** while 100% of the collection-network intake
went unbridged. The instrument and the leak share a blind spot. This is the ADR-0070
lesson repeating one level down: we fixed _which rows_ we measure, not _which column_.

---

## Decisions (proposed — none implemented)

**D1 — Request the delivery date.** Add `Recycler_Reported_Delivery_Date__c` (and
`Transporter_Reported_Delivery_Date__c` as a secondary) to `HAUL_OPTIONAL_FIELDS`, map
to a new `recycler_reported_delivery_date` column on `mymrc_hauls_mirror`. Requesting a
field the record cannot expose is already safe — the client omits it silently.

**D2 — Key inbound on delivery, fall back to appointment.** The bridge's delivery-day
key becomes `COALESCE(recycler_reported_delivery_date, docking_appointment_date)`.
`haulsUndated` then means "genuinely dateless," which is the honest residual — and it
must be **alertable**, not merely counted in a return value. A haul that is Delivered,
carries units, and has no date on any field is a data-quality question for MRC, and it
is the only remaining case where "ask MRC" is the right move.

**D3 — Freshness follows the same key.** `FRESHNESS_COLUMN` for both haul feeds moves to
the same COALESCE. Otherwise the guard keeps certifying a feed it cannot see.

**D4 — Re-detail and backfill before bridging.** All 3,330 undated rows need
`detail_fetched_at` cleared and re-enriched to pick up the new field, then the bridge
re-run over the recovered window via `scripts/fix-woodland-inbound.sh` (the hourly path
only re-bridges a trailing 10 days; the affected days have slid out). Expect the
post-anchor 639 program / 1,790 non-program units to land on their true delivery days.

**D5 — Do not re-litigate the pre-anchor 206,684 units.** They remain out of the live
floor by ADR-0059's anchor design. D4's recovery is scoped to post-anchor days only.

---

## The one discriminating fact still unproven

**We have not yet observed a populated value in `Recycler_Reported_Delivery_Date__c`.**
The field is enumerated in our discovery doc as both a list column and a detail field,
and MyMRC surfaces it in the delivered-hauls list view — strong evidence it is populated
for delivered hauls. But enumeration proves the field _exists_, not that MRC _fills it_.

The captured fixtures predate the field's use and do not contain it, so this cannot be
settled from disk.

**Cheapest proof, and the first step of any build session:** add the field to
`HAUL_OPTIONAL_FIELDS`, clear `detail_fetched_at` for a single known haul (H-137017 —
Delivered, 110 units, Golden Bear, currently undated), run
`scripts/mymrc-enrich-details.mjs`, and read the value. One row, one fetch, no business
write. If it comes back null, fall to `Transporter_Reported_Delivery_Date__c`, then
`Actual_Pickup_Date__c`; if all three are null the fallback is `first_seen_at` as an
explicitly-labelled provisional date, which is materially worse and should be a Bill
decision, not a default.

**Do not skip this step.** Committing to D2 before the value is observed would repeat
the exact error this ADR exists to correct — reasoning from a field's name instead of
its contents.

---

## Consequences

- The floor gets its missing intake and the ~1,900-unit gap gets its most credible
  explanation: 2,429 post-anchor units silently dropped, against a gap of ~1,900.
  The arithmetic is close but not exact, so **the gap is explained, not yet closed** —
  the remaining candidate (stripped over-count) stays live until the recovery lands.
- The July Woodland COR stays mechanically blocked on the negative-ledger refusal until
  D4 runs. That is the gate working correctly.
- Billing exposure is real but bounded in the right direction: unbridged inbound
  _understates_ what DR3 received, so nothing has been overbilled to MRC by this defect.
- Third time is the pattern. 2026-07-31, 2026-08-03, and today all began with "it's
  upstream" and ended with a Vision-side cause. **On this integration, the upstream
  hypothesis has a 0-for-3 record and should carry the burden of proof, not the
  presumption of it.**

## Alternatives considered

- **Bridge undated hauls to their `first_seen_at` day.** Rejected as the primary: it
  invents a delivery date from a scrape artifact, and a backfill would stamp thousands of
  hauls onto the day we happened to discover them. Retained only as an explicitly-labelled
  last resort under D5 if every real date field is null.
- **Ask MRC to set docking appointment dates on route collections.** Rejected: it asks a
  vendor to change their data model to fit ours, for a field that correctly means
  "appointment." MRC is right here; we are reading the wrong column.
- **Treat the collection network as out of scope for the floor.** Rejected: 67 tons of
  mattresses arrived at Woodland and were physically processed. Excluding them would make
  the floor permanently and knowingly wrong.
