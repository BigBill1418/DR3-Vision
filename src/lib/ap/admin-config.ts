// ADR-0066 §1.4 + §1.6 — the data layer behind the combined AP configuration
// screen (`/admin/ap/routing` and `/admin/ap/notifications` are two doors into
// ONE surface: routing and notification prefs are six rows of config that only
// make sense read together).
//
// ── Why this module is shaped the way it is ─────────────────────────────────
// The outage ADR-0066 fixes was an EMPTY RECIPIENT SET that looked exactly like
// a successful send. Everything here exists to make that state impossible to
// create through the admin UI, and visible when it already exists in data:
//
//   1. `selectableApprovers` is the ONLY set offered as a second approver or a
//      fallback, and `saveRoutingRow()` re-checks membership server-side. A
//      person is selectable only when they are ACTIVE, hold an APPROVER ROLE,
//      and HAVE AN EMAIL. In production Bill, Janette and Morena each have a
//      SECOND account — an operator PIN account created 2026-07-28 for the iPad
//      rollout, with no email at all. A name-keyed picker would happily route to
//      one of those and the routing table would look fully populated while every
//      notification resolved to nobody. That is the defect, reintroduced through
//      its own admin screen.
//   2. `problems` mirrors the shared resolver's `problems` output
//      (`second-approval-resolver.ts`). The screen shows the admin the same
//      misconfigurations the 06:00 digest will warn about, before they cost a
//      week of unsigned invoices.
//   3. Self-approval is refused three times over: the picker omits the first
//      approver, `saveRoutingRow()` rejects the pair, and the DB
//      `CHECK (first_approver_id <> second_approver_id)` is the backstop. The
//      constraint violation is CAUGHT and mapped to a readable reason rather
//      than surfacing as a 500.
//
// Every mutation writes its `audit_log` row inside the SAME transaction as the
// write (CLAUDE.md hard rule #6 — an append-only log is worthless if the row can
// be lost on partial failure), exactly as `src/lib/admin-users.ts` does.
//
// Server-only: imports Prisma. Client components must not import it.

import { Prisma, type AuditAction, type UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  AP_NOTIFICATION_EVENTS,
  AP_PREF_COLUMN,
  AP_PREF_DEFAULTS,
  type ApNotificationEvent,
} from '@/lib/ap/notification-prefs';

/** Roles that may hold AP approval authority at all — same set as the resolver. */
export const APPROVER_ROLES: readonly UserRole[] = ['manager', 'admin'];

export const ROUTING_STATUSES = ['active', 'inactive', 'all'] as const;
export type RoutingStatusFilter = (typeof ROUTING_STATUSES)[number];

/** Business-hours bounds for `fallback_after_hours` (§1.5 weekday clock). */
export const FALLBACK_HOURS_MIN = 1;
export const FALLBACK_HOURS_MAX = 168;

// ────────────────────────────────────────────────────────────────────
// DTOs — everything crossing into a client component is JSON-safe.
// ────────────────────────────────────────────────────────────────────

export interface ApPersonRef {
  id: string;
  name: string;
  email: string | null;
  /** null when the routing row references a user we can no longer resolve. */
  role: UserRole | null;
  is_active: boolean;
  /** Active + approver role + a real address. The ONLY thing that may be routed to. */
  reachable: boolean;
}

export interface ApRoutingRowDto {
  id: string;
  first_approver: ApPersonRef;
  second_approver: ApPersonRef;
  fallback_approver: ApPersonRef | null;
  fallback_after_hours: number;
  active: boolean;
  updated_at: string;
  updated_by: string | null;
}

export interface ApPrefRowDto {
  person: ApPersonRef;
  /** False ⇒ no `ap_notification_prefs` row; `values` are the column defaults. */
  has_row: boolean;
  values: Record<ApNotificationEvent, boolean>;
  updated_at: string | null;
}

export type ApConfigProblemCode =
  | 'missing_routing_row'
  | 'unreachable_second_approver'
  | 'unreachable_fallback_approver'
  | 'self_pair'
  | 'no_reachable_admin';

