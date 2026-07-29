// ADR-0046 Amendment 9 (§2.2–§2.6) — the AP equipment ESCAPE HATCH.
//
// THE PROBLEM THIS SOLVES. Amendment 5 (D-M5-6) made equipment linkage REQUIRED
// to approve, and Amendment 7 opened the picker to the whole fleet. Neither
// helps an approver holding an invoice for an asset the registry simply does not
// carry — the ADR-0062 seed is a coarse jurisdiction mapping of an SVdP machine
// list that has no "DR3 Eugene" facility at all (C-28). Their only two options
// were both lies: pick a wrong-but-plausible asset, or tick "Not
// equipment-related". Both file the invoice against the wrong thing, and neither
// leaves any trace that the registry is incomplete.
//
// THE HATCH IS NOT A BYPASS. The third option costs MORE than the other two, not
// less: a REQUIRED free-text description, written into `ap_equipment_requests`
// inside the SAME transaction as the decision, that lands on a site-manager
// worklist and stays `open` until somebody either creates the real asset
// (`resolved`) or says why it was not one (`rejected`, note required). What used
// to be a silent mis-filing is now a tracked request with a named owner.
//
// INVARIANTS THIS MODULE OWNS:
//   1. Exactly one disposition per `ap_equipment_links` row (equipment /
//      not-related / request). Enforced by a DB CHECK constraint as of this
//      amendment — the app check alone was what a third option would have
//      quietly outgrown. This module never writes a row that violates it.
//   2. Every mutation writes its `audit_log` row in the SAME transaction
//      (CLAUDE.md hard rule #6).
//   3. Resolution NEVER touches the invoice's decision. `ap_requests.status`,
//      `decided_by`, `decided_at` are not read for writing and not written here.
//      A rejected request means "this was not equipment after all", NOT "unapprove
//      that invoice" — the money already moved.
//   4. Nothing is ever hard-deleted. Terminal states are stamps, and the
//      equipment this creates is subject to ADR-0063's deactivate-only rule.

import type { Prisma, PrismaClient, EquipmentCategory } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import {
  createEquipmentInTx,
  normalizeDisplayName,
  DISPLAY_NAME_MAX,
  type ActorContext,
} from '@/lib/admin-equipment';

const TABLE = 'ap_equipment_requests';

/**
 * Storage-DoS boundary on the description, matching the AP route's `NOTE_MAX_LEN`.
 * Generous enough for "type, make/model, unit number, nickname, and site" — which
 * is exactly what the field asks for — and bounded enough to refuse an abusive
 * payload.
 */
export const EQUIPMENT_REQUEST_DESCRIPTION_MAX = 2000;

/** Thrown when a resolve/reject payload cannot produce a valid terminal state. */
export class ApEquipmentRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'ApEquipmentRequestError';
  }
}

// ────────────────────────────────────────────────────────────────────
// Create (transaction participant — called from decideRequest)
// ────────────────────────────────────────────────────────────────────

export interface CreateEquipmentRequestArgs {
  apRequestId: string;
  siteId: string;
  description: string;
  requestedBy: string;
}

/**
 * File the request AND its `ap_equipment_links` row, inside the decision's own
 * transaction.
 *
 * Both writes live here rather than being split across this module and
 * `approvals.ts` because they are one invariant, not two rows: a hatch link is
 * meaningless without the request it points at, and a request with no link is an
 * orphan that never shows the invoice it came from. The DB CHECK refuses the
 * half-states, so writing them from one place is what keeps that constraint from
 * ever being the thing that discovers a bug.
 *
 * Returns the new request id so the caller can notify after commit.
 */
export async function createEquipmentRequestInTx(
  tx: Prisma.TransactionClient,
  args: CreateEquipmentRequestArgs,
): Promise<string> {
  const description = args.description.trim();
  if (!description) {
    throw new ApEquipmentRequestError('An equipment description is required.');
  }
  const row = await tx.apEquipmentRequest.create({
    data: {
      ap_request_id: args.apRequestId,
      site_id: args.siteId,
      description: description.slice(0, EQUIPMENT_REQUEST_DESCRIPTION_MAX),
      requested_by: args.requestedBy,
      status: 'open',
    },
    select: { id: true },
  });
  await tx.apEquipmentLink.create({
    data: { request_id: args.apRequestId, equipment_request_id: row.id },
  });
  // The decision's own audit row records `equipment: 'request'`; this one records
  // the request row itself so the worklist has a first-class provenance entry.
  await writeAudit(
    {
      actor_user_id: args.requestedBy,
      action: 'insert',
      table_name: TABLE,
      row_id: row.id,
      after: {
        ap_request_id: args.apRequestId,
        site_id: args.siteId,
        status: 'open',
        description_length: description.length,
      },
    },
    { tx },
  );
  return row.id;
}

