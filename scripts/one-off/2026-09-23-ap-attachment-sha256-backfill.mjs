// ADR-0136 addendum — one-off: fill `ap_attachments.sha256` for every file stored
// before migration 20260864_adr0136_ap_attachment_sha256.
//
// WHY: the same-file duplicate key compares the sha256 of the pending request's
// invoice files with the files of every approved request. The Approve guard
// records the hash for each request it checks from now on; the approvals made
// before it have no hash on their files, so without this backfill the key could
// only see them through `ap_requests.original_attachment_sha256` (the decision
// stamp's FIRST original — half the approved requests carry two or more files).
//
// WHAT IT WRITES: `ap_attachments.sha256` only, only where it is NULL, only the
// sha256 of the bytes stored under that row's own `storage_key`. Every stored file
// is hashed (signature images included — the key itself refuses those at match
// time), so the column means one thing on every row. No other table, no audit row
// (a derived value, not a decision — CLAUDE.md hard rule 6 is about never touching
// audit rows, and none is touched). Idempotent: a re-run finds nothing to do.
//
// RUN (inside the app container — it carries the R2 credentials and the Prisma
// client; nothing is printed but ids and counts):
//   docker exec -w /app dr3-vision-app node scripts/one-off/2026-09-23-ap-attachment-sha256-backfill.mjs
//   … add `--apply` to write. Without it the script is a read-only dry run.

import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const env = process.env;
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
  if (!env[k]) throw new Error(`${k} is not set — run this inside the app container`);
}
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});
const db = new PrismaClient();

try {
  const rows = await db.apAttachment.findMany({
    where: { kind: 'file', sha256: null, storage_key: { not: null } },
    select: { id: true, storage_key: true },
  });
  let hashed = 0;
  let written = 0;
  const unreadable = [];
  for (const r of rows) {
    if (r.storage_key.startsWith('pending-r2-')) {
      unreadable.push(r.id);
      continue;
    }
    try {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: r.storage_key }),
      );
      const bytes = await res.Body.transformToByteArray();
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      hashed++;
      if (APPLY) {
        const { count } = await db.apAttachment.updateMany({
          where: { id: r.id, sha256: null },
          data: { sha256 },
        });
        written += count;
      }
    } catch (e) {
      unreadable.push(`${r.id} (${e instanceof Error ? e.name : 'error'})`);
    }
  }
  console.log(
    JSON.stringify({
      mode: APPLY ? 'apply' : 'dry-run',
      candidates: rows.length,
      hashed,
      written,
      unreadable,
    }),
  );
} finally {
  await db.$disconnect();
}
