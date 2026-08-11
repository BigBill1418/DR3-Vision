// ADR-0028 — Resolve the expected approver for a bonus amendment request.
//
// The approver matrix is sourced from `bonus_signature_chains` (per-site row).
// The requester is matched to a slot (facility OR ops) at their site; the OTHER
// slot's signer is the approver. Carve-outs:
//   - Any manager who occupies NEITHER slot at their site is blocked — the
//     workflow is not available to them. This is emergent from chain membership,
//     not an allowlist: there is no per-person branch anywhere in this file.
//   - The Director (admin) bypasses the workflow entirely; this function is
//     never called for admin actors.
//
// HISTORICAL NOTE (2026-08-11): this file used to name Patrick Dills as the
// blocked party, because at the time he was the one Eugene manager outside the
// chain. That is no longer true — Patrick now HOLDS the Eugene ops slot (Bill
// instruction, replacing Shannon Rockwell who covered for Kelsey Ruhland), so
// he is a first-class approver and Rick Albritton is his counterpart. Nothing
// in the code changed to make that so; repointing the chain row was sufficient.
// The `patrick_or_other_non_chain_manager` reason string below is now a
// misnomer, but it is part of the HTTP contract (returned as the `error` field
// by /api/bonus/amendments), so renaming it is a breaking change and is
// deliberately deferred rather than done as a drive-by.
//
// Standing conflict to be aware of: Patrick is also a Eugene BonusEmployee, so
// he can now be the default approver for amendments to entries that include his
// own historical bonus rows. The DB CHECK only prevents requester == approver.
// Bill accepted this trade-off explicitly; see ADR-0028.

import { getSignatureChain } from '@/lib/bonus/signature-chain';
import type { PrismaClient } from '@prisma/client';

export class AmendmentWorkflowForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(
    public readonly forbiddenReason:
      | 'patrick_or_other_non_chain_manager'
      | 'admin_uses_direct_path',
  ) {
    super(`amendment workflow forbidden: ${forbiddenReason}`);
    this.name = 'AmendmentWorkflowForbiddenError';
  }
}

export interface ResolvedApprover {
  /** Default counterpart approver, resolved from the signature chain. */
  expectedApproverUserId: string;
  /** Admin auto-override actor (Bill) — always Bill-ping eligible. */
  pingBillUserId: string;
}

/**
 * Resolve the default expected approver for an amendment request from
 * `requesterUserId` at `siteId`. Throws AmendmentWorkflowForbiddenError when
 * the requester is structurally outside the workflow — i.e. any user who is
 * neither the facility nor the ops signer at that site.
 */
export async function resolveAmendmentApprover(
  db: PrismaClient,
  siteId: string,
  requesterUserId: string,
): Promise<ResolvedApprover> {
  const chain = await getSignatureChain(siteId, db);

  if (
    requesterUserId !== chain.facility_signer_user_id &&
    requesterUserId !== chain.ops_signer_user_id
  ) {
    throw new AmendmentWorkflowForbiddenError('patrick_or_other_non_chain_manager');
  }

  const counterpartUserId =
    requesterUserId === chain.facility_signer_user_id
      ? chain.ops_signer_user_id
      : chain.facility_signer_user_id;

  return {
    expectedApproverUserId: counterpartUserId,
    pingBillUserId: chain.auto_override_actor_user_id,
  };
}

export interface ApprovalEligibilityInput {
  actorUserId: string;
  request: {
    requested_by_user_id: string;
    expected_approver_user_id: string;
    bill_pinged_at: Date | null;
  };
  chain: { auto_override_actor_user_id: string };
  actorIsAdmin: boolean;
}

/**
 * Returns true iff `actorUserId` is eligible to approve `request`.
 *
 * Eligible:
 *   - the expected approver (counterpart slot) — always
 *   - the admin auto-override actor (Bill) when bill_pinged_at IS NOT NULL,
 *     OR when actor is admin (admin always eligible — Q1 escape valve)
 *
 * Never eligible:
 *   - the requester (DB CHECK + this app-layer mirror)
 */
export function canApproveRequest(input: ApprovalEligibilityInput): boolean {
  const { actorUserId, request, chain, actorIsAdmin } = input;

  if (actorUserId === request.requested_by_user_id) return false;
  if (actorUserId === request.expected_approver_user_id) return true;
  if (actorIsAdmin) return true;
  if (actorUserId === chain.auto_override_actor_user_id && request.bill_pinged_at !== null) {
    return true;
  }
  return false;
}
