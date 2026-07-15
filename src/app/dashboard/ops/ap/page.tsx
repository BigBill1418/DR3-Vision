// ADR-0046 D4 + §3 amendment — the AP approval queue. Access is the ap_approvers
// ROSTER, not org reach: admin OR an active roster approver (single-site managers
// Rick/Janette are full approvers via the roster, even without all_sites). This
// mirrors the route guard (requireApApprover / canActOnApRequest) so the page and
// the /api/ops/ap/* routes agree on who may approve — gating the page on
// hasOrgReach (the pre-amendment model) locked single-site roster approvers out of
// the queue while the routes let them act. AP requests are org-level accounting
// records; Vision creates them from mailbox ingestion, the approver decides here
// (first action wins), and Vision mails the decision to the configured recipients.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentOpsViewer } from '@/lib/ops/viewer';
import { canActOnApRequest } from '@/lib/ap/approvers';
import { ApQueueClient } from './ApQueueClient';

export const dynamic = 'force-dynamic';

export default async function ApQueuePage() {
  const identity = await currentOpsViewer();
  if (!identity) redirect('/login?next=/dashboard/ops/ap');
  const allowed = await canActOnApRequest({ role: identity.viewer.role, userId: identity.userId });
  if (!allowed) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 text-dr3-mist-dim">
          The AP approval queue is for admins and active AP approvers.
        </p>
        <Link href="/" className="mt-6 text-sm text-dr3-cyan underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  // ADR-0051 — the AP surface adopts the Vision logo-keyed deep-space theme
  // (was ADR-0008 green). The floor iPads (/operator) stay green; this is the
  // office/manager sweep. Reuse the VisionShell nebula + starfield atmosphere so
  // the queue reads as one product with the dashboard front door.
  return (
    <main className="relative min-h-screen overflow-hidden bg-dr3-space px-6 py-10 text-dr3-mist">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -right-48 -top-48 h-[40rem] w-[40rem] rounded-full bg-dr3-cyan/10 blur-[150px]" />
        <div className="absolute -bottom-40 -left-40 h-[32rem] w-[32rem] rounded-full bg-dr3-steel/25 blur-[150px]" />
      </div>
      <div className="relative mx-auto max-w-6xl">
        <Link href="/" className="text-sm text-dr3-cyan underline">
          ← Back to dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-dr3-mist">
          Vendor-invoice approvals
        </h1>
        <p className="mt-1 text-sm text-dr3-mist-dim">
          Accounting mails an approval request; Vision turns each valid message into a request
          below. Review the invoice and approve or reject — first action wins. Vision emails the
          decision to the configured accounting recipients for Great Plains filing.
        </p>
        <ApQueueClient />
      </div>
    </main>
  );
}
