// ADR-0085 — presigned R2 PUT for a walk-up drop-off photo.
//
// The load-photo analogue is `/api/photos/upload-url`, which authorises through
// `requireOperatorAtLoadSite` — it derives the site FROM THE LOAD. A walk-up
// drop-off has no load, which is the point of the flow, so the site has to come
// from somewhere else and the only safe somewhere is the session.
// `requireActivatedOperator` re-derives it from `primary_site_id`; the `[site]`
// path segment selects WHICH site's gate to evaluate and can never grant reach
// the session does not already have.
//
// That is also why this endpoint lives under `/api/operator/[site]/…` rather
// than beside the load-photo mint: the site is structurally part of the address,
// so there is no shape of this route that forgets to scope itself.
//
// Gated on `ipad_dropoff` — the SAME surface as the write it feeds. A mint that
// stayed reachable while the write was gated would hand out signed URLs for a
// flow that then refuses the row: bytes in the bucket, nothing in the table, and
// a queue entry that can never drain. ADR-0078 Am.1 states the rule this
// follows — mint and confirm move together, always.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { mintDropoffUploadUrl } from '@/lib/r2';
import { requireActivatedOperator, loadsErrorResponse } from '@/lib/loads/route-helpers';
import { UI_SURFACE } from '@/lib/notify/rollout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mirrors `/api/photos/upload-url` exactly (audit 2026-07-16 · UPLOAD). The value
// is set verbatim on the presigned PUT, so an arbitrary string would let a caller
// park HTML/SVG that R2 then serves with an active Content-Type on the photos
// host. Mirrors r2.ts SAFE_EXT.
const CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

const schema = z.object({
  content_type: z.enum(CONTENT_TYPES),
});

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedOperator(site, UI_SURFACE.IPAD_DROPOFF);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }

    // Keyed on `ctx.siteId` — the session's site, never the path string. The
    // submit handler re-checks the returned key against this same prefix
    // (`isValidDropoffStorageKey`), so the two ends agree on what "this site's
    // object" means without either trusting the client's copy of it.
    const minted = await mintDropoffUploadUrl({
      siteId: ctx.siteId,
      contentType: parsed.data.content_type,
    });
    return NextResponse.json(minted);
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'operator.dropoff.mint',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
