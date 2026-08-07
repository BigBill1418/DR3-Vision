// ADR-0067 Amendment A §A.6 — "a line in Bill's 06:00 digest until resolved".
//
// Lives here rather than in `morning-digest.test.ts` deliberately: this asserts
// an ADR-0067 requirement that happens to be delivered through the AP digest,
// and keeping it here means the ingestion contract is not silently deleted by a
// future AP-side edit that does not know it exists.
//
// The property that matters is the one that is easy to get wrong: a disconnected
// ingester produces NO items, so an items-gated line would be invisible exactly
// when it matters. The warning must therefore ALSO defeat the digest's
// empty-suppression.

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb } from '@/lib/ap/__testutils__/fake-prisma';
import { buildApMorningDigest } from '@/lib/ap/morning-digest';

function prismaWith(
  connection: {
    state: 'connected' | 'reauth_required';
    reauth_since: Date | null;
    reauth_reason: string | null;
    account_upn: string;
  } | null,
): PrismaClient {
  // ADR-0080 — seed a CLEAN reachability scan so these cases stay about W3.
  //
  // The discovery-gap warning is a second, independent line in the same
  // `warnings` slot, and it legitimately fires for a CONNECTED system that has
  // never been scanned. Leaving that unseeded would make every assertion here
  // depend on ADR-0080 state and stop testing the ADR-0067 contract it is named
  // for. A clean scan is also the honest steady state: the sweep runs one every
  // 15 minutes.
  return makeFakePrisma(
    newFakeDb({
      docIngestConnection: connection,
      reachabilityScans: [
        {
          id: 'scan-clean',
          scanned_at: new Date(NOW.getTime() - 10 * 60_000),
          scope_query: '(filetype:xlsx) AND path:"https://example-my.sharepoint.com"',
          reachable_count: 3,
          watched_count: 3,
          gap_count: 0,
          truncated: false,
          error: null,
        },
      ],
    }),
  ) as unknown as PrismaClient;
}

const NOW = new Date('2026-08-05T13:00:00Z'); // a Wednesday

describe('doc-ingest warning in the 06:00 AP digest (W3)', () => {
  it('adds NOTHING while ingestion is connected', async () => {
    const payload = await buildApMorningDigest(
      prismaWith({
        state: 'connected',
        reauth_since: null,
        reauth_reason: null,
        account_upn: 'docs-dr3@svdp.us',
      }),
      NOW,
    );
    expect(payload.warnings).toEqual([]);
    expect(payload.empty).toBe(true);
  });

  it('adds nothing when ingestion was never connected', async () => {
    const payload = await buildApMorningDigest(prismaWith(null), NOW);
    expect(payload.warnings).toEqual([]);
    expect(payload.empty).toBe(true);
  });

  it('adds the line — and DEFEATS empty-suppression — once disconnected', async () => {
    // This is the whole point. With an empty AP queue and a halted ingester,
    // suppressing the digest would mean the outage is invisible for as long as
    // no invoice happens to arrive.
    const payload = await buildApMorningDigest(
      prismaWith({
        state: 'reauth_required',
        reauth_since: new Date('2026-08-03T13:00:00Z'),
        reauth_reason: 'invalid_grant: AADSTS700082',
        account_upn: 'docs-dr3@svdp.us',
      }),
      NOW,
    );

    expect(payload.empty).toBe(false);
    expect(payload.warnings).toHaveLength(1);
    const line = payload.warnings[0] ?? '';
    expect(line).toContain('DISCONNECTED');
    expect(line).toContain('docs-dr3@svdp.us');
    expect(line).toContain('/admin/doc-ingest/connect');
    expect(line).toContain('invalid_grant');
  });
});
