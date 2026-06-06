// T-110 — Monthly signature capture endpoint (ADR-0019 §5).
//
// POST /api/bonus/months/<id>/sign — capture the calling manager's attestation
// signature on a Woodland bonus month. Gates through `requireBonusAccess()`
// (Woodland-scoped): anonymous → 401, operator / Eugene manager (Rick) → 403.
// The signer's slot (Janette vs Morena) is derived server-side from the
// authenticated BonusContext; the client is NEVER trusted for it
// (CLAUDE.md hard rule #2). The ip / user-agent stamped on the signature come
// from the request headers.
//
// State (ADR-0019 §5): first signature → partially_signed; second → signed.
// On reaching `signed`, total_payout_cents is locked and the PDF + M365
// delivery fire as BACKGROUND-SAFE side effects — the signing user never waits
// on Chromium or Graph (the route returns as soon as the signature transaction
// commits).
//
// A signer who already filled their slot is rejected (409 already_signed); the
// UI also disables the button. Each signature writes an audit row (in the
// signature transaction, via the data layer).

import { NextResponse } from 'next/server';
import { requireBonusAccess } from '@/lib/bonus/access';
import { prisma } from '@/lib/prisma';
import { recordSignature, recordStateGauge } from '@/lib/bonus/signatures';
import { generateBonusPdf } from '@/lib/bonus/pdf';
import { sendPayrollPdf } from '@/lib/m365-mail';
import { log, newRequestId } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

/**
 * Fire the 2nd-signature side effects WITHOUT blocking the signing response.
 * Both steps are individually fail-safe: generateBonusPdf rethrows on failure
 * (we swallow + log here so a PDF/mail failure never surfaces to the signer or
 * crashes the process), and sendPayrollPdf is fail-open. Mail only runs if the
 * PDF succeeded — there is nothing to attach otherwise.
 */
function triggerPayrollDelivery(monthId: string): void {
  const requestId = newRequestId();
  void (async () => {
    try {
      await generateBonusPdf(monthId);
    } catch (err) {
      log.error({ requestId, monthId, err }, '[sign] bonus PDF generation failed; skipping mail');
      return;
    }
    try {
      const month = await prisma.bonusMonth.findUnique({
        where: { id: monthId },
        select: { pdf_storage_key: true, month_start: true, amended_from_month_id: true },
      });
      if (!month?.pdf_storage_key) {
        log.error(
          { requestId, monthId },
          '[sign] no pdf_storage_key after generation; skipping mail',
        );
        return;
      }
      const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
      const accountId = process.env['R2_ACCOUNT_ID'];
      const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
      const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];
      const bucket = process.env['R2_BUCKET'];
      if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
        log.warn({ requestId, monthId }, '[sign] R2 not configured; cannot attach pdf for mail');
        return;
      }
      const r2 = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      });
      const obj = await r2.send(
        new GetObjectCommand({ Bucket: bucket, Key: month.pdf_storage_key }),
      );
      const pdfBuffer = Buffer.from(await obj.Body!.transformToByteArray());
      const ym = `${month.month_start.getUTCFullYear()}-${String(
        month.month_start.getUTCMonth() + 1,
      ).padStart(2, '0')}`;
      const isAmendment = month.amended_from_month_id !== null;
      await sendPayrollPdf({
        monthId,
        pdfBuffer,
        filename: `bonus-${ym}.pdf`,
        subject: `${isAmendment ? '[AMENDED] ' : ''}Woodland processor bonus — ${ym}`,
        htmlBody: `<p>The signed Woodland processor bonus report for ${ym} is attached.</p>`,
        isAmendment,
      });
    } catch (err) {
      log.error({ requestId, monthId, err }, '[sign] payroll mail-send failed');
    }
  })();
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let ctx;
  try {
    ctx = await requireBonusAccess();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;

  // Optional override payload (ADR-0019 §5, T-111). A natural signature posts an
  // empty body; an override posts { onBehalfOf, reason }. The server re-derives
  // and re-enforces the asymmetric authority in the data layer — the client is
  // NEVER trusted for who-may-override-whom.
  let onBehalfOf: 'janette' | 'morena' | undefined;
  let overrideReason: string | undefined;
  try {
    const body = (await req.json().catch(() => null)) as {
      onBehalfOf?: unknown;
      reason?: unknown;
    } | null;
    if (body && (body.onBehalfOf === 'janette' || body.onBehalfOf === 'morena')) {
      onBehalfOf = body.onBehalfOf;
      overrideReason = typeof body.reason === 'string' ? body.reason : undefined;
    }
  } catch {
    // Malformed/empty body → treat as a natural signature (no override).
  }

  const result = await recordSignature({
    db: prisma as never,
    monthId: id,
    signer: {
      userId: ctx.userId,
      role: ctx.role,
      primarySiteId: ctx.primarySiteId,
      siteId: ctx.siteId,
    },
    // Omit the keys entirely on a natural signature (exactOptionalPropertyTypes).
    ...(onBehalfOf ? { onBehalfOf } : {}),
    ...(overrideReason !== undefined ? { overrideReason } : {}),
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent') ?? null,
  });

  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return NextResponse.json({ error: 'Bonus month not found.' }, { status: 404 });
      case 'already_signed':
        return NextResponse.json({ error: 'You have already signed this month.' }, { status: 409 });
      case 'wrong_state':
        return NextResponse.json(
          { error: 'This month is not awaiting signatures.' },
          { status: 409 },
        );
      case 'no_slot':
        // An admin signing with no override target lands here.
        return NextResponse.json(
          { error: 'You are not an assigned signer for this month.' },
          { status: 403 },
        );
      case 'not_authorized':
        // Caller may not override THIS slot (ADR-0019 §5 asymmetric authority).
        return NextResponse.json(
          { error: 'You are not authorized to sign on behalf of this signer.' },
          { status: 403 },
        );
      case 'missing_reason':
        return NextResponse.json(
          { error: 'A reason is required to sign on behalf of another signer.' },
          { status: 422 },
        );
      default:
        return NextResponse.json({ error: 'Server error.' }, { status: 500 });
    }
  }

  // Reflect the state move on the gauge. First signature moved
  // pending_signatures → partially_signed; second → signed.
  const from = result.fullySigned ? 'partially_signed' : 'pending_signatures';
  recordStateGauge(ctx.siteId, from, result.state);

  // Second signature → fire PDF + payroll delivery off the request path.
  if (result.fullySigned) triggerPayrollDelivery(id);

  return NextResponse.json(
    { ok: true, slot: result.slot, state: result.state, fullySigned: result.fullySigned },
    { status: 200 },
  );
}
