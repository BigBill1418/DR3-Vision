# Phase-1 mapper fixtures (ADR-0057) — SYNTHETIC, real structure

These fixtures reproduce the **real** MyMRC Aura shapes captured in Phase-0
(`docs/mymrc-discovery-2026-07-22.md`) but every **value is fabricated**:
recycler is `DR3 Testville`, account id `001460000SYNTHTVLAAQ`, people are absent,
haul/materials numbers are `H-90…` / `M-90…`. **No real names, sites, or counts.**
The raw Phase-0 fixtures (uncommitted, PII-bearing) are NEVER committed — only
these redacted stand-ins are.

Each `*-getrecord.json` is a raw Salesforce `RecordRepresentation` (the
`getRecordWithFields` `returnValue`), consumed directly by the mappers. Each
`*-getitems.json` is a `ListViewDataManagerController.getItems` `returnValue`
(record ids + column metadata; **no per-record field values** — the observed
transport lists ids only).

Structural properties deliberately preserved for the mapper tests:

- `{displayValue, value}` pairs on every field; identity/number/date read `value`.
- Nested `__r` relationship records (`Recycling_Center_Lookup__r`, `Account__r`)
  with the related `Name` under `value.fields.Name.value`.
- Typographic apostrophe U+2019 in `Container_Type__c` (`28’ Trailer`).
- Free-text Pacific docking time `Docking_Appointment_Time__c` = `2026/07/20 12:00 PT`.
- `Materials__c` split by `Type__c` (`Processing` vs `Outbound`) — one object, two rows.
- Outbound `Outbound_Vendor_Name__c` is **absent from the record detail** (list-only
  column) — present only in `outbound-getitems.json` `fields`/`columnWidthMapping`.
- Dock `Day_of_Week__c` value = numeric codes `1;2;3` (displayValue = weekday names);
  `Dock_Door__c` value `Dock Door 2` ≠ displayValue `Schedule 2`; slot times are
  Salesforce Time strings (`07:00:00.000Z`), never datetimes.
