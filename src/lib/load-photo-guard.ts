import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// Shared operator-owns-load guard for the photo-upload routes.
// Returns the load on success; throws a Response on failure so the
// route handler can `return` it directly.

export async function requireOperatorOwnsLoad(loadId: string): Promise<{
  loadId: string;
  operatorUserId: string;
  siteId: string;
}> {
  const session = await auth();
  if (!session?.user || session.user.role !== 'operator') {
    throw new Response('forbidden', { status: 403 });
  }
  const load = await prisma.inboundLoad.findUnique({
    where: { id: loadId },
    select: { id: true, site_id: true, assigned_operator_id: true },
  });
  if (!load) throw new Response('load not found', { status: 404 });
  if (load.assigned_operator_id !== session.user.id) {
    throw new Response('forbidden', { status: 403 });
  }
  if (session.user.primary_site_id !== load.site_id) {
    throw new Response('forbidden', { status: 403 });
  }
  return {
    loadId: load.id,
    operatorUserId: session.user.id,
    siteId: load.site_id,
  };
}
