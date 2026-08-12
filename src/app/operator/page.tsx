import { prisma } from '@/lib/prisma';
import Image from 'next/image';
import Link from 'next/link';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';

export const dynamic = 'force-dynamic';

// /operator without a site qualifier. In production, the iPad is
// pinned to a site (cookie or a URL set by the manager when the iPad
// is provisioned). For now this is a friendly site picker so a
// developer or manager can reach either flow.

export default async function OperatorRootPage() {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string) => translate(dict, k);
  const sites = await prisma.site.findMany({
    select: { code: true, name: true },
    orderBy: { name: 'asc' },
  });
  return (
    <main className="px-6 pb-10">
      <div className="mx-auto flex max-w-md flex-col items-center gap-8 pt-6 text-center">
        <Image
          src="/brand/dr3-vision-logo.jpg"
          alt="DR3-Vision"
          width={1168}
          height={784}
          priority
          className="h-auto w-full"
        />
        <h1 className="text-2xl font-semibold">{t('site_picker.heading')}</h1>
        {/* Audit D-18 — there was NO zero-length branch here: an empty `Site`
            table rendered the heading "Choose your site" over an empty <ul> and
            nothing else. Compounding it, `floor-nav.ts` returns
            `backHref: null, showLogOut: false` for `/operator`, so unlike every
            other floor screen the chrome band offers no exit either — making
            this the ONLY page in the app with neither an empty state nor a
            chrome escape.

            The chrome's silence is correct and stays: `/operator` IS the top of
            the tree, and a Back pill pointing at nothing is the dead control
            this batch exists to remove. What was missing is the sentence, so
            that is what is added. Production has 2 sites (woodland, eugene), so
            this branch is latent — it is here because every sibling surface
            (`[site]/page.tsx`, `today/page.tsx`, `inbound/page.tsx`) already has
            one and the `floor-surface-coverage` guard cannot see it: that guard
            tests page-level chrome, not branch-level content. */}
        {sites.length === 0 && (
          <p className="text-base text-white/70" data-testid="site-picker-empty">
            {t('site_picker.empty')}
          </p>
        )}
        <ul className="flex w-full flex-col gap-3">
          {sites.map((s) => (
            <li key={s.code}>
              <Link
                href={`/operator/${s.code}`}
                className="block rounded-lg bg-white/5 px-4 py-4 text-lg font-semibold text-white transition-colors hover:bg-white/10"
              >
                {s.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
