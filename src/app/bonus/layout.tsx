// Bonus shell layout (ADR-0019.2 §6, T-210). Wraps every `/bonus/**` route and
// renders the "Site: <name> | switch" banner for multi-site admins so they can
// re-pick from anywhere in the bonus surface. Single-site users (Janette, Rick,
// Morena) and denied callers get no banner — just their page.
//
// The banner reflects the picked-site cookie (set by the picker). The layout
// can't read `?site=`, but every pick writes the cookie, so the two stay in
// sync. Access is re-checked here only to decide banner visibility; each page
// still enforces its own gate (CLAUDE.md hard rule #6 — never trust the layout).

import { tryBonusAccess } from '@/lib/bonus/access';
import { SiteSwitchBanner } from './SiteSwitchBanner';

export const dynamic = 'force-dynamic';

export default async function BonusLayout({ children }: { children: React.ReactNode }) {
  const gate = await tryBonusAccess();
  const showBanner = gate.ok && gate.ctx.allowedSites.length > 1;

  return (
    <>
      {showBanner ? <SiteSwitchBanner activeSite={gate.ctx.siteCode} /> : null}
      {children}
    </>
  );
}
