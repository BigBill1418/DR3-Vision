// ADR-0039 — read-side queries for the findings review surface. Site-scoped per
// CLAUDE.md hard rule #2 (every read filters by site_id).

import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type { CheckCode, FindingKind, Severity } from './types';
import type { FindingStatus, CauseCategory } from './lifecycle';

export interface FindingFilter {
  status?: FindingStatus;
  checkCode?: CheckCode;
  severity?: Severity;
}

export interface FindingListItem {
  id: string;
  checkCode: CheckCode;
  kind: FindingKind;
  severity: Severity;
  status: FindingStatus;
  windowStart: Date;
  windowEnd: Date;
  legARef: string | null;
  legBRef: string | null;
  causeCategory: CauseCategory | null;
  firstDetectedAt: Date;
  lastSeenAt: Date;
}

export interface FindingDetail extends FindingListItem {
  expected: Prisma.JsonValue;
  actual: Prisma.JsonValue;
  detail: Prisma.JsonValue;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  importId: string | null;
}

const LIST_SELECT = {
  id: true,
  check_code: true,
  finding_kind: true,
  severity: true,
  status: true,
  window_start: true,
  window_end: true,
  leg_a_ref: true,
  leg_b_ref: true,
  cause_category: true,
  first_detected_at: true,
  last_seen_at: true,
} satisfies Prisma.AuditFindingSelect;

type ListRow = Prisma.AuditFindingGetPayload<{ select: typeof LIST_SELECT }>;

function toListItem(r: ListRow): FindingListItem {
  return {
    id: r.id,
    checkCode: r.check_code as CheckCode,
    kind: r.finding_kind as FindingKind,
    severity: r.severity as Severity,
    status: r.status as FindingStatus,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    legARef: r.leg_a_ref,
    legBRef: r.leg_b_ref,
    causeCategory: (r.cause_category as CauseCategory | null) ?? null,
    firstDetectedAt: r.first_detected_at,
    lastSeenAt: r.last_seen_at,
  };
}

export async function listFindings(
  siteId: string,
  filter: FindingFilter = {},
  limit = 200,
): Promise<FindingListItem[]> {
  const rows = await prisma.auditFinding.findMany({
    where: {
      site_id: siteId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.checkCode ? { check_code: filter.checkCode } : {}),
      ...(filter.severity ? { severity: filter.severity } : {}),
    },
    select: LIST_SELECT,
    orderBy: [{ severity: 'desc' }, { last_seen_at: 'desc' }],
    take: limit,
  });
  return rows.map(toListItem);
}

export interface FindingStats {
  open: number;
  acknowledged: number;
  resolved: number;
  notAnIssue: number;
}

export async function findingStats(siteId: string): Promise<FindingStats> {
  const grouped = await prisma.auditFinding.groupBy({
    by: ['status'],
    where: { site_id: siteId },
    _count: { _all: true },
  });
  const stats: FindingStats = { open: 0, acknowledged: 0, resolved: 0, notAnIssue: 0 };
  for (const g of grouped) {
    const n = g._count._all;
    if (g.status === 'open') stats.open = n;
    else if (g.status === 'acknowledged') stats.acknowledged = n;
    else if (g.status === 'resolved') stats.resolved = n;
    else if (g.status === 'not_an_issue') stats.notAnIssue = n;
  }
  return stats;
}

export async function getFinding(siteId: string, id: string): Promise<FindingDetail | null> {
  const r = await prisma.auditFinding.findFirst({
    where: { id, site_id: siteId },
  });
  if (!r) return null;
  return {
    ...toListItem(r),
    expected: r.expected,
    actual: r.actual,
    detail: r.detail_json,
    resolutionNote: r.resolution_note,
    resolvedAt: r.resolved_at,
    resolvedByUserId: r.resolved_by_user_id,
    importId: r.import_id,
  };
}
