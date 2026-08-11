#!/usr/bin/env node
// ADR-0092 — flip the stale-claim watchdog's nudge LIVE at both sites.
//
// EXECUTED ONCE against production on 2026-08-11, at Bill's written instruction.
// He received the pilot-mode nudge:
//
//   "[PILOT — would have sent to: morena.gomez@svdp.us, janette.tomas@svdp.us]
//    DR3-Vision — DR3 Woodland: 1 load still open on the dock"
//
// and replied: "flip these to live now! we need these."
//
// That is the ADR-0047 ramp working exactly as designed: the pilot send showed
// him the CONTENT and the TARGETING before either reached a site manager, and
// the flip is his decision on the evidence rather than an assumption in a deploy.
//
// ── Why .mjs and not .ts like the two precedents ─────────────────────────────
//
// `2026-08-10-throughput-gap-flip-live.ts` was run with `npx tsx` from a machine
// that had the repo, its devDependencies, and network reach to the production
// database. Neither half of that holds here: `dr3-vision-postgres` publishes no
// host port (`{"5432/tcp":null}` — it is reachable only on the `dr3net` compose
// network), and the app image is a Next standalone build with a trimmed
// `node_modules` that carries no `tsx`.
//
// So this runs INSIDE the app container, where `@prisma/client` and DATABASE_URL
// both already exist — the same trade every daemon in `scripts/` makes, for the
// same reason. It is one file, and it is the file that ran.
//
// ── Why it re-states flipRolloutSurface instead of importing it ──────────────
//
// It cannot import it: `src/lib/notify/flip.ts` is TypeScript, compiled into the
// Next server chunks and not reachable as a module. So the behaviour is
// reproduced here field-for-field, and the reproduction is deliberately explicit
// about the ONE thing that must not be dropped.
//
// ADR-0068 Am.1 §B records rows with a NULL `flipped_by` produced by raw UPDATEs
// that bypassed the function. That is the defect to avoid — not the bypass
// itself, which is unavoidable here, but the missing attribution it caused. This
// script therefore writes ALL FOUR of the columns the function writes
// (`rollout_state`, `flipped_by`, `flipped_at`, `criteria_note`) plus the audit
// row, and refuses to run if the criteria note is too short, exactly as
// `CRITERIA_NOTE_MIN_LENGTH` does.
//
// ── actorLabel, not a borrowed users.id ──────────────────────────────────────
//
// `flipRolloutSurface` takes `actorLabel` INSTEAD of a real `users.id` for a
// named non-human flip: the label lands in `flipped_by` and the audit row
// carries `actor_label` with `actor_user_id` NULL. That path is used here for
// the reason the 2026-08-06 terex-ledger and 2026-08-10 throughput-gap one-offs
// used it: the only `admin` in this database is Bill, and attributing the
// keystrokes to his user id would put a false statement in an append-only table.
// He DIRECTED this flip; he did not perform it, and the record should say so.
//
// ── Scope: BOTH sites, and why Eugene is included ────────────────────────────
//
// The throughput-gap one-off flipped Woodland only and left Eugene `pilot` as a
// recorded "no", because Eugene has no Terex — its scan can NEVER fire, so a
// flip there would be meaningless. That reasoning does not carry over.
//
// Eugene's `ipad_queue` is LIVE, so it is structurally capable of producing a
// stranded load the moment floor work starts there. It has none today (zero
// `inbound_loads` rows at Eugene, ever — verified 2026-08-11), so this flip
// cannot send Rick Albritton a single email until Eugene actually has dock work.
// Leaving it `pilot` would instead re-create the exact silent-gap class ADR-0092
// exists to close, on the day Eugene's first load is stranded.
//
// RUN (inside the app container on CHAD-HQ):
//   docker exec dr3-vision-app node scripts/one-off/2026-08-11-stale-claim-flip-live.mjs [--apply]
// Dry run without --apply.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SURFACE = 'load_stale_claim';
const CRITERIA_NOTE_MIN_LENGTH = 3;

