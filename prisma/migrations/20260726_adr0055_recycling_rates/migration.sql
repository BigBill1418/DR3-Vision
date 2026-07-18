-- ADR-0055 — recycling-rate configuration + outbound stewardship derivation.
-- PURELY ADDITIVE (ADR-0035 clean-replay): two new tables + nullable columns on
-- `outbound_materials` only. Every added column is nullable, so the migration is
-- safe on populated prod tables and replays cleanly on empty PG16. No new enum
-- (commodity reuses the existing "OutboundCommodity"); no Postgres extension
-- (the fleet uses none — see the ADR Alternatives for why btree_gist EXCLUDE was
-- rejected). Dir name sorts after 20260725_adr0037_inventory_foundation.

-- Outbound recycler / commodity-buyer master (GLOBAL — mirrors `transporters`, not
-- the site-scoped `sources`). Formalizes the free-text `outbound_materials.buyer`.
CREATE TABLE "outbound_vendors" (
  "id"         TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "notes"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outbound_vendors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outbound_vendors_name_key" ON "outbound_vendors" ("name");
CREATE INDEX "outbound_vendors_is_active_idx" ON "outbound_vendors" ("is_active");

-- Effective-dated recycler recovery rate per (vendor, commodity). `recycling_percent`
-- is Decimal(5,4) in [0,1] — 0.8100 exactly; fenced by a CHECK constraint below.
CREATE TABLE "recycling_rates" (
  "id"                TEXT NOT NULL,
  "vendor_id"         TEXT NOT NULL,
  "commodity"         "OutboundCommodity" NOT NULL,
  "recycling_percent" DECIMAL(5,4) NOT NULL,
  "effective_from"    DATE NOT NULL,
  "effective_to"      DATE,
  "notes"             TEXT,
  "created_by"        TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recycling_rates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recycling_rates_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "outbound_vendors" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- A recycling fraction is meaningless outside [0,1]; refuse a bad seed at the DB.
  CONSTRAINT "recycling_rates_percent_range_chk"
    CHECK ("recycling_percent" >= 0 AND "recycling_percent" <= 1),
  -- effective_to, when present, must not precede effective_from (a zero-length
  -- [from, from] window IS allowed — a single-day rate).
  CONSTRAINT "recycling_rates_window_order_chk"
    CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);
CREATE INDEX "recycling_rates_vendor_commodity_effective_idx"
  ON "recycling_rates" ("vendor_id", "commodity", "effective_from");
-- Overlap guard (layer 1 of 3, see recycling-rates.ts): at most ONE open-ended
-- ("current") rate per (vendor, commodity). Closed-window overlaps are caught by
-- the transactional write-path check (layer 2) and the resolver (layer 3).
CREATE UNIQUE INDEX "recycling_rates_open_window_uniq"
  ON "recycling_rates" ("vendor_id", "commodity")
  WHERE "effective_to" IS NULL;

-- Outbound derived-stewardship + vendor reference columns (all nullable/additive).
-- recycled_lbs + landfilled_lbs == weight_lbs (complement-by-subtraction); both null
-- when no rate covers (vendor, commodity, ship_date). recycling_percent_applied is the
-- durable snapshot of the fraction used; recycling_rate_id is provenance to the row.
ALTER TABLE "outbound_materials"
  ADD COLUMN "vendor_id"                 TEXT,
  ADD COLUMN "recycled_lbs"              INTEGER,
  ADD COLUMN "landfilled_lbs"            INTEGER,
  ADD COLUMN "recycling_percent_applied" DECIMAL(5,4),
  ADD COLUMN "recycling_rate_id"         TEXT;

ALTER TABLE "outbound_materials"
  ADD CONSTRAINT "outbound_materials_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "outbound_vendors" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "outbound_materials_recycling_rate_id_fkey"
    FOREIGN KEY ("recycling_rate_id") REFERENCES "recycling_rates" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "outbound_materials_vendor_id_idx" ON "outbound_materials" ("vendor_id");
