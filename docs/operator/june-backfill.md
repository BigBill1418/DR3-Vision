# Operator runbook — June operational backfill + Terex history import (ADR-0048)

**Audience:** Bill (admin). **What this does:** loads the real June numbers into
DR3-Vision's operational tables so July cross-checks, equipment trends, and the
running balance read against a real June — the tracking month.

Everything here is **admin-only** and **audited**. Every promotion is one-shot,
idempotent (re-running does nothing), and refuses to touch any row you entered by
hand.

---

## What you need (the only blockers — ADR-0048 D4)

1. **`JUNE 2026 DAILY LOG WOODLAND.xlsm`** — the live copy with Kelsey's category tabs.
2. **Eugene's June daily log** — whatever artifact holds Jun 24–30.
3. **Janette's Terex spreadsheet** — the full downtime/notes history.

> Until these land, the importers run complete against test fixtures. The parser
> that reads the *real* workbook shape is finalized the day the files arrive; the
> promotion, assertion, conflict logic, and audit are already done and tested.

---

## Part 1 — Backfill the June workbook (Woodland, then Eugene)

### Step 1: Upload the workbook (staging only — nothing operational yet)

1. Go to **Admin → Workbook import & backfill** (`/admin/audit/workbook`).
2. Pick the **Site**, set **Window start / end** to the month, add a period label
   (e.g. `June 2026`), choose the `.xlsm`, and click **Import & audit**.
3. This parses the file into *staging rows only* and runs the retro-audit. No
   operational table is touched yet. The file appears in **Recent imports**.

### Step 2: Promote the staged rows

1. In **Recent imports**, click the file name to open its detail page
   (`/admin/audit/workbook/<id>`).
2. Under **Promote to operational tables**, pick the **Scope**. Only the allowed
   windows appear:
   - **Woodland:** `June 2026 (Jun 1–30)` · expected close **4062**
   - **Eugene:** `June 2026 (Jun 24–30)` · no close assertion (last week only)
3. Click **Dry-run preview** FIRST. The preview shows, without writing anything:
   - **Per-table counts** — how many rows will land in `processed_units_daily`,
     `inbound_loads`, `outbound_materials`, `landfilled_units`,
     `consumer_dropoffs`, and the one anchor `site_inventory_snapshots`.
   - **Clipped rows** — any workbook rows outside the scope window (e.g. Eugene
     rows before Jun 24) are dropped and counted here.
   - **Recomputed close** — the June-30 on-hand balance the promoted numbers
     produce. For Woodland it must read **4062 ✓**. If it reads anything else it
     shows **✗ — commit will refuse**.
   - **Conflicts** — any live (hand-entered) rows already in the window. If there
     are any, promotion is blocked until they're resolved (nothing is merged
     silently).
4. If the preview is clean (close ✓, no conflicts), click **Promote**. This writes
   every row in ONE transaction with `source=import`, stamps each with the
   promotion id, and writes one audit-log row per table. If the recomputed close
   doesn't match 4062, the whole thing rolls back and tells you both numbers.

### Step 3: Repeat for Eugene

Same flow, Eugene site, `June 2026 (Jun 24–30)` scope. Eugene has no known-close
assertion, so the preview just shows counts + conflicts.

### If you run it twice

Nothing happens. A second promotion of the same import is a **no-op** and returns
the prior counts. (If the staged content somehow changed between runs, it refuses
with a SHA-mismatch error rather than double-writing.)

---

## Part 2 — Import the Terex history

1. Go to **Admin → Terex history import** (`/admin/equipment/import`).
2. Read the amber banner: the column mapping is **provisional** until Janette's
   real file is in hand, and it **fails loudly** on an unrecognized shape (it
   never guesses rows).
3. Pick the **Site**, choose the `.xlsx`/`.csv`, click **Import Terex history**.
4. Result: rows land in the equipment log as `source=import`. A row with stated
   downtime becomes a **downtime** event (with hours where the file states them);
   every other row becomes a **note**. The result line shows created / skipped /
   parsed counts.
5. Re-uploading the identical file is a **no-op**. Uploading a different file that
   repeats events already present skips the duplicates (matched on
   site + date + kind + note text).

The imported events show up in the existing equipment trend/tile surface — June
downtime bands included.

---

## Safety properties (why this is safe to run against production)

- **Idempotent** — re-runs do nothing; you cannot double-count.
- **No silent merge** — a live row anywhere in the window blocks the promotion and
  is listed by table + date. You decide before anything is written.
- **Self-proving** — Woodland refuses to commit unless June closes to 4062. That
  4062 figure is configuration (`src/lib/audit/backfill-scopes.ts`), so adding a
  future month is a config change, not code.
- **Fully audited** — one append-only audit row per table per promotion, and a
  `workbook_promotions` / `equipment_history_imports` ledger row per batch.
- **Retro-audit still runs** — the DAY6 broken-roll and Friday-carry defects in
  the source data surface as audit findings, exactly as designed. The promotion
  loads the workbook's own numbers; it does not silently "fix" them.
