-- ADR-0099 — the stale-haul sweep needs a memory.
--
-- Before this, the sweep cancelled an `expected_loads` row the first time a
-- scrape did not list it. Measured on production 2026-08-11 22:04 PT: 69
-- auto-cancellations, of which 67 were later UN-cancelled by a subsequent
-- scrape and 30 came back on the very next hourly pass. Only 2 in the entire
-- history were genuine retirements. Cancelling on a single miss was therefore
-- wrong 97% of the time, and each wrong cancellation hides the slot from the
-- queue outright and reduces the hauls card to "View only".
--
-- Both columns are additive and non-null-safe for existing rows: an
-- already-cancelled row keeps its `cancelled_at`, and every live row starts at
-- a zero streak, which is the correct reading — no scrape has missed it yet.
ALTER TABLE "expected_loads"
  ADD COLUMN "missed_scrape_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "first_missed_at" TIMESTAMP(3);
