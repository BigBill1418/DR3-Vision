// ADR-0045 D2 — a single digest: GET (with rendered copy-ready HTML), PATCH to
// save the markdown draft or finalize it. Org reach only (admin / all_sites).
// There is NO send action here — the human copies the HTML and sends it.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrgReach } from '@/lib/ops/viewer';
import {
  finalizeDigest,
  renderDigestHtml,
  saveDigestBody,
  UpdateDigestError,
} from '@/lib/ops/update-digest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  try {
    await requireOrgReach();
    const { id } = await ctx.params;
    const digest = await prisma.updateDigest.findUnique({ where: { id } });
    if (!digest) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ digest, html: renderDigestHtml(digest) });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

interface PatchBody {
  action: 'save' | 'finalize';
  body_md?: string;
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const identity = await requireOrgReach();
    const { id } = await ctx.params;
    const body = (await req.json()) as PatchBody;
    try {
      if (body.action === 'finalize') {
        const digest = await finalizeDigest(id, identity.userId);
        return NextResponse.json({ digest });
      }
      if (body.action === 'save') {
        if (typeof body.body_md !== 'string') {
          return NextResponse.json({ error: 'body_md_required' }, { status: 422 });
        }
        const digest = await saveDigestBody(id, body.body_md, identity.userId);
        return NextResponse.json({ digest });
      }
      return NextResponse.json({ error: 'invalid_action' }, { status: 422 });
    } catch (inner) {
      if (inner instanceof UpdateDigestError) {
        return NextResponse.json({ error: inner.reason }, { status: inner.status });
      }
      throw inner;
    }
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
