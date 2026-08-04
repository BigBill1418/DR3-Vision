#!/usr/bin/env node
// One-shot, idempotent, audited seed of the `equipment` master from the SVdP
// "DR3 Machine List" workbook (file-drop 580024f8, 2026-07-28).
//
// WHY THIS EXISTS
// ---------------
// `equipment` is the option set behind the AP Approve panel's equipment
// multi-select (ADR-0046 Amendment 5 / D-M5-6). It was EMPTY in production —
// every one of the 12 `ap_equipment_links` rows written to date is
// `is_not_equipment_related=true`, because an approver had literally nothing to
// pick. The AP code calls the registry "admin-managed", but no create surface was
// ever built, so there is no UI path to populate it. This script is that path
// until the admin screen exists (see docs/OPEN-ITEMS.md C-27).
//
// SITE MAPPING (operator-directed, 2026-07-28)
// --------------------------------------------
// The workbook is SVdP-WIDE: 554 rows across 35 locations, of which only 21 are
// tagged "DR3 Woodland" and NONE are "DR3 Eugene". `equipment.site_id` is a FK to
// `sites`, and only two site rows exist. Bill's direction was to load everything
// anyway ("load all of this in for all sites — just no better way for now"), so
// rows are mapped by JURISDICTION, which is the charter's own axis:
//
//   California  → woodland   (DR3 Woodland, DR3 Livermore, DR3 Stockton, OTR California)
//   everything else → eugene (Oregon SVdP facilities, the unqualified OTR fleet,
//                             and rows with no location at all)
//
// This is deliberately coarse and is NOT a claim that e.g. Cleveland Warehouse is
// the DR3 Eugene operation. It makes the whole fleet selectable at approval time;
// refine it when the real DR3-Eugene asset list arrives.
//
// STOCKTON (CLAUDE.md hard rule #1)
// ---------------------------------
// 15 rows live at the Stockton facility. The `equipment` model stores only
// display_name / category / site_id / is_active — there is NO location column —
// so those assets load WITHOUT the word "Stockton" being written into any stored
// or user-facing string. The rule ("never mention Stockton in user-facing code,
// docs, UI strings, or seed data") is satisfied by construction; the unit numbers
// (EQ43 etc.) carry no site identity. No location text from the workbook is ever
// persisted.
//
// IDEMPOTENCY
// -----------
// Keyed on (site_id, display_name). A re-run updates category/is_active in place
// when they drifted and inserts only genuinely new rows; it never duplicates and
// never hard-deletes. Every insert and every update writes an `audit_log` row
// (hard rule #6 — append-only) with actor_label='system:equipment-seed'.
//
// USAGE
//   # parse anywhere exceljs is installed (a dev clone):
//   node scripts/seed-equipment-master.mjs --file <machine-list.xlsx> --emit-json rows.json
//   # write from anywhere @prisma/client is (the runtime container has no exceljs):
//   node scripts/seed-equipment-master.mjs --json rows.json [--apply]
//   # or do both at once where both deps exist:
//   node scripts/seed-equipment-master.mjs --file <machine-list.xlsx> [--apply]
// Without --apply it is a DRY RUN and prints the plan without writing.
//
// The parse/write split exists because the deployed image is a Next standalone
// build: it ships @prisma/client but NOT exceljs. `--emit-json` carries the parsed
// rows (and the source sha256, so provenance survives the hop) across that gap.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ACTOR_LABEL = 'system:equipment-seed';
const SHEET_NAME = 'DR3 Machine List';

/** Statuses that mean "not in service" → is_active=false. */
const INACTIVE_STATUSES = new Set([
  'Scrapped',
  'To Be Scrapped',
  'Sold',
  'Inactive',
  'Out of Service',
  'Transferred to Car Lot for Sale',
]);

// 91 of the 554 workbook rows have a BLANK Type cell. Rather than dumping all of
// them into `other`, fall back to the Make column: in this fleet the make alone
// identifies the class (Great Dane / Fruehauf / Strick = trailers; Freightliner /
// Volvo = tractors; Ford / Toyota = light vehicles). Only rows where neither Type,
// Notes, Make nor the unit-number convention says anything stay `other` — an
// honest "unknown", not a guess.
const VEHICLE_MAKES =
  /^(fruehauf|wabash|strick|trailmobile|great dane|utility trailer|pullman|dorsey|comet|hyundai|trailer|converter dolly|freightliner|volvo|international|peterbilt|kenworth|mack|isuzu|ford|chevrolet|gmc|toyota|honda|mazda|nissan|dodge|buick|ram|mercedes|sterling)\b/i;

