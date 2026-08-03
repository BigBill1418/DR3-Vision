// ADR-0047 — the rollout-surface registry resolver, shared by the notification
// chokepoint (`notify-staff.ts`) AND the UI surface-audience gate. ONE resolver
// so a surface's pilot/live state is read the same way everywhere.
//
// Model shape (see prisma/schema.prisma `RolloutSurface`): one row per
// (surface_code, site). Default `pilot`. Every notification surface is seeded
// per site (Eugene + Woodland) — there are no NULL-site rows, so the Postgres
// NULL-unique ambiguity never arises. An ORG-WIDE caller (site = null, e.g. the
// AP module) resolves the effective state conservatively: `pilot` unless EVERY
// per-site row is `live` (both sites must be ramped before an org-wide surface
// goes live). This is the fail-safe direction.

import { prisma } from '@/lib/prisma';
import type { PrismaClient, RolloutState, RolloutSurfaceKind } from '@prisma/client';
import { UnregisteredSurfaceError } from './errors';

export type { RolloutState, RolloutSurfaceKind } from '@prisma/client';

// ── Registered surface codes (the registry). Future features add a line here
// AND a seed row; the repo test + the seed keep this list and the DB in sync. ──

/** Notification surfaces under the ADR-0047 gate. */
export const NOTIFY_SURFACE = {
  ALERT_DIGEST: 'alert_digest',
  TASK_REMINDERS: 'task_reminders',
  CONTACT_INTAKE_NOTIFY: 'contact_intake_notify',
  INVOICE_APPROVAL_NOTIFY: 'invoice_approval_notify',
  COR_NOTIFY: 'cor_notify',
  AP_NOTIFY: 'ap_notify',
  // ADR-0046 Amendment 9 (§2.4) — an approver filed an equipment ESCAPE-HATCH
  // request. Deliberately its OWN surface rather than riding `ap_notify`: the
  // audience is different (the SITE MANAGERS who maintain the fleet, not the
  // approver roster), and Bill must be able to ramp this to Morena/Rick without
  // also ramping the AP queue's new-invoice broadcast. Born pilot. Per-site rows,
  // and this surface is CALLED per-site (the request always carries a real site),
  // so it never takes the conservative org-wide both-sites-must-be-live path.
  AP_EQUIPMENT_REQUEST: 'ap_equipment_request',
  // ADR-0045 §3 addendum (planning rollup 2026-07-08 §1.8) — Bethany's board-pack
  // digest. Org-wide surface, born pilot (resolves pilot unless BOTH sites live).
  BOARD_PACK_DIGEST: 'board_pack_digest',
  // Grandfathered — established production surfaces, seeded `live` (§4.4 out-of-scope).
  BONUS_SIGNATURE_CHAIN: 'bonus_signature_chain',
  SURVEY_SENDS: 'survey_sends',
} as const;

/** UI surfaces whose per-site audience is gated (ADR-0037 D7 pattern → data-driven). */
export const UI_SURFACE = {
  WORKBENCH_MANAGER_READ: 'workbench_manager_read',
  LOADS_EVENTS_OR_TABS: 'loads_events_or_tabs',
  EQUIPMENT_ENTRY: 'equipment_entry',
  EQUIPMENT_TREND: 'equipment_trend',
  // handoff §1.8 — manager-facing Yard view, born pilot (admin-only until flipped).
  YARD_LIST: 'yard_list',
  // ADR-0037 D7 (data-driven) — the master loads/inventory + floor-operator
  // activation gate. Born `pilot` (admin-only, today's behavior); an admin flips
  // it `live` per-site from /admin/rollout to activate the operator iPad flow.
  // Consulted by `assertLoadsInventoryActivated` (record-guards) and the
  // loads-inventory page gate. Default/unregistered ⇒ admin-only (fail-safe).
  LOADS_INVENTORY: 'loads_inventory',

  // ── ADR-0065 — PER-SURFACE iPad (floor) gates ──────────────────────────────
  // `loads_inventory` is a SHARED master gate: it also fronts the manager
  // desktop loads/inventory tabs and every loads write. Bill needs to disable
  // ONE iPad surface without a deploy AND without dropping the managers' tabs,
  // so each operator surface gets its own row. These are read INSTEAD of
  // `loads_inventory` on the iPad; the manager desktop keeps reading the master.
  //
  // The hub (`/operator/[site]/today`) is deliberately NOT gated — Bill:
  // "leave the site picker do not strand anyone." Only its cards + its F-1
  // on-hand summary block are gated, so a signed-in operator always lands
  // somewhere navigable.
  /** Truck queue + the per-load dock workflow (`/queue`, `/load/[id]`) and their writes. */
  IPAD_QUEUE: 'ipad_queue',
  /** Inbound haul-count confirmation (ADR-0060 F-2). */
  IPAD_INBOUND: 'ipad_inbound',
  /** Physical on-hand count (ADR-0060 F-3). */
  IPAD_COUNT: 'ipad_count',
  /** Processed / stripped-count confirmation (ADR-0060 F-4). */
  IPAD_PROCESSED: 'ipad_processed',
  /** The F-1 on-hand summary BLOCK inside the hub — not the hub itself. */
  IPAD_TODAY_SUMMARY: 'ipad_today_summary',

  // ADR-0074 — the open, searchable, newest-first READ of every MyMRC portal
  // haul (`/operator/[site]/hauls`). Its own surface rather than riding
  // `ipad_queue`: this is a read catalogue with no writes, and Bill must be able
  // to ramp it at Woodland (the only site with a portal feed) without touching
  // the actionable dock queue — or to pull it back without taking the queue down
  // with it. Born `pilot` per ADR-0047 #3.
  IPAD_HAULS: 'ipad_hauls',

  // ADR-0068 — the Employee Reimbursement tile on the site dashboard. Gated per
  // site because spec §6.4 leaves open whether Eugene's reimbursement process
  // runs the same way as Woodland's today; Bill can ramp one without the other
  // and without a deploy.
  REIMBURSEMENT_TILE: 'reimbursement_tile',
} as const;

