// ADR-0019.4 — standing health of the bonus signature chain.
//
// ADR-0019.1 §4 promised a Vision Dashboard indicator surfacing "override actor
// available (boolean: can the system locate Bill's user record and is it
// active)". T-120 shipped the health-pill SHELL with a hardcoded six-subsystem
// list and the chain check was never added. This module is that check.
//
// The thing being watched: `bonus_signature_chains` is the single source of
// truth for who signs which slot and who may override it. Every id on the row is
// a FOREIGN KEY BY CONVENTION into `users` — the override lists are
// comma-separated UUID strings, so the database enforces nothing about them, and
// the primary-signer FKs enforce existence but say nothing about `is_active`.
//
// Why a standing indicator rather than another alert: the 08:30 PT auto-override
// already refuses to sign as an inactive actor and fires an urgent ntfy. That
// guard is correct and it is not enough. It speaks at the point of failure —
// thirty minutes before an immovable payroll deadline — and only through the
// alert channel. On 2026-08-05 the app logged
// `stranded ntfy dropped (primary+fallback failed)`: the one page that would
// have told anyone Eugene was stranded was itself lost, and the period was
// signed ~25h late. A check whose only output is a page can be silenced by the
// pager. This one is readable as state.
//
// Pure by design: `evaluateChainHealth` takes already-fetched rows and returns a
// verdict. All IO lives in the caller (`loadChainHealth`), so the interesting
// logic is testable without a database.

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export type ChainStatus = 'green' | 'amber' | 'red';

/** Which position on the chain row a finding refers to. */
export type ChainSlot =
  | 'facility_signer'
  | 'ops_signer'
  | 'auto_override'
  | 'facility_override'
  | 'ops_override';

export type ChainFindingReason =
  /** The referenced user id has no row in `users`. */
  | 'missing'
  /** The user exists but `is_active = false`. */
  | 'inactive'
  /** The user exists and is active but is soft-deleted. */
  | 'deleted'
  /** Facility and ops slots resolve to the same person — no four-eyes. */
  | 'degenerate_same_signer'
  /** A slot has an empty override list — no human backstop. */
  | 'degenerate_no_override'
  /** The auto-override actor also occupies a signer slot. */
  | 'degenerate_actor_is_signer'
  /**
   * ADR-0019.3 §2 — a slot whose signer is separation-of-duties excluded from
   * some periods has NO override backstop configured. Distinct from
   * `degenerate_no_override` because the missing backstop is not hypothetical
   * here: the signer is already, permanently, unable to sign a class of periods.
   */
  | 'sod_excluded_no_backstop';

/**
 * ADR-0019.3 §2 — a chain signer who is also the subject of bonus entries, and
 * is therefore excluded from signing the periods that contain them.
 *
 * This is NOT a defect. It is the guard working: those periods route to the
 * override chain by design. It is carried on the result so the dashboard can
 * explain why an override actor signed a period, without anyone reading an ADR.
 */
export interface SodExclusion {
  slot: 'facility_signer' | 'ops_signer';
  userId: string;
  employeeName: string;
}

export interface ChainFinding {
  slot: ChainSlot;
  reason: ChainFindingReason;
  /** The offending user id, where the finding is about a specific reference. */
  userId: string | null;
  /** Operator-facing sentence: what is wrong AND what it costs. */
  detail: string;
}

/** Minimal user shape this check needs. */
export interface ChainHealthUser {
  id: string;
  name: string;
  is_active: boolean;
  deleted_at: Date | null;
}

/** The parsed chain plus the users its ids point at. */
export interface ChainHealthInput {
  siteCode: string;
  siteName: string;
  chain: {
    facility_signer_user_id: string;
    facility_override_actor_user_ids: string[];
    ops_signer_user_id: string;
    ops_override_actor_user_ids: string[];
    auto_override_actor_user_id: string;
  };
  users: readonly ChainHealthUser[];
  /**
   * ADR-0019.3 §2 — signer slots held by someone who is also a bonus subject.
   *
   * Supplying this NEVER makes a healthy chain unhealthy. The evaluator needs it
   * only so it can tell the difference between "this slot has no backstop, which
   * would matter if the signer were ever unavailable" and "this slot has no
   * backstop AND its signer is already barred from a class of periods". Omitting
   * it degrades gracefully to the pre-ADR-0019.3 behaviour.
   */
  sodExclusions?: readonly SodExclusion[];
}

