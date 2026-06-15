import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { tryBonusAccess } from '@/lib/bonus/access';
import { listPendingForApprover } from '@/lib/bonus/amendment-requests';
import { AmendmentQueue, type RequestRow } from './AmendmentQueue';
import { HOME_ROUTE } from '@/lib/routes';

export const dynamic = 'force-dynamic';

export default async function AmendmentsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?next=/bonus/amendments');

  const gate = await tryBonusAccess(undefined);
  if (!gate.ok) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 text-dr3-mist-dim">Amendment review requires bonus access.</p>
        <Link
          href={HOME_ROUTE}
          className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
        >
          Back to dashboard
        </Link>
      </main>
    );
  }

  const raw = await listPendingForApprover(
    gate.ctx.userId,
    gate.ctx.isAdmin,
    gate.ctx.isAdmin ? null : gate.ctx.siteId,
  );
  // `old_value` / `new_value` are stored as JSONB (Prisma `JsonValue`); their
  // runtime shape is the `{ mattress_count, note }` snapshot the service writes.
  // Coerce at this boundary so the client component gets the narrow row type.
  const requests: RequestRow[] = raw.map((r) => ({
    ...r,
    old_value: r.old_value as RequestRow['old_value'],
    new_value: r.new_value as RequestRow['new_value'],
  }));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/bonus"
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
        >
          ← Back to bonus
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Pending amendments</h1>
        <p className="text-sm text-dr3-mist-dim">
          Review prior-day edit requests. Approving will apply the change to the daily entry and
          notify Bill. Rejecting requires a reason.
        </p>

        <AmendmentQueue requests={requests} />
      </div>
    </main>
  );
}