/** EquipmentCategory ∈ vehicle | forklift | baler | terex | other. */
function categorize(type, notes, make, unit = '') {
  const b = `${type} ${notes} ${make}`.toLowerCase();
  if (b.includes('forklift')) return 'forklift';
  if (b.includes('baler')) return 'baler';
  // The Woodland shear (EQ74) is the machine the equipment_events log calls
  // "terex"; shear machines map to that category. ("Sheer" is a recurring
  // workbook misspelling.)
  if (b.includes('shear') || b.includes('sheer')) return 'terex';
  if (/trailer|truck|van|bus|vehicle|dolly|semi|tractor|flatbed|jockey|stacker/.test(b))
    return 'vehicle';

  // ── inference for blank-Type rows ──
  if (make && VEHICLE_MAKES.test(make.trim())) return 'vehicle';
  // Unit-number convention: F## is a forklift (cf. Woodland F60/F61/F62).
  if (/^F\d+$/i.test(unit.trim())) return 'forklift';
  // EQ## is fixed plant (baler/shear/press) but the workbook does not say which.
  return 'other';
}

/**
 * Location string is "addr - facility - city - state" (or a bare label).
 * Returns the site CODE this row maps to. California → woodland; all else → eugene.
 */
function siteCodeFor(location) {
  const parts = location.split(' - ').map((s) => s.trim());
  const state = parts.length >= 4 ? parts[3] : '';
  const facility = parts.length >= 4 ? parts[1] : parts[0] || '';
  if (state === 'California') return 'woodland';
  if (/california/i.test(facility)) return 'woodland';
  return 'eugene';
}

/** Human-readable, approver-facing label. Never includes location text. */
function displayName(unit, make, type) {
  const tail = [make, type].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return tail ? `${unit} — ${tail}` : unit;
}

async function parseWorkbook(file) {
  // Dynamic so the write-only path (--json) runs in the standalone container,
  // which has no exceljs.
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets[0];
  if (!ws) throw new Error(`no worksheet found (expected "${SHEET_NAME}")`);

  const out = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return; // header
    const cell = (i) => {
      const v = row.values[i];
      if (v == null) return '';
      if (typeof v === 'object') return String(v.text ?? v.result ?? '').trim();
      return String(v).trim();
    };
    const unit = cell(1);
    if (!unit) return; // a row with no Unit # is not an asset
    const make = cell(2);
    const location = cell(4);
    const type = cell(5);
    const status = cell(6);
    const notes = cell(8);
    out.push({
      unit,
      make,
      type,
      status,
      notes,
      site_code: siteCodeFor(location),
      category: categorize(type, notes, make, unit),
      is_active: !INACTIVE_STATUSES.has(status),
      display_name: displayName(unit, make, type),
    });
  });
  return out;
}

