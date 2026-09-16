// Data invariants for the inbound haul mirror (ADR-0131 D2, D8 #8).
//
// Co-located with `portal-hauls.ts`, the app-side per-haul reader of
// `mymrc_hauls_mirror`. ADR-0131 D2 would put this beside the inbound bridge in
// `src/lib/mymrc/`; it cannot live there — `tsconfig.mymrc.json` pins
// `rootDir: ./src/lib/mymrc` with no `@/` alias, so a file under it importing
// `@/lib/prisma` breaks `npm run build:mymrc` with TS6059 (the same forced
// placement recorded in `cooldown-store.ts` and `ntfy-header-safe.ts`).

import { noOnboardedSites, onboardedSites } from '@/lib/invariants/scope';
import { prisma } from '@/lib/prisma';
import type { Invariant, InvariantOutcome, Violation } from '@/lib/invariants/types';
import { verdict } from '@/lib/invariants/types';

/**
 * The most program units one haul may carry before it is reported as implausible.
 *
 * **Measured against production 2026-09-11, not assumed.** Over the 1,096 live
 * `Delivered`/`General` rows in `mymrc_hauls_mirror`, exactly TWO exceed this:
 * H-138391 (6,020 units / 331,100 lb) and H-139774 (4,840 / 266,200), both on 53'
 * trailers. Excluding those two, the all-time maximum across every unit column
 * (`program_unit_count`, `units`, `unit_count_at_unload`, and program+non-program
 * combined) is **303**, over 1,094 rows. 350 leaves ~15% headroom above the highest
 * load DR3 has ever actually delivered.
 *
 * Physical sanity agrees: 331,100 lb is about 165 tons of mattresses on a trailer
 * whose legal gross is roughly 40 tons.
 *
 * CALIBRATION NOTE, stated because it differs from the record. ADR-0131 D8 #8 gives
 * the basis as "observed maximum ever is 342, over 6,551 rows". Neither number
 * reproduces against production tonight on any filter tried: all mirror rows = 7,568,
 * live = 1,112, live Delivered General = 1,096; and the max excluding the two
 * offenders is 303, not 342, on every unit column. The THRESHOLD is unchanged — 350
 * clears 303 with room and catches both offenders by more than an order of magnitude
 * — but the basis recorded here is the one that can be re-derived.
 */
export const HAUL_UNIT_PLAUSIBILITY_MAX = 350;

/** Live, delivered, general — the rows that actually reach the running balance. */
const LIVE_DELIVERED_GENERAL = {
  disappeared_at: null,
  status: 'Delivered',
  type: 'General',
} as const;

