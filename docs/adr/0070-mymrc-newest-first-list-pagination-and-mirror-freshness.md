# ADR-0070 — MyMRC list pagination reads newest-first, and mirror freshness is measured

- **Status:** Accepted
- **Date:** 2026-07-31
- **Supersedes nothing.** Amends the steady-state list transport of ADR-0038 and the
  ADR-0057 D3 pagination work.

## Context

MyMRC is the only **independent** witness available for validating `workbook-sync`
before cutover. The doc-ingest reconciliation surface cannot play that role: both
of its sides derive from the same extractor, so after activation it compares the
extractor to itself. That puts the MyMRC mirror on the cutover critical path.

On 2026-07-31 the mirror was measured against production:

| mirror                   | rows | max `detail_fetched_at` | newest business date    |
| ------------------------ | ---- | ----------------------- | ----------------------- |
| `mymrc_hauls_mirror`     | 7251 | 2026-07-31 01:00        | current                 |
| `mymrc_processed_mirror` | 984  | 2026-07-22              | `entry_date` 2026-07-20 |
| `mymrc_outbound_mirror`  | 4514 | 2026-07-22              | `entry_date` 2026-07-21 |

The processed and outbound mirrors had not gained a row in nine days, while every
hourly run recorded `status='ok'` — 216 consecutive successful runs over a frozen
mirror. Sampled ledger rows were identical hour after hour:
`processed=ok(listed:50,detail:0) outbound=ok(listed:50,detail:0)`.

### Root cause (measured, not inferred)

The steady-state list transport (`createPortalClient().fetchListRecordIds`) is
**passive**: it navigates the list page and reads whichever `getItems` window the
portal's own UI happened to fire. That window is the list view's **default sort**.

A read-only probe against `mrc-us.my.site.com` on 2026-07-31 established that the
default sort is **ascending**, so the window is pinned to the **oldest** records
in the view — permanently:

```
processed_active  sortBy=null ≡ sortBy='Id'  → M-000300@2024-03-01 … M-000590@2024-03-07
outbound_active   sortBy=null (ascending)    → M-000264@2024-03-01 … M-000369@2024-03-04
```

Both views report `hasMoreData:true` (`totalCount` 985 / 4559). So each hour the
sync re-read page 0 of an ascending list: 50 ids it already held, `detail:0`
because they all had details already, and `ok`. **A record created after
2026-07-22 could never enter the window**, no matter how many times the sync ran.

Hauls escaped only by accident of size: `docking_appointments_rc` holds 18 records,
one page, so its window contains everything including new records.

The historical backfill engine (ADR-0057 D3) _can_ paginate, but it is a one-shot
history drain: all eight cursors set `completed_at` on 2026-07-22 and a drained
cursor is a no-op, so nothing re-ran.

### Why nothing noticed

Every existing guard measures the **scraper**, and the scraper was healthy:

- zero-anomaly fires on 0 listed — the runs listed 50;
- the deadman fires when no run _succeeds_ in 26h — they all succeeded;
- the windowed-list warning fires on `hasMoreData`, which is a normal state for a
  large view and therefore carried no signal.

Nothing measured whether **what we hold is current with the source**. This is the
same "unknown recorded as fine" shape that has cost this codebase repeatedly.

## Decision

**1. The steady-state list pass paginates newest-first.**
`src/lib/mymrc/list-sync-client.ts` wraps a `PortalClient` and replaces only
`fetchListRecordIds`, leaving auth, the self-heal, and the detail transport
untouched. It replays `getItems` explicitly with `sortBy:'-Id'` over a bounded
offset walk, reusing the proven envelope-replay transport built for the backfill.

`-Id` is descending Record ID. For a Salesforce custom object the id sequence
increases with record **creation**, so descending id surfaces the most recently
created records first. This is a claim about creation order, **not** about the
business date column: the same probe showed outbound `M-183449` carrying
`entry_date` 2026-07-23 while lower ids carried 2026-07-30. Nothing here depends
on page 0 holding the N greatest entry dates — only on it reaching recent records.

Termination is structural: the walk iterates a precomputed finite offset list
(`plannedOffsets`), and additionally stops on a drained view or an empty page.
The plan never issues an offset past the portal's SOQL `OFFSET` ceiling of 2000.

