// ADR-0039 D2 — findings lifecycle: durable, deduplicated, audited.
//
// The decision core (`reconcileFindings`) is a PURE function so it is fully unit
// tested without a DB. The DB writer (`persistRun`) applies the plan inside a
// single transaction, writing a paired `audit_log` row for every create /
// reopen / auto-resolve (the house append-only-audit pattern). Findings NEVER
// mutate the underlying operational data — fixing happens in the source records
// via their own audited flows (D2).

import { Prisma, type PrismaClient } from '@prisma/client';
import { dayKeyUTCFromISO } from '@/lib/time';
import type { AuditWindow, CheckCode, Finding, JsonValue } from './types';

/** Coerce an optional JSON payload to a Prisma Json input (null → SQL NULL). */
function jsonInput(v: JsonValue | null | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return v === null || v === undefined ? Prisma.JsonNull : (v as Prisma.InputJsonValue);
}

export type FindingStatus = 'open' | 'acknowledged' | 'resolved' | 'not_an_issue';
export type CauseCategory =
  | 'data_entry'
  | 'operational'
  | 'external_mymrc'
  | 'template_defect'
  | 'unknown';

export const AUTO_RESOLVE_NOTE = 'auto: legs now agree';
const AUTO_PREFIX = 'auto:';

// ────────────────────────────────────────────────────────────────────────
// Pure reconcile core
// ────────────────────────────────────────────────────────────────────────

/** The minimal existing-finding shape the reconcile core reasons over. */
export interface ExistingFindingLite {
  id: string;
  fingerprint: string;
  status: FindingStatus;
  /** True when the finding was auto-resolved (resolution_note starts `auto:`). */
  autoResolved: boolean;
}

export interface RefreshItem {
  id: string;
  finding: Finding;
}

export interface ReconcilePlan {
  /** Fingerprints with no existing row → insert (status open). */
  toCreate: Finding[];
  /** Matched open/acknowledged/manually-closed rows → bump last_seen, refresh payload. */
  toRefresh: RefreshItem[];
  /** Matched auto-resolved rows that recur → reopen (status open) + refresh. */
  toReopen: RefreshItem[];
  /** Open/acknowledged rows absent from this run → auto-resolve. */
  toAutoResolve: string[];
}

/**
 * Diff freshly-computed findings against the existing rows the run's scope
 * covered. `existing` MUST already be scoped by the caller to the (site,
 * checks, window-overlap) universe the `computed` set covers — otherwise
 * unrelated findings could be auto-resolved.
 */
export function reconcileFindings(
  existing: readonly ExistingFindingLite[],
  computed: readonly Finding[],
): ReconcilePlan {
  const plan: ReconcilePlan = { toCreate: [], toRefresh: [], toReopen: [], toAutoResolve: [] };

  // Dedupe computed by fingerprint (guard — the fingerprint design makes this rare).
  const computedByFp = new Map<string, Finding>();
  for (const f of computed) if (!computedByFp.has(f.fingerprint)) computedByFp.set(f.fingerprint, f);

  const existingByFp = new Map<string, ExistingFindingLite>();
  for (const e of existing) existingByFp.set(e.fingerprint, e);

  for (const [fp, finding] of computedByFp) {
    const ex = existingByFp.get(fp);
    if (!ex) {
      plan.toCreate.push(finding);
      continue;
    }
    if (ex.status === 'resolved' && ex.autoResolved) {
      plan.toReopen.push({ id: ex.id, finding });
    } else {
      // open / acknowledged, and manual resolved / not_an_issue: keep the human
      // decision, but refresh last_seen + latest payload (the discrepancy persists).
      plan.toRefresh.push({ id: ex.id, finding });
    }
  }

  for (const e of existing) {
    if (computedByFp.has(e.fingerprint)) continue;
    if (e.status === 'open' || e.status === 'acknowledged') {
      plan.toAutoResolve.push(e.id);
    }
  }

  return plan;
}

