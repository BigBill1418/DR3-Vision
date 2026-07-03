// ADR-0039 D4 — site-name alias resolution (precondition for historical joins).
//
// The workbook's own site lists carry heavy spelling drift (Addendum B §B7:
// `All about Buidling`, `Chester Tranfer`, `VAcaville`, a literal `Name` junk
// row). Historical data cannot be joined without alias resolution. This is the
// plain interface used now; it is wired to ADR-0037's `source_aliases` table
// post-merge. An unresolvable name is NEVER dropped — the caller emits an
// `unresolved_site` finding.

import type { SiteAliasResolver } from '../types';

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface AliasEntry {
  siteId: string;
  canonicalName: string;
  isNonProgram: boolean;
}

/**
 * In-memory alias resolver (test double + the shape the DB-backed resolver
 * satisfies post-merge). Keys are matched case/whitespace-insensitively.
 */
export function inMemoryAliasResolver(entries: Record<string, AliasEntry>): SiteAliasResolver {
  const index = new Map<string, AliasEntry>();
  for (const [name, entry] of Object.entries(entries)) index.set(normalizeName(name), entry);
  return {
    resolve(rawName: string) {
      return index.get(normalizeName(rawName)) ?? null;
    },
  };
}
