'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { claimStatusAction } from '../../actions';

// ADR-0082 — what the DISPLACED operator sees when their claim moved mid-shift.
//
// ## The failure this closes, which the takeover feature itself created
//
// `assertOwn` refuses every stage action from a non-assignee with 403
// `load_not_assigned_to_operator`. Before takeover existed that 403 was
// effectively unreachable, because a claim never moved. Making claims movable
// makes it ROUTINE: A goes to lunch, B takes the load over, A returns to an iPad
// still showing the counting screen and taps +1.
//
// What A got at that instant was the stage's error banner rendering `e.message`
// — and a Server Action's throw reaches the browser with its message REDACTED in
// production builds. So the reason was not merely unhelpful, it was structurally
// unavailable to the client. Shipping takeover without this would have replaced
// one silent dead end (the redirect loop) with another one wearing a red banner.
//
// ## Why a re-ask rather than a blanket refresh
//
// The obvious fix — `router.refresh()` on any stage error — is wrong. Most stage
// errors are NOT claim losses (a validation refusal, an illegal transition, a
// genuine save failure), and refreshing re-renders the screen and takes the
// error banner with it. That trades an opaque message for no message, which is
// worse. So the client asks the one question it cannot answer locally, and only
// refreshes when the answer is yes.
//
// ## Why not the offline branch
//
// This runs ONLY in the non-offline branch of a stage's catch. A device that
// cannot reach the server cannot answer "who holds this load", and an offline
// write is queued rather than failed — there is nothing to explain yet.

/**
 * Returns a probe to call from the NON-OFFLINE branch of a stage's catch.
 *
 * @returns `true` when the claim has moved and the page has been refreshed —
 *          the caller must return immediately and set no error, because the
 *          server is about to re-render this route as the held-by panel.
 *          `false` means the claim is intact and the caller's real error stands.
 */
export function useClaimLossGuard(siteCode: string, loadId: string): () => Promise<boolean> {
  const router = useRouter();
  return useCallback(async () => {
    try {
      const { mine } = await claimStatusAction(siteCode, loadId);
      if (mine) return false;
      // The server component re-runs and renders `HeldByPanel`, which names the
      // new holder — the same surface a second operator sees, reached from the
      // other side.
      router.refresh();
      return true;
    } catch {
      // The probe itself failed (session gone, connection dropped between the two
      // calls). Fall back to the caller's own error handling rather than
      // asserting anything about the claim: a guess here would be the exact class
      // of confident-and-wrong this ADR is written against.
      return false;
    }
  }, [siteCode, loadId, router]);
}
