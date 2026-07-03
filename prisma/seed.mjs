// DR3-Vision seed loader. Reads the six baseline-reference CSVs in
// `prisma/seed/` and idempotently upserts them into the database. Match
// keys are documented in `prisma/seed/README.md`.
//
// Plain ESM JS (was .ts) so the runtime image doesn't need tsx +
// esbuild — `node prisma/seed.mjs` runs directly. Local dev gets the
// same path; type checking is enforced in code review + at the schema
// level, not via TS in this file.
//
// Load order (dependency-respecting):
//   1. sites                  -- everything else FKs to sites.id
//   2. transporters           -- independent
//   3. users                  -- depends on sites (primary_site_code)
//   4. site_holidays          -- depends on sites
//   5. processor_bonus_rules  -- depends on sites
//   6. sources                -- depends on sites
//   7. bonus_pay_periods      -- depends on sites (ADR-0019.1 / T-201)
//   8. bonus_signature_chains -- depends on sites + users (resolves signer
//                                emails to user ids; ADR-0019.2 / T-201)
//   9. bonus post-seed DDL    -- NOT NULL + canonical unique index, applied
//                                after the 52 rows are in place (T-201)
//
// Also seeded (right after users, before site_holidays): the ADR-0030 daily
// production report config — 1 BonusDailyReportConfig per site (2 rows) plus
// their BonusDailyReportRecipient rosters (3 Woodland + 4 Eugene = 7 rows).
// Idempotent; not asserted in assertCounts (recipients are admin-editable).
//
// Re-runs are safe: existing rows update, new rows insert, never duplicate.
// The post-seed DDL is idempotent (SET NOT NULL re-issue is a no-op;
// CREATE UNIQUE INDEX IF NOT EXISTS).
//
// Verification: at the end the script asserts the row counts documented
// in `prisma/seed/README.md` (sites=2, users=5, site_holidays=24,
// processor_bonus_rules=2, sources=111, transporters=11,
// bonus_pay_periods=52, bonus_signature_chains=2). Mismatches throw and
// abort the seed — investigate the CSV before proceeding.

import { PrismaClient, Prisma } from '@prisma/client';
import Papa from 'papaparse';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SEED_DIR = join(__dirname, 'seed');
const HISTORICAL_SEED_DIR = join(SEED_DIR, 'historical');

const prisma = new PrismaClient();

