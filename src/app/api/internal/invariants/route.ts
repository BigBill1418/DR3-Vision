// Internal cron entry point for the production data-invariant suite.
//
// Same posture as every other `/api/internal/**` route: `guardInternalCron` 404s
// anything that arrived via the public tunnel and requires the bearer in prod.
//
// READ-ONLY. The suite diagnoses production state and records nothing; the only
// side effect is the ADR-0037 notification, and `notify=false` removes even that.
// `src/lib/invariants/readonly.guard.test.ts` fails the build if a write verb ever
// appears in the suite.
//
// Always 200 when the run completed, even with violations. The findings are the
// PAYLOAD, not the status: a non-2xx would make the cron wrapper log a failure and
// retry a read-only scan, and would make "the suite found problems" look identical
// to "the suite could not run" — the one distinction this whole module exists to
// preserve. A run that could not happen at all still throws to a 500.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardInternalCron } from '@/lib/internal-auth';
import { INVARIANTS } from '@/lib/invariants/registry';
import type { Invariant } from '@/lib/invariants/types';
import { notifyInvariantReport } from '@/lib/invariants/notify';
import { runInvariants } from '@/lib/invariants/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  /** Publish the ADR-0037 digest. Default true; `false` is the dry-run an operator
   *  uses to read the current state without consuming the daily cooldown window. */
  notify: z.boolean().optional(),
  /** Fixed as-of instant (ISO), for reproducing a past run. Default now. */
  now: z.string().datetime().optional(),
  /** Restrict to specific invariant ids — for testing ONE new invariant in prod
   *  without publishing a digest that pretends the whole suite ran. */
  only: z.array(z.string()).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const { notify = true, only } = parsed.data;
  const now = parsed.data.now ? new Date(parsed.data.now) : new Date();

  const selected = only ? INVARIANTS.filter((i: Invariant) => only.includes(i.id)) : INVARIANTS;
  const report = await runInvariants(selected, { now });

  // A filtered run must not publish the daily digest — its `blind` and its counts
  // describe a subset, and a subset reported as the whole is a false all-clear.
  const publish = notify && !only;
  const notified = publish ? await notifyInvariantReport(report) : { published: [] };

  return NextResponse.json({
    ...report,
    // Decimal/Date never reach here — every check returns plain strings — so the
    // JSON is stable enough for an operator to diff between runs.
    notified: notified.published,
    notifySkipped: publish ? null : only ? 'filtered_run' : 'notify=false',
  });
}
