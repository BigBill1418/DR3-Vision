// ADR-0089 post-recovery verification (2026-08-10) — does the July Woodland COR
// now clear the two gates that blocked it?
//
//   1. assertCorInboundFresh          — delivered-feed freshness (D3 COALESCE key)
//   2. computeCorPrefill (July, EOM)  — derives the filed inventory figure
//   3. assertCorInventoryNotNegative  — the negative-ledger refusal that had the
//                                       filing mechanically blocked since July
//
// READ-ONLY: no table is written; this drives the same functions the COR
// generation service runs, so a PASS here is the service's own arithmetic.
//
// RUN: DATABASE_URL=<prod, via tunnel> npx tsx scripts/one-off/2026-08-10-adr0089-july-cor-verify.ts

import { prisma } from '../../src/lib/prisma';
import { computeCorPrefill } from '../../src/lib/cor/prefill';
import {
  assertCorInboundFresh,
  assertCorInventoryNotNegative,
} from '../../src/lib/cor/inbound-gate';

async function main(): Promise<void> {
  const site = await prisma.site.findFirst({ where: { code: 'woodland' }, select: { id: true } });
  if (!site) throw new Error('woodland site not found');

  try {
    await assertCorInboundFresh();
    console.log('GATE 1 (inbound freshness): PASS');
  } catch (e) {
    console.log('GATE 1 (inbound freshness): REFUSED —', (e as Error).message);
    return;
  }

  const prefill = await computeCorPrefill(site.id, '2026-07-01', 'end_of_month');
  console.log('PREFILL inventoryUnits:', prefill.inventoryUnits);
  console.log('PREFILL inventorySource:', JSON.stringify(prefill.inventorySource));

  try {
    assertCorInventoryNotNegative(prefill.inventoryUnits ?? 0);
    console.log('GATE 2 (non-negative ledger): PASS');
  } catch (e) {
    console.log('GATE 2 (non-negative ledger): REFUSED —', (e as Error).message);
  }
}

main()
  .catch((e) => {
    console.error('probe failed:', e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