// ────────────────────────────────────────────────────────────────────
// Read (the §2.5 worklist + the §2.6 dashboard count)
// ────────────────────────────────────────────────────────────────────

export interface EquipmentRequestView {
  id: string;
  description: string;
  status: 'open' | 'resolved' | 'rejected';
  requestedAt: Date;
  requesterName: string | null;
  siteId: string;
  siteCode: string | null;
  siteName: string | null;
  /** Invoice context — what the approver was looking at when they filed this. */
  apRequestId: string;
  subject: string | null;
  vendor: string | null;
  amountCents: number | null;
  resolvedEquipmentId: string | null;
  resolvedEquipmentName: string | null;
  resolverName: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  /** True when the originating link row can still be repointed (§2.5 backfill). */
  linkPending: boolean;
}

export interface ListEquipmentRequestFilters {
  status?: 'open' | 'resolved' | 'rejected' | 'all' | undefined;
  /**
   * Site reach (CLAUDE.md hard rule #2). `undefined` = every site (admin or an
   * `all_sites` manager); a list = exactly those sites. An EMPTY array means "no
   * reach" and returns nothing — never "all", which is the direction that leaks.
   */
  siteIds?: readonly string[] | undefined;
}

function whereFrom(filters: ListEquipmentRequestFilters): Prisma.ApEquipmentRequestWhereInput {
  const where: Prisma.ApEquipmentRequestWhereInput = {};
  if (!filters.status || filters.status === 'open') where.status = 'open';
  else if (filters.status !== 'all') where.status = filters.status;
  if (filters.siteIds) where.site_id = { in: [...filters.siteIds] };
  return where;
}

/**
 * The worklist, oldest FIRST — this is an aging queue, and the request that has
 * been waiting longest is the one a site manager should see first.
 */
export async function listEquipmentRequests(
  prisma: PrismaClient = defaultPrisma,
  filters: ListEquipmentRequestFilters = {},
): Promise<EquipmentRequestView[]> {
  const rows = await prisma.apEquipmentRequest.findMany({
    where: whereFrom(filters),
    orderBy: { requested_at: 'asc' },
    include: {
      ap_request: {
        select: { id: true, subject: true, vendor_freeform: true, confirmed_amount_cents: true },
      },
      resolved_equipment: { select: { id: true, display_name: true } },
      links: { select: { id: true, equipment_request_id: true } },
    },
  });
  if (rows.length === 0) return [];

  // `site_id`, `requested_by` and `resolved_by` are BARE FKs (repo convention for
  // sibling-owned models), so resolve their labels with two batched lookups
  // rather than an include that does not exist.
  const [sites, users] = await Promise.all([
    prisma.site.findMany({ select: { id: true, code: true, name: true } }),
    prisma.user.findMany({
      where: {
        id: {
          in: Array.from(
            new Set(
              rows.flatMap((r) => [r.requested_by, ...(r.resolved_by ? [r.resolved_by] : [])]),
            ),
          ),
        },
      },
      select: { id: true, name: true },
    }),
  ]);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return rows.map((r) => {
    const site = siteById.get(r.site_id);
    return {
      id: r.id,
      description: r.description,
      status: r.status,
      requestedAt: r.requested_at,
      requesterName: nameById.get(r.requested_by) ?? null,
      siteId: r.site_id,
      siteCode: site?.code ?? null,
      siteName: site?.name ?? null,
      apRequestId: r.ap_request_id,
      subject: r.ap_request.subject,
      vendor: r.ap_request.vendor_freeform,
      amountCents: r.ap_request.confirmed_amount_cents,
      resolvedEquipmentId: r.resolved_equipment?.id ?? null,
      resolvedEquipmentName: r.resolved_equipment?.display_name ?? null,
      resolverName: r.resolved_by ? (nameById.get(r.resolved_by) ?? null) : null,
      resolvedAt: r.resolved_at,
      resolutionNote: r.resolution_note,
      // A link still pointing at THIS request is one that has not been backfilled.
      linkPending: r.links.some((l) => l.equipment_request_id === r.id),
    };
  });
}

/** Open-request count for the ADR-0020 dashboard tile badge (§2.6). */
export async function openEquipmentRequestCount(
  prisma: PrismaClient = defaultPrisma,
  filters: Pick<ListEquipmentRequestFilters, 'siteIds'> = {},
): Promise<number> {
  return prisma.apEquipmentRequest.count({ where: whereFrom({ ...filters, status: 'open' }) });
}

