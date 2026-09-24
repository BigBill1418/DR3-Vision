# ADR-0138 — Who counted is not who keyed it in

- **Status:** Accepted, implemented 2026-09-24 (Pacific)
- **Context:** Bill, 2026-09-24 6:22 AM PDT: _"on the eugene production report last night it
  says Bill Barnard was the counter - WTF ?"_ OPEN-ITEMS § 0.BY.
- **Amends:** ADR-0105 (its recorded consequence that the report names the correcting
  manager as counter), and the "no counter column" stance written into
  `resolveCounter`, `correct-count.ts` and `void-count.ts`. **Extends:** ADR-0084 (the
  report's freshness line), ADR-0072 (holds carry the entry verbatim).

## Context

The daily report's inventory panel printed a **Counter** row from
`eod.anchor.counter`, which `resolveCounter` (`src/lib/loads/eod-inventory.ts`) read as
the actor of the snapshot's `insert` audit row — the account that **submitted** the
count. The comment above it argued the audit log was the one truth and a name column
would be a second one.

That holds only if the submitter is the counter. It is not:

- Eugene's only count (snapshot `7232d092`, 751 = 19/732, closing of 2026-09-16) was
  counted by **Chris R**, confirmed by **Patrick D**, relayed by the site manager, and
  keyed by an admin through `POST /api/manager/eugene/snapshots` (commit `3a315881`,
  OPEN-ITEMS § 0.BT BT-6). Every Eugene report since has said "Counter: Bill Barnard",
  and would have until the next count.
- A released Tier-2 hold's snapshot is inserted with the **approver** as actor, so the
  report named the manager who released an operator's count.
- A correction (ADR-0105) is inserted with the correcting manager as actor; ADR-0105
  recorded "the report names the manager for a corrected count" as an accepted cost.

The audit actor answers "who put this number in the system". The report asked "who
counted the floor". They are different facts, and only one of them was recorded.

## Decision

1. **Record the counter.** `site_inventory_snapshots.counted_by` and `confirmed_by`
   (nullable TEXT, free text — crew members are not all users), migration
   `20260865_adr0138_count_counted_by`. The same pair on `inventory_count_holds` so a
   held count keeps them through release.
2. **Ask for it.** The manager desktop count form (`LoadsInventoryClient` →
   `PhysicalCountPanel`) asks **"Who counted?"** (required) and "Confirmed by
   (optional)", never prefilled with the signed-in user. `POST
/api/manager/[site]/snapshots` refuses a count without it (`422
counted_by_required`) — the server check, not the disabled button, is the control.
   Names are validated by `CountPersonName` (trimmed, 1–80, no control characters).
3. **Carry it wherever a count's figures are carried.** Hold release writes the held
   counter; a correction (ADR-0105) carries the original's counter forward (the
   correction fixes a keyed number, not who counted); an anchor reactivation copies the
   restored row's counter with its figures. The audit actor on each stays exactly what
   it was — the enterer.
4. **Print it honestly.** `resolveCounter` now returns `formatCountAttribution(...)`
   (`src/lib/inventory/count-attribution.ts`):
   - `Chris R, confirmed by Patrick D · entered by Bill Barnard`
   - `Janette Tomas` (counted and entered by the same person)
   - `Not recorded · entered by Bill Barnard` (no counter captured)

   The report row is relabelled **Counted by**. The enterer of a released hold is the
   hold's submitter, not the approver. **The keying account is never printed as the
   counter.**

5. **The iPad floor path does not ask (yet).** The signed-in operator there is on the
   floor, but a crew counts together and the kiosk bundle updates lazily (ADR-0078 D10:
   a new required field would 422 every count from a device on the old shell). Floor
   counts leave `counted_by` NULL and read "Not recorded · entered by <operator>" —
   true, and no longer a false claim. Asking on the iPad is a follow-up (§ 0.BY BY-2).

## Backfill

Only rows whose counter is **documented** are filled; the rest stay NULL and print the
"Not recorded · entered by" form. One row qualifies: `7232d092` → `Chris R` /
`Patrick D`, source commit `3a315881` + OPEN-ITEMS § 0.BT BT-6. Woodland's live anchor
`04cb7ae2` (885, 09-14) is recorded as "Bill's hard count" relayed in chat; who
physically counted is not written anywhere, so it is left NULL rather than guessed.
Script: `scripts/one-off/2026-09-24-adr0138-counted-by-backfill.sql` (one transaction,
hard-stop gates, audit row, system actor), after a table backup.

## Consequences

- The report's "Counted by" line is now a statement about the floor, and the enterer is
  shown only when different and always labelled.
- `counted_by` is typed text, so it is only as good as what the manager enters; it is
  never inferred. The audit actor remains the provenance of the ENTRY.
- The correction audit payload keeps its historical `after.counted_by` key (the
  original ENTERER's user id, ADR-0105). It is not the column of the same name; the
  comment at the write site says so.
