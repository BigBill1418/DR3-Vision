// ADR-0041 (capture half; Addendum B6 / B10-6) — atomic document-number issuance.
//
// `document_sequences` is a per-(site, sequence_code) counter. `issueDocumentNumber`
// hands out the current `next_value` and increments it in a SINGLE
// `UPDATE … RETURNING` statement. That one statement takes a row-level lock for the
// duration of its (implicit or enclosing) transaction, so concurrent issuers
// serialize on the row and can NEVER be handed the same number — no gap, no
// collision. This is the update-returning variant of `SELECT … FOR UPDATE`
// (preferred: one statement, inherently atomic, no read-modify-write window).
//
// Pass the enclosing transaction client as `executor` to make issuance atomic WITH
// a larger unit of work (e.g. the office verify step below): if that transaction
// rolls back, the counter increment rolls back with it — a rejected/failed verify
// never burns a DR3 number.
//
// Material # is MyMRC-owned (assigned in MyMRC at EOD) and is NEVER issued here.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/** The canonical Vision DR3 document-number sequence code. */
export const DR3_NUMBER_SEQUENCE = 'dr3_number' as const;

/** No `document_sequences` row exists for the requested (site, code). */
export class DocumentSequenceNotFoundError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly siteId: string,
    readonly sequenceCode: string,
  ) {
    super(
      `no document_sequences counter for site ${siteId} code '${sequenceCode}' — seed the counter before issuing`,
    );
    this.name = 'DocumentSequenceNotFoundError';
  }
}

/** The minimal executor surface issuance needs — satisfied by the client OR a tx. */
type QueryExecutor = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Whether a site is issued a Vision-assigned DR3 number.
 *
 * Woodland-style (California) sites get one; Eugene (Oregon) does not — their scan
 * timestamp lives in existing arrival fields. Driven off jurisdiction FOR NOW.
 * TODO(ADR-0041 / B10-6): make this a per-site config flag once Janette confirms
 * whether DR3# is per-site or company-wide — the trigger should be a `Site` setting,
 * not a jurisdiction inference.
 */
export function siteGetsVisionDr3Number(jurisdiction: string): boolean {
  return jurisdiction === 'california';
}

/**
 * Atomically issue the next number for `(siteId, sequenceCode)` and advance the
 * counter. Returns the number handed out. Throws {@link DocumentSequenceNotFoundError}
 * when no counter row exists (never silently mints from 0 — a missing counter is a
 * seeding gap the office must fix). Pass `executor` = an enclosing `$transaction`
 * client to bind issuance to that transaction's atomicity.
 */
export async function issueDocumentNumber(
  siteId: string,
  sequenceCode: string,
  executor: QueryExecutor = prisma,
): Promise<number> {
  const rows = await executor.$queryRaw<{ issued: number }[]>(Prisma.sql`
    UPDATE "document_sequences"
    SET "next_value" = "next_value" + 1, "updated_at" = now()
    WHERE "site_id" = ${siteId} AND "sequence_code" = ${sequenceCode}
    RETURNING ("next_value" - 1)::int AS "issued"
  `);
  const issued = rows[0]?.issued;
  if (issued == null) throw new DocumentSequenceNotFoundError(siteId, sequenceCode);
  return issued;
}
