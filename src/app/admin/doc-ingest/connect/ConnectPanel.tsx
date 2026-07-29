'use client';

// ADR-0067 Amendment A §A.6 — connect-surface client panel.
//
// Owns three things: the Connect/Reconnect action, the callback-outcome banner,
// and a client-side refresh of the status body.
//
// CLAUDE.md #10: no HTML `<form>`. The Connect action is an `onClick` that
// POSTs to /oauth/start (which sets the sealed CSRF cookie) and then navigates
// to the returned authorize URL — the cookie is set before the navigation
// leaves, which is exactly the ordering the state check depends on.
//
// No secret ever reaches this component. The status API omits every ciphertext
// column, so there is nothing here to leak even by accident.

import { useCallback, useEffect, useState } from 'react';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';
import type { DocIngestStatusResponse } from '@/app/api/admin/doc-ingest/status/route';

type CallbackStatus =
  | 'connected'
  | 'handshake_failed'
  | 'wrong_account'
  | 'denied'
  | 'exchange_failed'
  | 'key_missing'
  | 'error';

interface Props {
  initialStatus: DocIngestStatusResponse;
  callbackStatus: CallbackStatus | null;
  signedInUpn: string | null;
}

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function ConnectPanel({ initialStatus, callbackStatus, signedInUpn }: Props) {
  const [status, setStatus] = useState<DocIngestStatusResponse>(initialStatus);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch('/api/admin/doc-ingest/status', { cache: 'no-store' });
    if (!res.ok) {
      setError(M.loadFailed);
      return;
    }
    setStatus((await res.json()) as DocIngestStatusResponse);
    setError(null);
  }, []);

  // A fresh connect lands here via redirect; re-pull so the panel shows the row
  // that was just written rather than the render that preceded it.
  useEffect(() => {
    if (callbackStatus === 'connected') void reload();
  }, [callbackStatus, reload]);

  const handleConnect = async () => {
    setError(null);
    setPending(true);
    try {
      const res = await fetch('/api/admin/doc-ingest/oauth/start', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        authorizeUrl?: string;
        error?: string;
      };
      if (!res.ok || !body.authorizeUrl) {
        setError(body.error ?? M.errors.serverError);
        return;
      }
      window.location.assign(body.authorizeUrl);
    } catch {
      setError(M.errors.serverError);
      setPending(false);
    }
  };

  const banner = callbackBanner(callbackStatus, signedInUpn);
  const needsReauth = status.state === 'reauth_required';

  return (
    <div className="flex flex-col gap-8" data-testid="doc-ingest-connect">
      {banner ? (
        <p
          className={`rounded-md px-4 py-3 text-sm ${
            banner.tone === 'ok'
              ? 'bg-emerald-900/40 text-emerald-100'
              : 'bg-red-900/40 text-red-100'
          }`}
          role={banner.tone === 'ok' ? 'status' : 'alert'}
          data-testid="doc-ingest-callback-banner"
        >
          {banner.text}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100" role="alert">
          {error}
        </p>
      ) : null}

      {needsReauth ? (
        <section
          className="flex flex-col gap-2 rounded-md border border-red-500/50 bg-red-950/40 px-4 py-4"
          role="alert"
          data-testid="doc-ingest-reauth-banner"
        >
          <h2 className="text-lg font-semibold text-red-100">{M.reauthHeading}</h2>
          <p className="text-sm text-red-100/90">{M.reauthBody}</p>
          <p className="text-xs text-red-200/80">
            {M.reauthSince}: {fmt(status.reauthSince)}
            {status.reauthReason ? ` · ${M.reauthReason}: ${status.reauthReason}` : ''}
          </p>
        </section>
      ) : null}

      {status.connected ? (
        <ConnectedBody status={status} />
      ) : (
        <section
          className="flex flex-col gap-3 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2/60 px-4 py-4"
          data-testid="doc-ingest-disconnected"
        >
          <h2 className="text-lg font-semibold text-dr3-mist">{M.disconnectedHeading}</h2>
          <p className="text-sm text-dr3-mist-dim">{M.disconnectedBody}</p>
        </section>
      )}

      {/* Named account warning. Present in BOTH states — it is as easy to pick the
          wrong account on a reconnect as on a first connect. */}
      <p
        className="rounded-md border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100"
        data-testid="doc-ingest-account-warning"
      >
        {M.signInAsWarning}
      </p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleConnect}
          disabled={pending}
          className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space disabled:opacity-50"
          data-testid="doc-ingest-connect-button"
        >
          {pending ? M.connecting : status.connected ? M.reconnect : M.connect}
        </button>
        <button
          type="button"
          onClick={() => void reload()}
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          data-testid="doc-ingest-refresh"
        >
          {M.refresh}
        </button>
      </div>

      <ConfigBody status={status} />
    </div>
  );
}

