'use client';

// ADR-0057 — /admin/mrc-scrape composition.
//
// Thin client shell that stitches the two independently-built surfaces together:
// the credential-entry form (write path) and the read-only status panel. It owns
// a single `refreshKey` so a successful credential save immediately re-pulls the
// status panel (which fetches client-side and would otherwise not know a save
// happened). Each surface stays self-contained; this only bridges save → refetch.

import { useState } from 'react';
import { MrcScrapeForm } from './MrcScrapeForm';
import { ScrapeStatus } from './ScrapeStatus';

interface Props {
  configured: boolean;
  username: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function MrcScrapePanels({ configured, username, updatedAt, updatedBy }: Props) {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="flex flex-col gap-8">
      <MrcScrapeForm
        configured={configured}
        username={username}
        updatedAt={updatedAt}
        updatedBy={updatedBy}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />
      <ScrapeStatus refreshKey={refreshKey} />
    </div>
  );
}
