// Site-aware signer display-name resolution for the manager bonus UI.
//
// The manager-facing bonus detail page (T-110) and its signature panel (T-111)
// must show the NATURAL signer names for the period's site — "Janette Tomas /
// Morena Gomez" at Woodland, "Rick Albritton / Kelsey Ruhland" at Eugene. Those
// identities live in the `bonus_signature_chains` data, NEVER hardcoded per site
// (CLAUDE.md hard rule #2 — Eugene and Woodland are strictly separated and no
// per-site signer identity is baked into presentation code).
//
// This is the same resolution the PDF page already performs inline (resolve the
// chain → look up the two signer UUIDs' display names in one query). It is
// lifted here so the manager page and panel share ONE implementation, and so the
// logic is unit-testable without rendering a server component.

import { prisma } from '@/lib/prisma';
import { getSignatureChain, type SignatureChainDb } from '@/lib/bonus/signature-chain';

/** Resolved display names for a period's two natural signature slots. */
export interface SlotSignerNames {
  /** Display name of the site's natural facility-slot signer. */
  facility: string;
  /** Display name of the site's natural ops-slot signer. */
  ops: string;
}

/** Minimal Prisma surface this helper needs: the chain lookup + a user lookup. */
export interface SignerNamesDb extends SignatureChainDb {
  user: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; name: true };
    }): Promise<Array<{ id: string; name: string | null }>>;
  };
}

/**
 * Resolve the facility/ops natural-signer display names for a site from the
 * signature chain. Mirrors the bonus-pdf page: read the chain, then resolve the
 * two signer UUIDs to names in a single `user.findMany`. If a signer's name is
 * missing (null/unknown), the UUID is returned as a last-resort label rather
 * than an empty slot — the same fallback the PDF page uses.
 *
 * @param siteId The period's site UUID (`sites.id`), NOT a site code.
 * @param db     Override the Prisma client (tests inject a double); defaults to
 *               the global singleton.
 * @throws {SignatureChainNotFoundError} when the site has no chain row.
 */
export async function resolveSlotSignerNames(
  siteId: string,
  db: SignerNamesDb = prisma as unknown as SignerNamesDb,
): Promise<SlotSignerNames> {
  const chain = await getSignatureChain(siteId, db);
  const ids = [...new Set([chain.facility_signer_user_id, chain.ops_signer_user_id])];
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const nameOf = (id: string): string => users.find((u) => u.id === id)?.name ?? id;
  return {
    facility: nameOf(chain.facility_signer_user_id),
    ops: nameOf(chain.ops_signer_user_id),
  };
}
