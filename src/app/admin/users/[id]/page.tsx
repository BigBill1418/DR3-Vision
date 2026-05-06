// ADR-0017 — admin Settings panel: edit-user page.

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { getUser } from '@/lib/admin-users';
import { adminMessages as M } from '@/app/admin/messages';
import { UserEditForm } from './UserEditForm';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditUserPage({ params }: PageProps) {
  const { id } = await params;
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect(`/login?next=/admin/users/${id}`);
    redirect('/admin/users');
  }

  const [sites, user] = await Promise.all([
    prisma.site.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    }),
    getUser(id),
  ]);
  if (!user) notFound();

  const isSelf = gate.ok && gate.ctx.userId === user.id;

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
          <h1 className="text-3xl font-bold tracking-tight">{M.form.editHeading}</h1>
          <p className="text-sm text-dr3-cream/70">
            {user.name} <span className="capitalize">({user.role})</span>
          </p>
        </header>
        <UserEditForm user={user} sites={sites} isSelf={isSelf} />
      </div>
    </main>
  );
}
