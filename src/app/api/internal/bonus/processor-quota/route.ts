// ADR-0071 — internal processor-quota digest endpoint.
//
// `scripts/processor-quota-cron.mjs` is a thin Pacific scheduler that sleeps
// until the configured send moment and POSTs here; all real work (evaluate,
// suppress-or-send, log) runs compiled inside the Next app. The daemon imports
// no TypeScript — the same build contract every other cron in this repo follows.
//
// INTERNAL-ONLY: `guardInternalCron` 404s anything carrying `cf-connecting-ip`
// (i.e. arriving via the public tunnel) and enforces the bearer token when set.
// This endpoint can mail three managers a list of named employees' performance;
// it must not be reachable from the internet.
//
// `dryRun` is the operator's safe read: it evaluates the week and returns the
// counts WITHOUT sending or writing a log row, so a threshold can be sanity-
// checked against real data before anyone's inbox is involved.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardInternalCron } from '@/lib/internal-auth';
import { prisma } from '@/lib/prisma';
import { runProcessorQuotaDigest } from '@/lib/bonus/processor-quota-digest';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z
  .object({
    /** Evaluate a specific Monday instead of the last complete week. */
    weekStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .optional();

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const raw = await req.json().catch(() => undefined);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const body = parsed.data ?? {};

  try {
    const outcomes = await runProcessorQuotaDigest({
      db: prisma,
      ...(body.weekStart !== undefined ? { weekStartISO: body.weekStart } : {}),
      ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
    });
    log.info(
      { sites: outcomes.length, dryRun: body.dryRun === true },
      '[processor-quota] run complete',
    );
    return NextResponse.json({ outcomes });
  } catch (err) {
    log.error({ err }, '[processor-quota] run threw');
    return NextResponse.json(
      { error: 'run_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
