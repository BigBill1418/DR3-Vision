// ADR-0042 D2.3 — the COR signer block, standardized from site config (NOT typed
// per certificate).
//
// CONFIG CHOICE (documented per the ADR's "document choice"): a simple site-scoped
// config ROW (`cor_site_config`, one per CA site) rather than a `state_program_rules`
// -style effective-dated table. Rationale: the signer name + title are a single
// standing fact per site with no history/effective-dating need (unlike a billing
// rate), so a plain 1:1 config row is the minimal correct model. A confirmed title
// is ONE row edit — never a code change, never retyped per certificate (D2.3).
//
// TBC: the seeded title "Transportation Manager" is what the June COR read but is
// flagged TBC with MRC (docs/QUESTIONS.md Q-5). Until a row is seeded/confirmed,
// the resolver falls back to the documented default below so a draft still
// pre-fills; the fallback is itself the seed value, so confirming the title is a
// data edit either way.

import { prisma } from '@/lib/prisma';

export interface CorSigner {
  name: string;
  title: string;
}

/**
 * D2.3 seed default (Rick Albritton, "Transportation Manager"). Used only when no
 * `cor_site_config` row exists yet — flagged TBC with MRC (docs/QUESTIONS.md Q-5).
 */
export const DEFAULT_COR_SIGNER: CorSigner = {
  name: 'Rick Albritton',
  title: 'Transportation Manager',
};

/**
 * Resolve the standing signer block for a site from `cor_site_config`, falling
 * back to {@link DEFAULT_COR_SIGNER} when no row is seeded yet. The resolved value
 * is DENORMALIZED onto the certificate at generation, so a later config edit never
 * rewrites a finalized artifact.
 */
export async function resolveCorSigner(siteId: string): Promise<CorSigner> {
  const row = await prisma.corSiteConfig.findUnique({
    where: { site_id: siteId },
    select: { signer_name: true, signer_title: true },
  });
  if (!row) return { ...DEFAULT_COR_SIGNER };
  return { name: row.signer_name, title: row.signer_title };
}
