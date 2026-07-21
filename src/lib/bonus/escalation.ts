// Bonus signature-escalation orchestration (ADR-0019.1 §3/§4/§6, T-205 + T-206).
//
// This is the testable heart behind `/api/internal/bonus/escalation-check`,
// which the thin Pacific-aware daemon `scripts/bonus-escalation-check.mjs` POSTs
// once per tier at the four Pacific wall-clock times. Keeping the logic here (TS,
// unit-tested) rather than in the `.mjs` mirrors the period-close split (T-204):
// the `.mjs` stays a DST-safe scheduler; the orchestration stays in TypeScript
// behind the state machine.
//
// The four tiers (one per fire):
//   t1 06:00 PT — low-urgency ntfy per still-unsigned slot.
//   t2 07:30 PT — urgent ntfy per still-unsigned slot; body lists the
//                 override-authorized humans from the signature chain.
//   t3 08:30 PT — AUTO-OVERRIDE: sign each still-unsigned slot AS the chain's
//                 auto_override_actor via the SAME override path as a manual
//                 override (recordSignature), stamping `*_auto_override_at` and
//                 the ADR-0019.1 reason; this triggers the existing
//                 post-signature side-effects (PDF + M365). The auto-override
//                 actor MUST be a valid ACTIVE user first — else urgent ntfy +
//                 NO auto-sign (addendum risk-mitigation row).
//   t4 09:00 PT — (T-206) urgent payroll-deadline-missed ntfy for any
//                 yesterday's-period that has not reached `paid`.
//
// SCOPE: "yesterday's-close" periods — `state IN ('pending_signatures',
// 'partially_signed')` (t1–t3) or `state != 'paid'` (t4) AND `period_end ==
// appToday() - 1 day` (Pacific). The `now` passed in is the @db.Date-shaped
// Pacific "today" key; we subtract one calendar day for the period_end match.

import type { Prisma, PrismaClient } from '@prisma/client';
import { recordSignature, type SignatureSlot } from '@/lib/bonus/signatures';
import { getSignatureChain } from '@/lib/bonus/signature-chain';
import { triggerPayrollDelivery } from '@/lib/bonus/payroll-delivery';
import { publishNtfy } from '@/lib/ntfy';
import { log } from '@/lib/observability/logger';

// ────────────────────────────────────────────────────────────────────
// Tiers
// ────────────────────────────────────────────────────────────────────

/** The four escalation fires (06:00 / 07:30 / 08:30 / 09:00 PT). */
export type EscalationTier = 't1' | 't2' | 't3' | 't4';

const TIERS: ReadonlySet<string> = new Set<EscalationTier>(['t1', 't2', 't3', 't4']);

/** Type-guard for the `tier` query param. */
export function isEscalationTier(v: string | null): v is EscalationTier {
  return v !== null && TIERS.has(v);
}

// The ADR-0019.1 §4 reason text (system override). `<slot label>` is the
// human-readable slot the system signed on behalf of.
function escalationReason(slotLabel: string): string {
  return (
    `system-applied admin override per ADR-0019.1 escalation policy after ` +
    `the ${slotLabel} slot failed to sign by 08:30 AM PT deadline`
  );
}

/** ntfy priority mapping (ADR-0037 §1): t1 low-urgency, t2–t4 urgent. */
const TIER_PRIORITY = { t1: 'default', t2: 'urgent' } as const;

// ────────────────────────────────────────────────────────────────────
// DB seams (structural — production passes the Prisma singleton; tests inject)
// ────────────────────────────────────────────────────────────────────

/** One yesterday's-close period row the escalation logic reads. */
export interface EscalationPeriodRow {
  id: string;
  site_id: string;
  period_number: number;
  period_year: number;
  /** @db.Date-shaped period-end key — used by t4 to tell a stranded (older) period from today's deadline. */
  period_end: Date;
  state: string;
  facility_signed_by_user_id: string | null;
  ops_signed_by_user_id: string | null;
  site: { code: string; name: string };
}