function parseCsv(filename) {
  const text = readFileSync(join(SEED_DIR, filename), 'utf-8');
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    throw new Error(`CSV parse errors in ${filename}: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed.data;
}

function parseHistoricalCsv(filename) {
  const text = readFileSync(join(HISTORICAL_SEED_DIR, filename), 'utf-8');
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    throw new Error(`Historical CSV parse errors in ${filename}: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed.data;
}

function blankToNull(v) {
  return v == null || v === '' ? null : v;
}

function intOrNull(v) {
  const s = blankToNull(v);
  return s == null ? null : Number.parseInt(s, 10);
}

function bool(v) {
  return String(v).toLowerCase() === 'true';
}

// Parse a YYYY-MM-DD CSV cell as a date-only value at UTC midnight, matching
// the @db.Date columns (Postgres DATE has no time/zone). Same convention as
// seedSiteHolidays / seedProcessorBonusRules above.
function dateOnly(v) {
  const s = blankToNull(v);
  if (s == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Expected YYYY-MM-DD date, got '${v}'`);
  }
  return new Date(`${s}T00:00:00Z`);
}

// ─── Signature-chain email reconciliation ────────────────────────────────
// `bonus_signature_chains.csv` identifies signers/override-actors by EMAIL,
// but those emails do not all match the canonical addresses seeded by
// `users.csv`. Two documented discrepancies (flagged in the T-200/T-201
// report, NOT silently absorbed):
//
//   1. Short-form addresses in the chain CSV (janette@ / morena@ / rick@)
//      are abbreviations of the canonical `.full@svdp.us` form used in
//      users.csv AND in the cutover runbook's Entra-account list
//      (docs/v3 add/bonus-cadence-and-eugene-cutover.md). The chain CSV
//      itself was corrected to the canonical form when copied into
//      prisma/seed/; this map is defense-in-depth in case a future CSV
//      regresses to the short form.
//   2. Bill is seeded in users.csv as `operations@svdp.us`, but the chain
//      CSV + runbook refer to him as `bill.barnard@svdp.us`. Until users.csv
//      adopts bill.barnard@ (out of scope for T-201 — it would change an
//      existing seeded identity), we resolve bill.barnard@ → operations@.
//
// If a referenced email cannot be resolved to a seeded user, the seed throws
// loudly (matching the runbook's "deploy will fail if a referenced user can't
// be found" contract) rather than silently dropping a signer.
const SIGNATURE_CHAIN_EMAIL_ALIASES = {
  'bill.barnard@svdp.us': 'operations@svdp.us',
  'janette@svdp.us': 'janette.tomas@svdp.us',
  'morena@svdp.us': 'morena.gomez@svdp.us',
  'rick@svdp.us': 'rick.albritton@svdp.us',
};

function resolveSignerEmail(email) {
  const e = email.trim().toLowerCase();
  return SIGNATURE_CHAIN_EMAIL_ALIASES[e] ?? e;
}

async function seedSites() {
  const rows = parseCsv('sites.csv');
  for (const r of rows) {
    const data = {
      code: r.code,
      name: r.name,
      jurisdiction: r.jurisdiction,
      mrc_program_code: r.mrc_program_code,
      max_units_indoor: intOrNull(r.max_units_indoor),
      max_units_outdoor: intOrNull(r.max_units_outdoor),
      max_units_total_on_site: intOrNull(r.max_units_total_on_site),
      customer_service_open: r.customer_service_open,
      customer_service_close: r.customer_service_close,
      recycling_rate_target_pct: new Prisma.Decimal(r.recycling_rate_target_pct),
      records_retention_years: Number.parseInt(r.records_retention_years, 10),
      inbound_processing_deadline_days: Number.parseInt(r.inbound_processing_deadline_days, 10),
      mymrc_inbound_submission_business_days: Number.parseInt(
        r.mymrc_inbound_submission_business_days,
        10,
      ),
      mymrc_processed_submission_business_days: Number.parseInt(
        r.mymrc_processed_submission_business_days,
        10,
      ),
      dock_sla_minutes: Number.parseInt(r.dock_sla_minutes, 10),
      reconciliation_target_pct: new Prisma.Decimal(r.reconciliation_target_pct),
      billing_cadence: r.billing_cadence,
      cip_enabled: bool(r.cip_enabled),
    };
    await prisma.site.upsert({
      where: { code: data.code },
      create: data,
      update: data,
    });
  }
}

async function seedTransporters() {
  const rows = parseCsv('transporters.csv');
  for (const r of rows) {
    const data = {
      name: r.name,
      is_internal: bool(r.is_internal),
      is_active: bool(r.is_active),
      notes: blankToNull(r.notes),
    };
    await prisma.transporter.upsert({
      where: { name: data.name },
      create: data,
      update: data,
    });
  }
}

async function getSiteIdsByCode() {
  const sites = await prisma.site.findMany({ select: { id: true, code: true } });
  return new Map(sites.map((s) => [s.code, s.id]));
}

async function seedUsers(siteIds) {
  const rows = parseCsv('users.csv');
  for (const r of rows) {
    const primaryCode = blankToNull(r.primary_site_code);
    const primary_site_id = primaryCode ? (siteIds.get(primaryCode) ?? null) : null;
    if (primaryCode && !primary_site_id) {
      throw new Error(`users.csv: unknown primary_site_code='${primaryCode}' for ${r.email}`);
    }
    const data = {
      email: r.email,
      name: r.name,
      role: r.role,
      locale: r.locale || 'en',
      primary_site_id,
      processor_role: blankToNull(r.processor_role),
      is_active: bool(r.is_active),
      all_sites: bool(r.all_sites), // ADR-0024 all-sites manager (blank → false)
      is_super_admin: bool(r.is_super_admin), // ADR-0030 super-admin (blank/false → false)
    };
    await prisma.user.upsert({
      where: { email: data.email },
      create: data,
      update: data,
    });
  }

  // ── ADR-0030 (contract divergence #3): flip Bill to super-admin ──
  // bill.barnard@svdp.us is Bill's real SSO login but is NOT a row in
  // users.csv (only the inactive import alias operations@svdp.us is). On a
  // fresh DB his SSO row doesn't exist yet, so this updateMany matches 0 rows
  // and is a no-op; once he has signed in (or prod runs the manual UPDATE at
  // deploy), the row exists and this idempotently sets is_super_admin = true.
  await prisma.user.updateMany({
    where: { email: 'bill.barnard@svdp.us' },
    data: { is_super_admin: true },
  });
}

async function seedSiteHolidays(siteIds) {
  const rows = parseCsv('site_holidays.csv');
  for (const r of rows) {
    const site_id = siteIds.get(r.site_code);
    if (!site_id) {
      throw new Error(`site_holidays.csv: unknown site_code='${r.site_code}'`);
    }
    const holiday_date = new Date(`${r.holiday_date}T00:00:00Z`);
    const data = { site_id, holiday_date, name: r.name };
    await prisma.siteHoliday.upsert({
      where: { site_id_holiday_date: { site_id, holiday_date } },
      create: data,
      update: data,
    });
  }
}

async function seedProcessorBonusRules(siteIds) {
  const rows = parseCsv('processor_bonus_rules.csv');
  for (const r of rows) {
    const site_id = siteIds.get(r.site_code);
    if (!site_id) {
      throw new Error(`processor_bonus_rules.csv: unknown site_code='${r.site_code}'`);
    }
    const effective_date = new Date(`${r.effective_date}T00:00:00Z`);
    const end_date_raw = blankToNull(r.end_date);
    const data = {
      site_id,
      threshold_low: Number.parseInt(r.threshold_low, 10),
      rate_low: new Prisma.Decimal(r.rate_low),
      threshold_high: Number.parseInt(r.threshold_high, 10),
      rate_high: new Prisma.Decimal(r.rate_high),
      effective_date,
      end_date: end_date_raw ? new Date(`${end_date_raw}T00:00:00Z`) : null,
      notes: blankToNull(r.notes),
    };
    const existing = await prisma.processorBonusRule.findFirst({
      where: { site_id, effective_date },
      select: { id: true },
    });
    if (existing) {
      await prisma.processorBonusRule.update({ where: { id: existing.id }, data });
    } else {
      await prisma.processorBonusRule.create({ data });
    }
  }
}

// ─── ADR-0037 D1 (Addendum B5) — state_program_rules (rates are DATA, never code) ──
// Every rate the loads/inventory/billing layer reads resolves from here via the
// strict named resolver `src/lib/program-rules/resolver.ts`. Idempotent upsert
// keyed on (site_id, rule_kind, effective_from) — the CA processing fee is a full
// effective-dated schedule (2025/2026/2027), so multiple rows share a rule_kind
// and differ by effective_from.
//
// STRUCTURAL GUARD (D1): OR fuel surcharge is IMPOSSIBLE — no fuel_surcharge rule
// is ever seeded for Eugene (Oregon), AND the resolver throws for an OR fuel
// lookup. The CA fuel formula is captured (Rick Albritton, survey Q6, 2026-07-03)
// but COMPUTATION stays refused until P2 billing wires the EIA-rate × miles
// calculator (rate_cents is null; the amount is formula-driven).
//
// No mattress/foundation categories anywhere (Addendum B1). No DR3#/Material#
// sequence issuance yet (Addendum B10-6 open — see the loads runbook TODO).
async function seedStateProgramRules(siteIds) {
  const woodland = siteIds.get('woodland');
  const eugene = siteIds.get('eugene');
  if (!woodland || !eugene) {
    throw new Error('state_program_rules seed: missing woodland/eugene site id');
  }
  const D2025 = new Date('2025-01-01T00:00:00Z');
  const D2026 = new Date('2026-01-01T00:00:00Z');
  const D2027 = new Date('2027-01-01T00:00:00Z');
  const END2025 = new Date('2025-12-31T00:00:00Z');
  const END2026 = new Date('2026-12-31T00:00:00Z');
  const rules = [
    // CA processing (per-unit fee) — full effective-dated schedule (Summary!Q8:R11
    // existed and was ignored; Vision wires the table). $16.00 → $16.50 → $17.00.
    { site_id: woodland, rule_kind: 'processing_rate', rate_cents: 1600, effective_from: D2025, effective_to: END2025,
      params: null, notes: 'CA processing rate $16.00/unit (2025; Summary!Q8:R11).' },
    { site_id: woodland, rule_kind: 'processing_rate', rate_cents: 1650, effective_from: D2026, effective_to: END2026,
      params: null, notes: 'CA processing rate $16.50/unit (2026; Summary!Q8:R11).' },
    { site_id: woodland, rule_kind: 'processing_rate', rate_cents: 1700, effective_from: D2027, effective_to: null,
      params: null, notes: 'CA processing rate $17.00/unit (2027; Summary!Q8:R11).' },
    // OR processing $17.00/unit (end-of-month only).
    { site_id: eugene, rule_kind: 'processing_rate', rate_cents: 1700, effective_from: D2026, effective_to: null,
      params: null, notes: 'OR processing rate $17.00/unit (mission §3).' },
    // OR satellite collection $2.25/unit.
    { site_id: eugene, rule_kind: 'satellite_collection_rate', rate_cents: 225, effective_from: D2026, effective_to: null,
      params: null, notes: 'OR satellite collection rate $2.25/unit (mission §3).' },
    // CA collector incentive $3.00/unit, capped 5 units/person/day (list!T2).
    { site_id: woodland, rule_kind: 'collector_incentive', rate_cents: 300, effective_from: D2026, effective_to: null,
      params: { daily_cap_units: 5 }, notes: 'CA collector incentive $3.00/unit, cap 5 units/person/day.' },
    // CA fuel surcharge — formula + trigger captured (Addendum B3); computation P2.
    { site_id: woodland, rule_kind: 'fuel_surcharge', rate_cents: null, effective_from: D2026, effective_to: null,
      params: {
        formula: '(eia_rate_usd_per_gal / mpg) * miles_driven',
        mpg: 6.5,
        trigger_usd_per_gal: 5.05,
        index_series: 'EIA West Coast PADD-5 ULSD weekly retail',
        index_url: 'https://www.eia.gov/dnav/pet/pet_pri_gnd_dcus_r50_w.htm',
        captured_from: 'survey dr3-intel-2026-06, Rick Albritton, 2026-07-03',
      },
      notes: 'CA fuel surcharge; formula + $5.05/gal trigger captured (Addendum B3), computation P2. NEVER seed for OR.' },
    // CA labor / per-diem constants (Addendum B5) — parameterized, never retyped.
    { site_id: woodland, rule_kind: 'driver_hourly', rate_cents: 12500, effective_from: D2026, effective_to: null,
      params: null, notes: 'CA driver rate $125.00/hr (Addendum B5).' },
    { site_id: woodland, rule_kind: 'general_labor_hourly', rate_cents: 9000, effective_from: D2026, effective_to: null,
      params: null, notes: 'CA general labor $90.00/hr (Addendum B5).' },
    { site_id: woodland, rule_kind: 'per_diem_nightly', rate_cents: 27500, effective_from: D2026, effective_to: null,
      params: null, notes: 'CA per diem $275.00/night (Addendum B5).' },
    // Unit-weight estimate 55 lbs/unit — ESTIMATE ONLY (MRC reporting uses actual
    // scale weights on outbound). Both sites; no rate (params-only).
    { site_id: woodland, rule_kind: 'unit_weight_estimate', rate_cents: null, effective_from: D2026, effective_to: null,
      params: { lbs: 55, estimate_only: true }, notes: '55 lbs/unit estimate only (Addendum B5).' },
    { site_id: eugene, rule_kind: 'unit_weight_estimate', rate_cents: null, effective_from: D2026, effective_to: null,
      params: { lbs: 55, estimate_only: true }, notes: '55 lbs/unit estimate only (Addendum B5).' },
  ];
  for (const r of rules) {
    const existing = await prisma.stateProgramRule.findFirst({
      where: { site_id: r.site_id, rule_kind: r.rule_kind, effective_from: r.effective_from },
      select: { id: true },
    });
    const data = {
      site_id: r.site_id,
      rule_kind: r.rule_kind,
      effective_from: r.effective_from,
      effective_to: r.effective_to,
      rate_cents: r.rate_cents,
      params: r.params ?? undefined,
      notes: r.notes,
    };
    if (existing) {
      await prisma.stateProgramRule.update({ where: { id: existing.id }, data });
    } else {
      await prisma.stateProgramRule.create({ data });
    }
  }
}

async function seedSources(siteIds) {
  const rows = parseCsv('sources.csv');
  for (const r of rows) {
    const site_id = siteIds.get(r.site_code);
    if (!site_id) {
      throw new Error(`sources.csv: unknown site_code='${r.site_code}'`);
    }
    const data = {
      site_id,
      name: r.name,
      street: blankToNull(r.street),
      city: blankToNull(r.city),
      state: blankToNull(r.state),
      zip: blankToNull(r.zip),
      is_active: bool(r.is_active),
      notes: blankToNull(r.notes),
    };
    await prisma.source.upsert({
      where: { site_id_name: { site_id, name: data.name } },
      create: data,
      update: data,
    });
  }
}

// ─── Bonus bi-weekly pay periods (ADR-0019.1 / T-201) ────────────────────
// 26 periods × 2 sites = 52 rows. Idempotent upsert keyed on the canonical
// (site_id, period_year, period_number). The unique index backing that key is
// created post-seed (see seedBonusPostSeedDdl) because period_number /
// period_year were added NULL-allowed by the migration; we use findFirst +
// create/update here so the seed is safe both before and after that index
// exists.
async function seedBonusPayPeriods(siteIds) {
  const rows = parseCsv('bonus_pay_periods_2026.csv');
  for (const r of rows) {
    const site_id = siteIds.get(r.site_code);
    if (!site_id) {
      throw new Error(`bonus_pay_periods_2026.csv: unknown site_code='${r.site_code}'`);
    }
    const period_number = Number.parseInt(r.period_number, 10);
    const period_year = Number.parseInt(r.period_year, 10);
    if (!Number.isInteger(period_number) || !Number.isInteger(period_year)) {
      throw new Error(
        `bonus_pay_periods_2026.csv: bad period_number/period_year for ${r.site_code} (${r.period_number}/${r.period_year})`,
      );
    }
    const data = {
      site_id,
      period_number,
      period_year,
      period_start: dateOnly(r.period_start),
      period_end: dateOnly(r.period_end),
      pay_date: dateOnly(r.pay_date),
    };
    const existing = await prisma.bonusPayPeriod.findFirst({
      where: { site_id, period_year, period_number },
      select: { id: true },
    });
    if (existing) {
      await prisma.bonusPayPeriod.update({ where: { id: existing.id }, data });
    } else {
      await prisma.bonusPayPeriod.create({ data });
    }
  }
}

// ─── Bonus signature chains (ADR-0019.2 §2 / T-201) ──────────────────────
// 2 rows (Woodland + Eugene). The CSV identifies signers/override-actors by
// EMAIL; we resolve to user UUIDs at seed time (see resolveSignerEmail and the
// SIGNATURE_CHAIN_EMAIL_ALIASES note). Override-actor email lists are
// comma-separated; we resolve each and store back as a comma-separated list of
// UUIDs in the *_override_actor_ids string columns. Idempotent upsert keyed on
// site_id (one chain per site).
async function seedBonusSignatureChains(siteIds) {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  const userIdByEmail = new Map(
    users.filter((u) => u.email).map((u) => [u.email.toLowerCase(), u.id]),
  );

  const resolve = (rawEmail, ctx) => {
    const canonical = resolveSignerEmail(rawEmail);
    const id = userIdByEmail.get(canonical);
    if (!id) {
      throw new Error(
        `bonus_signature_chains.csv: cannot resolve ${ctx} email '${rawEmail}' ` +
          `(canonical '${canonical}') to a seeded user. Seed users first, or fix the email.`,
      );
    }
    return id;
  };

  const resolveList = (rawList, ctx) =>
    String(rawList)
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => resolve(e, ctx))
      .join(',');

  const rows = parseCsv('bonus_signature_chains.csv');
  for (const r of rows) {
    const site_id = siteIds.get(r.site_code);
    if (!site_id) {
      throw new Error(`bonus_signature_chains.csv: unknown site_code='${r.site_code}'`);
    }
    const data = {
      site_id,
      facility_signer_user_id: resolve(r.facility_signer_email, `${r.site_code} facility_signer`),
      facility_override_actor_ids: resolveList(
        r.facility_override_actor_emails,
        `${r.site_code} facility_override`,
      ),
      ops_signer_user_id: resolve(r.ops_signer_email, `${r.site_code} ops_signer`),
      ops_override_actor_ids: resolveList(
        r.ops_override_actor_emails,
        `${r.site_code} ops_override`,
      ),
      auto_override_actor_user_id: resolve(
        r.auto_override_actor_email,
        `${r.site_code} auto_override_actor`,
      ),
    };
    await prisma.bonusSignatureChain.upsert({
      where: { site_id },
      create: data,
      update: data,
    });
  }
}

// ─── Daily production report config + recipients (ADR-0030) ──────────────
// One BonusDailyReportConfig per site (Woodland + Eugene), each enabled and
// firing at 18:00:00 PT, with its recipient roster. Recipients are from the
// BUILD-CONTRACT divergence #2 (Morena added per operator request 2026-06-17).
// Fully idempotent: config upsert is keyed on the unique site_id; each
// recipient upsert is keyed on the composite unique (config_id, email). Emails
// are normalized to lowercase so the composite-unique key never collides on
// case. Re-runs only flip enabled back on and ensure the roster exists; they
// never delete a recipient an admin may have added via the UI.
const DAILY_REPORT_RECIPIENTS = {
  woodland: [
    'bill.barnard@svdp.us',
    'bethany.cartledge@svdp.us',
    'morena.gomez@svdp.us',
  ],
  eugene: [
    'shannon.rockwell@svdp.us',
    'bill.barnard@svdp.us',
    'bethany.cartledge@svdp.us',
    'rick.albritton@svdp.us',
  ],
};

async function seedDailyReportConfig(siteIds) {
  for (const code of ['woodland', 'eugene']) {
    const site_id = siteIds.get(code);
    if (!site_id) {
      throw new Error(`seedDailyReportConfig: unknown site code='${code}'`);
    }
    const config = await prisma.bonusDailyReportConfig.upsert({
      where: { site_id },
      create: {
        site_id,
        enabled: true,
        // @db.Time column — only the time-of-day matters. 18:00 PT.
        send_time_pt: new Date('1970-01-01T18:00:00.000Z'),
        subject_template: 'DR3 Daily Production Report — {site} — {date}',
        updated_at: new Date(),
      },
      update: { enabled: true },
    });

    for (const rawEmail of DAILY_REPORT_RECIPIENTS[code]) {
      const email = rawEmail.trim().toLowerCase();
      await prisma.bonusDailyReportRecipient.upsert({
        where: { config_id_email: { config_id: config.id, email } },
        create: { config_id: config.id, email },
        update: {},
      });
    }
  }
}

// ─── Post-seed DDL (T-201) ───────────────────────────────────────────────
// The migration added period_number / period_year / pay_date as NULL-allowed
// so the in-place table rename could land before data existed. Now that the
// 52 rows are seeded, tighten the constraints and add the canonical unique
// index. All statements are idempotent (IF NOT EXISTS / re-issuing SET NOT
// NULL on an already-NOT-NULL column is a no-op), so re-running the seed is
// safe.
async function seedBonusPostSeedDdl() {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE bonus_pay_periods ALTER COLUMN period_number SET NOT NULL',
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE bonus_pay_periods ALTER COLUMN period_year SET NOT NULL',
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE bonus_pay_periods ALTER COLUMN pay_date SET NOT NULL',
  );
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS bonus_pay_periods_site_id_period_year_period_number_key ' +
      'ON bonus_pay_periods(site_id, period_year, period_number)',
  );
}

// ─── Historical bonus data import (ADR-0023 / T-320) ─────────────────────
// Imports the one historical spreadsheet bundle in prisma/seed/historical/.
// IDEMPOTENT via bonus_imports.source_sha256 — a re-run that finds the same
// SHA already imported is a no-op. createMany(skipDuplicates) + upserts make
// the row-level inserts re-run-safe too. See ADR-0023.
async function seedHistoricalImport(siteIds) {
  // Read the bonus_imports row first — it carries SHA, totals, the import
  // session id, and the timestamp. One row.
  const importRow = parseHistoricalCsv('bonus_imports.csv')[0];
  if (!importRow) {
    console.log('  (no historical import to seed — bonus_imports.csv is empty)');
    return;
  }
  const importSessionId = importRow.id;
  const sourceSha = importRow.source_sha256;

  // Idempotency: if this exact import already landed, no-op.
  const existing = await prisma.bonusImport.findUnique({
    where: { source_sha256: sourceSha },
    select: { id: true },
  });
  if (existing) {
    console.log(`  ▼ historical import already loaded (sha ${sourceSha.slice(0, 12)}…); skipping`);
    return;
  }

  // ── Resolve the importing user (Bill via operations@svdp.us alias) ──
  const importer = await prisma.user.findUnique({
    where: { email: 'operations@svdp.us' },
    select: { id: true },
  });
  if (!importer) {
    throw new Error(
      'seedHistoricalImport: cannot resolve operations@svdp.us — users must be seeded first.',
    );
  }

  // ── 1. Create the BonusImport row ──
  console.log('  ▶ creating bonus_import session');
  await prisma.bonusImport.create({
    data: {
      id: importSessionId,
      source_filename: importRow.source_filename,
      source_sha256: sourceSha,
      source_archive_path: `prisma/seed/historical/source-archive/${importRow.source_filename}`,
      imported_by_user_id: importer.id,
      imported_at: new Date(importRow.imported_at),
      total_entries: Number.parseInt(importRow.total_entries, 10),
      total_mattress_count: new Prisma.Decimal(importRow.total_mattress_count),
      total_legacy_dollars: new Prisma.Decimal(importRow.total_legacy_dollars),
      stockton_origin_entries: Number.parseInt(importRow.stockton_origin_entries, 10),
      stockton_origin_dollars: new Prisma.Decimal(importRow.stockton_origin_dollars),
      anomaly_count: Number.parseInt(importRow.anomaly_count, 10),
      auto_sum_count: Number.parseInt(importRow.auto_sum_count, 10),
      notes: importRow.notes ?? null,
    },
  });

  // ── 2. Seed 2025 pay periods (52 rows) ──
  console.log('  ▶ seeding 2025 pay periods (52 rows)');
  const pp2025 = parseHistoricalCsv('bonus_pay_periods_2025.csv');
  for (const r of pp2025) {
    const site_id = siteIds.get(r.site_code);
    if (!site_id) {
      throw new Error(`bonus_pay_periods_2025.csv: unknown site_code='${r.site_code}'`);
    }
    const period_number = Number.parseInt(r.period_number, 10);
    const period_year = Number.parseInt(r.period_year, 10);
    const data = {
      site_id,
      period_number,
      period_year,
      period_start: dateOnly(r.period_start),
      period_end: dateOnly(r.period_end),
      pay_date: dateOnly(r.pay_date),
      state: 'draft', // initial state; transitions to historical_imported below
    };
    const existing = await prisma.bonusPayPeriod.findFirst({
      where: { site_id, period_year, period_number },
      select: { id: true },
    });
    if (existing) {
      await prisma.bonusPayPeriod.update({ where: { id: existing.id }, data });
    } else {
      await prisma.bonusPayPeriod.create({ data });
    }
  }

  // Build period-id lookup: (site_code, year, period_number) → period.id
  const periodIdByKey = new Map();
  const allPeriods = await prisma.bonusPayPeriod.findMany({
    select: { id: true, site_id: true, period_year: true, period_number: true },
  });
  const siteCodeById = new Map(Array.from(siteIds.entries()).map(([code, id]) => [id, code]));
  for (const p of allPeriods) {
    const code = siteCodeById.get(p.site_id);
    periodIdByKey.set(`${code}|${p.period_year}|${p.period_number}`, p.id);
  }

  // ── 3. Seed bonus_employees (94 rows; idempotent by deterministic UUID) ──
  console.log('  ▶ seeding bonus_employees from historical CSV');
  const empRows = parseHistoricalCsv('bonus_employees_historical.csv');
  // Resolve Patrick Dills' user_id once (he is the sole BonusEmployee linked
  // to a User account in the historical import, per ADR-0023).
  const patrick = await prisma.user.findUnique({
    where: { email: 'patrick.dills@svdp.us' },
    select: { id: true },
  });
  const patrickUserId = patrick?.id ?? null;

  for (const r of empRows) {
    const site_id = siteIds.get(r.site_code);
    if (!site_id) {
      throw new Error(`bonus_employees_historical.csv: unknown site_code='${r.site_code}'`);
    }
    const data = {
      id: r.id,
      site_id,
      full_name: r.full_name,
      is_active: bool(r.is_active),
      notes: blankToNull(r.notes),
      user_id: r.full_name === 'Patrick Dills' ? patrickUserId : null,
    };
    await prisma.bonusEmployee.upsert({
      where: { id: r.id },
      create: data,
      update: data,
    });
  }

  // ── 4. Seed bonus_employee_aliases (128 rows) ──
  console.log('  ▶ seeding bonus_employee_aliases');
  const aliasRows = parseHistoricalCsv('bonus_employee_aliases_historical.csv');
  // Build canonical_name → bonus_employee_id lookup (scoped by site)
  const empIdByCanonical = new Map();
  for (const r of empRows) {
    empIdByCanonical.set(`${r.full_name}|${r.site_code}`, r.id);
  }
  for (const a of aliasRows) {
    const canonical_employee_id = empIdByCanonical.get(`${a.canonical_name}|${a.target_site_code}`);
    if (!canonical_employee_id) {
      throw new Error(
        `bonus_employee_aliases_historical.csv: cannot resolve canonical='${a.canonical_name}' site='${a.target_site_code}'`,
      );
    }
    await prisma.bonusEmployeeAlias.upsert({
      where: {
        variant_name_canonical_employee_id: {
          variant_name: a.variant_name,
          canonical_employee_id,
        },
      },
      create: {
        variant_name: a.variant_name,
        canonical_employee_id,
        import_session_id: a.import_session_id,
      },
      update: {
        import_session_id: a.import_session_id,
      },
    });
  }

  // ── 5. Update pay-period state + dual totals from historical state CSV ──
  console.log('  ▶ updating pay-period totals + transitioning to historical_imported');
  const stateRows = parseHistoricalCsv('bonus_pay_periods_historical_state.csv');
  let periodsTransitioned = 0;
  for (const r of stateRows) {
    const key = `${r.site_code}|${r.period_year}|${r.period_number}`;
    const periodId = periodIdByKey.get(key);
    if (!periodId) {
      throw new Error(`bonus_pay_periods_historical_state.csv: unknown period ${key}`);
    }
    const legacyCents = Number.parseInt(r.legacy_total_payout_cents, 10);
    const totalCents = Number.parseInt(r.total_payout_cents, 10);
    const importedWithLegacy = bool(r.imported_with_legacy_formula);

    // Read current state so we capture before-state correctly for audit
    const before = await prisma.bonusPayPeriod.findUnique({
      where: { id: periodId },
      select: { state: true },
    });

    await prisma.$transaction(async (tx) => {
      await tx.bonusPayPeriod.update({
        where: { id: periodId },
        data: {
          state: 'historical_imported',
          legacy_total_payout_cents: legacyCents,
          total_payout_cents: totalCents,
          imported_with_legacy_formula: importedWithLegacy,
          import_session_id: importSessionId,
        },
      });
      await tx.auditLog.create({
        data: {
          actor_user_id: importer.id,
          actor_label: 'system:historical-import',
          action: 'update',
          table_name: 'bonus_pay_periods',
          row_id: periodId,
          before: { state: before?.state ?? 'unknown' },
          after: {
            state: 'historical_imported',
            legacy_total_payout_cents: legacyCents,
            total_payout_cents: totalCents,
            imported_with_legacy_formula: importedWithLegacy,
            import_session_id: importSessionId,
          },
        },
      });
    });
    periodsTransitioned++;
  }
  console.log(`    transitioned ${periodsTransitioned} periods to historical_imported`);

  // ── 6. Bulk insert daily entries (with provenance JSONB + audit rows) ──
  console.log('  ▶ inserting historical daily entries (~5,158 rows)');
  const entryRows = parseHistoricalCsv('bonus_daily_entries_historical.csv');

  // Build the dataset for createMany in batches of 500 (memory + query size).
  const BATCH = 500;
  let insertedEntries = 0;
  let insertedAuditRows = 0;
  for (let i = 0; i < entryRows.length; i += BATCH) {
    const chunk = entryRows.slice(i, i + BATCH);
    const periodKey = (r) => `${r.site_code}|${r.period_year}|${r.period_number}`;
    const entryData = chunk
      .map((r) => {
        const periodId = periodIdByKey.get(periodKey(r));
        if (!periodId) {
          throw new Error(
            `bonus_daily_entries_historical.csv: unknown period ${periodKey(r)} for entry ${r.id}`,
          );
        }
        return {
          id: r.id,
          bonus_employee_id: r.bonus_employee_id,
          bonus_pay_period_id: periodId,
          entry_date: dateOnly(r.entry_date),
          mattress_count: new Prisma.Decimal(r.mattress_count),
          legacy_total_cents: Math.round(Number.parseFloat(r.legacy_total_dollars) * 100),
          import_session_id: importSessionId,
          import_provenance: {
            source_sheet_name: r.source_sheet_name,
            source_row_index: r.source_row_index,
            source_count_col: Number.parseInt(r.source_count_col, 10),
            source_total_col: Number.parseInt(r.source_total_col, 10),
            original_site_code: r.original_site_code,
            total_source: r.total_source,
            raw_count: Number.parseFloat(r.raw_count),
            raw_total: Number.parseFloat(r.raw_total),
            formula_version: r.formula_version,
            merge_strategy: r.merge_strategy || null,
            merge_source_count: r.merge_source_count
              ? Number.parseInt(r.merge_source_count, 10)
              : 1,
          },
          entered_by_user_id: importer.id,
          entered_at: new Date(importRow.imported_at),
          note: null,
        };
      });
    // createMany with skipDuplicates for re-run safety on the unique
    // (bonus_employee_id, entry_date) index.
    const result = await prisma.bonusDailyEntry.createMany({
      data: entryData,
      skipDuplicates: true,
    });
    insertedEntries += result.count;

    // Audit log: one row per daily entry created (Q17 max forensic granularity).
    // Build audit rows mirroring the entry data; provenance JSONB is the `after`.
    const auditData = entryData.map((e) => ({
      actor_user_id: importer.id,
      actor_label: 'system:historical-import',
      action: 'insert',
      table_name: 'bonus_daily_entries',
      row_id: e.id,
      before: null,
      after: {
        bonus_employee_id: e.bonus_employee_id,
        bonus_pay_period_id: e.bonus_pay_period_id,
        entry_date: e.entry_date,
        mattress_count: e.mattress_count.toString(),
        legacy_total_cents: e.legacy_total_cents,
        import_session_id: e.import_session_id,
        import_provenance: e.import_provenance,
      },
    }));
    const auditResult = await prisma.auditLog.createMany({ data: auditData });
    insertedAuditRows += auditResult.count;

    if ((i / BATCH) % 5 === 0) {
      console.log(`    ${insertedEntries}/${entryRows.length} entries + ${insertedAuditRows} audit rows`);
    }
  }
  console.log(`    ✔ ${insertedEntries} daily entries inserted; ${insertedAuditRows} audit rows`);

  console.log('  ✔ historical import complete');
}

async function assertCounts() {
  // Seed-controlled tables: exact count is the contract (CSV-driven).
  const expectedExact = {
    sites: 2,
    site_holidays: 24,
    processor_bonus_rules: 2,
    bonus_pay_periods: 104, // 52 (2026) + 52 (2025) = 104 (ADR-0023 §Q3)
    bonus_signature_chains: 2, // Woodland + Eugene (ADR-0019.2 / T-201)
  };
  // Runtime-growable tables: the seed sets a baseline, but the app legitimately
  // adds rows (users via the admin UI; sources/transporters may be extended).
  // Assert a FLOOR, not equality — otherwise prod (e.g. 7 users) fails the seed.
  const expectedMin = {
    users: 6, // Bill, Kelsey, Morena, Rick, Janette, Patrick (ADR-0023)
    sources: 111,
    transporters: 11,
    bonus_employees: 94, // historical import (ADR-0023)
    bonus_employee_aliases: 128,
    bonus_imports: 1,
    bonus_daily_entries: 5000, // floor — exact is 5,158 but allow for future entries
  };
  const actual = {
    sites: await prisma.site.count(),
    users: await prisma.user.count(),
    site_holidays: await prisma.siteHoliday.count(),
    processor_bonus_rules: await prisma.processorBonusRule.count(),
    sources: await prisma.source.count(),
    transporters: await prisma.transporter.count(),
    bonus_pay_periods: await prisma.bonusPayPeriod.count(),
    bonus_signature_chains: await prisma.bonusSignatureChain.count(),
    bonus_employees: await prisma.bonusEmployee.count(),
    bonus_employee_aliases: await prisma.bonusEmployeeAlias.count(),
    bonus_imports: await prisma.bonusImport.count(),
    bonus_daily_entries: await prisma.bonusDailyEntry.count(),
  };
  const mismatches = [
    ...Object.keys(expectedExact)
      .filter((k) => actual[k] !== expectedExact[k])
      .map((k) => `${k}: expected=${expectedExact[k]} actual=${actual[k]}`),
    ...Object.keys(expectedMin)
      .filter((k) => actual[k] < expectedMin[k])
      .map((k) => `${k}: expected>=${expectedMin[k]} actual=${actual[k]}`),
  ];
  if (mismatches.length > 0) {
    throw new Error(`Seed row-count mismatch — ${mismatches.join('; ')}`);
  }
  return actual;
}

// ── ADR-0034 operational intelligence survey seed (auto-mirrored from
// prisma/seed/survey_dr3_intel_2026.ts; that .ts file is the typed source of
// truth — keep this block byte-aligned with it). Plain ESM so `node
// prisma/seed.mjs` seeds the campaign without tsx. Idempotent by slug.

const CAMPAIGN_SLUG = 'dr3-intel-2026-06';
const CAMPAIGN_TITLE = 'DR3 Operational Intelligence — June 2026';

const INTRO_TEXT = `I'm collecting input from across the DR3 team to help build a better data management system — one that improves how we operate, tracks what we do more reliably, frees up your time on data entry, and gives everyone from the floor to leadership a clearer operational picture.

This survey was created by me so we can gather what each of you knows about the systems and processes you touch — what works, what doesn't, and what would make your work easier. Your responses will feed directly into the design of a new DR3 data management system intended to safeguard and automate processes within the DR3 department, free up staff time, verify we have correct data, and improve overall operational tracking.

Responses save as you type; you can come back to finish later. No login required. Should take 20-45 minutes depending on how much detail you want to share. More detail is better, but skip what doesn't apply. Reply to this email if anything is unclear.

— Bill Barnard, Director of Operations`;

// The closing question appended to every packet.
const CLOSING_QUESTION = {
  position: 9999, // re-numbered at insert
  kind: 'long_text',
  prompt: 'What are we missing? What should we be looking at that we haven\'t asked about?',
  description:
    'Anything that didn\'t fit the questions above. Operational pain points, data quality issues, blind spots, ideas, concerns, side topics — whatever you think we should know.',
  is_required: false,
};


const PACKETS = [
  // ─── 1. Bethany Cartledge — Executive Director ────────────────
  {
    recipient_name: 'Bethany Cartledge',
    recipient_email: 'bethany.cartledge@svdp.us', // adjust if needed
    role_label: 'Executive Director',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt: 'What does the board ask you about DR3 most often that you don\'t have great data for today?',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'When you talk about DR3 publicly — donors, MRC, regulators, community — what numbers do you wish you could quote with confidence?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'DR3 funds SVdP human services. What is the most important "DR3 funds X human services" data we should be able to show?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt: 'What concerns about DR3 operations reach you that you suspect better data could address?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'If you opened a single DR3 dashboard once a week, what 5 numbers or metrics should be on it?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'When ADR-0033\'s financial integration roadmap item lands, what financial picture do you most want to see — DR3 contribution to SVdP services, per-facility cost recovery, something else?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt: 'Are there mission/board reporting deadlines that should drive Vision\'s reporting cadence?',
      },
    ],
  },

  // ─── 2. Leisha Wallace — Personnel ────────────────────────────
  {
    recipient_name: 'Leisha Wallace',
    recipient_email: 'leisha.wallace@svdp.us',
    role_label: 'Personnel Director',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt: 'What\'s the history of DR3 you\'ve witnessed? Key changes in process, staffing, or scope.',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'From a personnel perspective — what longitudinal data do you wish we tracked about DR3 staff that we don\'t today? (Tenure patterns, role progression, bonus history vs retention, attendance trends, anything else.)',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt: 'What recurring HR questions about DR3 do you find yourself piecing together from multiple sources?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'Are there compliance or regulatory tracking needs specific to DR3 staff that we should bake into the new system?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'What employee-facing reports would help your work? Per-employee production history, bonus earnings history, tenure milestones, etc.',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'Without crossing into individual-sensitive territory — what aggregate workforce metrics about DR3 should leadership see?',
      },
    ],
  },

  // ─── 3. Shannon Rockwell — Stores Operations / Rick\'s supervisor ──
  {
    recipient_name: 'Shannon Rockwell',
    recipient_email: 'shannon.rockwell@svdp.us',
    role_label: 'Director of Stores Operations',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'As Rick\'s supervisor — what data do you currently get from him about DR3 operations, and how (email, paper, conversation, ad-hoc)?',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt: 'What about Eugene\'s DR3 operations do you wish you had real-time visibility into?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'What\'s the cadence of your DR3 oversight work — daily check-ins, weekly reviews, monthly meetings?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt: 'What reports do you produce upward about DR3, and where does the data for them come from today?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt: 'What cross-site visibility (Eugene vs Woodland) do you want as a supervisor?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'How does DR3 connect to Stores operations beyond reporting? Are there Stores-to-DR3 material flows or coordination points we should track?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt: 'What\'s the biggest gap between what you know about DR3 today and what you wish you knew?',
      },
    ],
  },

  // ─── 4. Mary Scott — Accounting / GP entry for MRC billing ───────
  {
    recipient_name: 'Mary Scott',
    recipient_email: 'mary.scott@svdp.us',
    role_label: 'Accounting / Great Plains Entry for MRC Billing',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'Walk me through your process for MRC billing — what comes to you from Rick, in what format, and what do you do with it?',
      },
      {
        position: 2,
        kind: 'single_select',
        prompt:
          'Which Great Plains integration mechanism does SVdP use for entering invoice data today?',
        options: [
          { label: 'eConnect (XML integration)', value: 'econnect' },
          { label: 'SmartConnect (CSV/Excel templates mapped to GP tables)', value: 'smartconnect' },
          { label: 'Integration Manager (built-in GP IM tool)', value: 'integration_manager' },
          { label: 'Direct entry through the GP UI (no automation)', value: 'direct_entry' },
          { label: 'Something else — describe in the closing question', value: 'other' },
          { label: 'I don\'t know', value: 'unknown' },
        ],
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'What does the GP customer record for MRC look like? Customer ID, default GL accounts, terms, anything else relevant.',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'What goes wrong most often in the MRC billing process today? Where do errors creep in, what gets caught late, what gets caught only after MRC pushes back?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'If you could specify the exact file or format you wanted to receive from Rick (or from a Vision system) to make GP entry painless, what would it look like? Columns, fields, format, naming convention, anything.',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt: 'How are credits and adjustments to MRC invoices handled today? Walk through a real example if possible.',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt:
          'What\'s the close cadence — when do you cut off MRC invoices for the month, and when do they need to be entered in GP?',
      },
      {
        position: 8,
        kind: 'long_text',
        prompt: 'Are there other DR3-related entries you make in GP beyond MRC invoices? Payroll, expense, etc.',
      },
    ],
  },

  // ─── 5. Rick Albritton — Eugene + MRC billing contact ──────────
  {
    recipient_name: 'Rick Albritton',
    recipient_email: 'rick.albritton@svdp.us',
    role_label: 'Eugene Manager + MRC Billing Contact',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'Walk me through how you produce the data Mary uses to bill MRC. What sources do you pull from, what calculations do you do, what format do you send her, what cadence?',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'For California Woodland — when do you cut off the mid-month invoice? Strictly the 15th regardless of weekday, last business day on or before the 15th, first business day on or after, or some other rule?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'Does Eugene have a daily log spreadsheet or equivalent? If not, how is daily Eugene production captured? Who does it, when, with what?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'How do you coordinate between Eugene and Woodland operationally? Container moves, material transfers, shared resources, staff coverage, anything.',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'Where does MRC reconciliation happen — do you compare what MRC shows in their portal against what you\'ve billed? What does that process look like, and how often do discrepancies show up?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'What\'s the fuel surcharge formula for CA? How is it calculated each month? Where does the diesel index come from?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt:
          'On every row of the Woodland daily log, the DR3 # and Material # appear as sequential numbers. How are these assigned? Who picks the next number, from what source, when?',
      },
      {
        position: 8,
        kind: 'long_text',
        prompt: 'What about the spreadsheet or process frustrates you most? Where do errors creep in?',
      },
      {
        position: 9,
        kind: 'long_text',
        prompt:
          'If Vision generated a clean MRC billing data package automatically, what would need to be in it for you to trust it? What checks would you want to see before approving?',
      },
      {
        position: 10,
        kind: 'long_text',
        prompt: 'What\'s the Oregon fee schedule going forward? Per-unit, per-site collection, transport, anything else.',
      },
    ],
  },

  // ─── 6. Janette Tomas — Woodland Manager ─────────────────────────
  {
    recipient_name: 'Janette Tomas',
    recipient_email: 'janette.tomas@svdp.us',
    role_label: 'Woodland Manager',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'Walk me through your daily routine with the Woodland daily log spreadsheet (e.g. JUNE_2026_DAILY_LOG_WOODLAND.xlsm). When do you enter what? Real-time during the day, or all at once at end of day?',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'The DR3 # and Material # sequences on each row — how are these assigned? Who picks the next number, from what source, and when? Are these used in MRC reporting or just internal?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'The "office use only" columns on the daily sheets — what do you enter there and when?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'Container rentals at collection sites — how does the operational reality work? Trailers placed, swapped, picked up? Or simpler than that? How is the rental count tracked and reconciled to the monthly invoice?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'Events like the Chico Event — how often do these happen? What\'s your involvement? What information do you need to capture, and how do you capture it today?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'In June 2026\'s daily log, day 10 had "Terex is down" written into a numeric cell. Where do you record equipment status, downtime, repairs today? Is there a better way?',
      },
      {
        position: 7,
        kind: 'single_select',
        prompt: 'For photo or document capture (BOL photos, weight ticket photos) — would attaching photos to each daily-log row help your work?',
        options: [
          { label: 'Yes, on every row — would replace paper retention', value: 'every_row' },
          { label: 'Yes, on outbound rows specifically (BOL + weight ticket)', value: 'outbound_only' },
          { label: 'Sometimes — depends on the situation', value: 'sometimes' },
          { label: 'No — would slow things down too much', value: 'no' },
          { label: 'I don\'t know yet', value: 'unknown' },
        ],
      },
      {
        position: 8,
        kind: 'long_text',
        prompt:
          'Has the spreadsheet template changed over time? What versions have you seen? Any major shifts that would matter when we try to import historical data?',
      },
      {
        position: 9,
        kind: 'long_text',
        prompt:
          'The inventory cap of 3,500 units at Woodland — when does the facility actually hit it? What do you do when capacity is reached? Have you ever had to turn trucks away?',
      },
      {
        position: 10,
        kind: 'long_text',
        prompt: 'What about the spreadsheet or current process frustrates you most? What do you wish was different?',
      },
    ],
  },

  // ─── 7. Morena Gomez — California Operations ─────────────────────
  {
    recipient_name: 'Morena Gomez',
    recipient_email: 'morena.gomez@svdp.us',
    role_label: 'DR3 California Operations Manager',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'As CA operations manager — what\'s your visibility across the CA facility today? What do you check daily, weekly, monthly? In what tools or formats?',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'Where has the spreadsheet been wrong in ways you\'ve caught? Tell me a few specific examples — what was wrong, how was it caught, what was the impact?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'What cross-facility coordination work do you do that paper or email handles today? Material moves, shared resources, staffing, anything.',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'What dashboard would you want to see when you open Vision in the morning? What 5 things tell you "is CA OK today?"',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'You\'ve seen Vision\'s daily reconciliation reports recently. What did you do with that data? Was it useful? What would you change about it?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt: 'What systems and tools do you use most often in your work, and what do you wish you could replace?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt:
          'Now that Stockton has wound down, what\'s the CA facility footprint going forward? Anything Vision needs to know about future expansion or contraction at Woodland?',
      },
    ],
  },

  // ─── 8. Kelsey Ruhland — Data / Compliance ───────────────────────
  {
    recipient_name: 'Kelsey Ruhland',
    recipient_email: 'kelsey.ruhland@svdp.us',
    role_label: 'Data / Compliance',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'What MRC reporting do you handle? Cadence, format, who you submit to, what gets verified before submission.',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'The per-unit fee schedule for CA — the daily log shows 2026=$16.50 and 2027=$17.00. Is that the verified schedule going forward? And what\'s Oregon\'s schedule for 2026 and 2027?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'Re-Trac IDs on each collection site — how does Re-Trac fit into the picture? What goes in there, when, by whom?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'What audit and retention requirements should the new system bake in? How long do we keep daily logs, BOLs, photos, anything else?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt: 'What compliance reports do you generate for DR3, and what data do you need for them?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt: 'CalRecycle reporting — what\'s your involvement and what frequency?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt:
          'If MRC enabled API access tomorrow (we requested it 2026-05-04 and haven\'t heard back), what would you want Vision to do with it? Pull-only? Pull + write-back? Reconciliation alerts?',
      },
      {
        position: 8,
        kind: 'long_text',
        prompt:
          'Where do you currently catch errors before they reach MRC? What\'s the verification process today and where could automation help most?',
      },
      {
        position: 9,
        kind: 'long_text',
        prompt:
          'For state-by-state rules — what fee categories are allowed in each state? OR has confirmed no fuel surcharge; what other asymmetries between CA and OR should Vision know about?',
      },
    ],
  },

  // ─── 9. Juan — Woodland production floor ─────────────────────────
  {
    recipient_name: 'Juan',
    recipient_email: 'juan@svdp.us', // adjust if needed
    role_label: 'Woodland Production Floor',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt: 'From the floor — what equipment and processes do you work with? Walk me through a typical shift.',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'Equipment downtime — when something breaks (like the Terex), how is that recorded today? What goes into the spreadsheet, what stays word-of-mouth, what gets lost?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'Quality issues — when a mattress can\'t be processed (wet, damaged, illegal contents inside), what happens and how is it recorded?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt: 'What slows production down most often? What would you change if you could?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'Production volume — is the number recorded each day accurate to what you actually processed? What would make it more accurate?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt: 'What information do you wish supervisors had about the floor that they don\'t today?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt: 'Safety — are there safety events or near-misses that should be tracked alongside production?',
      },
      {
        position: 8,
        kind: 'long_text',
        prompt:
          'For your role specifically — what would make the work easier? Better tools, better data, better coordination, anything.',
      },
    ],
  },

  // ─── 10. Patrick Dills — Eugene lead processor ────────────────────
  {
    recipient_name: 'Patrick Dills',
    recipient_email: 'patrick.dills@svdp.us',
    role_label: 'Eugene Lead Processor',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt: 'From the Eugene floor — what equipment and processes do you work with? Walk me through a typical shift.',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'The bonus system — how does it look from the processor\'s side? What\'s working, what\'s not, what would you change?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt: 'What\'s the difference between how Eugene and Woodland operate that you\'ve noticed?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt: 'Equipment downtime, quality issues, safety events — how are these handled in Eugene today?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'Production volume tracking — is it accurate to what actually happens on the floor? What would improve it?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'As a lead processor — what information do you wish other processors had access to? What would help them work better?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt: 'What dashboards or screens would processors themselves benefit from seeing?',
      },
      {
        position: 8,
        kind: 'long_text',
        prompt: 'What about the daily routine frustrates you most? What would you fix first if you could?',
      },
    ],
  },
];