/** Legal manual status transitions (D2 lifecycle). */
export function isAllowedTransition(from: FindingStatus, to: FindingStatus): boolean {
  if (from === to) return false;
  const map: Record<FindingStatus, FindingStatus[]> = {
    open: ['acknowledged', 'resolved', 'not_an_issue'],
    acknowledged: ['open', 'resolved', 'not_an_issue'],
    resolved: ['open'],
    not_an_issue: ['open'],
  };
  return map[from].includes(to);
}

// ────────────────────────────────────────────────────────────────────────
// DB application (thin; every mutation writes a paired audit_log row)
// ────────────────────────────────────────────────────────────────────────

function findingCreateData(f: Finding, importId: string | null): Prisma.AuditFindingUncheckedCreateInput {
  return {
    site_id: f.siteId,
    check_code: f.checkCode,
    window_start: dayKeyUTCFromISO(f.windowStartISO),
    window_end: dayKeyUTCFromISO(f.windowEndISO),
    severity: f.severity,
    finding_kind: f.kind,
    leg_a_ref: f.legARef,
    leg_b_ref: f.legBRef,
    expected: jsonInput(f.expected),
    actual: jsonInput(f.actual),
    detail_json: jsonInput(f.detail),
    fingerprint: f.fingerprint,
    import_id: importId,
  };
}

export interface PersistRunArgs {
  db: PrismaClient;
  window: AuditWindow;
  /** The checks actually evaluated this run (bounds the auto-resolve scope). */
  checkCodes: CheckCode[];
  computed: Finding[];
  /** e.g. 'system:audit-sweep' or 'system:retro-audit'. */
  actorLabel: string;
  importId?: string | null;
}

export interface PersistRunResult {
  opened: number;
  updated: number;
  resolved: number;
}

/**
 * Upsert-by-fingerprint the computed findings and auto-resolve the ones that
 * disappeared, all in one transaction. Returns lifecycle counts for the run
 * ledger.
 */
export async function persistRun(args: PersistRunArgs): Promise<PersistRunResult> {
  const { db, window, checkCodes, computed, actorLabel } = args;
  const runStart = dayKeyUTCFromISO(window.startISO);
  const runEnd = dayKeyUTCFromISO(window.endISO);

  // Scope: findings for this site + checks whose window OVERLAPS the run window.
  const existingRows = await db.auditFinding.findMany({
    where: {
      site_id: window.siteId,
      check_code: { in: checkCodes },
      status: { in: ['open', 'acknowledged'] },
      window_start: { lt: runEnd },
      window_end: { gt: runStart },
    },
    select: { id: true, fingerprint: true, status: true, resolution_note: true },
  });

  const existing: ExistingFindingLite[] = existingRows.map((r) => ({
    id: r.id,
    fingerprint: r.fingerprint,
    status: r.status as FindingStatus,
    autoResolved: (r.resolution_note ?? '').startsWith(AUTO_PREFIX),
  }));

  const plan = reconcileFindings(existing, computed);

  let opened = 0;
  let updated = 0;
  let resolved = 0;

  await db.$transaction(async (tx) => {
    for (const finding of plan.toCreate) {
      // Upsert guards against a create racing a concurrent run on the unique
      // fingerprint; on conflict we simply refresh last_seen.
      const created = await tx.auditFinding.upsert({
        where: { fingerprint: finding.fingerprint },
        create: findingCreateData(finding, args.importId ?? null),
        update: {
          last_seen_at: new Date(),
          expected: jsonInput(finding.expected),
          actual: jsonInput(finding.actual),
        } satisfies Prisma.AuditFindingUncheckedUpdateInput,
      });
      opened++;
      await tx.auditLog.create({
        data: {
          actor_label: actorLabel,
          action: 'insert',
          table_name: 'audit_findings',
          row_id: created.id,
          after: { fingerprint: finding.fingerprint, check_code: finding.checkCode, kind: finding.kind },
        },
      });
    }

    for (const item of plan.toRefresh) {
      await tx.auditFinding.update({
        where: { id: item.id },
        data: {
          last_seen_at: new Date(),
          expected: jsonInput(item.finding.expected),
          actual: jsonInput(item.finding.actual),
          detail_json: jsonInput(item.finding.detail),
          severity: item.finding.severity,
        } satisfies Prisma.AuditFindingUncheckedUpdateInput,
      });
      updated++;
    }

    for (const item of plan.toReopen) {
      await tx.auditFinding.update({
        where: { id: item.id },
        data: {
          status: 'open',
          resolved_at: null,
          resolved_by_user_id: null,
          resolution_note: null,
          last_seen_at: new Date(),
          expected: jsonInput(item.finding.expected),
          actual: jsonInput(item.finding.actual),
        } satisfies Prisma.AuditFindingUncheckedUpdateInput,
      });
      updated++;
      await tx.auditLog.create({
        data: {
          actor_label: actorLabel,
          action: 'update',
          table_name: 'audit_findings',
          row_id: item.id,
          after: { status: 'open', reason: 'auto-reopen: discrepancy recurred' },
        },
      });
    }

    for (const id of plan.toAutoResolve) {
      await tx.auditFinding.update({
        where: { id },
        data: { status: 'resolved', resolution_note: AUTO_RESOLVE_NOTE, resolved_at: new Date() },
      });
      resolved++;
      await tx.auditLog.create({
        data: {
          actor_label: actorLabel,
          action: 'update',
          table_name: 'audit_findings',
          row_id: id,
          after: { status: 'resolved', resolution_note: AUTO_RESOLVE_NOTE },
        },
      });
    }
  });

  return { opened, updated, resolved };
}

