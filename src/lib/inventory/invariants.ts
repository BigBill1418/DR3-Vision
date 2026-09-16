// Data invariants for the inventory running balance (ADR-0131 D2).
//
// These live BESIDE the code whose assumption they encode, not in a central
// directory. ADR-0131 D2's reasoning: a central registry becomes a second document
// maintained in parallel with the ADRs and drifts from both. `running-balance.ts`
// is where the assumption is made; this is where it is made falsifiable.
//
// `src/lib/invariants/registry.ts` imports this module and holds no invariants of
// its own. `src/lib/invariants/colocation.guard.test.ts` fails the build if an
// `invariants.ts` exists anywhere under `src/lib/` that the registry does not
// import - the same shape as `snapshot-void-readers.guard.test.ts`, as D2 directs.

import { NOT_VOIDED } from '@/lib/inventory/snapshot-void';
import { onHand, snapshotTotalUnits, type RunningBalance } from '@/lib/inventory/running-balance';
import { businessDaysBetween } from '@/lib/mymrc/business-days';
import { noOnboardedSites, onboardedSites } from '@/lib/invariants/scope';
import { prisma } from '@/lib/prisma';
import { dayISO, pacificDayISO } from '@/lib/time';
import type {
  Invariant,
  InvariantContext,
  InvariantOutcome,
  Violation,
} from '@/lib/invariants/types';
import { verdict } from '@/lib/invariants/types';

/**
 * How stale a site's physical anchor may get before it is reported.
 *
 * Grounded in the observed production cadence, not picked: Woodland's counts ran
 * 2026-06-30 -> 07-22 -> 08-18, i.e. roughly monthly, and MRC bills monthly. Every
 * downstream floor, COR and billing number is computed FORWARD from the anchor, so
 * once the anchor is older than about three working weeks the next count is due and
 * the balance being invoiced has gone that long unreconciled. Flagging at three
 * weeks is actionable ("schedule the count"); flagging at a month is a postmortem.
 *
 * ADR-0131 D8 #2 states the same invariant in CALENDAR days (14). Business days are
 * used here because the floor cannot be counted on a day it is shut, and
 * `site_holidays` is the list this repo already uses for exactly that question.
 */
export const ANCHOR_STALE_BUSINESS_DAYS = 15;

// -- shared, memoised live balance --------------------------------------------
//
// Three invariants read the same balance. `onHand` is six aggregate queries, so
// computing it once per site per run rather than once per invariant is the
// difference between 6 and 18 scans against a database that is also serving the
// floor. Keyed on the context object so one run never reuses another run's numbers.

const balanceCache = new WeakMap<InvariantContext, Map<string, Promise<RunningBalance>>>();

function balanceFor(ctx: InvariantContext, siteId: string): Promise<RunningBalance> {
  let perRun = balanceCache.get(ctx);
  if (!perRun) {
    perRun = new Map();
    balanceCache.set(ctx, perRun);
  }
  const hit = perRun.get(siteId);
  if (hit) return hit;
  const p = onHand(siteId, ctx.now);
  perRun.set(siteId, p);
  return p;
}

interface SiteRow {
  id: string;
  code: string;
  max_units_indoor: number | null;
  max_units_total_on_site: number | null;
}

/**
 * The sites this suite speaks for — ADR-0131 Amendment 2, 2026-09-15.
 *
 * NOT every row in `sites`. A site is in scope only when its `loads_inventory` UI
 * surface (ADR-0047) is `live`, which is this repo's existing, admin-flipped,
 * audited answer to "is this site running Loads & Inventory?". Every invariant
 * below asserts something about a floor being operated on — a fresh anchor,
 * non-negative pools, a balance inside the permitted storage — and none of those
 * is a meaningful claim about a site that has never recorded a single flow.
 *
 * WHY, concretely: Eugene's surfaces were switched on 2026-07-22 12:54 PT and were
 * never used — 0 `inbound_loads`, 0 `consumer_dropoffs`, 0 `processed_units_daily`,
 * 0 physical counts, ever. `INV-ANCHOR-FRESH` therefore paged at 02:30 PT every
 * night from 2026-09-12 saying Eugene has no count, which was true, actionable by
 * nobody, and indistinguishable in the digest from Woodland's real staleness. Bill,
 * 2026-09-15 9:52 PM PT: _"Eugene is not running it yet - flip it to pilot"_; the
 * five Eugene surfaces went back to `pilot` the same evening.
 *
 * RE-ENTRY IS AUTOMATIC. Flip a site `live` at `/admin/rollout` and it is back in
 * this list on the next 02:30 run with no deploy — and `INV-ANCHOR-FRESH` will then
 * demand a first physical count from it immediately. That is the designed behaviour:
 * a floor being worked and never counted is precisely what it exists to notice.
 *
 * Callers must handle an EMPTY result with {@link noOnboardedSites} rather than
 * `verdict(0, [])`, which would read `ok` until the runner rewrote it.
 *
 * Deliberately NOT narrowed: `INV-ANCHOR-POOLS-SUM` and `INV-ANCHOR-UNIQUE`, which
 * iterate snapshot ROWS. A count row with a broken pool split is wrong wherever it
 * sits, and a stray count at a site that is not supposed to have one is a finding
 * worth keeping, not an out-of-scope subject.
 */
