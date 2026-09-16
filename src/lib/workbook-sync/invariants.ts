// Data invariants for the workbook-sync transport (ADR-0131 D2).
//
// Co-located with `engine.ts`, whose monthly folder resolution is the assumption
// being pinned. ADR-0131 D2 nominates `src/lib/mymrc/invariants.ts` for this;
// it cannot live there. `tsconfig.mymrc.json` pins `rootDir: ./src/lib/mymrc` and
// the MyMRC bundle has no `@/` alias, so any file under that directory importing
// `@/lib/prisma` breaks `npm run build:mymrc` with TS6059 - the same forced
// placement recorded in `cooldown-store.ts` and `ntfy-header-safe.ts`. The workbook
// source row belongs to `workbook-sync` in any case; this is where its reader is.

import { noOnboardedSites, onboardedSites } from '@/lib/invariants/scope';
import { prisma } from '@/lib/prisma';
import type { Invariant, InvariantOutcome, Violation } from '@/lib/invariants/types';
import { verdict } from '@/lib/invariants/types';

export const WORKBOOK_SYNC_INVARIANTS: readonly Invariant[] = [
  {
    id: 'INV-WORKBOOK-PATH-TOKEN',
    tier: 'refusal',
    title: "Every onboarded site's workbook source exists and carries a tokenised monthly path",
    adr: 'ADR-0102',
    assumption:
      'Every `workbook_sources.folder_path` contains a `{` token - asked of every site ONBOARDED to Loads & Inventory (its `loads_inventory` UI surface is `live`), which is the set of sites that is supposed to have a source row at all (ADR-0131 Amendment 2).',
    severity: 'default',
    gate:
      'q1 actionable in 5min? YES - the fix is one admin field. q2 customer-visible? no, it stalls ' +
      'ingestion silently. q3 self-heal? the poller retries forever and never succeeds. q4 dedup? per ' +
      'invariant. q5 /status. -> Tier A, `default`.',
    remedy:
      'Set the folder path at /admin/workbook-sync to the tokenised form. The save-time guard (422 folder_path_untokenised_month) refuses an untokenised month, so this can only be an unmigrated row or a site with no row at all.',
    async check(): Promise<InvariantOutcome> {
      // P-63. ADR-0102's rollover fix shipped in engine.ts and the production row
      // kept the literal `August 2026 Woodland`, so the transport asked for
      // September's file inside August's folder for 398 polls. The ADR predicted it
      // in writing and nothing checked the row afterwards.
      //
      // Subjects are SITES, not workbook_sources rows, and that is the whole point.
      // Scoped to existing ROWS this invariant would examine Woodland, pass, and be
      // structurally incapable of seeing that Eugene has no row at all — a green
      // light over a blind spot. So the subject list is still built from `sites`.
      //
      // THE DELIBERATE NARROWING, recorded HERE as the previous version of this
      // comment asked for (ADR-0131 Amendment 2, 2026-09-15).
      //
      // A single-site source registry IS intentional today, and this invariant now
      // says so: it speaks only for sites ONBOARDED to Loads & Inventory — those
      // whose `loads_inventory` UI surface (ADR-0047) is `live`. That row is the
      // repo's existing, admin-flipped, audited onboarding signal, so there is no
      // new `sites` column and no second definition to drift from it.
      //
      // WHY. Eugene's surfaces were switched on 2026-07-22 12:54 PT and never used —
      // no daily log, no counts, zero rows in every flow table — so this invariant
      // paged at 02:30 PT every night from 2026-09-12 for a missing workbook source
      // that nobody was ever going to create. Bill, 2026-09-15 9:52 PM PT: _"Eugene
      // is not running it yet - flip it to pilot"_. OPEN-ITEMS 0.BT BT-3.
      //
      // WHAT IS NOT SEALED. The blind spot is scoped, not covered over. An ONBOARDED
      // site with no `workbook_sources` row is still a violation, by name — see the
      // `!src` branch below — because a site running the flow with no daily log is
      // the exact P-63 shape this was written for. And re-entry is automatic: flip a
      // site `live` and it is a subject again on the next 02:30 run, with no deploy.
      const all = await onboardedSites(
        await prisma.site.findMany({ select: { id: true, code: true }, orderBy: { code: 'asc' } }),
      );
      if (all.length === 0) return noOnboardedSites();
      const sources = await prisma.workbookSource.findMany({
        select: { site_id: true, folder_path: true, naming_pattern: true, is_syncing: true },
      });
      const violations: Violation[] = [];
      for (const s of all) {
        const src = sources.find((x) => x.site_id === s.id);
        if (!src) {
          violations.push({
            subject: s.code,
            detail:
              'site is ONBOARDED to Loads & Inventory (`loads_inventory` live) but has no ' +
              'workbook_sources row, so its daily log is never ingested and nothing rolls',
          });
          continue;
        }
        // The time-bomb shape: a path that names one month resolves correctly on the
        // day it is typed and silently wrongly on the 1st of the next.
        if (!src.folder_path.includes('{')) {
          violations.push({
            subject: s.code,
            detail: `folder_path "${src.folder_path}" carries no {TOKEN}; it cannot roll to the next month`,
          });
        }
        if (!src.naming_pattern.includes('{')) {
          violations.push({
            subject: s.code,
            detail: `naming_pattern "${src.naming_pattern}" carries no {TOKEN}; it cannot roll to the next month`,
          });
        }
      }
      return verdict(all.length, violations);
    },
  },
];
