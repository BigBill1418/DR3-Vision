// ADR-0046 Amendment 5 (D-M5-4) — per-vendor variance-threshold overrides
// (admin-only). PATCH sets (or clears) `variance_flat_override_cents` +
// `variance_percent_override` on one `ap_vendor_baselines` row — the admin tightens
// a vendor's bounds (Kelsey's Clark Pest → $25 flat + 6.25%) or loosens them. The
// override columns are the ONLY thing that survives a rebuild untouched, so this is
// where they are set. `[vendor]` is the URL-encoded `vendor_name_normalized`. The
// change is audited (a threshold change is security-relevant config).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OverrideBody {
  /** Whole cents (>= 0) or null to clear back to the global $50 default. */
  flatOverrideCents?: number | null;
  /** Fraction in (0, 1] (e.g. 0.0625 for 6.25%) or null to clear to the 15% default. */
  percentOverride?: number | null;
}

/** Validate a nullable non-negative integer cents override. */
function validFlat(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
}
/** Validate a nullable fraction in (0, 1]. */
function validPercent(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ vendor: string }> },
): Promise<Response> {
  let actorUserId: string;
  try {
    const ctx = await requireAdmin();
    actorUserId = ctx.userId;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { vendor } = await params;
  const key = decodeURIComponent(vendor);
  const body = (await req.json().catch(() => null)) as OverrideBody | null;
  if (!body) return NextResponse.json({ error: 'expected JSON body' }, { status: 400 });
  if (!('flatOverrideCents' in body) && !('percentOverride' in body)) {
    return NextResponse.json({ error: 'no override fields supplied' }, { status: 400 });
  }
  if ('flatOverrideCents' in body && !validFlat(body.flatOverrideCents)) {
    return NextResponse.json({ error: 'flatOverrideCents must be a non-negative integer or null' }, { status: 400 });
  }
  if ('percentOverride' in body && !validPercent(body.percentOverride)) {
    return NextResponse.json({ error: 'percentOverride must be a fraction in (0,1] or null' }, { status: 400 });
  }

  const existing = await prisma.apVendorBaseline.findUnique({
    where: { vendor_name_normalized: key },
    select: { variance_flat_override_cents: true, variance_percent_override: true },
  });
  if (!existing) return NextResponse.json({ error: 'baseline not found' }, { status: 404 });

  const data: {
    variance_flat_override_cents?: number | null;
    variance_percent_override?: number | null;
  } = {};
  if ('flatOverrideCents' in body) data.variance_flat_override_cents = body.flatOverrideCents ?? null;
  if ('percentOverride' in body) data.variance_percent_override = body.percentOverride ?? null;

  const updated = await prisma.apVendorBaseline.update({
    where: { vendor_name_normalized: key },
    data,
  });
  await writeAudit({
    actor_user_id: actorUserId,
    action: 'update',
    table_name: 'ap_vendor_baselines',
    row_id: key,
    before: {
      variance_flat_override_cents: existing.variance_flat_override_cents,
      variance_percent_override:
        existing.variance_percent_override != null ? Number(existing.variance_percent_override) : null,
    },
    after: {
      variance_flat_override_cents: updated.variance_flat_override_cents,
      variance_percent_override:
        updated.variance_percent_override != null ? Number(updated.variance_percent_override) : null,
    },
  });

  return NextResponse.json({ ok: true });
}
