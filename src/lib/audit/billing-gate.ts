// ADR-0039 D5 — the billing trust gate (Rick's bar, pre-wired for P2).
//
// A window with open findings above a configurable severity BLOCKS P2 invoice
// generation for that window (soft-block: a super-admin can override with an
// audited justification — mirroring the ADR-0033 reconciliation-tripwire
// philosophy at the month scale). This module ships the gate CHECK; P2 consumes
// it. Pure `gateForWindow` + an audited override API.

import type { PrismaClient } from '@prisma/client';
import { gateMinBlockingSeverity } from './config';
import type { CheckCode, CheckConfig, Severity } from './types';
import { severityRank } from './types';
import type { FindingStatus } from './lifecycle';

/** The minimal finding shape the gate reasons over. */
export interface GateFinding {
  id: string;
  checkCode: CheckCode;
  severity: Severity;
  status: FindingStatus;
}

export interface GateResult {
  blocked: boolean;
  blockingFindings: GateFinding[];
  minBlockingSeverity: Severity;
}

/**
 * Decide whether a window's findings block billing. A finding blocks when it is
 * still active (open or acknowledged — a resolved/not_an_issue finding never
 * blocks), its check contributes to the gate (`blocksBilling`), and its severity
 * is at or above the configured threshold (D5, stored in `audit_check_config`).
 */
export function gateForWindow(
  findings: readonly GateFinding[],
  configs: Map<CheckCode, CheckConfig>,
): GateResult {
  const minBlockingSeverity = gateMinBlockingSeverity(configs);
  const minRank = severityRank(minBlockingSeverity);

  const blockingFindings = findings.filter((f) => {
    if (f.status !== 'open' && f.status !== 'acknowledged') return false;
    const cfg = configs.get(f.checkCode);
    if (!cfg || !cfg.blocksBilling) return false;
    return severityRank(f.severity) >= minRank;
  });

  return { blocked: blockingFindings.length > 0, blockingFindings, minBlockingSeverity };
}

// ────────────────────────────────────────────────────────────────────────
// Super-admin override (typed API — P2 consumes; audited, append-only)
// ────────────────────────────────────────────────────────────────────────

export interface GateOverrideArgs {
  db: PrismaClient;
  siteId: string;
  windowStartISO: string;
  windowEndISO: string;
  actorUserId: string;
  justification: string;
}

export type GateOverrideResult =
  | { ok: true }
  | { ok: false; reason: 'justification_required' };

/**
 * Record a super-admin override of the billing gate for a window. This is the
 * soft-block escape hatch (D5): it does not mutate findings — it writes an
 * append-only `audit_log` row that P2's invoice-generation path reads to permit
 * generation despite an active blocking finding. The caller is responsible for
 * having already enforced super-admin authorization.
 */
export async function recordGateOverride(args: GateOverrideArgs): Promise<GateOverrideResult> {
  if (!args.justification.trim()) return { ok: false, reason: 'justification_required' };

  await args.db.auditLog.create({
    data: {
      actor_user_id: args.actorUserId,
      actor_label: 'billing-gate-override',
      action: 'update',
      table_name: 'audit_findings',
      row_id: `gate:${args.siteId}:${args.windowStartISO}:${args.windowEndISO}`,
      after: {
        override: true,
        site_id: args.siteId,
        window_start: args.windowStartISO,
        window_end: args.windowEndISO,
        justification: args.justification.trim(),
      },
    },
  });

  return { ok: true };
}
