#!/usr/bin/env node
// Bootstrap CLI — create-or-update an operator account and set/reset
// their PIN. Used to bring up the test operator for T-004 acceptance,
// and as the manager fall-back path until the manager-portal PIN-reset
// surface ships (T-010+).
//
// Usage:
//   node scripts/set-operator-pin.mjs <site-code> <operator-name> <pin>
//
//   site-code: 'eugene' | 'woodland' (matches sites.code)
//   operator-name: human-readable; matches existing operator at the
//                  site by exact name, or creates a new operator.
//   pin: 4 digits.
//
// Loop-verify uniqueness within the site happens server-side per
// ADR-0012 §3 — collisions abort with a non-zero exit. Audit row
// written via the same shared helper as the runtime portal.

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const FOUR_DIGITS = /^\d{4}$/;

function isAllSame(p) {
  return p.split('').every((d) => d === p[0]);
}
function isSequential(p) {
  const ds = p.split('').map(Number);
  const asc = ds.every((d, i) => i === 0 || d === ds[i - 1] + 1);
  const desc = ds.every((d, i) => i === 0 || d === ds[i - 1] - 1);
  return asc || desc;
}
function isRepeatedPair(p) {
  return p[0] === p[2] && p[1] === p[3] && p[0] !== p[1];
}
function patternError(p) {
  if (!FOUR_DIGITS.test(p)) return 'not_four_digits';
  if (isAllSame(p)) return 'all_same';
  if (isSequential(p)) return 'sequential';
  if (isRepeatedPair(p)) return 'repeated_pair';
  return null;
}

async function main() {
  const [siteCode, name, pin] = process.argv.slice(2);
  if (!siteCode || !name || !pin) {
    console.error('Usage: node scripts/set-operator-pin.mjs <site-code> <operator-name> <pin>');
    process.exit(2);
  }
  const ptn = patternError(pin);
  if (ptn) {
    console.error(`PIN rejected: ${ptn} (per ADR-0004 disallow list)`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const site = await prisma.site.findUnique({ where: { code: siteCode }, select: { id: true } });
    if (!site) {
      console.error(`No site with code ${siteCode}`);
      process.exit(1);
    }

    let operator = await prisma.user.findFirst({
      where: { name, primary_site_id: site.id, role: 'operator' },
      select: { id: true, pin_hash: true },
    });
    if (!operator) {
      operator = await prisma.user.create({
        data: {
          name,
          role: 'operator',
          locale: 'en',
          primary_site_id: site.id,
          is_active: true,
        },
        select: { id: true, pin_hash: true },
      });
      console.log(`created new operator ${name} at ${siteCode} → ${operator.id}`);
    }

    // Loop-verify uniqueness within site (ADR-0012 §3).
    const peers = await prisma.user.findMany({
      where: {
        role: 'operator',
        is_active: true,
        primary_site_id: site.id,
        pin_hash: { not: null },
        id: { not: operator.id },
      },
      select: { id: true, pin_hash: true },
    });
    for (const peer of peers) {
      if (await argon2.verify(peer.pin_hash, pin)) {
        console.error(
          `PIN collision: another active operator at ${siteCode} already uses this PIN`,
        );
        process.exit(1);
      }
    }

    const hash = await argon2.hash(pin, HASH_OPTIONS);
    await prisma.user.update({
      where: { id: operator.id },
      data: {
        pin_hash: hash,
        pin_failed_attempts: 0,
        pin_first_failed_at: null,
        pin_locked_until: null,
        is_active: true,
      },
    });
    await prisma.auditLog.create({
      data: {
        actor_label: 'system:set-operator-pin-cli',
        action: 'update',
        table_name: 'users',
        row_id: operator.id,
        after: { pin_hash: '<argon2id>', pin_set: true },
      },
    });
    console.log(`✔ PIN set for ${name} (${operator.id}) at ${siteCode}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
