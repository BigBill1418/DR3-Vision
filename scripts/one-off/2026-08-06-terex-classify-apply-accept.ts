// ADR-0077 D5/D9 — one-off: register the TEREX workbook and accept its first batch.
//
// EXECUTED ONCE against production on 2026-08-06, at Bill's explicit written
// instruction ("you need to classify and accept everything"). Retained because it
// IS the record of what ran, in what order, under what actor, with what hard stop.
//
// WHY A SCRIPT. Every step below has an admin button. Bill ordered them executed;
// `requireAdmin()` / `checkAdmin()` are the HTTP gates on those buttons and his
// written order is the authorisation. So this drives the SAME audited service
// functions the buttons drive — `confirmClassification`, `applyVersion`,
// `decideTerexBatch` — never hand-written SQL, which would skip the class-already-
// registered guard, the archive-missing anomaly, the totals capture and the audit
// rows.
//
// WHO IT SAYS DID IT. A label, never a borrowed `users.id`: `classified_by`,
// `applied_by` and `confirmed_by` are all bare string columns, so the label lands
// in each and the audit rows carry `actor_label` with `actor_user_id` NULL.
//
// THE HARD STOP is the point of the whole script. `Maintenance Log 2025` is a
// strict SUBSET of `Maintenance Log2026` and both sheets report the same totals,
// so an absorption that failed to de-duplicate reports $154,135.88 — exactly
// double. This refuses to accept anything unless the staged batch reads
// 77067.94 / 4025.36 to the cent. A wrong number here becomes accepted money.
//
// RUN (through an SSH tunnel to the prod Postgres; absorption itself runs INSIDE
// the cluster because it needs R2 credentials this workstation does not have):
//   npx tsx scripts/one-off/2026-08-06-terex-classify-apply-accept.ts <step>
// where <step> is `classify`, `apply`, `check` or `accept`. Steps are separate on
// purpose: `check` is read-only and must be run, and seen, before `accept`.

import { confirmClassification } from '../../src/lib/doc-ingest/classification';
import { applyVersion } from '../../src/lib/doc-ingest/ingest';
import { decideTerexBatch } from '../../src/lib/doc-ingest/terex-decide';
import { prisma } from '../../src/lib/prisma';

const SOURCE_ID = '8a0246e7-dbb0-4de2-a90f-ddc5d4b2de4b'; // TEREX.xlsx
const VERSION_ID = 'eed9d4cb-03c1-47cf-8ea6-081995fac4c4'; // the staged revision
const WOODLAND_ID = 'de9875a3-a09f-484f-aed1-2891ef544b87';

/**
 * Bill, 2026-08-06: "the terex machine operates exclusively at woodland — eugene
 * has no use or need for this data at all", then "you need to classify and accept
 * everything". Those two settle the site and the authority respectively; neither
 * was inferred here.
 */
const ACTOR_LABEL =
  "system:terex-absorption (ADR-0077, executed by Claude Code at Bill's written instruction 2026-08-06)";

/** The ADR-0069 Am.2 figures. Not a target — a refusal threshold. */
const EXPECT_REPAIR = 77067.94;
const EXPECT_CREDITED = 4025.36;

function fail(message: string): never {
  console.error(`\nHARD STOP — ${message}`);
  process.exit(1);
}

