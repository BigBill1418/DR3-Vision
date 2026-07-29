// ADR-0066 §1.4 + §1.6 — the server half of the combined AP configuration
// screen, shared verbatim by `/admin/ap/routing` and `/admin/ap/notifications`.
//
// Two routes, one surface. Bill: "two separate pages for six rows of config is
// worse." The routes exist because the two halves are separately linkable (the
// resolver's own `problems` string points at `/admin/ap/routing`), but they
// render the same page — `view` only decides which tab reads as current and
// which section the browser anchors on.
//
// Gated with `checkAdmin()` — `role === 'admin'` — at the page layer as well as
// the API layer. Admin POWERS never key off the `all_sites` reach flag
// (CLAUDE.md hard rule #2). Without the page-layer check a manager would see the
// React shell before the API 403'd, leaking that the surface exists (ADR-0017's
// stated reason for the three-layer gate).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkAdmin } from '@/lib/auth-helpers';
import { getApConfig } from '@/lib/ap/admin-config';
import { adminMessages as M } from '@/app/admin/messages';
import { ApConfigScreen } from './ApConfigScreen';
import {
  AP_CONFIG_ROUTES,
  pickApConfigParams,
  type ApConfigSearchParams,
  type ApConfigView,
} from './list-url';

const AC = M.apConfig;

export type ApConfigPageProps = {
  searchParams: Promise<ApConfigSearchParams>;
};

export async function renderApConfigPage(view: ApConfigView, props: ApConfigPageProps) {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect(`/login?next=${AP_CONFIG_ROUTES[view]}`);
    return <Forbidden />;
  }

  const params = pickApConfigParams(await props.searchParams);
  const config = await getApConfig({ status: params.status });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← Admin
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{AC.pageTitle}</h1>
          <p className="max-w-4xl text-sm text-dr3-mist-dim">{AC.pageSubtitle}</p>
        </header>

        <ApConfigScreen config={config} view={view} params={params} />
      </div>
    </main>
  );
}

function Forbidden() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">{M.forbiddenHeading}</h1>
      <p className="mt-2 text-dr3-mist-dim">{M.forbiddenBody}</p>
      <Link
        href="/admin"
        className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
      >
        {M.backToDashboard}
      </Link>
    </main>
  );
}
