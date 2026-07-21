-- ADR-0037 amendment (rollup §1/§2/§4/§7) — Addendum-B reference-data seeds. This is
-- the PROD path (prod does not re-run prisma/seed.mjs); prisma/seed.mjs mirrors every
-- change below for dev/CI parity (both idempotent, neither clobbers the other).
--
-- PURELY ADDITIVE / IDEMPOTENT (ADR-0035 clean-replay invariant). On a fresh CI replay
-- the `sites` / `sources` / `users` / `ap_approvers` tables are empty at this point
-- (seeded later by prisma/seed.mjs), so every JOIN/subquery below yields zero rows and
-- every statement is a safe no-op. On production the real rows are renamed / inserted /
-- updated. The dir name sorts AFTER `20260730_adr0037b_addendum_b_schema`, so the
-- `svdp_internal_store` enum value ADD'd there is committed before the store INSERT here
-- USES it (PG16 same-transaction-use rule).
--
-- Source RENAMES (not re-inserts) preserve `sources.id` and every inbound_loads FK; the
-- OLD verbatim names become `source_aliases` so historical workbook / MyMRC rows still
-- resolve. Canonical names + addresses are Rick's MRC-portal-authoritative spellings
-- (rollup §1, incl. MRC's verbatim typo "Recieving").

-- ── §1 — rename OR collection sources to canonical MyMRC names (id-preserving) ──
UPDATE "sources" SET "name" = 'St Vincent De Paul Of Lane County - Salem Thrift Store',
    "street" = '445 Lancaster Dr NE', "city" = 'Salem',
    "notes" = 'OR MRC collection site. Canonical MyMRC name (rollup §1, Rick 2026-07-19). Prior seed name kept as source_alias.', "updated_at" = CURRENT_TIMESTAMP
    WHERE "site_id" = (SELECT "id" FROM "sites" WHERE "code" = 'eugene') AND "name" = 'Salem-Keizer Recycling Center';
UPDATE "sources" SET "name" = 'ST Vincent De Paul OF Lane County-Albany Thrift Store',
    "street" = '2220 Pacific Blvd', "city" = 'Albany',
    "notes" = 'OR MRC collection site. Canonical MyMRC name (rollup §1, Rick 2026-07-19). Prior seed name kept as source_alias.', "updated_at" = CURRENT_TIMESTAMP
    WHERE "site_id" = (SELECT "id" FROM "sites" WHERE "code" = 'eugene') AND "name" = 'Albany-Linn County Transfer Station';
UPDATE "sources" SET "name" = 'St Vincent De Paul Of Lane County - Cottage Grove Store',
    "street" = '910 Row River Rd', "city" = 'Cottage Grove',
    "notes" = 'OR MRC collection site. Canonical MyMRC name (rollup §1, Rick 2026-07-19). Prior seed name kept as source_alias.', "updated_at" = CURRENT_TIMESTAMP
    WHERE "site_id" = (SELECT "id" FROM "sites" WHERE "code" = 'eugene') AND "name" = 'Cottage Grove Transfer Station';
UPDATE "sources" SET "name" = 'St Vincent De Paul Of Lane County - Florence Thrift Store',
    "street" = '2315 HWY 101', "city" = 'Florence',
    "notes" = 'OR MRC collection site. Canonical MyMRC name (rollup §1, Rick 2026-07-19). Prior seed name kept as source_alias.', "updated_at" = CURRENT_TIMESTAMP
    WHERE "site_id" = (SELECT "id" FROM "sites" WHERE "code" = 'eugene') AND "name" = 'Florence Transfer Station';
UPDATE "sources" SET "name" = 'Glenwood Central Recieving Station',
    "street" = '3100 E 17th Ave', "city" = 'Eugene',
    "notes" = 'OR MRC collection site. Canonical MyMRC name (rollup §1 — MRC''s verbatim typo of "Receiving"). Prior seed name kept as source_alias.', "updated_at" = CURRENT_TIMESTAMP
    WHERE "site_id" = (SELECT "id" FROM "sites" WHERE "code" = 'eugene') AND "name" = 'Glenwood Transfer & Recycling Station';

-- ── §4 — 11 SVDP internal-store rows (site_type=svdp_internal_store, active_billing=false) ──
INSERT INTO "sources" ("id","site_id","name","street","city","state","zip","is_active","notes","site_type","active_billing","created_at","updated_at")
SELECT gen_random_uuid()::text, e."id", v.name, v.street, v.city, 'OR', v.zip, true, v.notes, 'svdp_internal_store'::"SourceSiteType", false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT "id" FROM "sites" WHERE "code" = 'eugene') e
CROSS JOIN (VALUES
    ('Division', '201 Division Ave', 'Eugene', NULL, 'SVDP internal store (rollup §4). Retail. Not an MRC collection site — no per-mattress/trans/trailer billing.'),
    ('Seneca', '705 Seneca Rd', 'Eugene', NULL, 'SVDP internal store (rollup §4). Retail.'),
    ('West Eugene', '2167 W 11th Ave', 'Eugene', NULL, 'SVDP internal store (rollup §4). Retail.'),
    ('Chad Drive', '2890 Chad Dr', 'Eugene', NULL, 'SVDP internal store (rollup §4). Retail (SVdP HQ).'),
    ('Q Street', '199 Q St', 'Springfield', NULL, 'SVDP internal store (rollup §4). Retail.'),
    ('Main Street', '4555 Main St', 'Springfield', NULL, 'SVDP internal store (rollup §4). Retail.'),
    ('Junction City', '333 Ivy St/HWY 99', 'Junction City', NULL, 'SVDP internal store (rollup §4). Retail.'),
    ('Oakridge', '47663 Hwy 58', 'Oakridge', NULL, 'SVDP internal store (rollup §4). Retail.'),
    ('Garfield', '888 Garfield St', 'Eugene', NULL, 'SVDP internal store (rollup §4). Retail.'),
    ('CARS', '1175 State Hwy 99N', 'Eugene', NULL, 'SVDP internal store (rollup §4). Used car lot, no mattresses yet (renamed from Affordable Vehicles 2026-07-19).'),
    ('Cleveland WH', '135 N Cleveland St', 'Eugene', '97402', 'SVDP internal store (rollup §4). Warehouse, closed to public (added 2026-07-19).')
) AS v(name, street, city, zip, notes)
ON CONFLICT ("site_id", "name") DO NOTHING;

