// ADR-0046 D4 — the AP approval queue. Org reach only (admin or all_sites —
// Morena/Janette are provisioned as all_sites managers = the approver set as
// data). AP requests are org-level accounting records, not site-scoped. Vision
// creates requests from mailbox ingestion; the approver decides here, first
// action wins, and Vision mails the decision to the fixed recipient list.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentOpsViewer } from '@/lib/ops/viewer';
import { hasOrgReach } from '@/lib/ops/reach';
import { ApQueueClient } from './ApQueueClient';

export const dynamic = 'force-dynamic';

export default async function ApQueuePage() {
  const identity = await currentOpsViewer();
  if (!identity) redirect('/login?next=/dashboard/ops/ap');
  if (!hasOrgReach(identity.viewer)) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-white">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">The AP approval queue is for admins and all-sites managers.</p>
        <Link href="/" className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <Link href="/" className="text-sm underline opacity-90">
          ← Back to dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Vendor-invoice approvals</h1>
        <p className="mt-1 text-sm opacity-75">
          Accounting mails an approval request; Vision turns each valid message into a request below.
          Review the invoice and approve or reject — first action wins. Vision emails the decision to the
          configured accounting recipients for Great Plains filing.
        </p>
        <ApQueueClient />
      </div>
    </main>
  );
}
