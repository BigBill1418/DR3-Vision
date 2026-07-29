// ADR-0067 §3.4 — the anomaly queue: before/after diff, apply or discard.
//
// This is the surface that makes D7 workable. The guardrail STAGED a revision
// instead of letting it flow; this is where a human looks at what changed and
// decides. Applying writes the same full before/after audit row an auto-applied
// change writes, because a reviewed change is not a lesser record than an
// unreviewed one.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { listAnomalies } from '@/lib/doc-ingest/health';
import { applyVersion, discardVersion } from '@/lib/doc-ingest/ingest';
import { acknowledgeAnomaly, resolveAnomalyById } from '@/lib/doc-ingest/anomalies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const includeResolved = new URL(req.url).searchParams.get('resolved') === '1';
  return NextResponse.json({ anomalies: await listAnomalies(prisma, includeResolved) });
}

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('apply'), versionId: z.string().min(1) }),
  z.object({
    action: z.literal('discard'),
    versionId: z.string().min(1),
    note: z.string().min(1).max(500),
  }),
  z.object({ action: z.literal('acknowledge'), anomalyId: z.string().min(1) }),
  z.object({
    action: z.literal('resolve'),
    anomalyId: z.string().min(1),
    note: z.string().min(1).max(500),
  }),
]);

export async function POST(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const body = parsed.data;

  try {
    if (body.action === 'apply') {
      const version = await prisma.docSourceVersion.findUnique({
        where: { id: body.versionId },
        include: { doc_source: true },
      });
      if (!version?.doc_source) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      // Only a STAGED revision can be applied from here. Without this check a
      // replayed request could re-apply an already-applied revision and mint a
      // second file-drop for one change.
      if (!version.staged) {
        return NextResponse.json({ error: 'not_staged' }, { status: 409 });
      }
      await applyVersion(
        prisma,
        version.doc_source,
        version,
        version.size_bytes ?? 0,
        ctx.userId,
        new Date(),
        'operator',
      );
      // The anomaly that staged it is now answered — resolve it rather than
      // leaving a fixed problem showing as open.
      const open = await prisma.docIngestAnomaly.findMany({
        where: { doc_source_version_id: version.id, status: { in: ['open', 'acknowledged'] } },
        select: { id: true },
      });
      for (const row of open) {
        await resolveAnomalyById(
          prisma,
          row.id,
          ctx.userId,
          'Staged revision applied after review.',
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'discard') {
      await discardVersion(prisma, body.versionId, ctx.userId, body.note);
      const open = await prisma.docIngestAnomaly.findMany({
        where: { doc_source_version_id: body.versionId, status: { in: ['open', 'acknowledged'] } },
        select: { id: true },
      });
      for (const row of open) {
        await resolveAnomalyById(
          prisma,
          row.id,
          ctx.userId,
          `Staged revision discarded: ${body.note}`,
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'acknowledge') {
      await acknowledgeAnomaly(prisma, body.anomalyId, ctx.userId);
      return NextResponse.json({ ok: true });
    }

    await resolveAnomalyById(prisma, body.anomalyId, ctx.userId, body.note);
    return NextResponse.json({ ok: true });
  } catch {
    // Never leak internals — an error message here can describe the store.
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
