// ADR-0041 amendment §3.4 — the pilot/production delivery chokepoint.
//
// These pin the STRUCTURAL guarantee the launch safety net rests on: a pilot
// invoice can never resolve to MRC, by any input. If any of these fail, the
// safety net has a hole.

import { describe, expect, it } from 'vitest';
import {
  planInvoiceDelivery,
  assertProductionForMrc,
  PilotDeliveryError,
  type DeliveryRecipient,
} from './delivery';

const PILOT: DeliveryRecipient[] = [
  { email: 'bill.barnard@svdp.us', name: 'Bill Barnard' },
  { email: 'rick.albritton@svdp.us', name: 'Rick Albritton' },
];
const MRC: DeliveryRecipient[] = [{ email: 'billing@mrc.example', name: 'MRC AP' }];

describe('planInvoiceDelivery — pilot is structurally incapable of reaching MRC', () => {
  it('pilot → pilot_preview to the pilot roster, sendsToMrc:false', () => {
    const plan = planInvoiceDelivery('pilot', PILOT, MRC);
    expect(plan.channel).toBe('pilot_preview');
    expect(plan.sendsToMrc).toBe(false);
    expect(plan.recipients).toEqual(PILOT);
  });

  it('pilot IGNORES the MRC roster entirely — no MRC address can appear', () => {
    // Even handed a full MRC roster, the pilot plan carries ONLY the pilot roster.
    const plan = planInvoiceDelivery('pilot', PILOT, MRC);
    const emails = plan.recipients.map((r) => r.email);
    expect(emails).not.toContain('billing@mrc.example');
    expect(plan.recipients).not.toBe(MRC);
  });

  it('pilot with an EMPTY pilot roster still never falls through to MRC', () => {
    // A degenerate roster must never become a reason to reach MRC — it stays a
    // pilot plan with no recipients (a future sender treats that as refuse-and-page).
    const plan = planInvoiceDelivery('pilot', [], MRC);
    expect(plan.channel).toBe('pilot_preview');
    expect(plan.sendsToMrc).toBe(false);
    expect(plan.recipients).toEqual([]);
  });

  it('production → mrc_production to the MRC roster, sendsToMrc:true', () => {
    const plan = planInvoiceDelivery('production', PILOT, MRC);
    expect(plan.channel).toBe('mrc_production');
    expect(plan.sendsToMrc).toBe(true);
    expect(plan.recipients).toEqual(MRC);
  });

  it('sendsToMrc is true IFF the channel is mrc_production', () => {
    for (const mode of ['pilot', 'production'] as const) {
      const plan = planInvoiceDelivery(mode, PILOT, MRC);
      expect(plan.sendsToMrc).toBe(plan.channel === 'mrc_production');
    }
  });
});

describe('assertProductionForMrc — the MRC-send tripwire', () => {
  it('throws PilotDeliveryError for a pilot invoice', () => {
    expect(() => assertProductionForMrc({ id: 'inv-1', mode: 'pilot' })).toThrow(PilotDeliveryError);
    try {
      assertProductionForMrc({ id: 'inv-1', mode: 'pilot' });
    } catch (e) {
      expect((e as PilotDeliveryError).status).toBe(422);
      expect((e as PilotDeliveryError).invoiceId).toBe('inv-1');
    }
  });

  it('passes for a production invoice', () => {
    expect(() => assertProductionForMrc({ id: 'inv-2', mode: 'production' })).not.toThrow();
  });
});