export interface ApConfigProblem {
  code: ApConfigProblemCode;
  /**
   * `error` — this WILL degrade a real second approval (the subject is an admin
   * or sits on the `ap_approvers` roster, or the row itself is broken).
   * `warning` — an approver-role account that is not currently on the AP roster;
   * harmless today, a silent fallback the day they are added.
   */
  severity: 'error' | 'warning';
  subjectUserId: string | null;
  message: string;
}

export interface ApConfigDto {
  /** Routing rows matching the status filter. `problems` always covers ALL rows. */
  routing: ApRoutingRowDto[];
  /** One row per approver-role account — effective prefs, defaults included. */
  prefs: ApPrefRowDto[];
  /** Everyone who may hold AP approval authority (the first-approver universe). */
  approvers: ApPersonRef[];
  /** The only accounts offerable as second approver / fallback. */
  selectable: ApPersonRef[];
  /**
   * Active accounts that SHARE A NAME with an approver but are NOT selectable —
   * the email-less operator PIN accounts. Rendered so an admin looking at two
   * "Morena Gomez" rows can see which one the picker deliberately excludes.
   */
  namesakes: ApPersonRef[];
  problems: ApConfigProblem[];
  defaults: Record<ApNotificationEvent, boolean>;
  events: readonly ApNotificationEvent[];
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: UserRole;
  is_active: boolean;
}

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  is_active: true,
} as const;

/** Reachable = active, an approver role, and an address we can actually send to. */
export function isReachable(u: Pick<UserRow, 'email' | 'role' | 'is_active'>): boolean {
  return u.is_active && !!u.email && u.email.length > 0 && APPROVER_ROLES.includes(u.role);
}

function toPerson(u: UserRow): ApPersonRef {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    is_active: u.is_active,
    reachable: isReachable(u),
  };
}

/** A routing row can reference a hard-deleted user; never render `undefined`. */
function unknownPerson(id: string): ApPersonRef {
  return {
    id,
    name: `(unresolved user ${id})`,
    email: null,
    role: null,
    is_active: false,
    reachable: false,
  };
}

function serializeForAudit(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

/**
 * The DB `CHECK (first_approver_id <> second_approver_id)` is the one guarantee a
 * bug cannot bypass — but Prisma surfaces a check violation as an opaque raw
 * error, which would reach the admin as a 500. Recognise it by constraint name.
 */
function isSelfApprovalCheckViolation(e: unknown): boolean {
  return e instanceof Error && e.message.includes('ap_approval_routing_no_self_approval');
}

/** P2003 — a referenced user id does not exist. */
function isForeignKeyViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003';
}

// ────────────────────────────────────────────────────────────────────
// Read
// ────────────────────────────────────────────────────────────────────

