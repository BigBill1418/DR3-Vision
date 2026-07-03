// ADR-0037 — shared guards for the manager CRUD-lite loads/inventory records
// (consumer_dropoffs, outbound_materials, landfilled_units).
//
// D7 activation gate: schema + surfaces merge behind flags, but no loads surface
// activates beyond what is already shipped until the ops gates close (restore
// drill + RESTIC_PASSWORD off-box, both Bill-owned). Until then only ADMINS see
// these surfaces. `assertLoadsInventoryActivated` is the single, documented gate
// to flip when activation is approved — it is NOT a permission check (that is the
// site/role guard), it is the feature-exposure switch.

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

/** The loads/inventory surfaces are gated to admins until the D7 ops gates close. */
export class LoadsInventoryNotActivatedError extends Error {
  readonly status = 403 as const;
  constructor() {
    super('loads/inventory surfaces are not yet activated (ADR-0037 D7 — admin-only until ops gates close)');
    this.name = 'LoadsInventoryNotActivatedError';
  }
}

/** Throw {@link LoadsInventoryNotActivatedError} unless the caller is an admin. */
export function assertLoadsInventoryActivated(role: 'operator' | 'manager' | 'admin'): void {
  if (role !== 'admin') throw new LoadsInventoryNotActivatedError();
}

/** Throw {@link RecordLockedError} when a record is locked. */
export function assertUnlocked(table: string, id: string, lockedAt: Date | null): void {
  if (lockedAt) throw new RecordLockedError(table, id);
}