/** Disambiguate display-name collisions within a site (5 unit numbers repeat). */
function dedupe(rows) {
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.site_code}::${r.display_name}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) r.display_name = `${r.display_name} (#${n})`;
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1] ?? null;
  };
  const file = opt('--file');
  const jsonIn = opt('--json');
  const emitJson = opt('--emit-json');
  const apply = args.includes('--apply');

  if (!file && !jsonIn) {
    console.error(
      'usage: seed-equipment-master.mjs (--file <xlsx> | --json <rows.json>) [--emit-json <out>] [--apply]',
    );
    process.exit(2);
  }

  let sha;
  let rows;
  if (file) {
    sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    rows = dedupe(await parseWorkbook(file));
  } else {
    const payload = JSON.parse(readFileSync(jsonIn, 'utf8'));
    sha = payload.source_sha256;
    rows = payload.rows;
    if (!sha || !Array.isArray(rows)) {
      throw new Error('--json payload must be { source_sha256, rows[] }');
    }
  }

  if (emitJson) {
    writeFileSync(emitJson, JSON.stringify({ source_sha256: sha, rows }, null, 1));
    console.log(`wrote ${rows.length} parsed rows → ${emitJson} (sha ${sha.slice(0, 12)}…)`);
    if (!jsonIn && !apply) return; // parse-only invocation
  }

  const sites = await prisma.site.findMany({ select: { id: true, code: true } });
  const siteId = new Map(sites.map((s) => [s.code, s.id]));
  for (const code of new Set(rows.map((r) => r.site_code))) {
    if (!siteId.has(code)) throw new Error(`site code "${code}" not present in sites table`);
  }

  console.log(`source sha256 : ${sha}`);
  console.log(`parsed rows   : ${rows.length}`);
  const bySite = {};
  const byCat = {};
  for (const r of rows) {
    bySite[r.site_code] = (bySite[r.site_code] ?? 0) + 1;
    byCat[r.category] = (byCat[r.category] ?? 0) + 1;
  }
  console.log('by site       :', bySite);
  console.log('by category   :', byCat);
  console.log('inactive      :', rows.filter((r) => !r.is_active).length);

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const r of rows) {
    const site_id = siteId.get(r.site_code);
    const existing = await resolveSeedTarget(prisma, site_id, r.display_name);
    if (existing === MERGED_TARGET_MISSING) {
      console.warn(
        `skip: "${r.display_name}" (${r.site_code}) is merged into a row that is missing`,
      );
      unchanged++;
      continue;
    }

    if (!existing) {
      created++;
      if (!apply) continue;
      await prisma.$transaction(async (tx) => {
        const row = await tx.equipment.create({
          data: {
            site_id,
            display_name: r.display_name,
            category: r.category,
            is_active: r.is_active,
          },
        });
        await tx.auditLog.create({
          data: {
            actor_label: ACTOR_LABEL,
            action: 'insert',
            table_name: 'equipment',
            row_id: row.id,
            before: undefined,
            after: {
              display_name: row.display_name,
              category: row.category,
              is_active: row.is_active,
              site_id: row.site_id,
              source_sha256: sha,
            },
          },
        });
      });
      continue;
    }

    if (existing.category === r.category && existing.is_active === r.is_active) {
      unchanged++;
      continue;
    }

    updated++;
    if (!apply) continue;
    await prisma.$transaction(async (tx) => {
      const row = await tx.equipment.update({
        where: { id: existing.id },
        data: { category: r.category, is_active: r.is_active },
      });
      await tx.auditLog.create({
        data: {
          actor_label: ACTOR_LABEL,
          action: 'update',
          table_name: 'equipment',
          row_id: row.id,
          before: { category: existing.category, is_active: existing.is_active },
          after: {
            category: row.category,
            is_active: row.is_active,
            source_sha256: sha,
          },
        },
      });
    });
  }

  console.log(
    `\n${apply ? 'APPLIED' : 'DRY RUN'} — created ${created}, updated ${updated}, unchanged ${unchanged}`,
  );
  if (!apply) console.log('re-run with --apply to write.');
}

/** Sentinel: the name matched a merged row whose survivor is gone. */
export const MERGED_TARGET_MISSING = Symbol('merged-target-missing');

/**
 * The row this seed should WRITE for a given `(site_id, display_name)` — which is
 * not always the row the name matches.
 *
 * ADR-0075 D5 — THE RESURRECTION TRAP. This seed keys its idempotency on
 * `(site_id, display_name)`, and a merged loser KEEPS its name: nothing here is
 * ever renamed or deleted. So a naive re-run after a merge finds the loser by
 * name and writes `is_active = true` straight back onto it — silently re-splitting
 * the rows an admin just joined and putting the duplicate back in front of every
 * AP approver. That is precisely the failure the 2026-08-04 Terex merge would hit
 * on the next seed run.
 *
 * Following `merged_into_id` to the survivor is what keeps the seed and the merge
 * tool agreeing about which row IS the asset.
 *
 * ONE hop only, deliberately: merging an already-merged row is refused at the API
 * (`winner_merged` / `loser_merged`), so a chain cannot form, and walking further
 * would be inventing a traversal for a state that cannot exist. If the survivor
 * is missing — impossible through the app, since `onDelete: Restrict` forbids
 * deleting it, so it means data damage — the caller SKIPS rather than falling
 * back to the loser and resurrecting it.
 *
 * Exported for the guard test; `prisma` is a parameter so the test injects a
 * stand-in and touches no database.
 */
export async function resolveSeedTarget(prisma, site_id, display_name) {
  const SELECT = { id: true, category: true, is_active: true, merged_into_id: true };
  const matched = await prisma.equipment.findFirst({
    where: { site_id, display_name },
    select: SELECT,
  });
  if (!matched?.merged_into_id) return matched;

  const winner = await prisma.equipment.findUnique({
    where: { id: matched.merged_into_id },
    select: SELECT,
  });
  return winner ?? MERGED_TARGET_MISSING;
}

// Guarded so the test can import `resolveSeedTarget` without the script
// connecting to a database and running the whole seed (pattern from
// `mymrc-processed-bridge-backfill.mjs`).
const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