export interface ChainHealthResult {
  siteCode: string;
  siteName: string;
  status: ChainStatus;
  findings: ChainFinding[];
  /** Display name of the auto-override actor, or null if unresolvable. */
  autoOverrideActorName: string | null;
  /**
   * ADR-0019.3 §2 — signers excluded from their own periods. Standing context,
   * deliberately NOT findings: a green chain with an exclusion is green.
   */
  sodExclusions: SodExclusion[];
}

// ────────────────────────────────────────────────────────────────────
// Reference resolution
// ────────────────────────────────────────────────────────────────────

/**
 * Why this is stricter than the guard it watches: `escalation.ts` checks only
 * `is_active`, so a soft-deleted-but-active user would pass it and sign payroll.
 * The canonical liveness predicate everywhere else in this repo is
 * `{ is_active: true, deleted_at: null }`. A monitor that is exactly as strict
 * as the thing it monitors cannot warn you about the thing it monitors.
 */
function brokenReason(u: ChainHealthUser | undefined): 'missing' | 'inactive' | 'deleted' | null {
  if (!u) return 'missing';
  if (!u.is_active) return 'inactive';
  if (u.deleted_at !== null) return 'deleted';
  return null;
}

const SLOT_LABEL: Record<ChainSlot, string> = {
  facility_signer: 'facility signer',
  ops_signer: 'ops signer',
  auto_override: 'auto-override actor',
  facility_override: 'facility override actor',
  ops_override: 'ops override actor',
};

/**
 * The consequence sentence. Each slot fails differently and an operator reading
 * a dashboard at 07:00 on payroll morning needs to know which one they are
 * looking at — "inactive user" alone does not distinguish "payroll cannot ship"
 * from "one of two backstops is gone".
 */
function consequence(slot: ChainSlot, reason: 'missing' | 'inactive' | 'deleted'): string {
  const state =
    reason === 'missing' ? 'does not exist' : reason === 'inactive' ? 'is INACTIVE' : 'is DELETED';
  switch (slot) {
    case 'auto_override':
      return (
        `The ${SLOT_LABEL[slot]} ${state}. The 08:30 PT auto-override will REFUSE to sign ` +
        `(escalation.ts actorUnavailable) and the 09:00 PT payroll deadline will be missed ` +
        `unless a human signs manually.`
      );
    case 'facility_signer':
    case 'ops_signer':
      return (
        `The ${SLOT_LABEL[slot]} ${state}. That slot cannot be signed normally and no ` +
        `signature-request email can reach them; the period depends entirely on the 08:30 PT ` +
        `auto-override.`
      );
    default:
      return (
        `A ${SLOT_LABEL[slot]} ${state}. That backstop is unavailable if the primary signer ` +
        `cannot sign before the 09:00 PT deadline.`
      );
  }
}

// ────────────────────────────────────────────────────────────────────
// Evaluation
// ────────────────────────────────────────────────────────────────────

/**
 * Evaluate one site's chain. Pure: no IO, no clock, no environment.
 *
 * Severity model (justified in ADR-0019.4):
 *   red   — a reference cannot sign: missing / inactive / deleted. The chain is
 *           broken and a deadline WILL be missed if it is relied on.
 *   amber — the chain still functions but has lost a safety property
 *           (four-eyes, or a backstop). Worth seeing before a deadline morning;
 *           must not page at the same volume as red.
 *   green — every reference resolves to a live account and no degeneracy.
 */
