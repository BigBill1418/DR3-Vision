// Bonus shell header banner (ADR-0019.2 §6, T-210). Shown on every `/bonus/**`
// route for callers who can reach more than one site (admins). Displays
// "Site: <name> | switch"; the switch control posts `switchBonusSiteAction`
// which clears the picked-site cookie and returns the admin to the picker.
//
// Single-site users never see this banner (their site is fixed). Pure server
// component; the switch is a <form> bound to a server action — no client JS.
// Styled for the DARK dr3-space / cyan dashboard theme.

import type { SiteCode } from '@/lib/bonus/access';
import { switchBonusSiteAction } from './site-actions';

const SITE_LABEL: Record<SiteCode, string> = {
  woodland: 'Woodland',
  eugene: 'Eugene',
};

export function SiteSwitchBanner({ activeSite }: { activeSite: SiteCode }) {
  return (
    <div className="border-b border-dr3-steel-light/20 bg-dr3-space-2/60">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-6 py-2 text-sm">
        <span className="text-dr3-mist-dim">
          Site: <span className="font-semibold text-dr3-mist">{SITE_LABEL[activeSite]}</span>
        </span>
        <form action={switchBonusSiteAction}>
          <button
            type="submit"
            className="font-medium text-dr3-cyan underline-offset-4 hover:text-dr3-cyan-bright hover:underline focus:outline-none focus:ring-2 focus:ring-dr3-cyan focus:ring-offset-2 focus:ring-offset-dr3-space"
          >
            switch
          </button>
        </form>
      </div>
    </div>
  );
}
