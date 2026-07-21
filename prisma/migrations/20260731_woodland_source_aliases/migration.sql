-- ── 2026-07-21 — Woodland (CA) source aliases (prod backfill) ──────────────────
-- 30 evidence-confirmed Woodland-workbook nicknames, inserted directly into prod
-- source_aliases on 2026-07-21; this migration backfills them into the migration
-- history so a rebuilt prod recovers them. Each alias resolves to the verbatim
-- WOODLAND `sources.name`. Alias is globally UNIQUE, so ON CONFLICT DO NOTHING makes
-- this a no-op against the live rows. Mirrors WOODLAND_SOURCE_ALIASES in
-- prisma/seed/addendum-b-data.mjs (change both together).
--
-- NOTE: unlike the eugene aliases (20260730b), the Woodland *sources* are NOT
-- created by any migration — they come from sources.csv via prisma/seed.mjs
-- (seedSources). So on a clean `migrate deploy` DB with no seed run, this JOIN
-- matches zero source rows and inserts nothing (CI-safe, no error); on live prod
-- (and any seeded DB) the sources exist and the rows resolve. The dev/CI/rebuild
-- path is seedSourceAliases in seed.mjs, which runs after seedSources.
INSERT INTO "source_aliases" ("id","alias","source_id","created_at")
SELECT gen_random_uuid()::text, v.alias, s."id", CURRENT_TIMESTAMP
FROM (VALUES
    ('1800 Got Junk Concord', '1-800-Got-Junk? - Concord'),
    ('Anderson', 'Anderson Landfill'),
    ('Bass Hill Landfill - LRSWMA', 'Bass Hill Landfill'),
    ('C &S Waste Ukiah', 'C&S Waste Solutions'),
    ('Clover Flats', 'Clover Flat Resource Recovery Park - Clover Flat Landfill, Inc.'),
    ('Costco Benicia', 'Costco-Innovel- Benicia'),
    ('Costco Sacramento', 'Costco-Innovel -Sacramento'),
    ('Living Spaces', 'Living Spaces - West Sacramento'),
    ('Mc Courtney', 'McCourtney Road Transfer Station'),
    ('NARS', 'North Area Recovery Station (NARS)'),
    ('Neal Road', 'Neal Road Recycling and Waste Facility'),
    ('North Valley Chico', 'North Valley Disposal Transfer Station'),
    ('Oroville', 'Oroville Transfer Station'),
    ('Placer County Eastern Regional Sanitary Landfill, Inc.', 'Placer County Eastern Regional Sanitary Landfill'),
    ('Quincy Mountain Mattress, LLC', 'Quincy Mountain Mattress'),
    ('Recology Auburn', 'Recology Auburn Placer'),
    ('Recology Butte-Colusa - Maxwell Transfer Station', 'Maxwell Transfer Station'),
    ('Recology Yuba', 'Recology Yuba Sutter'),
    ('Recology of the Coast - Pacifica', 'Recology of the Coast'),
    ('Redding Transfer', 'Redding Transfer Station'),
    ('Sacramento Recycling', 'Sacramento Recycling & Transfer Station'),
    ('Speedy Delivery Union City', 'Speedy Delivery LLC - Union City'),
    ('Tehama County / Red Bluff Landfill - Waste Connections of California, Inc.', 'Tehama County / Red Bluff Landfill'),
    ('West Central IGO', 'West Central Landfill'),
    ('Wilkerson Co.', 'Wilkerson Company - Evert Wilkerson'),
    ('ord rd transfer station', 'Ord Ranch Road Transfer Station'),
    ('Recycling Industries', 'Recycling Industries Transfer Station'),
    ('Recycling Industries Yuba', 'Recycling Industries Transfer Station'),
    ('Solano', 'Recology Vacaville Solano'),
    ('Vacaville', 'Recology Vacaville Solano')
) AS v(alias, canonical)
JOIN "sources" s ON s."name" = v.canonical
    AND s."site_id" = (SELECT "id" FROM "sites" WHERE "code" = 'woodland')
ON CONFLICT ("alias") DO NOTHING;
