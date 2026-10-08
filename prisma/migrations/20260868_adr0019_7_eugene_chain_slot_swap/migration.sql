-- ADR-0019.7: swap the Eugene bonus signature-chain slots (Bill, 2026-10-07 18:31 PDT, option "a").
--
--   facility = Patrick Dills (patrick.dills@svdp.us), override = Bill, Rick
--   ops      = Rick Albritton (rick.albritton@svdp.us), override = Bill
--   auto-override actor = Bill (unchanged)
--
-- Woodland is not touched. The seed CSV (prisma/seed/bonus_signature_chains.csv)
-- carries the same row, so a re-seed reinforces it (the ADR-0019.3 §3 lesson).
--
-- Guarded on the EXACT current state, read from prod on 2026-10-07 (facility =
-- Rick, ops = Patrick, facility override = Bill + Patrick, ops override = Bill).
-- If the row is in any other state the swap is skipped with a NOTICE rather than
-- overwriting a configuration someone else set since (the 2026-08-11 lesson:
-- a swap phrased in terms of who holds a seat cannot see a newer occupant).
-- Re-running after it applied is therefore a no-op. On a clean replay (ADR-0035)
-- there are no users or chains, so it is a no-op too.
--
-- One audit_log row, written in the same statement, records before/after
-- (CLAUDE.md hard rule #6).
DO $$
DECLARE
  v_site   text;
  v_rick   text;
  v_pat    text;
  v_bill   text;
  v_chain  "bonus_signature_chains"%ROWTYPE;
BEGIN
  SELECT "id" INTO v_site FROM "sites" WHERE "code" = 'eugene';
  SELECT "id" INTO v_rick FROM "users" WHERE lower("email") = 'rick.albritton@svdp.us';
  SELECT "id" INTO v_pat  FROM "users" WHERE lower("email") = 'patrick.dills@svdp.us';
  SELECT "id" INTO v_bill FROM "users" WHERE lower("email") = 'bill.barnard@svdp.us';
  IF v_site IS NULL OR v_rick IS NULL OR v_pat IS NULL OR v_bill IS NULL THEN
    RAISE NOTICE 'ADR-0019.7: site/users not present (clean replay?) — skipped';
    RETURN;
  END IF;

  SELECT * INTO v_chain FROM "bonus_signature_chains" WHERE "site_id" = v_site FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'ADR-0019.7: no Eugene chain row — skipped';
    RETURN;
  END IF;

  IF v_chain."facility_signer_user_id" = v_pat AND v_chain."ops_signer_user_id" = v_rick THEN
    RAISE NOTICE 'ADR-0019.7: already applied — no-op';
    RETURN;
  END IF;

  IF NOT (v_chain."facility_signer_user_id" = v_rick
          AND v_chain."ops_signer_user_id" = v_pat
          AND v_chain."ops_override_actor_ids" = v_bill
          AND v_chain."auto_override_actor_user_id" = v_bill) THEN
    RAISE NOTICE 'ADR-0019.7: Eugene chain is not in the expected pre-swap state — skipped, needs review';
    RETURN;
  END IF;

  UPDATE "bonus_signature_chains"
     SET "facility_signer_user_id"     = v_pat,
         "facility_override_actor_ids" = v_bill || ',' || v_rick,
         "ops_signer_user_id"          = v_rick,
         "ops_override_actor_ids"      = v_bill,
         "updated_at"                  = CURRENT_TIMESTAMP
   WHERE "id" = v_chain."id";

  INSERT INTO "audit_log" ("id", "actor_label", "action", "table_name", "row_id", "before", "after", "created_at")
  VALUES (
    gen_random_uuid()::text,
    'system:approver-swap (Bill instruction 2026-10-07 18:31 PDT, option "a": Patrick Dills signs Eugene facility, Rick Albritton signs ops; ADR-0019.7)',
    'update'::"AuditAction",
    'bonus_signature_chains',
    v_chain."id",
    jsonb_build_object(
      'facility_signer_user_id', v_chain."facility_signer_user_id",
      'facility_override_actor_ids', v_chain."facility_override_actor_ids",
      'ops_signer_user_id', v_chain."ops_signer_user_id",
      'ops_override_actor_ids', v_chain."ops_override_actor_ids"
    ),
    jsonb_build_object(
      'facility_signer_user_id', v_pat,
      'facility_override_actor_ids', v_bill || ',' || v_rick,
      'ops_signer_user_id', v_rick,
      'ops_override_actor_ids', v_bill
    ),
    CURRENT_TIMESTAMP
  );
END $$;
