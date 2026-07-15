-- 2026-07-15 (operator-directed, Bill) — ADR-0046 Amendment 4: stamp the ORIGINAL
-- vendor invoice on BOTH decisions, attach the stamped original to the decision
-- email, and archive that stamped PDF to R2. Two nullable columns record the
-- artifacts: decision_pdf_r2_key (the R2 key of the archived stamped decision PDF)
-- and original_attachment_sha256 (sha256 of the ORIGINAL attachment bytes — the
-- second half of the dual-sha tamper record). PURELY ADDITIVE (ADR-0035 clean-replay).
ALTER TABLE "ap_requests" ADD COLUMN "decision_pdf_r2_key" TEXT;
ALTER TABLE "ap_requests" ADD COLUMN "original_attachment_sha256" TEXT;
