// ADR-0039 D4 — retro-audit workbook ingestion orchestration.
//
// Ties the pieces together: parse (staging rows w/ provenance) → persist the
// import + staging rows → run the Summary-recompute + site-alias checks →
// upsert findings (tagged import_id) → write an `audit_runs` retro row. The
// original xlsx is retained in R2 for evidence, keyed on the import row. NEVER
// writes to operational tables (staging only).

import { Prisma, type PrismaClient } from '@prisma/client';
import { dayKeyUTCFromISO } from '@/lib/time';
import { putWorkbookEvidence } from '@/lib/r2';
import { parseWorkbook } from './workbook/parser';
import { recomputeSummary, resolveInboundSites } from './workbook/summary-recompute';
import { persistRun } from './lifecycle';
import { defaultCheckConfigMap } from './config';
import type { AuditWindow, CheckCode, Finding, SiteAliasResolver } from './types';

export interface IngestWorkbookArgs {
  db: PrismaClient;
  siteId: string;
  uploadedByUserId: string;
  filename: string;
  buffer: Uint8Array;
  /** The month/period the workbook represents (drives the finding window). */
  window: AuditWindow;
  periodLabel?: string | null;
  resolver: SiteAliasResolver;
}

export interface IngestWorkbookResult {
  importId: string;
  templateGeneration: string;
  rowCount: number;
  findingsOpened: number;
}

const RETRO_CHECKS: CheckCode[] = ['summary_recompute'];

export async function ingestWorkbook(args: IngestWorkbookArgs): Promise<IngestWorkbookResult> {
  const { db, siteId, uploadedByUserId, filename, buffer, window } = args;

  const imp = await db.workbookImport.create({
    data: {
      site_id: siteId,
      original_filename: filename,
      period_label: args.periodLabel ?? null,
      status: 'parsing',
      uploaded_by_user_id: uploadedByUserId,
    },
    select: { id: true },
  });

  // Best-effort R2 evidence blob (keyed on the import row).
  const storageKey = await putWorkbookEvidence({ importId: imp.id, filename, bytes: buffer }).catch(() => null);

  try {
    const parsed = await parseWorkbook(buffer);

    if (parsed.stagingRows.length > 0) {
      await db.workbookImportRow.createMany({
        data: parsed.stagingRows.map((r) => ({
          import_id: imp.id,
          tab_name: r.tabName,
          row_index: r.rowIndex,
          col_ref: r.colRef,
          section: r.section,
          field_key: r.fieldKey,
          raw_value: r.rawValue,
          numeric_value: r.numericValue,
          site_name_raw: r.siteNameRaw,
          provenance: r.provenance as unknown as Prisma.InputJsonValue,
        })),
      });
    }

    const config = defaultCheckConfigMap().get('summary_recompute')!;
    const findings: Finding[] = [
      ...recomputeSummary(window, parsed, config),
      ...resolveInboundSites(window, parsed.inbound, args.resolver, config),
    ];

    const lifecycle = await persistRun({
      db,
      window,
      checkCodes: RETRO_CHECKS,
      computed: findings,
      actorLabel: 'system:retro-audit',
      importId: imp.id,
    });

    await db.auditRun.create({
      data: {
        site_id: siteId,
        trigger: 'retro_workbook',
        window_start: dayKeyUTCFromISO(window.startISO),
        window_end: dayKeyUTCFromISO(window.endISO),
        status: 'ok',
        checks_run: RETRO_CHECKS,
        findings_opened: lifecycle.opened,
        findings_updated: lifecycle.updated,
        findings_resolved: lifecycle.resolved,
        finished_at: new Date(),
      },
    });

    await db.workbookImport.update({
      where: { id: imp.id },
      data: {
        status: 'parsed',
        storage_key: storageKey,
        template_generation: parsed.templateGeneration,
        sheet_count: parsed.sheetCount,
        row_count: parsed.stagingRows.length,
      },
    });

    return {
      importId: imp.id,
      templateGeneration: parsed.templateGeneration,
      rowCount: parsed.stagingRows.length,
      findingsOpened: lifecycle.opened,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.workbookImport.update({
      where: { id: imp.id },
      data: { status: 'failed', parse_error: message.slice(0, 1000), storage_key: storageKey },
    });
    throw err;
  }
}
