import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
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

// ────────────────────────────────────────────────────────────────────────
// AP approval attachments (ADR-0046 C10.3)
// ────────────────────────────────────────────────────────────────────────

// Vendor-invoice attachments (PDFs, and unwrapped nested-message files) go to R2
// under the PRIVATE `ap/` prefix — bank details may be inside, so they NEVER
// touch a log/notification (ADR-0045 discipline; hard rule #7). The bytes already
// live on the server (the Graph transport decoded them), so we PUT them straight
// to R2 rather than minting a browser signed URL. Fail-soft: returns null when R2
// is unconfigured, and the pipeline records a non-fetchable `pending-r2-ap-…`
// placeholder key so the request still forms (v1 reads by human; the operator
// provisions R2 per the runbook).

export async function putApAttachment(args: {
  requestId: string;
  attachmentId: string;
  filename: string | null;
  contentType: string | null;
  bytes: Uint8Array;
}): Promise<string | null> {
  if (!isConfigured()) return null;
  const bucket = process.env['R2_BUCKET']!;
  const safeName =
    (args.filename ?? 'attachment.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) ||
    'attachment.bin';
  const storage_key = `ap/${args.requestId}/${args.attachmentId}/${safeName}`;
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: storage_key,
      Body: args.bytes,
      ContentType: args.contentType ?? 'application/octet-stream',
    }),
  );
  return storage_key;
}

// ────────────────────────────────────────────────────────────────────────
// Workbook cutover archival (ADR-0049 D8)
// ────────────────────────────────────────────────────────────────────────

// On the cutover flip, every monthly workbook that was syncing is copied to R2
// under `workbooks/{siteCode}/{yearMonth}.xlsm` — immutable, forever retention, so
// the workbook data survives Kelsey's role transitions. The bytes already live on
// the server (the Files transport downloaded them). Fail-soft: returns null when R2
// is unconfigured so the flip still completes (archival is recorded on the run/audit
// as skipped; the flip is the authoritative state change).

export async function putWorkbookArchive(args: {
  siteCode: string;
  yearMonth: string; // 'YYYY-MM'
  bytes: Uint8Array;
}): Promise<string | null> {
  if (!isConfigured()) return null;
  const bucket = process.env['R2_BUCKET']!;
  const safeSite = args.siteCode.replace(/[^a-z0-9_-]/gi, '_').toLowerCase() || 'site';
  const storage_key = `workbooks/${safeSite}/${args.yearMonth}.xlsm`;
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: storage_key,
      Body: args.bytes,
      ContentType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    }),
  );
  return storage_key;
}

export interface SignApDownloadOptions {
  expiresIn?: number;
  /**
   * ADR-0046 Amendment 4 — serve with `Content-Disposition: inline` (+ the
   * attachment's Content-Type) so the approver's browser PREVIEWS the file in a
   * frame/img instead of downloading it. The route only sets this for the
   * allowlisted inline types (pdf / png / jpeg / webp); everything else keeps the
   * plain download URL.
   */
  inline?: boolean;
  contentType?: string | null;
}

/**
 * Mint a short-lived presigned GET for an AP attachment so an approver's browser
 * fetches the PDF/image directly from R2 (the app never proxies the bytes). With
 * `inline` the URL carries an inline Content-Disposition for in-panel preview.
 * Returns null when R2 is unconfigured or the key is a non-fetchable `pending-r2-…`
 * placeholder.
 */
export async function signApAttachmentDownload(
  storageKey: string,
  opts: SignApDownloadOptions = {},
): Promise<string | null> {
  if (!isConfigured()) return null;
  if (storageKey.startsWith('pending-r2-')) return null;
  const bucket = process.env['R2_BUCKET']!;
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: storageKey,
    ...(opts.inline
      ? {
          ResponseContentDisposition: 'inline',
          ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
        }
      : {}),
  });
  return getSignedUrl(getClient(), cmd, { expiresIn: opts.expiresIn ?? 300 });
}

