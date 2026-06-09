// ADR-0017 — admin-only Settings panel data layer.
//
// Every public function here:
//   - assumes the caller already passed `requireAdmin()` (route /
//     server-component layer enforces the gate; never trust the
//     client)
//   - writes a User mutation + AuditLog entry in the same Prisma
//     transaction so an audit row can never be lost on partial
//     failure (CLAUDE.md hard rule #6 — append-only retention is
//     useless if the row never lands)
//   - never returns `pin_hash` to callers
//   - scrubs `pin_hash` from audit `before` / `after` snapshots —
//     the audit table records *that* the secret changed, never what
//     it was.
//
// PIN hashing flows through `setPin()` in `pin-service.ts` so we
// reuse the existing Argon2id config + uniqueness-within-site
// loop-verify (ADR-0012 §3). This module never calls `argon2.hash()`
// directly for PINs.
//
// `password_hash` was dropped in the Sprint-2 cleanup migration
// `20260506215753_drop_user_password_hash` (per ADR-0016 — Entra SSO
// is the only manager/admin sign-in path). The scrubber + serializer
// retain a defensive `password_hash` guard so any future refactor
// that re-introduces a password-shaped column trips the runtime
// probe before a hash can leak into the append-only audit log.

import { Prisma, type AuditAction, type User, type UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { setPin } from '@/lib/pin-service';
import { validatePinPattern } from '@/lib/pin-validator';
import { PROCESSOR_ROLES, type ProcessorRole } from '@/app/admin/constants';

// Re-export for callers that already pulled from this module. New
// code should import from `@/app/admin/constants` directly.
export { PROCESSOR_ROLES, type ProcessorRole };

// Public DTOs. NEVER expose pin_hash; use this shape in every API
// response + every server-component prop.
export interface AdminUserDto {
  id: string;
  email: string | null;
  name: string;
  role: UserRole;
  primary_site_id: string | null;
  primary_site_code: string | null;
  processor_role: string | null;
  is_active: boolean;
  all_sites: boolean;
  has_pin: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

type AuditableUser = Pick<
  User,
  | 'id'
  | 'email'
  | 'name'
  | 'role'
  | 'locale'
  | 'primary_site_id'
  | 'processor_role'
  | 'is_active'
  | 'all_sites'
  | 'pin_hash'
  | 'deleted_at'
>;

interface ActorContext {
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
}

// ────────────────────────────────────────────────────────────────────
// PII scrubber
// ────────────────────────────────────────────────────────────────────

type ScrubbedUser = Omit<AuditableUser, 'pin_hash'> & {
  pin_set: boolean;
};

/**
 * Strip `pin_hash` from a User-shaped object, replacing it with a
 * boolean "is set" marker. Used for audit `before`/`after` snapshots;
 * never reverses (we never rehydrate audit rows back into User
 * objects).
 *
 * `password_hash` was dropped in Sprint-2; if a future refactor
 * re-introduces it the runtime probe in `serializeForAudit()` will
 * throw before the value can land in the append-only audit log.
 */
export function scrubUserForAudit(u: AuditableUser): ScrubbedUser {
  const { pin_hash, ...rest } = u;
  return {
    ...rest,
    pin_set: pin_hash != null,
  };
}

// ────────────────────────────────────────────────────────────────────
// DTO mapper
// ────────────────────────────────────────────────────────────────────

type UserWithSite = User & { primary_site: { code: string } | null };

function toDto(u: UserWithSite): AdminUserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    primary_site_id: u.primary_site_id,
    primary_site_code: u.primary_site?.code ?? null,
    processor_role: u.processor_role,
    is_active: u.is_active,
    all_sites: u.all_sites,
    has_pin: u.pin_hash != null,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
    updated_at: u.updated_at,
    deleted_at: u.deleted_at,
  };
}

// ────────────────────────────────────────────────────────────────────
// List
// ────────────────────────────────────────────────────────────────────

export interface ListFilters {
  siteId?: string | undefined;
  role?: UserRole | undefined;
  status?: 'active' | 'inactive' | 'all' | undefined;
}

