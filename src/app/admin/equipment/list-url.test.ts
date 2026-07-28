// ADR-0063 — equipment list view-state serializer.
//
// This module exists to prevent the ADR-0017-Amendment-1 defect (create/edit
// silently dropping the admin's filters). These tests lock the round trip:
// anything `pickEquipmentListParams` accepts must survive
// `buildEquipmentListQuery` -> `pickEquipmentListParams` unchanged.

import { describe, expect, it } from 'vitest';
import {
  SEARCH_MAX,
  buildEquipmentListHref,
  buildEquipmentListQuery,
  parseCategory,
  parseSearch,
  parseStatus,
  pickEquipmentListParams,
  withEquipmentListQuery,
  type EquipmentListParams,
} from './list-url';

describe('parseCategory', () => {
  it('accepts every EquipmentCategory value', () => {
    for (const c of ['vehicle', 'forklift', 'baler', 'terex', 'other']) {
      expect(parseCategory(c)).toBe(c);
    }
  });

  it('rejects anything else', () => {
    expect(parseCategory('shear')).toBeUndefined();
    expect(parseCategory('')).toBeUndefined();
    expect(parseCategory(undefined)).toBeUndefined();
  });
});

describe('parseStatus', () => {
  it('defaults to active', () => {
    expect(parseStatus(undefined)).toBe('active');
    expect(parseStatus('')).toBe('active');
    expect(parseStatus('bogus')).toBe('active');
  });

  it('accepts the three real statuses', () => {
    expect(parseStatus('active')).toBe('active');
    expect(parseStatus('inactive')).toBe('inactive');
    expect(parseStatus('all')).toBe('all');
  });
});

describe('parseSearch', () => {
  it('trims', () => {
    expect(parseSearch('  EQ43  ')).toBe('EQ43');
  });

  it('collapses a whitespace-only term to undefined', () => {
    // A stray space must not pin the list to an empty result set, and must not
    // ride along in the round-trip query string.
    expect(parseSearch('   ')).toBeUndefined();
    expect(parseSearch('')).toBeUndefined();
    expect(parseSearch(undefined)).toBeUndefined();
  });

  it('clamps an over-long term', () => {
    const long = 'x'.repeat(SEARCH_MAX + 50);
    expect(parseSearch(long)).toHaveLength(SEARCH_MAX);
  });
});

describe('pickEquipmentListParams', () => {
  it('whitelists — an unexpected key never rides the round trip', () => {
    const picked = pickEquipmentListParams({
      site: 'woodland',
      category: 'baler',
      status: 'all',
      q: 'EQ43',
      // The create/edit pages feed what they were given into router.push, so a
      // pass-through of arbitrary params is the hazard this closes.
      next: '/admin/users',
    } as Parameters<typeof pickEquipmentListParams>[0]);

    expect(picked).toEqual({
      site: 'woodland',
      category: 'baler',
      status: 'all',
      q: 'EQ43',
    });
    expect(Object.keys(picked).sort()).toEqual(['category', 'q', 'site', 'status']);
  });

  it('drops an invalid category and status rather than 500ing the list', () => {
    const picked = pickEquipmentListParams({ category: 'spaceship', status: 'deleted' });
    expect(picked.category).toBeUndefined();
    expect(picked.status).toBe('active');
  });

  it('passes an unknown site code through for the page to resolve away', () => {
    // Not validated here (that needs a DB read); the list resolves it to "no
    // site filter" via siteByCode.
    expect(pickEquipmentListParams({ site: 'nowhere' }).site).toBe('nowhere');
  });

  it('handles an entirely absent searchParams bag', () => {
    expect(pickEquipmentListParams(undefined)).toEqual({
      site: undefined,
      category: undefined,
      status: 'active',
      q: undefined,
    });
  });
});

describe('buildEquipmentListHref', () => {
  const base: EquipmentListParams = {
    site: undefined,
    category: undefined,
    status: 'active',
    q: undefined,
  };

  it('omits the default status so "no filters" is the bare path', () => {
    expect(buildEquipmentListHref(base)).toBe('/admin/equipment');
  });

  it('serializes every non-default param', () => {
    expect(
      buildEquipmentListHref({ site: 'woodland', category: 'terex', status: 'all', q: 'EQ74' }),
    ).toBe('/admin/equipment?site=woodland&category=terex&status=all&q=EQ74');
  });

  it('URL-encodes a search term with spaces', () => {
    const href = buildEquipmentListHref({ ...base, q: 'EQ43 shear' });
    expect(href).toBe('/admin/equipment?q=EQ43+shear');
    // and it must survive a real URL parse back to the original term
    expect(new URL(href, 'https://x').searchParams.get('q')).toBe('EQ43 shear');
  });
});

describe('round trip', () => {
  const cases: EquipmentListParams[] = [
    { site: undefined, category: undefined, status: 'active', q: undefined },
    { site: 'woodland', category: undefined, status: 'active', q: undefined },
    { site: 'eugene', category: 'forklift', status: 'inactive', q: undefined },
    { site: 'woodland', category: 'terex', status: 'all', q: 'EQ74 — Terex Shear' },
    { site: undefined, category: undefined, status: 'all', q: 'F60' },
  ];

  it.each(cases)('survives build -> pick unchanged: %j', (view) => {
    const qs = buildEquipmentListQuery(view);
    const parsed = Object.fromEntries(new URLSearchParams(qs));
    expect(pickEquipmentListParams(parsed)).toEqual(view);
  });
});

describe('withEquipmentListQuery', () => {
  it('appends the view state to a sub-route', () => {
    expect(
      withEquipmentListQuery('/admin/equipment/new', {
        site: 'woodland',
        category: undefined,
        status: 'active',
        q: undefined,
      }),
    ).toBe('/admin/equipment/new?site=woodland');
  });

  it('leaves the path bare when there is no view state', () => {
    expect(
      withEquipmentListQuery('/admin/equipment/new', {
        site: undefined,
        category: undefined,
        status: 'active',
        q: undefined,
      }),
    ).toBe('/admin/equipment/new');
  });
});
