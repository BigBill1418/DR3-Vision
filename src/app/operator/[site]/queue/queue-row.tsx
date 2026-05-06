'use client';

import { useTransition } from 'react';
import { startLoadAction } from '../actions';

// Tap-to-start wrapper. Per CLAUDE.md hard rule #10 the queue row
// is a `<button>` with onClick rather than a form. The server action
// creates the InboundLoad and redirects to /load/[id], so the
// client never sees the response.

export function QueueRow({
  siteCode,
  expectedLoadId,
  children,
}: {
  siteCode: string;
  expectedLoadId: string;
  children: React.ReactNode;
}) {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          await startLoadAction(siteCode, expectedLoadId);
        })
      }
      className="w-full rounded-lg bg-dr3-green-dark/40 p-4 text-left transition-colors hover:bg-dr3-green-dark/70 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}
