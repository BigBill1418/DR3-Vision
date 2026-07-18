// ADR-0041 amendment §3.4 — the pilot/production delivery chokepoint.
//
// This module is THE launch safety net. Until Rick reconciles and signs off,
// every invoice is `pilot`: its preview goes to Bill + Rick (the pilot roster)
// and NOWHERE else. A `production` invoice is the ONLY mode whose delivery plan
// resolves to MRC.
//
// The safety guarantee is STRUCTURAL, not procedural. `planInvoiceDelivery` is a
// TOTAL function on `mode`: the `pilot` branch has no path — none — that returns
// MRC recipients or `sendsToMrc: true`. No configuration, no argument, no roster
// state can make a pilot plan reach MRC. Any future MRC sender MUST obtain its
// recipients from this plan (never from the raw invoice), and MUST call
// `assertProductionForMrc` before it addresses an envelope to MRC — so a pilot
// invoice cannot be delivered to MRC even by a caller that forgot to inspect the
// plan.
//
// (No live MRC sender exists yet — the boundary ships first so the sender is a
// consumer of a proven-safe plan, not a refactor. This mirrors how the frozen
// `invoice_export` boundary shipped ahead of the GP adapter.)

import { prisma } from '@/lib/prisma';
import type { InvoiceMode } from './types';
import type { InvoiceView } from './view';

/** Where an invoice's preview/delivery is allowed to go. */
export type DeliveryChannel = 'pilot_preview' | 'mrc_production';

export interface DeliveryRecipient {
  email: string;
  name: string | null;
}

/**
 * The resolved delivery plan for an invoice. `sendsToMrc` is the single boolean a
 * sender checks — it is `true` iff and only if the channel is `mrc_production`.
 * A `pilot_preview` plan carries the pilot roster and `sendsToMrc: false`, always.
 */
export interface DeliveryPlan {
  mode: InvoiceMode;
  channel: DeliveryChannel;
  recipients: DeliveryRecipient[];
  sendsToMrc: boolean;
}

/**
 * A pilot invoice was pushed toward MRC delivery. This is a caller bug (a sender
 * that skipped the plan), never a data condition — so it fails loud (422).
 */
export class PilotDeliveryError extends Error {
  readonly status = 422 as const;
  constructor(readonly invoiceId: string) {
    super(
      `invoice ${invoiceId} is in PILOT mode and cannot be delivered to MRC — ` +
        `flip its (site, kind) to production first (ADR-0041 amendment §3.4)`,
    );
    this.name = 'PilotDeliveryError';
  }
}

/**
 * The pure chokepoint. TOTAL on `mode`:
 *   - `pilot`      → pilot_preview to `pilotRecipients`, `sendsToMrc: false`. The
 *                    `mrcRecipients` argument is deliberately IGNORED here — a
 *                    pilot plan can never carry an MRC address by construction.
 *   - `production` → mrc_production to `mrcRecipients`, `sendsToMrc: true`.
 * There is no third branch and no way for `pilot` to yield MRC recipients — the
 * structural guarantee the safety net rests on. Unit-tested exhaustively.
 */
export function planInvoiceDelivery(
  mode: InvoiceMode,
  pilotRecipients: readonly DeliveryRecipient[],
  mrcRecipients: readonly DeliveryRecipient[],
): DeliveryPlan {
  if (mode === 'production') {
    return {
      mode,
      channel: 'mrc_production',
      recipients: [...mrcRecipients],
      sendsToMrc: true,
    };
  }
  // pilot (the default, and any non-production value): preview to the pilot
  // roster ONLY. `mrcRecipients` is never read on this path.
  return {
    mode: 'pilot',
    channel: 'pilot_preview',
    recipients: [...pilotRecipients],
    sendsToMrc: false,
  };
}

/**
 * The tripwire a future MRC sender calls immediately before it addresses an
 * envelope to MRC. Throws {@link PilotDeliveryError} for a pilot invoice — a
 * pilot invoice is structurally undeliverable to MRC even for a caller that did
 * not consult {@link planInvoiceDelivery}.
 */
export function assertProductionForMrc(invoice: Pick<InvoiceView, 'id' | 'mode'>): void {
  if (invoice.mode !== 'production') throw new PilotDeliveryError(invoice.id);
}

/** Active pilot roster (Bill + Rick), name included for a preview greeting. */
export async function loadPilotRecipients(): Promise<DeliveryRecipient[]> {
  const rows = await prisma.invoicePilotRecipient.findMany({
    where: { active: true },
    orderBy: { email: 'asc' },
    select: { email: true, name: true },
  });
  return rows.map((r) => ({ email: r.email, name: r.name }));
}

/**
 * Resolve the full delivery plan for a stored invoice. Reads the pilot roster
 * from the DB; the production MRC roster is NOT built yet (OR's MRC identity is
 * pending Mary and CLAUDE.md forbids real MRC sends during the pilot), so a
 * production plan currently carries an EMPTY MRC roster — a future sender treats
 * that as refuse-and-page (like `ap_decision_recipients`), never a silent drop.
 * The pilot path — the ONLY path exercised during launch — is fully wired.
 */
export async function resolveInvoiceDeliveryPlan(invoice: InvoiceView): Promise<DeliveryPlan> {
  const pilotRecipients = await loadPilotRecipients();
  const mrcRecipients: DeliveryRecipient[] = []; // pending Mary (§4.2) + pilot policy
  return planInvoiceDelivery(invoice.mode, pilotRecipients, mrcRecipients);
}
