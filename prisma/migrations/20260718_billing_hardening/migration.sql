-- 2026-07-10 stack sweep — billing hardening (DB backstops for two audited
-- check-then-act races). PURELY ADDITIVE (ADR-0035 clean-replay: both indexes
-- create on empty PG16; prod has zero rows in both tables today).
--
-- Dir name sorts after 20260717_trade_discount_credit_memos_verify.

-- One version per (site, kind, month) chain: the service computes max+1 inside
-- a transaction, but nothing stopped two concurrent generates from minting the
-- same version. Now the second insert conflicts here.
CREATE UNIQUE INDEX "invoices_site_id_kind_billing_month_version_key"
  ON "invoices"("site_id", "kind", "billing_month", "version");

-- One OPEN credit memo per invoice (rollup §1.4 discipline): the service's
-- findFirst-then-create pre-check races under concurrency; this partial unique
-- index is the atomic guard. Terminal memos (applied / void_and_reissue_
-- triggered) don't block a new correction.
CREATE UNIQUE INDEX "credit_memos_one_open_per_invoice_key"
  ON "credit_memos"("invoice_id")
  WHERE "status" IN ('proposed', 'sent_to_mrc', 'accepted', 'rejected');
