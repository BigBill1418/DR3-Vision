// ADR-0108 — retune one commodity's outlier band without a deploy.
//
// The whole reason the band is a table and not a constant. The seeded numbers
// were measured from one revision of one workbook on one date; Rick and Janette
// will move them once they have seen what the first pass surfaces. A threshold
// that needs a deploy to move is a threshold nobody moves, and it quietly stops
// being a question somebody asked and starts being the definition of normal.
//
// ── What this route cannot do ──────────────────────────────────────────────
// It edits a LOOK-AT-THIS line. It does not confirm, discard, promote or
// otherwise touch any absorbed row, and it opens no alert path: nothing on this
// endpoint can cause a message to be sent to anybody. Changing a bound changes
// which loads a person sees highlighted next time they open the page.
//
// Admin only, matching every other `/api/admin/doc-ingest/*` route.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bounds are deliberately generous rather than opinionated — an operator is
 * allowed to set a line this code would not have chosen. They exist to keep a
 * typo from writing a value the arithmetic cannot use: a `spread_ratio` at or
 * below 1 is a zero-width band, and a non-positive `k` or median has no band at
 * all. Those are the same conditions the reader treats as "no spread", so the
 * DB CHECK constraints and `resolveBound` agree.
 */
const Body = z.object({
  id: z.string().min(1),
  enabled: z.boolean().optional(),
  medianLbs: z.number().finite().positive().max(10_000_000).optional(),
  spreadRatio: z.number().finite().min(1).max(100).optional(),
  k: z.number().finite().positive().max(99).optional(),
  minSampleN: z.number().int().positive().max(100_000).optional(),
});

export async function PATCH(req: Request): Promise<Response> {
  const gate = await checkAdmin();
  if (!gate.ok) return NextResponse.json({ error: 'forbidden' }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const { id, ...edits } = parsed.data;

  // An empty PATCH is a caller bug, not a no-op to absorb quietly.
  if (Object.keys(edits).length === 0) {
    return NextResponse.json({ error: 'nothing_to_change' }, { status: 400 });
  }

  const before = await prisma.outboundVarianceConfig.findUnique({ where: { id } });
  if (before === null) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const updated = await prisma.outboundVarianceConfig.update({
    where: { id },
    data: {
      ...(edits.enabled === undefined ? {} : { enabled: edits.enabled }),
      ...(edits.medianLbs === undefined ? {} : { median_lbs: edits.medianLbs }),
      ...(edits.spreadRatio === undefined ? {} : { spread_ratio: edits.spreadRatio }),
      ...(edits.k === undefined ? {} : { k: edits.k }),
      ...(edits.minSampleN === undefined ? {} : { min_sample_n: edits.minSampleN }),
    },
  });

  // Who moved the line, and from what to what. A bound that changes with no
  // trace makes every later reading of the page unexplainable.
  log.info(
    {
      configId: id,
      commodity: updated.commodity,
      actor: gate.ctx.userId,
      from: {
        enabled: before.enabled,
        medianLbs: Number(before.median_lbs),
        spreadRatio: Number(before.spread_ratio),
        k: Number(before.k),
        minSampleN: before.min_sample_n,
      },
      to: {
        enabled: updated.enabled,
        medianLbs: Number(updated.median_lbs),
        spreadRatio: Number(updated.spread_ratio),
        k: Number(updated.k),
        minSampleN: updated.min_sample_n,
      },
    },
    '[outbound-variance] look-at-this band retuned',
  );

  return NextResponse.json({
    id: updated.id,
    commodity: updated.commodity,
    enabled: updated.enabled,
    medianLbs: Number(updated.median_lbs),
    spreadRatio: Number(updated.spread_ratio),
    k: Number(updated.k),
    minSampleN: updated.min_sample_n,
  });
}
