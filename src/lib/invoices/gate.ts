// ADR-0041 D4 — the generation gate.
//
// Generating an APPROVABLE (non-draft) invoice for a window requires the ADR-0039
// billing trust gate clean for that window: open/acknowledged findings on
// gate-contributing checks at or above the configured severity BLOCK generation,
// with the finding list attached to a typed refusal (logged per D6). A
// super-admin may override (audited justification, ADR-0033 tripwire philosophy),
// recorded by `recordGateOverride` as an append-only audit_log row that this
// evaluator reads to permit generation despite an active blocking finding.
//
// DRAFT (preview) generation does NOT call the gate — a preview is clearly
// marked non-approvable and never freezes a number.

import type { PrismaClient } from '@prisma/client';
import { gateForWindow, type GateFinding } from '@/lib/audit/billing-gate';
import { resolveCheckConfigs, type CheckConfigRow } from '@/lib/audit/config';
import type { CheckCode, Severity } from '@/lib/audit/types';
import type { FindingStatus } from '@/lib/audit/lifecycle';

export interface WindowGateResult {
  blocked: boolean;
  overridden: boolean;
  blockingFindings: Array<{ id: string; checkCode: CheckCode; severity: Severity }>;
  /** Distinct gate-blocking check codes — surfaced in the refusal + D6 log. */
  findingCodes: CheckCode[];
}

/** Generation of an approvable invoice was refused by the trust gate (D4). */
export class InvoiceGateBlockedError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly context: {
      siteId: string;
      windowStartISO: string;
      windowEndISO: string;
      findingCodes: CheckCode[];
    },
  ) {
    super(
      `billing trust gate blocks approvable generation for ${context.windowStartISO}..${context.windowEndISO}: ` +
        `${context.findingCodes.length} blocking finding code(s) [${context.findingCodes.join(', ')}] — ` +
        `resolve the findings or record a super-admin override`,
    );
    this.name = 'InvoiceGateBlockedError';
  }
}

const OVERRIDE_LABEL = 'billing-gate-override';

/** Audit `row_id` shape `recordGateOverride` writes for a window override. */
function overrideRowId(siteId: string, windowStartISO: string, windowEndISO: string): string {
  return `gate:${siteId}:${windowStartISO}:${windowEndISO}`;
}

function dbDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/**
 * Evaluate the trust gate for an invoice window. A finding contributes when it
 * OVERLAPS the window (`finding.window_start <= windowEnd && finding.window_end
 * >= windowStart`) and is active — `gateForWindow` then applies the
 * blocks-billing + min-severity policy. An override for the EXACT window flips
 * `blocked` to false (but `overridden` stays true so callers record it).
 */
export async function evaluateWindowGate(
  db: PrismaClient,
  siteId: string,
  windowStartISO: string,
  windowEndISO: string,
): Promise<WindowGateResult> {
  const start = dbDate(windowStartISO);
  const end = dbDate(windowEndISO);

  const [findingRows, configRows, override] = await Promise.all([
    db.auditFinding.findMany({
      where: {
        site_id: siteId,
        status: { in: ['open', 'acknowledged'] },
        window_start: { lte: end },
        window_end: { gte: start },
      },
      select: { id: true, check_code: true, severity: true, status: true },
    }),
    db.auditCheckConfig.findMany({ where: { OR: [{ site_id: null }, { site_id: siteId }] } }),
    db.auditLog.findFirst({
      where: {
        actor_label: OVERRIDE_LABEL,
        table_name: 'audit_findings',
        row_id: overrideRowId(siteId, windowStartISO, windowEndISO),
      },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    }),
  ]);

  const findings: GateFinding[] = findingRows.map((r) => ({
    id: r.id,
    checkCode: r.check_code as CheckCode,
    severity: r.severity as Severity,
    status: r.status as FindingStatus,
  }));

  const configs = resolveCheckConfigs(siteId, configRows as unknown as CheckConfigRow[]);
  const result = gateForWindow(findings, configs);
  const overridden = override != null;

  return {
    blocked: result.blocked && !overridden,
    overridden,
    blockingFindings: result.blockingFindings.map((f) => ({
      id: f.id,
      checkCode: f.checkCode,
      severity: f.severity,
    })),
    findingCodes: [...new Set(result.blockingFindings.map((f) => f.checkCode))],
  };
}
