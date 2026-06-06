// Internal period-close cron endpoint (ADR-0019.1 §3/§6, T-204; supersedes the
// monthly T-125 close — URL path preserved per ADR-0019.1 §7 so bookmarks /
// existing callers don't break).
//
// Daily at 17:30 America/Los_Angeles, the fleet cron (`scripts/bonus-period-close.mjs`)
// POSTs here. We transition every draft pay-period whose `period_end` is the
// Pacific calendar today to `pending_signatures` (via the state machine,
// audited), then email the facility-manager signer for each newly-closed period
// (signature-request, fail-open). On a non-period-end day no period matches, so
// the run is a clean no-op.
//
// INTERNAL-ONLY: like /metrics and /internal/bonus-pdf, any request carrying a
// `cf-connecting-ip` header (i.e. anything arriving via the public Cloudflare
// tunnel) gets a 404. The cron reaches it over loopback inside the fleet network.
// An optional `INTERNAL_CRON_TOKEN` adds a bearer check when set (defense in depth).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { closePayPeriodsDueForSignature } from '@/lib/bonus/state-machine';
import { notifyPendingSigner } from '@/lib/bonus/signature-notifications';
import { log } from '@/lib/observability/logger';
import { appToday } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  // Public-tunnel requests are not allowed to drive the cron.
  if (req.headers.get('cf-connecting-ip')) {
    return new NextResponse('Not Found', { status: 404 });
  }
  const requiredToken = process.env['INTERNAL_CRON_TOKEN'];
  if (requiredToken) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${requiredToken}`) {
      return new NextResponse('Not Found', { status: 404 });
    }
  }

  // Pass Pacific "today" (the @db.Date-shaped key) as `now`: the cron fires at
  // 17:30 America/Los_Angeles, which is already past UTC midnight, so a raw
  // `new Date()` would resolve to the wrong calendar day (hence wrong period_end
  // match) for the whole evening. `appToday()` keys off the Pacific zone.
  const { transitioned } = await closePayPeriodsDueForSignature(prisma as never, appToday());

  // Email the first signer for each newly-closed month (fail-open; never throws).
  const notified: string[] = [];
  for (const monthId of transitioned) {
    try {
      const r = await notifyPendingSigner(monthId);
      if (r.notified) notified.push(monthId);
    } catch (err) {
      log.error({ monthId, err }, '[close-months] signature-request email failed (non-fatal)');
    }
  }

  log.info(
    { closed: transitioned.length, notified: notified.length },
    '[close-months] run complete',
  );
  return NextResponse.json({ closed: transitioned, notified });
}
