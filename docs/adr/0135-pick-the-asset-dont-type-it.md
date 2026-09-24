# ADR-0135 — Pick the asset, don't type it: stopping equipment-name drift

- **Status:** **Accepted and Implemented 2026-09-23 (Pacific) — all three phases.**
  Bill approved Phases 1–3 on 2026-09-23 (_"build this out - test and confirm
  function - do not stop until complete"_) and decided cross-site assets: trailers
  move between yards, so an asset may be FLEET-WIDE (no home site). What shipped is
  §8; it deviates from §3/§4 where §8 says so. The §5 cleanup ran 2026-09-22.
- **Date:** 2026-09-22 (Pacific); implemented 2026-09-23
- **Context:** Bill, 2026-09-22, on `/admin/ap/equipment-requests`: _"this system is
  driving me insane.... we can't have staff typing in different equipment with
  different spellings and having more and more equipment and vehicles in the
  inventory that are the same but slight word variations - please review and
  propose fixes and design changes to improve this workflow. also - clean and
  condense the items that this has happened to check the DB"._
- **Extends:** ADR-0046 Amendment 9 (the AP equipment escape hatch), ADR-0063
  (`/admin/equipment`), ADR-0075 (collision fork + merge tool), ADR-0077 (Terex
  canonical record). **Builds on, does not replace:** ADR-0087 (Proposed — VLM
  identity, canonical key that preserves `-` and `#`, "the key proposes,
  corroboration disposes"). This ADR is the AP-workflow half of ADR-0087 D4.

---

## 1. What the production record shows (measured 2026-09-22, read-only first)

- `equipment`: 577 rows, 542 active, 2 merged (the ADR-0077 Terex pair). 554 rows
  came from the 2026-07-28 seed; **23 were created since**, and every one of those
  came through the equipment-request resolve panel.
- `ap_equipment_requests`: 32 rows — 27 resolved, 5 open. Of the 27 resolutions,
  **23 CREATED a new asset** (8 pre-ADR-0075 + 15 after it) and only **4 picked an
  existing one** (`audit_log.after->>'resolution_mode'`).
- Of the 23 created rows, at least 8 duplicate an asset the registry already had,
  3 are work orders rather than assets, and the rest are named in five different
  styles (`5312 trailer`, `Trailer #19`, `Trailer Number #7677`, `trailer 540010`,
  `161053.`) against the seed's `<unit> — <make> <type>` convention.
- Five requests are open right now, and three of them describe things that already
  exist or have been requested twice (§6).

## 2. Root cause — five holes, each with its line

1. **The only hard guard is an exact string match.**
   `createEquipmentInTx` (`src/lib/admin-equipment.ts:474-487`) refuses a create
   only when `(site_id, display_name)` matches EXACTLY, and the DB index
   `equipment_site_id_display_name_key` is the same test. The ADR-0075 similar-name
   panel is **advisory UI** — the operator can still press Add. That is how `terex`
   was created on 2026-08-20 next to `Terex`, whose canonical form is identical.
2. **The detector compares whole names, so a unit number never matches a seeded
   row.** `canonicalizeName` (`admin-equipment.ts:213`) and
   `findSimilarEquipment` (`:251`, equality at `:276`) test canonical EQUALITY of
   the entire string. Seeded rows are `161053 — Freightliner Semi Truck (Day Cab
S/A)`; a resolver typing `161053.` canonicalises to `161053`, which is not
   equal, so no suggestion appears and a new row is created. Same for
   `trailer 32-48`, `Trailer 281577`, `Trailer #284460`.
3. **The detector is single-site, but trailers move between yards.**
   `findSimilarEquipment` filters `where: { site_id }` (`admin-equipment.ts:265`),
   and `mergeEquipment` refuses `cross_site` (`:748`). 281577 and 282876 are seeded
   at Woodland and were re-created at Eugene; 284460 the reverse. Neither the
   warning nor the merge tool can see or fix these.
4. **The resolve panel's primary verb is "create".**
   `EquipmentRequestsClient.tsx:197-205` — the only primary button is _Add to the
   fleet_, which opens a free-text create form. There is no "find it in the fleet"
   search; picking an existing asset is only reachable through hole #2's warning,
   which rarely fires. 23 of 27 resolutions created a row.
5. **Identity lives in a free-text name.** `equipment` (`prisma/schema.prisma:5066`)
   has no unit number, VIN, plate or serial column, so staff put those in the
   name: `1DW1A5321PS807745` (a VIN), `12BB04252`, `SN 31587 Forklift` (filed as
   `vehicle`), `ZHGC FP25`. And the approver's hatch description
   (`ApQueueClient.tsx:1119` picker filter is a raw lower-case `includes`) misses
   `Trailer # 19` vs `Trailer #19` and `161053.` vs `161053 — …`, which pushes
   approvers into the hatch in the first place.

**Latent defect found on the way:** `mergeEquipment` (`admin-equipment.ts:735`)
repoints `ap_equipment_links` and `ap_equipment_requests` only. Two newer FKs to
`equipment` — `equipment_daily_throughput` (ADR-0079) and
`equipment_throughput_gap_alerts` (ADR-0088), both `ON DELETE RESTRICT` — are NOT
repointed. Merging a machine that has throughput history would leave that history
on a dead row. The §5 cleanup asserted zero such rows on every loser before merging.

## 3. Options considered

| #   | Option                                                                                                                                                                                                                                                                                             | What it fixes                                          | Cost                                               | Verdict                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **Search-first resolve panel** — "Find it in the fleet" box, pre-filled from the description's unit tokens, fleet-wide, ranked; _Use this one_ is the primary action; _Add new_ appears only under the results                                                                                     | Hole 4 (the 23:4 ratio), hole 3 (cross-site visible)   | 2–3 days                                           | **Adopt** — this is the fix Bill will feel                                                                                                                                                        |
| B   | **Unit-aware matcher** `matchEquipment(query)` — extract unit tokens with the ADR-0087 D2 key (upper-case, collapse spaces, KEEP `-` and `#`, O→0/I→1 next to digits); rank exact unit key > same digits different separator ("maybe — check") > token overlap on the descriptive part; both sites | Hole 2, hole 3; feeds A, D, E                          | 1–2 days                                           | **Adopt** — one matcher, every surface                                                                                                                                                            |
| C   | **Hard server gate on create** — the create path re-runs B; an exact canonical-name or exact unit-key hit on a live row is a 409 unless the caller sends `confirmDistinct` with a distinguishing fact (VIN/serial/make) and a reason, written to the audit row                                     | Hole 1                                                 | 0.5 day                                            | **Adopt** — turns the warning into a wall with a door                                                                                                                                             |
| D   | **Structured "new asset" form** — type, unit number (required for trailer/vehicle/forklift), make, optional VIN/serial/plate; `display_name` is GENERATED as `<unit> — <make> <type>` (the seed's convention); no free-typed names                                                                 | Hole 5, the five naming styles                         | 1–2 days + 1 migration (additive nullable columns) | **Adopt**                                                                                                                                                                                         |
| E   | **Structured approver hatch + same matcher in the approver picker** — unit # + type instead of a paragraph; one asset per request (a four-trailer work order becomes four links or "not equipment")                                                                                                | Hole 5 at the source; fewer requests filed at all      | 1–2 days                                           | **Adopt, after A–D**                                                                                                                                                                              |
| F   | **Admin "possible duplicates" queue + cross-site merge** on `/admin/equipment`, driven by B; merge lets the admin choose the survivor's site; merge also repoints throughput + gap-alert rows                                                                                                      | Hole 3's cleanup path; the latent merge defect         | 1–2 days                                           | **Adopt** — the merge-repoint fix should ship with C regardless                                                                                                                                   |
| G   | Case-insensitive unique index `(site_id, lower(display_name)) WHERE merged_into_id IS NULL`                                                                                                                                                                                                        | Case-only duplicates (`terex`/`Terex`) at the DB layer | 0.5 day                                            | **Adopt as a backstop** — now buildable: §5 cleared the last live violating group (ADR-0075 D3's blocker). Weak on its own: it catches none of the unit-number cases                              |
| H   | `pg_trgm` trigram similarity in Postgres                                                                                                                                                                                                                                                           | Fuzzy ranking                                          | extension install on prod                          | **Defer** — not installed; the registry is 577 rows, so B in TypeScript is cheaper and keeps one definition (ADR-0075's own argument). Revisit past ~10k rows                                     |
| I   | Separate `equipment_aliases` table                                                                                                                                                                                                                                                                 | Old spellings → canonical                              | 1 day                                              | **Reject for now** — ADR-0075 already gives this for free: a merged loser keeps its name and `merged_into_id`, and `findSimilarEquipment` returns merged rows. B should do the same               |
| J   | Admin approval on EVERY new asset                                                                                                                                                                                                                                                                  | Everything, slowly                                     | 1 day + a new queue                                | **Reject** — adds a second queue behind the queue Bill is already frustrated with. C gates only the risky case                                                                                    |
| K   | Registry fed only from VLM (ADR-0087 D3)                                                                                                                                                                                                                                                           | Long-term identity                                     | ADR-0087 build                                     | **Keep separate** — right direction for trailers/vehicles, but DR3 must still add assets VLM does not carry (balers, the Terex). Needs `vlm_legacy_id`, which D's migration should leave room for |

## 4. Recommendation

Ship **B + C + F-merge-fix + G first (Phase 1, ~2 days)**, then **A + D (Phase 2,
~3–4 days)**, then **E + the rest of F (Phase 3, ~2–3 days)**. Total ~7–9
working days, each phase independently useful:

- **Phase 1 stops new duplicates at the server** even before the UI changes: the
  matcher plus the hard gate would have refused `terex`, `161053.` and
  `trailer 32-48` and handed back the existing row.
- **Phase 2 changes what the resolver sees**: search first, pick, and only then
  create — with a generated name, so the five naming styles stop at the form.
- **Phase 3 fixes the source** (approvers stop writing paragraphs) and gives
  Bill a duplicates queue so the cleanup in §5 is a button next time, not a
  session.

**Guardrail carried from ADR-0087, non-negotiable in every phase:** the matcher
PROPOSES; a human or a corroborating identifier DISPOSES. `21`, `21-27` and
`21-48` are three trailers; `Truck 9` and `Truck #9` are two trucks; unit `3` at
Eugene is both a Fruehauf and a Wabash. Nothing in this design merges or blocks
on a separator-only or digits-only similarity without showing it to a person.

Out of scope here: `equipment_events.equipment_code` (a free-text Terex log key
with no FK, ADR-0048 D3) — not touched by any of this.

## 5. One-off cleanup executed 2026-09-22 (Part B)

**Backup first:** `svdp-dev:~/backups-adhoc/dr3-equipment-dedupe-pre-20260922-232239-PT.dump`
(pg_dump `-Fc` of `equipment`, `ap_equipment_links`, `ap_equipment_requests`,
`equipment_daily_throughput`, `equipment_throughput_gap_alerts`; 74,361 bytes;
sha256 `667caa0097b1755f63b8f0b9ed67c56cdac03d7db5798eb299a8129c0c439221`; mode 600).
Restore-tested into a scratch database (schema + `--data-only`): row counts
577 / 163 / 32 / 354 / 9 matched the live manifest (`….dump.rowcounts`); scratch
DB dropped.

**Method:** `scripts/one-off/2026-09-22-equipment-dedupe-merge.ts`, which drives
`mergeEquipment` — the same audited transaction as the admin Merge button — one
transaction per pair, actor label `system:equipment-dedupe-merge (ADR-0135, …)`,
`actor_user_id` NULL. Dry run first, then `--apply` at 11:26 PM PDT.

**Merged — high confidence only (same site AND identical canonical name, or
identical unit number corroborated by the invoice text, or the ADR-0087 VIN register):**

| Survivor (kept)                                                      | Merged away                                     | Evidence                                                 | Links / requests moved |
| -------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- | ---------------------- |
| `7e35a4aa` Woodland `Terex`                                          | `1323e8f6` `terex` (created 2026-08-20)         | canonical-identical; the ADR-0077 canonical Terex        | 1 / 1                  |
| `994a2d76` Woodland `161053 — Freightliner Semi Truck (Day Cab S/A)` | `89ea5644` `161053.` (created 2026-08-20)       | invoice reads "Unit #161053"                             | 1 / 1                  |
| `48ef6ffc` Eugene `32-48 — Trailer 48 Ft Swing Door Trailer`         | `cfd92a89` `trailer 32-48` (created 2026-09-04) | invoice reads "Unit #32-48", dash intact, same vendor    | 1 / 1                  |
| `4c6f6d1a` Eugene `F9 — Hyster Forklift`                             | `23ebbb4f` `F9` (seed shell)                    | ADR-0087 register G6 (one Hyster, double-entered in VLM) | 0 / 0                  |

**Verified after:** 577 rows (nothing deleted), 538 active (−4), 6 merged (+4);
links over the eight ids 26 → 26, spend 2,276,253 → 2,276,253 cents; 0 links and 0
resolved requests point at any merged row fleet-wide; 4 audit rows under the
label; `listEquipmentRequests` (the page's own data function) returns 32 rows / 5
open, with every affected request now naming its survivor; the approver picker
(`listSiteEquipment`) returns 538 options and none of the four loser names.
Reversal = clear `merged_into_id` and restore links from each audit row's
`before`, or restore the dump.

## 6. Not merged — Bill's decision list

Cross-site pairs (the merge tool refuses these, correctly, until someone says
where the trailer lives now):

1. **281577** — seeded at Woodland (`3324cbce`, `281577 — Great Dane`), re-created at
   Eugene (`bf828ad0`, `Trailer 281577`, 1 invoice). Which yard is home?
2. **282876** — seeded at Woodland (`da85e182`), re-created at Eugene (`2588490b`, 1 invoice).
3. **284460** — seeded at Eugene (`1ed0f856`), re-created at Woodland (`fdef4b7a`, 1 invoice).
4. **`48-68 trailer`** (Woodland `ef09f6a9`, 1 invoice) vs **`4868 — Fruehauf 28 Ft`**
   (Eugene `89fe4505`). Different site AND a dash difference — ADR-0087 shows
   dashes separate real trailers. Needs eyes on the invoice.

Same-site, not corroborated:

5. **`60`** vs **`60 — Strick 28 Ft Roll Up Door Trailer`** (Eugene, both seed, no
   invoices). The bare row may be a VLM ghost unit, like the others in the
   ADR-0087 register.

Rows that are not assets but sit active in every approver's picker:

6. `Fix and repair trailer: 53489, 5340, 35, 282859 going to Ore…` (Woodland
   `fc211740`), `fix trailer 95 and 5308` (Woodland `d9372c52`), `relay order from
Aleks` (Woodland `cd87a14f`) — one invoice each. Recommendation: repoint each
   invoice at the real trailer(s) or mark it not-equipment, then deactivate the row.
   (`95` is two different trailers — ADR-0087 G3 — so this one needs the invoice read.)

Names that are identifiers, not names (rename once identity is known — Phase 2's
generated names would have prevented them):

7. `1DW1A5321PS807745` (Eugene, a VIN), `12BB04252` (Woodland), `SN 31587 Forklift`
   (Woodland, filed as `vehicle`), `ZHGC FP25` (Woodland), `Trailer Number #7677`,
   `5312 trailer`, `53641 trailer`, `trailer 540010`, `Trailer #19` (Eugene).

Open requests on the worklist today:

8. **Green horizontal baler, requested twice at Woodland today** (Morena 9:01 AM
   PDT, Janette 11:51 AM PDT), while `Green Horizontal baler Topper` was created at
   **Eugene** on 2026-08-24. Woodland already carries EQ23 / EQ44 / EQ48 / EQ75
   Horizontal Balers. Which EQ number is the green one — and is the Eugene
   "Topper" row really a Woodland machine?
9. **`EQ24 Terex Shredder`** (Janette, 2026-09-18) → resolve against
   `EQ24 — Shear Machine` (`cbc2e53e`, category `terex`)? And is EQ24 the same
   machine as the canonical `Terex` (`7e35a4aa`)? Both carry daily-throughput
   history (17 vs 337 rows), so a merge would need the §2 merge fix first.
10. **`Trailer # 19`** (Woodland, today) vs existing **`Trailer #19`** (Eugene,
    created 2026-08-06). Same trailer, moved yards?
11. **`Trailer # 5327`** (Woodland, today) — nothing in the registry matches; likely a
    genuine new asset.

Side finding, outside equipment: **invoice 6646 (United Fleet Maintenance, Unit
#161053, $201.84) exists as two approved AP requests** — received 2026-08-10
2:40 PM PDT and approved 2026-08-13 5:32 AM PDT; received again 2026-09-01 3:27 PM
PDT and approved 2026-09-02 6:14 AM PDT. Worth an AP check for a double payment.

## 7. Consequences

- Nothing in §4 is built. The registry will keep drifting at roughly the rate
  in §1 until Phase 1 ships, and the decision list in §6 grows with it.
- Phase 1's hard gate will occasionally refuse a genuinely new asset whose unit
  number collides with a different real asset (the `13`/`66`/`95` class). That is
  the point of `confirmDistinct`: the refusal costs one extra field, and the
  audit row records why.
- `display_name` stops being typed by people from Phase 2 on. Existing names are
  not rewritten automatically; the §6 list is the rename worklist.

## 8. What shipped (2026-09-23, Pacific)

All three phases, on `feat/adr0135-equipment-redesign`, merged to `main`. Where
this differs from §3/§4 it says why.

### Phase 1 — the matcher, the wall with a door, the merge that moves everything

- **One matcher** — `src/lib/equipment/match.ts`, PURE (no Prisma), so the server
  gate, the resolve panel, the approver's picker, the admin list search and the
  duplicates queue all run the same code. Signals, strongest first: same VIN/serial
  → same name ignoring case/spacing/punctuation → same **unit number** → shared
  words (search only). Unit tokens: `#` and the space after it are dropped
  (`Trailer # 19` = `Trailer #19` = unit `19`); an ASCII hyphen between
  alphanumerics is KEPT (`48-68` ≠ `4868`, `32-48` ≠ `3248`); Unicode dashes are
  separators (the seed's `—`); a length is not an identity (`28 Ft`, `53'`); O/I
  look-alikes are fixed only inside an otherwise-numeric token. A seed-format row
  (`<unit> — <rest>`) is identified by the part before the dash only, so `4868 —
Fruehauf 28 Ft …` cannot match a query for trailer `28`. Merged losers are never
  returned as themselves — an old spelling finds its survivor (§3 option I, free).
- **Probable duplicate** = same VIN, same name, or the query's first unit number on
  a live row where the unit is ≥3 characters OR both rows are the same kind of
  asset (trailer / truck / forklift / baler / shredder, from the structured type or
  the name). Fleet-wide: both yards, always. **The fleet-class word before the
  number is identity** (added after the first prod run of the queue, below):
  `Truck 12`, `Van 12`, `Bus 12` are three vehicles and `LIFT 1` is not trailer `1`
  — different words are never a probable duplicate (still a search hit); one side
  bare counts only for a ≥3-char number or when the word names the other row's kind.
  First prod run without that rule: 18 queue pairs, mostly `Truck N`/`Van N`/`Bus N`
  noise; with it: **4** (`2 — Great Dane`/`2 — Trailmobile` and `908`/`Truck 908`
  cross-site; `3` Fruehauf/Wabash and `Truck 9` ×2 at Eugene — the last two are the
  ADR-0087 known-distinct pairs, for "Different assets"). **Correction 2026-09-23:**
  ADR-0087 documents `Truck 9` / `Truck #9` (register G7) but its Wabash/Fruehauf pair is
  unit `95` (G3), not `3`. The `3` pair is proven distinct by the VLM register itself
  (unit `3` Wabash, VIN 1JJV281N9PL180863; unit `03` 1984 Fruehauf, VIN
  1H4V02812EJ023049). Both pairs were marked **Different assets** 2026-09-23 11:13 PM PDT
  (`scripts/one-off/2026-09-23-mark-distinct-equipment-pairs.ts`, system actor, audited;
  backup `svdp-dev:~/backups-adhoc/dr3-equipment-distinct-pairs-pre-20260923-231240-PT.dump`).
  The queue now holds exactly `2` Great Dane/Trailmobile and `908`/`Truck 908`, for Bill.
- **The hard gate** — `createEquipmentInTx` runs the matcher over the whole registry
  before every insert (admin create AND equipment-request resolve). A probable
  duplicate is refused (`409 probable_duplicate` + the rows) unless the caller sends
  `confirmDistinct { reason (≥10 chars), distinctFromIds }` naming EVERY row the gate
  found (`override_incomplete` otherwise). The override is written into the create's
  audit row (`after.duplicate_override`: reason, the rows and what each matched on;
  actor + timestamp are the audit row's own) and into `equipment_distinct_pairs`.
  A same-name or same-VIN hit is **not** overridable (`name_taken` / `vin_taken`).
- **Database backstop (G)** — migration `20260862_adr0135_equipment_identity`:
  `equipment_live_name_ci_key`, unique on
  `lower(regexp_replace(btrim(display_name),'\s+',' ','g')) WHERE merged_into_id IS NULL`
  — FLEET-WIDE, stricter than §3 G's per-site proposal, because prod held zero
  fleet-wide violators (checked 2026-09-23) and a trailer lives at no single yard.
  The migration pre-checks and fails with a readable message if violators appear.
  Plus `equipment_live_vin_serial_key` on the normalised VIN.
- **Merge fixed and widened (F)** — `mergeEquipment` now repoints EVERY FK into
  `equipment`: `ap_equipment_links`, `ap_equipment_requests.resolved_equipment_id`,
  `equipment_daily_throughput`, `equipment_throughput_gap_alerts`, and rows already
  merged INTO the loser (so no chain forms). `MERGE_REPOINTED_REFERENCES` /
  `MERGE_EXEMPT_REFERENCES` name them, and `admin-equipment.db.test.ts` asserts the
  live `pg_constraint` set equals that list — a new FK fails CI (falsified: removing
  the gap-alert entry turns it red). Same-day non-voided throughput on both machines
  refuses the merge (`throughput_conflict` + dates): which reading is true is a
  person's call. `equipment_events` has no FK (unchanged); `audit_log` is history.
- **Cross-site** — `equipment.site_id` is now NULLABLE; NULL = **fleet-wide**. A
  cross-site merge is allowed but the caller must NAME the survivor's site (a yard
  or fleet-wide); the survivor's move is its own audit row. Site-scoped consumers
  (Terex ledger, throughput, equipment dashboard) keep `site_id = $1` semantics — a
  fleet-wide trailer is not a site's machine. `seed-equipment-master.mjs` falls
  back to a fleet-wide row of the same name instead of re-creating it.
- **Reach narrowed deliberately** — resolving a request against an asset filed at
  the OTHER yard is now allowed for a single-site manager (it writes only her
  request and link — the act every approver already performs in the fleet-wide
  picker); only REACTIVATING an out-of-reach asset still 403s. Without this, the
  gate would refuse Morena's create AND refuse her use of the Eugene row: a dead end.

### Phase 2 — search first, structured create (A + D)

- `/admin/ap/equipment-requests`: the primary action is **Find it in the fleet** —
  a fleet-wide ranked search pre-filled from the request, with **Use this one** on
  every result. **Add a new asset instead** is secondary, under the results.
- New assets (resolve panel AND `/admin/equipment/new`) come from a structured form:
  **type** (`ASSET_TYPES` → category), **unit #** (required for trailers, trucks,
  vans, forklifts; ONE unit), make, optional details, optional VIN/serial, site or
  **Fleet-wide**. The name is generated server-side as `<unit> — <make> <details>
<type>`; both routes refuse a free-typed `display_name`. Identity is stored in
  `unit_number`, `make`, `asset_type`, `vin_serial` (seed-format rows had their unit
  backfilled from the name by the migration; free-text rows left NULL).
- `/admin/equipment` list search uses the matcher; the site filter shows fleet-wide
  rows at every yard plus a Fleet-wide option; the edit form edits the identifiers
  and can make an asset fleet-wide; the merge picker offers all live rows and asks
  where the survivor lives when the two differ.

### Phase 3 — the source and the queue (E + F)

- The approver's **Equipment not in list** hatch is a structured form: type + ONE
  unit number (+ make, notes). It still posts the same `equipmentRequestDescription`
  string (the AP decide route is untouched), written in a fixed `Unit #: … / Type: …
/ Make: … / Notes: …` shape; `createEquipmentRequestInTx` refuses anything else
  (a stale tab gets "reload and fill in the type and unit number") and a unit LIST.
  The worklist parses the fields back to pre-fill search and create. A request with
  no unit number is allowed only for types that do not carry one (baler, shear,
  other) and then needs a make or a note — a deliberate relaxation: the green
  baler's approver does not know an EQ number.
- The approver's picker filter is `pickerMatches` (unit-aware) instead of a raw
  `includes()`; fleet-wide rows show as "fleet".
- **`/admin/equipment/duplicates`** — every live pair the matcher calls a probable
  duplicate, cross-site pairs first, minus pairs a person already judged distinct.
  Per pair: **Merge** (pick the survivor and, cross-site, where it lives) or
  **Different assets** (reason required; recorded in `equipment_distinct_pairs` +
  audit). Admin-only, like the merge.

### Deferred, unchanged: H (`pg_trgm`), J (approval of every asset), K (VLM feed).

### Deployed and verified in production (2026-09-23, Pacific)

- Backup before the migration: `svdp-dev:~/backups-adhoc/dr3-adr0135-pre-deploy-20260923-023235-PT.dump`
  (`-Fc`: equipment, ap_equipment_links, ap_equipment_requests, equipment_daily_throughput,
  equipment_throughput_gap_alerts; 74,870 bytes; sha256 `167a5d6f…eb5b`; mode 600). Restore-tested
  into a scratch DB (schema + data-only): 578 / 163 / 32 / 354 / 9 rows = live; scratch dropped.
  Prod had ZERO live case/whitespace-duplicate names fleet-wide immediately before.
- Pushed `8907900` to `main` 2:33 AM PDT; the deployer built on CHAD-HQ, the image-digest gate
  passed (app digest changed → `sha256:47c7132e…`), the migrate container applied
  `20260862_adr0135_equipment_identity` and exited 0, app recreated 2:46:41 AM PDT, health + smoke
  green. On prod: `site_id` nullable, `equipment_live_name_ci_key` / `equipment_live_vin_serial_key`
  / `equipment_distinct_pairs` present, 477 of 578 rows got a backfilled `unit_number`; the new
  routes answer 401/307-to-login unauthenticated.
- `scripts/one-off/2026-09-23-adr0135-prod-verify.ts` against prod — 14/14 PASS: search returns the
  existing asset for `161053.`, `Trailer # 19`, `trailer 32-48`; `48-68` does not surface `4868`;
  creating `161053.` is REFUSED (`probable_duplicate`, Freightliner row attached, no write); the
  override (inside a rolled-back transaction) creates, audits reason + matched rows + actor, and
  writes a distinct-pair row; a cross-site merge into fleet-wide (rolled back) repoints 1 throughput
  - 1 gap-alert row. Both transactions verified to leave nothing behind.
- **BX-2 executed 2:49 AM PDT** — `scripts/one-off/2026-09-23-cross-site-trailer-merge.ts --apply`:
  `Trailer 281577` (Eugene) → `281577 — Great Dane`, `Trailer 282876` (Eugene) → `282876 — Strick
28 Ft …`, `Trailer #284460` (Woodland) → `284460 — Great Dane 28 Ft …`; each survivor now
  FLEET-WIDE; 1 link + 1 resolved request moved per pair; links 3 → 3, spend $495.41 → $495.41;
  nothing left on a loser; 6 audit rows under `system:cross-site-trailer-merge`. Registry: 578 rows,
  532 active, 12 merged, 3 fleet-wide.
- Not verifiable from here: anything that needs a signed-in browser (the click-paths). Bill's
  checklist is in OPEN-ITEMS § 0.BX BX-11.
