import {
  Prisma,
  type CountMode,
  type ConcernCategory,
  type LoadStatus,
  type PhotoKind,
  type RejectionCategory,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';

// State-machine moves for the inbound-load workflow per
// SPRINT-1-PLAN T-006 + ADR-0012 §1 (timer starts on door-open). All
// transitions are guarded server-side: the UI enforces order, but a
// hand-crafted POST cannot skip ahead. Forced-photo gates land in the
// stage transitions that require a `LoadPhoto` row.
//
// Photo storage_key is intentionally a placeholder for T-006
// ("pending-r2-…"). T-007 retrofits the real R2 upload + replaces
// these keys; the audit + UI surfaces remain unchanged.

const ALLOWED_PRIOR: Record<LoadStatus, LoadStatus[]> = {
  expected: [],
  arrived: ['expected'],
  weight_captured: ['arrived'],
  unload_started: ['arrived', 'weight_captured'],
  in_progress: ['unload_started'],
  finished: ['in_progress'],
  submitted: ['finished'],
  verified: ['submitted'],
  rejected: ['arrived', 'weight_captured', 'unload_started'],
  submitted_to_mymrc: ['verified'],
  processed: ['submitted_to_mymrc'],
};

class TransitionError extends Error {
  constructor(
    public from: LoadStatus,
    public to: LoadStatus,
  ) {
    super(`illegal transition ${from} → ${to}`);
  }
}

async function assertOwn(args: { loadId: string; operatorUserId: string; siteId: string }) {
  const load = await prisma.inboundLoad.findUnique({
    where: { id: args.loadId },
    select: {
      id: true,
      site_id: true,
      assigned_operator_id: true,
      status: true,
      arrived_at: true,
      unload_started_at: true,
    },
  });
  if (!load) throw new Error('load not found');
  if (load.site_id !== args.siteId) throw new Error('load not at this site');
  if (load.assigned_operator_id !== args.operatorUserId) {
    throw new Error('load not assigned to this operator');
  }
  return load;
}

function placeholderStorageKey(kind: PhotoKind): string {
  // T-007 swaps this for the real R2 object key. Until then we emit
  // a deterministic-looking key that's obvious to any reader as
  // "the upload didn't happen yet."
  return `pending-r2-${kind}-${crypto.randomUUID()}`;
}

export async function startInboundLoad(args: {
  expectedLoadId: string;
  siteId: string;
  operatorUserId: string;
}): Promise<{ id: string }> {
  const expected = await prisma.expectedLoad.findUnique({
    where: { id: args.expectedLoadId },
    select: {
      id: true,
      site_id: true,
      cancelled_at: true,
      source_id: true,
      transporter_id: true,
      bol_number: true,
      inbound_load: { select: { id: true } },
    },
  });
  if (!expected) throw new Error('expected load not found');
  if (expected.site_id !== args.siteId) throw new Error('expected load not at this site');
  if (expected.cancelled_at) throw new Error('expected load was cancelled');
  if (expected.inbound_load) {
    // Idempotent — if the operator taps twice, return the existing
    // in-progress load rather than minting a duplicate.
    return { id: expected.inbound_load.id };
  }

  const created = await prisma.inboundLoad.create({
    data: {
      site_id: args.siteId,
      expected_load_id: expected.id,
      status: 'arrived',
      arrived_at: new Date(),
      assigned_operator_id: args.operatorUserId,
      assigned_at: new Date(),
      source_id: expected.source_id,
      transporter_id: expected.transporter_id,
      bol_number: expected.bol_number,
    },
    select: { id: true },
  });
  await writeAudit({
    actor_user_id: args.operatorUserId,
    action: 'insert',
    table_name: 'inbound_loads',
    row_id: created.id,
    after: { status: 'arrived', expected_load_id: expected.id },
  });
  return created;
}

async function transition(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  to: LoadStatus;
  data?: Prisma.InboundLoadUpdateInput;
}): Promise<void> {
  const current = await assertOwn({
    loadId: args.loadId,
    operatorUserId: args.operatorUserId,
    siteId: args.siteId,
  });
  const allowed = ALLOWED_PRIOR[args.to];
  if (!allowed.includes(current.status)) throw new TransitionError(current.status, args.to);
  await prisma.inboundLoad.update({
    where: { id: args.loadId },
    data: { ...args.data, status: args.to },
  });
  await writeAudit({
    actor_user_id: args.operatorUserId,
    action: 'update',
    table_name: 'inbound_loads',
    row_id: args.loadId,
    before: { status: current.status },
    after: { status: args.to },
  });
}

