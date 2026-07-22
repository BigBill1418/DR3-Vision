# `prisma/seed/`

Seed data for DR3-Vision database initialization. These CSV files populate baseline reference tables on a fresh database (development, staging, or production day-1).

## Load order

The Prisma seed script (`prisma/seed.ts` — to be written in Sprint 1, ticket T-002) must load these CSVs in dependency order:

1. **`sites.csv`** — must load first; many other tables FK to `sites.id`
2. **`users.csv`** — depends on sites (some users have a `primary_site_code`)
3. **`site_holidays.csv`** — depends on sites
4. **`processor_bonus_rules.csv`** — depends on sites
5. **`sources.csv`** — depends on sites
6. **`transporters.csv`** — independent, can load any time

The loader matches by `(site_code, name)` for sources, by `name` for transporters, by `email` for users, and by `code` for sites. Re-running the seed updates existing rows; never duplicates.

```bash
npx prisma db seed
```

## Files

### `sites.csv` — 2 rows

The two operating sites: Eugene (Oregon) and Woodland (California). Each row encodes the per-site contract parameters from `docs/MRC-CONTRACTS.md`: storage limits, recycling rate target, retention years, processing deadline, and billing cadence.

Per-site differences locked in here:

- Eugene: 6,000 unit total cap, no indoor cap, 70% recycling target, 5-year retention, 60-day processing window, end-of-month billing only, no CIP
- Woodland: 3,500 indoor cap (outdoor storage is not tracked — ADR-0037 addendum 2026-07-22), 75% recycling target, 4-year retention, 45-day processing window, mid+end-of-month billing, CIP enabled

Empty cells (`,,`) are intentional — Eugene has no indoor cap, Woodland has no total cap.

### `users.csv` — 6 rows

The six named portal accounts that exist day 1: Bill Barnard (`operations@` import alias, inactive — Bill signs in as `bill.barnard@svdp.us`), Kelsey Ruhland (manager, **all-sites** per ADR-0024), Morena Gomez (manager, Woodland), Rick Albritton (manager, Eugene), Janette Tomas (manager, Woodland), Patrick Dills (manager, Eugene).

The `all_sites` column (ADR-0024): `true` makes a `manager` reach every site like an admin would, but WITHOUT the admin role — so no user management, bonus amendment, or override. Only Kelsey ships `all_sites=true` (Data & Compliance lead / MRC SME who needs both-site visibility). Granting/revoking it today is seed- or SQL-managed; an `/admin/users` toggle is a planned fast-follow.

Patrick Dills is the Eugene lead processor, added per ADR-0023. He gets read access to Eugene site data but is **intentionally not a member of the Eugene bonus signature chain** (separation of duties — Patrick is himself a BonusEmployee at Eugene). Like the other rows he ships `is_active=false` and is activated via the `/admin/users` panel after his first Entra SSO sign-in.

**All seeded with `is_active=false`.** Per ADR-0016, manager + admin sign-in is Microsoft Entra ID SSO only — there is no password to seed and no per-user reset flow. An admin activates each row via the `/admin/users` Settings panel (ADR-0017) once the seeded user has been added to the `DR3-Vision Admins` Entra security group; the user can then sign in via "Sign in with Microsoft" on `/login`.

Three of the five emails are placeholders pending Bill's confirmation (Morena, Rick, Janette — see open decision #7 in the charter). The seed loader should preserve any manual email update made post-seed.

Operator accounts (forklift drivers) are **not** in the seed file. They are created through the `/admin/users` panel by an admin as Rick and Janette hire/onboard staff. PIN auth (ADR-0004) flows separately from this seed.

### `site_holidays.csv` — 24 rows (12 per site, 2026 + 2027)

The six US federal holidays observed at both DR3 sites: New Year's, Memorial, Independence, Labor, Thanksgiving, Christmas. Bill confirmed both sites use the same six (Q19 in the charter). Each entry uses the **observed** date (e.g., when July 4 falls on a weekend, the Friday or Monday observance is the date that matters for business-day SLA calculations).

Coverage: 2026 + 2027, matching the contract terms (both end Dec 31, 2027). For 2028+, this file will be appended manually before each year-end deploy or replaced by a generator function in V2.

### `processor_bonus_rules.csv` — 2 rows

The bonus calculation parameters per site, derived from `Bonus_Spread_Sheet_2026.xlsx`:

- **Eugene:** `MAX(units − 50, 0) × $1.00 + MAX(units − 100, 0) × $0.25`
- **Woodland:** `MAX(units − 50, 0) × $0.50 + MAX(units − 75, 0) × $0.25`

