// ADR-0047 — typed errors for the staff-notification policy layer.

/**
 * A feature tried to send staff-facing mail through a surface that is not
 * registered in `rollout_surfaces`. Per ADR-0047 D1 an unregistered surface is
 * a typed error, NEVER a silent send — every staff-facing output must declare a
 * surface row (which is born `pilot`), so an unregistered code is a programming
 * error (a new surface shipped without its registry row). Surfaced as 500.
 */
export class UnregisteredSurfaceError extends Error {
  readonly status = 500 as const;
  constructor(
    readonly surfaceCode: string,
    readonly kind: string,
  ) {
    super(
      `notifyStaff: surface '${surfaceCode}' (${kind}) is not registered in rollout_surfaces — ` +
        `refusing to send (ADR-0047 D1: an unregistered surface is a typed error, never a silent send). ` +
        `Register it in the 20260713_rollout_gate seed (born pilot).`,
    );
    this.name = 'UnregisteredSurfaceError';
  }
}