/** Cent-exact comparison without trusting float equality. */
function centsEqual(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

async function stagedTotals(): Promise<{ rows: number; repair: number; credited: number }> {
  const rows = await prisma.docTerexMaintenanceRow.findMany({
    where: { doc_source_version_id: VERSION_ID, status: 'staged' },
    select: { actual_repair_cost: true, amount_credited: true },
  });
  return {
    rows: rows.length,
    repair: rows.reduce((a, r) => a + Number(r.actual_repair_cost ?? 0), 0),
    credited: rows.reduce((a, r) => a + Number(r.amount_credited ?? 0), 0),
  };
}

async function classify(): Promise<void> {
  const source = await prisma.docSource.findUniqueOrThrow({ where: { id: SOURCE_ID } });
  if (source.doc_class !== null) {
    console.log(`already registered as "${source.doc_class}" — nothing to do`);
    return;
  }
  const updated = await confirmClassification(prisma, {
    sourceId: SOURCE_ID,
    kind: 'terex_maintenance_log',
    siteId: WOODLAND_ID,
    period: null,
    actorUserId: '',
    actorLabel: ACTOR_LABEL,
  });
  console.log(`classified: doc_class=${updated.doc_class} site_id=${updated.site_id}`);
}

async function apply(): Promise<void> {
  const source = await prisma.docSource.findUniqueOrThrow({ where: { id: SOURCE_ID } });
  const version = await prisma.docSourceVersion.findUniqueOrThrow({ where: { id: VERSION_ID } });
  if (!version.staged) {
    console.log(`version already applied at ${String(version.applied_at)} — nothing to do`);
    return;
  }
  await applyVersion(
    prisma,
    source,
    version,
    version.size_bytes ?? 0,
    ACTOR_LABEL,
    new Date(),
    'system',
  );
  const after = await prisma.docSourceVersion.findUniqueOrThrow({ where: { id: VERSION_ID } });
  console.log(`applied: staged=${after.staged} applied_at=${String(after.applied_at)}`);
}

/** READ-ONLY. Must be run, and read, before `accept`. */
async function check(): Promise<void> {
  const t = await stagedTotals();
  console.log(`staged rows: ${t.rows}`);
  console.log(`staged repair:   ${t.repair.toFixed(2)}  (expect ${EXPECT_REPAIR.toFixed(2)})`);
  console.log(`staged credited: ${t.credited.toFixed(2)}  (expect ${EXPECT_CREDITED.toFixed(2)})`);
  if (centsEqual(t.repair, EXPECT_REPAIR * 2)) {
    fail('repair total is EXACTLY DOUBLE — the subset sheet was absorbed twice (ADR-0069 Am.2)');
  }
  if (!centsEqual(t.repair, EXPECT_REPAIR) || !centsEqual(t.credited, EXPECT_CREDITED)) {
    fail('staged totals do not match the ADR-0069 Am.2 figures — accept NOTHING, report instead');
  }
  console.log('OK — totals match to the cent. Safe to accept.');
}

async function accept(): Promise<void> {
  // Re-check inside the accepting step: `check` may have been run against a
  // different absorption pass, and this is the write that makes money real.
  const t = await stagedTotals();
  if (t.rows === 0) fail('nothing staged to accept');
  if (!centsEqual(t.repair, EXPECT_REPAIR) || !centsEqual(t.credited, EXPECT_CREDITED)) {
    fail(
      `staged totals moved since the check (${t.repair.toFixed(2)} / ${t.credited.toFixed(2)}) — refusing`,
    );
  }

  const res = await decideTerexBatch('confirm', {
    versionId: VERSION_ID,
    actor: { label: ACTOR_LABEL },
  });
  if (!res.ok) fail(`accept refused: ${res.reason}`);
  console.log(`confirmed ${res.rows} rows`);
  console.log(`totals accepted: ${JSON.stringify(res.totals)}`);

  const confirmed = await prisma.docTerexMaintenanceRow.findMany({
    where: { doc_source_version_id: VERSION_ID, status: 'confirmed' },
    select: { actual_repair_cost: true, amount_credited: true },
  });
  const repair = confirmed.reduce((a, r) => a + Number(r.actual_repair_cost ?? 0), 0);
  const credited = confirmed.reduce((a, r) => a + Number(r.amount_credited ?? 0), 0);
  console.log(`confirmed sums: repair=${repair.toFixed(2)} credited=${credited.toFixed(2)}`);
  if (!centsEqual(repair, EXPECT_REPAIR) || !centsEqual(credited, EXPECT_CREDITED)) {
    fail('POST-ACCEPT MISMATCH — confirmed sums do not match what was accepted');
  }
  console.log('verified: confirmed sums match the accepted totals to the cent');
}

/**
 * Discard the SUPERSEDED revisions' staged rows.
 *
 * Found on the live run and the reason the check step exists. Registering the
 * source made every APPLIED revision absorbable at once, so the backlog sweep
 * absorbed all three (ctags …2977 / …2978 / …2979) — 3 × 80 rows, 3 × $77,067.94.
 * Each version's own total is exactly right; the de-duplication ADR-0069 Am.2
 * describes is WITHIN a version (the 2025 sheet is a subset of the 2026 sheet)
 * and was never meant to reach across revisions of the same document.
 *
 * Only the newest revision is the document. The older two are discarded — not
 * deleted — through the same audited decision path as an accept, so the record
 * shows a decision was taken and what it was worth.
 */
const SUPERSEDED = [
  '76dc0bef-a074-491a-8573-00a1d5ad6543', // ctag …2977
  'f1c2d68d-abb8-4175-9936-cb8b73a29b02', // ctag …2978
] as const;

async function supersede(): Promise<void> {
  for (const versionId of SUPERSEDED) {
    const res = await decideTerexBatch('discard', {
      versionId,
      actor: { label: ACTOR_LABEL },
      reason:
        `Superseded revision. Registering the source made all three applied revisions absorbable ` +
        `at once; only the newest (${VERSION_ID}) is the current document. Discarded so the ` +
        `ledger reads one copy of the maintenance log, not three.`,
    });
    if (!res.ok) {
      console.log(`${versionId}: ${res.reason} (nothing to do)`);
      continue;
    }
    console.log(`${versionId}: discarded ${res.rows} rows worth ${JSON.stringify(res.totals)}`);
  }
}

const STEPS: Record<string, () => Promise<void>> = { classify, apply, check, supersede, accept };

async function main(): Promise<void> {
  const step = process.argv[2] ?? '';
  const fn = STEPS[step];
  if (!fn) fail(`unknown step "${step}" — one of: ${Object.keys(STEPS).join(', ')}`);
  await fn();
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
