// Sprint-1 T-016 — manager monthly CSV reconciliation upload.
//
// POST /api/reconciliation/{site}/upload
//   multipart/form-data:
//     file:           the MyMRC monthly CSV (required)
//     tolerance_pct:  optional decimal override; defaults to
//                     DEFAULT_WEIGHT_TOLERANCE_PCT (plus-or-minus 2%)
//
// Auth: `requireManagerForSite(site)` — manager scoped to the URL's
// site OR admin (any site). Cross-site upload is the spec's
// "admin-only" path; the route enforces it via the site URL: a
// manager pointed at /api/reconciliation/woodland/upload while
// scoped to Eugene gets a 403, never a leaked write.
//
// Idempotency: SHA-256 of the file body is the dedupe key. If the
// same file has already been uploaded for this site, we return
// 200 with `{ created: false, reconciliation_id }` so the UI can
// surface "this file has been processed; resume?" with a link to
// the existing session — never a duplicate session.
//
// CLAUDE.md rule #10 — the client posts via fetch(), not via a
// browser <form>. The route still accepts multipart because that is
// the only sane way to ship the file body without paying the
// base64-inflation tax.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import {
  DEFAULT_WEIGHT_TOLERANCE_PCT,
  categorizeRows,
  parseReconciliationCsv,
  persistReconciliation,
  type Dr3LoadForReconcile,
} from '@/lib/reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 25 MiB ceiling — MyMRC monthly exports for a busy site rarely
// exceed 200 KiB. The cap defends against accidental upload of a
// gzipped photo dump or similar.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const toleranceSchema = z.coerce.number().min(0).max(100);

export async function POST(req: Request, ctx: { params: Promise<{ site: string }> }) {
  const { site: siteCode } = await ctx.params;

  let auth;
  try {
    auth = await requireManagerForSite(siteCode);
  } catch (gateErr) {
    if (gateErr instanceof Response) return gateErr;
    throw gateErr;
  }

  // multipart/form-data parsing
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (formErr) {
    return NextResponse.json(
      {
        error: 'malformed multipart body',
        detail: formErr instanceof Error ? formErr.message : String(formErr),
      },
      { status: 400 }
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'missing required field: file' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `file exceeds ${MAX_UPLOAD_BYTES} byte ceiling` },
      { status: 413 }
    );
  }

  const toleranceRaw = form.get('tolerance_pct');
  let tolerancePct = DEFAULT_WEIGHT_TOLERANCE_PCT;
  if (typeof toleranceRaw === 'string' && toleranceRaw.length > 0) {
    const t = toleranceSchema.safeParse(toleranceRaw);
    if (!t.success) {
      return NextResponse.json(
        { error: 'tolerance_pct must be a number between 0 and 100' },
        { status: 422 }
      );
    }
    tolerancePct = t.data;
  }

  const text = await file.text();
  const parseResult = parseReconciliationCsv(text);
  if (!parseResult.ok) {
    const status = parseResult.reason === 'missing_columns' ? 422 : 400;
    return NextResponse.json(
      { error: parseResult.reason, detail: parseResult.detail },
      { status }
    );
  }

  // Categorizer wants every DR3 load with a haul_id at THIS site
  // whose unload_finished_at falls within the CSV's observed period.
  // We widen by 7 days at each end to absorb timezone fuzz between
  // MyMRC's report dates (likely Pacific) and our UTC `unload_finished_at`.
  const periodStart = new Date(parseResult.parsed.period_start);
  periodStart.setUTCDate(periodStart.getUTCDate() - 7);
  const periodEnd = new Date(parseResult.parsed.period_end);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 8); // +1 to make exclusive, +7 fuzz

  const dr3Loads = await prisma.inboundLoad.findMany({
    where: {
      site_id: auth.siteId,
      external_mymrc_haul_id: { not: null },
      OR: [
        { unload_finished_at: { gte: periodStart, lt: periodEnd } },
        { arrived_at: { gte: periodStart, lt: periodEnd } },
      ],
    },
    select: {
      id: true,
      external_mymrc_haul_id: true,
      total_units: true,
      weight_lbs: true,
    },
  });

  const categorization = categorizeRows(
    parseResult.parsed.rows,
    dr3Loads as Dr3LoadForReconcile[],
    tolerancePct
  );

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = req.headers.get('user-agent') ?? null;

  const persisted = await persistReconciliation({
    siteId: auth.siteId,
    uploaderUserId: auth.userId,
    filename: file.name,
    parsed: parseResult.parsed,
    categorization,
    tolerancePct,
    ip,
    userAgent,
  });

  if (!persisted.ok) {
    return NextResponse.json(
      { error: persisted.reason, detail: persisted.detail },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      reconciliation_id: persisted.reconciliationId,
      created: persisted.created,
      counts: categorization.counts,
      sha256: parseResult.parsed.sha256,
    },
    { status: persisted.created ? 201 : 200 }
  );
}