-- ── §1 — new OR collection rows: The Dalles (new MRC site), Rifes, Roseburg (parked) ──
INSERT INTO "sources" ("id","site_id","name","street","city","state","zip","is_active","notes","active_billing","is_non_program","created_at","updated_at")
SELECT gen_random_uuid()::text, e."id", v.name, v.street, v.city, 'OR', NULL, v.is_active, v.notes, v.active_billing, v.is_non_program, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT "id" FROM "sites" WHERE "code" = 'eugene') e
CROSS JOIN (VALUES
    ('St Vincent De Paul Of Lane County - The Dalles Thrift Store', '505 W 9th St', 'The Dalles', true, 'OR MRC collection site (rollup §1, new — container rental added June, +$100). Canonical MyMRC name.', true, false),
    ('Rifes', NULL, 'Eugene', true, 'OR MRC collection site (rollup §1). Canonical MyMRC name; no address in MyMRC portal.', true, false),
    ('Roseburg Transfer Station', NULL, 'Roseburg', false, 'OR non-program, PARKED pending MRC signature (rollup §1). Rates pre-negotiated. ACTIVATE ON SIGNATURE: set is_active=true + active_billing=true.', false, true)
) AS v(name, street, city, is_active, notes, active_billing, is_non_program)
ON CONFLICT ("site_id", "name") DO NOTHING;