export async function getApConfig(
  filter: { status?: RoutingStatusFilter } = {},
): Promise<ApConfigDto> {
  const status = filter.status ?? 'active';
  const now = new Date();

  const [live, routingRows, prefRows, roster] = await Promise.all([
    prisma.user.findMany({
      where: { deleted_at: null },
      select: USER_SELECT,
      orderBy: [{ name: 'asc' }],
    }),
    prisma.apApprovalRouting.findMany({ orderBy: [{ created_at: 'asc' }] }),
    prisma.apNotificationPref.findMany(),
    // The explicit AP roster (ADR-0046 §3). Roster membership — plus admin —
    // is what makes a missing routing row an ERROR rather than a note.
    prisma.apApprover.findMany({
      where: { OR: [{ active_until: null }, { active_until: { gt: now } }] },
      select: { user_id: true },
    }),
  ]);

  const byId = new Map<string, UserRow>(live.map((u) => [u.id, u]));

  // Routing rows can point at soft-deleted accounts, which the query above
  // excludes. Resolve them explicitly rather than rendering "(unresolved)" for a
  // row that is merely stale — the difference matters when diagnosing.
  const referenced = new Set<string>();
  for (const r of routingRows) {
    referenced.add(r.first_approver_id);
    referenced.add(r.second_approver_id);
    if (r.fallback_approver_id) referenced.add(r.fallback_approver_id);
  }
  const missingIds = [...referenced].filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    const extra = await prisma.user.findMany({
      where: { id: { in: missingIds } },
      select: USER_SELECT,
    });
    for (const u of extra) byId.set(u.id, u);
  }

  const person = (id: string): ApPersonRef => {
    const u = byId.get(id);
    return u ? toPerson(u) : unknownPerson(id);
  };

  const approvers = live
    .filter((u) => u.is_active && APPROVER_ROLES.includes(u.role))
    .map(toPerson);
  const selectable = approvers.filter((p) => p.reachable);

  const approverNames = new Set(approvers.map((p) => p.name));
  const namesakes = live
    .filter((u) => u.is_active && approverNames.has(u.name) && !isReachable(u))
    .map(toPerson);

  const allRouting: ApRoutingRowDto[] = routingRows.map((r) => ({
    id: r.id,
    first_approver: person(r.first_approver_id),
    second_approver: person(r.second_approver_id),
    fallback_approver: r.fallback_approver_id ? person(r.fallback_approver_id) : null,
    fallback_after_hours: r.fallback_after_hours,
    active: r.active,
    updated_at: r.updated_at.toISOString(),
    updated_by: r.updated_by,
  }));

  const prefByUser = new Map(prefRows.map((p) => [p.user_id, p]));
  const prefs: ApPrefRowDto[] = approvers.map((p) => {
    const row = prefByUser.get(p.id);
    const values = {} as Record<ApNotificationEvent, boolean>;
    for (const ev of AP_NOTIFICATION_EVENTS) {
      values[ev] = row ? (row[AP_PREF_COLUMN[ev]] ?? AP_PREF_DEFAULTS[ev]) : AP_PREF_DEFAULTS[ev];
    }
    return {
      person: p,
      has_row: !!row,
      values,
      updated_at: row ? row.updated_at.toISOString() : null,
    };
  });

  const rosterIds = new Set(roster.map((r) => r.user_id));
  const problems = computeProblems({ approvers, routing: allRouting, rosterIds, selectable });

  const visible =
    status === 'all' ? allRouting : allRouting.filter((r) => r.active === (status === 'active'));

  return {
    routing: visible,
    prefs,
    approvers,
    selectable,
    namesakes,
    problems,
    defaults: AP_PREF_DEFAULTS,
    events: AP_NOTIFICATION_EVENTS,
  };
}

/**
 * The validation warnings, mirroring `resolveSecondApproval()`'s `problems`.
 *
 * The table is REQUIRED TO BE TOTAL (§1.4): a first approver with no active row
 * falls back immediately, and — before ADR-0066 — silently. Showing that gap
 * here is the whole point of the screen.
 *
 * Exported for direct unit testing; `getApConfig` is its only production caller.
 */
