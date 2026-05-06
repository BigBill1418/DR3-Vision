#!/usr/bin/env node
// Bootstrap CLI — set a manager/admin password without going through
// the email reset flow. Used post-deploy to seat the first admin
// password (Bill) so the rest of the team can be invited via the
// proper email-reset flow once Resend is wired in.
//
// Usage:
//   DATABASE_URL=... node scripts/set-password.mjs <email>
//
// Reads the new password from a TTY prompt (no echo) and writes it
// hashed via Argon2id. Idempotent — running twice with different
// passwords just re-hashes.

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import readline from 'node:readline';
import { Writable } from 'node:stream';

const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

function promptHidden(question) {
  return new Promise((resolve) => {
    const muted = new Writable({
      write(chunk, _enc, cb) {
        if (!muted.muted) process.stdout.write(chunk);
        cb();
      },
    });
    muted.muted = false;
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(question);
    muted.muted = true;
    rl.question('', (answer) => {
      muted.muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/set-password.mjs <email>');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, role: true },
  });
  if (!user) {
    console.error(`No user with email ${email}`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`Found ${user.name} (${user.role})`);
  const pw = await promptHidden('New password (≥12 chars): ');
  const pw2 = await promptHidden('Confirm:                  ');
  if (pw !== pw2) {
    console.error('Passwords do not match');
    await prisma.$disconnect();
    process.exit(1);
  }
  if (pw.length < 12) {
    console.error('Password must be at least 12 characters');
    await prisma.$disconnect();
    process.exit(1);
  }
  const hash = await argon2.hash(pw, HASH_OPTIONS);
  await prisma.user.update({
    where: { id: user.id },
    data: { password_hash: hash, is_active: true },
  });
  console.log(`✔ Password set for ${email}; account marked active.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
