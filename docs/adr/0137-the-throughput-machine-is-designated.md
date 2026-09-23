# ADR-0137 — A site's throughput machine is designated, not inferred

- **Status:** Accepted, implemented 2026-09-23 (Pacific)
- **Context:** OPEN-ITEMS §0.BX **BX-12**, approved by Bill 2026-09-23 ~7:20 AM PDT.
- **Supersedes:** ADR-0077 D1's identity rule ("the machine is the `terex`-category row the
  Terex invoices resolve to") and the evidence proxy `isSiteTerexMachine` built on it
  (ADR-0077 Am.2). **Extends:** ADR-0079 (daily throughput), ADR-0088 (gap watchdog),
  ADR-0135 F (every FK into `equipment` is accounted for by the merge).

## Context

`resolveSiteThroughputMachine(siteId)` answered "the OLDEST active, unmerged
`terex`-category row at the site with ANY invoice link"
(`src/lib/equipment/daily-throughput.ts:285-301` before this change). Every throughput
surface asked it: the daily form (read + write), the carry-forward meter prefill, the
90-day trend, the dashboard tile, the EOD day review, and the gap watchdog. Three more
surfaces re-implemented the same proxy inline — `siteMachineLabel` (with **no
ordering at all**), the equipment page's ledger list (ordered by **name**), and the
admin detail page's ledger link.

The ADR-0062 seed files the shear machines under category `terex`. At Woodland,
`EQ24 — Shear Machine` was seeded 2026-07-28, two days before `Terex` (2026-07-30). As
long as no shear had an invoice, the proxy happened to select the Terex. At
**2026-09-02 6:21 AM PDT** EQ24 got its first link (Kelliher, "Welding the sheer
machine"), and from that moment:

- the daily form wrote every Woodland reading onto the shear — 17 days, 09-01 → 09-22;
- 09-01 was entered twice: on the Terex (09-01 5:17 PM PDT) and again on the shear
  (09-02 5:11 PM PDT), after the 8:30 AM gap scan had told the managers 09-01 was
  missing — it asked the shear;
- the Terex's history appeared to stop at 09-01, and its metrics band (ordered by name,
  `EQ24…` < `Terex`) rendered the shear.

The hour meter is the proof the readings are the Terex's: the Terex's 09-01 row ends at
2,895.25 and the shear's 09-02 row starts at 2,895.25, continuing unbroken to 3,030.85
on 09-22. `EQ43` and `EQ74` would have flipped the site the same way the day either was
invoiced. ADR-0077 recorded the proxy as a residual ("the real fix is a link … to an
equipment id"); this is that fix.

## Decision

1. **A designation table, `site_throughput_machines`** (migration
   `20260863_bx12_site_throughput_machine`): `site_id` PRIMARY KEY (one designation per
   site, by construction), `equipment_id` nullable + UNIQUE (one site per machine), both
   FKs `ON DELETE RESTRICT`, a required `reason`, and the ADR-0036 actor pair
   (`set_by` user id or `set_label`, CHECK one of them).
2. **Three states, never collapsed** — `src/lib/equipment/site-machine.ts`:
   - designated row → that machine;
   - designated `NULL` → the site has **no** throughput machine, by decision (Eugene);
   - **no row**, or the designated row is merged / inactive / at another site / gone →
     `ThroughputMachineNotConfiguredError` (status 503). **Never a guess** — a guess is
     how three weeks of Terex readings went onto a shear.
3. **Every consumer reads the designation** — the resolver keeps its name and shape
   (re-exported from `daily-throughput.ts`), so the form, prefill, trend, tile, EOD review
   and watchdog changed no call site; `siteMachineLabel`, the equipment page's ledger
   list, the admin ledger link and `computeTerexLedger`'s identity guard now use it
   instead of their inline copies of the proxy. `category: 'terex'` + `links: { some }`
   no longer decides identity anywhere.
4. **Failing loudly:** the form API answers 503 with the error message (the existing
   `equipmentErrorResponse` status mapping); the gap watchdog records
   `machine_unconfigured` and pages `dr3-vision-system` (high, 6 h cooldown per site,
   existing topic — a configuration fault is a system event under hard rule #5).
5. **Merges carry it:** `site_throughput_machines.equipment_id` joins
   `MERGE_REPOINTED_REFERENCES` (the merged-away row and the survivor are the same
   machine). A merge that would leave a designation off its site — the survivor re-homed,
   or two designated machines merged — is refused (`throughput_machine_site`, 409).
6. **Production designations are data in the migration:** Woodland → `Terex`
   (`7e35a4aa-d022-4e65-b64f-580c74f21cf1`), Eugene → none — guarded on the exact row, so
   on any database without it the site stays unconfigured and fails loudly. `prisma/seed.mjs`
   designates "none" for seeded sites (create-only; never overwrites a designation).

## Alternatives considered

- **`is_throughput_machine` flag on `equipment` + partial unique per site.** Cannot say
  "this site deliberately has none", so Eugene would either fail loudly forever or the
  "missing" state would have to mean "none" — exactly the ambiguity that made the proxy
  silent.
- **A `sites.throughput_equipment_id` column.** Same problem: NULL would mean both "none"
  and "never configured".
- **Keep the proxy, order by "most links".** Still inference; a heavily repaired shear
  flips it.

## Consequences

- Deactivating, re-homing or merging the Terex without re-designating stops every
  throughput surface at Woodland with a clear 503 and pages Bill — by design.
- There is no admin UI to change a designation (not required; Bill 2026-09-23). A change is
  an audited one-off or a follow-up control.
- Data correction (the moved days, the dropped 09-01 duplicate, the 5 gap alerts and
  their verdicts): `scripts/one-off/2026-09-23-bx12-throughput-to-terex.ts`; evidence in
  CHANGELOG and OPEN-ITEMS §0.BX BX-12.
