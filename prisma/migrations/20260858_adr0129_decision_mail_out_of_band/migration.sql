-- ADR-0129 D1 — out-of-band decision-mail confirmation.
-- A decided AP request whose notice reached accounting outside Vision's mail
-- path (hand-filed) gets its own truthful stamp instead of a laundered
-- decision_mail_sent_at. All three are nullable adds: no rewrite, no backfill.
ALTER TABLE "ap_requests"
  ADD COLUMN "decision_mail_filed_out_of_band_at" TIMESTAMP(3),
  ADD COLUMN "decision_mail_filed_out_of_band_by" TEXT,
  ADD COLUMN "decision_mail_filed_out_of_band_note" TEXT;
