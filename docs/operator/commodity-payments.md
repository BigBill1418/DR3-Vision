# Commodity Payment Reconciliation — operator guide (ADR-0052)

**Owner:** Daven Stetson (commodities, both sites). **Access:** admins and
all-sites managers — the **Commodity Payments** tile on the Vision dashboard,
or `/dashboard/ops/commodity-payments`.

## What it is

Every outbound commodity load (metal, foam, wood, … — both sites) carries a
payment status so nothing we sell goes unpaid without us seeing it age. A load
you have never touched shows as **Awaiting invoice** automatically — there is
nothing to create.

## The working loop

1. Ship happens → the load appears at the top (newest first), **Awaiting
   invoice**, with its age since ship counting.
2. You invoice the buyer → open **Update** on the row, enter the buyer
   invoice #, optionally the expected $ (plain decimal like `1234.50`), and
   click **Mark invoiced**. Today's date is stamped automatically (Pacific).
3. Payment arrives → **Mark paid** (again date-stamped).
4. Problem → **Mark disputed** with a note; a settled dispute moves back to
   invoiced or paid. A load found short-paid AFTER marking paid can still go
   to disputed.

Statuses only move forward — corrections are new transitions, never edits of
history. Every change is recorded in the audit log with who/when and the
transition.

## Aging + the nightly check

- The view highlights ages past the thresholds: **30 days** since ship with no
  invoice, **45 days** since invoice with no payment (amber).
- The nightly audit runs the same math and files **one finding per buyer**
  listing that buyer's stale loads; it rides the daily digest. It stays silent
  for a site until the FIRST payment record is entered there (bootstrap gate),
  so the backlog doesn't page anyone before Daven starts working it.
- Thresholds live in `audit_check_config` (`m3_commodity_payment_aging`
  params) — data, not code; an admin can tune them.

## CSV export

**Export CSV** downloads exactly what the current filters show (site, status,
aging columns included) — Excel-safe quoting, amounts as plain decimals.

## Out of scope at v1 (deliberate — ADR-0052)

No bank feed, no OCR, no remittance parsing, no price-per-lb contract
validation. Candidates for v2 after a month of real use.
