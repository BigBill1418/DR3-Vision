// ADR-0046 C3/C9-D2/C10.4 — sender validation on the AUTHENTICATED envelope sender.
//
// Two modes (data, admin-toggle — never a code change):
//   tenant_wide  (default): any internal `@svdp.us` sender is approvable.
//   explicit_list         : only addresses in ap_sender_entries (active) are.
// The quarantine ring therefore covers external senders + unprocessable messages.
//
// C10.4 nuance: for a FORWARD the auth subject is the internal forwarder (the
// envelope `from`); the original vendor address inside the body is display
// context only and is NEVER passed here.

import type { PrismaClient } from '@prisma/client';

export type SenderMode = 'tenant_wide' | 'explicit_list';

export type QuarantineReason = 'external_sender' | 'not_in_explicit_list' | 'unprocessable' | 'attachment_parse_failure';

export interface SenderPolicy {
  mode: SenderMode;
  internalDomain: string; // e.g. 'svdp.us'
  explicitAllow: ReadonlySet<string>; // lowercased addresses, active entries
}

export interface SenderVerdict {
  valid: boolean;
  reason?: QuarantineReason;
}

/** The lowercased domain part of an address, or '' when malformed. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).trim().toLowerCase();
}

export function isInternal(address: string, internalDomain: string): boolean {
  return domainOf(address) === internalDomain.trim().toLowerCase();
}

/**
 * Pure sender verdict. tenant_wide: internal ⇒ valid, external ⇒ quarantine.
 * explicit_list: membership in the (active) allowlist ⇒ valid, else quarantine.
 */
export function validateSender(address: string, policy: SenderPolicy): SenderVerdict {
  const addr = address.trim().toLowerCase();
  if (policy.mode === 'explicit_list') {
    return policy.explicitAllow.has(addr) ? { valid: true } : { valid: false, reason: 'not_in_explicit_list' };
  }
  return isInternal(addr, policy.internalDomain) ? { valid: true } : { valid: false, reason: 'external_sender' };
}

/** The internal tenant domain (env override, default svdp.us). */
export function internalDomain(): string {
  return process.env['MSGRAPH_MAIL_INTERNAL_DOMAIN']?.trim().toLowerCase() || 'svdp.us';
}

/**
 * Resolve the live sender policy from the DB (singleton config + active entries).
 * A missing config row means the default tenant_wide mode (never a code change to
 * tighten — an admin creates/flips the row).
 */
export async function resolveSenderPolicy(prisma: PrismaClient): Promise<SenderPolicy> {
  const [config, entries] = await Promise.all([
    prisma.apSenderConfig.findUnique({ where: { id: 'singleton' }, select: { mode: true } }),
    prisma.apSenderEntry.findMany({ where: { active: true }, select: { address: true } }),
  ]);
  return {
    mode: (config?.mode ?? 'tenant_wide') as SenderMode,
    internalDomain: internalDomain(),
    explicitAllow: new Set(entries.map((e) => e.address.trim().toLowerCase())),
  };
}
