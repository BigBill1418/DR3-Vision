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
-- is_non_program=true: Rick §4 — these stores "are not Collection sites in conjunction
-- With the MRC", so the mattresses they bring are OUTSIDE the MRC program. The verify-gate
-- / promotion DEFAULT split routes their inbound units to the NON-program (non-billable)
-- pool, not the program pool billed at UNITSMO (money-safe; a manager may override at
-- verify). Mirrors SVDP_INTERNAL_STORE_CLASSIFICATION in prisma/seed/addendum-b-data.mjs.
INSERT INTO "sources" ("id","site_id","name","street","city","state","zip","is_active","notes","site_type","active_billing","is_non_program","created_at","updated_at")
SELECT gen_random_uuid()::text, e."id", v.name, v.street, v.city, 'OR', v.zip, true, v.notes, 'svdp_internal_store'::"SourceSiteType", false, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
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

-- ── §8/§13 — GP per-site billing identifiers (Mary-confirmed; corrects PR #128) ──
-- PROD path for the gp_site_billing_config corrections that prisma/seed.mjs
-- (seedGpSiteBillingConfig) mirrors for dev/CI — WITHOUT this the corrections shipped
-- ONLY in seed.mjs, which prod never re-runs, so prod would keep the stale
-- "DR3W"/null identifiers and pilot v2 exports would render PO "M/DD/YY DR3W" for
-- Woodland and null customerId/PO for Eugene — exactly the defect §13 corrects.
-- Woodland: Customer ID MRCL001, PO suffix "DR3 W" (WITH space — §13). Eugene:
-- Customer ID MRCL001 (same as CA — §8 Q1), PO suffix "DR3 OREGON" (spelled out —
-- §8 Q4). Clears the stale "pending Mary" note. Upsert keyed on the unique site_id:
-- corrects a row previously seeded with "DR3W"/nulls, or inserts if absent. On a
-- clean CI replay the `sites` table is empty here (seeded later by seed.mjs), so the
-- JOIN yields zero rows and this is a safe no-op — dev/CI parity comes from seed.mjs.
INSERT INTO "gp_site_billing_config" ("id","site_id","customer_id","po_site_suffix","pending_note","updated_at")
SELECT gen_random_uuid()::text, s."id", v.customer_id, v.po_site_suffix, NULL, CURRENT_TIMESTAMP
FROM (VALUES
    ('woodland', 'MRCL001', 'DR3 W'),
    ('eugene', 'MRCL001', 'DR3 OREGON')
) AS v(code, customer_id, po_site_suffix)
JOIN "sites" s ON s."code" = v.code
ON CONFLICT ("site_id") DO UPDATE
    SET "customer_id" = EXCLUDED."customer_id",
        "po_site_suffix" = EXCLUDED."po_site_suffix",
        "pending_note" = NULL,
        "updated_at" = CURRENT_TIMESTAMP;

-- ── §7 — Kelsey AP-approver auto-remove date 2026-08-01 → 2026-08-08 (vacation extension) ──
-- Guarded by the old DATE (not the exact timestamp) so this bumps Kelsey's row whatever
-- the time component of the prod 8/1 value is (a seed run, a manual SQL insert, or a
-- different ms all still land on the 2026-08-01 calendar day), while STILL refusing to
-- clobber a manual change to any other day. `active_until` is TIMESTAMP(3) (no time
-- zone), so `::date` truncation is deterministic and session-TZ-independent. Idempotent:
-- after the bump the row's date is 2026-08-08, so a re-run matches 0 rows. Clean-CI
-- no-op: no users → subquery NULL → 0 rows. Without this the daily expiry reaper
-- (src/lib/ap/expiry.ts) would delete Kelsey on 8/1 — a week before her extended 8/8
-- window (§7, the deadline OPEN-ITEMS anchors on) — with no error anywhere.
-- POST-DEPLOY CHECK (deploy notes): confirm the bump landed —
--   SELECT active_until FROM ap_approvers a JOIN users u ON u.id = a.user_id
--   WHERE u.email = 'kelsey.ruhland@svdp.us';  -- expect 2026-08-08 07:00:00
UPDATE "ap_approvers" SET "active_until" = '2026-08-08T07:00:00.000Z', "updated_at" = CURRENT_TIMESTAMP
WHERE "active_until"::date = DATE '2026-08-01'
    AND "user_id" = (SELECT "id" FROM "users" WHERE "email" = 'kelsey.ruhland@svdp.us');
