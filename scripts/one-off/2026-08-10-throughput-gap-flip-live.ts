// ADR-0088 — flip the throughput-gap watchdog's nudge live at WOODLAND.
//
// EXECUTED ONCE against production on 2026-08-10, at Bill's written instruction
// ("let's flip live the no terex numbers alert please - that should be good to
// go"). The pilot evidence existed and was read: the watchdog's first scheduled
// pass (2026-08-10 08:30 PT, the first working morning after the #222 deploy)
// found Friday 2026-08-07 unrecorded and delivered the pilot-mode nudge 1/1 to
// admins — content and targeting exactly as ADR-0088 D4 designed.
//
// Drives `flipRolloutSurface` — the ONE audited place a surface's pilot↔live
// state changes (ADR-0047), the same function `/admin/rollout` drives — under a
// label rather than a borrowed `users.id`, per the 2026-08-06 terex-ledger
// precedent. NOT a raw UPDATE: ADR-0068 Am.1 §B records the NULL-`flipped_by`
// rows that bypass produced, and this script exists so that never recurs.
//
// WOODLAND ONLY. Eugene has no machine (`resolveSiteThroughputMachine` returns
// null there — ADR-0088 D3 row 4), so its scan can never fire regardless of
// state; its row stays `pilot` as a RECORDED "no" rather than an absent or
// meaningless flip, matching the terex-ledger one-off's reasoning verbatim.
//
// Preconditions verified live before the flip (2026-08-10):
//  - `equipment_entry` @ woodland = live (D3 row 2 — the nudge may not point
//    managers at a form they cannot open; flipped 2026-08-06, O-13).
//  - ledger `equipment_throughput_gap_alerts` carries (woodland, 2026-08-07)
//    with notify_mode='pilot', delivered 1/1 — the instrument demonstrably runs.
//
// RUN: npx tsx scripts/one-off/2026-08-10-throughput-gap-flip-live.ts [--apply]
// (DATABASE_URL exported to the production DB; dry run without --apply.)

import { flipRolloutSurface } from '../../src/lib/notify/flip';
import { prisma } from '../../src/lib/prisma';

const SURFACE = 'equipment_throughput_gap';

const ACTOR_LABEL =
  "system:throughput-gap-flip (ADR-0088, executed by Claude Code at Bill's written instruction 2026-08-10)";

const CRITERIA_NOTE =
  'Pilot evidence read and accepted: first scheduled pass 2026-08-10 08:30 PT found Friday ' +
  '2026-08-07 unrecorded and delivered the pilot nudge 1/1 to admins (ledger row woodland/2026-08-07, ' +
  'notify_mode=pilot). Bill 2026-08-10: "flip live the no terex numbers alert - that should be good ' +
  'to go\". equipment_entry live at Woodland since 2026-08-06 (D3 precondition). Woodland only — ' +
  'Eugene has no machine, its row stays pilot as a recorded no.';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const rows = await prisma.rolloutSurface.findMany({
    where: { surface_code: SURFACE },
    select: { id: true, site_id: true, rollout_state: true, surface_code: true },
  });
  const sites = await prisma.site.findMany({ select: { id: true, code: true } });
  const codeOf = new Map(sites.map((s) => [s.id, s.code]));

  for (const r of rows) {
    console.log(
      `${r.surface_code} @ ${codeOf.get(r.site_id ?? '') ?? r.site_id}: ${r.rollout_state}`,
    );
  }

  const woodland = rows.find((r) => codeOf.get(r.site_id ?? '') === 'woodland');
  if (!woodland) throw new Error('no woodland row for ' + SURFACE);
  if (woodland.rollout_state === 'live') {
    console.log(`${SURFACE}: woodland already live — nothing to do`);
    return;
  }
  if (!apply) {
    console.log(`dry run — would flip ${SURFACE} @ woodland ${woodland.rollout_state} → live`);
    return;
  }
  const updated = await flipRolloutSurface({
    surfaceId: woodland.id,
    toState: 'live',
    criteriaNote: CRITERIA_NOTE,
    actorUserId: '',
    actorLabel: ACTOR_LABEL,
  });
  console.log(`${SURFACE}: woodland → ${updated.rollout_state}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