// ────────────────────────────────────────────────────────────────────────
// Manual status transitions (review surface)
// ────────────────────────────────────────────────────────────────────────

export interface TransitionArgs {
  db: PrismaClient;
  findingId: string;
  toStatus: FindingStatus;
  actorUserId: string;
  causeCategory?: CauseCategory;
  resolutionNote?: string;
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'illegal_transition' | 'cause_required' };

/**
 * Apply a manual status transition with a paired audit_log row in one
 * transaction. Moving to `resolved` / `not_an_issue` requires a cause category
 * (the D2 data-entry-vs-operational classification).
 */
export async function transitionFinding(args: TransitionArgs): Promise<TransitionResult> {
  const { db, findingId, toStatus } = args;
  const current = await db.auditFinding.findUnique({
    where: { id: findingId },
    select: { id: true, status: true },
  });
  if (!current) return { ok: false, reason: 'not_found' };

  const from = current.status as FindingStatus;
  if (!isAllowedTransition(from, toStatus)) return { ok: false, reason: 'illegal_transition' };

  const closing = toStatus === 'resolved' || toStatus === 'not_an_issue';
  if (closing && !args.causeCategory) return { ok: false, reason: 'cause_required' };

  const data: Prisma.AuditFindingUncheckedUpdateInput = { status: toStatus };
  if (args.causeCategory) data.cause_category = args.causeCategory;
  if (args.resolutionNote !== undefined) data.resolution_note = args.resolutionNote;
  if (closing) {
    data.resolved_by_user_id = args.actorUserId;
    data.resolved_at = new Date();
  } else if (toStatus === 'open') {
    data.resolved_at = null;
    data.resolved_by_user_id = null;
    data.resolution_note = null;
  }

  await db.$transaction(async (tx) => {
    await tx.auditFinding.update({ where: { id: findingId }, data });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: 'audit_findings',
        row_id: findingId,
        before: { status: from },
        after: {
          status: toStatus,
          cause_category: args.causeCategory ?? null,
          resolution_note: args.resolutionNote ?? null,
        },
      },
    });
  });

  return { ok: true };
}