export function evaluateChainHealth(input: ChainHealthInput): ChainHealthResult {
  const { chain, users, siteCode, siteName } = input;
  const byId = new Map(users.map((u) => [u.id, u]));
  const findings: ChainFinding[] = [];
  const sodExclusions = [...(input.sodExclusions ?? [])];
  // Which override list belongs to a slot whose signer is SoD-excluded.
  const excludedSignerSlots = new Set(sodExclusions.map((e) => e.slot));

  const checkOne = (slot: ChainSlot, userId: string): void => {
    const reason = brokenReason(byId.get(userId));
    if (reason) {
      findings.push({ slot, reason, userId, detail: consequence(slot, reason) });
    }
  };

  // Primary slots. Order is deliberate: auto_override last so that when several
  // are broken the most consequential finding is not buried, but every one is
  // reported — a partial repair must stay red.
  checkOne('facility_signer', chain.facility_signer_user_id);
  checkOne('ops_signer', chain.ops_signer_user_id);
  checkOne('auto_override', chain.auto_override_actor_user_id);

  // Override lists. Report at most one finding per list so a list of five dead
  // ids does not drown the primary-slot findings; the detail names the id.
  for (const [slot, ids] of [
    ['facility_override', chain.facility_override_actor_user_ids],
    ['ops_override', chain.ops_override_actor_user_ids],
  ] as const) {
    const bad = ids.map((id) => ({ id, reason: brokenReason(byId.get(id)) })).find((x) => x.reason);
    if (bad?.reason) {
      findings.push({
        slot,
        reason: bad.reason,
        userId: bad.id,
        detail: consequence(slot, bad.reason),
      });
    }
  }

  const hasBrokenRef = findings.length > 0;

  // Degeneracies are only meaningful on a chain whose references resolve; there
  // is no point telling someone their four-eyes is collapsed when the slot is
  // pointed at a ghost.
  if (!hasBrokenRef) {
    if (chain.facility_signer_user_id === chain.ops_signer_user_id) {
      findings.push({
        slot: 'ops_signer',
        reason: 'degenerate_same_signer',
        userId: chain.ops_signer_user_id,
        detail:
          'The facility and ops slots resolve to the same person, so both signatures on a ' +
          'pay period would be theirs. The four-eyes property ADR-0019 §5 relies on is gone.',
      });
    }
    for (const [slot, ids] of [
      ['facility_override', chain.facility_override_actor_user_ids],
      ['ops_override', chain.ops_override_actor_user_ids],
    ] as const) {
      if (ids.length === 0) {
        const which = slot === 'ops_override' ? 'ops' : 'facility';
        // ADR-0019.3 §2 — same severity, sharper sentence. An empty override list
        // is amber either way; what changes is whether the risk is conditional.
        const excluded = excludedSignerSlots.has(
          slot === 'ops_override' ? 'ops_signer' : 'facility_signer',
        );
        findings.push({
          slot,
          reason: excluded ? 'sod_excluded_no_backstop' : 'degenerate_no_override',
          userId: null,
          detail: excluded
            ? `No override actor is configured for the ${which} slot, and its signer is ` +
              'separation-of-duties excluded from periods containing their own bonus entries ' +
              '(ADR-0019.3 §2). For those periods that signer cannot sign and no human backstop ' +
              'is configured, so only an admin or the 08:30 PT auto-override could complete them.'
            : `No override actor is configured for the ${which} ` +
              'slot. If its signer is unavailable, no human can sign on their behalf before the ' +
              '09:00 PT deadline — only the 08:30 PT auto-override could rescue the period.',
        });
      }
    }
    if (
      chain.auto_override_actor_user_id === chain.facility_signer_user_id ||
      chain.auto_override_actor_user_id === chain.ops_signer_user_id
    ) {
      findings.push({
        slot: 'auto_override',
        reason: 'degenerate_actor_is_signer',
        userId: chain.auto_override_actor_user_id,
        detail:
          'The auto-override actor also holds a signer slot, so the system would sign on ' +
          'behalf of the very person who failed to sign. The override stops being independent.',
      });
    }
  }

  const status: ChainStatus = hasBrokenRef ? 'red' : findings.length > 0 ? 'amber' : 'green';
  const actor = byId.get(chain.auto_override_actor_user_id);

  return {
    siteCode,
    siteName,
    status,
    findings,
    autoOverrideActorName: actor?.name ?? null,
    sodExclusions,
  };
}

/**
 * Roll up across sites, worst-wins.
 *
 * An EMPTY list is red, deliberately. `bonus_signature_chains` should always
 * hold one row per site; zero rows means nothing can sign anywhere, and the
 * naive `.some(red)` reduction would call that green. This is the empty-set
 * trap that makes a monitor confidently report health it never measured.
 */
export function worstChainStatus(statuses: readonly ChainStatus[]): ChainStatus {
  if (statuses.length === 0) return 'red';
  if (statuses.includes('red')) return 'red';
  if (statuses.includes('amber')) return 'amber';
  return 'green';
}

// ────────────────────────────────────────────────────────────────────
// Paging decision
// ────────────────────────────────────────────────────────────────────

/** Re-page a persisting unhealthy chain at most once a day (ADR-0037 §3). */
export const CHAIN_REPAGE_MS = 24 * 60 * 60 * 1000;

const RANK: Record<ChainStatus, number> = { green: 0, amber: 1, red: 2 };

