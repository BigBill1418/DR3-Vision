// OPEN-ITEMS §0.BO / BO-4 — the uncharged-freight line reaches the 06:00 digest.
//
// Lives here rather than in `morning-digest.test.ts`, on the precedent of
// `doc-ingest/__tests__/digest-integration.test.ts`: this asserts a LOADS-domain
// contract that happens to be delivered through the AP digest, and keeping it
// here means it is not silently deleted by a future AP-side edit that does not
// know it exists.
//
// Two properties, and the second is the one that is easy to get wrong:
//
//   1. it appears when there is something to report;
//   2. it DEFEATS the digest's empty-suppression. An uncharged freight leg
//      produces no AP items — the invoice line is never written, so nothing is
//      pending, held or awaiting a signature — which means an items-gated
//      finding would be invisible on exactly the mornings it matters.
//
// It must ALSO not page. ADR-0037's gate is failed on Q1 and Q3: the remedy is a
// data-entry session against the Woodland workbook, not a five-minute action,
// and there is nothing to self-heal.

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb } from '@/lib/ap/__testutils__/fake-prisma';
import { buildApMorningDigest } from '@/lib/ap/morning-digest';

/** A Wednesday, 06:00 PT — a real digest tick. */
const NOW = new Date('2026-08-26T13:00:00Z');

function prismaWith(loads: { total_units: number | null; transporter: { name: string } }[]) {
  return makeFakePrisma(
    newFakeDb({
      // A CLEAN reachability scan, so these cases stay about BO-4: the
      // discovery-gap line is a second, independent warning in the same slot and
      // legitimately fires for a system that has never been scanned.
      reachabilityScans: [
        {
          id: 'scan-clean',
          scanned_at: new Date(NOW.getTime() - 10 * 60_000),
          scope_query: '(filetype:xlsx)',
          reachable_count: 3,
          watched_count: 3,
          gap_count: 0,
          truncated: false,
          error: null,
        },
      ],
      unchargedFreightLoads: loads,
    }),
  ) as unknown as PrismaClient;
}

describe('BO-4 — uncharged third-party freight in the 06:00 AP digest', () => {
  it('adds NOTHING on a month with no uncharged third-party haul', async () => {
    const payload = await buildApMorningDigest(prismaWith([]), NOW);
    expect(payload.warnings).toEqual([]);
    expect(payload.empty).toBe(true);
  });

  it('RESURRECTS an otherwise-empty digest — the whole point', async () => {
    // Nothing is pending, nothing is held, nobody owes a signature; the AP queue
    // is spotless. The freight leg is still silently missing, and 2026-08-25 is
    // the proof that this state can persist for the entire life of a system.
    const payload = await buildApMorningDigest(
      prismaWith([
        { total_units: 135, transporter: { name: 'Ron Lawrence & Son' } },
        { total_units: 112, transporter: { name: 'Titan Concepts International' } },
      ]),
      NOW,
    );
    expect(payload.empty).toBe(false);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toContain('third-party truck with NO transport charge');
    expect(payload.warnings[0]).toContain('Ron Lawrence & Son');
  });

  it('does NOT raise the digest to high priority — it is a digest line, not a page', async () => {
    // ADR-0037. The 3-day invoice age bar and an undelivered decision raise the
    // whole email; a standing data-classification gap does not. Escalating it
    // would put a permanent high-priority flag on every morning's mail, which is
    // how a priority stops meaning anything.
    const payload = await buildApMorningDigest(
      prismaWith([{ total_units: 135, transporter: { name: 'Ron Lawrence & Son' } }]),
      NOW,
    );
    expect(payload.highPriority).toBe(false);
  });

  it('renders into the email body, not only into the payload', async () => {
    const { renderApMorningDigestHtml } = await import('@/lib/ap/morning-digest');
    const payload = await buildApMorningDigest(
      prismaWith([{ total_units: 135, transporter: { name: 'Ron Lawrence & Son' } }]),
      NOW,
    );
    const html = renderApMorningDigestHtml(payload);
    expect(html).toContain('Ron Lawrence &amp; Son');
  });
});

// NOTE on wiring: every test above goes through `buildApMorningDigest`, not
// through the loads module directly. That is deliberate and is the wiring guard
// — an AP-side refactor that dropped the call would turn the second test red. A
// spy-based "the digest called my function" assertion was written and deleted:
// it could not survive the `vi.resetModules()` the module graph needs, so it
// asserted only that both exports are functions, which is true of broken code.
