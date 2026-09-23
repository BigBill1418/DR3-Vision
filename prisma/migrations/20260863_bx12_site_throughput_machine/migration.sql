-- BX-12 (ADR-0137) — a site's throughput machine is DESIGNATED, never inferred.
--
-- Until now `resolveSiteThroughputMachine` picked "the OLDEST active
-- `terex`-category row at the site with ANY invoice link". The ADR-0062 seed
-- files the shear machines under `terex` too, and `EQ24 — Shear Machine`
-- (seeded 2026-07-28) is older than `Terex` (2026-07-30). The shear got its
-- first invoice link 2026-09-02 6:21 AM PDT, and from that moment Woodland's
-- daily Terex readings were saved on the shear. EQ43 / EQ74 would have flipped
-- it the same way the day they were invoiced.
--
-- One row per site (the PRIMARY KEY is the one-per-site guarantee):
--   * row with `equipment_id`       → that row IS the site's throughput machine;
--   * row with `equipment_id` NULL  → the site deliberately has NO machine
--                                     (Eugene — its gap scan stays silent);
--   * NO row                        → not configured: every reader FAILS LOUDLY
--                                     (`ThroughputMachineNotConfiguredError`),
--                                     it never guesses.
-- `equipment_id` is UNIQUE, so one machine cannot serve two sites.
--
-- CLEAN-REPLAY SAFE (ADR-0035): every statement is guarded; replays green on an
-- empty PG16 and again on a database that already has it. TEXT ids per the
-- house rule. Sorts after `20260862_adr0135_equipment_identity`.

CREATE TABLE IF NOT EXISTS "site_throughput_machines" (
  "site_id"      TEXT         NOT NULL,
  "equipment_id" TEXT,
  "reason"       TEXT         NOT NULL,
  "set_by"       TEXT,
  "set_label"    TEXT,
  "set_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_throughput_machines_pkey" PRIMARY KEY ("site_id"),
  CONSTRAINT "site_throughput_machines_reason_nonempty" CHECK (length(btrim("reason")) > 0),
  -- ADR-0036 actor discipline: a human id OR a named system label, never neither.
  CONSTRAINT "site_throughput_machines_actor" CHECK ("set_by" IS NOT NULL OR "set_label" IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS "site_throughput_machines_equipment_id_key"
  ON "site_throughput_machines" ("equipment_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_throughput_machines_site_id_fkey') THEN
    ALTER TABLE "site_throughput_machines" ADD CONSTRAINT "site_throughput_machines_site_id_fkey"
      FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_throughput_machines_equipment_id_fkey') THEN
    ALTER TABLE "site_throughput_machines" ADD CONSTRAINT "site_throughput_machines_equipment_id_fkey"
      FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ── Production designations (Bill, 2026-09-23 ~7:20 AM PDT) ───────────────
-- Keyed on the exact production row, and guarded so it is a no-op anywhere that
-- row does not exist live at Woodland (CI, a fresh dev database): there the
-- site stays UNCONFIGURED and fails loudly rather than being handed a guess.
--   Woodland → `Terex` (7e35a4aa…): 19 invoice links (Kelliher 0183 "TAS815
--              Shredder" among them), 337 days of history through 2026-09-01,
--              and the hour meter the shear-filed days continue (2,895.25 at
--              09-01 → 3,030.85 at 09-22).
--   Eugene   → none. It has never had a throughput row or a gap alert; its only
--              `terex`-category row is `EQ65`, a shear with no invoices.
INSERT INTO "site_throughput_machines" ("site_id", "equipment_id", "reason", "set_label")
SELECT s."id", e."id",
       'BX-12: Woodland''s throughput machine is the Terex (Bill, 2026-09-23). Replaces the '
       || '"oldest terex-category row with an invoice link" inference, which picked EQ24 — Shear Machine from 2026-09-02.',
       'system:bx12-migration'
  FROM "sites" s
  JOIN "equipment" e ON e."id" = '7e35a4aa-d022-4e65-b64f-580c74f21cf1'
                    AND e."site_id" = s."id"
                    AND e."is_active"
                    AND e."merged_into_id" IS NULL
 WHERE s."code" = 'woodland'
ON CONFLICT ("site_id") DO NOTHING;

INSERT INTO "site_throughput_machines" ("site_id", "equipment_id", "reason", "set_label")
SELECT s."id", NULL,
       'BX-12: Eugene has no throughput machine (no Terex; EQ65 is a shear). Explicit, so the gap scan stays silent by decision.',
       'system:bx12-migration'
  FROM "sites" s
 WHERE s."code" = 'eugene'
ON CONFLICT ("site_id") DO NOTHING;
