// ADR-0067 §3.4 — the sources list + the classification confirm/correct queue.
//
// Admin-only (hard rule #2: `/admin/*` powers stay `admin`, never `all_sites`).
// That is not incidental here — the list deliberately shows UNCLASSIFIED sources
// whose `site_id` is NULL, and a NULL site must never leak into a site-scoped
// surface. An admin-only view that shows everything is the only honest place for
// a document nobody has scoped yet.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { listDocSources } from '@/lib/doc-ingest/health';
import {
  confirmClassification,
  reclassifySource,
  setSourceEnabled,
} from '@/lib/doc-ingest/classification';
import { DOC_KINDS } from '@/lib/doc-ingest/classifier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  void ctx;
  return NextResponse.json({ sources: await listDocSources(prisma) });
}

// `vendor_invoice` is intentionally absent from the CONFIRMABLE kinds: it is
// recognized so it can be refused and redirected (ADR-0046's AP mailbox is its
// address), never registered as a document this pipeline ingests. Offering it in
// the confirm queue would invite exactly the mis-filing the misdirect flag warns
// about.
const CONFIRMABLE_KINDS = DOC_KINDS.filter((k) => k !== 'vendor_invoice' && k !== 'unknown');

const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('confirm'),
    sourceId: z.string().min(1),
    kind: z.enum(CONFIRMABLE_KINDS as unknown as [string, ...string[]]),
    siteId: z.string().min(1).nullable(),
    period: z.string().max(32).nullable(),
  }),
  z.object({
    action: z.literal('reclassify'),
    sourceId: z.string().min(1),
    kind: z.enum(CONFIRMABLE_KINDS as unknown as [string, ...string[]]),
    siteId: z.string().min(1).nullable(),
    period: z.string().max(32).nullable(),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    action: z.literal('setEnabled'),
    sourceId: z.string().min(1),
    enabled: z.boolean(),
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
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const body = parsed.data;

  // A site id from the client is a claim, not a fact — verify it names a real
  // site before it reaches a site-scoped column (hard rule #2).
  if ('siteId' in body && body.siteId !== null) {
    const site = await prisma.site.findUnique({ where: { id: body.siteId }, select: { id: true } });
    if (!site) return NextResponse.json({ error: 'unknown_site' }, { status: 400 });
  }

  try {
    if (body.action === 'confirm') {
      const source = await confirmClassification(prisma, {
        sourceId: body.sourceId,
        kind: body.kind as (typeof DOC_KINDS)[number],
        siteId: body.siteId,
        period: body.period,
        actorUserId: ctx.userId,
      });
      return NextResponse.json({ ok: true, docClass: source.doc_class });
    }

    if (body.action === 'reclassify') {
      const source = await reclassifySource(prisma, {
        sourceId: body.sourceId,
        kind: body.kind as (typeof DOC_KINDS)[number],
        siteId: body.siteId,
        period: body.period,
        reason: body.reason,
        actorUserId: ctx.userId,
      });
      return NextResponse.json({ ok: true, docClass: source.doc_class });
    }

    await setSourceEnabled(prisma, body.sourceId, body.enabled, ctx.userId);
    return NextResponse.json({ ok: true, enabled: body.enabled });
  } catch (e) {
    // `confirmClassification` throws a deliberately operator-readable message
    // when a source is already registered ("use reclassify to change it"). That
    // one is worth surfacing; anything else could describe internals.
    const message = e instanceof Error ? e.message : 'request failed';
    const isAlreadyRegistered = message.includes('already registered');
    return NextResponse.json(
      { error: isAlreadyRegistered ? message : 'server_error' },
      { status: isAlreadyRegistered ? 409 : 500 },
    );
  }
}
