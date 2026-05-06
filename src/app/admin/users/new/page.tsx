// ADR-0017 — admin Settings panel: create-user page.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { adminMessages as M } from '@/app/admin/messages';
import { UserCreateForm } from './UserCreateForm';

export const dynamic = 'force-dynamic';

export default async function NewUserPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/users/new');
    redirect('/admin/users');
  }

  const sites = await prisma.site.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  });

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-12 text-dr3-cream">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin/users"
            className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
          >
            ← {M.pageTitle}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{M.form.createHeading}</h1>
        </header>
        <UserCreateForm sites={sites} />
      </div>
    </main>
  );
}