/**
 * This module reads periods + users, resolves the signature chain, and calls
 * `recordSignature` (which needs the full signature/tx surface). Rather than
 * maintain a hand-rolled structural seam broad enough to satisfy all of those
 * AND stay PrismaClient-assignable under `exactOptionalPropertyTypes`, we type
 * `db` as the real `PrismaClient`. The route passes the singleton; tests inject
 * a small double cast `as unknown as PrismaClient` (only the methods exercised
 * by the tier under test need to exist on the double).
 */
export type EscalationDb = PrismaClient;

export interface RunEscalationOpts {
  db: EscalationDb;
  tier: EscalationTier;
  /** @db.Date-shaped Pacific "today" key (callers pass `appToday()`). */
  now: Date;
}

export interface RunEscalationResult {
  tier: EscalationTier;
  /** Yesterday's-close periods examined for this tier. */
  periodsExamined: number;
  /** Count of ntfy publishes attempted (warning / urgent / deadline-missed). */
  ntfyPublished: number;
  /** Count of slots auto-signed at t3. */
  autoSigned: number;
  /** Count of periods that fired the t4 deadline-missed alert. */
  deadlineMissed: number;
  /** Count of periods that fired the t4 STRANDED alert (missed their window on an earlier day). */
  stranded: number;
  /** Count of sites where the configured auto-override actor was unavailable. */
  actorUnavailable: number;
}

const SLOTS: readonly SignatureSlot[] = ['facility', 'ops'];

/** Human-facing slot label for ntfy bodies / the override reason. */
function slotLabel(slot: SignatureSlot): string {
  return slot === 'facility' ? 'Facility Manager' : 'Operations Manager';
}

/** Whether the given slot on the row is still unsigned. */
function slotUnsigned(row: EscalationPeriodRow, slot: SignatureSlot): boolean {
  return slot === 'facility'
    ? row.facility_signed_by_user_id === null
    : row.ops_signed_by_user_id === null;
}

/** Pacific-calendar yesterday for a @db.Date-shaped Pacific "today" key. */
export function yesterdayKey(now: Date): Date {
  // `now` is UTC-midnight of the Pacific calendar day; stepping one @db.Date day
  // back is a pure UTC-day subtraction (no DST seam — these are date-only keys).
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
}

