// ADR-0143 — shared access gate for the inventory-exception pages. A manager with
// reach to the site (ADR-0024) sees them once Bill ramps the `inventory_exceptions`
// surface; until then (born pilot, CLAUDE.md hard rule 12) admins only.
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';

export type ExceptionGate =
  | { ok: true; siteId: string; siteName: string; userId: string; role: string }
  | { ok: false; page: React.ReactElement };

export async function exceptionGate(siteCode: string, nextPath: string): Promise<ExceptionGate> {
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=${nextPath}`);
    return {
      ok: false,
      page: <Denied siteCode={siteCode} title="Access denied" body="This area is restricted." />,
    };
  }
  const live = await isUiSurfaceLive(UI_SURFACE.INVENTORY_EXCEPTIONS, result.ctx.siteId);
  if (result.ctx.role !== 'admin' && !live) {
    return {
      ok: false,
      page: (
        <Denied
          siteCode={siteCode}
          title="Not yet activated"
          body="Inventory exceptions (ADR-0143) are staged but not yet activated for this site. Admin access only until an admin flips the inventory_exceptions rollout surface live."
        />
      ),
    };
  }
  return {
    ok: true,
    siteId: result.ctx.siteId,
    siteName: result.ctx.siteName,
    userId: result.ctx.userId,
    role: result.ctx.role,
  };
}

function Denied({ siteCode, title, body }: { siteCode: string; title: string; body: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-md opacity-80">{body}</p>
      <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
        Back to dashboard
      </Link>
    </main>
  );
}
