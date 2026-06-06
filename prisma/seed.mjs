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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SEED_DIR = join(__dirname, 'seed');

const prisma = new PrismaClient();

function parseCsv(filename) {
  const text = readFileSync(join(SEED_DIR, filename), 'utf-8');
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    throw new Error(`CSV parse errors in ${filename}: ${JSON.stringify(parsed.errors)}`);
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
  'janette@svdp.us': 'janette.thomas@svdp.us',
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
    };
    await prisma.user.upsert({
      where: { email: data.email },
      create: data,
      update: data,
    });
  }
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

async function assertCounts() {
  // Seed-controlled tables: exact count is the contract (CSV-driven).
  const expectedExact = {
    sites: 2,
    site_holidays: 24,
    processor_bonus_rules: 2,
    bonus_pay_periods: 52, // 26 periods × 2 sites (ADR-0019.1 / T-201)
    bonus_signature_chains: 2, // Woodland + Eugene (ADR-0019.2 / T-201)
  };
  // Runtime-growable tables: the seed sets a baseline, but the app legitimately
  // adds rows (users via the admin UI; sources/transporters may be extended).
  // Assert a FLOOR, not equality — otherwise prod (e.g. 7 users) fails the seed.
  const expectedMin = {
    users: 5,
    sources: 111,
    transporters: 11,
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

async function main() {
  console.log('▶ seeding sites');
  await seedSites();
  console.log('▶ seeding transporters');
  await seedTransporters();
  const siteIds = await getSiteIdsByCode();
  console.log('▶ seeding users');
  await seedUsers(siteIds);
  console.log('▶ seeding site_holidays');
  await seedSiteHolidays(siteIds);
  console.log('▶ seeding processor_bonus_rules');
  await seedProcessorBonusRules(siteIds);
  console.log('▶ seeding sources');
  await seedSources(siteIds);
  console.log('▶ seeding bonus pay periods');
  await seedBonusPayPeriods(siteIds);
  console.log('▶ seeding bonus signature chains');
  await seedBonusSignatureChains(siteIds);
  console.log('▶ applying bonus post-seed DDL');
  await seedBonusPostSeedDdl();
  const counts = await assertCounts();
  console.log('✔ seed complete:', counts);
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
