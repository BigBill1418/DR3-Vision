// ADR-0066 §1.4 — second-approval routing. One of two doors into the SINGLE
// AP configuration screen (see `../config/render.tsx`); the resolver's own
// `problems` message points admins here by name, which is why the route exists
// separately from `/admin/ap/notifications`.

import { renderApConfigPage, type ApConfigPageProps } from '../config/render';

export const dynamic = 'force-dynamic';

export default async function AdminApRoutingPage(props: ApConfigPageProps) {
  return renderApConfigPage('routing', props);
}
