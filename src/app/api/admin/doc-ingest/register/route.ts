// ADR-0067 §3.2 D4 — operator-driven share registration.
//
// WHY THIS ROUTE EXISTS. Discovery enumerates shares through
// `GET /me/drive/sharedWithMe`, which Microsoft deprecated in November 2025 AND
// which, in this tenant, under-reports: it returns ONE item while more documents
// are genuinely shared with the service account. The documented replacement
// route — `remoteItem` shortcuts under `/me/drive/root/children` — was measured
// live and is empty (zero shortcuts, zero `following`, zero `recent`), so
// switching to it would take discovery from one source to none.
//
// `GET /shares/u!{token}/driveItem` DOES resolve the documents the enumeration
// misses, including an Outlook-attachment share that never appears in a
// shared-with-me list at all. It just cannot be enumerated — it needs a URL. So
// the URL comes from the one party who has it: the operator.
//
// Admin-only, matching every other `/api/admin/doc-ingest/*` route: registering
// a source creates a row whose `site_id` is NULL (UNCLASSIFIED, never "both" —
// hard rule #2), and a NULL site must never be reachable from a site-scoped
// surface.
//
// READ-ONLY. Resolving a link observes the tenant; it grants nothing. See the
// deliberate omission of `Prefer: redeemSharingLink` in graph.ts.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { DocIngestHaltedError, DocIngestNotConnectedError } from '@/lib/doc-ingest/access-token';
import {
  docIngestGraph,
  DocIngestAccessDeniedError,
  DocIngestNotFoundError,
  DocIngestSharingUrlError,
} from '@/lib/doc-ingest/graph';
import { registerSharedItem } from '@/lib/doc-ingest/discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 2048 is the practical ceiling for a SharePoint URL; a longer string is a paste
// accident, and rejecting it here keeps it out of the base64 encoder and the
// Graph path.
const BodySchema = z.object({ url: z.string().min(1).max(2048) });

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

  const graph = docIngestGraph(prisma);

  // ── Resolve ───────────────────────────────────────────────────────────────
  // Each failure gets its own status AND its own sentence. "Could not add the
  // document" would be true of all four and useful for none: a revoked share, a
  // deleted file, a mistyped link and a halted connection need four different
  // things from Bill, and only he can tell which one he is looking at.
  let item;
  try {
    item = await graph.resolveSharingUrl(parsed.data.url);
  } catch (e) {
    if (e instanceof DocIngestSharingUrlError) {
      return NextResponse.json({ error: 'unrecognized_url', message: e.message }, { status: 400 });
    }
    if (e instanceof DocIngestAccessDeniedError) {
      return NextResponse.json(
        {
          error: 'access_denied',
          message:
            'That document exists, but it is not shared with the Vision service account. ' +
            'Ask the owner to share it with docs-dr3@svdp.us, then register the link again.',
        },
        { status: 403 },
      );
    }
    if (e instanceof DocIngestNotFoundError) {
      return NextResponse.json(
        {
          error: 'not_found',
          message:
            'Microsoft has no document at that link — it was deleted, moved, or the sharing ' +
            'link was revoked.',
        },
        { status: 404 },
      );
    }
    if (e instanceof DocIngestHaltedError || e instanceof DocIngestNotConnectedError) {
      // Both messages are written for an operator and name the fix (the connect
      // page), so they are safe and useful to pass through verbatim.
      return NextResponse.json({ error: 'not_connected', message: e.message }, { status: 503 });
    }
    return NextResponse.json(
      {
        error: 'graph_unavailable',
        message: 'Microsoft did not answer. Nothing was registered — try again in a minute.',
      },
      { status: 502 },
    );
  }

  // ── Register ──────────────────────────────────────────────────────────────
  try {
    const source = await registerSharedItem(prisma, graph, item);

    await writeAudit({
      actor_user_id: ctx.userId,
      action: source.created ? 'insert' : 'update',
      table_name: 'doc_sources',
      row_id: source.id,
      after: {
        drive_id: source.driveId,
        item_id: source.itemId,
        display_name: source.displayName,
        owner_upn: source.ownerUpn,
        web_url: source.webUrl,
        kind: source.kind,
        // The provenance is the point of the audit row: this source did not come
        // from an enumeration, a named admin asked for it by URL.
        registered_via: 'sharing_url',
        already_registered: !source.created,
      },
    });

    return NextResponse.json({
      ok: true,
      created: source.created,
      sourceId: source.id,
      name: source.displayName,
      ownerUpn: source.ownerUpn,
      kind: source.kind,
    });
  } catch {
    // Never leak internals — an error here can describe the store.
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
