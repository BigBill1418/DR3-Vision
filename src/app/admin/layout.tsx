// Admin route-group layout (ADR-0064). Before this, `/admin/**` had NO group
// layout at all, so its ~27 pages offered no in-app path back to the Vision
// Dashboard (`/`) — you were stuck on the browser Back button. This mounts the
// shared back-to-dashboard bar for every admin page.
//
// The admin surface is English-only per ADR-0017, so — unlike the bonus and
// dashboard groups — this layout intentionally does NOT mount an I18nProvider.
// It renders the presentational bar directly with plain English strings.

import { ManagerChromeBar } from '@/app/_components/manager-chrome';
import { adminMessages as AM } from './messages';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ManagerChromeBar
        backLabel={AM.nav.backToDashboard}
        backAriaLabel={AM.nav.backToDashboardAria}
        signOutLabel={AM.nav.signOut}
        signOutAriaLabel={AM.nav.signOutAria}
      />
      {children}
    </>
  );
}