async function attachPhoto(loadId: string, kind: PhotoKind): Promise<void> {
  await prisma.loadPhoto.create({
    data: {
      load_id: loadId,
      kind,
      storage_key: placeholderStorageKey(kind),
      captured_at: new Date(),
    },
  });
}

export async function recordBolCapture(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  // BOL is captured during the `arrived` stage; the row is already
  // there from `startInboundLoad`. Only side effect is the photo row.
  await assertOwn(args);
  await attachPhoto(args.loadId, 'bol');
}

export async function recordWeightSkip(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  // Operator chose "no weight ticket" — no DB change needed; the
  // weight stage gates only on the user's choice, not on a status
  // transition. The next door-open transition jumps straight from
  // `arrived` → `unload_started`.
  await assertOwn(args);
}

export async function recordWeightCapture(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  weightLbs: number;
}): Promise<void> {
  if (!Number.isInteger(args.weightLbs) || args.weightLbs < 1 || args.weightLbs > 100_000) {
    throw new Error('weight out of range (1 .. 100,000 lbs)');
  }
  await transition({
    ...args,
    to: 'weight_captured',
    data: { weight_lbs: args.weightLbs, weight_captured_at: new Date() },
  });
  await attachPhoto(args.loadId, 'weight_ticket');
}

export async function recordDoorOpenCapture(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  const current = await assertOwn(args);
  const now = new Date();
  const arrivedAt = current.arrived_at ?? now;
  const timeToUnloadStart = Math.max(0, Math.round((now.getTime() - arrivedAt.getTime()) / 1000));
  await transition({
    ...args,
    to: 'unload_started',
    data: {
      unload_started_at: now,
      time_to_unload_start_seconds: timeToUnloadStart,
    },
  });
  await attachPhoto(args.loadId, 'door_open');
}

export async function beginUnload(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  await transition({ ...args, to: 'in_progress' });
}

export async function addStack(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  stackIndex: number;
  unitCount: number;
  countMode: CountMode;
}): Promise<void> {
  if (!Number.isInteger(args.unitCount) || args.unitCount < 1) {
    throw new Error('stack unit count must be ≥ 1');
  }
  await assertOwn(args);
  await prisma.loadStack.create({
    data: {
      load_id: args.loadId,
      stack_index: args.stackIndex,
      unit_count: args.unitCount,
      count_mode: args.countMode,
    },
  });
}

export async function finishUnload(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  countMode: CountMode;
}): Promise<void> {
  const current = await assertOwn(args);
  const now = new Date();
  const startedAt = current.unload_started_at ?? now;
  const duration = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
  const stacks = await prisma.loadStack.findMany({
    where: { load_id: args.loadId },
    select: { unit_count: true },
  });
  const totalUnits = stacks.reduce((acc, s) => acc + s.unit_count, 0);
  await transition({
    ...args,
    to: 'finished',
    data: {
      unload_finished_at: now,
      unload_duration_seconds: duration,
      total_units: totalUnits,
      count_mode: args.countMode,
    },
  });
}

export async function addConcern(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  category: ConcernCategory;
  note: string | null;
}): Promise<void> {
  await assertOwn(args);
  await prisma.loadConcern.create({
    data: {
      load_id: args.loadId,
      category: args.category,
      note: args.note,
      raised_by_user_id: args.operatorUserId,
    },
  });
}

export async function submitLoad(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  await transition({
    ...args,
    to: 'submitted',
    data: {
      submitted_at: new Date(),
      submitted_by: { connect: { id: args.operatorUserId } },
    },
  });
}

export async function rejectLoad(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  category: RejectionCategory;
  note: string | null;
}): Promise<void> {
  await transition({
    ...args,
    to: 'rejected',
    data: {
      rejection_category: args.category,
      rejection_note: args.note,
      submitted_at: new Date(),
      submitted_by: { connect: { id: args.operatorUserId } },
    },
  });
  await attachPhoto(args.loadId, 'rejection');
}
