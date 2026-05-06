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
//
// Re-runs are safe: existing rows update, new rows insert, never duplicate.
//
// Verification: at the end the script asserts the row counts documented
// in `prisma/seed/README.md` (sites=2, users=5, site_holidays=24,
// processor_bonus_rules=2, sources=111, transporters=11). Mismatches
// throw and abort the seed — investigate the CSV before proceeding.

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

async function assertCounts() {
  const expected = {
    sites: 2,
    users: 5,
    site_holidays: 24,
    processor_bonus_rules: 2,
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
  };
  const mismatches = Object.keys(expected).filter((k) => actual[k] !== expected[k]);
  if (mismatches.length > 0) {
    const detail = mismatches.map((k) => `${k}: expected=${expected[k]} actual=${actual[k]}`).join('; ');
    throw new Error(`Seed row-count mismatch — ${detail}`);
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
