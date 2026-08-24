-- ADR-0124 — the weight decision becomes a fact about the truck.
--
-- `recordWeightSkip` wrote NOTHING. Its whole body was `assertOwn(args)` under a
-- comment reading "no DB change needed; the weight stage gates only on the
-- user's choice". The user's choice lived in one browser tab, as a `useState`,
-- so it died on every reload and every takeover and the next operator was asked
-- about the same truck again.
--
-- That is the `bolDone` defect exactly (ADR-0121): a step whose completion is
-- recorded only on the device that completed it. It has not trapped anyone,
-- because "None" is always live — but a stage the floor can be sent back through
-- indefinitely is the same class, and leaving one client latch in a dispatch
-- while removing the other keeps half the defect alive.
--
-- Nullable and additive: every existing row reads NULL, which is honest — no
-- load in history has a recorded skip, because until now the skip was never
-- recorded anywhere.

ALTER TABLE "inbound_loads"
  ADD COLUMN "weight_skipped_at" TIMESTAMP(3);
