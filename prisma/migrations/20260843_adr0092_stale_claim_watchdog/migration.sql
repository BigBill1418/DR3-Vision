-- ADR-0092 — the stale-claim watchdog's ledger, and its born-pilot notify surface.
--
-- WHY THE KEY IS THE LOAD, NOT THE RUN DAY.
--
-- ADR-0037 asks for a cooldown. An in-process one cannot deliver the guarantee
-- that matters here: it lives in the app container's memory, so a restart
-- re-arms it, and it is keyed on wall time rather than on the fact being
-- reported. Keying on `load_id` makes the promise structural — a given stranded
-- load is reported exactly once, ever, however many times the cron fires,
-- whether a second cron container exists, or whatever restarted in between.
-- That is strictly stronger than the policy floor, and it is what makes the
-- internal route safe to `curl` by hand.
--
-- ADR-0035: additive only. This creates one table and seeds two rollout rows;
-- it drops nothing and alters no existing column, so it replays cleanly onto an
-- empty database in lexical order.

CREATE TABLE "stale_claim_alerts" (
    "id" TEXT NOT NULL,
    "load_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "holder_name" TEXT,
    "load_status" TEXT NOT NULL,
    "idle_minutes" INTEGER NOT NULL,
    "notify_mode" TEXT NOT NULL,
    "recipient_count" INTEGER NOT NULL,
    "delivered_count" INTEGER NOT NULL,
    "last_status" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stale_claim_alerts_pkey" PRIMARY KEY ("id")
);

-- The guarantee. One nudge per load, ever.
CREATE UNIQUE INDEX "stale_claim_alerts_load_id_key" ON "stale_claim_alerts"("load_id");
CREATE INDEX "stale_claim_alerts_site_id_created_at_idx" ON "stale_claim_alerts"("site_id", "created_at");

ALTER TABLE "stale_claim_alerts"
    ADD CONSTRAINT "stale_claim_alerts_load_id_fkey"
    FOREIGN KEY ("load_id") REFERENCES "inbound_loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stale_claim_alerts"
    ADD CONSTRAINT "stale_claim_alerts_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The same shape-guards ADR-0088's ledger carries. A wrong `notify_mode` would
-- make the pilot/live audit trail unreadable, and `delivered > recipients` is
-- arithmetically impossible — better refused by the database than explained by
-- a future reader.
ALTER TABLE "stale_claim_alerts"
    ADD CONSTRAINT "stale_claim_alerts_notify_mode_check"
    CHECK ("notify_mode" IN ('live', 'pilot'));

ALTER TABLE "stale_claim_alerts"
    ADD CONSTRAINT "stale_claim_alerts_counts_nonnegative_check"
    CHECK ("recipient_count" >= 0 AND "delivered_count" >= 0 AND "delivered_count" <= "recipient_count");

-- Idle time cannot be negative. `stalenessOf` floors at zero in code; this says
-- the same thing at the boundary that enforces it.
ALTER TABLE "stale_claim_alerts"
    ADD CONSTRAINT "stale_claim_alerts_idle_nonnegative_check"
    CHECK ("idle_minutes" >= 0);

-- ADR-0047 #3 — the notify surface is BORN PILOT at both sites. In pilot the
-- roster is ignored and the nudge goes to admins with the would-have-sent
-- header, so Bill reads a few and agrees with the content AND the targeting
-- before it reaches a site manager. Bill ramps it per-site from /admin/rollout.
--
-- The id is a TEXT-cast uuid deliberately: a uuid-typed one passes CI (which
-- does not run migrations against the real schema) and fails only on deploy.
INSERT INTO "rollout_surfaces" ("id","kind","surface_code","site_id","rollout_state","created_at","updated_at")
SELECT gen_random_uuid()::text, 'notification'::"RolloutSurfaceKind", v.surface_code, s."id",
       v.rollout_state::"RolloutState", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "sites" s
CROSS JOIN (VALUES ('load_stale_claim','pilot')) AS v(surface_code, rollout_state)
WHERE s."code" IN ('eugene','woodland')
ON CONFLICT ("surface_code","site_id") DO NOTHING;