/**
 * Leading-edge paging, modelled on `decidePage` in `@/lib/mymrc/sync.ts`.
 *
 * The prior state is read from the run ledger in Postgres rather than an
 * in-process map, because `publishNtfy`'s cooldown ledger is per-process and
 * every deploy recreates this container — an in-memory cooldown would re-page
 * the same unhealthy chain on every deploy, which is precisely the noise
 * ADR-0037 exists to prevent.
 *
 * Pages when: first-ever observation of an unhealthy state, a transition into a
 * WORSE state, or a persisting unhealthy state past `repageMs`. Never pages for
 * green, and never for an improvement — recovery is not an alarm.
 */
export function decideChainPage(
  prior: { status: ChainStatus; observed_at: Date } | null,
  current: ChainStatus,
  now: Date,
  repageMs: number = CHAIN_REPAGE_MS,
): boolean {
  if (current === 'green') return false;
  if (!prior) return true;
  if (RANK[current] > RANK[prior.status]) return true;
  if (RANK[current] < RANK[prior.status]) return false;
  return now.getTime() - prior.observed_at.getTime() >= repageMs;
}

// ────────────────────────────────────────────────────────────────────
// IO — load, evaluate, record, page
// ────────────────────────────────────────────────────────────────────

import { parseOverrideActorIds } from '@/lib/bonus/signature-chain';
import { publishNtfy } from '@/lib/ntfy';
import { log } from '@/lib/observability/logger';
import type { PrismaClient } from '@prisma/client';

export interface ChainHealthReport {
  overall: ChainStatus;
  sites: ChainHealthResult[];
}

/**
 * Read every site's chain and evaluate it.
 *
 * Reads the chain rows RAW rather than via `getSignatureChain`, deliberately:
 * that helper memoises for 30s, and a health check that reports cached state is
 * reporting the past. It also throws `SignatureChainNotFoundError` per site,
 * whereas a missing row is exactly one of the conditions this check must
 * REPORT rather than crash on.
 */
export async function loadChainHealth(db: PrismaClient): Promise<ChainHealthReport> {
  const sites = await db.site.findMany({ select: { id: true, code: true, name: true } });
  const rows = await db.bonusSignatureChain.findMany();
  const bySite = new Map(rows.map((r) => [r.site_id, r]));

  // Collect every referenced id across all sites, then resolve in ONE query.
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.facility_signer_user_id);
    ids.add(r.ops_signer_user_id);
    ids.add(r.auto_override_actor_user_id);
    for (const i of parseOverrideActorIds(r.facility_override_actor_ids)) ids.add(i);
    for (const i of parseOverrideActorIds(r.ops_override_actor_ids)) ids.add(i);
  }
  const users = ids.size
    ? await db.user.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, name: true, is_active: true, deleted_at: true },
      })
    : [];

  // ADR-0019.3 §2 — which signers are also bonus subjects. One indexed query
  // over the signer ids only; `some: {}` restricts it to employees that actually
  // carry entries, so a linked-but-never-keyed employee is not reported as an
  // exclusion it never causes. In production this matches exactly one row
  // (Patrick Dills), because 132 of 133 `bonus_employees` have a NULL user_id.
  const signerIds = [
    ...new Set(rows.flatMap((r) => [r.facility_signer_user_id, r.ops_signer_user_id])),
  ];
  const subjects = signerIds.length
    ? await db.bonusEmployee.findMany({
        where: { user_id: { in: signerIds }, daily_entries: { some: {} } },
        select: { user_id: true, full_name: true, site_id: true },
      })
    : [];
  // Keyed by SITE + user, not user alone. Bonus is site-scoped, and so are pay
  // periods — someone who is a bonus subject at Eugene is not excluded from
  // anything at Woodland, because no Woodland period can contain their entries.
  // A user-only key would paint a correct-but-misleading exclusion on the other
  // site's card.
  const subjectBySiteUser = new Map(
    subjects.map((s) => [`${s.site_id}:${s.user_id}`, s.full_name]),
  );

  const results: ChainHealthResult[] = [];
  for (const site of sites) {
    const row = bySite.get(site.id);
    if (!row) {
      // A site with no chain row cannot sign at all. Report it as red rather
      // than omitting it — an absent site would otherwise vanish from the
      // rollup and read as health.
      results.push({
        siteCode: site.code,
        siteName: site.name,
        status: 'red',
        autoOverrideActorName: null,
        sodExclusions: [],
        findings: [
          {
            slot: 'auto_override',
            reason: 'missing',
            userId: null,
            detail:
              `No bonus_signature_chains row exists for ${site.name}. No slot can be signed and ` +
              `the 08:30 PT auto-override has nothing to act on.`,
          },
        ],
      });
      continue;
    }
    results.push(
      evaluateChainHealth({
        siteCode: site.code,
        siteName: site.name,
        chain: {
          facility_signer_user_id: row.facility_signer_user_id,
          facility_override_actor_user_ids: parseOverrideActorIds(row.facility_override_actor_ids),
          ops_signer_user_id: row.ops_signer_user_id,
          ops_override_actor_user_ids: parseOverrideActorIds(row.ops_override_actor_ids),
          auto_override_actor_user_id: row.auto_override_actor_user_id,
        },
        users,
        sodExclusions: (
          [
            ['facility_signer', row.facility_signer_user_id],
            ['ops_signer', row.ops_signer_user_id],
          ] as const
        ).flatMap(([slot, userId]) => {
          const employeeName = subjectBySiteUser.get(`${site.id}:${userId}`);
          return employeeName ? [{ slot, userId, employeeName }] : [];
        }),
      }),
    );
  }

  return { overall: worstChainStatus(results.map((r) => r.status)), sites: results };
}

