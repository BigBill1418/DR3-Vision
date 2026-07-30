// ADR-0049 D8 — cutover archival to R2.
//
// On the cutover flip, every monthly `.xlsm` that was syncing for the site is
// copied to R2 at `workbooks/{siteCode}/{yearMonth}.xlsm` (immutable, forever). We
// enumerate the source folder via the SAME read transport, filter to files matching
// the source's naming pattern, download each and PUT it. Fail-soft: an R2-unconfig
// or a per-file transport error is recorded (skipped/failed) but NEVER fails the
// cutover flip — the flip is the authoritative state change (D7).

import type { PrismaClient } from '@prisma/client';
import { putWorkbookArchive } from '@/lib/r2';
import { selectFilesTransport } from '@/lib/msgraph-files';
import type { FilesTransport, FilesTransportLogger } from '@/lib/msgraph-files';
import { fileNameMatchesPattern, yearMonthKeyFromFileName } from './naming';

export interface ArchiveResult {
  siteId: string;
  archivedKeys: string[];
  filesConsidered: number;
  skipped: boolean; // true when nothing was written (R2 unconfigured, or no files)
  error: string | null;
}

export interface ArchiveArgs {
  db: PrismaClient;
  siteId: string;
  siteCode: string;
  transport?: FilesTransport;
  log?: FilesTransportLogger;
}

export async function archiveWorkbooksToR2(args: ArchiveArgs): Promise<ArchiveResult> {
  const { db, siteId, siteCode } = args;
  const log = args.log ?? (() => undefined);
  const result: ArchiveResult = {
    siteId,
    archivedKeys: [],
    filesConsidered: 0,
    skipped: true,
    error: null,
  };

  const source = await db.workbookSource.findUnique({ where: { site_id: siteId } });
  if (!source) {
    result.error = 'no workbook_source configured for site';
    return result;
  }

  let transport: FilesTransport;
  try {
    transport = args.transport ?? (await selectFilesTransport(log));
    const files = await transport.listFolder(source.drive_upn, source.folder_path);
    const monthly = files.filter((f) => fileNameMatchesPattern(source.naming_pattern, f.name));
    result.filesConsidered = monthly.length;

    for (const f of monthly) {
      const yearMonth = yearMonthKeyFromFileName(source.naming_pattern, f.name);
      if (!yearMonth) continue;
      try {
        const bytes = await transport.downloadFile(source.drive_upn, f.id);
        const key = await putWorkbookArchive({ siteCode, yearMonth, bytes });
        if (key) {
          result.archivedKeys.push(key);
          result.skipped = false;
        }
      } catch (e) {
        log('warn', `[workbook-archive] ${siteCode} ${f.name} failed (non-fatal): ${describe(e)}`);
      }
    }
  } catch (e) {
    // Whole-folder failure (403 / transport) — recorded, never rethrown.
    result.error = describe(e);
    log(
      'error',
      `[workbook-archive] ${siteCode} listFolder failed (non-fatal for the flip): ${result.error}`,
    );
  }

  return result;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