**2. Completeness requires two agreeing signals.**
`hasMoreData:false` is not proof a view is drained. Observed live at pageSize 2000:
`outbound_active` returned 2000 ids with `hasMoreData:false` while `totalCount` was
4559 — the portal clamps the page to its 2000 cap and then reports no-more-data.
Trusting that alone would hand the sync engine `complete:true` for a 44%-complete
list, and `markDisappeared` would stamp the 2559 unseen records as gone. A list is
complete only when `hasMoreData:false` **and** the ids account for `totalCount`;
otherwise the walk reports `short_of_total`, `complete:false`, and warns.

**3. `ok` now means the mirror is current.**
New run status `stale_mirror` (`MymrcSyncStatus`, migration
`20260820_mymrc_stale_mirror_status`). A run that does not throw but leaves the
feed's newest business record older than the freshness threshold records
`stale_mirror` with the measured date in `error`, not `ok`.

**4. Freshness is measured on the record's own business date.**
`src/lib/mymrc/freshness.ts` reads `entry_date` (processed/outbound) and
`docking_appointment_date` (hauls) — never `detail_fetched_at` or `last_seen_at`,
which refresh whenever we re-read a record we already hold and therefore stayed
green throughout the freeze. Threshold 96h: clears a weekend plus a holiday Monday,
and would have fired on day 5 of a 9-day freeze rather than never.

Hauls are future-dated, so a healthy hauls feed reports a negative age and can
never be stale; when the feed stops, the newest appointment recedes into the past
and crosses the threshold on its own.

**5. Alarm grading (ADR-0037 five-question gate).**
Actionable in 5 min (run the catch-up); not customer-visible; self-heals hourly
before the threshold; one fingerprint per site+feed with a 24h cooldown; tier-2
click to `/admin/mrc-scrape`. ⇒ **`high`, at most one page per site+feed per day.**
Deliberately **not** a per-run page — the per-run signal is the ledger status.

A freshness query that throws does **not** degrade to `ok`: mirror currency is then
unknown, and the run fails loudly with the cause attributed.

## Consequences

- New records reach the mirror hourly. Verified live through the real code path:
  processed returned business dates 2026-07-21…2026-07-29 and outbound
  2026-07-20…2026-07-30, none of which existed in the mirror.
- The default budget (4 pages × 200 = the 800 most-recently-created records per
  feed per run) is ~3 orders of magnitude above the observed daily record rate.
- Disappeared-detection is _more_ conservative than before, never less: a capped or
  short-of-total walk reports `complete:false`, which already suppresses it.
- `MYMRC_LIST_PAGE_SIZE` / `MYMRC_LIST_MAX_PAGES` provide a bounded catch-up
  without an unbounded re-scrape. An invalid value warns and falls back.

## Known issues this ADR does NOT close

- **Hauls disappeared-marking is over-broad.** The hauls list view
  (`docking_appointments_rc`) is a narrow _active_ view of ~18 records, but
  `markDisappeared` operates on the whole mirror table. Because that view is a
  single complete page, every haul not currently scheduled is stamped
  `disappeared_at` — all 6182 Delivered/General rows currently are. The inbound
  bridge deliberately ignores `disappeared_at`, so ADR-0059 is unaffected, but
  `expected_loads` filters on it. Pre-existing; unchanged by this ADR.
- **`undated:2301` on the inbound bridge is a genuine source gap, not a parse
  failure.** All 2301 rows carry `Docking_Appointment_Date__c` with a JSON `null`
  value and the companion time field as the empty template `"// : PT"`; dock door
  is also null on 2301/2301. Across the whole table there are **0** cases of a
  payload string date failing to reach its column (3955 payload dates → 3955
  populated columns). 1326 of the 2301 form one contiguous 100%-undated block
  (`H-060000`–`H-075999`). The header comment in `inbound-bridge.ts` claiming the
  "live/forward path is fully covered" is true today only by timing — undated rows
  appear right up to the newest haul numbers — and should be revisited when
  Delivered rows flow again.

---

## Amendment 1 — the freshness guard was blind, and the freeze had a deeper cause (2026-07-31, ACCEPTED)

