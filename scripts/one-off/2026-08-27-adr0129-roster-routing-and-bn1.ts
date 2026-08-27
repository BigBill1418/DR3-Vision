// ADR-0129 — the 2026-08-27 digest triage, executed as data.
//
// Bill's directives (session of 2026-08-27, morning digest lines):
//
//   1. DAVEN STETSON IS NOT AN AP APPROVER. His ap_approvers row is EXPIRED
//      (active_until = now — the Kelsey pattern; the daily expiry job deletes
//      it with its own audit trail). His user account is untouched.
//   2. PATRICK DILLS IS an approver, peer ROUTED TO RICK ALBRITTON. He was
//      never on the ADR-0046 roster at all (the digest named him only because
//      W1 enumerated roles — fixed as ADR-0129 D2), so this adds the roster
//      row AND the routing pair, in that order.
//   3. THE FOUR UNMAILED DECISIONS WERE FILED BY HAND BY MARY. Bill confirmed
//      accounting already has them; re-sending would duplicate her filing.
//      Each gets the ADR-0129 D1 out-of-band stamp — decision_mail_sent_at
//      stays NULL forever on these rows, truthfully: no machine mail was ever
//      confirmed sent.
//
// RUN: npx tsx scripts/one-off/2026-08-27-adr0129-roster-routing-and-bn1.ts [--apply]
// (DATABASE_URL exported to the production DB; dry run without --apply.)
//
// Idempotent by construction: every leg checks current state and skips work
// already done, so a re-run after a partial failure completes the remainder.

import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { saveRoutingRow } from '@/lib/ap/admin-config';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

const DAVEN_EMAIL = 'daven.stetson@svdp.us';
const PATRICK_EMAIL = 'patrick.dills@svdp.us';
const RICK_EMAIL = 'rick.albritton@svdp.us';
const BILL_EMAIL = 'bill.barnard@svdp.us';

// The four BN-1 requests, pinned by id from the 0.BN register table so a
// status drift between then and now cannot re-target the stamp.
const BN1_PREFIXES = ['1ee8e502', 'ffa0b0d6', 'eec29987', '74daa199'];
const BN1_NOTE =
  'Filed with accounting by hand (Mary); confirmed by Bill 2026-08-27. ' +
  'ADR-0129 D1 — no machine mail was sent and none is owed.';

async function userByEmail(email: string) {
  const u = await prisma.user.findFirst({
    where: { email, deleted_at: null },
    select: { id: true, name: true, is_active: true },
  });
  if (!u) throw new Error(`no user for ${email}`);
  return u;
}