async function seedSurveyIntelCampaign(ownerUserId) {
  const existing = await prisma.surveyCampaign.findUnique({ where: { slug: CAMPAIGN_SLUG } });
  if (existing) {
    console.log(`  ▼ survey campaign '${CAMPAIGN_SLUG}' already seeded; skipping`);
    return;
  }
  await prisma.$transaction(async (tx) => {
    const campaign = await tx.surveyCampaign.create({
      data: {
        title: CAMPAIGN_TITLE,
        slug: CAMPAIGN_SLUG,
        intro_text: INTRO_TEXT,
        created_by_user_id: ownerUserId,
        status: 'draft',
      },
    });
    for (const packet of PACKETS) {
      const allQuestions = [
        ...packet.questions,
        { ...CLOSING_QUESTION, position: packet.questions.length + 1 },
      ];
      const token = randomBytes(24).toString('base64url');
      await tx.surveyInvite.create({
        data: {
          campaign_id: campaign.id,
          recipient_name: packet.recipient_name,
          recipient_email: packet.recipient_email.toLowerCase(),
          role_label: packet.role_label,
          token,
          status: 'draft',
          questions: {
            create: allQuestions.map((q) => ({
              position: q.position,
              kind: q.kind,
              prompt: q.prompt,
              description: q.description ?? null,
              options: q.options == null ? Prisma.JsonNull : q.options,
              is_required: q.is_required ?? false,
            })),
          },
        },
      });
    }
  });
  console.log(`  ✔ survey campaign '${CAMPAIGN_SLUG}' seeded with ${PACKETS.length} invites (draft)`);
}

