import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { getLocale } from '@/i18n/get-locale';
import { getManagerDictionary } from '@/i18n/dictionary';
import { translate } from '@/i18n/dictionary';

// Dashboard landing post-login. Server component — pulls the manager
// dictionary directly through `getManagerDictionary` rather than
// `useT()` so it can render synchronously.

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const locale = await getLocale();
  const dict = getManagerDictionary(locale);
  const t = (key: string, vars?: Record<string, string | number>) => translate(dict, key, vars);

  const sites = await prisma.site.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  });

  const visibleSites =
    session.user.role === 'admin'
      ? sites
      : sites.filter((s) => s.id === session.user.primary_site_id);

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-12 text-dr3-cream">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{t('dashboard.header_title')}</h1>
              <p className="text-sm text-dr3-cream/70">
                {t('dashboard.signed_in_as', {
                  name: session.user.name ?? '',
                  role: session.user.role,
                })}
              </p>
            </div>
            {session.user.role === 'admin' ? (
              <Link
                href="/admin/users"
                className="inline-flex items-center gap-2 rounded-md bg-dr3-green-dark/40 px-3 py-1.5 text-sm font-medium text-dr3-cream transition-colors hover:bg-dr3-green-dark/70"
                data-testid="dashboard-admin-link"
              >
                {t('dashboard.admin_link')}
              </Link>
            ) : null}
          </div>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">{t('dashboard.sites_heading')}</h2>
          {visibleSites.length === 0 ? (
            <p className="text-dr3-cream/70">{t('dashboard.sites_empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visibleSites.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/dashboard/${s.code}`}
                    className="block rounded-md bg-dr3-green-dark/40 px-4 py-3 text-lg font-medium text-dr3-cream transition-colors hover:bg-dr3-green-dark/70"
                  >
                    {s.name} <span className="text-sm text-dr3-cream/60">({s.code})</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
