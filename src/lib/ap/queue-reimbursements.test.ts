// ADR-0068 Amendment 3 — reimbursements in the shared AP queue.
//
// The privacy question was raised BEFORE this was built, because the AP queue has
// no site filter: interleaving means an approver at one site can read a
// reimbursement filed at the other. Bill answered it directly on 2026-07-30 —
// reimbursements are work materials, tools and equipment only, never medical or
// otherwise sensitive — so the exposure is acceptable BY POLICY ABOUT CONTENT.
//
// These tests pin the two things that policy depends on:
//   1. the row is discriminated as a REIMBURSEMENT, so it can never be rendered
//      through the vendor-invoice panel (D7 — no vendor freeform, no confirmed
//      amount, no equipment multi-select, no baseline variance);
//   2. it deep-links OUT to the site surface, because the queue is where a
//      reimbursement is SEEN and not where it is DECIDED. Only one person can act
//      on any given one, and the authorisation that decides who lives there.

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { listReimbursementQueueRows } from './queue';

const ROWS = [
  {
    id: 'rb-1',
    amount_cents: 4250,
    submitted_at: new Date('2026-07-30T15:00:00.000Z'),
    purpose: 'replacement blade for the Woodland band saw',
    category: 'tools',
    escalated_at: null,
    employee_name_freeform: 'Diego Ramirez',
    employee_user: null,
    submitter: { name: 'Janette Tomas' },
    routed_to: { name: 'Morena Gomez' },
    site: { code: 'woodland', name: 'Woodland' },
  },
  {
    id: 'rb-2',
    amount_cents: 1900,
    submitted_at: new Date('2026-07-29T15:00:00.000Z'),
    purpose: 'shop rags',
    category: 'supplies',
    escalated_at: new Date('2026-07-30T15:00:00.000Z'),
    employee_name_freeform: null,
    employee_user: { name: 'Rick Albritton' },
    submitter: { name: 'Shannon Rockwell' },
    routed_to: { name: 'Bill Barnard' },
    site: { code: 'eugene', name: 'Eugene' },
  },
];

function fake(rows: typeof ROWS = ROWS): PrismaClient {
  return {
    reimbursementRequest: {
      async findMany() {
        return rows;
      },
    },
  } as unknown as PrismaClient;
}

describe('listReimbursementQueueRows', () => {
  it('discriminates every row as a reimbursement, never an invoice', async () => {
    const rows = await listReimbursementQueueRows(fake());
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.kind).toBe('reimbursement');
      expect(r.reimbursement).not.toBeNull();
      // No vendor, because an insider is being repaid — there is no counterparty.
      expect(r.vendor).toBeNull();
    }
  });

  it('links OUT to the site surface where the decision is authorised', async () => {
    const rows = await listReimbursementQueueRows(fake());
    expect(rows[0]?.reimbursement?.url).toBe('/dashboard/woodland/reimbursements');
    expect(rows[1]?.reimbursement?.url).toBe('/dashboard/eugene/reimbursements');
  });

  it('names the submitter rather than inventing a sender address', async () => {
    // A reimbursement was FILED by an authenticated manager, not forwarded from a
    // mailbox. Claiming a sender address would be a fabrication.
    const rows = await listReimbursementQueueRows(fake());
    expect(rows[0]?.senderAddress).toBe('filed by Janette Tomas');
    // Authenticated submission is the strongest provenance in this queue, so the
    // row is not flagged "external".
    expect(rows[0]?.senderValidated).toBe(true);
  });

  it('carries who it is waiting on, and flags an escalation', async () => {
    const rows = await listReimbursementQueueRows(fake());
    expect(rows[0]?.reimbursement?.routedToName).toBe('Morena Gomez');
    expect(rows[0]?.reimbursement?.escalated).toBe(false);
    expect(rows[1]?.reimbursement?.escalated).toBe(true);
  });

  it('resolves the beneficiary from the roster OR the free-text name', async () => {
    const rows = await listReimbursementQueueRows(fake());
    expect(rows[0]?.reimbursement?.beneficiary).toBe('Diego Ramirez');
    expect(rows[1]?.reimbursement?.beneficiary).toBe('Rick Albritton');
    expect(rows[0]?.subject).toContain('Diego Ramirez');
  });

  it('always reports exactly one attachment — the receipt is REQUIRED', async () => {
    const rows = await listReimbursementQueueRows(fake());
    for (const r of rows) expect(r.attachmentCount).toBe(1);
  });

  it('reports every row as pending_second_approval', async () => {
    // The one status the two objects genuinely share. Anything else would mean
    // something different for a reimbursement than for an invoice.
    const rows = await listReimbursementQueueRows(fake());
    for (const r of rows) expect(r.status).toBe('pending_second_approval');
  });

  it('returns an empty list when nothing is pending, without throwing', async () => {
    expect(await listReimbursementQueueRows(fake([]))).toEqual([]);
  });
});
