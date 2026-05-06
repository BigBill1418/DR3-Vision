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
    <main className="min-h-screen bg-black px-6 py-10 text-white">
      <div className="mx-auto flex max-w-md flex-col items-center gap-8 text-center">
        <Image
          src="/brand/dr3-vision-logo.jpg"
          alt="DR3-Vision"
          width={1168}
          height={784}
          priority
          className="h-auto w-full"
        />
        <h1 className="text-2xl font-semibold">{t('site_picker.heading')}</h1>
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
