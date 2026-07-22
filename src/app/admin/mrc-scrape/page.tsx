// ADR-0057 — MyMRC admin-credential surface (page).
//
// Admin-only. Renders the credential-entry form seeded with the NON-SECRET
// status (configured?, username, when/who) resolved server-side via
// `getMymrcCredentialStatus` — which never SELECTs the ciphertext, so no secret
// reaches this render or the client bundle. The password is write-only: the form
// shows a "set" indicator when configured but never the value.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { getMymrcCredentialStatus } from '@/lib/mymrc/credential-store';
import { adminMessages as M } from '@/app/admin/messages';
import { MrcScrapePanels } from './MrcScrapePanels';

export const dynamic = 'force-dynamic';

export default async function MrcScrapePage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/mrc-scrape');
    redirect('/admin');
  }

  const status = await getMymrcCredentialStatus(prisma);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {M.backToDashboard}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{M.mrc.heading}</h1>
          <p className="text-sm text-dr3-mist-dim">{M.mrc.subtitle}</p>
        </header>
        <MrcScrapePanels
          configured={status.configured}
          username={status.username}
          updatedAt={status.updatedAt ? status.updatedAt.toISOString() : null}
          updatedBy={status.updatedBy}
        />
      </div>
    </main>
  );
}
