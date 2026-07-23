// ADR-0039 — the source_aliases-backed site resolver (retro-audit join key).
// Fake-prisma idiom (the repo has no test Postgres). Verifies exact-canonical
// resolution, alias resolution, canonical-wins-over-alias on a normalized-key
// collision, and honest null for an unresolvable name.

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { sourceAliasResolver } from './site-alias';

function db(sources: unknown[]): PrismaClient {
  return {
    source: { findMany: vi.fn(async () => sources) },
  } as unknown as PrismaClient;
}

describe('sourceAliasResolver', () => {
  it('resolves an exact canonical Source.name (case/whitespace-insensitive) with its pool classification', async () => {
    const resolver = await sourceAliasResolver(
      db([{ id: 's1', site_id: 'site-eugene', name: 'Vacaville', is_non_program: false, aliases: [] }]),
    );
    expect(resolver.resolve('  vacaville ')).toEqual({
      sourceId: 's1',
      siteId: 'site-eugene',
      canonicalName: 'Vacaville',
      isNonProgram: false,
    });
  });

  it('resolves a drift-spelled alias to its canonical source', async () => {
    const resolver = await sourceAliasResolver(
      db([
        {
          id: 's1',
          site_id: 'site-wood',
          name: 'Chester Transfer',
          is_non_program: true,
          aliases: [{ alias: 'Chester Tranfer' }, { alias: 'chester xfer' }],
        },
      ]),
    );
    expect(resolver.resolve('Chester Tranfer')?.canonicalName).toBe('Chester Transfer');
    expect(resolver.resolve('Chester Tranfer')?.sourceId).toBe('s1');
    expect(resolver.resolve('CHESTER XFER')?.isNonProgram).toBe(true);
  });

  it('canonical name wins over an alias that normalizes to the same key', async () => {
    const resolver = await sourceAliasResolver(
      db([
        { id: 's1', site_id: 'site-a', name: 'Northside', is_non_program: false, aliases: [] },
        // s2 has an alias colliding with s1's canonical name — canonical must win.
        { id: 's2', site_id: 'site-b', name: 'Southside', is_non_program: true, aliases: [{ alias: 'northside' }] },
      ]),
    );
    expect(resolver.resolve('Northside')?.siteId).toBe('site-a');
  });

  it('returns null for an unresolvable name (caller emits unresolved_site)', async () => {
    const resolver = await sourceAliasResolver(db([]));
    expect(resolver.resolve('Nowhere Yard')).toBeNull();
  });

  // ADR-0037 (Rick/Morena) — EFFECTIVE classification: a flag-false source whose state
  // differs from its site's recycler state resolves as NON-program (out-of-state rule);
  // an in-state flag-false source resolves as program; the explicit flag still wins.
  it('classifies an OUT-OF-STATE source (state ≠ recycler state) as non-program', async () => {
    const resolver = await sourceAliasResolver(
      db([
        {
          id: 's1',
          site_id: 'site-wood',
          name: 'Ashland Yard',
          is_non_program: false,
          state: 'OR', // Oregon-generated units delivered to Woodland (CA)
          site: { jurisdiction: 'california' },
          aliases: [],
        },
      ]),
    );
    expect(resolver.resolve('Ashland Yard')?.isNonProgram).toBe(true);
  });

  it('classifies an IN-STATE flag-false source as program; explicit flag still wins', async () => {
    const resolver = await sourceAliasResolver(
      db([
        {
          id: 's1',
          site_id: 'site-wood',
          name: 'Local Yard',
          is_non_program: false,
          state: 'CA',
          site: { jurisdiction: 'california' },
          aliases: [],
        },
        {
          id: 's2',
          site_id: 'site-wood',
          name: 'Golden Bear',
          is_non_program: true, // explicit non-program, in-state
          state: 'CA',
          site: { jurisdiction: 'california' },
          aliases: [{ alias: 'Recology Sonoma' }],
        },
      ]),
    );
    expect(resolver.resolve('Local Yard')?.isNonProgram).toBe(false);
    expect(resolver.resolve('Golden Bear')?.isNonProgram).toBe(true);
    expect(resolver.resolve('Recology Sonoma')?.isNonProgram).toBe(true);
  });
});
