// ADR-0071 Amendment 1 — can the quota monitor prove it is alive?
//
// ADR-0071 shipped a correct exception alert and switched it off, pending a
// decision on the quota number. Nothing was wrong with that. What was wrong is
// that a switched-off monitor produced no evidence of any kind: the digest
// selected `enabled = true` configs, matched none, and returned `{"outcomes":[]}`
// without writing a row. For twelve days the cron fired daily at 06:00 PT and
// left behind precisely what a crashed cron would have left.
//
// This module turns the heartbeat in `processor_quota_runs` into the three
// states an operator actually needs, which are NOT two:
//
//   green  — a site is enabled and the monitor ran recently. Silence means
//            everyone met quota, and that reading can be trusted.
//   amber  — the monitor is running and is not going to mail anyone (every site
//            disabled, or none configured). Nothing is broken; a person chose
//            this, and the pill says so rather than implying coverage.
//   red    — the monitor has never run, or has not run inside the staleness
//            budget. This is the outage, and it is the one that is dangerous:
//            managers read no-email as "everyone met quota".
//
// Collapsing amber into green is how the original silence happened. Collapsing
// it into red pages someone about a deliberate setting. The distinction is the
// whole point of the amendment.

import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * How stale a heartbeat may get before the monitor is considered down.
 *
 * The cron fires DAILY at 06:00 PT, so the natural gap is 24h and a 24h budget
 * has zero slack: a deploy that recreates the container across the fire minute,
 * or the 25-hour Pacific day at the DST fall-back, would flip a perfectly
 * healthy monitor red. 36h tolerates one entirely missed fire, which is the
 * point at which something really is wrong — the daily schedule exists so a
 * failed Monday self-heals on Tuesday, and two consecutive misses defeat that.
 */
export const QUOTA_RUN_STALE_HOURS = 36;

export type QuotaHealthStatus = 'green' | 'amber' | 'red';

export interface QuotaMonitorHealth {
  status: QuotaHealthStatus;
  /** Operator-facing sentence. Says which of the three states, and why. */
  detail: string;
  /** Null only when the monitor has genuinely never completed a live run. */
  lastRunAt: Date | null;
  configsTotal: number;
  configsEnabled: number;
}

function hoursSince(then: Date, now: Date): number {
  return (now.getTime() - then.getTime()) / 3_600_000;
}

/** '3 hours ago' / '2 days ago' — a gap a human can judge at a glance. */
function ago(hours: number): string {
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.round(hours / 24);
  return `${d} days ago`;
}

/**
 * Read the monitor's standing state. Two indexed reads; safe to call on a
 * dashboard poll.
 *
 * Ordering of the checks is load-bearing. Staleness is evaluated BEFORE the
 * enabled count, because a stopped cron on an enabled site is the failure that
 * actually misleads people, and reporting it as "switched off" would describe a
 * broken system as a deliberate one.
 */
export async function loadProcessorQuotaHealth(
  db: Db,
  now: Date = new Date(),
): Promise<QuotaMonitorHealth> {
  const [configs, lastRun] = await Promise.all([
    db.processorQuotaConfig.findMany({ select: { enabled: true } }),
    db.processorQuotaRun.findFirst({
      orderBy: { ran_at: 'desc' },
      select: { ran_at: true, configs_total: true, configs_enabled: true },
    }),
  ]);

  const configsTotal = configs.length;
  const configsEnabled = configs.filter((c) => c.enabled).length;

  if (!lastRun) {
    return {
      status: 'red',
      detail:
        'Monitor has never run — no heartbeat recorded. Silence cannot be read as "everyone met quota".',
      lastRunAt: null,
      configsTotal,
      configsEnabled,
    };
  }

  const age = hoursSince(lastRun.ran_at, now);
  if (age > QUOTA_RUN_STALE_HOURS) {
    return {
      status: 'red',
      detail: `Monitor has not run since ${ago(age)} (budget ${QUOTA_RUN_STALE_HOURS}h) — no email is not evidence quota was met.`,
      lastRunAt: lastRun.ran_at,
      configsTotal,
      configsEnabled,
    };
  }

  if (configsTotal === 0) {
    return {
      status: 'amber',
      detail: `Monitor ran ${ago(age)} but no site is configured — nothing is being evaluated.`,
      lastRunAt: lastRun.ran_at,
      configsTotal,
      configsEnabled,
    };
  }

  if (configsEnabled === 0) {
    return {
      status: 'amber',
      detail: `Monitor ran ${ago(age)}; the weekly digest is switched off for all ${configsTotal} site${configsTotal === 1 ? '' : 's'} — nobody is being emailed.`,
      lastRunAt: lastRun.ran_at,
      configsTotal,
      configsEnabled,
    };
  }

  return {
    status: 'green',
    detail: `Ran ${ago(age)}; digest enabled for ${configsEnabled} of ${configsTotal} site${configsTotal === 1 ? '' : 's'}.`,
    lastRunAt: lastRun.ran_at,
    configsTotal,
    configsEnabled,
  };
}
