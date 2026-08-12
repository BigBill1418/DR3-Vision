-- ADR-0071 Amendment 1 — the quota monitor must be able to say it is alive.
--
-- ADR-0071 §4 guarded the SUPPRESSED week: "nobody missed twice" and "the cron
-- never ran" look identical from an inbox, so a suppressed week still writes a
-- `processor_quota_logs` row. That guard was correct and it was placed one step
-- too far down the path.
--
-- The digest only ever selected `enabled = true` configs. Shipped disabled
-- (deliberately, pending Bill's threshold decision), the run therefore matched
-- ZERO configs, fell straight out of the loop, wrote no row anywhere, and
-- returned `{"outcomes":[]}`. From 2026-07-31 to 2026-08-11 the cron fired every
-- morning at 06:00 PT and left behind exactly the same evidence a dead cron
-- would have left: none. The operator's question — "we are supposed to get
-- alerts and I have seen nothing" — could not be answered from the system.
--
-- `processor_quota_runs` is the standing state that answers it. One row per LIVE
-- run, written whether or not any config is enabled and whether or not anything
-- was sent. It is deliberately NOT keyed on (site, week): `processor_quota_logs`
-- owns that key and uses it for send-idempotency, so a heartbeat sharing it
-- would claim the week and permanently suppress the first real digest.
--
-- Mirrors `bonus_chain_health_runs` (ADR-0019.4) — the same shape, for the same
-- reason: a monitor whose only output is an event is invisible until it fires.

CREATE TABLE "processor_quota_runs" (
    "id" TEXT NOT NULL,
    "ran_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Sites holding a config row at all. Zero means the feature is not merely
    -- off, it is unconfigured — a different problem with a different fix.
    "configs_total" INTEGER NOT NULL DEFAULT 0,
    -- Of those, how many would actually mail. Zero with a healthy heartbeat is
    -- the honest reading of "alive, but switched off".
    "configs_enabled" INTEGER NOT NULL DEFAULT 0,
    -- Disabled sites are still EVALUATED read-only, so this counts them: the
    -- heartbeat can report what the digest would have said without sending it.
    "sites_evaluated" INTEGER NOT NULL DEFAULT 0,
    "processors_seen" INTEGER NOT NULL DEFAULT 0,
    "flagged_total" INTEGER NOT NULL DEFAULT 0,
    -- Digests actually DELIVERED to at least one recipient. Per ADR-0095, an
    -- attempted send that reached nobody must never be recorded as a send.
    "digests_sent" INTEGER NOT NULL DEFAULT 0,
    -- Per-site breakdown: [{siteCode, enabled, processorsSeen, flaggedCount,
    -- wouldFlag, suppressed, delivered, skipped}]. Diagnosable without a redeploy.
    "detail" JSONB NOT NULL,
    "error_text" TEXT,

    CONSTRAINT "processor_quota_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "processor_quota_runs_ran_at_idx" ON "processor_quota_runs"("ran_at");

-- ── Eugene was structurally invisible ──────────────────────────────────────
--
-- ADR-0071 seeded a config for Woodland only and scoped every query by
-- `site_id`, which is correct — an Eugene processor can never reach a Woodland
-- digest. The consequence nobody stated: with no Eugene row, `findMany` returns
-- no Eugene config, so Eugene processors are not "passing the quota", they are
-- not being looked at. Eugene ran 3–4 processors with recorded production every
-- week since go-live and 2 of them would have flagged in the week of 2026-08-03.
--
-- Seeded DISABLED, exactly like Woodland: this changes no behaviour today and
-- sends nothing to anyone. It makes the site visible on /admin/processor-quota
-- so its threshold can be tried against real weeks before anyone turns it on.
-- Recipients are deliberately NOT seeded — a guessed address does not fail
-- loudly (ADR-0071's own finding), so Eugene's list is Bill's to fill in.
INSERT INTO "processor_quota_config" ("id", "site_id", "enabled", "quota_units", "min_misses", "send_time_pt", "send_dow", "created_at", "updated_at")
SELECT gen_random_uuid()::text, s."id", false, 75, 2, TIME '06:00:00', 1, NOW(), NOW()
FROM "sites" s
WHERE s."code" = 'eugene'
  AND NOT EXISTS (SELECT 1 FROM "processor_quota_config" c WHERE c."site_id" = s."id");
