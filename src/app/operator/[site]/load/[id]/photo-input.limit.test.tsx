// @vitest-environment jsdom
//
// ADR-0109 — the floor half of the three-photo ceiling.
//
// The server refuses a fourth photo (`photo-limit.route.test.ts`). This suite is
// about the thing an operator's thumb can reach, and the bar it has to clear is
// CONTRIBUTING.md's, not merely "the count is right":
//
//   > Never ship a control whose only outcome is a refusal (ADR-0074 Am.1).
//
// So the affordance must be WITHDRAWN at the ceiling rather than present and
// rejecting, and the count must be seeded from the server or a reload re-offers
// three taps on a step with room for none.
//
// ## Naive-first, recorded red
//
// Written against `photo-input.tsx` as it stood on `main` at cbab98b — one
// button, no counter, no cap, and re-tapping it after a successful capture
// silently uploaded another photo. That is not a reading of the code; it is what
// production shows: 18 (load, kind) pairs carry 2-4 rows with distinct storage
// keys. Re-falsified 2026-08-18 by restoring that component (drop the second
// control, the count caption, and the three `atLimit` guards). VERBATIM:
//
//     × photos 2 and 3 ... > offers "add another photo" once one exists, with no slot label
//       → expected null not to be null
//     × photos 2 and 3 ... > states the running count against the ceiling
//       → Unable to find an element by: [data-testid="photo-count"]
//     × photos 2 and 3 ... > the primary control stops being a second way to do the same thing
//       → expected null not to be null
//     × the ceiling > explains the withdrawal rather than leaving it mysterious
//       → Unable to find an element by: [data-testid="photo-count"]
//     × the ceiling > seeds the count from the server so a reload cannot exceed the ceiling
//       → a load already at the ceiling still offered a capture control: expected false to be true
//     × the ceiling > sends nothing when the file input fires at the ceiling
//       → expected "spy" to not be called at all, but actually been called 1 times
//     × a queued photo counts ... > counts an offline capture toward the ceiling
//       → Unable to find an element by: [data-testid="photo-count"]
//     × a 409 from the server resyncs the client > reads the server count instead of only showing the message
//       → Unable to find an element by: [data-testid="photo-count"]
//
//     Tests  8 failed | 3 passed (11)
//
// The three survivors are the required-photo cases, which is exactly right: the
// first photo was never the thing that changed.
//
// `sends nothing when the file input fires at the ceiling` is the one worth
// reading twice — under the old component the file input happily uploaded a
// FOURTH photo, which is how production ended up with a load holding four BOLs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';
import { MAX_PHOTOS_PER_KIND } from '@/lib/loads/photo-limit';

const { enqueueUpload, isOfflineError, newIdempotencyKey } = vi.hoisted(() => ({
  enqueueUpload: vi.fn(async () => ({})),
  isOfflineError: vi.fn(() => false),
  newIdempotencyKey: vi.fn(() => '0000000000abc-0000000000000000key1'),
}));
vi.mock('@/lib/offline-queue', () => ({ enqueueUpload, isOfflineError, newIdempotencyKey }));

// Real dictionary, real interpolation — the assertions are about text an
// operator reads, and a stubbed `t` would be measuring itself.
vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useT: () => (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
    useLocale: () => 'en',
  };
});

import { PhotoInput } from './photo-input';

const onCaptured = vi.fn();

function shoot(): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['jpeg'], 'IMG.jpg', { type: 'image/jpeg' })] },
  });
}

/** Mint + R2 PUT + confirm all succeed. The ordinary online capture. */
function happyPath(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).includes('/api/photos/upload-url')
        ? new Response(JSON.stringify({ storage_key: 'loads/l/bol/a.jpg', upload_url: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ id: 'p1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );
}

function mount(initialCount?: number) {
  return render(
    <PhotoInput
      loadId="load-1"
      kind="bol"
      labelKey="bol"
      onCaptured={onCaptured}
      {...(initialCount === undefined ? {} : { initialCount })}
    />,
  );
}

const addAnother = () => screen.queryByTestId('photo-add-another');
const capture = () => screen.getByTestId('photo-capture') as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  isOfflineError.mockReturnValue(false);
  happyPath();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the required photo is unchanged', () => {
  it('offers exactly one control before any photo exists, and no count', () => {
    mount();
    expect(capture().disabled).toBe(false);
    expect(addAnother(), 'nothing to add another OF yet').toBeNull();
    expect(screen.queryByTestId('photo-count')).toBeNull();
  });

  it('does not arm the parent stage until a photo is captured', () => {
    mount();
    // `onCaptured` is what enables Continue in every stage that mounts this.
    // A load with zero photos must not be submittable, and the extras added by
    // this ADR must not have moved that gate.
    expect(onCaptured).not.toHaveBeenCalled();
  });
});