const ACTOR_LABEL =
  "system:stale-claim-flip (ADR-0092, executed by Claude Code at Bill's written instruction 2026-08-11)";

const CRITERIA_NOTE =
  'Pilot evidence read and accepted by Bill. First live-code scan 2026-08-11 12:32 PM PT found ' +
  'H-136147 (Kiefer Landfill, held by Janette Tomas at `arrived`, 277 minutes silent) and delivered ' +
  'the pilot nudge 1/1 to admins; a second fire one minute later returned skipped_none with the ' +
  'ledger unchanged, demonstrating the one-report-per-load guarantee. Bill 2026-08-11, on receiving ' +
  'the pilot mail: "flip these to live now! we need these." Recipients verified against ' +
  'alert_recipients before the flip: Woodland = morena.gomez@svdp.us + janette.tomas@svdp.us ' +
  '(both active, matching the addresses in the pilot header Bill quoted); Eugene = ' +
  'rick.albritton@svdp.us. Both sites flipped: Eugene ipad_queue is live so it is capable of ' +
  'stranding a load, and it has zero inbound_loads today so the flip cannot mail anyone yet.';

async function main() {
  const apply = process.argv.includes('--apply');
  if (CRITERIA_NOTE.trim().length < CRITERIA_NOTE_MIN_LENGTH) {
    throw new Error('criteria_note_required');
  }

  const rows = await prisma.rolloutSurface.findMany({
    where: { surface_code: SURFACE },
    select: {
      id: true,
      site_id: true,
      surface_code: true,
      kind: true,
      rollout_state: true,
      flipped_by: true,
    },
  });

  const sites = Object.fromEntries(
    (await prisma.site.findMany({ select: { id: true, code: true } })).map((s) => [s.id, s.code]),
  );

  console.log(`\n=== ${SURFACE} — BEFORE ===`);
  for (const r of rows) {
    console.log(
      `  ${sites[r.site_id] ?? r.site_id}: ${r.rollout_state}  flipped_by=${r.flipped_by ?? '(null)'}  id=${r.id}`,
    );
  }

  if (!apply) {
    console.log('\nDRY RUN — pass --apply to flip. Nothing was written.\n');
    return;
  }

  for (const before of rows) {
    if (before.rollout_state === 'live') {
      console.log(`  ${sites[before.site_id]}: already live — skipped (idempotent).`);
      continue;
    }

    const updated = await prisma.rolloutSurface.update({
      where: { id: before.id },
      data: {
        rollout_state: 'live',
        // The label lands in `flipped_by` — the column is a bare string, and a
        // NULL here is the ADR-0068 Am.1 §B defect this script exists to avoid.
        flipped_by: ACTOR_LABEL,
        flipped_at: new Date(),
        criteria_note: CRITERIA_NOTE,
      },
    });

    await prisma.auditLog.create({
      data: {
        // A named non-human actor: label set, user id NULL. Never Bill's id.
        actor_user_id: null,
        actor_label: ACTOR_LABEL,
        action: 'update',
        table_name: 'rollout_surfaces',
        row_id: before.id,
        before: {
          surface_code: before.surface_code,
          site_id: before.site_id,
          rollout_state: before.rollout_state,
        },
        after: { rollout_state: updated.rollout_state, criteria_note: CRITERIA_NOTE },
        ip: null,
        user_agent: null,
      },
    });

    console.log(
      `  ${sites[before.site_id]}: ${before.rollout_state} -> ${updated.rollout_state} ✓`,
    );
  }

  const after = await prisma.rolloutSurface.findMany({
    where: { surface_code: SURFACE },
    select: { site_id: true, rollout_state: true, flipped_by: true, flipped_at: true },
  });
  console.log(`\n=== ${SURFACE} — AFTER ===`);
  for (const r of after) {
    console.log(
      `  ${sites[r.site_id] ?? r.site_id}: ${r.rollout_state}  flipped_by=${r.flipped_by}  at=${r.flipped_at?.toISOString()}`,
    );
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error('stale-claim flip FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
