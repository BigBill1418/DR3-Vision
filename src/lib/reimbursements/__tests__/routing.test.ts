// ADR-0068 D4/D6 — the reimbursement approval exclusions.
//
// These tests exist because of a specific, named, real-world control failure.
// Mary Scott reported that Janette was approving her own reimbursement
// submissions, and she was right: Vision had no concept of who ORIGINATED a
// request, so first-action-wins let the originator claim it. The stamp was
// manufacturing audit evidence for a review that never happened.
//
// So the headline assertions here are not "the function returns the right shape".
// They are: THE SUBMITTER CANNOT APPROVE, and THE BENEFICIARY CANNOT APPROVE —
// including the mirror-image case Bill's stated rule did not cover, where Morena
// submits a reimbursement *for* Janette and routing would otherwise send it
// straight to Janette.

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeDb } from '@/lib/ap/__testutils__/fake-prisma';
import {
  canApproveReimbursement,
  nameIsAmbiguousAgainst,
  nameMayReferTo,
  normalizeName,
  resolveReimbursementApproval,
} from '../routing';

const fp = (db: FakeDb) => makeFakePrisma(db) as unknown as PrismaClient;

const U = {
  janette: {
    id: 'u-jt',
    name: 'Janette Tomas',
    email: 'janette.tomas@svdp.us',
    role: 'manager' as const,
    all_sites: false,
    is_active: true,
  },
  morena: {
    id: 'u-mg',
    name: 'Morena Gomez',
    email: 'morena.gomez@svdp.us',
    role: 'manager' as const,
    all_sites: false,
    is_active: true,
  },
  rick: {
    id: 'u-ra',
    name: 'Rick Albritton',
    email: 'rick.albritton@svdp.us',
    role: 'manager' as const,
    all_sites: false,
    is_active: true,
  },
  shannon: {
    id: 'u-sr',
    name: 'Shannon Rockwell',
    email: 'shannon.rockwell@svdp.us',
    role: 'manager' as const,
    all_sites: false,
    is_active: true,
  },
  bill: {
    id: 'u-bb',
    name: 'Bill Barnard',
    email: 'bill.barnard@svdp.us',
    role: 'admin' as const,
    all_sites: true,
    is_active: true,
  },
};

