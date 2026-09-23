// @vitest-environment jsdom
//
// ADR-0135 E — the approver's "Equipment not in list" hatch is STRUCTURED, and
// the approver's picker uses the unit-aware matcher.
//
// Drives the real DetailPanel: the hatch must gate Approve on a VALID request
// (type + ONE unit #), and the decide payload must carry the structured text in
// the unchanged `equipmentRequestDescription` field — the server refuses anything
// else (`createEquipmentRequestInTx`).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DetailPanel } from './ApQueueClient';
import { REQUEST_PROBLEM_MESSAGE } from '@/lib/equipment/request-description';

const OPTIONS = [
  { id: 'eq-19', displayName: 'Trailer #19', category: 'vehicle', siteCode: null },
  {
    id: 'eq-161053',
    displayName: '161053 — Freightliner Semi Truck',
    category: 'vehicle',
    siteCode: 'woodland',
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/ops/ap/equipment')) {
      return { ok: true, status: 200, json: async () => ({ options: OPTIONS }) };
    }
    if (url.endsWith('/decide')) {
      return { ok: true, status: 200, json: async () => ({ mail: 'sent' }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
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
const byTestId = <T extends HTMLElement>(id: string) => screen.getByTestId(id) as T;

/** Real site + the three non-equipment structured fields, so only equipment gates Approve. */
function fillAllButEquipment() {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'woodland' } });
  fireEvent.change(screen.getByRole('textbox', { name: /enter the vendor name carefully/i }), {
    target: { value: 'Sunbelt Rentals' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: /confirmed amount usd/i }), {
    target: { value: '125.00' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: /what was this transaction for/i }), {
    target: { value: 'trailer repair' },
  });
}

function openHatch() {
  fireEvent.click(byTestId('ap-equipment-not-listed'));
}

describe('DetailPanel — structured "Equipment not in list" hatch (ADR-0135 E)', () => {
  it('replaces the free-text paragraph with type / unit # / make / notes', () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    fillAllButEquipment();
    openHatch();
    expect(screen.queryByTestId('ap-equipment-description')).toBeNull();
    expect(byTestId('ap-equipment-request-type')).toBeTruthy();
    expect(byTestId('ap-equipment-request-unit')).toBeTruthy();
    expect(byTestId('ap-equipment-request-make')).toBeTruthy();
    expect(byTestId('ap-equipment-request-notes')).toBeTruthy();
    expect(screen.getByTestId('ap-equipment-request-fields').textContent).toMatch(
      /for several units, pick each from the list/i,
    );
  });

  it('keeps Approve disabled until the request is valid — one unit only', () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    fillAllButEquipment();
    openHatch();
    expect(approveBtn().disabled).toBe(true); // nothing chosen

    fireEvent.change(byTestId('ap-equipment-request-type'), { target: { value: 'trailer' } });
    expect(approveBtn().disabled).toBe(true); // trailer needs a unit #
    expect(byTestId('ap-equipment-request-problem').textContent).toBe(
      REQUEST_PROBLEM_MESSAGE.unit_required,
    );

    fireEvent.change(byTestId('ap-equipment-request-unit'), {
      target: { value: '53489, 5340, 35' },
    });
    expect(approveBtn().disabled).toBe(true); // a work order, not an asset
    expect(byTestId('ap-equipment-request-problem').textContent).toBe(
      REQUEST_PROBLEM_MESSAGE.unit_invalid,
    );

    fireEvent.change(byTestId('ap-equipment-request-unit'), { target: { value: '5327' } });
    expect(approveBtn().disabled).toBe(false);
    expect(screen.queryByTestId('ap-equipment-request-problem')).toBeNull();
  });

  it('a baler without a unit # needs a note before Approve enables', () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    fillAllButEquipment();
    openHatch();
    fireEvent.change(byTestId('ap-equipment-request-type'), { target: { value: 'baler' } });
    expect(approveBtn().disabled).toBe(true);
    fireEvent.change(byTestId('ap-equipment-request-notes'), {
      target: { value: 'the vertical baler by dock 2' },
    });
    expect(approveBtn().disabled).toBe(false);
  });

  it('posts the STRUCTURED text in equipmentRequestDescription, and nothing else for equipment', async () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    fillAllButEquipment();
    openHatch();
    fireEvent.change(byTestId('ap-equipment-request-type'), { target: { value: 'trailer' } });
    fireEvent.change(byTestId('ap-equipment-request-unit'), { target: { value: '#5327' } });
    fireEvent.change(byTestId('ap-equipment-request-make'), { target: { value: 'Great Dane' } });
    fireEvent.click(approveBtn());

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/decide'))).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/decide'))!;
    const body = JSON.parse((call[1] as RequestInit).body as string) as {
      equipmentRequestDescription?: string;
    };
    expect(body.equipmentRequestDescription).toBe('Unit #: 5327\nType: Trailer\nMake: Great Dane');
    expect(body).not.toHaveProperty('equipmentIds');
    expect(body).not.toHaveProperty('notEquipmentRelated');
  });

  it('picking from the list clears the hatch fields (no half-typed request rides along)', async () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    fillAllButEquipment();
    openHatch();
    fireEvent.change(byTestId('ap-equipment-request-type'), { target: { value: 'trailer' } });
    fireEvent.click(byTestId('ap-equipment-not-listed')); // back to the list
    await screen.findByText('Trailer #19');
    openHatch();
    expect(byTestId<HTMLSelectElement>('ap-equipment-request-type').value).toBe('');
  });
});

describe('DetailPanel — picker uses the unit-aware matcher (ADR-0135 B)', () => {
  it('`Trailer # 19` finds `Trailer #19`, and a fleet-wide asset reads `fleet`', async () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    fillAllButEquipment();
    await screen.findByText('Trailer #19');
    fireEvent.change(screen.getByPlaceholderText('Search equipment…'), {
      target: { value: 'Trailer # 19' },
    });
    expect(screen.getByText('Trailer #19')).toBeTruthy();
    expect(screen.queryByText('161053 — Freightliner Semi Truck')).toBeNull();
    expect(screen.getByText('Trailer #19').parentElement?.textContent).toMatch(/· fleet/);
  });

  it('`161053.` finds `161053 — Freightliner …` (site code shown)', async () => {
    render(<DetailPanel detail={pendingDetail()} onDecided={() => undefined} />);
    fillAllButEquipment();
    await screen.findByText('Trailer #19');
    fireEvent.change(screen.getByPlaceholderText('Search equipment…'), {
      target: { value: '161053.' },
    });
    expect(screen.queryByText('Trailer #19')).toBeNull();
    expect(screen.getByText('161053 — Freightliner Semi Truck').parentElement?.textContent).toMatch(
      /· woodland/,
    );
  });
});
