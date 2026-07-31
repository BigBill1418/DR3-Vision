-- ADR-0071 — processor production quota alert (Woodland exception digest).
--
-- Additive only. This feature is READ-ONLY against production data: the counts
-- it evaluates live in `bonus_daily_entries`, written by the bonus entry flow,
-- and it never touches `processed_units_daily` (sole writer: workbook-sync,
-- ADR-0049/0058). The only tables it owns are the three created here.
--
-- TEXT ids throughout, per the house rule — hand-written migrations must not use
-- UUID columns, or the Prisma client's String ids mismatch on deploy.

CREATE TABLE IF NOT EXISTS "processor_quota_config" (
  "id"           TEXT PRIMARY KEY,
  "site_id"      TEXT NOT NULL UNIQUE,
  "enabled"      BOOLEAN NOT NULL DEFAULT false,
  -- Decimal(5,1) mirrors bonus_daily_entries.mattress_count exactly: a half-shift
  -- 49.9 must compare on the scale it was recorded on, not a rounded copy.
  "quota_units"  DECIMAL(5,1) NOT NULL DEFAULT 75,
  "min_misses"   INTEGER NOT NULL DEFAULT 2,
  "send_time_pt" TIME NOT NULL DEFAULT '06:00:00',
  "send_dow"     INTEGER NOT NULL DEFAULT 1,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processor_quota_config_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE,
  -- A zero/negative quota would make every recorded day a miss and flag the whole
  -- floor; a zero threshold would flag a processor who never missed at all.
  CONSTRAINT "processor_quota_units_positive"  CHECK ("quota_units" > 0),
  CONSTRAINT "processor_quota_min_misses_sane" CHECK ("min_misses" >= 1),
  CONSTRAINT "processor_quota_dow_valid"       CHECK ("send_dow" BETWEEN 1 AND 7)
);

CREATE TABLE IF NOT EXISTS "processor_quota_recipients" (
  "id"               TEXT PRIMARY KEY,
  "config_id"        TEXT NOT NULL,
  "email"            TEXT NOT NULL,
  "added_by_user_id" TEXT,
  "added_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processor_quota_recipients_config_fk"
    FOREIGN KEY ("config_id") REFERENCES "processor_quota_config"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "processor_quota_recipients_config_email_key"
  ON "processor_quota_recipients" ("config_id", "email");
CREATE INDEX IF NOT EXISTS "processor_quota_recipients_config_idx"
  ON "processor_quota_recipients" ("config_id");

-- One row per (site, week) EVALUATED — including weeks that deliberately stayed
-- silent. Without a row for a suppressed week, "nobody missed twice" and "the
-- cron never ran" look identical, which is the failure shape this codebase keeps
-- having to amend away.
CREATE TABLE IF NOT EXISTS "processor_quota_logs" (
  "id"              TEXT PRIMARY KEY,
  "site_id"         TEXT NOT NULL,
  "week_start"      DATE NOT NULL,
  "week_end"        DATE NOT NULL,
  "evaluated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processors_seen" INTEGER NOT NULL DEFAULT 0,
  "flagged_count"   INTEGER NOT NULL DEFAULT 0,
  "suppressed"      BOOLEAN NOT NULL DEFAULT false,
  "recipient_count" INTEGER NOT NULL DEFAULT 0,
  "sent_at"         TIMESTAMP(3),
  "error_text"      TEXT,
  CONSTRAINT "processor_quota_logs_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "processor_quota_logs_site_week_key"
  ON "processor_quota_logs" ("site_id", "week_start");
CREATE INDEX IF NOT EXISTS "processor_quota_logs_site_week_idx"
  ON "processor_quota_logs" ("site_id", "week_start");

-- ── Seed: Woodland only, DISABLED ──────────────────────────────────────────
-- Woodland only because the decision was Woodland processing staff (the query is
-- site-scoped regardless, so Eugene cannot appear even if a config existed).
-- Disabled because a digest that starts mailing the moment a migration lands is
-- how an unreviewed alert reaches three people at 6am.
INSERT INTO "processor_quota_config"
  ("id", "site_id", "enabled", "quota_units", "min_misses", "send_time_pt", "send_dow",
   "created_at", "updated_at")
SELECT gen_random_uuid()::text, s."id", false, 75, 2, '06:00:00', 1,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "sites" s
WHERE s."code" = 'woodland'
ON CONFLICT ("site_id") DO NOTHING;

-- Recipients seeded per the decision: Bill, Morena, Janette.
--
-- The addresses are resolved from the LIVE roster and were verified against it
-- on 2026-07-31 — two of the three initially assumed here were wrong (Morena is
-- `morena.gomez@`, not `morena.chavez@`; Janette is `janette.tomas@`, not
-- `janette.gonzalez@`). A guessed address does not fail loudly: it silently seeds
-- a recipient list that is short two of the three people who need the alert.
--
-- `is_active` and the empty-string guard both matter: each of these three ALSO
-- holds an operator account carrying an EMPTY email (PIN-only floor login), and
-- Bill has a deactivated `operations@svdp.us`. Without the guards this seeds
-- blank rows and a dead address.
INSERT INTO "processor_quota_recipients" ("id", "config_id", "email", "added_at")
SELECT gen_random_uuid()::text, c."id", u."email", CURRENT_TIMESTAMP
FROM "processor_quota_config" c
JOIN "sites" s ON s."id" = c."site_id" AND s."code" = 'woodland'
JOIN "users" u ON lower(u."email") IN (
  'bill.barnard@svdp.us',
  'morena.gomez@svdp.us',
  'janette.tomas@svdp.us'
)
WHERE u."is_active" = true AND coalesce(u."email", '') <> ''
ON CONFLICT ("config_id", "email") DO NOTHING;

-- The notification surface, so notifyStaff() has a registered gate to read.
-- PILOT: the first sends land on admins with the pilot banner naming who it would
-- have gone to, which is the point of ADR-0047's gate — validate content AND
-- targeting before it reaches staff.
INSERT INTO "rollout_surfaces"
  ("id", "kind", "surface_code", "site_id", "rollout_state", "created_at", "updated_at")
SELECT gen_random_uuid()::text, 'notification', 'processor_quota_digest', s."id", 'pilot',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "sites" s
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