/** `YYYY-MM-DD` of a @db.Date-shaped key (UTC-midnight; no DST seam). */
function isoDate(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** Whole @db.Date days between two UTC-midnight keys (>= 0). */
function daysBetween(earlier: Date, later: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

// ────────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────────

export async function runEscalationTier(opts: RunEscalationOpts): Promise<RunEscalationResult> {
  const { db, tier, now } = opts;
  const periodEnd = yesterdayKey(now);

  const result: RunEscalationResult = {
    tier,
    periodsExamined: 0,
    ntfyPublished: 0,
    autoSigned: 0,
    deadlineMissed: 0,
    stranded: 0,
    actorUnavailable: 0,
  };

  if (tier === 't4') {
    await runDeadlineMissed(db, periodEnd, result);
    return result;
  }

  // t1–t3: only periods still awaiting signatures.
  const periods = await db.bonusPayPeriod.findMany({
    where: {
      period_end: periodEnd,
      state: { in: ['pending_signatures', 'partially_signed'] },
    },
    select: PERIOD_SELECT,
  });
  result.periodsExamined = periods.length;

  for (const period of periods) {
    const unsignedSlots = SLOTS.filter((s) => slotUnsigned(period, s));
    if (unsignedSlots.length === 0) continue; // fully signed → no escalation

    if (tier === 't1') {
      await tierWarning(period, unsignedSlots, 't1', result);
    } else if (tier === 't2') {
      await tierWarning(period, unsignedSlots, 't2', result, db);
    } else {
      await tierAutoOverride(db, period, unsignedSlots, result);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────
// t1 / t2 — ntfy warnings
// ────────────────────────────────────────────────────────────────────

async function tierWarning(
  period: EscalationPeriodRow,
  unsignedSlots: readonly SignatureSlot[],
  tier: 't1' | 't2',
  result: RunEscalationResult,
  db?: EscalationDb,
): Promise<void> {
  const periodLabel = `Period ${period.period_number} (${period.period_year})`;
  const slotNames = unsignedSlots.map(slotLabel).join(', ');
  const priority = TIER_PRIORITY[tier];
  const fpSuffix = tier; // t1 | t2 — matches the fingerprint suffix in the spec

  let body =
    `${period.site.name} ${periodLabel} is still unsigned by ${slotNames}. ` +
    `Sign before Tue 08:30 AM PT or the system auto-overrides as the configured ` +
    `admin to hit the 09:00 AM PT payroll deadline.`;

  if (tier === 't2' && db) {
    const humans = await overrideAuthorizedHumans(db, period.site_id);
    if (humans.length > 0) {
      body += `\n\nOverride-authorized: ${humans.join(', ')}.`;
    }
  }

  const res = await publishNtfy({
    topic: 'dr3-vision-system',
    title:
      tier === 't1'
        ? `Bonus signatures pending — ${period.site.name} ${periodLabel}`
        : `URGENT: bonus signatures still pending — ${period.site.name} ${periodLabel}`,
    body,
    priority,
    tags: tier === 't1' ? ['warning', 'bonus'] : ['rotating_light', 'bonus'],
    // Fingerprint per spec: bonus-escalation-warning:<site>:<period-id>:<tier>.
    fingerprint: `bonus-escalation-warning:${period.site.code}:${period.id}:${fpSuffix}`,
    // One fire per tier per period per day; a 6h cooldown comfortably dedupes a
    // restart-triggered re-POST of the same tier without crossing into the next
    // day's run.
    cooldownMs: 6 * 60 * 60 * 1000,
  });
  result.ntfyPublished += 1;
  if (res.outcome === 'dropped') {
    log.warn(
      { periodId: period.id, tier },
      '[escalation] warning ntfy dropped (primary+fallback failed)',
    );
  }
}

/** The names of users authorized to override either slot at a site (t2 body). */
async function overrideAuthorizedHumans(db: EscalationDb, siteId: string): Promise<string[]> {
  const chain = await getSignatureChain(siteId, db);
  const ids = new Set<string>([
    ...chain.facility_override_actor_user_ids,
    ...chain.ops_override_actor_user_ids,
    chain.auto_override_actor_user_id,
  ]);
  if (ids.size === 0) return [];
  const users = await db.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true },
  });
  return users.map((u) => u.name);
}

// ────────────────────────────────────────────────────────────────────
// t3 — auto-override
// ────────────────────────────────────────────────────────────────────

async function tierAutoOverride(
  db: EscalationDb,
  period: EscalationPeriodRow,
  unsignedSlots: readonly SignatureSlot[],
  result: RunEscalationResult,
): Promise<void> {
  const chain = await getSignatureChain(period.site_id, db);
  const actorId = chain.auto_override_actor_user_id;

  // RISK MITIGATION (addendum): the configured auto-override actor MUST be a
  // valid, ACTIVE user before we sign as them. If not, fire an urgent ntfy and
  // DO NOT auto-sign — miss the deadline with an explicit alert rather than fail
  // silently or write a bogus signature.
  const actor = await db.user.findUnique({
    where: { id: actorId },
    select: { id: true, name: true, is_active: true },
  });
  if (!actor || !actor.is_active) {
    result.actorUnavailable += 1;
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: `URGENT: auto-override actor unavailable — ${period.site.name} Period ${period.period_number}`,
      body:
        `The configured auto-override actor (${actorId}) for ${period.site.name} is ` +
        `${actor ? 'INACTIVE' : 'MISSING'}. The system did NOT auto-sign ` +
        `Period ${period.period_number} (${period.period_year}). Sign manually NOW — ` +
        `the 09:00 AM PT payroll deadline is at risk.`,
      priority: 'urgent',
      tags: ['rotating_light', 'bonus', 'auto-override'],
      fingerprint: `bonus-auto-override-actor-unavailable:${period.site.code}:${period.id}`,
      cooldownMs: 6 * 60 * 60 * 1000,
    });
    result.ntfyPublished += 1;
    return;
  }

  let signedAny = false;
  for (const slot of unsignedSlots) {
    const res = await recordSignature({
      db: db as unknown as Parameters<typeof recordSignature>[0]['db'],
      chainDb: db,
      monthId: period.id,
      signer: {
        userId: actorId,
        role: 'admin',
        primarySiteId: null,
        siteId: period.site_id,
      },
      onBehalfOf: slot,
      overrideReason: escalationReason(slotLabel(slot)),
      autoOverride: true,
      actorLabel: 'system:bonus-escalation',
    });

    if (res.ok) {
      result.autoSigned += 1;
      signedAny = true;
    } else if (res.reason === 'already_signed') {
      // IDEMPOTENT: a slot signed manually before 08:30 (or already auto-signed
      // on a prior fire / re-POST) is NOT re-overridden — recordSignature rejects
      // it and we move on. Not an error.
      log.info(
        { periodId: period.id, slot },
        '[escalation] slot already signed; skipping auto-override (idempotent)',
      );
    } else {
      log.error(
        { periodId: period.id, slot, reason: res.reason },
        '[escalation] auto-override failed for slot',
      );
    }
  }

  if (signedAny) {
    // Confirm the auto-override (ADR-0019.1 §4 audit ntfy) and fire the
    // post-signature side-effects (PDF + M365) — the SAME chain the sign route
    // runs after a 2nd signature. If only one slot was auto-signed and the other
    // was already manually signed, the period is now fully `signed`; if both
    // were unsigned, this single delivery covers them.
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: `Bonus auto-override applied — ${period.site.name} Period ${period.period_number}`,
      body:
        `System auto-signed ${signedSlotsLabel(unsignedSlots)} for ${period.site.name} ` +
        `Period ${period.period_number} (${period.period_year}) as ${actor.name} per ` +
        `ADR-0019.1 escalation policy. PDF + payroll delivery triggered.`,
      priority: 'urgent',
      tags: ['white_check_mark', 'bonus', 'auto-override'],
      fingerprint: `bonus-auto-override:${period.site.code}:${period.id}`,
      cooldownMs: 6 * 60 * 60 * 1000,
    });
    result.ntfyPublished += 1;
    triggerPayrollDelivery(period.id);
  }
}

