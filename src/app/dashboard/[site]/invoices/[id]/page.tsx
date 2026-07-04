// ADR-0041 — invoice detail (line drill-down, inline gate findings, prior-version
// diff, approve/void/supersede). Site-scoped (hard rule #2).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { InvoiceDetailClient } from './InvoiceDetailClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string; id: string }> };

export default async function InvoiceDetailPage({ params }: Props) {
  const { site: siteCode, id } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/invoices/${id}`);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-white">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <Link href={`/dashboard/${siteCode}/invoices`} className="mt-6 text-sm underline">
          Back to invoices
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-10 text-white">
      <div className="mx-auto max-w-4xl">
        <Link href={`/dashboard/${siteCode}/invoices`} className="text-sm underline opacity-90">
          &larr; Back to invoices
        </Link>
        <InvoiceDetailClient siteCode={siteCode} invoiceId={id} />
      </div>
    </main>
  );
}
