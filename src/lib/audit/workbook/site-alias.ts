// ADR-0039 D4 — site-name alias resolution (precondition for historical joins).
//
// The workbook's own site lists carry heavy spelling drift (Addendum B §B7:
// `All about Buidling`, `Chester Tranfer`, `VAcaville`, a literal `Name` junk
// row). Historical data cannot be joined without alias resolution. This is the
// plain interface used now; it is wired to ADR-0037's `source_aliases` table
// post-merge. An unresolvable name is NEVER dropped — the caller emits an
// `unresolved_site` finding.

import type { PrismaClient } from '@prisma/client';
import type { SiteAliasResolver } from '../types';
import {
  isSourceNonProgram,
  recyclerStateForJurisdiction,
} from '@/lib/inventory/source-classification';

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface AliasEntry {
  /** The resolved `sources.id` (null only in test doubles that don't care about linkage). */
  sourceId: string | null;
  siteId: string;
  canonicalName: string;
  isNonProgram: boolean;
}

/** Test-double input — `sourceId` optional so existing fixtures stay terse. */
export type AliasEntryInput = Omit<AliasEntry, 'sourceId'> & { sourceId?: string };

/**
 * In-memory alias resolver (test double + the shape the DB-backed resolver
 * satisfies post-merge). Keys are matched case/whitespace-insensitively.
 */
export function inMemoryAliasResolver(entries: Record<string, AliasEntryInput>): SiteAliasResolver {
  const index = new Map<string, AliasEntry>();
  for (const [name, entry] of Object.entries(entries)) {
    index.set(normalizeName(name), { ...entry, sourceId: entry.sourceId ?? null });
  }
  return {
    resolve(rawName: string) {
      return index.get(normalizeName(rawName)) ?? null;
    },
  };
}

/**
 * DB-backed resolver over ADR-0037's `sources` + `source_aliases` (B7). A raw
 * workbook site name resolves to its owning `Source` — first by exact canonical
 * `Source.name` (case/whitespace-insensitive), then by the alias table. The
 * source's `site_id` + EFFECTIVE program/non-program classification come back with
 * it. `isNonProgram` is the definitive determination (see {@link isSourceNonProgram}):
 * the explicit `is_non_program` flag OR the out-of-state rule (the source's `state` ≠
 * the recycler's operating state, derived from its site's jurisdiction). Unresolvable
 * names are never dropped — the caller emits an `unresolved_site` finding.
 *
 * Built eagerly (one read of both tables) so `resolve()` stays synchronous, as
 * the `SiteAliasResolver` contract requires. Canonical names win over aliases on
 * a normalized-key collision; a repeated canonical name across sites keeps the
 * first (deterministic by id order).
 */
export async function sourceAliasResolver(db: PrismaClient): Promise<SiteAliasResolver> {
  const sources = await db.source.findMany({
    select: {
      id: true,
      site_id: true,
      name: true,
      is_non_program: true,
      state: true,
      site: { select: { jurisdiction: true } },
      aliases: { select: { alias: true } },
    },
    orderBy: { id: 'asc' },
  });

  // EFFECTIVE program-ness per source (ADR-0037, Rick/Morena): the explicit flag OR the
  // out-of-state rule, keyed on the source's OWN site's recycler state. Computed once per
  // source so both the alias and canonical index entries share it. The `site` relation is
  // always present on the real select; if it is ever absent, fall back to the explicit flag
  // only (the out-of-state rule needs the recycler state — never guess without it).
  const effectiveNonProgram = (s: (typeof sources)[number]): boolean =>
    s.site
      ? isSourceNonProgram(s, recyclerStateForJurisdiction(s.site.jurisdiction))
      : s.is_non_program;

  const index = new Map<string, AliasEntry>();
  // Aliases first (globally unique), then canonical names overlaid on top so a
  // canonical name always wins a normalized-key collision with an alias.
  for (const s of sources) {
    const entry: AliasEntry = {
      sourceId: s.id,
      siteId: s.site_id,
      canonicalName: s.name,
      isNonProgram: effectiveNonProgram(s),
    };
    for (const a of s.aliases) index.set(normalizeName(a.alias), entry);
  }
  const canonicalSeen = new Set<string>();
  for (const s of sources) {
    const key = normalizeName(s.name);
    if (canonicalSeen.has(key)) continue; // first canonical wins on a cross-site name repeat
    canonicalSeen.add(key);
    index.set(key, {
      sourceId: s.id,
      siteId: s.site_id,
      canonicalName: s.name,
      isNonProgram: effectiveNonProgram(s),
    });
  }

  return {
    resolve(rawName: string) {
      return index.get(normalizeName(rawName)) ?? null;
    },
  };
}
