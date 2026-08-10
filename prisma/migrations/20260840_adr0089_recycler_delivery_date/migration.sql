-- ADR-0089 Am.1 — the delivery date we never asked for.
--
-- The inbound bridge keyed the delivery day on `Docking_Appointment_Date__c` — a
-- SCHEDULING field MyMRC leaves null for route collections that book no dock
-- slot. 3,330 of 7,334 mirror rows (45%) are undated by that column; 35 of them
-- arrived AFTER the ADR-0059 anchor carrying 2,429 units / 67 tons that never
-- touched the floor ledger. The field that means "when the truck actually
-- arrived" — `Recycler_Reported_Delivery_Date__c` — was enumerated in our own
-- Phase-0 discovery on 2026-07-22 and never requested. Proven populated live
-- 2026-08-10 (12/12 Delivered probes, incl. 2023/2024 pre-anchor rows).
--
-- Three nullable columns; every existing row stays NULL until the ADR-0089 D4
-- re-detail sweep re-fetches details with the widened field set. Nothing reads
-- these columns until the same deploy's bridge/freshness re-key (D2/D3), which
-- COALESCEs onto the dock date — so a not-yet-re-detailed row behaves exactly
-- as before this migration.
ALTER TABLE "mymrc_hauls_mirror"
  ADD COLUMN "recycler_reported_delivery_date"    TIMESTAMP(3),
  ADD COLUMN "transporter_reported_delivery_date" TIMESTAMP(3),
  ADD COLUMN "unit_count_at_unload"               INTEGER;
