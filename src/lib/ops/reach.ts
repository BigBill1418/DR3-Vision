// ADR-0045 D1 — reach rules for the ops ledger (hard rule #2, pure).
//
// A row with `site_id` set is SITE-SCOPED: visible to a manager of that site, an
// all_sites manager, or an admin. A row with `site_id = NULL` is ORG-WIDE
// (Bill/Morena cross-site follow-ups) — visible ONLY to admin or an all_sites
// manager. Operators reach nothing here. This is site *reach*, never admin
// *powers*: `role === 'admin' || all_sites` (CLAUDE.md hard rule #2 — do not
// reconflate the two checks).
//
// Kept import-free so it is unit-testable without pulling Prisma/NextAuth.

export interface OpsViewer {
  role: 'operator' | 'manager' | 'admin';
  primarySiteId: string | null;
  allSites: boolean;
}

/** admin OR all_sites — the org-wide (site_id = NULL) reach gate. */
export function hasOrgReach(v: OpsViewer): boolean {
  return v.role === 'admin' || v.allSites === true;
}

/** Can this viewer see one row, given its `site_id` (null = org-wide)? */
export function canSeeRow(v: OpsViewer, rowSiteId: string | null): boolean {
  if (v.role !== 'manager' && v.role !== 'admin') return false;
  if (rowSiteId === null) return hasOrgReach(v);
  if (hasOrgReach(v)) return true;
  return v.primarySiteId === rowSiteId;
}

/**
 * The Prisma `where` fragment for the ledger list on a site page. A plain
 * manager sees only that site's rows; admin / all_sites additionally see the
 * org-wide (site_id = NULL) rows alongside the site's. Shape: `{ OR: [...] }`,
 * returned as a plain object so this module stays Prisma-free.
 */
export function reachWhere(
  v: OpsViewer,
  siteId: string,
): { OR: Array<{ site_id: string | null }> } {
  const clauses: Array<{ site_id: string | null }> = [{ site_id: siteId }];
  if (hasOrgReach(v)) clauses.push({ site_id: null });
  return { OR: clauses };
}

/**
 * Guard for a WRITE against a specific `site_id` (null = org-wide). A plain
 * manager may only write to their own site; org-wide writes require org reach.
 */
export function canWriteRow(v: OpsViewer, rowSiteId: string | null): boolean {
  return canSeeRow(v, rowSiteId);
}
