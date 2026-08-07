import { notFound } from 'next/navigation';
import Image from 'next/image';
import { prisma } from '@/lib/prisma';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { ChevronBackIcon, NavPillLink } from '@/app/_components/nav-pill';
import { GREEN_TONE } from '../../_components/floor-tone';
import { Keypad } from './keypad';

export const dynamic = 'force-dynamic';

// PIN entry. Renders the operator's name + a numeric keypad. The
// client `Keypad` posts to `/api/auth/callback/pin` (Auth.js v5
// Credentials provider id `pin`); on success it routes to the
// operator queue placeholder.

// ADR-0078 G8c — carries the post-PIN return path through to the keypad.
type Props = {
  params: Promise<{ site: string; userId: string }>;
  searchParams: Promise<{ next?: string }>;
};

export default async function OperatorPinPage({ params, searchParams }: Props) {
  const { site: siteCode, userId } = await params;
  const { next } = await searchParams;
  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) notFound();

  const operator = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      role: true,
      is_active: true,
      primary_site_id: true,
    },
  });
  if (
    !operator ||
    operator.role !== 'operator' ||
    !operator.is_active ||
    operator.primary_site_id !== site.id
  ) {
    notFound();
  }

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string) => translate(dict, k);

  return (
    <main className="px-6 pb-10">
      <div className="mx-auto flex max-w-md flex-col items-center gap-8 pt-6">
        <header className="flex w-full items-center justify-between gap-4">
          <Image
            src="/brand/dr3-vision-logo.jpg"
            alt="DR3-Vision"
            width={1168}
            height={784}
            priority
            className="h-12 w-auto"
          />
          <span className="rounded-md bg-white/10 px-3 py-1 text-sm font-medium uppercase tracking-wide text-white/80">
            {site.name}
          </span>
        </header>

        <h1 className="text-2xl font-semibold">{operator.name}</h1>
        <p className="text-sm text-white/70">{t('keypad.prompt')}</p>

        <Keypad userId={operator.id} siteCode={site.code} next={next} />

        {/* ADR-0065 — kept (Bill's "Not you?" exit is the fastest way off a
            wrong name) but restyled to the shared >=44px pill. FloorChrome also
            offers a generic Back here; this one is the LABELLED intent. */}
        <NavPillLink
          href={`/operator/${site.code}`}
          label={t('keypad.switch_user')}
          ariaLabel={t('keypad.switch_user')}
          toneClass={GREEN_TONE}
          icon={<ChevronBackIcon />}
        />
      </div>
    </main>
  );
}