export type NotifySurfaceCode = (typeof NOTIFY_SURFACE)[keyof typeof NOTIFY_SURFACE];
export type UiSurfaceCode = (typeof UI_SURFACE)[keyof typeof UI_SURFACE];

interface ResolveOpts {
  db?: PrismaClient;
  kind: RolloutSurfaceKind;
  surfaceCode: string;
  /** Concrete site id, or null for an org-wide (aggregate-across-sites) resolution. */
  siteId: string | null;
}

/**
 * Resolve the effective rollout state for a surface. Throws
 * {@link UnregisteredSurfaceError} when no row exists (never a silent default).
 */
export async function getRolloutState(opts: ResolveOpts): Promise<RolloutState> {
  const db = opts.db ?? prisma;

  if (opts.siteId === null) {
    const rows = await db.rolloutSurface.findMany({
      where: { kind: opts.kind, surface_code: opts.surfaceCode },
      select: { rollout_state: true },
    });
    if (rows.length === 0) throw new UnregisteredSurfaceError(opts.surfaceCode, opts.kind);
    // Conservative: live only if every site is live; any pilot ⇒ pilot.
    return rows.every((r) => r.rollout_state === 'live') ? 'live' : 'pilot';
  }

  const row = await db.rolloutSurface.findUnique({
    where: { surface_code_site_id: { surface_code: opts.surfaceCode, site_id: opts.siteId } },
    select: { rollout_state: true },
  });
  if (!row) throw new UnregisteredSurfaceError(opts.surfaceCode, opts.kind);
  return row.rollout_state;
}

/** Notification-surface convenience wrapper. */
export function getNotificationState(
  surfaceCode: string,
  siteId: string | null,
  db?: PrismaClient,
): Promise<RolloutState> {
  return getRolloutState({ ...(db ? { db } : {}), kind: 'notification', surfaceCode, siteId });
}

/**
 * UI-surface convenience wrapper. UI surfaces are always per-site. Returns
 * `true` when the surface is LIVE for its designed (non-admin) audience; `false`
 * in pilot (admin-only — the ADR-0037 D7 default). Never throws for a caller
 * that wants a boolean: an unregistered UI surface is treated as pilot
 * (admin-only) — fail-safe — and logged upstream.
 */
export async function isUiSurfaceLive(
  surfaceCode: string,
  siteId: string,
  db?: PrismaClient,
): Promise<boolean> {
  try {
    const state = await getRolloutState({ ...(db ? { db } : {}), kind: 'ui', surfaceCode, siteId });
    return state === 'live';
  } catch {
    // Unregistered ⇒ admin-only (pilot) is the safe default for a visibility gate.
    return false;
  }
}

export interface AdminRecipient {
  address: string;
  name: string;
}

/**
 * The active-admin recipient set — where pilot output reroutes. Admins are the
 * only audience allowed to validate an unramped surface (directive §4.2).
 */
export async function activeAdminRecipients(db: PrismaClient = prisma): Promise<AdminRecipient[]> {
  const rows = await db.user.findMany({
    where: { role: 'admin', is_active: true, email: { not: null } },
    select: { email: true, name: true },
    orderBy: { name: 'asc' },
  });
  return rows
    .filter((r): r is { email: string; name: string } => !!r.email)
    .map((r) => ({ address: r.email, name: r.name }));
}
