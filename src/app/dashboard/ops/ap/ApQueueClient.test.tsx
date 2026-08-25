// @vitest-environment jsdom
//
// ADR-0046 Amendment 5 (D-M5-1/4/6) — the STRUCTURED Approve panel: a real-site
// Approve gates on four fields (vendor, confirmed amount, explanation, equipment
// choice); Reject / Hold keep their single note field. Interaction test over the
// DetailPanel. `fetch` is stubbed to an empty/failed response so the equipment +
// variance effects degrade cleanly (no network); the gating logic under test is
// purely client-side.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApQueueClient, DetailPanel } from './ApQueueClient';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function pendingDetail(): React.ComponentProps<typeof DetailPanel>['detail'] {
  return {
    id: 'req-1',
    status: 'pending',
    subject: 'Invoice #4471',
    senderAddress: 'morena@svdp.us',
    senderValidated: true,
    receivedAt: '2026-07-21T18:30:00.000Z',
    vendor: null,
    amountCents: null,
    attachmentCount: 0,
    followupCount: 0,
    conversationId: null,
    bodyHtmlSanitized: null,
    bodyText: 'Please pay this invoice.',
    quarantineReason: null,
    decidedByName: null,
    decidedAt: null,
    decisionNote: null,
    decisionMailSentAt: null,
    heldByName: null,
    heldAt: null,
    holdNote: null,
    extraction: null,
    vendorFreeform: null,
    explanation: null,
    confirmedAmountCents: null,
    varianceFlagState: null,
    varianceAcknowledgmentNote: null,
    equipmentLinks: [],
    firstApproverName: null,
    firstApprovedAt: null,
    secondApproverName: null,
    secondApprovedAt: null,
    secondApproverNote: null,
    secondApproval: null,
    attachments: [],
    followups: [],
  };
}

const approveBtn = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
const rejectBtn = () => screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
const locationSelect = () => screen.getByRole('combobox') as HTMLSelectElement;
const noteField = () => screen.getByPlaceholderText(/reason to reject or hold/i);

function selectSite(code: string) {
  fireEvent.change(locationSelect(), { target: { value: code } });
}

describe('DetailPanel — structured Approve gating (Amendment 5)', () => {
  it('hides the structured fields until a real site is selected', () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    expect(screen.queryByRole('textbox', { name: /enter the vendor name carefully/i })).toBeNull();
    selectSite('woodland');
    expect(screen.getByRole('textbox', { name: /enter the vendor name carefully/i })).toBeTruthy();
  });

  it('keeps Approve disabled until all four structured fields are complete', () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    expect(approveBtn().disabled).toBe(true); // no site

    selectSite('woodland');
    expect(approveBtn().disabled).toBe(true); // real site, nothing filled

    fireEvent.change(screen.getByRole('textbox', { name: /enter the vendor name carefully/i }), {
      target: { value: 'Sunbelt Rentals' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /confirmed amount usd/i }), {
      target: { value: '125.00' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /what was this transaction for/i }), {
      target: { value: 'mower rental' },
    });
    expect(approveBtn().disabled).toBe(true); // still missing the equipment choice

    fireEvent.click(screen.getByRole('checkbox', { name: /not equipment-related/i }));
    expect(approveBtn().disabled).toBe(false); // all four satisfied
  });

  it('Reject gates on the single note field, independent of the structured fields', () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    selectSite('woodland');
    expect(rejectBtn().disabled).toBe(true);
    fireEvent.change(noteField(), { target: { value: 'duplicate invoice' } });
    expect(rejectBtn().disabled).toBe(false);
    // A rejection reason does NOT satisfy the structured Approve gate.
    expect(approveBtn().disabled).toBe(true);
  });

  it('NOT-DR3 uses the single note field (no structured fields shown)', () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    selectSite('not_dr3');
    expect(screen.queryByRole('textbox', { name: /enter the vendor name carefully/i })).toBeNull();
    // Approve on NOT-DR3 gates on the note.
    expect(approveBtn().disabled).toBe(true);
    fireEvent.change(noteField(), { target: { value: 'parent-org bill, not DR3' } });
    expect(approveBtn().disabled).toBe(false);
  });
});

// ── ADR-0126 D6 — the delivery failure is visible on the ROW ────────────────
//
// It used to live only inside the detail pane, so finding a decided-but-unmailed
// request meant opening every decided request one at a time. Two rejections went
// unnoticed for weeks because nobody does that.

describe('ApQueueClient — mail-not-sent badge (ADR-0126 D6)', () => {
  function listResponse(rows: unknown[], unsentCount: number) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        rows,
        counts: { pending: 0, decision_mail_unsent: unsentCount },
        filter: 'all',
      }),
    };
  }
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'req-1',
      kind: 'invoice',
      status: 'rejected',
      subject: 'Invoice #4471',
      senderAddress: 'morena@svdp.us',
      senderValidated: true,
      receivedAt: '2026-08-19T18:30:00.000Z',
      vendor: null,
      amountCents: null,
      attachmentCount: 0,
      followupCount: 0,
      heldByName: null,
      holdNote: null,
      reimbursement: null,
      ...over,
    };
  }

  it('renders the badge on a decided row with no confirmed decision email', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        listResponse([row({ decisionMailUnsent: true })], 1),
      ) as unknown as typeof fetch,
    );
    render(<ApQueueClient />);
    expect(await screen.findByTestId('ap-queue-mail-unsent-badge')).toBeTruthy();
  });

  it('renders NO badge when the mail was confirmed sent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        listResponse([row({ decisionMailUnsent: false })], 0),
      ) as unknown as typeof fetch,
    );
    render(<ApQueueClient />);
    await screen.findByText('Invoice #4471');
    expect(screen.queryByTestId('ap-queue-mail-unsent-badge')).toBeNull();
  });

  it('renders no badge for a payload from an older deploy (field absent)', async () => {
    // Forward-compat: the field is optional, so a stale client/server pairing
    // degrades to "no badge" rather than throwing the whole queue away.
    vi.stubGlobal('fetch', vi.fn(async () => listResponse([row()], 0)) as unknown as typeof fetch);
    render(<ApQueueClient />);
    await screen.findByText('Invoice #4471');
    expect(screen.queryByTestId('ap-queue-mail-unsent-badge')).toBeNull();
  });

  it('shows the filter tab ONLY when something is actually stuck', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        listResponse([row({ decisionMailUnsent: true })], 1),
      ) as unknown as typeof fetch,
    );
    render(<ApQueueClient />);
    // EXACT name, not a substring: the row button now contains the badge text
    // too, so /mail not sent/i matches both the tab and the row and throws.
    expect(await screen.findByRole('button', { name: 'mail not sent (1)' })).toBeTruthy();
  });

  it('HIDES the filter tab at zero — a permanent zero-state tab trains the eye to skip it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        listResponse([row({ decisionMailUnsent: false })], 0),
      ) as unknown as typeof fetch,
    );
    render(<ApQueueClient />);
    await screen.findByText('Invoice #4471');
    expect(screen.queryByRole('button', { name: 'mail not sent (0)' })).toBeNull();
  });
});
