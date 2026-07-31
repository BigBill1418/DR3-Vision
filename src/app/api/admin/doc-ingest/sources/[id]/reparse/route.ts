// ADR-0067 Amendment 8 §2 — re-parse an already-applied revision.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// `parse_summary` is computed at PARSE time, and a parse only happens when a new
// revision arrives. So when Amendment 8 fixed the header-row detection, the three
// documents already in the system kept their old summaries — headers still
// reading `["Woodland Trailer List 2025"]` — and would have kept them until
// somebody happened to edit the file in OneDrive. A code fix that reaches the
// data only by luck is not a fix.
//
// ── What it does NOT do, deliberately ──────────────────────────────────────
// It does NOT create a revision. The document's CONTENT has not changed; only our
// reading of it has. Minting a revision would claim Kelsey edited a file she did
// not touch, and would drag the whole delta machinery (guardrail comparison,
// anomaly staging, notifications) through a change that never happened.
//
// It does NOT touch `ctag` / `etag`. ADR-0067 Amendment 6 makes those the content
// markers a delta may supply but never remove, and a missing one must recover or
// alarm rather than read as `unchanged`. Re-parsing is orthogonal to change
// detection and must leave that machinery exactly as it found it.
//
// ── What it DOES change, stated plainly ─────────────────────────────────────
// The stored `parse_summary` for the revision — which is also the BASELINE the
// next guardrail comparison runs against. That is the point: the old baseline was
// built from title strings, so its aggregate check was comparing nothing. A
// corrected baseline is what gives the next real revision something to be
// compared to. The audit row records the before/after header shape so the change
// in baseline is visible rather than silent.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { getFileDropBytes } from '@/lib/r2';
import { parseDocument } from '@/lib/doc-ingest/parse';
import { writeAudit } from '@/lib/audit';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

function headerShape(summary: unknown): unknown {
  if (summary === null || typeof summary !== 'object') return null;
  const sheets = (summary as { sheets?: unknown }).sheets;
  if (!Array.isArray(sheets)) return null;
  return sheets.slice(0, 5).map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return {
      name: o['name'],
      headerRowIndex: o['headerRowIndex'] ?? null,
      headerConfidence: o['headerConfidence'] ?? null,
      headers: Array.isArray(o['headers']) ? (o['headers'] as unknown[]).slice(0, 12) : [],
    };
  });
}

export async function POST(_req: Request, { params }: Params): Promise<Response> {
  const gate = await checkAdmin();
  if (!gate.ok) return NextResponse.json({ error: 'forbidden' }, { status: gate.status });

  const { id } = await params;

  const source = await prisma.docSource.findUnique({
    where: { id },
    select: { id: true, display_name: true, content_type: true },
  });
  if (!source) return NextResponse.json({ error: 'source_not_found' }, { status: 404 });

  // The newest APPLIED revision — the one whose summary is in force. A staged
  // revision is deliberately left alone: it is waiting on a human decision, and
  // re-deriving its summary underneath that decision would change what is being
  // decided about.
  const version = await prisma.docSourceVersion.findFirst({
    where: { doc_source_id: id, applied_at: { not: null } },
    orderBy: { created_at: 'desc' },
    select: { id: true, r2_key: true, parse_summary: true },
  });
  if (!version) {
    return NextResponse.json({ error: 'no_applied_revision' }, { status: 404 });
  }
  if (!version.r2_key) {
    return NextResponse.json(
      {
        error: 'no_archived_object',
        message:
          'This revision has no archived object, and the stored summary keeps no cell values — there is nothing to re-read.',
      },
      { status: 409 },
    );
  }

  let bytes: Uint8Array | null = null;
  try {
    bytes = await getFileDropBytes(version.r2_key);
  } catch (e) {
    log.error({ err: e, sourceId: id }, '[doc-ingest reparse] R2 read failed');
    return NextResponse.json({ error: 'archive_unreadable' }, { status: 502 });
  }
  if (!bytes) return NextResponse.json({ error: 'archive_unreadable' }, { status: 502 });

  const parsed = await parseDocument(bytes, source.display_name, source.content_type ?? null);
  if (!parsed.ok) {
    // A parse failure must NOT overwrite a good stored summary with nothing.
    return NextResponse.json(
      { error: 'parse_failed', reason: parsed.reason, message: parsed.message },
      { status: 422 },
    );
  }

  const before = headerShape(version.parse_summary);

  await prisma.docSourceVersion.update({
    where: { id: version.id },
    data: { parse_summary: parsed.summary as unknown as object },
  });

  const after = headerShape(parsed.summary as unknown);

  await writeAudit({
    actor_user_id: gate.ctx.userId,
    action: 'update',
    table_name: 'doc_source_versions',
    row_id: version.id,
    before: { parse_summary_headers: before },
    after: {
      reparse: true,
      reason: 'ADR-0067 Am.8 — re-derive parse_summary with header-row detection',
      parse_summary_headers: after,
      // Named explicitly so a future reader knows the content did not change.
      content_unchanged: true,
      ctag_untouched: true,
    },
  });

  log.info(
    { sourceId: id, versionId: version.id },
    '[doc-ingest reparse] parse_summary re-derived',
  );

  return NextResponse.json({ reparsed: true, versionId: version.id, before, after });
}
