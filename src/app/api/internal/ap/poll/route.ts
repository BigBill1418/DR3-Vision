// ADR-0046 D5 — internal AP mailbox poll endpoint.
//
// Same loopback-guarded internal-route pattern as the bonus/survey/audit crons:
// any request carrying a `cf-connecting-ip` header (public Cloudflare tunnel) gets
// a 404; the thin `scripts/ap-poll-cron.mjs` daemon reaches it over the compose
// network. An optional `INTERNAL_CRON_TOKEN` adds a bearer check (defense in
// depth). `/api/internal/ap/` is exempted in public-paths.ts (+ regression test)
// so the auth middleware never 307s this session-less POST to /login (the standing
// ADR-0036 lesson).
//
// The route does all the real work inside the Next app via `runApPoll` (transport
// select, delta, ingest, move, ledger-always, deadman), so the daemon imports no
// TS. A poll-run ledger row is ALWAYS written, including on throw.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { runApPoll } from '@/lib/ap/poll';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const result = await runApPoll({
    log: (level, message) => log[level]({ op: 'ap-poll' }, message),
  });
  log.info(
    {
      op: 'ap-poll',
      status: result.status,
      mode: result.transportMode,
      listed: result.messagesListed,
      created: result.requestsCreated,
      followups: result.followupsCreated,
      quarantined: result.quarantined,
      moved: result.moved,
    },
    '[ap-poll] run complete',
  );
  return NextResponse.json(result);
}
