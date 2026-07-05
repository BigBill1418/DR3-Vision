# Equipment module (Terex) — operator guide

ADR-0044 (P4). The Terex is the throughput bottleneck, and until now its
operational record lived in a side spreadsheet plus hallway conversation
("Terex is down" was once found handwritten in a numeric cell of the daily log).
This module gives the office one place to log downtime, cost, maintenance, repair,
and notes — and a trend view that DERIVES throughput from the number you already
close every day. Nothing about throughput is entered twice.

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

- **Green bars** — units/day (stripped program + non-program from the daily
  close). This is the SAME number billing bills from; there is no separate
  throughput entry.
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

No work-order workflow, no maintenance scheduling, no alerting, and no
depreciation/asset accounting — `cost_cents` is operational spend context, not
bookkeeping (GP remains the ledger of record). A chronic-downtime alert can become
an audit-engine check later if the data shows a pattern worth paging on.
