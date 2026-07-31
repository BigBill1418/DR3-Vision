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