export interface ChainHealthSweepResult {
  overall: ChainStatus;
  sites: ChainHealthResult[];
  paged: number;
  ntfyDropped: number;
}

/**
 * The cron body: evaluate, write a ledger row per site, and page on the leading
 * edge of an unhealthy transition.
 *
 * A ledger row is written on EVERY poll regardless of status — that is what
 * makes "the check stopped running" visible. Paging is decided per site against
 * that site's previous row.
 */
export async function runChainHealthSweep(
  db: PrismaClient,
  now: Date = new Date(),
  clickUrl = 'https://dr3-vision.svdp.us/admin/bonus-chain-health',
): Promise<ChainHealthSweepResult> {
  const report = await loadChainHealth(db);
  const sites = await db.site.findMany({ select: { id: true, code: true } });
  const idByCode = new Map(sites.map((s) => [s.code, s.id]));

  let paged = 0;
  let ntfyDropped = 0;

  for (const site of report.sites) {
    const siteId = idByCode.get(site.siteCode);
    if (!siteId) continue;

    const prior = await db.bonusChainHealthRun.findFirst({
      where: { site_id: siteId },
      orderBy: { observed_at: 'desc' },
      select: { status: true, observed_at: true },
    });

    const shouldPage = decideChainPage(
      prior ? { status: prior.status as ChainStatus, observed_at: prior.observed_at } : null,
      site.status,
      now,
    );

    let didPage = false;
    if (shouldPage) {
      const worst = site.findings[0];
      const res = await publishNtfy({
        topic: 'dr3-vision-system',
        title:
          site.status === 'red'
            ? `Bonus signature chain BROKEN — ${site.siteName}`
            : `Bonus signature chain degraded — ${site.siteName}`,
        body:
          `${site.siteName}: ${site.findings.length} finding(s). ${worst?.detail ?? ''} ` +
          `Fix before the next 08:30 AM PT auto-override window.`,
        // ADR-0037: red is `high`, not `urgent`. A broken chain is genuinely
        // actionable and payroll-impacting, but it is SLOW-MOVING — it is only
        // load-bearing at 08:30 PT on a payroll morning, so it does not warrant
        // waking Bill at 3am. Amber is `default`.
        priority: site.status === 'red' ? 'high' : 'default',
        tags: site.status === 'red' ? ['rotating_light', 'bonus', 'chain'] : ['warning', 'bonus'],
        clickUrl,
        fingerprint: `bonus-chain-health:${site.siteCode}:${site.status}`,
        cooldownMs: CHAIN_REPAGE_MS,
      });
      didPage = res.outcome === 'sent' || res.outcome === 'fallback-sent';
      if (!didPage) {
        // The 2026-08-05 lesson: a page that never lands must not be recorded as
        // if it did, or the ledger will claim someone was told when nobody was.
        ntfyDropped += 1;
        log.error(
          { site: site.siteCode, status: site.status, outcome: res.outcome },
          '[chain-health] ntfy did NOT deliver — chain finding is unannounced',
        );
      } else {
        paged += 1;
      }
    }

    await db.bonusChainHealthRun.create({
      data: {
        site_id: siteId,
        observed_at: now,
        status: site.status,
        findings: site.findings as unknown as object,
        paged: didPage,
      },
    });
  }

  return { overall: report.overall, sites: report.sites, paged, ntfyDropped };
}
