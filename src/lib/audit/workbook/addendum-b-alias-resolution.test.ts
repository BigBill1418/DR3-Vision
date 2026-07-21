// ADR-0037 amendment (rollup §1/§12) — intake alias resolution over the REAL
// Addendum-B seed data. Every documented customer-name variant (old live seed
// names + the month-to-month workbook drift Kelsey's files exhibit) must resolve
// case/whitespace-insensitively to its canonical MyMRC Source. Unknown names are
// NEVER guessed: the resolver returns null and the ingest path flags the row as
// an `unresolved_site` finding for operator review — parsing continues.
//
// Fake-prisma idiom (no test Postgres): the DB-backed resolver is fed exactly
// the rows the `20260730b_addendum_b_seeds` migration / prisma/seed.mjs create,
// built from the shared `prisma/seed/addendum-b-data.mjs` constants so a seed
// edit and this test can never drift apart.

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { sourceAliasResolver } from './site-alias';
import { resolveInboundSites } from './summary-recompute';
import type { InboundStage } from './parser';
import { defaultCheckConfigMap } from '../config';
import type { AuditWindow } from '../types';
import {
  CANONICAL_OR_NAMES,
  SOURCE_ALIASES,
} from '../../../../prisma/seed/addendum-b-data.mjs';

const SITE = 'site-eugene';

/** The seeded shape: one Source per canonical MyMRC name, its aliases attached. */
function seededDb(): PrismaClient {
  const sources = CANONICAL_OR_NAMES.map((name, i) => ({
    id: `src-${i + 1}`,
    site_id: SITE,
    name,
    is_non_program: false,
    aliases: SOURCE_ALIASES.filter(([, canonical]) => canonical === name).map(([alias]) => ({
      alias,
    })),
  }));
  return { source: { findMany: vi.fn(async () => sources) } } as unknown as PrismaClient;
}

const sourceIdOf = (canonical: string): string =>
  `src-${CANONICAL_OR_NAMES.indexOf(canonical) + 1}`;

describe('Addendum-B alias resolution — seeded variants', () => {
  it('resolves EVERY seeded [alias → canonical] pair to the right Source (id + name)', async () => {
    const resolver = await sourceAliasResolver(seededDb());
    for (const [alias, canonical] of SOURCE_ALIASES) {
      const hit = resolver.resolve(alias);
      expect(hit, `alias "${alias}" must resolve`).not.toBeNull();
      expect(hit!.canonicalName, `alias "${alias}"`).toBe(canonical);
      expect(hit!.sourceId, `alias "${alias}"`).toBe(sourceIdOf(canonical));
      expect(hit!.siteId).toBe(SITE);
    }
  });

  it('resolves every canonical MyMRC name to itself (incl. the verbatim "Recieving" typo)', async () => {
    const resolver = await sourceAliasResolver(seededDb());
    for (const canonical of CANONICAL_OR_NAMES) {
      const hit = resolver.resolve(canonical);
      expect(hit?.canonicalName, canonical).toBe(canonical);
      expect(hit?.sourceId).toBe(sourceIdOf(canonical));
    }
    expect(resolver.resolve('Glenwood Central Recieving Station')).not.toBeNull();
  });

  it('resolves the §12 observed month-to-month workbook variants', async () => {
    const resolver = await sourceAliasResolver(seededDb());
    const cases: [string, string][] = [
      // May 2026 names
      ['SVDP Albany', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'],
      ['SvdP Albany', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'], // the §12 typo
      ['SVDP Florence', 'St Vincent De Paul Of Lane County - Florence Thrift Store'],
      ['Cottage Grove', 'St Vincent De Paul Of Lane County - Cottage Grove Store'],
      // June 2026 names
      ['Albany', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'], // no prefix
      ['SVDP Cottage Grove', 'St Vincent De Paul Of Lane County - Cottage Grove Store'],
      ['SVDP The Dalles', 'St Vincent De Paul Of Lane County - The Dalles Thrift Store'],
    ];
    for (const [raw, canonical] of cases) {
      expect(resolver.resolve(raw)?.canonicalName, `"${raw}"`).toBe(canonical);
    }
  });

  it('resolves the retired live-era ("Salem-Keizer Recycling Center" generation) seed names', async () => {
    const resolver = await sourceAliasResolver(seededDb());
    const cases: [string, string][] = [
      ['Salem-Keizer Recycling Center', 'St Vincent De Paul Of Lane County - Salem Thrift Store'],
      ['Glenwood Transfer & Recycling Station', 'Glenwood Central Recieving Station'],
      ['Glenwood Transfer Station', 'Glenwood Central Recieving Station'],
      ['Albany-Linn County Transfer Station', 'ST Vincent De Paul OF Lane County-Albany Thrift Store'],
      ['Cottage Grove Transfer Station', 'St Vincent De Paul Of Lane County - Cottage Grove Store'],
      ['Florence Transfer Station', 'St Vincent De Paul Of Lane County - Florence Thrift Store'],
    ];
    for (const [raw, canonical] of cases) {
      expect(resolver.resolve(raw)?.canonicalName, `"${raw}"`).toBe(canonical);
    }
  });

  it('matches case- and whitespace-insensitively (§1: parser matches case-insensitively)', async () => {
    const resolver = await sourceAliasResolver(seededDb());
    const albany = 'ST Vincent De Paul OF Lane County-Albany Thrift Store';
    expect(resolver.resolve('svdp albany')?.canonicalName).toBe(albany);
    expect(resolver.resolve('SVDP ALBANY')?.canonicalName).toBe(albany);
    expect(resolver.resolve('  Albany  ')?.canonicalName).toBe(albany);
    expect(resolver.resolve('salem   svdp')?.canonicalName).toBe(
      'St Vincent De Paul Of Lane County - Salem Thrift Store',
    );
    expect(resolver.resolve('glenwood central recieving station')?.canonicalName).toBe(
      'Glenwood Central Recieving Station',
    );
  });

  it('returns honest null for an unknown name — never a guess', async () => {
    const resolver = await sourceAliasResolver(seededDb());
    expect(resolver.resolve('Roseburg Mattress Emporium')).toBeNull();
    expect(resolver.resolve('')).toBeNull();
  });
});

describe('Addendum-B alias resolution — unmatched names route to operator review', () => {
  const config = defaultCheckConfigMap().get('summary_recompute')!;
  const window: AuditWindow = { siteId: SITE, startISO: '2026-06-01', endISO: '2026-07-01' };
  const stage = (siteNameRaw: string, row: number): InboundStage => ({
    siteNameRaw,
    sourceType: 'Transfer Station',
    units: 10,
    provenance: { tab: 'Inbound', row, col: 'B' },
  });

  it('flags ONLY the unknown name as an unresolved_site finding; resolved variants pass', async () => {
    const resolver = await sourceAliasResolver(seededDb());
    const inbound = [
      stage('SVDP Albany', 4),
      stage('Cottage Grove', 5),
      stage('Totally Unknown Yard', 6),
      stage('SVDP The Dalles', 7),
    ];
    const findings = resolveInboundSites(window, inbound, resolver, config);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('unresolved_site');
    expect(findings[0]!.actual).toEqual({ siteNameRaw: 'Totally Unknown Yard' });
  });

  it('dedupes repeated unknown names to one finding (one operator action per name)', async () => {
    const resolver = await sourceAliasResolver(seededDb());
    const inbound = [stage('Mystery Yard', 4), stage('mystery yard', 5), stage(' MYSTERY YARD ', 6)];
    const findings = resolveInboundSites(window, inbound, resolver, config);
    expect(findings).toHaveLength(1);
  });
});
