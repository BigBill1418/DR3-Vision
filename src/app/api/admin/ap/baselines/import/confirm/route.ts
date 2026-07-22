// ADR-0046 Amendment 5 (D-M5-4) — baseline-import CONFIRM (admin-only, writes).
//
// Step 2 of the two-step import: the admin has reviewed the preview rows (possibly
// edited/removed some in the UI) and confirms. This route re-validates each row
// server-side, writes them to ap_vendor_baseline_history (source='bill_upload'),
// rebuilds the aggregated baselines (preserving admin overrides), and marks the
// source file-drop routed. The preview step is the human guard against a bad parse
// — there is no DB-level dedupe, so an admin imports a given report once.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { confirmBaselineImport, type ImportedInvoiceRow } from '@/lib/ap/baseline-import';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ConfirmBody {
  fileDropId?: string;
  rows?: unknown;
}

const MAX_ROWS = 20000;

/** Coerce + validate one client row; returns null on any invalid field. */
function coerceRow(v: unknown): ImportedInvoiceRow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const vendorName = typeof o['vendorName'] === 'string' ? o['vendorName'].trim() : '';
  const invoiceDate = typeof o['invoiceDate'] === 'string' ? o['invoiceDate'] : '';
  const amt = o['invoiceAmountCents'];
  const siteRaw = o['siteCode'];
  const siteCode = siteRaw === 'woodland' || siteRaw === 'eugene' ? siteRaw : null;
  if (!vendorName) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return null;
  if (typeof amt !== 'number' || !Number.isFinite(amt) || amt < 0) return null;
  return { vendorName, invoiceDate, invoiceAmountCents: Math.round(amt), siteCode };
}

export async function POST(req: Request): Promise<Response> {
  let actorUserId: string;
  try {
    const ctx = await requireAdmin();
    actorUserId = ctx.userId;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const body = (await req.json().catch(() => null)) as ConfirmBody | null;
  if (!body || !Array.isArray(body.rows)) {
    return NextResponse.json({ error: 'rows[] is required' }, { status: 400 });
  }
  if (body.rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `too many rows (max ${MAX_ROWS})` }, { status: 413 });
  }

  const rows: ImportedInvoiceRow[] = [];
  let rejected = 0;
  for (const raw of body.rows) {
    const row = coerceRow(raw);
    if (row) rows.push(row);
    else rejected += 1;
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: 'no valid rows to import', rejected }, { status: 400 });
  }

  // Resolve site CODEs → sites.id once.
  const sites = await prisma.site.findMany({
    where: { code: { in: ['woodland', 'eugene'] } },
    select: { id: true, code: true },
  });
  const idByCode = new Map(sites.map((s) => [s.code, s.id]));

  const result = await confirmBaselineImport({
    prisma,
    rows,
    importedByUserId: actorUserId,
    siteIdByCode: (code) => idByCode.get(code) ?? null,
  });

  if (typeof body.fileDropId === 'string' && body.fileDropId) {
    await prisma.fileDrop
      .update({
        where: { id: body.fileDropId },
        data: {
          status: 'routed',
          note: `AP baseline import: ${result.historyRowsWritten} rows → ${result.vendorsComputed} vendor baselines`,
        },
      })
      .catch(() => undefined);
  }

  await writeAudit({
    actor_user_id: actorUserId,
    action: 'insert',
    table_name: 'ap_vendor_baseline_history',
    row_id: body.fileDropId ?? 'baseline-import',
    after: {
      source: 'bill_upload',
      rows_written: result.historyRowsWritten,
      rows_rejected: rejected,
      vendors_computed: result.vendorsComputed,
      file_drop_id: body.fileDropId ?? null,
    },
  });

  return NextResponse.json({ ok: true, ...result, rejected });
}
