// ADR-0040 D6 — rate variance report endpoint (JSON + CSV export).
//
// GET /api/manager/billing-rates/variance[?format=csv][&date=YYYY-MM-DD]
// Manager+ read (`requireRateRead`). Replaces the hand-built renegotiate_trans_rates.docx
// with a living, self-updating artifact.

import { NextResponse } from 'next/server';
import { requireRateRead } from '@/lib/auth-helpers';
import { buildVarianceReport, varianceToCsv } from '@/lib/billing-rates/variance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireRateRead();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');
  const date =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? new Date(`${dateParam}T00:00:00Z`) : new Date();

  const report = await buildVarianceReport({ date });

  if (url.searchParams.get('format') === 'csv') {
    const filename = `dr3-rate-variance-${report.as_of}.csv`;
    return new Response(varianceToCsv(report), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }
  return NextResponse.json(report);
}
