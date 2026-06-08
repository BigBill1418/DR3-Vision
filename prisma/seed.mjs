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
  console.log('▶ seeding historical bonus data (ADR-0023)');
  await seedHistoricalImport(siteIds);
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