// ────────────────────────────────────────────────────────────────────
// Resolve (§2.5 — create the real asset, then optionally backfill)
// ────────────────────────────────────────────────────────────────────

export interface ResolveEquipmentRequestInput {
  displayName: string;
  category: EquipmentCategory;
  /** Site the asset is registered to. Defaults to the request's site. */
  siteId?: string | undefined;
  /**
   * Repoint the ORIGINATING `ap_equipment_links` row at the new asset — the payoff
   * (Bill: "any equipment that was entered quickly to be properly formatted in the
   * future"). Default TRUE: leaving the historical invoice attributed to a
   * free-text blob when the real asset now exists is the outcome nobody wants.
   */
  backfillLink?: boolean | undefined;
  note?: string | undefined;
}

export interface ResolveEquipmentRequestResult {
  equipmentId: string;
  equipmentDisplayName: string;
  /** How many `ap_equipment_links` rows were repointed (0 or 1 in practice). */
  backfilledLinks: number;
}

/**
 * Resolve an OPEN request: create the real `equipment` row, stamp the resolution,
 * and (by default) repoint the originating link.
 *
 * All three in ONE transaction, via `createEquipmentInTx` rather than
 * `createEquipment` — a second, independent transaction for the create would
 * leave an orphan asset behind if the stamp or the backfill then failed, and
 * "resolve it again" would hit the `(site_id, display_name)` unique and be stuck.
 *
 * The invoice's approved decision is NOT touched. Only the link's ATTRIBUTION
 * changes, from "the approver described it" to "it is this asset".
 */
export async function resolveEquipmentRequest(
  prismaClient: PrismaClient = defaultPrisma,
  requestId: string,
  input: ResolveEquipmentRequestInput,
  actor: ActorContext,
): Promise<ResolveEquipmentRequestResult> {
  const displayName = normalizeDisplayName(input.displayName);
  if (!displayName) throw new ApEquipmentRequestError('Enter a name for the asset.');
  if (displayName.length > DISPLAY_NAME_MAX)
    throw new ApEquipmentRequestError(`Name must be ${DISPLAY_NAME_MAX} characters or fewer.`);

  const existing = await prismaClient.apEquipmentRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, site_id: true, ap_request_id: true },
  });
  if (!existing) throw new ApEquipmentRequestError('Equipment request not found.', 404);
  if (existing.status !== 'open')
    throw new ApEquipmentRequestError(`This request was already ${existing.status}.`, 409);

  const siteId = input.siteId ?? existing.site_id;
  const backfill = input.backfillLink !== false;
  const note = input.note?.trim();

  return prismaClient.$transaction(async (tx) => {
    const created = await createEquipmentInTx(
      tx,
      { site_id: siteId, display_name: displayName, category: input.category },
      actor,
    );
    if (!created.ok) throw new ApEquipmentRequestError(createFailureMessage(created.reason), 409);

    // Conditional stamp: `status: 'open'` in the WHERE makes two managers racing
    // to resolve the same request first-action-wins, exactly like the AP decide
    // path. The loser gets a 409 instead of double-creating an asset.
    const stamped = await tx.apEquipmentRequest.updateMany({
      where: { id: requestId, status: 'open' },
      data: {
        status: 'resolved',
        resolved_equipment_id: created.row.id,
        resolved_by: actor.actorUserId,
        resolved_at: new Date(),
        ...(note ? { resolution_note: note } : {}),
      },
    });
    if (stamped.count === 0)
      throw new ApEquipmentRequestError('This request was resolved by someone else.', 409);

    // §2.5 backfill — the historical invoice ends up correctly attributed. Both
    // columns move together: setting `equipment_id` while leaving
    // `equipment_request_id` set would trip the exactly-one-disposition CHECK.
    let backfilledLinks = 0;
    if (backfill) {
      const res = await tx.apEquipmentLink.updateMany({
        where: { equipment_request_id: requestId },
        data: { equipment_id: created.row.id, equipment_request_id: null },
      });
      backfilledLinks = res.count;
    }

    await writeAudit(
      {
        actor_user_id: actor.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: requestId,
        before: { status: 'open' },
        after: {
          status: 'resolved',
          resolved_equipment_id: created.row.id,
          equipment_display_name: created.row.display_name,
          site_id: siteId,
          backfilled_links: backfilledLinks,
          ap_request_id: existing.ap_request_id,
          has_note: !!note,
        },
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
      { tx },
    );

    return {
      equipmentId: created.row.id,
      equipmentDisplayName: created.row.display_name,
      backfilledLinks,
    };
  });
}

// ────────────────────────────────────────────────────────────────────
// Reject (§2.5 — genuinely not equipment)
// ────────────────────────────────────────────────────────────────────