The original ADR shipped a mirror-freshness alarm and recorded the over-broad
hauls disappeared-marking as a known, unfixed defect. Both of those need
correcting, and the root cause of the nine-day inbound freeze turned out to sit
one level below either.

### 1. The freshness guard could not detect the outage it was written for

It measured `max(docking_appointment_date)` across the **whole** haul mirror. A
haul is `Confirmed` when it is **scheduled**, and confirmed appointments are dated
into the FUTURE. Measured live, mid-outage:

| measured over          | newest     | age          |
| ---------------------- | ---------- | ------------ |
| all hauls (as shipped) | 2026-08-10 | **−9 days**  |
| delivered hauls        | 2026-07-21 | **+10 days** |

Future-dated scheduling **permanently masked** a delivered feed frozen since
2026-07-22. The guard read healthy throughout and would have gone on reading
healthy forever — the recede-into-the-past reasoning in the original docstring
only holds if the WHOLE feed stops, and here half of it kept moving.

It now measures **delivered** hauls only. That is also the half that matters:
`inbound_loads` is bridged from delivered hauls. Against the same live data it
reports 10 days stale and fires — it would have fired on **day 5**.

### 2. The root cause: nothing ever polled the view that says "delivered"

The hourly sync bound three list views — `docking_appointments_rc`,
`processed_active`, `outbound_active`. **A haul LEAVES the docking-appointments
view when MRC marks it Delivered**, appearing in `completed_hauls`, which only the
one-shot backfill ever read. So the mirror could not observe the transition at
all: `Confirmed` rows refreshed hourly and looked healthy while the delivered half
sat frozen. That is why the freeze was possible, not merely why it went unnoticed.

A `haulsCompleted` feed now reads `completed_hauls` hourly — same object, same
mirror, same page, a different list view.

### 3. The over-broad disappeared-marking is FIXED, and had to be

ADR-0070 recorded this as known-and-unfixed on the grounds that nothing consumes
`disappeared_at` for hauls. That was true and is no longer sufficient: with two
views over one mirror, an unscoped sweep lets each feed declare the other's
records vanished. The active view is ~73 rows, so it COMPLETES every hour — it was
stamping all ~7,190 delivered hauls on every single run.

**"Not in this list" stops meaning "gone" the moment one mirror has two partial
views.** Each feed is now scoped to the statuses its own view can contain. A NULL
status is excluded by `in`/`notIn` semantics — the money-safe direction: a haul we
have not detail-fetched is never declared gone on the strength of a list it may
not belong to.

Measured before/after the deploy: delivered rows carrying `disappeared_at` fell
from **7,190** (all of them) to **6,447**, and confirmed rows from 56 to **2**.

### 4. A feed can no longer be half-added

`haulsCompleted` was added to the type, the bindings, the adapters and the field
map — **and did not run**. `syncSite` and `checkDeadman` each carried their own
hardcoded `['hauls', 'processed', 'outbound']`. The constant said four feeds, the
runners iterated three, and the sync reported a clean run throughout. A feed that
exists but is never iterated is indistinguishable from a feed that was never
added. Both loops now iterate `FEED_NAMES`.

This was caught by RUNNING the sync after deploying, not by reading the diff.

### What this does NOT fix

**The negative floor is not a Vision defect.** As of 2026-07-31 the Woodland floor
is **−4,243** (program −5,129 / non-program 886, from the app's own probe). Two
causes, neither of them sync:

1. ~34 hauls dated 07-23→07-31 are still `Confirmed` in MRC's portal and carry
   **0 units** — units populate on delivery. At July's ~106 units/haul that is
   ≈3,600 units. Vision is reporting MRC faithfully; the fix is upstream.
2. **880 units sit in nine `submitted` loads whose pool split is unset.** Only
   `verified` loads reach `onHand`, because verification is what sets
   program/non-program. One verified load (150 units) is the only inbound counting
   since the anchor.

### Verification note

Three guards in this amendment failed to falsify on the first attempt — the
delivered-only filter (the test exercised the arithmetic, not the query), the
`FEED_NAMES` loop (the test asserted the constant, not the iteration), and earlier
the `priorMonthAnchor` case. Each was rewritten to target the defect itself rather
than the thing beside it. Guards that have never been observed to fail are not
guards.
