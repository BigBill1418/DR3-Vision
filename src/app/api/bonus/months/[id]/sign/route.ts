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
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { prisma } from '@/lib/prisma';
import { recordSignature, recordStateGauge } from '@/lib/bonus/signatures';
import { triggerPayrollDelivery } from '@/lib/bonus/payroll-delivery';
import { notifyPendingSigner } from '@/lib/bonus/signature-notifications';
import { publishNtfy } from '@/lib/ntfy';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

/** Email the remaining signer after the FIRST signature, off the request path. */
function triggerSignaturePrompt(monthId: string): void {
  void notifyPendingSigner(monthId).catch((err) => {
    // P0-3: notifyPendingSigner is fail-open and pages on its own resolvable
    // failures (no signer / mail failed). Reaching THIS catch means it threw
    // unexpectedly (DB error, etc.) — an otherwise-silent failure that leaves the
    // next signer un-prompted. Page (high) so it is not lost.
    log.error({ monthId, err }, '[sign] signature-request email failed (non-fatal)');
    void publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Bonus signature-request notify threw',
      body: `notifyPendingSigner threw for month ${monthId} after the first signature, so the remaining signer was not prompted. Error: ${
        err instanceof Error ? err.message : String(err)
      }`,
      priority: 'high',
      tags: ['error', 'bonus', 'payroll', 'signature', 'dr3-vision'],
      fingerprint: `signer-notify-threw:${monthId}`,
    });
  });
}

export async function POST(
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

  // Optional override payload (ADR-0019 §5, T-111). A natural signature posts an
  // empty body; an override posts { onBehalfOf, reason }. The server re-derives
  // and re-enforces the asymmetric authority in the data layer — the client is
  // NEVER trusted for who-may-override-whom.
  let onBehalfOf: 'facility' | 'ops' | undefined;
  let overrideReason: string | undefined;
  try {
    const body = (await req.json().catch(() => null)) as {
      onBehalfOf?: unknown;
      reason?: unknown;
    } | null;
    if (body && (body.onBehalfOf === 'facility' || body.onBehalfOf === 'ops')) {
      onBehalfOf = body.onBehalfOf;
      overrideReason = typeof body.reason === 'string' ? body.reason : undefined;
    }
  } catch {
    // Malformed/empty body → treat as a natural signature (no override).
  }

  const result = await recordSignature({
    db: prisma as never,
    // Chain lookup (T-208) reads the bonus_signature_chains row for the
    // period's site off the request-scoped Prisma singleton.
    chainDb: prisma,
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
  // First signature → email the remaining signer (ADR-0019 §5a, T-125).
  if (result.fullySigned) triggerPayrollDelivery(id);
  else triggerSignaturePrompt(id);

  return NextResponse.json(
    { ok: true, slot: result.slot, state: result.state, fullySigned: result.fullySigned },
    { status: 200 },
  );
}