describe('photos 2 and 3 — generic, unnamed, optional', () => {
  it('offers "add another photo" once one exists, with no slot label', async () => {
    mount();
    shoot();
    await waitFor(() => expect(addAnother()).not.toBeNull());
    const text = addAnother()!.textContent ?? '';
    expect(text).toMatch(/add another photo/i);
    // Handoff #264 Item 1: "generic/unnamed — no slot labels". A second/third
    // photo is not a named kind of evidence and must not read as one.
    expect(text).not.toMatch(/second|third|2nd|3rd|bol/i);
  });

  it('states the running count against the ceiling', async () => {
    mount();
    shoot();
    await waitFor(() => expect(screen.getByTestId('photo-count').textContent).toContain('1 of 3'));
  });

  it('the primary control stops being a second way to do the same thing', async () => {
    // Two live buttons that both open the camera is how the un-bounded version
    // of this behaviour got discovered by accident in the first place.
    mount();
    shoot();
    await waitFor(() => expect(addAnother()).not.toBeNull());
    expect(capture().disabled).toBe(true);
  });
});

describe('the ceiling', () => {
  it('withdraws the add-another control at the ceiling', () => {
    mount(MAX_PHOTOS_PER_KIND);
    expect(addAnother(), 'a control whose only outcome is a refusal').toBeNull();
  });

  it('explains the withdrawal rather than leaving it mysterious', () => {
    mount(MAX_PHOTOS_PER_KIND);
    expect(screen.getByTestId('photo-count').textContent).toContain('3 of 3');
  });

  it('seeds the count from the server so a reload cannot exceed the ceiling', () => {
    // The BOL stage is gated by a CLIENT latch (`bolDone`), so a reload lands the
    // operator back on a step whose photos are already in the database. Starting
    // at zero would offer three more taps and earn a 409 on the fourth.
    mount(MAX_PHOTOS_PER_KIND);
    expect(
      capture().disabled,
      'a load already at the ceiling still offered a capture control',
    ).toBe(true);
  });

  it('sends nothing when the file input fires at the ceiling', () => {
    // The last gate. iOS suspends the page for the whole time a camera sheet is
    // up, so "the count reached the ceiling while the sheet was open" is a real
    // interval, not a defensive hypothetical.
    mount(MAX_PHOTOS_PER_KIND);
    shoot();
    expect(fetch).not.toHaveBeenCalled();
    expect(enqueueUpload).not.toHaveBeenCalled();
  });
});

describe('a queued photo counts — offline does not buy extra room', () => {
  it('counts an offline capture toward the ceiling', async () => {
    isOfflineError.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    mount(MAX_PHOTOS_PER_KIND - 1);
    shoot();
    // The blob is in IndexedDB and `replayAll` will confirm it, so it is a row
    // the load is going to hold. Counting only completed uploads would let an
    // operator working offline queue three more and discover the surplus as
    // conflicts hours later.
    await waitFor(() => expect(enqueueUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(addAnother()).toBeNull());
    expect(screen.getByTestId('photo-count').textContent).toContain('3 of 3');
  });
});

describe('a 409 from the server resyncs the client', () => {
  it('reads the server count instead of only showing the message', async () => {
    // Reachable whenever another device drained a queued photo for the same load
    // — ordinary since ADR-0078 Am.1 made the photo gate site-scoped. A stale
    // count that stays stale re-offers the control and the operator taps into
    // the same refusal again.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/photos/upload-url')
          ? new Response(JSON.stringify({ storage_key: 'loads/l/bol/a.jpg', upload_url: null }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(JSON.stringify({ error: 'photo_limit_reached', limit: 3, held: 3 }), {
              status: 409,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    );
    mount(0);
    shoot();
    await waitFor(() => expect(screen.getByTestId('photo-count').textContent).toContain('3 of 3'));
    expect(addAnother()).toBeNull();
    // And the copy must not say "tap to try again" — nothing is broken.
    expect(document.body.textContent).toContain(en.photo.limit_reached.replace('{{max}}', '3'));
  });
});
