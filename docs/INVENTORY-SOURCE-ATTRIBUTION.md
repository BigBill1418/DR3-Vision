# Inventory source-attribution notes

Canonical running record for **individual inbound-load attribution questions** — cases
where a load's source, transporter, or unit split needed to be reconciled by hand against
the MyMRC mirror or against something a human reported by email.

This is the companion to the source-classification email sent to the team at the
Loads & Inventory go-live (ADR-0037). Classification *rules* live in
`docs/adr/0037-loads-inventory-foundations.md` and
`src/lib/inventory/source-classification.ts`. **Specific load reconciliations live here.**

**Standing rule:** where a human-reported name and the system name differ, **the system
name is authoritative** unless Bill corrects it. Record both, do not silently overwrite
either, and do not edit the mirror — it reflects the MyMRC portal.

---

## 2026-07-29 — DR3 Woodland, 150 units — haul H-135793

The 150 units entered on 2026-07-29 were **one load**, not an aggregate of several.

| | |
|---|---|
| Site | **DR3 Woodland** (`de9875a3-a09f-484f-aed1-2891ef544b87`) |
| `inbound_loads.id` | `4ce53083-79a7-4902-ac9a-5aefffd01f84` |
| Units | 150 — **all 150 program**, 0 non-program |
| Entry path | `load_source_type = ipad_floor`, `count_mode = total`, `status = verified` |
| Submitted | 2026-07-29 15:34:09 UTC (08:34 PDT) |
| MyMRC haul | **H-135793** (`mymrc_hauls_mirror`) |
| Mirror units | 150, `unit_count_at_unload` 150, all program |
| Mirror status | Delivered |
| Docking appointment | 2026-07-29 15:00 UTC (08:00 PDT) |
| Commodity | Whole Mattresses and Foundations |
| Recycler | DR3 Woodland |

### Transporter name discrepancy — resolved in favour of the system

- **System (`mymrc_hauls_mirror.transporter_name`): `Humboldt Sanitation`.**
  `collection_site` is also `Humboldt Sanitation`.
- **Reported to Bill by email: "Humble Moving."**

The names differ. Per the standing rule above, **`Humboldt Sanitation` is authoritative**
unless Bill corrects it. "Humble Moving" is most plausibly a mishearing or autocorrect of
"Humboldt" and is recorded here only so the email is reconcilable later — it is **not**
carried into any record.

### Why the link is by inference, not by key — read this before relying on it

The iPad floor row carries **`transporter_id = NULL`, `source_id = NULL`, and
`external_mymrc_haul_id = NULL`.** Nothing in the database joins this load to H-135793.
The attribution is an inference from four independently-checked facts:

1. Exactly **one** 150-unit inbound load exists fleet-wide on 2026-07-29 — no other site,
   no other row.
2. Exactly **one** 150-unit haul exists in the mirror docking 2026-07-27 → 2026-07-31.
3. Both sit at DR3 Woodland, both are 150/150 program.
4. The floor submitted at 08:34 PDT, 34 minutes after the 08:00 PDT docking appointment.

That is a strong match, but it is a **match, not a foreign key.** If either side is later
amended, re-derive rather than trusting this note.

### Two details worth not misreading

- **`arrived_at` is `2026-07-29 07:00:00 UTC` = Pacific midnight of the business day**,
  the same day-anchoring convention ADR-0037 §B7.1 describes for `paper_bulk`. It is a
  **business-day anchor, not the truck's arrival time.** Do not read it as "arrived at 7am."
- The mirror carries **two different docking values**: `docking_appointment_at`
  `2026-07-29 15:00` and `docking_appointment_date` `2026-07-29 12:00`. The `12:00` is the
  date-only field's noon placeholder — the appointment is **08:00 PDT**. A report quoting
  "docking 7/29 12:00" is reading the placeholder, not the appointment.
- A separate, unrelated **3-unit** Humboldt Sanitation `b2b_haul` row also exists at
  Woodland that day (created 14:30 UTC). It is **not** part of H-135793 — do not fold it in.

### Open, not blocking

`ipad_floor` loads have no source-classification point when `source_id` is NULL, so this
load contributes to the program pool by its explicit split rather than by source. That is
working as designed per ADR-0037 §B7.1, but it does mean **floor-entered loads cannot be
attributed to a transporter without a mirror match like the one above.** Worth a linkage
field if this recurs often enough to matter.