async function sites(): Promise<SiteRow[]> {
  const all = await prisma.site.findMany({
    select: { id: true, code: true, max_units_indoor: true, max_units_total_on_site: true },
    orderBy: { code: 'asc' },
  });
  return onboardedSites(all);
}

export const INVENTORY_INVARIANTS: readonly Invariant[] = [
  {
    id: 'INV-ANCHOR-POOLS-SUM',
    tier: 'refusal',
    title: "A measured physical count's program + non-program pools sum to its physical total",
    adr: 'ADR-0037',
    assumption:
      'A `measured` count with BOTH pools entered must sum to the physical total (MRC is billed on program units only; a wrong split silently mis-bills).',
    severity: 'high',
    gate:
      'q1 actionable in 5min? NO - needs an office correction to a past count. q2 customer-visible? ' +
      'YES: the program pool IS the MRC invoice, so this is a money path. q3 self-heal? none possible. ' +
      'q4 dedup? per invariant, 24h. q5 /status. -> ADR-0131 D6: Tier A, money path, so `high`.',
    remedy:
      'Open the count at /admin/inventory/anchors and re-enter the split so program + non-program equals the physical total; if the total itself is wrong, void the count (ADR-0084) and re-enter it.',
    async check(): Promise<InvariantOutcome> {
      // `reconcilePhysicalCount` validates this on WRITE and throws
      // PoolSplitMismatchError. Nothing has ever checked it again afterwards, and
      // rows can reach this table by routes that are not that function (workbook
      // promotion, migrations, hand SQL).
      //
      // The total is `snapshotTotalUnits`, NOT `units_total`. Woodland is CA and
      // stores its count in `units_indoor`, leaving `units_total` NULL on every
      // row it has ever written — an invariant written against `units_total`
      // alone would compare NULL to NULL and pass on 100% of production forever.
      const rows = await prisma.siteInventorySnapshot.findMany({
        where: { ...NOT_VOIDED, pool_attribution: 'measured' },
        select: {
          id: true,
          snapshot_at: true,
          units_indoor: true,
          units_total: true,
          units_in_processing: true,
          program_units: true,
          non_program_units: true,
          site: { select: { code: true } },
        },
        orderBy: { snapshot_at: 'asc' },
      });

      const violations: Violation[] = [];
      let checked = 0;
      for (const r of rows) {
        // A `measured` row missing either pool column is not a sum mismatch — it
        // is a row `resolveAnchorPair` silently downgrades to `legacy`, attributing
        // the WHOLE count to the program pool. Same billing consequence, different
        // cause, so it is reported distinctly rather than folded into the drift.
        if (r.program_units === null || r.non_program_units === null) {
          violations.push({
            subject: `${r.site.code} ${dayISO(r.snapshot_at)}`,
            detail:
              'pool_attribution="measured" but a pool column is NULL, so resolveAnchorPair ' +
              'downgrades it to "legacy" and attributes the entire count to the PROGRAM pool',
          });
          checked += 1;
          continue;
        }
        checked += 1;
        const total = snapshotTotalUnits(r);
        const sum = r.program_units.plus(r.non_program_units);
        if (!sum.equals(total)) {
          violations.push({
            subject: `${r.site.code} ${dayISO(r.snapshot_at)}`,
            detail: `program ${r.program_units.toString()} + non-program ${r.non_program_units.toString()} = ${sum.toString()}, physical total ${total}`,
          });
        }
      }
      return verdict(checked, violations);
    },
  },

  {
    id: 'INV-ANCHOR-FRESH',
    tier: 'refusal',
    title: 'Every onboarded site has a non-voided physical anchor newer than the count cadence',
    adr: 'ADR-0037',
    assumption:
      'Every site ONBOARDED to Loads & Inventory - its `loads_inventory` UI surface is `live` - has a non-voided physical anchor newer than the count cadence. Narrowed from "every active site" by ADR-0131 Amendment 2; a site in `pilot` is not being operated on, so it has nothing to anchor.',
    severity: 'default',
    gate:
      'q1 actionable in 5min? NO - the fix is to schedule a floor count. q2 customer-visible? ' +
      'the billed balance is unreconciled, so eventually. q3 self-heal? no. q4 dedup? per invariant, 24h. ' +
      'q5 /status. -> ADR-0131 D6: Tier A, not directly a money path, so `default`.',
    remedy:
      'Schedule a floor count at the named site. Until one exists, every number computed forward from the anchor - floor tile, COR, MRC invoice - rests on an unverified base.',
    async check(ctx): Promise<InvariantOutcome> {
      const all = await sites();
      if (all.length === 0) return noOnboardedSites();
      const holidayRows = await prisma.siteHoliday.findMany({
        select: { site_id: true, holiday_date: true },
      });
      const today = pacificDayISO(ctx.now);

      const violations: Violation[] = [];
      for (const s of all) {
        const holidays = new Set(
          holidayRows.filter((h) => h.site_id === s.id).map((h) => dayISO(h.holiday_date)),
        );
        const anchor = await prisma.siteInventorySnapshot.findFirst({
          where: { ...NOT_VOIDED, site_id: s.id, snapshot_kind: 'physical' },
          orderBy: [{ snapshot_at: 'desc' }, { created_at: 'desc' }],
          select: { snapshot_at: true },
        });
        if (!anchor) {
          // Not "stale" — ABSENT. onHand falls back to a zero anchor and counts
          // every flow since the epoch, so the site's whole floor is computed
          // from nothing that was ever physically verified.
          violations.push({
            subject: s.code,
            detail: 'no non-voided physical count has EVER been recorded; onHand anchors on zero',
          });
          continue;
        }
        const age = businessDaysBetween(dayISO(anchor.snapshot_at), today, holidays);
        if (age > ANCHOR_STALE_BUSINESS_DAYS) {
          violations.push({
            subject: s.code,
            detail: `newest anchor ${dayISO(anchor.snapshot_at)} is ${age} business days old (limit ${ANCHOR_STALE_BUSINESS_DAYS})`,
          });
        }
      }
      return verdict(all.length, violations);
    },
  },

  {
    id: 'INV-ANCHOR-UNIQUE',
    tier: 'refusal',
    title: 'No two non-voided physical counts at one site share a snapshot instant',
    adr: 'ADR-0078',
    assumption: 'No two non-voided physical snapshots share `(site_id, snapshot_at)`.',
    severity: 'default',
    gate:
      'q1 actionable in 5min? NO - needs a human to decide which count is right. q2 customer-visible? ' +
      'the anchor is ambiguous, so every forward number is. q3 self-heal? ADR-0078 D1 created_at tiebreak ' +
      'already resolves it deterministically. q4 dedup? per invariant. q5 /status. -> Tier A, `default`.',
    remedy:
      'Decide which count is correct and void the other at /admin/inventory/anchors. Until then the anchor is chosen by the ADR-0078 D1 created_at tiebreak, which is deterministic but was never a decision anyone made.',
    async check(): Promise<InvariantOutcome> {
      // The shape ADR-0078 D1 was written for. Two same-instant counts are a
      // SUPPORTED state (the floor anchors every count at Pacific midnight), and
      // the created_at tiebreak resolves them — so this is not "impossible", it is
      // "the tiebreak is now load-bearing and somebody should look".
      const rows = await prisma.siteInventorySnapshot.findMany({
        where: { ...NOT_VOIDED, snapshot_kind: 'physical' },
        select: {
          snapshot_at: true,
          reconciled_delta: true,
          created_at: true,
          site: { select: { code: true } },
        },
        orderBy: [{ snapshot_at: 'asc' }, { created_at: 'asc' }],
      });

      const byKey = new Map<string, typeof rows>();
      for (const r of rows) {
        const key = `${r.site.code}|${r.snapshot_at.toISOString()}`;
        const bucket = byKey.get(key) ?? [];
        bucket.push(r);
        byKey.set(key, bucket);
      }
      const violations: Violation[] = [];
      for (const [key, bucket] of byKey) {
        if (bucket.length < 2) continue;
        const deltas = bucket.map((b) =>
          b.reconciled_delta === null ? 'null' : String(b.reconciled_delta),
        );
        violations.push({
          subject: key.replace('|', ' '),
          detail: `${bucket.length} live counts share this instant with reconciled_delta [${deltas.join(', ')}]; the ADR-0078 created_at tiebreak decides the anchor`,
        });
      }
      // Subjects are the (site, instant) GROUPS, not the rows — a site with one
      // count has one opportunity to violate this and did not take it.
      return verdict(byKey.size, violations);
    },
  },

  {
    id: 'INV-ONHAND-COMPUTABLE',
    tier: 'refusal',
    title: 'The live on-hand balance computes at every onboarded site without refusing',
    adr: 'ADR-0037',
    assumption:
      'Refused rather than summed: an untaught kind added to the program pool by default is a silent mis-billing.',
    severity: 'default',
    gate:
      'q1 actionable in 5min? partly - an untaught drop-off kind is a one-line map entry. ' +
      'q2 customer-visible? YES, the floor tile and the COR both go dark. q3 self-heal? no. ' +
      'q4 dedup? per invariant. q5 /status. -> Tier A, `default`.',
    remedy:
      'If onHand REFUSED: add the named drop-off kind to DROPOFF_KIND_POOL in src/lib/inventory/running-balance.ts, deciding which pool it belongs to. If the anchor resolved legacy unexpectedly: the measured count is missing a pool column - see INV-ANCHOR-POOLS-SUM.',
    async check(ctx): Promise<InvariantOutcome> {
      // The falsifiable part is the REFUSAL path, not the arithmetic.
      //
      // Note what is deliberately NOT asserted here: `program + nonProgram ===
      // total`. `computeRunningBalance` builds `total` AS `program.plus(nonProgram)`,
      // so that equality is true by construction and no production data can ever
      // break it. It is a tautology, and a tautology in a monitoring suite is worse
      // than nothing — it is a green light wired to a battery.
      //
      // What CAN fail, and has: `UnknownDropoffKindError`, thrown when a
      // ConsumerDropoff kind reaches the balance that DROPOFF_KIND_POOL was never
      // taught (the door a hand-written `ALTER TYPE ... ADD VALUE` comes through,
      // where the compile-time gate never fires). Also reported: an anchor that
      // resolved `legacy` while a measured count exists, which silently moves the
      // whole floor into the program pool.
      const all = await sites();
      if (all.length === 0) return noOnboardedSites();
      const violations: Violation[] = [];
      for (const s of all) {
        try {
          const b = await balanceFor(ctx, s.id);
          if (b.anchorPool === 'legacy') {
            const measured = await prisma.siteInventorySnapshot.count({
              where: {
                ...NOT_VOIDED,
                site_id: s.id,
                snapshot_kind: 'physical',
                pool_attribution: 'measured',
              },
            });
            if (measured > 0) {
              violations.push({
                subject: s.code,
                detail: `balance resolved anchorPool="legacy" though ${measured} measured count(s) exist; the whole floor is attributed to the PROGRAM pool`,
              });
            }
          }
        } catch (err) {
          violations.push({
            subject: s.code,
            detail: `onHand REFUSED: ${(err as Error).name}: ${(err as Error).message.slice(0, 160)}`,
          });
        }
      }
      return verdict(all.length, violations);
    },
  },

  {
    id: 'INV-POOL-NON-NEGATIVE',
    tier: 'refusal',
    title: 'No inventory pool is negative at any onboarded site',
    adr: 'ADR-0037',
    assumption:
      'Inventory is two ledgers - program / non-program - because MRC is billed on PROGRAM units only.',
    severity: 'default',
    gate:
      'q1 actionable in 5min? NO - finding the wrong leg is an investigation. q2 customer-visible? ' +
      'YES, MRC is billed off the program pool. q3 self-heal? no. q4 dedup? per invariant. ' +
      'q5 /status. -> Tier A, `default` (the money consequence is downstream of an investigation).',
    remedy:
      'A negative pool means an outflow leg exceeds its inflow since the anchor. Compare the legs against the workbook for the window since the anchor date; do not take a new physical count until the leg is found, because a count would absorb the error into reconciled_delta and hide it.',
    async check(ctx): Promise<InvariantOutcome> {
      // The 2026-07-30 negative-inventory class. A negative pool is arithmetically
      // possible (the balance subtracts freely) and physically impossible, so it is
      // a pure statement about the data.
      const all = await sites();
      if (all.length === 0) return noOnboardedSites();
      const violations: Violation[] = [];
      let checked = 0;
      for (const s of all) {
        let b: RunningBalance;
        try {
          b = await balanceFor(ctx, s.id);
        } catch {
          // INV-004 owns the refusal. Reporting it twice would page twice for one
          // cause, which is exactly ADR-0037 question 4.
          continue;
        }
        checked += 1;
        for (const [pool, v] of [
          ['program', b.program],
          ['non-program', b.nonProgram],
        ] as const) {
          if (v.isNegative()) {
            violations.push({ subject: `${s.code} ${pool}`, detail: `${v.toString()} units` });
          }
        }
      }
      return verdict(checked, violations);
    },
  },

  {
    id: 'INV-FLOOR-WITHIN-CAPACITY',
    tier: 'implausibility',
    title: "The computed on-hand balance does not exceed the site's permitted storage",
    adr: 'ADR-0131',
    assumption: "A site's computed on-hand does not exceed `sites.max_units_indoor`.",
    severity: 'default',
    gate:
      'ADR-0131 D8 #9 grades this Tier B deliberately: a floor legitimately over capacity is an ' +
      'operational emergency, not a data error, and paging about it would be paging about mattresses ' +
      'rather than about numbers. Tier B NEVER pages (D6) - digest and dashboard only, whatever ' +
      'severity says. It is still the loudest line in the digest when it fires.',
    remedy:
      'Compare the computed legs since the anchor against the workbook. A floor genuinely over its contract cap is an operational escalation to the site manager; a floor that only READS over cap is a bad flow row - ADR-0131 Context records the 2026-09-04 case, two MyMRC haul rows carrying 6,020 and 4,840 units against an all-time observed maximum of 342.',
    async check(ctx): Promise<InvariantOutcome> {
      // Not in the seed list, and it is the one that fires hardest right now.
      //
      // Every other inventory invariant checks the balance against ITSELF. This one
      // checks it against an EXTERNAL, contractual number nobody in the balance code
      // path can move: the site's permitted storage. That is what makes it able to
      // catch a leg that is wrong but internally consistent — the exact shape where
      // inbound and stripped both agree and both are inflated.
      //
      // Capacity is `max_units_total_on_site + max_units_indoor` with NULLs as zero,
      // reusing the definition metric6StorageInventory in compliance.ts already
      // uses. CA grades on the indoor cap, OR on the total on-site cap; there is no
      // outdoor addend (ADR-0037 addendum 2026-07-22).
      const all = await sites();
      if (all.length === 0) return noOnboardedSites();
      const violations: Violation[] = [];
      let checked = 0;
      for (const s of all) {
        const capacity = (s.max_units_total_on_site ?? 0) + (s.max_units_indoor ?? 0);
        if (capacity <= 0) continue; // no cap recorded: nothing to assert against
        let b: RunningBalance;
        try {
          b = await balanceFor(ctx, s.id);
        } catch {
          continue; // INV-004 owns the refusal
        }
        checked += 1;
        if (b.total.greaterThan(capacity)) {
          const pct = b.total.times(100).dividedBy(capacity).toFixed(0);
          violations.push({
            subject: s.code,
            detail: `computed on-hand ${b.total.toString()} (program ${b.program.toString()} / non-program ${b.nonProgram.toString()}) is ${pct}% of the ${capacity}-unit permitted maximum`,
          });
        }
      }
      return verdict(checked, violations);
    },
  },
];
