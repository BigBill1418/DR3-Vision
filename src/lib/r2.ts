import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import type { PhotoKind } from '@prisma/client';

// Cloudflare R2 client + presigned-URL minting for the operator photo
// flow (T-007). The browser PUTs the file bytes directly to R2 via
// the signed URL, then POSTs to /api/photos/confirm to write the
// LoadPhoto row. This way the application server never proxies the
// file bytes — the operator's iPad uploads straight to the edge.
//
// CLAUDE.md hard rule #7: photos go to R2 only. Never DB, never local
// disk. The placeholder-fallback path in `mintUploadUrl` is for the
// pre-provisioned-creds window only — it returns a non-uploadable
// `pending-r2-…` storage_key so the workflow can still progress in
// dev or before the operator provisions ~/.dr3-vision-secrets/r2.env.

let cachedClient: S3Client | null = null;

function isConfigured(): boolean {
  return Boolean(
    process.env['R2_ACCOUNT_ID'] &&
      process.env['R2_ACCESS_KEY_ID'] &&
      process.env['R2_SECRET_ACCESS_KEY'] &&
      process.env['R2_BUCKET'],
  );
}

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  const accountId = process.env['R2_ACCOUNT_ID'];
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 not configured');
  }
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  return cachedClient;
}

const SAFE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function extFor(contentType: string): string {
  return SAFE_EXT[contentType.toLowerCase()] ?? 'bin';
}

export type MintedUpload = {
  storage_key: string;
  // null when R2 isn't configured — caller treats as "skip the PUT,
  // just write the LoadPhoto row with the placeholder key".
  upload_url: string | null;
};

export async function mintUploadUrl(args: {
  loadId: string;
  kind: PhotoKind;
  contentType: string;
}): Promise<MintedUpload> {
  const ext = extFor(args.contentType);
  if (!isConfigured()) {
    return {
      storage_key: `pending-r2-${args.kind}-${randomUUID()}.${ext}`,
      upload_url: null,
    };
  }
  const bucket = process.env['R2_BUCKET']!;
  const storage_key = `loads/${args.loadId}/${args.kind}/${randomUUID()}.${ext}`;
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: storage_key,
    ContentType: args.contentType,
  });
  const upload_url = await getSignedUrl(getClient(), cmd, { expiresIn: 600 });
  return { storage_key, upload_url };
}

// ────────────────────────────────────────────────────────────────────────
// Workbook-import evidence (ADR-0039 D4)
// ────────────────────────────────────────────────────────────────────────

// The historical workbook is parsed server-side and only staging rows persist,
// but the ORIGINAL xlsx is retained in R2 (prefix `workbook-imports/`) as audit
// evidence, keyed on the import row. Unlike the operator photo flow the bytes
// already live on the server here (the admin uploaded a file), so we PUT them
// straight to R2 rather than minting a browser-side signed URL. Fail-soft:
// returns null when R2 is unconfigured so the import still records its staging
// rows (the evidence blob is best-effort, not load-bearing for the audit).

export async function putWorkbookEvidence(args: {
  importId: string;
  filename: string;
  bytes: Uint8Array;
}): Promise<string | null> {
  if (!isConfigured()) return null;
  const bucket = process.env['R2_BUCKET']!;
  const safeName = args.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'workbook.xlsx';
  const storage_key = `workbook-imports/${args.importId}/${safeName}`;
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: storage_key,
      Body: args.bytes,
      ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
  return storage_key;
}
