// ADR-0049 D9 — the admin workbook-sync surface: sources (add/edit/enable), recent
// run ledger (counts, errors), and the cutover control (parity soft-gate). Admin-
// role only (checkAdmin) per CLAUDE.md hard rule #2.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { checkAdmin } from '@/lib/auth-helpers';
import { adminMessages as AM } from '@/app/admin/messages';
import { prisma } from '@/lib/prisma';
import { hasParitySignoff } from '@/lib/workbook-sync/parity-signoff';
import { WORKBOOK_SYNC_SURFACE } from '@/lib/workbook-sync/surface';
import { WorkbookSyncClient, type SiteOption, type SourceRow, type RunRow, type CutoverRow } from './WorkbookSyncClient';

export const dynamic = 'force-dynamic';

export default async function AdminWorkbookSyncPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/workbook-sync');
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">{AM.forbiddenHeading}</h1>
        <p className="mt-2 text-dr3-mist-dim">{AM.forbiddenBody}</p>
        <Link href={HOME_ROUTE} className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline">
          Back
        </Link>
      </main>
    );
  }

  const [sites, sources, runs, surfaces] = await Promise.all([
    prisma.site.findMany({ select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
    prisma.workbookSource.findMany({ orderBy: { created_at: 'asc' } }),
    prisma.workbookSyncRun.findMany({ orderBy: { started_at: 'desc' }, take: 25 }),
    prisma.rolloutSurface.findMany({ where: { kind: 'workbook_sync', surface_code: WORKBOOK_SYNC_SURFACE } }),
  ]);
  const siteCode = new Map(sites.map((s) => [s.id, s.code]));

  const sourceRows: SourceRow[] = sources.map((s) => ({
    id: s.id,
    siteId: s.site_id,
    siteCode: siteCode.get(s.site_id) ?? s.site_id,
    driveUpn: s.drive_upn,
    folderPath: s.folder_path,
    shareUrl: s.share_url,
    namingPattern: s.naming_pattern,
    isSyncing: s.is_syncing,
    lastPolledISO: s.last_polled_at ? s.last_polled_at.toISOString() : null,
    lastFileName: s.last_file_name,
  }));

  const runRows: RunRow[] = runs.map((r) => ({
    id: r.id,
    siteCode: siteCode.get(r.site_id) ?? r.site_id,
    startedISO: r.started_at.toISOString(),
    status: r.status,
    transportMode: r.transport_mode,
    fileName: r.file_name,
    changesDetected: r.changes_detected,
    cutoverNoop: r.cutover_noop,
    rowsUpserted: r.rows_upserted,
    rowsOverwritten: r.rows_overwritten,
    rowsSkippedMidedit: r.rows_skipped_midedit,
    error: r.error_text,
  }));

  const surfaceStateBySite = new Map(surfaces.map((s) => [s.site_id ?? '', s.rollout_state]));
  const cutoverRows: CutoverRow[] = await Promise.all(
    sources.map(async (s) => ({
      siteId: s.site_id,
      siteCode: siteCode.get(s.site_id) ?? s.site_id,
      surfaceState: (surfaceStateBySite.get(s.site_id) as 'pilot' | 'live' | undefined) ?? 'pilot',
      hasSurface: surfaceStateBySite.has(s.site_id),
      paritySignoff: await hasParitySignoff(s.site_id),
    })),
  );

  const siteOptions: SiteOption[] = sites
    .filter((s) => !sources.some((src) => src.site_id === s.id))
    .map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link href="/admin" className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline">
          ← Admin
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Workbook sync (ADR-0049)</h1>
        <p className="mt-2 max-w-3xl text-sm text-dr3-mist-dim">
          Mirrors each site&rsquo;s monthly Woodland daily-log workbook from Kelsey&rsquo;s OneDrive into Vision every
          10 minutes (business hours, PT). Pre-cutover the <strong>workbook wins</strong> — a disagreeing
          Vision-captured day is overwritten with an audit entry. A source is born <strong>disabled</strong>; enable it
          only once the <code>Files.Read.All</code> grant is live. The cutover flip stops sync and archives every
          monthly file to R2.
        </p>
        <WorkbookSyncClient sources={sourceRows} runs={runRows} cutovers={cutoverRows} siteOptions={siteOptions} />
      </div>
    </main>
  );
}
