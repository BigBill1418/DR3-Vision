#!/usr/bin/env node
// ADR-0098 §4 — ONE-SHOT clearance of the TEREX staged-revision backlog.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Five TEREX.xlsx revisions sat behind the D7 variance guardrail from 08-10.
// The guardrail staged them because it could not verify the change was real;
// ADR-0098 §4 verified it out-of-band (live Graph download byte-identical to the
// newest archived revision, sheet Jul26 col G summing to the workbook's own
// G34 = 222.25 against a 164.20 baseline — July being filled in). This applies
// that decision.
//
// It is NOT a general "apply staged revisions" tool and must not become one.
// The whole point of D7 is that a human decides; this encodes ONE decision that
// a human made against ONE verified set of ids, and refuses to do anything else.
//
// ── Why a script and not the admin UI ───────────────────────────────────────
// The /admin/doc-ingest/anomalies Apply button is the normal path and remains
// so. This runs the same state transitions non-interactively so the verification
// basis — the sha256, the live-Graph byte comparison, the workbook's own totals
// cell — lands IN the audit rows rather than in a chat log. `applyVersion`'s
// own audit row cannot carry that context; these do.
//
// ── Safety ──────────────────────────────────────────────────────────────────
// Dry-run by default; `--apply` to execute. Every id is pinned in EXPECTED
// below along with the content_sha256 it must still carry, and the run ABORTS
// if any precondition fails: wrong sha, not staged, or — the important one —
// the newest revision's ctag no longer matching `doc_sources.ctag`. That last
// check is what makes "this revision IS the live document" true at execution
// time rather than at verification time; if Janette saved the workbook again
// between the two, this refuses and the next sweep stages a fresh revision.
//
// Idempotent: an already-applied or already-discarded row is reported and
// skipped, so a re-run is a near-instant no-op.
//
//   docker exec dr3-vision-app node scripts/terex-staged-backlog-clear.mjs
//   docker exec dr3-vision-app node scripts/terex-staged-backlog-clear.mjs --apply

import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const ACTOR = 'system:terex-staged-backlog-clear-adr0097';

/** The one doc source this script is allowed to touch. */
const SOURCE_ID = '8a0246e7-dbb0-4de2-a90f-ddc5d4b2de4b';

/**
 * The verification basis, recorded verbatim into every audit row so the record
 * says WHY the guardrail was answered, not merely that it was.
 */
const BASIS = {
  adr: 'ADR-0098 §4',
  verified_at_pt: '2026-08-11 ~22:00 PT',
  live_graph_sha256: '0dea4156aac563c7add45e8c8182a63b270c26455c41338b3b62eba88775533d',
  live_graph_bytes: 491583,
  live_graph_ctag: 'c:{58DD7F92-C24C-4AC6-B3A5-1584F4DAE23F},3002',
  method:
    'Downloaded TEREX.xlsx live from Microsoft Graph with the app credentials and compared ' +
    'sha256 against the newest staged revision: byte-identical. All six archived R2 objects ' +
    'hash to their recorded content_sha256.',
  finding:
    'Sheet "Jul26" column G ("Day Total Hrs Used") rows 3-33 (the 31 daily rows) sum to 222.25, ' +
    "which equals the workbook's own totals cell G34. The applied baseline was 164.20. July was " +
    'filled in: monotonic, all 31 days entered, four legitimate zero days. The change is real.',
  outlier:
    'The 5698.4 reading in revision fb8aa241 (08-10 16:40) was the workbook mid-data-entry: day 29 ' +
    "held an End Hours meter value of 2665.95 with Start Hours blank, so the sheet's own " +
    'End-minus-Start formula returned the raw meter reading. Corrected in the file 15 minutes later. ' +
    'Not corruption, not a truncated upload, not a header shift.',
  units_caveat:
    "parse_summary.numericTotals counts each sheet's own totals row as a data row, so every " +
    'SUM-totalled aggregate is exactly 2x the human-readable figure (444.50 = 2 x 222.25; ' +
    '328.40 = 2 x 164.20). This is a known defect recorded in ADR-0098 §4 and deliberately NOT ' +
    'fixed here. It corrupts no business table and changes no staging decision (the doubling is ' +
    'consistent on both sides, so the +35.4% variance is exact either way). Read numericTotals as ' +
    'a change detector, never as a business figure.',
};

