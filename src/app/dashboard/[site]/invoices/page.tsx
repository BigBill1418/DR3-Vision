// ADR-0041 — manager invoices surface (list + generate). Site-scoped (hard rule
// #2). Desktop, English-first (manager/office surface, not an operator iPad).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { InvoicesClient } from './InvoicesClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function InvoicesPage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/invoices`);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-white">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">This area is restricted.</p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-10 text-white">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          &larr; Back to dashboard
        </Link>
        <h1 className="mt-4 text-3xl font-bold">Invoices — {result.ctx.siteName}</h1>
        <p className="mt-2 max-w-3xl text-sm opacity-80">
          MRC invoices are <strong>generated</strong> from Vision data — never hand-entered. Every line is a query
          result with provenance. Generate a draft, review each line against its source rows, then approve.
        </p>
        <InvoicesClient siteCode={siteCode} />
      </div>
    </main>
  );
}
