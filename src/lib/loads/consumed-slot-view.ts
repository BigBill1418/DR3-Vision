// ADR-0091 — what a consumed slot OFFERS, decided once for both surfaces.
//
// `consumed-slot.ts` answers "has this slot been worked?" and is server-only: it
// reaches `OPEN_DOCK_STATUSES`, which sits beside `prisma` and cannot enter the
// browser bundle. This module answers the SECOND question — "so what can the
// person looking at it do about it?" — and is deliberately pure and
// import-free so the queue (a server component) and the hauls list (a client
// component) can share one answer instead of writing two that disagree.
//
// That sharing is the whole point. ADR-0074 Amendment 1 put the SAME blindness
// on both surfaces because the code was not shared; splitting the decision again
// here would rebuild the defect one layer up. A third check-in surface must come
// through this function.
//
// ## The defect this closes (2026-08-11, Woodland)
//
// Amendment 1 gave the consumed card a sentence and no control, and hard-coded
// that sentence to "Already started by another operator" for every OPEN child.
// `ConsumedLoadRef` carried no holder identity, so the card could not have known
// better — it was not a wrong branch, it was a missing field.
//
// The consequence in production: Pablo Ledezma started H-136311
// (Costco-Innovel-Sacramento) at 6:46 AM PDT, photographed the BOL, began the
// unload at 6:48 AM — and then went back to the hauls screen to re-enter HIS OWN
// load. The screen told him another operator had it and offered him nothing. He
// was stuck until 8:00 AM, when it was escalated as an incident.
//
// The queue happened to save him (ADR-0065 Am.1's "unfinished work" block still
// linked the load) but the hauls screen is where you go when you know the
// truck's NAME, which is exactly what an operator has in hand. One surface
// having a way out is not a fix; it is luck.
//
// ## Why `held` also gets a route
//
// A load a colleague holds is NOT a dead end either — ADR-0082 replaced the old
// silent redirect with a held-by panel and a Take over button, and the queue's
// `HeldByOthersSection` has linked non-assignees into that page since. Sending
// the hauls card to the same place is consistency, not new exposure: the load
// page is site-scoped (`load.site_id !== site.id ⇒ notFound()`), so this cannot
// reach another site's work, and the holder's name is already on the queue.
//
// `worked` keeps Amendment 1's answer unchanged. A `submitted` slot has left the
// floor's hands and there is genuinely nothing to go back to, so it stays a
// read-only card. The regression Amendment 1 fixed — a button onto finished work
// — is not reintroduced.

/** The facts a card needs to decide what it can offer. */
export interface ConsumedSlotFacts {
  /** True while the child is still the floor's work. From `ConsumedLoadRef`. */
  open: boolean;
  loadId: string;
  holderUserId: string | null;
  holderName: string | null;
}

/**
 * What the card should render. A discriminated union rather than a pair of
 * booleans so an unhandled case is a type error at the call site, not a card
 * that silently falls through to "no control" — which is the state being fixed.
 */
export type ConsumedSlotView =
  /** You hold this open load. Go straight back to the workflow. */
  | { kind: 'resume'; loadId: string }
  /** Somebody else holds this open load. Route to the ADR-0082 held-by panel. */
  | { kind: 'held'; loadId: string; holderName: string | null }
  /** Off the floor (submitted or beyond). Read-only, exactly as Amendment 1 left it. */
  | { kind: 'worked' };

/**
 * @param viewerUserId the SIGNED-IN operator, always resolved from the session
 *   server-side — never from a path segment or a client-supplied value.
 *
 * A null `holderUserId` deliberately yields `held`, not `resume`. An unassigned
 * open load belongs to nobody, and telling the viewer it is theirs would be the
 * same species of confident falsehood this module exists to delete; `held` with
 * a null name renders the honest "another operator" fallback and still offers
 * the takeover that makes it theirs for real.
 */
export function describeConsumedSlot(
  c: ConsumedSlotFacts,
  viewerUserId: string,
): ConsumedSlotView {
  if (!c.open) return { kind: 'worked' };
  if (c.holderUserId !== null && c.holderUserId === viewerUserId) {
    return { kind: 'resume', loadId: c.loadId };
  }
  return { kind: 'held', loadId: c.loadId, holderName: c.holderName };
}
