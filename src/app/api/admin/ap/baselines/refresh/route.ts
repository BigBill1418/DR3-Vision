// ADR-0046 Amendment 5 (D-M5-4) — on-demand vendor-baseline rebuild (admin-only).
//
// The "Refresh baselines" button on /admin/ap/baselines. Same work the nightly cron
// route runs (`rebuildVendorBaselines`) — recompute every vendor over the trailing
// 12 months, preserving admin overrides — but fired synchronously by an admin.
// Idempotent.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { rebuildVendorBaselines } from '@/lib/ap/baselines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const result = await rebuildVendorBaselines(prisma);
  return NextResponse.json({ ok: true, ...result });
}
