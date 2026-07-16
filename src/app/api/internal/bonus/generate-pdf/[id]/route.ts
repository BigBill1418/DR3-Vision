// Internal eager-PDF generation endpoint (ADR-0023 Q13, T-321).
//
// The historical-import seed script (`scripts/generate-historical-pdfs.mjs`)
// POSTs here once per historical_imported period to render + upload its PDF and
// stamp `pdf_storage_key`. This mirrors the fleet convention used by the
// period-close cron (`scripts/bonus-period-close.mjs` → /api/internal/bonus/
// close-months): the `.mjs` wrapper stays plain JavaScript and never imports
// the TypeScript app code — it drives the orchestration (here, the Playwright +
// R2 path in `@/lib/bonus/pdf`) through a loopback-guarded internal route.
//
// INTERNAL-ONLY: like /metrics, /internal/bonus-pdf, and the close-months route,
// any request carrying a `cf-connecting-ip` header (i.e. arriving via the public
// Cloudflare tunnel) gets a flat 404. The seed reaches it over loopback inside
// the fleet network. An optional `INTERNAL_CRON_TOKEN` adds a bearer check.
//
// IDEMPOTENT: a period whose `pdf_storage_key` is already set is skipped (200
// with skipped:true) so a re-run / re-deploy is a no-op. generateBonusPdf reads
// the historical-aware internal render page, which prints the as-paid legacy
// total + import attestation for historical_imported periods (ADR-0023 Q1/Q4).

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { prisma } from '@/lib/prisma';
import { generateBonusPdf } from '@/lib/bonus/pdf';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Public-tunnel requests are not allowed to drive generation.
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const { id } = await params;

  const period = await prisma.bonusPayPeriod.findUnique({
    where: { id },
    select: { id: true, state: true, pdf_storage_key: true },
  });
  if (!period) {
    return new NextResponse('Not Found', { status: 404 });
  }

  // T-321 is scoped to historical periods only: never stamp a PDF on a live
  // draft / pending_signatures period, even over loopback.
  if (period.state !== 'historical_imported') {
    return NextResponse.json(
      { id, error: 'generate-pdf is restricted to historical_imported periods' },
      { status: 409 },
    );
  }

  // Idempotency: already has a PDF — no-op.
  if (period.pdf_storage_key) {
    return NextResponse.json({ id, skipped: true, storageKey: period.pdf_storage_key });
  }

  try {
    const { storageKey } = await generateBonusPdf(id);
    log.info({ id, storageKey }, '[generate-pdf] historical period pdf generated');
    return NextResponse.json({ id, skipped: false, storageKey });
  } catch (err) {
    log.error(
      { id, err: err instanceof Error ? err.message : String(err) },
      '[generate-pdf] historical period pdf generation failed',
    );
    return NextResponse.json(
      { id, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