/**
 * Reject an OPEN request with a REQUIRED note.
 *
 * The originating link row is left pointing at this request ON PURPOSE. Clearing
 * it would leave the link with no disposition at all (CHECK violation), and
 * flipping it to `is_not_equipment_related` would silently rewrite what the
 * approver actually said. The rejected request, with its note, IS the record —
 * and the invoice stays approved either way.
 */
export async function rejectEquipmentRequest(
  prismaClient: PrismaClient = defaultPrisma,
  requestId: string,
  note: string,
  actor: ActorContext,
): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed)
    throw new ApEquipmentRequestError(
      'A rejection needs a note explaining why. Add one, then reject.',
    );

  const existing = await prismaClient.apEquipmentRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true },
  });
  if (!existing) throw new ApEquipmentRequestError('Equipment request not found.', 404);
  if (existing.status !== 'open')
    throw new ApEquipmentRequestError(`This request was already ${existing.status}.`, 409);

  await prismaClient.$transaction(async (tx) => {
    const res = await tx.apEquipmentRequest.updateMany({
      where: { id: requestId, status: 'open' },
      data: {
        status: 'rejected',
        resolved_by: actor.actorUserId,
        resolved_at: new Date(),
        resolution_note: trimmed.slice(0, EQUIPMENT_REQUEST_DESCRIPTION_MAX),
      },
    });
    if (res.count === 0)
      throw new ApEquipmentRequestError('This request was decided by someone else.', 409);
    await writeAudit(
      {
        actor_user_id: actor.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: requestId,
        before: { status: 'open' },
        after: { status: 'rejected', has_note: true },
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
      { tx },
    );
  });
}

// ────────────────────────────────────────────────────────────────────
// Recipients (§2.4)
// ────────────────────────────────────────────────────────────────────

export interface EquipmentRequestRecipients {
  /** Site managers who can actually resolve it — Morena (Woodland), Rick (Eugene). */
  to: { address: string; name: string }[];
  /** Bill, CC'd on both sites. */
  cc: string[];
}

/**
 * Who hears about a new request at a given site.
 *
 * Resolved from the `can_resolve_equipment_requests` grant scoped to the site,
 * NOT from a hardcoded address list and NOT from `role = 'manager'` at large.
 * Hardcoding breaks the day somebody changes jobs; "every manager" would put a
 * Eugene invoice in front of four people who cannot act on it. The grant is the
 * same set that can open the worklist, so the mail always reaches somebody who
 * can do the thing the mail asks for.
 *
 * `all_sites` managers are included for every site (ADR-0024 reach), which is
 * also why the query is a reach test rather than a `primary_site_id` equality.
 *
 * Admins ride as CC on both sites (Bill), and are the FALLBACK `to` when a site
 * has no granted manager — a request nobody is told about is the exact failure
 * mode ADR-0066 §B.5 was written about.
 */
export async function equipmentRequestRecipients(
  prisma: PrismaClient = defaultPrisma,
  siteId: string,
): Promise<EquipmentRequestRecipients> {
  const [managers, admins] = await Promise.all([
    prisma.user.findMany({
      where: {
        deleted_at: null,
        role: 'manager',
        can_resolve_equipment_requests: true,
        email: { not: null },
        OR: [{ primary_site_id: siteId }, { all_sites: true }],
      },
      select: { email: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.user.findMany({
      where: { deleted_at: null, role: 'admin', email: { not: null } },
      select: { email: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const to = managers
    .filter((m): m is { email: string; name: string } => !!m.email)
    .map((m) => ({ address: m.email, name: m.name }));
  const adminAddrs = admins.map((a) => a.email).filter((e): e is string => !!e);

  if (to.length === 0) {
    // No granted manager for this site. Send TO the admins rather than emitting a
    // successful-looking send to nobody.
    return { to: adminAddrs.map((address) => ({ address, name: 'DR3 Admin' })), cc: [] };
  }
  const toLower = new Set(to.map((t) => t.address.toLowerCase()));
  return { to, cc: adminAddrs.filter((a) => !toLower.has(a.toLowerCase())) };
}

function createFailureMessage(reason: string): string {
  switch (reason) {
    case 'name_taken':
      return 'An asset with that name already exists at this site. Open /admin/equipment, reactivate or rename it, then resolve this request against it.';
    case 'site_not_found':
      return 'That site no longer exists.';
    case 'name_required':
      return 'Enter a name for the asset.';
    case 'name_too_long':
      return `Name must be ${DISPLAY_NAME_MAX} characters or fewer.`;
    default:
      return 'Could not create the asset.';
  }
}
