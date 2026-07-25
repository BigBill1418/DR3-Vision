import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { prisma } from '@/lib/prisma';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';

export const dynamic = 'force-dynamic';

// Operator name picker. Per ADR-0004 the first step of the iPad sign-in:
// list active operators at the device's site, tap the name, then enter
// the PIN on the next screen. Ordered last-seen-recent first so the
// previous-shift operator hits the top.

type Props = { params: Promise<{ site: string }> };

export default async function OperatorSitePage({ params }: Props) {
  const { site: siteCode } = await params;
  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) notFound();

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);

  const operators = await prisma.user.findMany({
    where: {
      role: 'operator',
      is_active: true,
      // Exclude soft-deleted operators. A `deleted_at` row can still be
      // `is_active`, so without this it would appear in the picker and pass
      // the PIN — but the ADR-0053 revocation kill-switch empties the session
      // immediately, bouncing the operator with no working shift. Hide them
      // from selection entirely (ADR-0061).
      deleted_at: null,
      primary_site_id: site.id,
    },
    select: {
      id: true,
      name: true,
      last_login_at: true,
    },
    orderBy: [{ last_login_at: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
  });

  return (
    <main className="min-h-screen bg-black px-6 pb-10 pt-20 text-white">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <header className="flex items-center justify-between gap-4">
          <Image
            src="/brand/dr3-vision-logo.jpg"
            alt="DR3-Vision"
            width={1168}
            height={784}
            priority
            className="h-16 w-auto"
          />
          <span className="rounded-md bg-white/10 px-3 py-1 text-sm font-medium uppercase tracking-wide text-white/80">
            {site.name}
          </span>
        </header>

        <h1 className="text-2xl font-semibold">{t('name_picker.heading')}</h1>

        {operators.length === 0 ? (
          <p className="text-white/70">{t('name_picker.no_operators', { site: site.name })}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {operators.map((op) => (
              <li key={op.id}>
                <Link
                  href={`/operator/${site.code}/${op.id}`}
                  className="block rounded-lg bg-white/5 px-4 py-6 text-center text-lg font-semibold text-white transition-colors hover:bg-white/10"
                >
                  {op.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