/** Pinned ids. `sha` must still match, or the run aborts. */
const EXPECTED = {
  apply: {
    id: '6adeed4b-0d74-43e6-a6a0-633c91d787ea',
    sha: '0dea4156aac563c7add45e8c8182a63b270c26455c41338b3b62eba88775533d',
    observed: '2026-08-12T00:13Z',
  },
  // Earlier states of the SAME file, every one superseded by the revision above.
  // Applying them would materialize stale content into the file-drop inbox.
  discard: [
    { id: 'ae0ec46e-e95d-492d-9dfd-bfaef0d247cb', observed: '2026-08-11T00:49Z' },
    { id: 'ea17871d-2c0a-4013-9ac7-b34083db7ea5', observed: '2026-08-11T00:34Z' },
    { id: 'eb0a6497-e9b0-42d4-a81f-fb36c4cef697', observed: '2026-08-10T16:55Z' },
    { id: 'fb8aa241-4752-449f-a5be-8873ed66c042', observed: '2026-08-10T16:40Z' },
  ],
};

const prisma = new PrismaClient();
const log = (m) => console.log(`[terex-backlog ${new Date().toISOString()}] ${m}`);

function abort(message) {
  throw new Error(`PRECONDITION FAILED — ${message}. Nothing was changed.`);
}

