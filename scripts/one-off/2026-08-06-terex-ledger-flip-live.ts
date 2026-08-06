// ADR-0077 / OPEN-ITEMS O-14 — flip the Terex machine ledger live at WOODLAND.
//
// EXECUTED ONCE against production on 2026-08-06, at Bill's written instruction
// ("you need to classify and accept everything — build done? check it all"),
// after O-12's acceptance landed: 80 confirmed rows, $77,067.94 / $4,025.36.
//
// Drives `flipRolloutSurface` — the ONE audited place a surface's pilot↔live
// state changes (ADR-0047), the same function `/admin/rollout` drives — under a
// label rather than a borrowed `users.id`. `flipped_by` is a bare string column,
// so the label lands there and the audit row carries `actor_label`.
//
// WOODLAND ONLY. Bill, 2026-08-06: "the terex machine operates exclusively at
// woodland — eugene has no use or need for this data at all." Eugene's row stays
// `pilot`, which is a RECORDED "no" rather than an absent row: an unregistered
// surface resolves to admin-only through a caught exception, and a deliberate
// decision should not look like a swallowed error.
//
// RUN: npx tsx scripts/one-off/2026-08-06-terex-ledger-flip-live.ts [--apply]

import { flipRolloutSurface } from '../../src/lib/notify/flip';
import { prisma } from '../../src/lib/prisma';

const SURFACE = 'equipment_terex_ledger';

const ACTOR_LABEL =
  "system:terex-ledger-flip (ADR-0077 O-14, executed by Claude Code at Bill's written instruction 2026-08-06)";

const CRITERIA_NOTE =
  'O-12 accepted: 80 confirmed maintenance rows, $77,067.94 repair / $4,025.36 credited, ' +
  'matching ADR-0069 Am.2 to the cent (three superseded revisions discarded, ledger version-scoped). ' +
  'AP ledger live: 4 invoices, 202,492 cents on the canonical Terex. Downtime honestly "not recorded". ' +
  'Woodland only — Bill: the Terex operates exclusively at Woodland.';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const rows = await prisma.rolloutSurface.findMany({
    where: { surface_code: SURFACE },
    select: { id: true, site_id: true, rollout_state: true },
  });
  const sites = await prisma.site.findMany({ select: { id: true, code: true } });
  const codeOf = new Map(sites.map((s) => [s.id, s.code]));

  for (const r of rows) {
    console.log(`${codeOf.get(r.site_id ?? '') ?? r.site_id}: ${r.rollout_state}`);
  }

  const woodland = rows.find((r) => codeOf.get(r.site_id ?? '') === 'woodland');
  if (!woodland) throw new Error('no woodland row for ' + SURFACE);

  if (!apply) {
    console.log(`dry run — would flip woodland ${woodland.rollout_state} → live`);
    return;
  }
  if (woodland.rollout_state === 'live') {
    console.log('woodland already live — nothing to do');
    return;
  }

  const updated = await flipRolloutSurface({
    surfaceId: woodland.id,
    toState: 'live',
    criteriaNote: CRITERIA_NOTE,
    actorUserId: '',
    actorLabel: ACTOR_LABEL,
  });
  console.log(`woodland → ${updated.rollout_state}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
