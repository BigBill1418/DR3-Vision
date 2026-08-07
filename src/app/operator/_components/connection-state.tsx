'use client';

// ADR-0078 D9 — the connection indicator, mounted ONCE in `FloorChrome`.
//
// Mounted in the chrome rather than per page, for the same reason the back pill
// and Log Out live there (ADR-0065): a control that exists on some screens and
// not others is a control an operator cannot rely on. The chrome wraps all nine
// operator screens through the route-group layout, so this is on every one of
// them by construction, and `chrome.connection-state-on-every-screen` enumerates
// the pages off the filesystem to keep it that way.
//
// It REPLACES two things it is a superset of: `PendingPill` in
// `load-workflow.tsx` (visible only inside a load, only when count > 0) and
// `PendingBanner` on the queue page. Both showed a queue depth and neither
// showed connection state, which is the half JT actually asked for — an
// operator could be offline with an empty queue and see nothing at all.
//
// Three states, and the quiet one is deliberate. `online` with nothing pending
// renders a small neutral dot, not a green badge: a reassurance shown constantly
// stops being read, and the thing that must be noticeable is the exception.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/provider';
import { useConnectionState } from '@/lib/use-connection-state';

export function ConnectionState({ siteCode }: { siteCode: string | null }) {
  const t = useT();
  const pathname = usePathname();
  const { status, pending, conflicts, blocked, auth, lastSyncAt, sync } = useConnectionState();

  // Session-expired outranks everything, including conflicts: it is one tap to
  // fix and it BLOCKS the queue, so surfacing anything else first sends the
  // operator to solve a problem they cannot solve yet.
  if (status === 'session-expired' && siteCode) {
    // G8c — sign in, and come BACK here.
    //
    // The name picker is the floor's sign-in, and without carrying the return
    // path an operator signing in mid-task lands on the hub and has to navigate
    // back to whatever they were doing. That friction is what makes a recovery
    // badge read as still-broken; with it, recovery is one tap and a PIN, and
    // the engine drains the moment the session exists.
    const back = pathname ?? `/operator/${siteCode}/today`;
    return (
      <Link
        href={`/operator/${siteCode}?next=${encodeURIComponent(back)}`}
        data-testid="connection-state"
        data-status="session-expired"
        className="flex min-h-[44px] items-center gap-2 rounded-full bg-sky-500/25 px-3 text-sm font-semibold text-sky-100 ring-1 ring-sky-300/50"
      >
        <span aria-hidden="true">🔑</span>
        {t('floor.connection.session_expired', { count: auth })}
      </Link>
    );
  }

  // Conflicts outrank everything: they are the only state that cannot resolve
  // itself, so they get the loudest treatment and a destination rather than a
  // retry. Tapping "retry" on something that will never succeed is the kind of
  // dead control this ADR is removing, not adding.
  if (conflicts > 0 && siteCode) {
    return (
      <Link
        href={`/operator/${siteCode}/queue/conflicts`}
        data-testid="connection-state"
        data-status="conflicts"
        className="flex min-h-[44px] items-center gap-2 rounded-full bg-amber-500/25 px-3 text-sm font-semibold text-amber-100 ring-1 ring-amber-300/50"
      >
        <span aria-hidden="true">⚠</span>
        {t('floor.connection.conflicts', { count: conflicts })}
      </Link>
    );
  }

  // `uploads-blocked` ranks above the rest because it is the state an operator
  // would otherwise never learn about. A count entered while photos are blocked
  // saves perfectly, so every other signal on the screen reads normal — which is
  // precisely how 97 undelivered photos went unremarked for weeks. The label
  // says what still works, so nobody stops entering counts over it.
  const label =
    status === 'uploads-blocked'
      ? t('floor.connection.uploads_blocked')
      : status === 'offline-queuing'
        ? t('floor.connection.offline', { count: pending })
        : status === 'syncing'
          ? t('floor.connection.syncing')
          : pending > 0
            ? t('floor.connection.pending', { count: pending })
            : t('floor.connection.online');

  const tone =
    status === 'uploads-blocked'
      ? 'bg-amber-500/25 text-amber-100 ring-1 ring-amber-300/50'
      : status === 'offline-queuing'
        ? 'bg-red-500/25 text-red-100 ring-1 ring-red-300/50'
        : status === 'syncing'
          ? 'bg-dr3-chartreuse/20 text-dr3-chartreuse'
          : pending > 0
            ? 'bg-dr3-chartreuse/20 text-dr3-chartreuse'
            : 'bg-white/10 text-dr3-cream/70';

  return (
    <button
      type="button"
      onClick={sync}
      disabled={status === 'syncing'}
      data-testid="connection-state"
      data-status={status}
      title={
        status === 'uploads-blocked'
          ? t('floor.connection.uploads_blocked_detail', { count: blocked })
          : lastSyncAt === null
            ? t('floor.connection.never_synced')
            : t('floor.connection.last_sync', { time: new Date(lastSyncAt).toLocaleTimeString() })
      }
      className={`flex min-h-[44px] items-center gap-2 rounded-full px-3 text-sm font-semibold disabled:opacity-70 ${tone}`}
    >
      <span aria-hidden="true">
        {status === 'uploads-blocked'
          ? '📷'
          : status === 'offline-queuing'
            ? '⚡'
            : status === 'syncing'
              ? '⏳'
              : '●'}
      </span>
      {label}
    </button>
  );
}
