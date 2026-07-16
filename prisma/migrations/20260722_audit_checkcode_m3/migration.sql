-- ADR-0052 — register the commodity payment aging check on the AuditCheckCode
-- enum (findings.check_code + audit_runs.checks_run are typed to it). PG16
-- allows ALTER TYPE ... ADD VALUE inside a migration transaction (the value is
-- not USED in the same tx). PURELY ADDITIVE (ADR-0035 clean-replay).
ALTER TYPE "AuditCheckCode" ADD VALUE IF NOT EXISTS 'm3_commodity_payment_aging';
