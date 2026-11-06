// @vitest-environment jsdom
//
// ADR-0072 Amendment 1 — the RENDERED contract for the manager's held-count
// screen: the flags a manager reads before deciding, the calls the buttons make,
// and that every refusal the route can answer reaches the screen as a sentence.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { HeldCountsClient, describeRefusal, type HeldCountView } from './HeldCountsClient';

function hold(over: Partial<HeldCountView> & { id: string }): HeldCountView {
  return {
    createdAtISO: '2026-11-06T16:05:00.000Z',
    enteredByName: 'JT',
    countedBy: 'JT',
    confirmedBy: null,
    enteredByMe: false,
    priorTotal: 2483,
    newTotal: 2150,
    swingPct: 23.4,
    thresholdPct: 20,
    largeSwing: false,
    sameCountPending: 1,
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
function answer(status: number, body: unknown): void {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('what the manager sees', () => {
  it('shows prior, new, swing and the Pacific time of each hold', () => {
    render(<HeldCountsClient siteCode="woodland" holds={[hold({ id: 'h1' })]} />);
    const text = screen.getByTestId('hold-h1').textContent ?? '';
    expect(text).toContain('2,483');
    expect(text).toContain('2,150');
    expect(text).toContain('-333 (23.4%)');
    // 16:05Z on Nov 6 = 8:05 AM PST.
    expect(text).toContain('8:05 AM PT');
    expect(text).toContain('Entered by JT');
  });

  it('warns prominently on a large swing, and only there', () => {
    render(
      <HeldCountsClient
        siteCode="woodland"
        holds={[
          hold({ id: 'big', newTotal: 1200, swingPct: 51.7, largeSwing: true }),
          hold({ id: 'small' }),
        ]}
      />,
    );
    expect(screen.getByTestId('large-swing-big').getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('large-swing-small')).toBeNull();
  });

  it('flags lookalike holds so the extras can be discarded', () => {
    render(
      <HeldCountsClient
        siteCode="woodland"
        holds={[
          hold({ id: 'a', sameCountPending: 2 }),
          hold({ id: 'b', sameCountPending: 2 }),
          hold({ id: 'c', newTotal: 999 }),
        ]}
      />,
    );
    expect(screen.getByTestId('duplicates-banner')).toBeTruthy();
    expect(screen.getByTestId('duplicate-a').textContent).toContain('2 held counts');
    expect(screen.getByTestId('duplicate-b')).toBeTruthy();
    expect(screen.queryByTestId('duplicate-c')).toBeNull();
  });

  it('offers no Approve on a count the manager entered, but still offers Discard', () => {
    render(<HeldCountsClient siteCode="woodland" holds={[hold({ id: 'm', enteredByMe: true })]} />);
    expect(screen.queryByTestId('approve-m')).toBeNull();
    expect(screen.getByTestId('mine-m')).toBeTruthy();
    expect(screen.getByTestId('discard-m')).toBeTruthy();
  });

  it('says so when nothing is waiting', () => {
    render(<HeldCountsClient siteCode="woodland" holds={[]} />);
    expect(screen.getByTestId('no-holds')).toBeTruthy();
  });
});

describe('the calls', () => {
  it('Approve needs a confirm, then POSTs the manager route and refreshes', async () => {
    answer(200, { released: true, newTotal: 2150 });
    render(<HeldCountsClient siteCode="woodland" holds={[hold({ id: 'h1' })]} />);
    fireEvent.click(screen.getByTestId('approve-h1'));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-approve-h1'));
    await waitFor(() =>
      expect(screen.getByTestId('hold-message').textContent).toContain('Approved'),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/manager/woodland/count-holds/h1',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('Discard is disabled until a reason is typed, then DELETEs with it', async () => {
    answer(200, { discarded: true });
    render(<HeldCountsClient siteCode="woodland" holds={[hold({ id: 'h1' })]} />);
    fireEvent.click(screen.getByTestId('discard-h1'));
    const go = screen.getByTestId('confirm-discard-h1') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('reason-h1'), { target: { value: '  duplicate  ' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'duplicate' });
  });

  it('a 409 says who won and re-reads the list', async () => {
    answer(409, { error: 'hold_discarded' });
    render(<HeldCountsClient siteCode="woodland" holds={[hold({ id: 'h1' })]} />);
    fireEvent.click(screen.getByTestId('approve-h1'));
    fireEvent.click(screen.getByTestId('confirm-approve-h1'));
    await waitFor(() =>
      expect(screen.getByTestId('hold-message').textContent).toContain('already discarded'),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a self-release refusal is named and does not refresh', async () => {
    answer(403, { error: 'operator_cannot_self_release', message: 'x' });
    render(<HeldCountsClient siteCode="woodland" holds={[hold({ id: 'h1' })]} />);
    fireEvent.click(screen.getByTestId('approve-h1'));
    fireEvent.click(screen.getByTestId('confirm-approve-h1'));
    await waitFor(() =>
      expect(screen.getByTestId('hold-message').textContent).toContain(
        'entered this count yourself',
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('describeRefusal', () => {
  it.each([
    [401, 'forbidden', 'sign-in has expired', false],
    [403, 'not_a_manager', 'not an approver', false],
    [403, 'forbidden', 'do not have manager access', false],
    [404, 'hold_not_found', 'no longer exists', true],
    [409, 'hold_approved', 'already approved', true],
    [422, 'reason_required', 'Enter a reason', false],
    [500, 'release_failed', 'release_failed', false],
  ])('%i %s', (status, error, expected, gone) => {
    const r = describeRefusal(status, { error });
    expect(r.text).toContain(expected);
    expect(r.gone).toBe(gone);
  });
});
