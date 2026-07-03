# Billing rates (ADR-0040)

DR3-Vision keeps every billing rate as **data** in effective-dated tables so the
invoice layer (ADR-0041) is pure computation. This doc is for the operator/admin who
maintains those rates (Rick, at rollout) and for anyone diagnosing the fuel-price feed.

There are four rate tables, all editable under **Admin → Billing Rates**
(`/admin/billing-rates`), plus the fuel-price auto-fetch feed and the variance report.

## Who can edit rates — the `can_manage_rates` flag

Editing the four rate tables requires either the **admin** role OR the
**`can_manage_rates`** flag on a manager. The flag grants *exactly* the four
rate-table writes — **nothing else**. It never unlocks user management, bonus
amendment/override, or any other `/admin/*` power.

**To grant it:** Admin → Users → open the manager → check **"Can manage billing
rates"** → Save. (The checkbox appears for the `manager` role only; admins already
have rate-write via their role, operators never do.) Rick gets this flag at rollout.
Every grant/revoke is audited.

Reading the rate tables + the variance report is open to any **manager or admin**;
writing is admin-or-flag.

## The four tables

### 1. Transport rate tiers (freight zone table)

Freight is a **zone table**, not $/mile: the mileage band a haul falls in fixes a flat
charge. Tiers are per **jurisdiction** (`CA` / `OR`) and effective-dated.

- The CA table is seeded (effective 2026-01-01): `0–25 → $425 · 26–50 → $600 ·
  51–100 → $925 · 101–200 → $1,450 · 201–300 → $2,000 · 301–400 → $2,500 ·
  401–500 → $3,000`.
- **No OR tiers are seeded** — until you add them, OR freight resolves to a typed
  error (never a silent $0). Add OR tiers when you have them.

**Editing safely:** a jurisdiction's tiers for one effective window must be
**contiguous from 0, with no gaps and no overlaps** (each band starts exactly one mile
past the previous band's top). The tier editor validates the whole set before saving
and points at any offending rows — you cannot save a broken set.

**A rate change is a new window, not an edit.** When freight is renegotiated, enter the
new table with a **new effective-from date**. History is never edited — old windows stay
for the audit trail. (Fixing a typo in the current window is fine.)

### 2. Account haul rates (per-account override)

A per-source freight override that **beats the tier table** for that source while in
force. Seeds **empty** — you add overrides from the workbook's variables sheet once you
confirm which are current. Each override is effective-dated (from/to) with an optional
note.

### 3. Container rental sites (monthly trailer rentals)

Monthly trailer/container rentals; the monthly total is the sum of **active** rows in
force for the month. Seeds **empty** by design (the June/July $10,800-vs-$10,500
discrepancy is settled by entering the real rows, not by pre-seeding a contested
number). Toggle a row's **active** flag or end-date it as rentals change.

### 4. Fuel prices (weekly diesel index)

One row per week (keyed on the **Monday** of the week), used for the CA fuel surcharge
(`surcharge = (price ÷ 6.5 mpg) × miles`, applied only when `price > $5.05/gal`, CA
only). Two sources:

- **`eia_api`** — auto-fetched weekly (see below).
- **`manual`** — entered by hand. **A manual entry wins:** the auto-fetch will never
  overwrite a manual row for that week (only another manual entry does, and that
  overwrite is audited).

**Manual entry:** Admin → Billing Rates → Fuel prices → enter any date in the target
week + the $/gal price. The date is normalized to that week's Monday.

## Fuel-price auto-fetch (EIA)

A weekly cron (`fuel-price-fetch` compose service) fires **Tuesday 06:00 Pacific** and
POSTs the internal route `/api/internal/billing/fuel-fetch`, which fetches the EIA
**West Coast (PADD 5) weekly ULSD retail price** (EIA API v2) and upserts the week's
`fuel_prices` row (`source=eia_api`).

- **`EIA_API_KEY`** (free, from <https://api.eia.gov/opendata>) enables the fetch. In
  production it lives in `~/.dr3-vision-secrets/billing.env` (compose env_file,
  `required:false`); locally it's an `.env` var.
- **Fail-open:** if the key is **absent**, the cron logs and skips — nothing pages,
  nothing crashes, and manual entry still works. A *real* fetch failure (HTTP/network/
  bad payload) pages `dr3-vision-system` (fingerprint `fuel-fetch-failed`, 6 h
  cooldown) so a persistent outage re-pages without spamming. **Success is silent.**
- A missing week's price at invoice time is a typed error (never a silent $0) — enter
  it manually if the fetch didn't land.

## Variance report

**Dashboard → Freight rate variance** (`/dashboard/billing-variance`), CSV export
available. Per trans-charge source: current mileage + tier-now vs. the tier it was last
billed under, the per-haul delta, and the monthly leakage. This replaces the hand-built
`renegotiate_trans_rates.docx` as a living, self-updating exhibit.

Until the workbook/invoice-import history is available (ADR-0039 audit-engine staging),
the report shows **tier-now only** with a banner explaining that last-billed / delta /
leakage populate once that import lands.
