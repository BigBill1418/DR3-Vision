// ADR-0141 — "Submit an invoice": a manager who received an invoice directly
// submits it and picks the accounting staff member who receives the decision.
//
// Gated by `teamSubmitAccess`, the same function the API uses: a manager only at
// their own primary site, an admin at any site, and admins only while
// `ui/ap_team_submit` is pilot for the site. Works at phone width: the common
// case is a paper invoice photographed on the floor.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getLocale } from '@/i18n/get-locale';
import { getManagerDictionary, translate } from '@/i18n/dictionary';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { listAccountingContacts } from '@/lib/ap/accounting-contacts';
import { teamSubmitAccess, ACCEPTED_TYPES } from '@/lib/ap/team-submit';
import { ApSubmitClient, type ApSubmitStrings, type MySubmissionRow } from './ApSubmitClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

const STRING_KEYS = [
  'title',
  'site_label',
  'file_label',
  'file_hint',
  'vendor_label',
  'invoice_number_label',
  'amount_label',
  'purpose_label',
  'accountant_label',
  'accountant_placeholder',
  'submit',
  'submitting',
  'success',
  'missing_fields',
  'no_accountants',
] as const;
const ERROR_KEYS = [
  'vendor_required',
  'invoice_number_required',
  'invalid_amount',
  'purpose_required',
  'accountant_required',
  'accountant_inactive',
  'file_required',
  'too_many_files',
  'file_too_large',
  'file_type',
  'storage_unavailable',
  'forbidden',
  'generic',
] as const;

function pacific(d: Date): string {
  return `${d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  })} PT`;
}

export default async function ApSubmitPage({ params }: Props) {
  const { site: siteCode } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect(`/login?next=/dashboard/${siteCode}/ap-submit`);

  const dict = getManagerDictionary(await getLocale());
  const t = (key: string, vars?: Record<string, string | number>) =>
    translate(dict, `ap_submit.${key}`, vars);

  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) notFound();

  const isAdmin = session.user.role === 'admin';
  const access = await teamSubmitAccess(
    { role: session.user.role, primarySiteId: session.user.primary_site_id ?? null },
    site.id,
  );
  if (access !== 'ok') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">{t('forbidden_heading')}</h1>
        <p className="mt-2 text-dr3-mist-dim">
          {access === 'pilot' ? t('forbidden_pilot_body') : t('forbidden_body')}
        </p>
        <Link href="/dashboard" className="mt-6 text-sm underline">
          {t('back')}
        </Link>
      </main>
    );
  }

  const [contacts, live, sites, mine] = await Promise.all([
    listAccountingContacts({ activeOnly: true }),
    isUiSurfaceLive(UI_SURFACE.AP_TEAM_SUBMIT, site.id),
    isAdmin
      ? prisma.site.findMany({
          where: { code: { in: ['eugene', 'woodland'] } },
          select: { code: true, name: true },
          orderBy: { name: 'asc' },
        })
      : Promise.resolve([]),
    prisma.apRequest.findMany({
      where: { intake_channel: 'team_submit', submitted_by: session.user.id },
      select: {
        id: true,
        status: true,
        submitted_at: true,
        submitted_vendor: true,
        submitted_invoice_number: true,
        submitted_amount_cents: true,
        outcome_recipient_email: true,
      },
      orderBy: { submitted_at: 'desc' },
      take: 50,
    }),
  ]);

  const strings = {
    ...Object.fromEntries(STRING_KEYS.map((k) => [k, t(k)])),
    errors: Object.fromEntries(ERROR_KEYS.map((k) => [k, t(`errors.${k}`)])),
  } as unknown as ApSubmitStrings;
  const rows: MySubmissionRow[] = mine.map((r) => ({
    id: r.id,
    submittedAt: r.submitted_at ? pacific(r.submitted_at) : '',
    invoice: `${r.submitted_invoice_number ?? ''} · ${r.submitted_vendor ?? ''}`,
    amountCents: r.submitted_amount_cents ?? 0,
    accountant:
      contacts.find((c) => c.email === r.outcome_recipient_email)?.displayName ??
      r.outcome_recipient_email ??
      '',
    status: t(`status.${r.status}`),
  }));

  return (
    <main className="min-h-screen bg-dr3-space px-4 py-6 text-dr3-mist sm:px-6 sm:py-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6">
          <Link
            href={`/dashboard/${site.code}`}
            className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist"
          >
            ← {site.name}
          </Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">{t('title')}</h1>
          <p className="mt-1 text-sm text-dr3-mist-dim">{t('intro')}</p>
          {!live && (
            <p className="mt-2 text-xs text-amber-300" data-testid="ap-submit-pilot-note">
              {t('pilot_note')}
            </p>
          )}
        </header>

        <ApSubmitClient
          siteCode={site.code}
          siteName={site.name}
          adminSites={sites}
          accountants={contacts.map((c) => ({ id: c.id, name: c.displayName }))}
          accept={ACCEPTED_TYPES.join(',')}
          strings={strings}
        />

        <section className="mt-10" data-testid="ap-submit-mine">
          <h2 className="mb-3 text-lg font-semibold">{t('mine_heading')}</h2>
          {rows.length === 0 ? (
            <p className="text-sm text-dr3-mist-dim">{t('mine_empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className="rounded border border-dr3-steel-light/25 bg-dr3-space-2 p-3 text-sm"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium">{r.invoice}</span>
                    <span>${(r.amountCents / 100).toFixed(2)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-dr3-mist-dim">
                    <span>
                      {t('col_status')}: {r.status}
                    </span>
                    <span>
                      {t('col_accountant')}: {r.accountant}
                    </span>
                    <span>{r.submittedAt}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