function signedSlotsLabel(slots: readonly SignatureSlot[]): string {
  return slots.map(slotLabel).join(' + ');
}

// ────────────────────────────────────────────────────────────────────
// t4 — payroll-deadline-missed (T-206)
// ────────────────────────────────────────────────────────────────────

// t4 fires only for periods in the LIVE payroll lifecycle that should have
// reached `paid` by the 09:00 PT deadline but didn't. Terminal / archival
// states are NOT live deadlines and must never page:
//   - `paid`                — success.
//   - `skipped`             — pre-cutover empties (ADR-0019.1); terminal, no PDF.
//   - `historical_imported` — spreadsheet loads (ADR-0023); already paid in V1.
//   - `amended`             — admin corrections, handled out-of-band.
// An allowlist (not the old `state != 'paid'`) is what stops the 2026-06-09
// go-live false-positive: Period 12 (historical_imported, period_end ==
// yesterday) was wrongly flagged as a missed payroll deadline. `draft` stays in
// the list so a period that never closed (period-close cron failed) still pages.
const T4_LIVE_DEADLINE_STATES = [
  'draft',
  'pending_signatures',
  'partially_signed',
  'signed',
] as const;

async function runDeadlineMissed(
  db: EscalationDb,
  periodEnd: Date,
  result: RunEscalationResult,
): Promise<void> {
  // Periods still in the live lifecycle (not yet `paid`) whose payroll deadline
  // has arrived or PASSED. Two cases, distinguished by `period_end`:
  //
  //   period_end == yesterday  → TODAY's 09:00 PT deadline missed: the PDF did
  //                              not ship (M365/R2 outage after auto-override, or
  //                              never signed). Bill intervenes for today's run.
  //   period_end <  yesterday  → STRANDED: the period missed its ENTIRE escalation
  //                              window on an earlier day (the daemon or app was
  //                              down that morning, so t1–t4 never processed it)
  //                              and it is still not `paid`.
  //
  // BUGFIX (audit P1-4, 2026-07-21): this query used `period_end == yesterday`
  // ONLY, so a period whose window was missed was never re-examined and stranded
  // FOREVER unpaged. We now look back with `lte` so a stranded period is
  // re-detected and PAGES every 09:00 PT run until an operator resolves it.
  // We deliberately do NOT auto-sign a stranded period late: ADR-0019.1's
  // auto-override is bound to the tight Tue 08:30/09:00 PT window (t3 keeps its
  // `period_end == yesterday` scoping), and signing days after the payroll
  // deadline is out of policy — the correct action is an operator intervention,
  // which this urgent page requests.
  //
  // Archival/terminal states are excluded (see T4_LIVE_DEADLINE_STATES) so
  // historical imports / skipped / amended periods never false-page, no matter
  // how far back the `lte` reaches.
  const live = await db.bonusPayPeriod.findMany({
    where: { period_end: { lte: periodEnd }, state: { in: [...T4_LIVE_DEADLINE_STATES] } },
    select: PERIOD_SELECT,
  });
  result.periodsExamined = live.length;

  const yesterdayMs = periodEnd.getTime();
  for (const period of live) {
    const periodLabel = `Period ${period.period_number} (${period.period_year})`;

    if (period.period_end.getTime() < yesterdayMs) {
      const daysLate = daysBetween(period.period_end, periodEnd);
      const res = await publishNtfy({
        topic: 'dr3-vision-system',
        title: `URGENT: bonus period STRANDED — ${period.site.name} Period ${period.period_number}`,
        body:
          `${period.site.name} ${periodLabel} is still in state '${period.state}' and MISSED its ` +
          `payroll window ${daysLate} day${daysLate === 1 ? '' : 's'} ago (period ended ` +
          `${isoDate(period.period_end)}). It was never paid and the escalation window is long ` +
          `past — the system does NOT auto-sign a period this late. Resolve it manually in /bonus.`,
        priority: 'urgent',
        tags: ['rotating_light', 'bonus', 'stranded'],
        // Per-period fingerprint; distinct from the deadline-missed one so a
        // period that paged "deadline missed" on its own day still re-pages as
        // "stranded" on later days. A 6h cooldown < the 24h between t4 runs, so
        // it re-fires daily until resolved (never silently strands again).
        fingerprint: `bonus-period-stranded:${period.site.code}:${period.id}`,
        cooldownMs: 6 * 60 * 60 * 1000,
      });
      result.ntfyPublished += 1;
      result.stranded += 1;
      if (res.outcome === 'dropped') {
        log.warn(
          { periodId: period.id, periodEnd: isoDate(period.period_end) },
          '[escalation] stranded ntfy dropped (primary+fallback failed)',
        );
      }
      continue;
    }

    const res = await publishNtfy({
      topic: 'dr3-vision-system',
      title: `URGENT: payroll deadline MISSED — ${period.site.name} Period ${period.period_number}`,
      body:
        `${period.site.name} ${periodLabel} is in state '${period.state}' at the 09:00 AM PT ` +
        `payroll deadline — the signed PDF was NOT delivered to payroll. Intervene manually.`,
      priority: 'urgent',
      tags: ['rotating_light', 'bonus', 'deadline'],
      // Per-period fingerprint (spec): bonus-payroll-deadline-missed:<site>:<id>.
      fingerprint: `bonus-payroll-deadline-missed:${period.site.code}:${period.id}`,
      // Cooldown prevents repeat fires (T-206 acceptance) — generous so a
      // re-POST / next-day run on a still-stuck period doesn't re-page within
      // the same payroll window.
      cooldownMs: 6 * 60 * 60 * 1000,
    });
    result.ntfyPublished += 1;
    result.deadlineMissed += 1;
    if (res.outcome === 'dropped') {
      log.warn(
        { periodId: period.id },
        '[escalation] deadline-missed ntfy dropped (primary+fallback failed)',
      );
    }
  }
}

// The select shared by both queries. Kept as a const so the structural row type
// and the Prisma query stay in lockstep.
const PERIOD_SELECT = {
  id: true,
  site_id: true,
  period_number: true,
  period_year: true,
  period_end: true,
  state: true,
  facility_signed_by_user_id: true,
  ops_signed_by_user_id: true,
  site: { select: { code: true, name: true } },
} satisfies Prisma.BonusPayPeriodSelect;
