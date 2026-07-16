// O-2 (2026-07-16) — /admin/file-drop. Admin-only capture inbox (role=admin per
// hard rule #2, matching /admin/users). SSR-renders the current manifest; the
// client handles upload + annotation. Deep-space theme to match the repainted
// admin surfaces.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { checkAdmin } from '@/lib/auth-helpers';
import { adminMessages as AM } from '@/app/admin/messages';
import { listFileDrops } from '@/lib/file-drop/list';
import { FileDropClient } from './FileDropClient';

export const dynamic = 'force-dynamic';

export default async function AdminFileDropPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/file-drop');
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">{AM.forbiddenHeading}</h1>
        <p className="mt-2 text-dr3-mist-dim">{AM.forbiddenBody}</p>
        <Link
          href={HOME_ROUTE}
          className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          {AM.backToDashboard}
        </Link>
      </main>
    );
  }

  const rows = await listFileDrops();

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {AM.backToDashboard}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{AM.fileDrop.title}</h1>
          <p className="text-sm text-dr3-mist-dim">{AM.fileDrop.subtitle}</p>
        </header>
        <FileDropClient initialRows={rows} />
      </div>
    </main>
  );
}
