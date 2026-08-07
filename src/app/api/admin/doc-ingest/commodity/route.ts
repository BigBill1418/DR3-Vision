// ADR-0080 Phase 2 — the commodity audit-coverage read, over HTTP.
//
// ── GET ONLY. There is deliberately no mutation here ────────────────────────
// The terex sibling route (`../terex/route.ts`) exposes a POST that confirms or
// discards a staged batch. This one does not, and that is a decision rather than
// an omission:
//
//   1. A confirm writes an OPERATOR'S NAME against the batch (O-2). It is a
//      person's attestation that the reading was read, so the only correct actor
//      is a person. An endpoint an agent can reach is an endpoint an agent can
//      press, and an agent pressing it would put Bill's name on work Bill has not
//      seen. Bill's confirm goes through the existing operator path.
//   2. The reconciliation rules this data would eventually feed — what counts as
//      a divergence, which source wins — are DEFERRED pending a stakeholder
//      interview and are explicitly out of scope. Nothing here compares this
//      document to anything.
//
// If a confirm path is ever added it belongs in its own reviewed change with its
// own audit trail, not as a second verb bolted onto a read.

import { NextResponse } from 'next/server';
import { checkAdmin } from '@/lib/auth-helpers';
import {
  computeCommodityCoverage,
  sitesWithCommodityCoverage,
  type CommodityScope,
} from '@/lib/doc-ingest/commodity-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const gate = await checkAdmin();
  if (!gate.ok) return NextResponse.json({ error: 'forbidden' }, { status: gate.status });

  const url = new URL(req.url);
  const rawScope = url.searchParams.get('scope');
  // An unrecognised scope is REFUSED, never coerced to a default: silently
  // answering a different question than the one asked is how a caller ends up
  // reading staged rows believing they are confirmed.
  if (rawScope !== null && rawScope !== 'confirmed' && rawScope !== 'staged') {
    return NextResponse.json({ error: 'invalid_scope' }, { status: 400 });
  }
  const scope: CommodityScope = rawScope ?? 'confirmed';

  const sites = await sitesWithCommodityCoverage();
  const requested = url.searchParams.get('site');

  // The client may only name a site that actually has absorbed rows. The id is
  // checked against the server's own list rather than passed through to the
  // query — a site id is a scoping decision and scoping decisions are made here
  // (hard rule #2).
  const scoped = requested === null ? sites : sites.filter((s) => s.id === requested);
  if (requested !== null && scoped.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const coverage = await Promise.all(
    scoped.map(async (site) => ({
      site,
      coverage: await computeCommodityCoverage(site.id, { scope }),
    })),
  );

  return NextResponse.json({ scope, sites: coverage });
}