export const LOADS_INVARIANTS: readonly Invariant[] = [
  {
    id: 'INV-INBOUND-PLAUSIBLE',
    tier: 'implausibility',
    title:
      'No delivered haul at an onboarded site carries more program units than a trailer can hold',
    adr: 'ADR-0131',
    assumption:
      'No Delivered General haul carries more units than the largest container can hold - asked of hauls at sites ONBOARDED to Loads & Inventory (`loads_inventory` UI surface `live`), the only sites whose hauls reach a running balance (ADR-0131 Amendment 2).',
    severity: 'default',
    gate:
      'ADR-0131 D1/D6 put this in Tier B, and the reason is not caution: there is no ' +
      'PROVABLE statement that 6,020 units is false. MyMRC asserts it and MyMRC is the ' +
      'system of record, so the honest claim is only "this is far outside anything this ' +
      'system has ever seen". Tier B NEVER pages - digest and dashboard only.',
    remedy:
      "The value is upstream, in MyMRC's own Salesforce org (`Recycler_Program_Unit_Count__c`). " +
      'Establish the true count from the dock paperwork or the BOL and have MRC correct it IN ' +
      'MyMRC (BS-1). The hourly scrape then re-details the row, the bridge rewrites the day ' +
      'aggregate as an absolute SET, and the floor self-heals with no code change and no ' +
      'database write. DO NOT hand-edit `mymrc_hauls_mirror` or `inbound_loads` - the mirror is ' +
      'a copy and the next scrape overwrites it (ADR-0084 standing rule).',
    async check(): Promise<InvariantOutcome> {
      // THE TABLE IS THE DESIGN. This thresholds the PER-HAUL mirror, never
      // `inbound_loads`, which is a per-site-per-DAY aggregate (ADR-0060 D5): 598 of
      // its 650 verified rows exceed 350 legitimately, because one day holds several
      // hauls. Pointing this invariant at the table the balance reads would produce
      // a 598-row false positive on its first run, and a suite that cries wolf once
      // is a suite that gets muted.
      //
      // `disappeared_at IS NULL` matters as much: a withdrawn row is a correction MRC
      // has already made, and reporting it would page about the fix.
      //
      // ADR-0131 Amendment 2 — scoped to ONBOARDED sites, the same predicate the
      // inventory and workbook-sync invariants now use, because this one is keyed on
      // `mymrc_hauls_mirror.site_id` and an implausible haul only matters where it
      // reaches a floor. Two things make the narrowing safe rather than a new blind
      // spot: (1) `inbound-bridge.ts` already filters `site_id: { not: null }`, so an
      // UNATTRIBUTED mirror row never reaches `inbound_loads` and never moves any
      // balance — a site-keyed scope loses nothing the ledger can see; (2) the scope
      // is the site list, never the threshold, so Woodland's H-138391 / H-139774 keep
      // being named until MRC corrects them upstream (OPEN-ITEMS BS-1).
      const sites = await onboardedSites(
        await prisma.site.findMany({ select: { id: true, code: true } }),
      );
      if (sites.length === 0) return noOnboardedSites();
      const siteIds = sites.map((s) => s.id);
      const [subjects, offenders] = await Promise.all([
        prisma.mymrcHaulsMirror.count({
          where: { ...LIVE_DELIVERED_GENERAL, site_id: { in: siteIds } },
        }),
        prisma.mymrcHaulsMirror.findMany({
          where: {
            ...LIVE_DELIVERED_GENERAL,
            site_id: { in: siteIds },
            program_unit_count: { gt: HAUL_UNIT_PLAUSIBILITY_MAX },
          },
          select: {
            external_haul_id: true,
            site_id: true,
            program_unit_count: true,
            non_program_unit_count: true,
            weight_lbs: true,
            container_type: true,
            recycler_reported_delivery_date: true,
          },
          orderBy: { program_unit_count: 'desc' },
          // A bound, so a systemic upstream break reports the worst offenders rather
          // than a body that cannot be read. The `subjects` count above still states
          // the true denominator.
          take: 20,
        }),
      ]);
      // `mymrc_hauls_mirror.site_id` is a BARE column, not a Prisma relation (the
      // mirror is a copy of someone else's org and deliberately owns no edges), so
      // the site code is resolved here rather than through an include.
      const codeById = new Map(sites.map((s) => [s.id, s.code]));

      const violations: Violation[] = offenders.map((h) => {
        const day = h.recycler_reported_delivery_date;
        const lbs = h.weight_lbs === null ? 'unknown' : `${h.weight_lbs.toString()} lb`;
        return {
          subject: `${(h.site_id && codeById.get(h.site_id)) ?? 'unknown-site'} ${h.external_haul_id ?? '(no haul id)'}`,
          detail:
            `${h.program_unit_count} program units on a ${h.container_type ?? 'unknown container'} ` +
            `(${lbs}) delivered ${day ? day.toISOString().slice(0, 10) : 'unknown date'}; ` +
            `threshold ${HAUL_UNIT_PLAUSIBILITY_MAX}, highest ever legitimately recorded 303`,
        };
      });

      // The OPPORTUNITY count is every live haul AT AN ONBOARDED SITE, not the
      // offenders and not every row in the mirror. Reporting only
      // the filtered rows would make a clean run `ok` over zero subjects, which the
      // runner rewrites to indeterminate — leaving the invariant permanently
      // "unchecked" and therefore permanently ignored.
      return verdict(subjects, violations);
    },
  },
];