Both rules become effective 2026-01-01 with no end date. When a rate or threshold changes, append a new row with the new `effective_date` and set the previous row's `end_date` — never edit historical rows. This is what enables back-calculation of past bonus periods after a rule change.

ADR-0011 covers why this is parameterized rather than hardcoded.

### `sources.csv` — 114 rows

Mattress collection sites that deliver to DR3 facilities. Drives the **Source** dropdown on the inbound-load form.

**Provenance:**

- 105 rows: real Woodland sources extracted from the MyMRC haul-level export (`report1777920718332.xls`), covering 4,906 hauls dated 2023-09-20 through 2026-05-04. Address fields parsed from the most-recent haul to that source.
- 6 rows: Eugene placeholder stubs for Oregon Collection Site Count locations (Salem, Albany, Cottage Grove, Florence per MRC OR contract Exhibit) and known Lane County waste facilities. **Addresses TBD** — backfill from the Oregon MyMRC export when available.
- 3 rows (2026-07-09): Eugene sites observed on the scanned paper daily-log sample (rollup §4.3): Thompsons Sanitary Service, Stayton Community Center, Deschutes. **Addresses TBD; names to be confirmed against Rick's forms.** The sample's other Site values are NOT sources: `Glenwood TC 143/144` are trailer-tagged aliases of the seeded Glenwood Transfer & Recycling Station, and `Illegal Drop` / `Sponsors` are drop-off kinds (`consumer_dropoffs.kind`), not collection sites.

Source `name` values **must match MyMRC verbatim** — including punctuation and capitalization — for the reconciliation match to work. Don't "clean up" names in the seed file.

Top 5 Woodland sources by historical volume:

1. North Area Recovery Station (NARS) — 343 hauls
2. Neal Road Recycling and Waste Facility — 343 hauls
3. Western Placer Waste Management Authority — 311 hauls
4. Yolo County Central Landfill — 256 hauls
5. Costco-Innovel - Benicia — 215 hauls

### `transporters.csv` — 11 rows

Trucking companies that deliver mattresses to DR3. Drives the **Transporter** dropdown.

**Provenance:** all 11 transporters seen in the MyMRC haul export, ranked by haul count. The two largest (Ron Lawrence & Son external + SVdP/DR3 internal hauling) account for ~80% of all hauls.

`is_internal=true` flags carriers that are SVdP/DR3-owned (so per-haul cost accounting can split them cleanly).

## Idempotency

The seed loader (T-002 in Sprint 1) must be **idempotent**: re-running `npx prisma db seed` should update existing rows where the data has changed and insert new rows, but never create duplicates. Match keys:

| Table                   | Match key                   |
| ----------------------- | --------------------------- |
| `sites`                 | `code`                      |
| `users`                 | `email`                     |
| `site_holidays`         | `(site_id, holiday_date)`   |
| `processor_bonus_rules` | `(site_id, effective_date)` |
| `sources`               | `(site_id, name)`           |
| `transporters`          | `name`                      |

## Expected row counts after seed

After a fresh seed, `npx prisma studio` should show:

| Table                   | Row count |
| ----------------------- | --------- |
| `sites`                 | 2         |
| `users`                 | 6         |
| `site_holidays`         | 24        |
| `processor_bonus_rules` | 2         |
| `sources`               | 111       |
| `transporters`          | 11        |

If any of these is off, the seed loader has a bug — investigate before proceeding.

## Updating

When the Oregon MyMRC export becomes available:

1. Drop the OR `report*.xls` file in `/scratch/`
2. Run `scripts/regenerate-seed-from-mymrc.py` (TODO build in Sprint 2 — preserves any manual edits)
3. Commit the updated CSVs

When MRC adds a new collection site mid-quarter, managers add it through the portal — the seed file does not need to be updated for runtime; it's only the day-1 baseline.

When a processor bonus rule changes, append a new row to `processor_bonus_rules.csv` with the new `effective_date` and update the previous row's `end_date`. Historical rows stay forever for back-calculation.

## Data integrity reminders

- **Site `code` values** are stable identifiers (`eugene`, `woodland`) — never change them; many things FK to them
- **Address fields** are nice-to-have for printing and routing, not required. The MyMRC reconciliation match keys off `name` + date + count.
- **Eugene placeholder rows** have `haul_count_2023_2026 = 0` and empty `last_delivery_date` — easy to filter from real-data analytics until backfilled.
- **Seeded user rows ship with `is_active = false`.** Production deploy must add each user to the `DR3-Vision Admins` Entra security group AND flip `is_active` true via the `/admin/users` Settings panel (ADR-0017) before they can sign in.
