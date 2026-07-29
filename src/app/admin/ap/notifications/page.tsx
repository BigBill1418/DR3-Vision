// ADR-0066 §1.6 — per-user AP notification preferences. The second door into
// the SINGLE AP configuration screen (see `../config/render.tsx`) — same page,
// anchored on the prefs half.

import { renderApConfigPage, type ApConfigPageProps } from '../config/render';

export const dynamic = 'force-dynamic';

export default async function AdminApNotificationsPage(props: ApConfigPageProps) {
  return renderApConfigPage('notifications', props);
}