function ConnectedBody({ status }: { status: DocIngestStatusResponse }) {
  return (
    <section
      className="flex flex-col gap-4 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2/60 px-4 py-4"
      data-testid="doc-ingest-connected"
      data-account-matches={status.accountMatches ? 'true' : 'false'}
    >
      <h2 className="text-lg font-semibold text-dr3-mist">{M.connectedHeading}</h2>

      <Row label={M.signedInAs} value={status.accountUpn ?? '—'} />
      {/* Defence in depth. The callback refuses a non-service account outright,
          so this can only fire if something bypassed that path — which is
          precisely when it must be shouted rather than assumed impossible. */}
      {!status.accountMatches ? (
        <p
          className="rounded-md bg-red-900/40 px-3 py-2 text-sm text-red-100"
          role="alert"
          data-testid="doc-ingest-account-mismatch"
        >
          {M.accountMismatch}
        </p>
      ) : null}

      <Row label={M.acquiredAt} value={fmt(status.acquiredAt)} />
      <Row
        label={M.lastRefresh}
        value={status.lastRefreshAt ? fmt(status.lastRefreshAt) : M.neverRefreshed}
      />
      <Row
        label={M.refreshTokenAge}
        value={
          status.refreshTokenAgeDays === null ? '—' : `${status.refreshTokenAgeDays} ${M.days}`
        }
      />
      <Row label={M.accessTokenExpires} value={fmt(status.accessTokenExpiresAt)} />

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-dr3-mist">{M.scopesHeading}</span>
        <span className="text-xs text-dr3-mist-dim" data-testid="doc-ingest-granted-scopes">
          {status.grantedScopes.length > 0 ? status.grantedScopes.join(' · ') : '—'}
        </span>
        {status.missingScopes.length > 0 ? (
          <span className="text-xs text-red-200" data-testid="doc-ingest-missing-scopes">
            {M.scopesMissing}: {status.missingScopes.join(', ')}
          </span>
        ) : (
          <span className="text-xs text-emerald-200">{M.scopesSatisfied}</span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-dr3-mist">{M.driveHeading}</span>
        <span className="text-xs text-dr3-mist-dim" data-testid="doc-ingest-drive-status">
          {driveText(status)}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-dr3-mist">{M.subscriptionsHeading}</span>
        <span className="text-xs text-dr3-mist-dim" data-testid="doc-ingest-subscriptions">
          {status.activeSubscriptionCount > 0
            ? `${M.activeSubscriptions}: ${status.activeSubscriptionCount} · ${M.nextRenewal}: ${fmt(status.nextSubscriptionRenewalAt)}`
            : M.noSubscriptions}
        </span>
        <span className="text-xs text-dr3-mist-dim">
          {M.lastSweep}: {status.lastDeltaSweepAt ? fmt(status.lastDeltaSweepAt) : M.neverSwept}
        </span>
      </div>
    </section>
  );
}

function ConfigBody({ status }: { status: DocIngestStatusResponse }) {
  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2/40 px-4 py-4 text-xs"
      data-testid="doc-ingest-config"
    >
      <span className="text-sm font-medium text-dr3-mist">{M.configHeading}</span>
      {/* Non-secret by §A.1 — printing them is how a provisioning drift becomes
          visible instead of mysterious. */}
      <Row label={M.tenantId} value={status.tenantId} />
      <Row label={M.clientId} value={status.clientId} />
      <Row label={M.redirectUri} value={status.redirectUri} />
      <Row
        label={M.encryptionKey}
        value={status.encryptionKeyConfigured ? M.configured : M.notConfigured}
      />
      <Row
        label={M.clientSecret}
        value={status.clientSecretConfigured ? M.configured : M.notConfigured}
      />
      <Row label={M.clientSecretExpiry} value={status.clientSecretExpiresOn} />
      <p className="text-dr3-mist-dim">{M.clientSecretShared}</p>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="text-xs font-medium text-dr3-mist-dim">{label}</span>
      <span className="text-sm text-dr3-mist">{value}</span>
    </div>
  );
}

function driveText(status: DocIngestStatusResponse): string {
  switch (status.driveStatus) {
    case 'provisioned':
      return `${M.driveProvisioned} · ${fmt(status.driveProvisionedAt)}`;
    case 'pending':
      return M.drivePending;
    case 'error':
      return `${M.driveError}: ${status.driveCheckError ?? ''}`;
    default:
      return M.driveUnknown;
  }
}

function callbackBanner(
  s: CallbackStatus | null,
  upn: string | null,
): { tone: 'ok' | 'bad'; text: string } | null {
  switch (s) {
    case null:
      return null;
    case 'connected':
      return { tone: 'ok', text: M.connectedHeading };
    case 'wrong_account':
      return {
        tone: 'bad',
        text: `${M.errors.wrongAccount}${upn ? ` (${upn})` : ''} ${M.signInAsWarning}`,
      };
    case 'handshake_failed':
      return { tone: 'bad', text: M.errors.handshake };
    case 'denied':
      return { tone: 'bad', text: M.errors.exchangeFailed };
    case 'exchange_failed':
      return { tone: 'bad', text: M.errors.exchangeFailed };
    case 'key_missing':
      return { tone: 'bad', text: M.errors.keyMissing };
    default:
      return { tone: 'bad', text: M.errors.serverError };
  }
}
