// ADR-0017 — admin Settings panel: create-user page.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { adminMessages as M } from '@/app/admin/messages';
import { UserCreateForm } from './UserCreateForm';
import { buildUsersListHref, pickUsersListParams, type UsersListSearchParams } from '../list-url';

export const dynamic = 'force-dynamic';

export default async function NewUserPage({
  searchParams,
}: {
  searchParams: Promise<UsersListSearchParams>;
}) {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/users/new');
    redirect('/admin/users');
  }

  const sites = await prisma.site.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  });

  // Carry the list's view state through the round trip so save/cancel land
  // back on the list the admin was working in, and so the site select
  // defaults to the site they had filtered to (rather than always the
  // alphabetically-first site).
  const view = pickUsersListParams(await searchParams);
  const initialSiteCode =
    view.site && sites.some((s) => s.code === view.site) ? view.site : undefined;
  const backHref = buildUsersListHref({ ...view, site: initialSiteCode });

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
          <h1 className="text-3xl font-bold tracking-tight">{M.form.createHeading}</h1>
        </header>
        <UserCreateForm sites={sites} backHref={backHref} initialSiteCode={initialSiteCode} />
      </div>
    </main>
  );
}