async function main() {
  log(APPLY ? 'mode: APPLY (writes)' : 'mode: DRY RUN (no writes) — pass --apply to execute');

  const source = await prisma.docSource.findUnique({ where: { id: SOURCE_ID } });
  if (!source) abort(`doc source ${SOURCE_ID} not found`);
  log(`source: "${source.display_name}"  ctag=${source.ctag}`);

  // ── Preconditions ────────────────────────────────────────────────────────
  const target = await prisma.docSourceVersion.findUnique({ where: { id: EXPECTED.apply.id } });
  if (!target) abort(`revision ${EXPECTED.apply.id} not found`);
  if (target.content_sha256 !== EXPECTED.apply.sha) {
    abort(
      `revision ${EXPECTED.apply.id} sha is ${target.content_sha256}, expected ${EXPECTED.apply.sha}`,
    );
  }
  if (!target.r2_key) abort(`revision ${EXPECTED.apply.id} has no archived bytes (r2_key is null)`);
  // The check that makes the verification still true NOW: this revision's marker
  // must still be the drive's live marker. If the workbook was saved again since
  // the verification, this is no longer the current document.
  if (target.ctag !== source.ctag) {
    abort(
      `revision ctag ${target.ctag} no longer matches the live source ctag ${source.ctag} — ` +
        `the workbook changed since verification; re-verify against the new revision`,
    );
  }
  log(`precondition OK: sha matches, bytes archived, ctag is the live marker`);

  // ── 1. Apply the newest revision ─────────────────────────────────────────
  if (target.applied_at) {
    log(`SKIP apply: ${target.id} already applied at ${target.applied_at.toISOString()}`);
  } else if (!target.staged) {
    abort(`revision ${target.id} is neither staged nor applied — refusing to guess`);
  } else if (!APPLY) {
    log(`WOULD APPLY  ${target.id} (${EXPECTED.apply.observed})`);
  } else {
    const now = new Date();
    const previous = await prisma.docSourceVersion.findFirst({
      where: { doc_source_id: SOURCE_ID, applied_at: { not: null }, id: { not: target.id } },
      orderBy: { applied_at: 'desc' },
      select: { id: true, ctag: true, content_sha256: true, parse_summary: true, applied_at: true },
    });

    await prisma.$transaction(async (tx) => {
      const drop = await tx.fileDrop.create({
        data: {
          original_filename: source.display_name,
          content_type: source.content_type ?? 'application/octet-stream',
          byte_size: target.size_bytes ?? 0,
          r2_key: target.r2_key,
          status: 'received',
          detected_kind: source.doc_class,
          note: 'Applied from a staged shared-document revision after out-of-band verification (ADR-0098 §4).',
          uploaded_by: ACTOR,
          ingest_source: 'shared_file',
          doc_source_id: SOURCE_ID,
        },
      });
      await tx.docSourceVersion.update({
        where: { id: target.id },
        data: {
          applied_at: now,
          applied_by: ACTOR,
          ingested_at: now,
          staged: false,
          file_drop_id: drop.id,
        },
      });
      await tx.docSource.update({ where: { id: SOURCE_ID }, data: { last_ingested_at: now } });
      await tx.auditLog.create({
        data: {
          actor_label: ACTOR,
          action: 'insert',
          table_name: 'doc_source_versions',
          row_id: target.id,
          before: previous
            ? {
                version_id: previous.id,
                ctag: previous.ctag,
                content_sha256: previous.content_sha256,
                applied_at: previous.applied_at,
                parse_summary: previous.parse_summary,
              }
            : null,
          after: {
            version_id: target.id,
            ctag: target.ctag,
            content_sha256: target.content_sha256,
            r2_key: target.r2_key,
            parse_summary: target.parse_summary,
            file_drop_id: drop.id,
            doc_source_id: SOURCE_ID,
            doc_class: source.doc_class,
            site_id: source.site_id,
            mode: 'system',
            verification_basis: BASIS,
          },
        },
      });
    });
    log(`APPLIED ${target.id}`);
  }

  // ── 2. Discard the superseded intermediates ──────────────────────────────
  for (const { id, observed } of EXPECTED.discard) {
    const v = await prisma.docSourceVersion.findUnique({ where: { id } });
    if (!v) abort(`revision ${id} not found`);
    if (v.doc_source_id !== SOURCE_ID) abort(`revision ${id} does not belong to the TEREX source`);
    if (v.discarded_at) {
      log(`SKIP discard: ${id} already discarded at ${v.discarded_at.toISOString()}`);
      continue;
    }
    if (v.applied_at) abort(`revision ${id} is APPLIED — refusing to discard an applied revision`);
    if (!APPLY) {
      log(`WOULD DISCARD ${id} (${observed})`);
      continue;
    }
    const note =
      `Superseded by ${EXPECTED.apply.id} (${EXPECTED.apply.observed}), which was verified ` +
      `byte-identical to the live Microsoft Graph copy and applied. This is an earlier state of ` +
      `the same workbook; applying it would materialize stale content. ADR-0098 §4.`;
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.docSourceVersion.update({
        where: { id },
        data: { staged: false, discarded_at: now, discarded_by: ACTOR, staged_reason: note },
      });
      await tx.auditLog.create({
        data: {
          actor_label: ACTOR,
          action: 'update',
          table_name: 'doc_source_versions',
          row_id: id,
          before: { staged: v.staged, staged_reason: v.staged_reason },
          after: {
            staged: false,
            discarded_at: now,
            discarded_by: ACTOR,
            note,
            verification_basis: BASIS,
          },
        },
      });
    });
    log(`DISCARDED ${id}`);
  }

  // ── 3. Resolve the anomalies those revisions raised ──────────────────────
  const versionIds = [EXPECTED.apply.id, ...EXPECTED.discard.map((d) => d.id)];
  const tied = await prisma.docIngestAnomaly.findMany({
    where: { doc_source_version_id: { in: versionIds }, status: { in: ['open', 'acknowledged'] } },
    select: { id: true, kind: true },
  });
  for (const row of tied) {
    if (!APPLY) {
      log(`WOULD RESOLVE ${row.kind} (${row.id}) — tied to a now-decided revision`);
      continue;
    }
    await prisma.docIngestAnomaly.update({
      where: { id: row.id },
      data: {
        status: 'resolved',
        resolved_at: new Date(),
        resolved_by: ACTOR,
        resolution_note:
          `Staged revision decided after out-of-band verification against the live Microsoft ` +
          `Graph copy (ADR-0098 §4). The change is real: sheet "Jul26" now sums to 222.25 ` +
          `(the workbook's own G34) against a 164.20 baseline — July filled in. Recorded ` +
          `aggregates are 2x the human-readable figure; see ADR-0098 §4 "units caveat".`,
      },
    });
    log(`RESOLVED ${row.kind} (${row.id})`);
  }
  if (tied.length === 0) log('no open anomalies tied to those revisions');

  // ── 4. Resolve the stale column_nulled parser artifact ───────────────────
  // Not tied to any of the above revisions: it was raised 07-31 against a
  // revision that was applied on 08-06 by a path that did not resolve it.
  const stale = await prisma.docIngestAnomaly.findMany({
    where: {
      doc_source_id: SOURCE_ID,
      kind: 'column_nulled',
      status: { in: ['open', 'acknowledged'] },
    },
    select: { id: true, occurrences: true },
  });
  for (const row of stale) {
    if (!APPLY) {
      log(`WOULD RESOLVE stale column_nulled (${row.id}, occurrences=${row.occurrences})`);
      continue;
    }
    await prisma.docIngestAnomaly.update({
      where: { id: row.id },
      data: {
        status: 'resolved',
        resolved_at: new Date(),
        resolved_by: ACTOR,
        resolution_note:
          `FALSE POSITIVE of our own upgrade (ADR-0098 §5). Column "Estimates for 2025" was never ` +
          `removed — it is in the live workbook at 'Annual Cost'!A1. ADR-0067 Amendment 8 correctly ` +
          `moved header detection from row 1 (three merged section titles) to row 2 (the real ` +
          `headers), taking Annual Cost from 3 pseudo-columns to 21 real ones, and the guardrail ` +
          `compared across the change. The ${row.occurrences} occurrences are that many findings in a ` +
          `SINGLE sweep collapsing onto one fingerprint, not that many events: first_seen_at and ` +
          `last_seen_at are identical to the millisecond and it has never re-fired.`,
      },
    });
    log(`RESOLVED stale column_nulled (${row.id})`);
  }

  log(APPLY ? 'done' : 'dry run complete — re-run with --apply to execute');
}

main()
  .catch((e) => {
    console.error(`[terex-backlog] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