export function computeProblems(args: {
  approvers: ApPersonRef[];
  routing: ApRoutingRowDto[];
  rosterIds: Set<string>;
  selectable: ApPersonRef[];
}): ApConfigProblem[] {
  const problems: ApConfigProblem[] = [];

  if (!args.selectable.some((p) => p.role === 'admin')) {
    problems.push({
      code: 'no_reachable_admin',
      severity: 'error',
      subjectUserId: null,
      message:
        'No active admin with an email address exists — there is no reachable backstop for AP second approvals.',
    });
  }

  const routedFirst = new Set(args.routing.filter((r) => r.active).map((r) => r.first_approver.id));
  for (const a of args.approvers) {
    if (routedFirst.has(a.id)) continue;
    const onRoster = a.role === 'admin' || args.rosterIds.has(a.id);
    problems.push({
      code: 'missing_routing_row',
      severity: onRoster ? 'error' : 'warning',
      subjectUserId: a.id,
      message: `No active ap_approval_routing row for first approver ${a.name} — anything they first-approve falls back to admin immediately instead of reaching a peer. Configure the pair below.`,
    });
  }

  for (const r of args.routing) {
    if (!r.active) continue;
    if (r.first_approver.id === r.second_approver.id) {
      problems.push({
        code: 'self_pair',
        severity: 'error',
        subjectUserId: r.first_approver.id,
        message: `${r.first_approver.name} is routed to themselves — self-approval is never a valid pair.`,
      });
    }
    if (!r.second_approver.reachable) {
      problems.push({
        code: 'unreachable_second_approver',
        severity: 'error',
        subjectUserId: r.second_approver.id,
        message: `ap_approval_routing points at an unreachable second approver (${r.second_approver.name}: inactive, non-approver role, or no email) — ${r.first_approver.name}'s second approvals fall back to admin.`,
      });
    }
    if (r.fallback_approver && !r.fallback_approver.reachable) {
      problems.push({
        code: 'unreachable_fallback_approver',
        severity: 'error',
        subjectUserId: r.fallback_approver.id,
        message: `The fallback approver on ${r.first_approver.name}'s row (${r.fallback_approver.name}) is unreachable — escalation resolves to admin instead. Clear it to use the system admin explicitly.`,
      });
    }
  }

  return problems;
}

// ────────────────────────────────────────────────────────────────────
// Write — routing (§1.4)
// ────────────────────────────────────────────────────────────────────

export interface ActorContext {
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface SaveRoutingInput {
  first_approver_id: string;
  second_approver_id: string;
  fallback_approver_id: string | null;
  fallback_after_hours: number;
  active: boolean;
}

export type SaveRoutingReason =
  | 'first_approver_invalid'
  | 'self_pair'
  | 'second_approver_unreachable'
  | 'fallback_unreachable'
  | 'hours_out_of_range'
  | 'user_not_found';

export type SaveRoutingResult = { ok: true; id: string } | { ok: false; reason: SaveRoutingReason };

/**
 * Create or update the routing pair for one first approver (`first_approver_id`
 * is UNIQUE — one row per person is what makes the table a total function).
 *
 * Every rejection below is also enforced somewhere else — the picker omits the
 * bad options, and the DB CHECK backstops self-pairing. This layer is the one
 * that cannot be bypassed by a hand-crafted request.
 */
export async function saveRoutingRow(
  input: SaveRoutingInput,
  actor: ActorContext,
): Promise<SaveRoutingResult> {
  if (input.first_approver_id === input.second_approver_id)
    return { ok: false, reason: 'self_pair' };
  if (
    !Number.isInteger(input.fallback_after_hours) ||
    input.fallback_after_hours < FALLBACK_HOURS_MIN ||
    input.fallback_after_hours > FALLBACK_HOURS_MAX
  ) {
    return { ok: false, reason: 'hours_out_of_range' };
  }

  const ids = [input.first_approver_id, input.second_approver_id];
  if (input.fallback_approver_id) ids.push(input.fallback_approver_id);
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, deleted_at: null },
    select: USER_SELECT,
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  const first = byId.get(input.first_approver_id);
  // A first approver need not be REACHABLE (nobody emails them in this role) but
  // must be an active approver-role account, or the row is meaningless.
  if (!first) return { ok: false, reason: 'user_not_found' };
  if (!first.is_active || !APPROVER_ROLES.includes(first.role)) {
    return { ok: false, reason: 'first_approver_invalid' };
  }

  const second = byId.get(input.second_approver_id);
  if (!second) return { ok: false, reason: 'user_not_found' };
  // THE check that keeps the email-less operator PIN accounts out of the table.
  if (!isReachable(second)) return { ok: false, reason: 'second_approver_unreachable' };

  if (input.fallback_approver_id) {
    const fb = byId.get(input.fallback_approver_id);
    if (!fb) return { ok: false, reason: 'user_not_found' };
    if (!isReachable(fb)) return { ok: false, reason: 'fallback_unreachable' };
  }

  const before = await prisma.apApprovalRouting.findUnique({
    where: { first_approver_id: input.first_approver_id },
  });

