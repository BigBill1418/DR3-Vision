// ADR-0109 — photos 2 and 3 participate in the freshness composite.
//
// ## The premise this test exists to settle, and how it came out
//
// The brief for the three-photo change said the load-freshness composite
// `GREATEST(updated_at, newest stack, newest photo)` (ADR-0092 D1) "must include
// the newest of ALL photos — verify it already keys on newest photo generically
// or fix it so photos 2-3 participate."
//
// It already does, and NOTHING was changed to make it so. `listOpenClaimsWithStaleness`
// selects `load_photos` ordered by `uploaded_at desc, take 1` with **no `where`
// clause at all** — no kind filter, no "first photo of each kind", no cap. The
// newest photo on the load wins whether it is the required one or the third.
//
// That is a claim about code that could rot, which is what this file is for. It
// is written as a REGRESSION FENCE, not as a lap of honour:
//
//   - The first test fails the moment anyone adds a `where` to that select —
//     the single most likely "tidy-up" once photos have a per-kind ceiling
//     ("surely we only want the required one here?"). Under such a filter a
//     third BOL photo would still count but a third door-open photo on a load
//     whose newest activity was a door-open photo would silently stop counting,
//     and the watchdog would start mailing about operators who are working.
//   - The second test proves the CONSEQUENCE rather than the query shape: a
//     photo landing after `updated_at` and after the newest stack moves the
//     verdict. A shape assertion alone would pass against a composite that read
//     the photo and then threw it away.
//
// Both together are the point: ADR-0092 measured that 21 of 60 claimed loads in
// production carry a photo instant LATER than their own row's `updated_at`.

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { listOpenClaimsWithStaleness } from './stale-claim-query';
import { stalenessOf } from './stale-claim';

const SITE = 'site-eugene';
const NOW = new Date('2026-08-18T20:00:00.000Z');

/** Minutes before `NOW`, as a Date. */
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

type FindManyArgs = { select: Record<string, unknown> };

function fakeDb(rows: unknown[]): { db: PrismaClient; findMany: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn(async () => rows);
  return { db: { inboundLoad: { findMany } } as unknown as PrismaClient, findMany };
}

/** One open, claimed load whose newest photo is its THIRD. */
function loadWithThreePhotos(newestPhotoAt: Date, updatedAt: Date, newestStackAt: Date | null) {
  return {
    id: 'load-1',
    status: 'in_progress',
    updated_at: updatedAt,
    assigned_operator: { name: 'Pablo' },
    expected_load: { external_mymrc_haul_id: 'H-1', source_name_at_sync: 'Acme' },
    load_stacks: newestStackAt ? [{ created_at: newestStackAt }] : [],
    // `take: 1, orderBy uploaded_at desc` — Prisma hands back the newest, which
    // for a load carrying three photos of one kind is the third.
    load_photos: [{ uploaded_at: newestPhotoAt }],
  };
}

describe('ADR-0109 — the composite keys on the newest photo GENERICALLY', () => {
  it('applies no filter to load_photos, so an extra photo is not excluded', async () => {
    const { db, findMany } = fakeDb([]);
    await listOpenClaimsWithStaleness(SITE, NOW, db);

    const args = findMany.mock.calls[0]?.[0] as FindManyArgs | undefined;
    if (!args) throw new Error('expected the query to have been issued');
    const photos = args.select['load_photos'] as Record<string, unknown>;

    // The load-bearing assertion. `load_stacks` beside it DOES carry a `where`
    // (`voided_at: null`) and legitimately so — a voided stack is retracted
    // work. There is no equivalent for photos: nothing retracts a photo, and a
    // second or third one is the same evidence as the first.
    expect(
      photos['where'],
      'a filter on load_photos would drop the extras ADR-0109 introduced',
    ).toBeUndefined();
    expect(photos['orderBy']).toEqual({ uploaded_at: 'desc' });
    expect(photos['take']).toBe(1);
  });

  it('lets photo #3 be the freshest thing on the load', async () => {
    // Row shape: the parent froze 5 hours ago (past the 4h nudge threshold), the
    // stacks froze 4.5 hours ago, and the third photo landed 10 minutes ago. If
    // the third photo counts, this load is `ok`. If it does not, the watchdog
    // MAILS about an operator who took a picture ten minutes ago.
    const { db } = fakeDb([loadWithThreePhotos(ago(10), ago(300), ago(270))]);
    const [verdict] = await listOpenClaimsWithStaleness(SITE, NOW, db);

    expect(verdict?.level, 'the third photo did not reset the idle clock').toBe('ok');
    expect(verdict?.idleMs).toBe(10 * 60_000);
  });

  it('is the MAXIMUM, so an extra photo can only ever make a load look fresher', () => {
    // Pure-function half, no database. Guards the direction of the composite:
    // an implementation that took the newest photo INSTEAD of the maximum would
    // pass the test above and fail this one, because here the parent row is the
    // most recent thing.
    const withPhoto = stalenessOf(
      { updatedAt: ago(10), lastStackAt: ago(400), lastPhotoAt: ago(300) },
      NOW,
    );
    const withoutPhoto = stalenessOf(
      { updatedAt: ago(10), lastStackAt: ago(400), lastPhotoAt: null },
      NOW,
    );
    expect(withPhoto.idleMs).toBe(withoutPhoto.idleMs);
    expect(withPhoto.idleMs).toBe(10 * 60_000);
  });
});
