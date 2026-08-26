/**
 * Is this thrown value Next's `redirect()` control-flow signal?
 *
 * A server action's `redirect()` does not return — it THROWS a tagged error that
 * the framework catches and turns into a navigation. Any `catch` around a server
 * action call must therefore re-throw it, or every success is reported to the
 * user as a failure: the inverse of the dead-end defect the catch was added for,
 * and worse, because the operator is then sent back to re-tap a load that
 * already exists.
 *
 * Extracted (ADR-0127) because the same eight-line shape was inlined in
 * `queue-row.tsx` and `reconcile-row.tsx`, and a third caller was about to copy
 * it. Two copies of a predicate that decides "was this a success or a failure"
 * is how one of them comes to be subtly wrong with nothing to say so — the
 * `haulNumberOf` reasoning (ADR-0090 A) applied to control flow.
 *
 * Deliberately a PREFIX match on `digest`, not equality: the digest carries the
 * destination, the replace/push mode and the status code after the tag
 * (`NEXT_REDIRECT;replace;/operator/woodland/load/abc;307;`).
 */
export function isNextRedirectSignal(e: unknown): boolean {
  if (!e || typeof e !== 'object' || !('digest' in e)) return false;
  const digest = (e as { digest?: unknown }).digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}
