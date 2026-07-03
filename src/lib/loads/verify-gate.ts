// ADR-0037 D2 (Q8; Addendum B7) — the manager verify gate: a load cannot reach
// `verified` unless its program/non-program split reconciles to the total unit
// count.
//
// Investigation 1a finding: on `main` there is NO verify action at all — the
// `submitted → verified` transition exists only as an entry in the load-service
// state table (`ALLOWED_PRIOR`), with no function, route, or UI implementing it,
// and no program/non-program columns. So these columns (D2) ARE the persistence,
// and this module is the server-side enforcement the mission §8 assumed was
// already "shipped." The split doubles as the MRC segregation documentation for
// co-processed volume (Woodland post-Stockton).
//
// Site-driven default (Addendum B7): program-ness is a property of the collection
// SITE, not the commodity. When the manager does not supply an explicit split, the
// DEFAULT derives from the load's source flag — a non-program source defaults all
// units to non-program; a program source defaults all to program. The manager can
// always override. The `program + non_program == total_units` check is unchanged.
//
// `assertProgramSplit` and `defaultProgramSplit` are pure and unit-tested;
// `verifyLoad` applies them inside a transaction that also writes the append-only
// audit row (CLAUDE.md hard rule #6).

import { type LoadStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';

/** Split does not reconcile, or the load cannot be verified from its current state. */
export class VerifyGateError extends Error {
  readonly status: 409 | 422;
  constructor(
    readonly reason:
      | 'split_mismatch'
      | 'missing_total'
      | 'invalid_split'
      | 'wrong_state'
      | 'not_found'
      | 'wrong_site'
      | 'no_source_for_default',
    message: string,
    status: 409 | 422 = 422,
  ) {
    super(message);
    this.name = 'VerifyGateError';
    this.status = status;
  }
}

/**
 * Enforce `program + non_program == total_units`, with both non-negative integers.
 * Throws {@link VerifyGateError} on any violation. Pure — no DB, no clock.
 */
export function assertProgramSplit(
  totalUnits: number | null,
  programUnits: number,
  nonProgramUnits: number,
): void {
  if (totalUnits == null) {
    throw new VerifyGateError(
      'missing_total',
      'cannot verify a load with no total_units — capture the count first',
    );
  }
  const bad = (n: number) => !Number.isInteger(n) || n < 0;
  if (bad(programUnits) || bad(nonProgramUnits) || bad(totalUnits)) {
    throw new VerifyGateError(
      'invalid_split',
      `program/non-program/total must be whole non-negative numbers (got ${programUnits}/${nonProgramUnits}/${totalUnits})`,
    );
  }
  if (programUnits + nonProgramUnits !== totalUnits) {
    throw new VerifyGateError(
      'split_mismatch',
      `program (${programUnits}) + non-program (${nonProgramUnits}) must equal total_units (${totalUnits})`,
    );
  }
}

/**
 * Site-driven DEFAULT split (Addendum B7): a non-program source puts all units in
 * the non-program pool; a program source puts all in the program pool. Pure.
 */
export function defaultProgramSplit(
  totalUnits: number,
  sourceIsNonProgram: boolean,
): { programUnits: number; nonProgramUnits: number } {
  return sourceIsNonProgram
    ? { programUnits: 0, nonProgramUnits: totalUnits }
    : { programUnits: totalUnits, nonProgramUnits: 0 };
}

/** Statuses from which a manager verify is legal (the operator has submitted). */
const VERIFIABLE_FROM: readonly LoadStatus[] = ['submitted'] as const;

/**
 * Verify a submitted inbound load: enforce the program split server-side, set the
 * split columns, transition `submitted → verified`, and write the audit row — all
 * in one transaction. Site-scoped (caller already passed the manager/site guard;
 * this re-checks the load belongs to `siteId` as defence in depth).
 *
 * If `programUnits`/`nonProgramUnits` are omitted, the split defaults from the
 * load's source `is_non_program` flag (Addendum B7); a manager-supplied split
 * overrides it. Either way the `program + non_program == total_units` check holds.
 */
export async function verifyLoad(args: {
  loadId: string;
  siteId: string;
  verifierUserId: string;
  programUnits?: number | undefined;
  nonProgramUnits?: number | undefined;
}): Promise<void> {
  const load = await prisma.inboundLoad.findUnique({
    where: { id: args.loadId },
    select: {
      id: true,
      site_id: true,
      status: true,
      total_units: true,
      source: { select: { is_non_program: true } },
    },
  });
  if (!load) throw new VerifyGateError('not_found', `load ${args.loadId} not found`, 422);
  if (load.site_id !== args.siteId) {
    throw new VerifyGateError('wrong_site', 'load is not at this site', 422);
  }
  if (!VERIFIABLE_FROM.includes(load.status)) {
    throw new VerifyGateError(
      'wrong_state',
      `load in status ${load.status} cannot be verified (must be submitted)`,
      409,
    );
  }

  // Manager override wins; otherwise default from the source flag (B7).
  let programUnits = args.programUnits;
  let nonProgramUnits = args.nonProgramUnits;
  if (programUnits === undefined && nonProgramUnits === undefined) {
    if (load.total_units == null) {
      throw new VerifyGateError('missing_total', 'cannot default the split with no total_units — capture the count first');
    }
    // Billing pool attribution must NEVER default blind. If the load has no source,
    // there is no basis to decide program vs non-program — refuse loudly (422) and
    // require the manager to supply an explicit split rather than silently crediting
    // the whole load to the program (billed) pool.
    if (!load.source) {
      throw new VerifyGateError(
        'no_source_for_default',
        `load ${args.loadId} has no source — cannot default the program split blind; supply an explicit program/non-program split`,
        422,
      );
    }
    const def = defaultProgramSplit(load.total_units, load.source.is_non_program);
    programUnits = def.programUnits;
    nonProgramUnits = def.nonProgramUnits;
    log.info(
      {
        loadId: args.loadId,
        siteId: args.siteId,
        defaulted: true,
        source_is_non_program: load.source.is_non_program,
        programUnits,
        nonProgramUnits,
      },
      '[verify-gate] program split defaulted from source flag',
    );
  } else if (programUnits === undefined || nonProgramUnits === undefined) {
    throw new VerifyGateError('invalid_split', 'supply BOTH program and non-program units, or neither (to default from source)');
  }

  assertProgramSplit(load.total_units, programUnits, nonProgramUnits);

  await prisma.$transaction(async (tx) => {
    await tx.inboundLoad.update({
      where: { id: args.loadId },
      data: {
        status: 'verified',
        program_unit_count: programUnits,
        non_program_unit_count: nonProgramUnits,
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.verifierUserId,
        action: 'update',
        table_name: 'inbound_loads',
        row_id: args.loadId,
        before: { status: load.status },
        after: {
          status: 'verified',
          program_unit_count: programUnits,
          non_program_unit_count: nonProgramUnits,
        },
      },
    });
  });
}