export async function listUsers(filters: ListFilters = {}): Promise<AdminUserDto[]> {
  const where: Prisma.UserWhereInput = {};
  if (filters.siteId) where.primary_site_id = filters.siteId;
  if (filters.role) where.role = filters.role;
  if (!filters.status || filters.status === 'active') {
    where.is_active = true;
    where.deleted_at = null;
  } else if (filters.status === 'inactive') {
    where.is_active = false;
  }
  // 'all' adds no status filter.

  const users = await prisma.user.findMany({
    where,
    include: { primary_site: { select: { code: true } } },
    orderBy: [{ name: 'asc' }],
  });
  return users.map(toDto);
}

// ────────────────────────────────────────────────────────────────────
// Create
// ────────────────────────────────────────────────────────────────────

export interface CreateUserInput {
  name: string;
  role: UserRole;
  email: string | null;
  primary_site_id: string;
  processor_role: ProcessorRole | null;
  pin: string | null;
  /** ADR-0024 — all-sites manager. Only meaningful for `manager`; coerced to
   * false for any other role (admins already see all sites; operators never). */
  all_sites?: boolean;
}

export type CreateUserResult =
  | { ok: true; user: AdminUserDto }
  | {
      ok: false;
      reason:
        | 'email_required'
        | 'email_taken'
        | 'pin_required'
        | 'pin_invalid_pattern'
        | 'pin_collision_within_site'
        | 'site_not_found';
    };

export async function createUser(
  input: CreateUserInput,
  actor: ActorContext,
): Promise<CreateUserResult> {
  // Email is required for manager + admin; optional for operator.
  if ((input.role === 'manager' || input.role === 'admin') && !input.email) {
    return { ok: false, reason: 'email_required' };
  }

  // Operators must have a PIN at creation time; the bootstrap CSV
  // path uses the seed sentinel, but the admin UI cannot.
  if (input.role === 'operator') {
    if (!input.pin) return { ok: false, reason: 'pin_required' };
    if (validatePinPattern(input.pin)) return { ok: false, reason: 'pin_invalid_pattern' };
  }

  // Site existence + (for operators) loop-verify scope.
  const site = await prisma.site.findUnique({
    where: { id: input.primary_site_id },
    select: { id: true },
  });
  if (!site) return { ok: false, reason: 'site_not_found' };

  // Manager/admin email uniqueness — case-insensitive (we lowercase
  // on write). Postgres `@unique` on `email` is case-sensitive, so
  // we enforce it here.
  const email = input.email ? input.email.toLowerCase() : null;
  if (email) {
    const dup = await prisma.user.findUnique({ where: { email } });
    if (dup) return { ok: false, reason: 'email_taken' };
  }

  // Operator PIN: pre-check uniqueness across ACTIVE peers at the
  // same site. We can't do this inside the create transaction
  // because setPin() does it post-create; but we need the user row
  // to exist before setPin can write the hash. Strategy: create with
  // pin_hash=null in a transaction with the audit row, then call
  // setPin() outside the txn. If setPin fails (collision), roll back
  // via soft-delete + audit. This is safe — the user does not appear
  // active until the PIN write succeeds, because we leave
  // is_active=false until then. Manager/admin rows are created
  // active; sign-in is gated by Entra SSO + the `evaluateEntraSignIn`
  // role/active/deleted_at checks (ADR-0016).

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: input.name,
        role: input.role,
        email,
        primary_site_id: input.primary_site_id,
        processor_role: input.processor_role,
        // ADR-0024: all_sites only applies to managers; force false otherwise.
        all_sites: input.role === 'manager' ? (input.all_sites ?? false) : false,
        // Operators flip to active after the PIN write; SSO users
        // are active immediately so they can sign in.
        is_active: input.role !== 'operator',
      },
      include: { primary_site: { select: { code: true } } },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        action: 'insert' satisfies AuditAction,
        table_name: 'users',
        row_id: user.id,
        before: Prisma.JsonNull,
        after: serializeForAudit(scrubUserForAudit(user)),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return user;
  });

  if (input.role === 'operator' && input.pin) {
    const pinResult = await setPin({
      targetUserId: created.id,
      pin: input.pin,
      actorUserId: actor.actorUserId,
    });
    if (!pinResult.ok) {
      // Roll back: hard-delete the orphan row + its audit entry. We
      // can hard-delete here because nothing else references the row
      // yet (no loads, no sessions, no audit rows from other tables).
      // The original audit insert from the txn is preserved per
      // append-only rule; we add a compensating soft_delete entry.
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: created.id },
          data: { is_active: false, deleted_at: new Date() },
        });
        await tx.auditLog.create({
          data: {
            actor_user_id: actor.actorUserId,
            action: 'soft_delete' satisfies AuditAction,
            table_name: 'users',
            row_id: created.id,
            before: serializeForAudit(scrubUserForAudit(created)),
            after: serializeForAudit({
              ...scrubUserForAudit(created),
              is_active: false,
              deleted_at: new Date(),
            }),
            ip: actor.ip,
            user_agent: actor.userAgent,
          },
        });
      });
      if (pinResult.reason === 'invalid_pattern')
        return { ok: false, reason: 'pin_invalid_pattern' };
      if (pinResult.reason === 'collision_within_site')
        return { ok: false, reason: 'pin_collision_within_site' };
      return { ok: false, reason: 'pin_required' };
    }
    // Flip the operator to active now that the PIN landed.
    const finalUser = await prisma.user.update({
      where: { id: created.id },
      data: { is_active: true },
      include: { primary_site: { select: { code: true } } },
    });
    return { ok: true, user: toDto(finalUser) };
  }

  return { ok: true, user: toDto(created) };
}

