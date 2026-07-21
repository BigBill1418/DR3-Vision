// @vitest-environment jsdom
//
// ADR-0046 2026-07-21 amendment — the approver panel must GATE approval on a note:
// Approve is disabled until a non-empty note is entered (mirroring how Reject
// already gates). Interaction test over the DetailPanel, no network round-trip.

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DetailPanel } from './ApQueueClient';

afterEach(cleanup);

// Build a minimal PENDING detail. The return type is pulled from the component's
// own prop type so the object stays in lockstep with the interface without
// exporting it, and its literal fields (e.g. status) are contextually checked.
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
    attachments: [],
    followups: [],
  };
}

const noteField = () => screen.getByPlaceholderText(/what this transaction was for/i);
const approveBtn = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
const rejectBtn = () => screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;

describe('DetailPanel — approval requires a note (ADR-0046 2026-07-21)', () => {
  it('disables Approve (and Reject) until a non-empty note is entered', () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    expect(approveBtn().disabled).toBe(true);
    expect(rejectBtn().disabled).toBe(true);

    fireEvent.change(noteField(), {
      target: { value: 'fuel for the Woodland box truck, June' },
    });
    expect(approveBtn().disabled).toBe(false);
    expect(rejectBtn().disabled).toBe(false);
  });

  it('re-disables Approve when the note is cleared to whitespace', () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    fireEvent.change(noteField(), { target: { value: 'ok to pay' } });
    expect(approveBtn().disabled).toBe(false);

    fireEvent.change(noteField(), { target: { value: '   ' } });
    expect(approveBtn().disabled).toBe(true);
  });

  it('marks the note field required and prompts for transaction purpose + context', () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    // The field is prompted for what the transaction was for + additional context…
    expect(noteField()).toBeTruthy();
    // …and the label carries an unmistakable (required) marker.
    expect(screen.getAllByText(/\(required\)/i).length).toBeGreaterThan(0);
  });
});