-- ── §1/§12 — source aliases: old seed names + month-to-month customer-name variants ──
-- Resolves each alias to its canonical source (eugene-scoped). Unresolvable names are
-- never dropped by the parser (it emits an `unresolved_site` finding), but these known
-- variants let the alias resolver match without operator review.
INSERT INTO "source_aliases" ("id","alias","source_id","created_at")
SELECT gen_random_uuid()::text, v.alias, s."id", CURRENT_TIMESTAMP
FROM (VALUES
    ('Salem-Keizer Recycling Center', 'St Vincent De Paul Of Lane County - Salem Thrift Store'),
    ('Salem SVDP', 'St Vincent De Paul Of Lane County - Salem Thrift Store'),
    ('SVDP Salem', 'St Vincent De Paul Of Lane County - Salem Thrift Store'),
    ('Albany-Linn County Transfer Station', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'),
    ('Albany SVDP', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'),
    ('SVDP Albany', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'),
    ('SvdP Albany', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'),
    ('Albany', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'),
    ('Cottage Grove Transfer Station', 'St Vincent De Paul Of Lane County - Cottage Grove Store'),
    ('Cottage Grove', 'St Vincent De Paul Of Lane County - Cottage Grove Store'),
    ('SVDP Cottage Grove', 'St Vincent De Paul Of Lane County - Cottage Grove Store'),
    ('Cottage Grove SVDP', 'St Vincent De Paul Of Lane County - Cottage Grove Store'),
    ('Florence Transfer Station', 'St Vincent De Paul Of Lane County - Florence Thrift Store'),
    ('Florence SVDP', 'St Vincent De Paul Of Lane County - Florence Thrift Store'),
    ('SVDP Florence', 'St Vincent De Paul Of Lane County - Florence Thrift Store'),
    ('Glenwood Transfer & Recycling Station', 'Glenwood Central Recieving Station'),
    ('Glenwood Transfer Station', 'Glenwood Central Recieving Station'),
    ('Glenwood TC 143', 'Glenwood Central Recieving Station'),
    ('Glenwood TC 144', 'Glenwood Central Recieving Station'),
    ('The Dalles SVDP', 'St Vincent De Paul Of Lane County - The Dalles Thrift Store'),
    ('SVDP The Dalles', 'St Vincent De Paul Of Lane County - The Dalles Thrift Store'),
    ('The Dalles', 'St Vincent De Paul Of Lane County - The Dalles Thrift Store')
) AS v(alias, canonical)
JOIN "sources" s ON s."name" = v.canonical
    AND s."site_id" = (SELECT "id" FROM "sites" WHERE "code" = 'eugene')
ON CONFLICT ("alias") DO NOTHING;

-- ── §2 — provenance agencies (Sponsors reclassified from drop-off; + Eugene Mattress, U-Haul) ──
INSERT INTO "provenance_agencies" ("id","name","notes","active","created_at","updated_at")
SELECT gen_random_uuid()::text, v.name, v.notes, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
    ('Sponsors', 'Halfway house on Hwy 99 next to Lindholm. Reclassified from a drop-off kind to a provenance agency (rollup §2, Rick 2026-07-19). No billing.'),
    ('Eugene Mattress Company', 'Provenance agency — origin of delivered mattresses (rollup §2). No billing.'),
    ('U-Haul', 'Provenance agency — origin of delivered mattresses (rollup §2). No billing.')
) AS v(name, notes)
ON CONFLICT ("name") DO NOTHING;

-- ── §7 — Kelsey AP-approver auto-remove date 2026-08-01 → 2026-08-08 (vacation extension) ──
-- Guarded by the old value so this never clobbers a manual change and is a clean no-op
-- on re-run / on a clean CI DB (no users → subquery NULL → 0 rows).
UPDATE "ap_approvers" SET "active_until" = '2026-08-08T07:00:00.000Z', "updated_at" = CURRENT_TIMESTAMP
WHERE "active_until" = '2026-08-01T07:00:00.000Z'
    AND "user_id" = (SELECT "id" FROM "users" WHERE "email" = 'kelsey.ruhland@svdp.us');
