// ADR-0045 D2 — the Updates / board-pack review surface. Org reach only
// (admin or all_sites). Vision drafts; the reviewer edits the markdown, finalizes
// (audited), then copies the rendered HTML and sends it from their OWN mail.
// There is deliberately no send button anywhere on this surface.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentOpsViewer } from '@/lib/ops/viewer';
import { hasOrgReach } from '@/lib/ops/reach';
import { DigestsClient } from './DigestsClient';

export const dynamic = 'force-dynamic';

export default async function DigestsPage() {
  const identity = await currentOpsViewer();
  if (!identity) redirect('/login?next=/dashboard/ops/digests');
  if (!hasOrgReach(identity.viewer)) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-white">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">The digest review surface is for admins and all-sites managers.</p>
        <Link href="/" className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-10 text-white">
      <div className="mx-auto max-w-5xl">
        <Link href="/" className="text-sm underline opacity-90">
          ← Back to dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">DR3 Updates &amp; board digests</h1>
        <p className="mt-1 text-sm opacity-75">
          Vision drafts each digest; you edit, finalize, then copy the HTML and send it from your own
          mail. Vision never sends these on your behalf.
        </p>
        <DigestsClient />
      </div>
    </main>
  );
}
