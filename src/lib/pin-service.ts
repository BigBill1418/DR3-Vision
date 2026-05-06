import { prisma } from '@/lib/prisma';
import { hashPassword, verifyPassword } from '@/lib/argon';
import { validatePinPattern } from '@/lib/pin-validator';
import { writeAudit } from '@/lib/audit';

// PIN auth + lifecycle per ADR-0004 (refined by ADR-0012 §3 on
// loop-verify uniqueness). The hash column is intentionally NOT
// indexed (CLAUDE.md hard rule #8); every lookup is by user_id from
// the name-picker UI, never `WHERE pin_hash = ?` (PIN enumeration
// hardening).

const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX_FAILS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 min

export type PinVerifyResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'unknown' | 'no_pin' | 'wrong_pin' | 'locked'; locked_until?: Date };

export async function verifyPin(userId: string, pin: string): Promise<PinVerifyResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      is_active: true,
      pin_hash: true,
      pin_failed_attempts: true,
      pin_first_failed_at: true,
      pin_locked_until: true,
    },
  });
  if (!user || !user.is_active) return { ok: false, reason: 'unknown' };
  if (user.role !== 'operator') return { ok: false, reason: 'unknown' };
  if (!user.pin_hash) return { ok: false, reason: 'no_pin' };

  const now = new Date();
  if (user.pin_locked_until && user.pin_locked_until > now) {
    return { ok: false, reason: 'locked', locked_until: user.pin_locked_until };
  }

  const matched = await verifyPassword(user.pin_hash, pin);
  if (matched) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        pin_failed_attempts: 0,
        pin_first_failed_at: null,
        pin_locked_until: null,
        last_login_at: now,
      },
    });
    return { ok: true, userId: user.id };
  }

  // Failure path — sliding-window rate limit.
  let nextCount: number;
  let nextWindowStart: Date | null;
  const windowStart = user.pin_first_failed_at;
  const inWindow =
    windowStart && (now.getTime() - windowStart.getTime()) / 1000 <= RATE_LIMIT_WINDOW_S;
  if (inWindow) {
    nextCount = user.pin_failed_attempts + 1;
    nextWindowStart = windowStart;
  } else {
    nextCount = 1;
    nextWindowStart = now;
  }

  if (nextCount >= RATE_LIMIT_MAX_FAILS) {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        pin_failed_attempts: nextCount,
        pin_first_failed_at: nextWindowStart,
        pin_locked_until: lockedUntil,
      },
    });
    return { ok: false, reason: 'locked', locked_until: lockedUntil };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      pin_failed_attempts: nextCount,
      pin_first_failed_at: nextWindowStart,
    },
  });
  return { ok: false, reason: 'wrong_pin' };
}

export type SetPinResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_pattern' | 'collision_within_site' | 'unknown_target' };

// Loop-verify uniqueness within site (ADR-0012 §3). At most ~30 active
// operators per site × ~80ms Argon2id verify ≈ 2.5s — acceptable for
// admin-side PIN-set; keeps `pin_hash` un-indexed and un-lookup-able.
export async function setPin(args: {
  targetUserId: string;
  pin: string;
  actorUserId: string | null;
  actorLabel?: string | null;
}): Promise<SetPinResult> {
  const patternError = validatePinPattern(args.pin);
  if (patternError) return { ok: false, reason: 'invalid_pattern' };

  const target = await prisma.user.findUnique({
    where: { id: args.targetUserId },
    select: { id: true, primary_site_id: true, role: true },
  });
  if (!target || target.role !== 'operator' || !target.primary_site_id) {
    return { ok: false, reason: 'unknown_target' };
  }

  const peers = await prisma.user.findMany({
    where: {
      role: 'operator',
      is_active: true,
      primary_site_id: target.primary_site_id,
      pin_hash: { not: null },
      id: { not: target.id },
    },
    select: { id: true, pin_hash: true },
  });
  for (const peer of peers) {
    if (!peer.pin_hash) continue;
    const collides = await verifyPassword(peer.pin_hash, args.pin);
    if (collides) return { ok: false, reason: 'collision_within_site' };
  }

  const hash = await hashPassword(args.pin);
  await prisma.user.update({
    where: { id: target.id },
    data: {
      pin_hash: hash,
      pin_failed_attempts: 0,
      pin_first_failed_at: null,
      pin_locked_until: null,
    },
  });
  await writeAudit({
    actor_user_id: args.actorUserId,
    actor_label: args.actorLabel ?? null,
    action: 'update',
    table_name: 'users',
    row_id: target.id,
    after: { pin_hash: '<argon2id>', pin_set: true }, // never log the PIN itself
  });
  return { ok: true };
}
