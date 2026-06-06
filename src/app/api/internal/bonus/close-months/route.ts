// Internal month-close cron endpoint (ADR-0019 §2 + §5a, T-125 / fills the T-106
// auto-close gap).
//
// On the 1st of each month (00:05 America/Los_Angeles), the fleet cron POSTs here.
// We transition every draft month whose month has ended to `pending_signatures`
// (via the state machine, audited), then email the facility-manager signer for each
// newly-closed month (signature-request, fail-open).
//
// INTERNAL-ONLY: like /metrics and /internal/bonus-pdf, any request carrying a
// `cf-connecting-ip` header (i.e. anything arriving via the public Cloudflare
// tunnel) gets a 404. The cron reaches it over loopback inside the fleet network.
// An optional `INTERNAL_CRON_TOKEN` adds a bearer check when set (defense in depth).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { closeMonthsDueForSignature } from '@/lib/bonus/state-machine';
import { notifyPendingSigner } from '@/lib/bonus/signature-notifications';
import { log } from '@/lib/observability/logger';

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

  const { transitioned } = await closeMonthsDueForSignature(prisma as never, new Date());

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
