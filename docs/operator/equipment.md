# Equipment module (Terex) — operator guide

ADR-0044 (P4). The Terex is the throughput bottleneck, and until now its
operational record lived in a side spreadsheet plus hallway conversation
("Terex is down" was once found handwritten in a numeric cell of the daily log).
This module gives the office one place to log downtime, cost, maintenance, repair,
and notes — plus a trend view over the daily throughput number the floor now
**CAPTURES** directly (ADR-0079: entered units + real run hours in
`equipment_daily_throughput`, which superseded ADR-0044 D2's floor-wide derivation).
It is entered once, in one place, by the manager who runs the machine.

## Where it lives

- **Trend page:** `/dashboard/<site>/equipment` (also reachable from the
  **Equipment** tile on the `/` launcher and the small equipment tile on the site
  dashboard).
- **Access:** any manager on their own site, plus admins / all-sites managers.
  Site-scoped — Eugene and Woodland never mix (hard rule #2).
- **API:** `GET/POST /api/manager/<site>/equipment`,
  `PATCH/DELETE /api/manager/<site>/equipment/<id>`,
  `GET /api/manager/<site>/equipment?view=throughput` for the derived series.

## Logging an event (the 30-second flow)

Juan's word-of-mouth path becomes: the floor reports to the office (unchanged
human flow); the office logs it in the entry row at the bottom of the page.

Fields:

- **Date** — the day it happened.
- **Kind** — one of `downtime`, `maintenance`, `repair`, `cost`, `note`.
- **Hours down** — only enabled for `downtime`/`maintenance`/`repair` (a cost or a
  note has no downtime). Quarter-hour steps.
- **Cost ($)** — optional on any kind (e.g. a repair with a vendor invoice, or a
  standalone `cost` row).
- **Vendor**, **Notes** — free text.

Only `kind=downtime` hours draw the **red band** on the trend and feed the
units/run-hour math. Maintenance and repair hours are recorded but treated as
planned interventions, not line-stopping downtime.

## Reading the trend

- **Green bars** — units/day, from the captured `equipment_daily_throughput` row for
  that day (ADR-0079; sheet-era history imported by ADR-0081 is structurally labelled
  and never blended with entered rows). A day with **no row draws as "not recorded"**,
  never as zero (ADR-0077 D4) — and that absence is exactly what the ADR-0088
  throughput-gap watchdog reads.
- **Bright line** — the 7-day rolling mean (null days without a close are skipped,
  not counted as zero).
- **Red bands** — days with `kind=downtime` hours logged.
- **Amber dashed line** — the `pocketcoil_estimate` from the daily close, drawn on
  its own scale so you can eyeball whether pocket-coil-heavy days track with lower
  throughput (Juan's Q4 hypothesis becomes visible instead of anecdotal).
- **units/run-hour** (in the CSV / tooltips) = units/day ÷ (assumed working day −
  downtime hours). The working day is an **assumed 8 hours** (`assumed_day_hours`)
  because the productive-hours figure isn't captured; it's labeled in the legend
  and is a one-line change if the real number is confirmed.
- **Monthly cost** — the sum of `cost_cents` per calendar month in the window.
- **Export CSV** — the daily series (date, units/day, hours down, units/run-hour,
  7- & 30-day means, pocketcoil estimate).

## Editing and removing

- Events are **freely editable** — click into the log and PATCH. Every edit writes
  an `audit_log` row; the audit trail, not a lock, is the integrity mechanism.
- **Removing** an event **soft-voids** it (**Void** button): the row is retained
  and hidden from the trend + tile, and the void is itself audited. There is **no
  hard delete** (hard rule #6). A voided event cannot be edited.

## A second machine (no migration)

`equipment_code` defaults to `terex` but is a plain string. To track a second
machine, pass its code on entry (the API accepts `equipmentCode`) and add it to
the UI filter — it's a data value, never a schema change.

## Deliberately out of scope (D4)

No work-order workflow, no maintenance scheduling, and no depreciation/asset
accounting — `cost_cents` is operational spend context, not bookkeeping (GP remains
the ledger of record).

**Alerting is no longer out of scope (ADR-0088).** The throughput-gap watchdog is a
scheduled morning pass that asks whether the PREVIOUS WORKING DAY got a live
throughput row for the site's machine, and says so once if it did not. It reads **row
existence, never magnitude** — a recorded zero is recorded; a voided-only day is
missing — and Monday looks back to Friday. It ramped **live at Woodland on
2026-08-10** (`equipment_throughput_gap`), after its first scheduled pass at 08:30 PT
correctly caught Friday 2026-08-07 unrecorded. **Eugene stays `pilot` by design:**
there is no machine there, so its scan cannot fire regardless of state. It routes
through `notifyStaff()`, not ntfy — Bill's phone is reserved for the nudge itself
failing to deliver.

That is a capture-gap reader only. **Chronic-downtime alerting is still unbuilt** and
can become an audit-engine check later if the data shows a pattern worth paging on.
