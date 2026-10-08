#!/usr/bin/env node
// ADR-0141 — flip the team-submitted invoice path LIVE at both sites.
//
// EXECUTED ONCE against production on 2026-10-08, at Bill's written instruction:
//   "no not pilot go live and make sure this is ready to go"  (2026-10-08 13:54 PDT)
//
// Two surfaces per site, flipped together (ADR-0141 §rollout):
//   ap_team_submit  (ui)           — the manager submit screen + its API
//   ap_team_outcome (notification) — the decision/hold mail to the picked accountant
// Flipping only the first would let managers submit while accountant mail still
// diverted to admins, so this script refuses to leave them split.
//
// Same shape as 2026-08-11-stale-claim-flip-live.mjs (read its header for why this
// is .mjs run inside the app container, and why it re-states flipRolloutSurface):
// writes all four columns flipRolloutSurface writes plus the audit row, attributed
// to a named non-human actor label rather than Bill's users.id.
//
// RUN (inside the app container on CHAD-HQ):
//   docker exec dr3-vision-app node /tmp/2026-10-08-ap-team-submit-flip-live.mjs [--apply]
// Dry run without --apply.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SURFACES = ['ap_team_submit', 'ap_team_outcome'];
const CRITERIA_NOTE_MIN_LENGTH = 3;

const ACTOR_LABEL =
  "system:ap-team-submit-flip (ADR-0141, executed by Claude Code at Bill's written instruction 2026-10-08)";

const CRITERIA_NOTE =
  'ADR-0141 go-live. Shipped in PR #298 (d887495), deployed 2026-10-08 10:29 PDT; migration ' +
  '20260869_adr0141_ap_team_submit applied; accounting contacts seeded and active (Gloria Salpino, ' +
  'Mary Scott, Yvonne Stephens). Bill 2026-10-08 13:54 PDT: "no not pilot go live and make sure ' +
  'this is ready to go". Both surfaces flipped together at both sites so submit and accountant ' +
  'mail never diverge.';

async function main() {
  const apply = process.argv.includes('--apply');
  if (CRITERIA_NOTE.trim().length < CRITERIA_NOTE_MIN_LENGTH)
    throw new Error('criteria_note_required');

  const sites = Object.fromEntries(
    (await prisma.site.findMany({ select: { id: true, code: true } })).map((s) => [s.id, s.code]),
  );
  const rows = await prisma.rolloutSurface.findMany({
    where: { surface_code: { in: SURFACES } },
    select: { id: true, site_id: true, surface_code: true, rollout_state: true },
  });
  if (rows.length !== SURFACES.length * Object.keys(sites).length) {
    throw new Error(`expected ${SURFACES.length} surfaces per site, found ${rows.length} rows`);
  }

  console.log('\n=== BEFORE ===');
  for (const r of rows) console.log(`  ${sites[r.site_id]} ${r.surface_code}: ${r.rollout_state}`);
  if (!apply) {
    console.log('\nDRY RUN — pass --apply to flip. Nothing was written.\n');
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const before of rows) {
      if (before.rollout_state === 'live') continue;
      const updated = await tx.rolloutSurface.update({
        where: { id: before.id },
        data: {
          rollout_state: 'live',
          flipped_by: ACTOR_LABEL,
          flipped_at: new Date(),
          criteria_note: CRITERIA_NOTE,
        },
      });
      await tx.auditLog.create({
        data: {
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
    }
  });

  const after = await prisma.rolloutSurface.findMany({
    where: { surface_code: { in: SURFACES } },
    select: { site_id: true, surface_code: true, rollout_state: true, flipped_at: true },
  });
  console.log('\n=== AFTER ===');
  for (const r of after) {
    console.log(
      `  ${sites[r.site_id]} ${r.surface_code}: ${r.rollout_state}  at=${r.flipped_at?.toISOString()}`,
    );
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error('ap-team-submit flip FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
