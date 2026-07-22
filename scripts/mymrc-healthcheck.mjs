#!/usr/bin/env node
// ADR-0057 D9 — Docker healthcheck for the mymrc-scrape container.
//
// Reports UNHEALTHY (exit 1) until Bill's MyMRC admin credential is configured in
// the DB store (entered at /admin/mrc-scrape), HEALTHY (exit 0) once it exists.
// This surfaces the "never provisioned" state in `docker ps` / NOC — the always-on
// companion to the per-tick ntfy page, and the fix for the historical silent
// zero-pull failure mode. It reads ONLY presence of the singleton row: no
// decryption, so it needs neither MYMRC_CRED_KEY nor the plaintext password.

import { PrismaClient } from '@prisma/client';

// Matches SINGLETON_ID in src/lib/mymrc/credential-store.ts (the one credential row).
const SINGLETON_ID = 'singleton';

const prisma = new PrismaClient();
let code = 1;
try {
  const row = await prisma.mymrcAdminCredential.findUnique({
    where: { id: SINGLETON_ID },
    select: { id: true },
  });
  code = row ? 0 : 1;
  if (!row) console.error('mymrc-healthcheck: admin credentials not configured');
} catch (err) {
  console.error(`mymrc-healthcheck: ${err?.message ?? err}`);
  code = 1;
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
process.exit(code);
