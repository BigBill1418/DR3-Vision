// BX-12 (ADR-0137) — the ONE place any surface learns which equipment row is a
// site's throughput machine. Designated in `site_throughput_machines`, never
// inferred.
//
// What this replaced: "the OLDEST active `terex`-category row at the site that
// has ANY invoice link" (ADR-0077's evidence proxy). The ADR-0062 seed files the
// shear machines under `terex`, `EQ24 — Shear Machine` is older than `Terex`, and
// the moment EQ24 got its first invoice (2026-09-02 6:21 AM PDT) the daily form,
// the gap watchdog, the trend, the EOD review and the machine label all switched
// to the shear — silently, for three weeks. A proxy that any unrelated invoice can
// flip is not an identity.
//
// Three states, and they are never collapsed:
//   * designated row      → `{ id, displayName }`
//   * designated NONE     → `null` (a decision: Eugene has no such machine)
//   * NOT CONFIGURED, or the designated row is merged / inactive / at another
//     site → THROWS `ThroughputMachineNotConfiguredError`. Never a guess: a guess
//     is exactly how three weeks of Terex readings went onto a shear.

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export interface SiteThroughputMachine {
  id: string;
  displayName: string;
}

/**
 * The site's throughput machine is not usable as configured. `status` makes the
 * equipment route mapper answer 503 with this message instead of a bare 500, so
 * the form says what is wrong; the gap watchdog pages `dr3-vision-system` on it.
 */
export class ThroughputMachineNotConfiguredError extends Error {
  readonly status = 503;
  constructor(
    readonly siteId: string,
    readonly detail: string,
  ) {
    super(
      `throughput_machine_not_configured: ${detail} (site ${siteId}). ` +
        'An admin must designate this site’s throughput machine (site_throughput_machines, ADR-0137).',
    );
    this.name = 'ThroughputMachineNotConfiguredError';
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function resolveSiteThroughputMachine(
  siteId: string,
  db: Db = prisma,
): Promise<SiteThroughputMachine | null> {
  const designation = await db.siteThroughputMachine.findUnique({
    where: { site_id: siteId },
    select: { equipment_id: true },
  });
  if (!designation) {
    throw new ThroughputMachineNotConfiguredError(siteId, 'no designation for this site');
  }
  if (designation.equipment_id === null) return null;

  const machine = await db.equipment.findUnique({
    where: { id: designation.equipment_id },
    select: {
      id: true,
      display_name: true,
      site_id: true,
      is_active: true,
      merged_into_id: true,
    },
  });
  // The designation outliving its row's eligibility is a configuration fault,
  // not a reason to fall back to some other row.
  if (!machine || machine.site_id !== siteId || !machine.is_active || machine.merged_into_id) {
    throw new ThroughputMachineNotConfiguredError(
      siteId,
      `designated equipment ${designation.equipment_id} is not a live machine at this site`,
    );
  }
  return { id: machine.id, displayName: machine.display_name };
}