  try {
    const saved = await prisma.$transaction(async (tx) => {
      const row = await tx.apApprovalRouting.upsert({
        where: { first_approver_id: input.first_approver_id },
        create: {
          first_approver_id: input.first_approver_id,
          second_approver_id: input.second_approver_id,
          fallback_approver_id: input.fallback_approver_id,
          fallback_after_hours: input.fallback_after_hours,
          active: input.active,
          updated_by: actor.actorUserId,
        },
        update: {
          second_approver_id: input.second_approver_id,
          fallback_approver_id: input.fallback_approver_id,
          fallback_after_hours: input.fallback_after_hours,
          active: input.active,
          updated_by: actor.actorUserId,
        },
      });
      await tx.auditLog.create({
        data: {
          actor_user_id: actor.actorUserId,
          action: (before ? 'update' : 'insert') satisfies AuditAction,
          table_name: 'ap_approval_routing',
          row_id: row.id,
          before: before ? serializeForAudit(before) : Prisma.JsonNull,
          after: serializeForAudit(row),
          ip: actor.ip,
          user_agent: actor.userAgent,
        },
      });
      return row;
    });
    return { ok: true, id: saved.id };
  } catch (e) {
    // Readable errors, never a 500: the storage-layer guarantees are the LAST
    // line of defence, not an internal-error path.
    if (isSelfApprovalCheckViolation(e)) return { ok: false, reason: 'self_pair' };
    if (isForeignKeyViolation(e)) return { ok: false, reason: 'user_not_found' };
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────
// Write — notification prefs (§1.6)
// ────────────────────────────────────────────────────────────────────

export type SetPrefReason = 'user_not_found' | 'not_an_approver' | 'event_inert';

export type SetPrefResult = { ok: true } | { ok: false; reason: SetPrefReason };

/**
 * Flip one event for one user, materialising the row on first write.
 *
 * `decision_outcome` is REFUSED. §1.6 ships it as a column with everyone false
 * and no send path wired; letting an admin switch it on would set an
 * expectation the system does not honour — a promise of an email nobody sends.
 * Rendered visibly inert rather than hidden, so the column's existence is
 * documented where it is configured.
 */
export async function setNotificationPref(
  input: { user_id: string; event: ApNotificationEvent; value: boolean },
  actor: ActorContext,
): Promise<SetPrefResult> {
  if (input.event === 'decision_outcome') return { ok: false, reason: 'event_inert' };

  const user = await prisma.user.findFirst({
    where: { id: input.user_id, deleted_at: null },
    select: USER_SELECT,
  });
  if (!user) return { ok: false, reason: 'user_not_found' };
  if (!user.is_active || !APPROVER_ROLES.includes(user.role)) {
    return { ok: false, reason: 'not_an_approver' };
  }

  const column = AP_PREF_COLUMN[input.event];
  const before = await prisma.apNotificationPref.findUnique({ where: { user_id: input.user_id } });

  await prisma.$transaction(async (tx) => {
    const row = await tx.apNotificationPref.upsert({
      where: { user_id: input.user_id },
      // A materialised row must start from the COLUMN DEFAULTS, not from
      // "everything false" — a missing row means defaults (§1.6), so writing one
      // event must not silently switch the others off.
      create: {
        user_id: input.user_id,
        notify_new_invoice: AP_PREF_DEFAULTS.new_invoice,
        notify_second_approval_request: AP_PREF_DEFAULTS.second_approval_request,
        notify_daily_digest: AP_PREF_DEFAULTS.daily_digest,
        notify_decision_outcome: AP_PREF_DEFAULTS.decision_outcome,
        [column]: input.value,
        updated_by: actor.actorUserId,
      },
      update: { [column]: input.value, updated_by: actor.actorUserId },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        action: (before ? 'update' : 'insert') satisfies AuditAction,
        table_name: 'ap_notification_prefs',
        row_id: row.id,
        before: before ? serializeForAudit(before) : Prisma.JsonNull,
        after: serializeForAudit(row),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
  });

  return { ok: true };
}
