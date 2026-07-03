// ADR-0039 D3 — the nightly sweep engine (thin daemon → internal route → here).
//
// For each site it audits a trailing window (default 14 days, asOf = today). It
// always writes an `audit_runs` record and returns a summary — never a silent
// green with nothing done. The only ntfy is system-level: the run itself
// FAILING (hard rule #5 — operational findings never push). A healthy run is
// silent.
//
// The comparator wiring is injected via `runChecks` so this module never
// references a sibling Prisma model directly; `leg-fetchers.buildRunChecksForWindow`
// supplies that callback (wired in the internal sweep route + on-demand run
// route). If no callback is passed, the sweep is a clean no-op (still ledgered).

import type { PrismaClient } from '@prisma/client';
import { appTodayISO, dayISO, dayKeyUTCFromISO } from '@/lib/time';
import { publishNtfy, type PublishNtfyArgs, type PublishNtfyResult } from '@/lib/ntfy';
import { persistRun } from './lifecycle';
import type { AuditWindow, CheckCode, Finding } from './types';

/** Per-site comparator runner (supplied post-integration by the leg-fetchers). */
export type RunChecksForWindow = (
  window: AuditWindow,
) => Promise<{ checkCodes: CheckCode[]; findings: Finding[] }>;

export interface SweepSiteResult {
  siteId: string;
  siteCode: string;
  status: 'ok' | 'error';
  windowStartISO: string;
  windowEndISO: string;
  checksRun: CheckCode[];
  opened: number;
  updated: number;
  resolved: number;
  error?: string;
}

export interface SweepSummary {
  runs: SweepSiteResult[];
  failures: number;
}

export interface RunAuditSweepArgs {
  db: PrismaClient;
  /** Anchor day (Pacific ISO). Defaults to today. */
  nowISO?: string;
  windowDays?: number;
  /** Injected comparator runner. Absent ⇒ clean no-op (current integration state). */
  runChecks?: RunChecksForWindow;
  /** Injected ntfy publisher (test seam). */
  publish?: (args: PublishNtfyArgs) => Promise<PublishNtfyResult>;
}

function shiftDaysISO(iso: string, deltaDays: number): string {
  const d = dayKeyUTCFromISO(iso);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return dayISO(d);
}

/** Trigger label written to the `audit_runs` ledger. */
export type AuditTrigger = 'nightly_sweep' | 'on_demand' | 'retro_workbook';

export interface AuditSiteWindowArgs {
  db: PrismaClient;
  site: { id: string; code: string };
  window: AuditWindow;
  trigger: AuditTrigger;
  runChecks?: RunChecksForWindow;
  publish?: (args: PublishNtfyArgs) => Promise<PublishNtfyResult>;
}

/**
 * Audit ONE site over ONE window: run the injected comparators, persist the
 * finding lifecycle, write the `audit_runs` ledger row, and (on a thrown run)
 * page `dr3-vision-system`. Shared by the nightly sweep and the on-demand run
 * action. Never throws — a failure is captured in the returned result and the
 * error run record.
 */
export async function auditSiteWindow(args: AuditSiteWindowArgs): Promise<SweepSiteResult> {
  const { db, site, window, trigger } = args;
  const publish = args.publish ?? publishNtfy;
  const startISO = window.startISO;
  const endISO = window.endISO;
  try {
    const result = args.runChecks ? await args.runChecks(window) : { checkCodes: [] as CheckCode[], findings: [] as Finding[] };

    const lifecycle =
      result.checkCodes.length > 0
        ? await persistRun({
            db,
            window,
            checkCodes: result.checkCodes,
            computed: result.findings,
            actorLabel: `system:audit-${trigger}`,
          })
        : { opened: 0, updated: 0, resolved: 0 };

    await db.auditRun.create({
      data: {
        site_id: site.id,
        trigger,
        window_start: dayKeyUTCFromISO(startISO),
        window_end: dayKeyUTCFromISO(endISO),
        status: 'ok',
        checks_run: result.checkCodes,
        findings_opened: lifecycle.opened,
        findings_updated: lifecycle.updated,
        findings_resolved: lifecycle.resolved,
        finished_at: new Date(),
      },
    });

    return {
      siteId: site.id,
      siteCode: site.code,
      status: 'ok',
      windowStartISO: startISO,
      windowEndISO: endISO,
      checksRun: result.checkCodes,
      opened: lifecycle.opened,
      updated: lifecycle.updated,
      resolved: lifecycle.resolved,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort error run record — never let logging failure mask the page.
    try {
      await db.auditRun.create({
        data: {
          site_id: site.id,
          trigger,
          window_start: dayKeyUTCFromISO(startISO),
          window_end: dayKeyUTCFromISO(endISO),
          status: 'error',
          checks_run: [],
          error_text: message.slice(0, 1000),
          finished_at: new Date(),
        },
      });
    } catch {
      /* swallow — the page below is the durable signal */
    }
    await publish({
      topic: 'dr3-vision-system',
      title: `Audit ${trigger} failed for ${site.code}`,
      body: `The 3-way audit (${trigger}) threw for site ${site.code}: ${message.slice(0, 400)}`,
      priority: 'high',
      tags: ['audit', 'error', 'dr3-vision'],
      fingerprint: `audit-sweep-failed:${site.code}`,
      cooldownMs: 30 * 60 * 1000,
    });
    return {
      siteId: site.id,
      siteCode: site.code,
      status: 'error',
      windowStartISO: startISO,
      windowEndISO: endISO,
      checksRun: [],
      opened: 0,
      updated: 0,
      resolved: 0,
      error: message,
    };
  }
}

export async function runAuditSweep(args: RunAuditSweepArgs): Promise<SweepSummary> {
  const { db } = args;
  const windowDays = args.windowDays ?? 14;
  const todayISO = args.nowISO ?? appTodayISO();
  const startISO = shiftDaysISO(todayISO, -windowDays);
  const endISO = todayISO; // half-open [start, today)

  const sites = await db.site.findMany({ select: { id: true, code: true } });

  const runs: SweepSiteResult[] = [];
  let failures = 0;

  for (const site of sites) {
    const window: AuditWindow = { siteId: site.id, startISO, endISO, asOfISO: todayISO };
    const result = await auditSiteWindow({
      db,
      site,
      window,
      trigger: 'nightly_sweep',
      ...(args.runChecks ? { runChecks: args.runChecks } : {}),
      ...(args.publish ? { publish: args.publish } : {}),
    });
    if (result.status === 'error') failures++;
    runs.push(result);
  }

  return { runs, failures };
}
