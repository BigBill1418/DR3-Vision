// C7 — Deadline compliance: MyMRC entry lateness vs contract clocks. Inbound 3
// business days, processed 1 business day, outbound 3 business days — with the
// outbound clock starting at EOD, not ticket time (Janette Q1: the Material #
// only exists at end-of-day MyMRC entry). Business days come from config.params
// (seeded) and skip weekends + the supplied per-site holiday set.
//
// A record submitted after its deadline day → a `date_mismatch` finding. A
// record still unsubmitted whose deadline has passed as of the run day → the
// same finding (overdue). A historical run (`asOfISO` undefined) treats any
// unsubmitted record as overdue (the data shows it never landed in MyMRC).

import type {
  AuditWindow,
  CheckConfig,
  Finding,
  InboundLegRow,
  OutboundLegRow,
  ProcessedLegRow,
} from '../types';
import { businessDayAddISO, instantToPacificDayISO, makeFinder } from './helpers';

export interface C7Input {
  inbound: readonly InboundLegRow[];
  processed: readonly ProcessedLegRow[];
  outbound: readonly OutboundLegRow[];
}

function paramDays(config: CheckConfig, key: string, fallback: number): number {
  const v = config.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function c7Deadline(
  window: AuditWindow,
  input: C7Input,
  config: CheckConfig,
  holidays: Date[] = [],
): Finding[] {
  if (!config.enabled) return [];
  const finding = makeFinder('c7_deadline', window, config);
  const out: Finding[] = [];

  const inboundDays = paramDays(config, 'inbound_business_days', 3);
  const processedDays = paramDays(config, 'processed_business_days', 1);
  const outboundDays = paramDays(config, 'outbound_business_days', 3);

  const evaluate = (args: {
    clock: 'inbound' | 'processed' | 'outbound';
    ref: string;
    startDayISO: string;
    businessDays: number;
    submittedAtISO: string | null;
  }): void => {
    const deadlineISO = businessDayAddISO(args.startDayISO, args.businessDays, holidays);
    if (args.submittedAtISO) {
      const submittedDayISO = instantToPacificDayISO(args.submittedAtISO);
      if (submittedDayISO > deadlineISO) {
        out.push(
          finding({
            kind: 'date_mismatch',
            keys: [args.clock, args.ref, 'late'],
            legARef: args.ref,
            legBRef: null,
            expected: { deadline: deadlineISO },
            actual: { submitted: submittedDayISO },
            detail: { clock: args.clock, businessDays: args.businessDays, start: args.startDayISO },
          }),
        );
      }
      return;
    }
    // Unsubmitted: overdue if the deadline day has passed as of the run day, or
    // always on a historical run (asOfISO undefined).
    const overdue = window.asOfISO === undefined || window.asOfISO > deadlineISO;
    if (overdue) {
      out.push(
        finding({
          kind: 'date_mismatch',
          keys: [args.clock, args.ref, 'overdue'],
          legARef: args.ref,
          legBRef: null,
          expected: { deadline: deadlineISO },
          actual: { submitted: null },
          detail: { clock: args.clock, businessDays: args.businessDays, start: args.startDayISO, overdue: true },
        }),
      );
    }
  };

  for (const r of input.inbound) {
    evaluate({
      clock: 'inbound',
      ref: r.id,
      startDayISO: r.businessDateISO,
      businessDays: inboundDays,
      submittedAtISO: r.mymrcSubmittedAtISO,
    });
  }
  for (const r of input.processed) {
    evaluate({
      clock: 'processed',
      ref: r.id,
      startDayISO: r.productionDateISO,
      businessDays: processedDays,
      submittedAtISO: r.mymrcSubmittedAtISO,
    });
  }
  for (const r of input.outbound) {
    // The outbound clock starts at EOD close, not ticket/ship time.
    const startDayISO = r.eodClosedAtISO ? instantToPacificDayISO(r.eodClosedAtISO) : r.shipDateISO;
    evaluate({
      clock: 'outbound',
      ref: r.id,
      startDayISO,
      businessDays: outboundDays,
      submittedAtISO: r.mymrcSubmittedAtISO,
    });
  }

  return out;
}
