// ADR-0017 — admin Settings panel: edit-user page.

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { getUser } from '@/lib/admin-users';
import { adminMessages as M } from '@/app/admin/messages';
import { UserEditForm } from './UserEditForm';
import { buildUsersListHref, pickUsersListParams, type UsersListSearchParams } from '../list-url';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<UsersListSearchParams>;
}

export default async function EditUserPage({ params, searchParams }: PageProps) {
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

  // Return the admin to the filtered list they came from, not the bare one.
  const view = pickUsersListParams(await searchParams);
  const backHref = buildUsersListHref({
    ...view,
    site: view.site && sites.some((s) => s.code === view.site) ? view.site : undefined,
  });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href={backHref}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {M.pageTitle}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{M.form.editHeading}</h1>
          <p className="text-sm text-dr3-mist-dim">
            {user.name} <span className="capitalize">({user.role})</span>
          </p>
        </header>
        <UserEditForm user={user} sites={sites} isSelf={isSelf} backHref={backHref} />
      </div>
    </main>
  );
}
