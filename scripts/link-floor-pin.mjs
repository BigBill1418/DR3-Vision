#!/usr/bin/env node
// ADR-0072 Amendment 2 — link (or unlink) a manager account to the SAME person's
// operator account, so they can approve held counts on the iPad with their floor PIN.
//
// Admin-only: `--actor` must be an ACTIVE admin's user id; it is recorded as the
// audit actor. Accounts are named by exact user id, never by name — two people can
// share a name, and a wrong link hands one person's PIN authority to another.
//
// It refuses (exit 2) when: the actor is not an active admin; the manager account is
// not an active manager/admin; the operator account is not an active operator with a
// PIN and a primary site; a MANAGER is at a different primary site than the operator
// (an admin has no site and may link to an operator at any); the operator is already
// linked from another account; or the manager is already linked to a different
// operator (clear it first). Linking an existing link is a no-op.
//
// Dry run by default. `--apply` writes the link and its audit row in ONE transaction,
// guarded so a concurrent change is refused rather than overwritten.
//
// Usage (inside the app container, after the ADR-0072 Am.2 migration is deployed):
//   docker exec dr3-vision-app node scripts/link-floor-pin.mjs \
//     --actor=<admin-user-id> --manager=<manager-user-id> --operator=<operator-user-id> [--apply]
//   docker exec dr3-vision-app node scripts/link-floor-pin.mjs \
//     --actor=<admin-user-id> --manager=<manager-user-id> --clear [--apply]
// Output carries ids, names, roles and site ids only. No PIN material is read out.

import { PrismaClient } from '@prisma/client';

export const ACTOR_LABEL = 'system:link-floor-pin-cli';

export class LinkRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinkRefused';
  }
}

/** Parse argv. Pure. */
export function parseArgs(argv) {
  const opts = { apply: false, clear: false, actor: '', manager: '', operator: '' };
  for (const a of argv) {
    if (a === '--apply') opts.apply = true;
    else if (a === '--clear') opts.clear = true;
    else if (a.startsWith('--actor=')) opts.actor = a.slice(8);
    else if (a.startsWith('--manager=')) opts.manager = a.slice(10);
    else if (a.startsWith('--operator=')) opts.operator = a.slice(11);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.actor) throw new Error('--actor=<admin-user-id> is required');
  if (!opts.manager) throw new Error('--manager=<manager-user-id> is required');
  if (opts.clear === Boolean(opts.operator)) {
    throw new Error('pass exactly one of --operator=<operator-user-id> or --clear');
  }
  if (opts.operator && opts.operator === opts.manager) {
    throw new Error('--manager and --operator must be different accounts');
  }
  return opts;
}

const USER_FIELDS = {
  id: true,
  name: true,
  role: true,
  is_active: true,
  primary_site_id: true,
  floor_user_id: true,
};

function describe(u) {
  return { id: u.id, name: u.name, role: u.role, site: u.primary_site_id };
}

/**
 * Plan and (with opts.apply) write the link. Throws LinkRefused on any refusal.
 * `prisma` is injectable for tests.
 */
export async function linkFloorPin(prisma, opts) {
  const actor = await prisma.user.findUnique({
    where: { id: opts.actor },
    select: { id: true, role: true, is_active: true },
  });
  if (!actor || actor.role !== 'admin' || !actor.is_active) {
    throw new LinkRefused('actor is not an active admin');
  }

  const manager = await prisma.user.findUnique({
    where: { id: opts.manager },
    select: USER_FIELDS,
  });
  if (!manager || !manager.is_active || !['manager', 'admin'].includes(manager.role)) {
    throw new LinkRefused('manager account is not an active manager or admin');
  }

  if (opts.clear) {
    const before = manager.floor_user_id;
    if (!before) return { action: 'none', reason: 'not linked', manager: describe(manager) };
    if (opts.apply) {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.user.updateMany({
          where: { id: manager.id, floor_user_id: before },
          data: { floor_user_id: null },
        });
        if (count === 0) throw new LinkRefused('link changed concurrently; re-run');
        await tx.auditLog.create({
          data: {
            actor_user_id: actor.id,
            actor_label: ACTOR_LABEL,
            action: 'update',
            table_name: 'users',
            row_id: manager.id,
            before: { floor_user_id: before },
            after: { floor_user_id: null, adr: 'ADR-0072 Am.2' },
          },
        });
      });
    }
    return { action: 'clear', applied: opts.apply, manager: describe(manager), previous: before };
  }

  const operator = await prisma.user.findUnique({
    where: { id: opts.operator },
    select: { ...USER_FIELDS, pin_hash: true },
  });
  if (!operator || operator.role !== 'operator' || !operator.is_active) {
    throw new LinkRefused('operator account is not an active operator');
  }
  if (!operator.pin_hash) throw new LinkRefused('operator account has no floor PIN');
  // An admin account has no site of its own (admins see every site), so the pair
  // only needs the operator to have one. A manager must be at the operator's site.
  // Either way, the PIN path re-checks the operator's site against the hold.
  if (!operator.primary_site_id) {
    throw new LinkRefused('the operator account has no primary site');
  }
  if (manager.role !== 'admin' && manager.primary_site_id !== operator.primary_site_id) {
    throw new LinkRefused('the two accounts are not at the same primary site');
  }
  const { pin_hash: _omit, ...operatorSafe } = operator;

  if (manager.floor_user_id === operator.id) {
    return {
      action: 'none',
      reason: 'already linked',
      manager: describe(manager),
      operator: describe(operatorSafe),
    };
  }
  if (manager.floor_user_id) {
    throw new LinkRefused('manager is already linked to a different operator; --clear it first');
  }
  const taken = await prisma.user.findFirst({
    where: { floor_user_id: operator.id },
    select: { id: true },
  });
  if (taken) throw new LinkRefused(`operator is already linked from account ${taken.id}`);

  if (opts.apply) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: manager.id, floor_user_id: null },
        data: { floor_user_id: operator.id },
      });
      if (count === 0) throw new LinkRefused('link changed concurrently; re-run');
      await tx.auditLog.create({
        data: {
          actor_user_id: actor.id,
          actor_label: ACTOR_LABEL,
          action: 'update',
          table_name: 'users',
          row_id: manager.id,
          before: { floor_user_id: null },
          after: { floor_user_id: operator.id, adr: 'ADR-0072 Am.2' },
        },
      });
    });
  }
  return {
    action: 'link',
    applied: opts.apply,
    manager: describe(manager),
    operator: describe(operatorSafe),
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const out = await linkFloorPin(prisma, opts);
    console.log(JSON.stringify(out, null, 2));
    if (!opts.apply && out.action !== 'none')
      console.log('DRY RUN — nothing written. Re-run with --apply.');
  } catch (e) {
    if (e instanceof LinkRefused) {
      console.error(`REFUSED: ${e.message}`);
      process.exitCode = 2;
    } else {
      // Unique-index or FK violations land here; surface the code, not the row.
      console.error(`FAILED: ${e?.code ?? e?.name ?? 'error'} ${e?.message ?? ''}`.trim());
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(`fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