// ────────────────────────────────────────────────────────────────────────
// AP decision artifacts (ADR-0046 Amendment 4)
// ────────────────────────────────────────────────────────────────────────

// The decision path (approvals.ts) downloads the ORIGINAL attachment bytes,
// overlays a visible approval/rejection stamp with pdf-lib, attaches the stamped
// original to the decision email, and archives that stamped PDF back to R2 under
// `ap/{requestId}/decision/…`. Both helpers are FAIL-SOFT (return null when R2 is
// unconfigured or the key is a placeholder) — a stamp/archive miss must NEVER
// block the decision email to accounting (hard rule: mail/R2 paths fail soft).

/**
 * Server-side GET of an AP attachment's bytes (the decision path needs them to
 * overlay a stamp). Returns null when R2 is unconfigured or the key is a
 * non-fetchable `pending-r2-…` placeholder, so the caller degrades to the cover
 * page instead of throwing.
 */
export async function getApAttachmentBytes(storageKey: string): Promise<Uint8Array | null> {
  if (!isConfigured()) return null;
  if (storageKey.startsWith('pending-r2-')) return null;
  const bucket = process.env['R2_BUCKET']!;
  const res = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) return null;
  return body.transformToByteArray();
}

/**
 * Archive a stamped decision PDF to the private `ap/{requestId}/decision/` prefix.
 * Fail-soft: returns null when R2 is unconfigured so the decision email still goes
 * out (the archived copy is best-effort, not load-bearing for the decision).
 */
export async function putApDecisionPdf(args: {
  requestId: string;
  attachmentId: string;
  bytes: Uint8Array;
}): Promise<string | null> {
  if (!isConfigured()) return null;
  const bucket = process.env['R2_BUCKET']!;
  const storage_key = `ap/${args.requestId}/decision/ap-decision-${args.attachmentId}.pdf`;
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: storage_key,
      Body: args.bytes,
      ContentType: 'application/pdf',
    }),
  );
  return storage_key;
}

// ────────────────────────────────────────────────────────────────────────
// Admin file-drop inbox (O-2, 2026-07-16)
// ────────────────────────────────────────────────────────────────────────

// The admin uploads an arbitrary file through /admin/file-drop; the bytes already
// live on the server (the multipart handler buffered them) so we PUT them straight
// to R2 under the `file-drops/<id>/` prefix — mirrors putApAttachment. Fail-soft:
// returns null when R2 is unconfigured so the route still records the manifest row
// with a non-fetchable `pending-r2-filedrop-…` placeholder key (capture is the
// priority; the object is best-effort until R2 is provisioned). Accepts ANY
// content-type — this is a raw inbox by design.

export async function putFileDrop(args: {
  id: string;
  filename: string;
  contentType: string | null;
  bytes: Uint8Array;
}): Promise<string | null> {
  if (!isConfigured()) return null;
  const bucket = process.env['R2_BUCKET']!;
  const safeName = args.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file.bin';
  const storage_key = `file-drops/${args.id}/${safeName}`;
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: storage_key,
      Body: args.bytes,
      ContentType: args.contentType || 'application/octet-stream',
    }),
  );
  return storage_key;
}

/**
 * Mint a short-lived presigned GET for a file-drop object so the admin's browser
 * fetches the bytes directly from R2 (the app never proxies them). Mirrors
 * signApAttachmentDownload: returns null when R2 is unconfigured or the key is a
 * non-fetchable `pending-r2-…` placeholder. Defaults to an attachment download;
 * pass `inline` for in-browser preview of a previewable type.
 */
export async function signFileDropDownload(
  storageKey: string,
  opts: SignApDownloadOptions = {},
): Promise<string | null> {
  if (!isConfigured()) return null;
  if (storageKey.startsWith('pending-r2-')) return null;
  const bucket = process.env['R2_BUCKET']!;
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: storageKey,
    ...(opts.inline
      ? {
          ResponseContentDisposition: 'inline',
          ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
        }
      : {}),
  });
  return getSignedUrl(getClient(), cmd, { expiresIn: opts.expiresIn ?? 300 });
}