async function main() {
  console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN (no writes) ===');
  const [daven, patrick, rick, bill] = await Promise.all([
    userByEmail(DAVEN_EMAIL),
    userByEmail(PATRICK_EMAIL),
    userByEmail(RICK_EMAIL),
    userByEmail(BILL_EMAIL),
  ]);
  const now = new Date();
  const actor = { actorUserId: bill.id, ip: null, userAgent: 'one-off/adr0129' };

  // ── Leg 1: expire Daven's roster row ──────────────────────────────────────
  const davenRow = await prisma.apApprover.findUnique({ where: { user_id: daven.id } });
  if (!davenRow) {
    console.log('[leg 1] Daven has no ap_approvers row — nothing to expire.');
  } else if (davenRow.active_until && davenRow.active_until <= now) {
    console.log('[leg 1] Daven already expired — skipping.');
  } else {
    console.log(`[leg 1] expire Daven roster row ${davenRow.id} (active_until → now)`);
    if (APPLY) {
      await prisma.$transaction(async (tx) => {
        await tx.auditLog.create({
          data: {
            actor_user_id: bill.id,
            action: 'update',
            table_name: 'ap_approvers',
            row_id: davenRow.id,
            before: {
              user_id: daven.id,
              active_until: davenRow.active_until?.toISOString() ?? null,
            },
            after: { user_id: daven.id, active_until: now.toISOString() },
            ip: null,
            user_agent: 'one-off/adr0129',
          },
        });
        await tx.apApprover.update({
          where: { id: davenRow.id },
          data: { active_until: now },
        });
      });
      console.log('[leg 1] done — the daily expiry job deletes the row with its own audit.');
    }
  }

  // ── Leg 2: put Patrick on the roster ──────────────────────────────────────
  const patrickRow = await prisma.apApprover.findUnique({ where: { user_id: patrick.id } });
  if (patrickRow && (patrickRow.active_until === null || patrickRow.active_until > now)) {
    console.log('[leg 2] Patrick already on the active roster — skipping.');
  } else {
    console.log('[leg 2] add Patrick to ap_approvers (permanent).');
    if (APPLY) {
      await prisma.$transaction(async (tx) => {
        const id = patrickRow?.id ?? randomUUID();
        if (patrickRow) {
          await tx.apApprover.update({ where: { id }, data: { active_until: null } });
        } else {
          await tx.apApprover.create({
            data: { id, user_id: patrick.id, active_until: null, created_by: bill.id },
          });
        }
        await tx.auditLog.create({
          data: {
            actor_user_id: bill.id,
            action: patrickRow ? 'update' : 'insert',
            table_name: 'ap_approvers',
            row_id: id,
            before: patrickRow
              ? {
                  user_id: patrick.id,
                  active_until: patrickRow.active_until?.toISOString() ?? null,
                }
              : Prisma.JsonNull,
            after: { user_id: patrick.id, active_until: null },
            ip: null,
            user_agent: 'one-off/adr0129',
          },
        });
      });
      console.log('[leg 2] done.');
    }
  }

  // ── Leg 3: routing pair Patrick → Rick ────────────────────────────────────
  const existing = await prisma.apApprovalRouting.findUnique({
    where: { first_approver_id: patrick.id },
  });
  if (existing?.active && existing.second_approver_id === rick.id) {
    console.log('[leg 3] routing Patrick → Rick already in place — skipping.');
  } else {
    console.log(`[leg 3] saveRoutingRow: Patrick → Rick (fallback none, 24h default).`);
    if (APPLY) {
      const res = await saveRoutingRow(
        {
          first_approver_id: patrick.id,
          second_approver_id: rick.id,
          fallback_approver_id: null,
          fallback_after_hours: 24,
          active: true,
        },
        actor,
      );
      if (!res.ok) throw new Error(`saveRoutingRow refused: ${res.reason}`);
      console.log(`[leg 3] done — row ${res.id} (audited by saveRoutingRow).`);
    }
  }

  // ── Leg 4: stamp the four BN-1 decisions filed-out-of-band ────────────────
  for (const prefix of BN1_PREFIXES) {
    const row = await prisma.apRequest.findFirst({
      where: { id: { startsWith: prefix } },
      select: {
        id: true,
        status: true,
        vendor: true,
        amount_cents: true,
        decision_mail_sent_at: true,
        decision_mail_filed_out_of_band_at: true,
      },
    });
    if (!row) throw new Error(`[leg 4] no ap_request with id prefix ${prefix} — refusing to guess`);
    if (row.decision_mail_sent_at) {
      console.log(`[leg 4] ${prefix}… was machine-mailed since the register — skipping.`);
      continue;
    }
    if (row.decision_mail_filed_out_of_band_at) {
      console.log(`[leg 4] ${prefix}… already stamped out-of-band — skipping.`);
      continue;
    }
    console.log(
      `[leg 4] stamp ${row.id} (${row.status}, ${row.vendor ?? '—'}, ` +
        `${row.amount_cents != null ? `$${(row.amount_cents / 100).toFixed(2)}` : '—'})`,
    );
    if (APPLY) {
      await prisma.$transaction(async (tx) => {
        await tx.auditLog.create({
          data: {
            actor_user_id: bill.id,
            action: 'update',
            table_name: 'ap_requests',
            row_id: row.id,
            before: { decision_mail_filed_out_of_band_at: null },
            after: {
              decision_mail_filed_out_of_band_at: now.toISOString(),
              decision_mail_filed_out_of_band_by: bill.id,
              decision_mail_filed_out_of_band_note: BN1_NOTE,
            },
            ip: null,
            user_agent: 'one-off/adr0129',
          },
        });
        await tx.apRequest.update({
          where: { id: row.id },
          data: {
            decision_mail_filed_out_of_band_at: now,
            decision_mail_filed_out_of_band_by: bill.id,
            decision_mail_filed_out_of_band_note: BN1_NOTE,
          },
        });
      });
    }
  }
  console.log(APPLY ? '=== APPLY complete ===' : '=== DRY RUN complete — re-run with --apply ===');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
