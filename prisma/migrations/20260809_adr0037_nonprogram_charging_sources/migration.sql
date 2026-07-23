-- ADR-0037 — NON-PROGRAM "charging" collection sites (Rick/Morena definitive rules,
-- 2026-07-23). Program vs non-program is the MRC billing split (MRC is billed on PROGRAM
-- units only), so these classifications are money-critical.
--
-- Rule 1 (EXPLICIT list): a "charging" collection site is non-program. The CA (Woodland)
-- charging list — Golden Bear, Monte Diablo, San Martin, Martinez, Petaluma, Sonoma,
-- Annapolis, Healdsburg, Vasco, Brentwood — plus the OR (Eugene) Recyclops are seeded
-- here with `is_non_program = true`. (Roseburg, the other OR non-program site, already
-- exists from 20260730b — left untouched.) All 10 CA sites are IN-state (CA), so ONLY the
-- explicit flag makes them non-program — the out-of-state rule (Rule 2, enforced in code
-- via src/lib/inventory/source-classification.ts) cannot catch an in-CA site.
--
-- PURELY ADDITIVE / IDEMPOTENT (ADR-0035 clean-replay invariant). This is the PROD deploy
-- backstop; the audited live INSERT (actor_label='adr-0037-nonprogram-sources') already
-- placed these rows on prod, so every INSERT below no-ops there via ON CONFLICT. On a fresh
-- CI replay the `sites` table is empty at this point (seeded later by prisma/seed.mjs), so
-- the site subquery yields no row and every INSERT is a safe no-op; the dev/CI path is
-- seedNonProgramChargingSources in seed.mjs (runs after seedSources). Mirrors
-- NONPROGRAM_CHARGING_SOURCES + NONPROGRAM_CHARGING_ALIASES in
-- prisma/seed/addendum-b-data.mjs — change all three together.
--
-- site_type = 'collection_site' (they ARE collection sites) but active_billing = false, so
-- they produce ZERO MRC invoice lines (resolveSiteTypeBilling short-circuits on
-- active_billing before reading site_type) — the money-safe posture for a non-program
-- source, matching Roseburg / the SVDP internal stores. `is_trans_charge` is left at its
-- default (false): the trans-charge BILLING setup for these charging sites (canonical
-- mileage + rate tiers) is a separate decision pending Rick's rates, deliberately not
-- asserted here.

-- ── CA (Woodland) — 10 explicit non-program charging collection sites ──────────
INSERT INTO "sources"
  ("id","site_id","name","state","is_active","is_non_program","site_type","active_billing","notes","created_at","updated_at")
SELECT gen_random_uuid()::text, w."id", v.name, 'CA', true, true,
       'collection_site'::"SourceSiteType", false, v.notes, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT "id" FROM "sites" WHERE "code" = 'woodland') w
CROSS JOIN (VALUES
    ('Golden Bear',  'CA non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool.'),
    ('Monte Diablo', 'CA non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool.'),
    ('San Martin',   'CA non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool.'),
    ('Martinez',     'CA non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool.'),
    ('Petaluma',     'CA non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool.'),
    ('Sonoma',       'CA non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool. MyMRC/workbook name "Recology Sonoma" aliased.'),
    ('Annapolis',    'CA non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool.'),
    ('Healdsburg',   'CA non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool. MyMRC/workbook name "Recology Healdsburg" aliased.'),
    ('Vasco',        'CA non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool.'),
    ('Brentwood',    'CA non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool.')
) AS v(name, notes)
ON CONFLICT ("site_id","name") DO NOTHING;

-- ── OR (Eugene) — Recyclops (explicit non-program) ────────────────────────────
INSERT INTO "sources"
  ("id","site_id","name","state","is_active","is_non_program","site_type","active_billing","notes","created_at","updated_at")
SELECT gen_random_uuid()::text, e."id", 'Recyclops', 'OR', true, true,
       'collection_site'::"SourceSiteType", false,
       'OR non-program charging collection site (ADR-0037, Morena 2026-07-23). Non-MRC — inbound units default to the non-program (non-billable) pool.',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT "id" FROM "sites" WHERE "code" = 'eugene') e
ON CONFLICT ("site_id","name") DO NOTHING;

-- ── Source aliases — MyMRC/workbook variants → canonical (Morena) name ─────────
-- Only Sonoma + Healdsburg have surviving name variants in the June workbook staging /
-- the MyMRC CA disambiguation ("Recology Sonoma" / "Recology Healdsburg"). "Golden Bear"
-- appears verbatim (no alias needed); the remaining 8 sites have no known variant. Alias
-- is globally UNIQUE, so ON CONFLICT DO NOTHING makes this a no-op against the live rows.
INSERT INTO "source_aliases" ("id","alias","source_id","created_at")
SELECT gen_random_uuid()::text, v.alias, s."id", CURRENT_TIMESTAMP
FROM (VALUES
    ('Recology Sonoma',     'Sonoma'),
    ('Recology Healdsburg', 'Healdsburg')
) AS v(alias, canonical)
JOIN "sources" s ON s."name" = v.canonical
    AND s."site_id" = (SELECT "id" FROM "sites" WHERE "code" = 'woodland')
ON CONFLICT ("alias") DO NOTHING;
