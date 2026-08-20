// ADR-0120 — the lock that keeps a workbook promotion from interleaving with
// the floor.
//
// `promoteWorkbookImport` refuses to promote into a window that already holds
// live rows: `detectConflicts` scans five operational tables inside the
// promotion transaction and throws `PromotionConflictError` on any hit. That
// scan is correct and is not the problem. The problem is that it is a READ, and
// this application runs at READ COMMITTED — Postgres's default — so a live row
// that commits AFTER the scan and BEFORE the promotion's own inserts is
// invisible to the scan and lands in the window anyway.
//
// The result is a silent double count of a real day's volume. The promoted rows
// and the live rows both stand, `onHand` sums both, and the promotion ledger row
// records a conflict-free promotion that was not one. Nothing errors, and the
// numbers feed MRC billing.
//
// ## Why an advisory lock, and why it is scoped to the SITE
//
// The conflict scan spans five tables and a date range. There is no single row
// to lock, and no natural key that both sides share — a promotion knows a
// WINDOW, while a floor write knows one row on one day and has no idea whether
// some admin is promoting a month that contains it. A key of
// `site_id || ':' || window` would be unbuildable on the writer side for that
// reason: the writer cannot name the window it might be inside.
//
// So the shared key is the coarsest thing both sides genuinely know: the SITE.
// Both sides take the same lock, and a promotion at Woodland cannot interleave
// with a floor write at Woodland.
//
// The alternative considered was a two-int key of `(hashtext(site_id), day)`,
// which would let a promotion contend only with writes on the days it covers. It
// was rejected as worse on every axis that matters here: a month-long promotion
// would hold ~31 locks instead of 1, every writer would need the day of its own
// row (which several of them derive rather than hold), and multi-lock acquisition
// introduces a lock-ordering obligation — and therefore a deadlock — where a
// single key has none. Promotions are rare, admin-initiated, and take seconds;
// floor writes are frequent and take milliseconds. Blocking the frequent-but-fast
// side for the duration of the rare-but-slow one is the correct trade, and it is
// the only shape with no ordering rule for the next author to get wrong.
//
// ## Lock ordering — the rule for whoever comes next
//
// **This is the only advisory lock any of these paths takes, and each path takes
// exactly one.** That is what makes it deadlock-free, and it is a property to
// preserve rather than an accident. If you add a second advisory lock to any
// path that already takes this one, you have created a lock-ordering problem: fix
// it by acquiring in a documented total order (this lock first), or by not adding
// the second lock.
//
// Row locks are a different matter and are fine: they are taken after this one on
// every path, so the order is consistent by construction.
//
// ## Hold times
//
// Transaction-scoped (`pg_advisory_xact_lock`), so it is released by the same
// commit or rollback that decides the write — there is no unlock to forget and no
// leak on a thrown error. Writers take it as the FIRST statement inside the
// transaction that performs the write, and nothing else, so the hold is the write
// itself. `hashtext` returns int4; the cast widens it to the `bigint` signature,
// which is the idiom `recycling-rates.ts` and `photos/confirm/route.ts` already
// use.
//
// A hash collision between two different site ids would cost extra serialisation
// and nothing else — both sides would simply take the same lock. It cannot cause
// incorrect data.

import type { Prisma } from '@prisma/client';

/**
 * Serialise this transaction against workbook promotion at `siteId`.
 *
 * Call it as the FIRST statement inside the transaction that writes any of the
 * five promoted operational tables — `inbound_loads`, `outbound_materials`,
 * `landfilled_units`, `consumer_dropoffs`, `site_inventory_snapshots` — and
 * inside the promotion transaction itself.
 *
 * Takes a transaction client, never the shared singleton: an advisory lock taken
 * outside a transaction is session-scoped and would outlive the work it guards.
 */
export async function lockSiteAgainstPromotion(
  tx: Prisma.TransactionClient,
  siteId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dr3:promotion:${siteId}`})::bigint)`;
}