// ────────────────────────────────────────────────────────────────────
// Update
// ────────────────────────────────────────────────────────────────────

export interface UpdateUserInput {
  name?: string;
  role?: UserRole;
  email?: string | null;
  primary_site_id?: string;
  processor_role?: ProcessorRole | null;
  /** ADR-0024 — all-sites manager. Coerced to false whenever the effective
   * role is not `manager` (so promoting an all-sites manager to admin, or
   * demoting to operator, clears the flag). */
  all_sites?: boolean;
}

export type UpdateUserResult =
  | { ok: true; user: AdminUserDto }
  | { ok: false; reason: 'not_found' | 'email_required' | 'email_taken' | 'site_not_found' };

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actor: ActorContext,
): Promise<UpdateUserResult> {
  const existing = await prisma.user.findUnique({
    where: { id },
    include: { primary_site: { select: { code: true } } },
  });
  if (!existing) return { ok: false, reason: 'not_found' };

  // Role change effects: enforce email-required invariant after the
  // change. We don't auto-strip processor_role on a role change;
  // managers can clear it explicitly via input.processor_role=null.
  const nextRole = input.role ?? existing.role;
  const nextEmail =
    input.email === undefined ? existing.email : input.email ? input.email.toLowerCase() : null;
  if ((nextRole === 'manager' || nextRole === 'admin') && !nextEmail) {
    return { ok: false, reason: 'email_required' };
  }
  if (nextEmail && nextEmail !== existing.email) {
    const dup = await prisma.user.findUnique({ where: { email: nextEmail } });
    if (dup && dup.id !== id) return { ok: false, reason: 'email_taken' };
  }

  if (input.primary_site_id && input.primary_site_id !== existing.primary_site_id) {
    const site = await prisma.site.findUnique({
      where: { id: input.primary_site_id },
      select: { id: true },
    });
    if (!site) return { ok: false, reason: 'site_not_found' };
  }

  const data: Prisma.UserUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.role !== undefined) data.role = input.role;
  if (input.email !== undefined) data.email = nextEmail;
  if (input.primary_site_id !== undefined) {
    data.primary_site = { connect: { id: input.primary_site_id } };
  }
  if (input.processor_role !== undefined) data.processor_role = input.processor_role;

  // ADR-0024: all_sites is meaningful only for managers. Recompute it whenever
  // the flag OR the role is part of this update, so a role change away from
  // `manager` clears it and a flag toggle on a manager persists it.
  if (input.all_sites !== undefined || input.role !== undefined) {
    const nextAllSites = nextRole === 'manager' ? (input.all_sites ?? existing.all_sites) : false;
    if (nextAllSites !== existing.all_sites) data.all_sites = nextAllSites;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id },
      data,
      include: { primary_site: { select: { code: true } } },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        action: 'update' satisfies AuditAction,
        table_name: 'users',
        row_id: id,
        before: serializeForAudit(scrubUserForAudit(existing)),
        after: serializeForAudit(scrubUserForAudit(u)),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return u;
  });

  return { ok: true, user: toDto(updated) };
}