async function resolveSurveyOwnerId() {
  // Bill is the campaign owner. He logs in as bill.barnard@svdp.us but is
  // seeded as operations@svdp.us (alias) — try both, then any super-admin.
  for (const email of ['bill.barnard@svdp.us', 'operations@svdp.us']) {
    const u = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (u) return u.id;
  }
  const sa = await prisma.user.findFirst({ where: { is_super_admin: true }, select: { id: true } });
  return sa?.id ?? null;
}

async function main() {
  console.log('▶ seeding sites');
  await seedSites();
  console.log('▶ seeding transporters');
  await seedTransporters();
  const siteIds = await getSiteIdsByCode();
  console.log('▶ seeding users');
  await seedUsers(siteIds);
  console.log('▶ seeding daily-report config + recipients (ADR-0030)');
  await seedDailyReportConfig(siteIds);
  console.log('▶ seeding site_holidays');
  await seedSiteHolidays(siteIds);
  console.log('▶ seeding processor_bonus_rules');
  await seedProcessorBonusRules(siteIds);

  await seedStateProgramRules(siteIds);
  console.log('▶ seeding sources');
  await seedSources(siteIds);
  console.log('▶ seeding bonus pay periods');
  await seedBonusPayPeriods(siteIds);
  console.log('▶ seeding bonus signature chains');
  await seedBonusSignatureChains(siteIds);
  console.log('▶ applying bonus post-seed DDL');
  await seedBonusPostSeedDdl();
  console.log('▶ seeding historical bonus data (ADR-0023)');
  await seedHistoricalImport(siteIds);
  console.log('▶ seeding operational intelligence survey (ADR-0034)');
  const surveyOwnerId = await resolveSurveyOwnerId();
  if (surveyOwnerId) {
    await seedSurveyIntelCampaign(surveyOwnerId);
  } else {
    console.warn('  ⚠ no super-admin / Bill user found — skipping survey campaign seed');
  }
  const counts = await assertCounts();
  console.log('✔ seed complete:', counts);

  // ── Eager historical-period PDF generation (ADR-0023 Q13 / T-321) ──
  // FINAL seed step. Renders + uploads a PDF (as-paid legacy total + import
  // attestation) for every historical_imported period lacking a pdf_storage_key.
  // Best-effort: this needs the running Next app (the internal render route) +
  // R2 creds, which may be absent during a bare `prisma db seed`. A failure here
  // must NOT fail the data seed — the operator runbook re-runs it standalone
  // (`node scripts/generate-historical-pdfs.mjs`) once the app + R2 are up.
  // Idempotent, so the standalone re-run only fills the gaps.
  console.log('▶ generating historical-period PDFs (ADR-0023 / T-321)');
  try {
    const { generateHistoricalPdfs } = await import('../scripts/generate-historical-pdfs.mjs');
    const pdfSummary = await generateHistoricalPdfs(prisma);
    if (pdfSummary.failed > 0) {
      console.warn(
        `  ⚠ ${pdfSummary.failed} historical PDF(s) failed to generate ` +
          `(generated ${pdfSummary.generated}, skipped ${pdfSummary.skipped}). ` +
          'Re-run `node scripts/generate-historical-pdfs.mjs` once the app + R2 are up.',
      );
    } else {
      console.log(
        `  ✔ historical PDFs: generated ${pdfSummary.generated}, skipped ${pdfSummary.skipped}`,
      );
    }
  } catch (err) {
    console.warn(
      '  ⚠ historical PDF generation skipped (app/R2 unavailable): ' +
        `${err?.message ?? err}. Re-run \`node scripts/generate-historical-pdfs.mjs\` later.`,
    );
  }
}

main()
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  })
  .then(async () => {
    await prisma.$disconnect();
  });