const ROUTING = [
  {
    id: 'r1',
    first_approver_id: U.janette.id,
    second_approver_id: U.morena.id,
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
  {
    id: 'r2',
    first_approver_id: U.morena.id,
    second_approver_id: U.janette.id,
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
  {
    id: 'r3',
    first_approver_id: U.rick.id,
    second_approver_id: U.shannon.id,
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
];

function db(over: Partial<FakeDb> = {}): FakeDb {
  return newFakeDb({
    users: Object.values(U),
    approvalRouting: ROUTING,
    ...over,
  } as Partial<FakeDb>);
}

// ── D4 — the submitter can never approve ────────────────────────────────────

describe('D4 — the submitter can never approve their own submission', () => {
  it('EXCLUDES the submitter from the authorized set', async () => {
    // The exact case Mary reported: Janette submits, and must not be able to sign.
    const routed = await resolveReimbursementApproval(fp(db()), {
      submittedBy: U.janette.id,
      employeeNameFreeform: 'Floor Employee',
    });
    expect(routed.authorizedUserIds).not.toContain(U.janette.id);
    expect(routed.routedTo?.userId).toBe(U.morena.id);
  });

  it('REFUSES the submitter at the authorization gate', async () => {
    const ok = await canApproveReimbursement(fp(db()), U.janette.id, {
      submittedBy: U.janette.id,
      employeeNameFreeform: 'Floor Employee',
    });
    expect(ok).toBe(false);
  });

  it('refuses the submitter even when they are an ADMIN', async () => {
    // No `role === 'admin'` short-circuit here, unlike the AP path. The exclusion
    // is about the PERSON, not the privilege — that is the whole control.
    const ok = await canApproveReimbursement(fp(db()), U.bill.id, {
      submittedBy: U.bill.id,
      employeeNameFreeform: 'Floor Employee',
    });
    expect(ok).toBe(false);
  });

  it('ALLOWS the routed peer', async () => {
    const ok = await canApproveReimbursement(fp(db()), U.morena.id, {
      submittedBy: U.janette.id,
      employeeNameFreeform: 'Floor Employee',
    });
    expect(ok).toBe(true);
  });
});

// ── D6 — the beneficiary can never approve ──────────────────────────────────

describe('D6 — the beneficiary can never approve, even when routing points at them', () => {
  it('escalates IMMEDIATELY when the routed peer is the person being paid', async () => {
    // Mirror image of Mary's complaint, and the gap Bill's stated rule left open:
    // Morena submits FOR Janette, and plain person routing would send it to
    // Janette — the beneficiary.
    const routed = await resolveReimbursementApproval(fp(db()), {
      submittedBy: U.morena.id,
      employeeUserId: U.janette.id,
    });

    expect(routed.authorizedUserIds).not.toContain(U.janette.id);
    expect(routed.authorizedUserIds).not.toContain(U.morena.id);
    // No valid local approver exists, so waiting 24h accomplishes nothing.
    expect(routed.escalateImmediately).toBe(true);
    expect(routed.escalationReason).toBe('beneficiary_conflict');
    // It lands on the admin, and it lands on SOMEONE — never authorized-by-nobody.
    expect(routed.authorizedUserIds).toContain(U.bill.id);
    expect(routed.recipients.length).toBeGreaterThan(0);
  });

  it('REFUSES the beneficiary at the authorization gate', async () => {
    const ok = await canApproveReimbursement(fp(db()), U.janette.id, {
      submittedBy: U.morena.id,
      employeeUserId: U.janette.id,
    });
    expect(ok).toBe(false);
  });

  it('excludes a beneficiary matched by FREE-TEXT name', async () => {
    // Not everyone reimbursed has a Vision account, so the name path has to
    // enforce the same rule as the id path.
    const routed = await resolveReimbursementApproval(fp(db()), {
      submittedBy: U.morena.id,
      employeeNameFreeform: 'Janette Tomas',
    });
    expect(routed.authorizedUserIds).not.toContain(U.janette.id);
    expect(routed.escalateImmediately).toBe(true);
  });

  it('matches a free-text name that differs only by a middle name', async () => {
    const routed = await resolveReimbursementApproval(fp(db()), {
      submittedBy: U.morena.id,
      employeeNameFreeform: 'Janette M Tomas',
    });
    expect(routed.authorizedUserIds).not.toContain(U.janette.id);
  });

  it('FAILS SAFE on an ambiguous single-token name', async () => {
    // "Janette" alone is not proof of identity — and guessing wrong pays someone
    // against their own signature. Escalate rather than decide.
    const routed = await resolveReimbursementApproval(fp(db()), {
      submittedBy: U.morena.id,
      employeeNameFreeform: 'Janette',
    });
    expect(routed.authorizedUserIds).not.toContain(U.janette.id);
    expect(routed.escalateImmediately).toBe(true);
    expect(routed.problems.join(' ')).toMatch(/AMBIGUOUS/);
  });

  it('leaves the COMMON case alone — a floor employee is nobody in the roster', async () => {
    // Neither manager is the beneficiary, so this is a plain peer swap with no
    // escalation. If this test fails, the exclusion is over-firing and every
    // reimbursement would land on Bill.
    const routed = await resolveReimbursementApproval(fp(db()), {
      submittedBy: U.janette.id,
      employeeNameFreeform: 'Diego Ramirez',
    });
    expect(routed.routedTo?.userId).toBe(U.morena.id);
    expect(routed.escalateImmediately).toBe(false);
    expect(routed.escalationReason).toBeNull();
  });
});

// ── The invariant inherited from the AP outage ──────────────────────────────

describe('authorized-by-someone is never notifiable-by-nobody', () => {
  it('always produces a reachable recipient when anyone is authorized', async () => {
    for (const submitter of [U.janette, U.morena, U.rick, U.shannon, U.bill]) {
      const routed = await resolveReimbursementApproval(fp(db()), {
        submittedBy: submitter.id,
        employeeNameFreeform: 'Floor Employee',
      });
      if (routed.authorizedUserIds.length > 0) {
        expect(
          routed.recipients.length,
          `${submitter.name} produced an empty recipient set — this is the outage shape`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('says so LOUDLY when nobody at all can sign', async () => {
    // Bill submits a reimbursement for himself and is the only admin: there is
    // genuinely no eligible approver. That must be reported, not silent.
    const routed = await resolveReimbursementApproval(
      fp(newFakeDb({ users: [U.bill], approvalRouting: [] } as Partial<FakeDb>)),
      { submittedBy: U.bill.id, employeeUserId: U.bill.id },
    );
    expect(routed.authorizedUserIds).not.toContain(U.bill.id);
    expect(routed.problems.join(' ')).toMatch(/INVARIANT VIOLATED/);
  });
});

// ── Site reach (CLAUDE.md hard rule #2) ────────────────────────────────────

describe('person routing does not become cross-site reach', () => {
  it('refuses a single-site manager acting on the other site', async () => {
    const ok = await canApproveReimbursement(fp(db()), U.shannon.id, {
      submittedBy: U.rick.id,
      employeeNameFreeform: 'Floor Employee',
      requestSiteId: 'site-woodland',
    });
    // Shannon is Eugene with all_sites false; a Woodland reimbursement is not hers.
    expect(ok).toBe(false);
  });
});

// ── Name normalisation units ───────────────────────────────────────────────

describe('name comparison', () => {
  it('normalises case, punctuation and whitespace', () => {
    expect(normalizeName('  Janette   TOMAS! ')).toBe('janette tomas');
    expect(normalizeName("O'Brien-Smith")).toBe('o brien smith');
  });

  it('treats first+last agreement as a match and a lone token as not', () => {
    expect(nameMayReferTo('janette tomas', 'Janette Tomas')).toBe(true);
    expect(nameMayReferTo('Janette M. Tomas', 'Janette Tomas')).toBe(true);
    expect(nameMayReferTo('Janette', 'Janette Tomas')).toBe(false);
    expect(nameIsAmbiguousAgainst('Janette', 'Janette Tomas')).toBe(true);
    expect(nameIsAmbiguousAgainst('Diego', 'Janette Tomas')).toBe(false);
  });

  it('does not match two different people who share a first name', () => {
    expect(nameMayReferTo('Janette Ruiz', 'Janette Tomas')).toBe(false);
  });
});
