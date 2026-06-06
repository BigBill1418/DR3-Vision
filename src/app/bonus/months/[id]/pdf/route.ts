// T-112 — Authorized PDF download (ADR-0019 §10).
//
// GET /bonus/months/<id>/pdf streams the stored R2 PDF object to an authorized
// bonus user (Woodland managers + admins via `requireBonusAccess()`). Unlike the
// internal render page, THIS route is the customer/operator-facing download, so
// it is fully auth-gated.
//
// The bytes are streamed from R2 through the app (the object is private; we do
// not hand out a presigned URL here so the auth gate is always enforced). The
// month must belong to the caller's Woodland site and must have a generated PDF.

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function r2Client(): S3Client {
  const accountId = process.env['R2_ACCOUNT_ID'];
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 not configured');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let ctx;
  try {
    ctx = await requireBonusAccess(siteFromRequest(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;

  // Scope to the caller's Woodland site so a forged id can't read another
  // site's artifact (CLAUDE.md hard rule #2).
  const month = await prisma.bonusPayPeriod.findFirst({
    where: { id, site_id: ctx.siteId },
    select: { id: true, pdf_storage_key: true, period_start: true },
  });
  if (!month) return new Response('not found', { status: 404 });
  if (!month.pdf_storage_key) return new Response('pdf not generated', { status: 409 });

  const bucket = process.env['R2_BUCKET'];
  if (!bucket) return new Response('storage not configured', { status: 503 });

  const obj = await r2Client().send(
    new GetObjectCommand({ Bucket: bucket, Key: month.pdf_storage_key }),
  );
  if (!obj.Body) return new Response('not found', { status: 404 });

  // The SDK Body is a web ReadableStream in the Node 18+ fetch runtime.
  const body = obj.Body.transformToWebStream();
  const ym = `${month.period_start.getUTCFullYear()}-${String(
    month.period_start.getUTCMonth() + 1,
  ).padStart(2, '0')}`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="bonus-${ym}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
