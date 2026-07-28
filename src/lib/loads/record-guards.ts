// ADR-0037 — shared guards for the manager CRUD-lite loads/inventory records
// (consumer_dropoffs, outbound_materials, landfilled_units).
//
// D7 activation gate (data-driven since ADR-0047): schema + surfaces merge behind
// flags, but no loads surface activates beyond what is already shipped until an
// admin flips it ON. `assertLoadsInventoryActivated` is the single, documented
// gate — it is NOT a permission check (that is the site/role guard), it is the
// feature-exposure switch. It reads the persisted `loads_inventory` ADR-0047
// rollout surface (per-site): `pilot`/missing/unregistered ⇒ admin-only (the
// historical behavior — a fresh deploy changes NOTHING); `live` ⇒ operators and
// managers are activated for that site. An admin ALWAYS passes and never triggers
// a DB read. The flip is admin-only + audited via /admin/rollout (ADR-0047); the
// ops preconditions (restore drill + RESTIC_PASSWORD off-box) remain Bill's
// go/no-go for approving that flip.

import { isUiSurfaceLive, UI_SURFACE, type UiSurfaceCode } from '@/lib/notify/rollout';
import type { PrismaClient } from '@prisma/client';

/** The record cannot be edited because it has been locked (edit-before-any-lock). */
export class RecordLockedError extends Error {
  readonly status = 409 as const;
  constructor(table: string, id: string) {
    super(`${table} record ${id} is locked and can no longer be edited`);
    this.name = 'RecordLockedError';
  }
}

/** The requested record does not exist (or is at another site). */
export class RecordNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(table: string, id: string) {
    super(`${table} record ${id} not found`);
    this.name = 'RecordNotFoundError';
  }
}

/** Input failed validation (e.g. a program/non-program split that does not sum). */
export class RecordValidationError extends Error {
  readonly status = 422 as const;
  constructor(message: string) {
    super(message);
    this.name = 'RecordValidationError';
  }
}

/** The loads/inventory surfaces are gated to admins until the D7 gate is flipped live. */
export class LoadsInventoryNotActivatedError extends Error {
  readonly status = 403 as const;
  constructor() {
    super(
      'loads/inventory surfaces are not yet activated (ADR-0037 D7 — admin-only until flipped live)',
    );
    this.name = 'LoadsInventoryNotActivatedError';
  }
}

/**
 * Throw {@link LoadsInventoryNotActivatedError} unless the loads/inventory flow is
 * activated for the caller. Admins ALWAYS pass (no DB read). Operators and managers
 * pass ONLY when the per-site `loads_inventory` rollout surface (ADR-0047) is `live`.
 *
 * Default-safe: an unregistered/missing surface row, a `pilot` state, or any read
 * error resolves to admin-only (via {@link isUiSurfaceLive}, which is fail-closed) —
 * identical to the historical hardcoded behavior. A fresh deploy exposes nothing to
 * operators/managers until an admin flips the surface `live` from /admin/rollout.
 */
export async function assertLoadsInventoryActivated(
  role: 'operator' | 'manager' | 'admin',
  siteId: string,
  db?: PrismaClient,
): Promise<void> {
  return assertUiSurfaceActivated(role, UI_SURFACE.LOADS_INVENTORY, siteId, db);
}

/**
 * ADR-0065 — the generalized form of {@link assertLoadsInventoryActivated}, for a
 * caller that names its OWN surface code instead of riding the shared
 * `loads_inventory` master gate. Same fail-closed semantics: admins always pass
 * (no DB read); everyone else passes only when that surface is `live` for the
 * site; unregistered / `pilot` / read-error ⇒ throw.
 *
 * This is what lets Bill disable ONE iPad screen from /admin/rollout without
 * dropping the manager desktop's loads/inventory tabs, which keep reading the
 * master gate.
 */
export async function assertUiSurfaceActivated(
  role: 'operator' | 'manager' | 'admin',
  surfaceCode: UiSurfaceCode,
  siteId: string,
  db?: PrismaClient,
): Promise<void> {
  if (role === 'admin') return;
  const live = await isUiSurfaceLive(surfaceCode, siteId, db);
  if (!live) throw new LoadsInventoryNotActivatedError();
}

/** Throw {@link RecordLockedError} when a record is locked. */
export function assertUnlocked(table: string, id: string, lockedAt: Date | null): void {
  if (lockedAt) throw new RecordLockedError(table, id);
}
