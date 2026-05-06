#!/usr/bin/env node
// Wraps `prisma migrate deploy` and publishes one ntfy event per
// newly-applied migration to `dr3-vision-system` (ADR-0036 + ADR-0037).
//
// Replaces the bare `prisma migrate deploy` invocation in
// `docker-compose.yml`'s `migrate` service. Per the fleet-wide
// "Migration applied" convention from CLAUDE.md these alerts ride at
// `default` priority — same-day visibility, no wake-up.
//
// Behaviour:
//   1. Snapshot applied migration names BEFORE running
//      `prisma migrate deploy`. If `_prisma_migrations` doesn't exist
//      yet (first deploy ever), the snapshot is empty.
//   2. Spawn `prisma migrate deploy`, inheriting stdio.
//   3. Non-zero exit → exit with the same code; no ntfy publish (the
//      operator gets the failure via the deployer surface).
//   4. Snapshot applied migrations AFTER. Diff against pre-snapshot.
//   5. For each newly-applied migration, POST to ntfy. Fail-soft: a
//      publish error never affects the migrate exit code.
//
// Per ADR-0036, when `NTFY_PUBLISHER_TOKEN` is unset the publish step
// is a no-op — the wrapper still completes successfully. Uses the
// already-bundled `@prisma/client` for the snapshot reads (no new
// dependency footprint vs. the bare invocation).

import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const PRIMARY_BASE = process.env.NTFY_BASE_URL?.trim() || 'https://ntfy.barnardhq.com';
const FALLBACK_BASE = 'https://ntfy.sh';
const TOPIC = process.env.NTFY_TOPIC_SYSTEM?.trim() || 'dr3-vision-system';
const FALLBACK_TOPIC = 'bhq-fb-dr3v-system-k8m2n';
const CLICK_URL = 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision';
const TIMEOUT_MS = 5_000;

async function appliedMigrationNames(prisma) {
  // `_prisma_migrations` is created on the first `migrate deploy`.
  // Tolerate its absence so the very first deploy still succeeds.
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL',
    );
    return new Set(rows.map((r) => r.migration_name));
  } catch (err) {
    const msg = err?.message ?? '';
    if (/relation .* does not exist/i.test(msg) || /_prisma_migrations.*does not exist/i.test(msg)) {
      return new Set();
    }
    throw err;
  }
}

async function publishMigrationApplied(name) {
  const token = process.env.NTFY_PUBLISHER_TOKEN?.trim();
  if (!token) return;
  const title = `[DR3-Vision] Migration applied ${name}`.slice(0, 250);
  const body = `Prisma migration "${name}" was applied to the production database.`;
  const headers = {
    'X-Title': title,
    Priority: 'default',
    Click: CLICK_URL,
    Tags: 'migration,dr3-vision',
    Authorization: `Bearer ${token}`,
  };
  const ok = await postWithTimeout(`${PRIMARY_BASE}/${TOPIC}`, body, headers, TIMEOUT_MS);
  if (ok) return;
  // Fallback — strip Authorization, prefix [FALLBACK].
  const fbHeaders = {
    'X-Title': `[FALLBACK] ${title}`.slice(0, 250),
    Priority: 'default',
    Click: CLICK_URL,
    Tags: 'migration,dr3-vision',
  };
  await postWithTimeout(`${FALLBACK_BASE}/${FALLBACK_TOPIC}`, body, fbHeaders, TIMEOUT_MS);
}

async function postWithTimeout(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    if (!resp.ok) {
      await resp.text().catch(() => '');
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function snapshotApplied() {
  const prisma = new PrismaClient();
  try {
    return await appliedMigrationNames(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('migrate-with-ntfy: DATABASE_URL is required');
    process.exit(2);
  }

  const before = await snapshotApplied();

  const result = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  // Best-effort post-snapshot + publish. Any error here is logged but
  // never fails the deploy — `migrate deploy` already succeeded.
  try {
    const after = await snapshotApplied();
    const newlyApplied = [...after].filter((name) => !before.has(name));
    for (const name of newlyApplied) {
      try {
        await publishMigrationApplied(name);
      } catch (err) {
        console.warn(`migrate-with-ntfy: publish failed for ${name}:`, err?.message ?? err);
      }
    }
  } catch (err) {
    console.warn('migrate-with-ntfy: post-migration ntfy step failed:', err?.message ?? err);
  }
}

main().catch((err) => {
  console.error('migrate-with-ntfy: fatal', err);
  process.exit(1);
});
