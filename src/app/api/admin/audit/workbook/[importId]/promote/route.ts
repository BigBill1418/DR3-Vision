// ADR-0048 D1/D5 — admin workbook-promotion endpoint.
//
// Admin-only (admin POWERS stay role=admin per hard rule #2 — never off
// all_sites; and the promotion writes to the ADR-0037 operational tables, which
// are themselves admin-gated until the D7 ops gates close). Scope is enforced
// here against the table-driven allow-list (backfill-scopes.ts): a request may
// only promote a window that appears there. `dryRun=true` returns a read-only
// preview (counts + conflicts + recomputed close); otherwise the promotion
// commits in one transaction, refusing on conflict / SHA mismatch / balance miss.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sourceAliasResolver } from '@/lib/audit/workbook/site-alias';
import { resolveScope } from '@/lib/audit/backfill-scopes';
import {
  promoteWorkbookImport,
  previewPromotion,
  type PromotionScope,
} from '@/lib/audit/workbook-promotion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function statusFor(err: unknown): number {
  const s = (err as { status?: unknown }).status;
  return typeof s === 'number' ? s : 500;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ importId: string }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.user.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const { importId } = await params;
  const body = (await req.json().catch(() => null)) as { scopeKey?: unknown; dryRun?: unknown } | null;
  if (!body || typeof body.scopeKey !== 'string') {
    return NextResponse.json({ error: 'scopeKey is required' }, { status: 400 });
  }
  const dryRun = body.dryRun === true;

  const imp = await prisma.workbookImport.findUnique({
    where: { id: importId },
    select: { id: true, site: { select: { id: true, code: true } } },
  });
  if (!imp) return NextResponse.json({ error: 'import not found' }, { status: 404 });

  const cfg = resolveScope(imp.site.code, body.scopeKey);
  if (!cfg) {
    return NextResponse.json(
      { error: `scope "${body.scopeKey}" is not an allowed backfill scope for site ${imp.site.code}` },
      { status: 422 },
    );
  }

  const scope: PromotionScope = {
    siteId: imp.site.id,
    from: cfg.from,
    to: cfg.to,
    expectedCloseTotal: cfg.expectedCloseTotal,
  };

  try {
    const resolver = await sourceAliasResolver(prisma);
    const common = { db: prisma, importId, scope, resolver, promotedByUserId: session.user.id };
    if (dryRun) {
      const preview = await previewPromotion(common);
      return NextResponse.json({ ok: true, dryRun: true, scope: cfg, preview });
    }
    const result = await promoteWorkbookImport(common);
    return NextResponse.json({ ok: true, dryRun: false, scope: cfg, result });
  } catch (err) {
    const status = statusFor(err);
    const message = err instanceof Error ? err.message : 'promotion failed';
    const name = err instanceof Error ? err.name : 'Error';
    // Surface the typed refusal detail (conflicts / unresolved names) to the operator.
    const detail: Record<string, unknown> = { error: message, kind: name };
    if (name === 'PromotionConflictError') detail['conflicts'] = (err as { conflicts?: unknown }).conflicts;
    if (name === 'PromotionUnresolvedSourceError') detail['names'] = (err as { names?: unknown }).names;
    return NextResponse.json(detail, { status: status === 500 ? 422 : status });
  }
}
