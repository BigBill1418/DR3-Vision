// ADR-0067 Amendment A §A.6 — the Entra connect surface.
//
// Admin-only. Server-renders the NON-SECRET connection status (the status
// helper never SELECTs a ciphertext column, so no token can reach this render
// or the client bundle) and hands it to a client panel that owns the Connect /
// Reconnect action and the refresh.
//
// The `status` search param is the fixed outcome vocabulary the OAuth callback
// redirects with; `upn` is present only on the wrong-account path and comes
// from Graph, never from user input.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { adminMessages as AM } from '@/app/admin/messages';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';
import { docIngestRedirectUri, getDocIngestConnectionStatus } from '@/lib/doc-ingest';
import { ConnectPanel } from './ConnectPanel';

export const dynamic = 'force-dynamic';

const CALLBACK_STATUSES = [
  'connected',
  'handshake_failed',
  'wrong_account',
  'denied',
  'exchange_failed',
  'key_missing',
  'error',
] as const;

type CallbackStatus = (typeof CALLBACK_STATUSES)[number];

function parseStatus(raw: string | string[] | undefined): CallbackStatus | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return CALLBACK_STATUSES.find((s) => s === value) ?? null;
}

export default async function DocIngestConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/doc-ingest/connect');
    redirect('/admin');
  }

  const params = await searchParams;
  const callbackStatus = parseStatus(params['status']);
  const rawUpn = params['upn'];
  const signedInUpn = (Array.isArray(rawUpn) ? rawUpn[0] : rawUpn) ?? null;

  const status = await getDocIngestConnectionStatus(prisma);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {AM.backToDashboard}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{M.pageTitle}</h1>
          <p className="text-sm text-dr3-mist-dim">{M.pageSubtitle}</p>
        </header>
        <ConnectPanel
          initialStatus={{ ...status, redirectUri: docIngestRedirectUri() }}
          callbackStatus={callbackStatus}
          signedInUpn={signedInUpn}
        />
      </div>
    </main>
  );
}
