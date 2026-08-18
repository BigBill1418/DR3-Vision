-- ADR-0108 — editable per-commodity outlier bounds for the outbound coverage page.
--
-- ── What this table is NOT ─────────────────────────────────────────────────
-- It is not a reconciliation. Handoff #264 asked for expected-vs-actual weight
-- variance, and the measurement killed that premise before any code was
-- written: `mymrc_outbound_mirror` carries NO weight for any load (`weight_lbs`
-- NULL on 4,685 of 4,685) and no weight-like key anywhere in its payload
-- (`payload::text ILIKE '%weight%'` matches 0 rows); positive unit counts exist
-- on 1 of the 831 joined loads, so there is no lbs-per-unit denominator either.
-- The workbook's own total-vs-parts already reconciles at 0 drift on 831 of 831.
-- There is no expected-vs-actual pair here, and manufacturing one would make the
-- guess authoritative by being first (ADR-0080 §D7).
--
-- What the data DOES support is the weaker, honest thing: a load whose weight is
-- far from what that commodity usually weighs is worth a human look. That is all
-- this bound claims.
--
-- ── Why the bound is a RATIO and not +/- k x MAD in pounds ─────────────────
-- Measured, not assumed. Load weights are strictly positive, so the largest
-- LOW-side deviation a row can physically have is the median itself — the low
-- side is capped at `median / MAD` deviations:
--
--     Wood   median 3,170  MAD  790  ->  cap  4.01 MAD
--     Waste  median 4,150  MAD  810  ->  cap  5.12 MAD
--     Steel  median 7,380  MAD 1,110 ->  cap  6.65 MAD
--
-- So a symmetric linear bound at k >= 4.01 can NEVER flag a low Wood weight,
-- however absurd — and `Wood 40 lb` (the keying-error-shaped row this was built
-- to catch) sits at 3.96, just inside the cap. A detector structurally incapable
-- of reporting the defect it exists for is worse than no detector.
--
-- Measuring the deviation in LOG space fixes it and makes the band
-- multiplicative: `median / ratio^k .. median * ratio^k`. `Wood 40 lb` then
-- lands 16.5 MAD out. It also reads better to the people who will retune it:
-- "one step is a factor of 1.22, and the line is six steps out".
--
-- ── The seed is PROVENANCE ─────────────────────────────────────────────────
-- Every number below was measured on 2026-08-18 (Pacific) from the pinned
-- revision 7829de7b-1ac9-4e65-b209-588b79496ec5 of "Woodland Outbound Auditing
-- 2026.xlsx" — 869 commodity rows carrying a weight above zero, out of 1,699
-- absorbed (the other 830 are recorded zeros, which are a claim of "carried
-- none" and not a weight). Median and MAD are `percentile_cont(0.5)` over
-- `ln(weight_lbs)`; `spread_ratio` is `exp(MAD)`.
--
-- The three singletons and the two- and three-row commodities are seeded so the
-- screen can SAY they are not flagged and why, rather than leaving a silent gap.
-- Their `sample_n` is below `min_sample_n`, which is what turns them off.
--
-- ADDITIVE ONLY. No existing table, column or row is touched.

CREATE TABLE IF NOT EXISTS "outbound_variance_config" (
  "id"      TEXT PRIMARY KEY,
  "site_id" TEXT NOT NULL,

  -- VERBATIM workbook stem. Matches `doc_outbound_commodity_rows.commodity`
  -- byte for byte; normalising here would silently stop matching.
  "commodity" TEXT NOT NULL,

  "enabled" BOOLEAN NOT NULL DEFAULT true,

  -- Geometric median, in pounds.
  "median_lbs" DECIMAL(12,2) NOT NULL,
  -- One MAD step as a MULTIPLIER. A value of exactly 1 is a zero-width spread;
  -- the reader refuses to flag on it rather than flagging every row that is not
  -- precisely the median.
  "spread_ratio" DECIMAL(8,4) NOT NULL,

  -- How many steps out the line sits.
  "k" DECIMAL(4,2) NOT NULL DEFAULT 6.00,
  -- Below this many observations, flagging is OFF for this commodity.
  "min_sample_n" INTEGER NOT NULL DEFAULT 20,

  -- Provenance. Not controls.
  "sample_n"               INTEGER NOT NULL,
  "seeded_from_version_id" TEXT,
  "seed_measured_on"       DATE,

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "outbound_variance_config_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON UPDATE CASCADE ON DELETE RESTRICT,

  -- A commodity cannot hold two different lines at one site.
  CONSTRAINT "outbound_variance_config_k_positive"      CHECK ("k" > 0),
  CONSTRAINT "outbound_variance_config_ratio_at_least_1" CHECK ("spread_ratio" >= 1),
  CONSTRAINT "outbound_variance_config_median_positive"  CHECK ("median_lbs" > 0),
  CONSTRAINT "outbound_variance_config_min_n_positive"   CHECK ("min_sample_n" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "outbound_variance_config_site_commodity_key"
  ON "outbound_variance_config" ("site_id", "commodity");

-- ── Seed ───────────────────────────────────────────────────────────────────
-- Driven off the `sites` table rather than a literal id, so a fresh database
-- with no sites inserts NOTHING and replays clean. `ON CONFLICT DO NOTHING`
-- keeps a re-run from overwriting a bound somebody has since retuned — a seed
-- that silently reverts an operator's edit is a defect this repo has already
-- shipped once.
INSERT INTO "outbound_variance_config"
  ("id", "site_id", "commodity", "median_lbs", "spread_ratio", "sample_n",
   "seeded_from_version_id", "seed_measured_on")
SELECT
  gen_random_uuid()::text,
  s."id",
  v.commodity,
  v.median_lbs,
  v.spread_ratio,
  v.sample_n,
  '7829de7b-1ac9-4e65-b209-588b79496ec5',
  DATE '2026-08-18'
FROM "sites" s
CROSS JOIN (VALUES
  -- commodity                          median_lbs   ratio     n
  ('Waste',                             4149.99,    1.2235,  334),
  ('Steel',                             7380.00,    1.1709,  268),
  ('Wood',                              3169.98,    1.3026,  220),
  ('Foam',                             36300.00,    1.0766,   29),
  -- Below the floor from here down. Seeded so the screen can say WHY they are
  -- silent instead of just omitting them.
  ('Quilt and Toppers',                35144.15,    1.0481,   10),
  ('Cotton',                             126.00,    2.2909,    3),
  ('Cardboard',                         3604.00,    1.4650,    2),
  ('Shoddy/Felt',                      21000.00,    1.0000,    1),
  ('Plastics',                          4426.00,    1.0000,    1),
  ('Whole Mattresses and Foundations',    55.00,    1.0000,    1)
) AS v(commodity, median_lbs, spread_ratio, sample_n)
WHERE s."name" = 'DR3 Woodland'
ON CONFLICT ("site_id", "commodity") DO NOTHING;