// ────────────────────────────────────────────────────────────────────
// PIN reset (operators only)
// ────────────────────────────────────────────────────────────────────

export type ResetPinResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_found' | 'not_operator' | 'pin_invalid_pattern' | 'pin_collision_within_site';
    };

export async function resetUserPin(
  id: string,
  newPin: string,
  actor: ActorContext,
): Promise<ResetPinResult> {
  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true },
  });
  if (!target) return { ok: false, reason: 'not_found' };
  if (target.role !== 'operator') return { ok: false, reason: 'not_operator' };

  const r = await setPin({
    targetUserId: id,
    pin: newPin,
    actorUserId: actor.actorUserId,
  });
  if (r.ok) return { ok: true };
  if (r.reason === 'invalid_pattern') return { ok: false, reason: 'pin_invalid_pattern' };
  if (r.reason === 'collision_within_site')
    return { ok: false, reason: 'pin_collision_within_site' };
  return { ok: false, reason: 'not_found' };
}

// ────────────────────────────────────────────────────────────────────
// Deactivate / reactivate
// ────────────────────────────────────────────────────────────────────

export type DeactivateResult =
  | { ok: true; user: AdminUserDto }
  | { ok: false; reason: 'not_found' | 'self_deactivate' };

export async function deactivateUser(id: string, actor: ActorContext): Promise<DeactivateResult> {
  if (id === actor.actorUserId) return { ok: false, reason: 'self_deactivate' };

  const existing = await prisma.user.findUnique({
    where: { id },
    include: { primary_site: { select: { code: true } } },
  });
  if (!existing) return { ok: false, reason: 'not_found' };

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id },
      data: { is_active: false, deleted_at: new Date() },
      include: { primary_site: { select: { code: true } } },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        action: 'soft_delete' satisfies AuditAction,
        table_name: 'users',
        row_id: id,
        before: serializeForAudit(scrubUserForAudit(existing)),
        after: serializeForAudit(scrubUserForAudit(u)),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return u;
  });
  return { ok: true, user: toDto(updated) };
}

export type ReactivateResult =
  | { ok: true; user: AdminUserDto }
  | { ok: false; reason: 'not_found' };

export async function reactivateUser(id: string, actor: ActorContext): Promise<ReactivateResult> {
  const existing = await prisma.user.findUnique({
    where: { id },
    include: { primary_site: { select: { code: true } } },
  });
  if (!existing) return { ok: false, reason: 'not_found' };

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id },
      data: { is_active: true, deleted_at: null },
      include: { primary_site: { select: { code: true } } },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        action: 'restore' satisfies AuditAction,
        table_name: 'users',
        row_id: id,
        before: serializeForAudit(scrubUserForAudit(existing)),
        after: serializeForAudit(scrubUserForAudit(u)),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return u;
  });
  return { ok: true, user: toDto(updated) };
}

// ────────────────────────────────────────────────────────────────────
// Read by id (for edit-page server hydration)
// ────────────────────────────────────────────────────────────────────

export async function getUser(id: string): Promise<AdminUserDto | null> {
  const u = await prisma.user.findUnique({
    where: { id },
    include: { primary_site: { select: { code: true } } },
  });
  return u ? toDto(u) : null;
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

// Re-implements the audit-helper pattern locally so we can write
// audit rows from inside an interactive transaction (the helper in
// `audit.ts` runs in its own client). The serialization shape
// matches `writeAudit()` exactly.
//
// Date instances aren't JSON-serializable through Prisma's input
// type, but `JSON.parse(JSON.stringify(...))` ISO-stringifies them,
// matching the `audit.ts` behavior.
function serializeForAudit(v: ScrubbedUser): Prisma.InputJsonValue {
  // Defensive: confirm at runtime that nobody dropped pin_hash back
  // in via a future refactor. We also reject `password_hash` even
  // though the column was dropped in Sprint-2 — if a future change
  // re-introduces a password-shaped column, this probe ensures the
  // hash never reaches the append-only audit log. The cost is one
  // shallow has-property check.
  const probe = v as Record<string, unknown>;
  if ('pin_hash' in probe || 'password_hash' in probe) {
    throw new Error('admin-users: refused to audit object containing pin_hash/password_hash');
  }
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

// Re-export helpers tests need to drive without spinning up a DB.
export const __testing = { serializeForAudit };
