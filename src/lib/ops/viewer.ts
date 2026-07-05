// ADR-0045 — server-side resolution of the current OpsViewer + the org-reach
// guard for the digests surface. Server-only (imports NextAuth via @/lib/auth).

import { auth } from '@/lib/auth';
import type { OpsViewer } from './reach';
import { hasOrgReach } from './reach';

export interface OpsIdentity {
  viewer: OpsViewer;
  userId: string;
}

/** The current caller as an OpsViewer, or null when unauthenticated. */
export async function currentOpsViewer(): Promise<OpsIdentity | null> {
  const session = await auth();
  const u = session?.user;
  if (!u?.id) return null;
  return {
    userId: u.id,
    viewer: {
      role: u.role,
      primarySiteId: u.primary_site_id ?? null,
      allSites: u.all_sites === true,
    },
  };
}

/**
 * Guard for the digests review surface (admin OR all_sites — org reach, NOT
 * admin powers). Throws a `Response` on failure so route handlers can return it.
 */
export async function requireOrgReach(): Promise<OpsIdentity> {
  const id = await currentOpsViewer();
  if (!id) throw new Response('unauthenticated', { status: 401 });
  if (!hasOrgReach(id.viewer)) throw new Response('forbidden', { status: 403 });
  return id;
}
