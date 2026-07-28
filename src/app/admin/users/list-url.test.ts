// ADR-0017 — user-list view-state serializer.
//
// The list's filters live in the URL. These guards lock the round-trip
// contract that keeps an admin in the view they were working in when they
// create or edit a user (the defect: save pushed a bare `/admin/users` and
// dumped a Woodland-scoped admin back to the all-users list).

import { describe, expect, it } from 'vitest';
import {
  buildUsersListHref,
  buildUsersListQuery,
  pickUsersListParams,
  withUsersListQuery,
} from './list-url';

describe('pickUsersListParams', () => {
  it('defaults to the unfiltered active list', () => {
    expect(pickUsersListParams(undefined)).toEqual({
      site: undefined,
      role: undefined,
      status: 'active',
    });
    expect(pickUsersListParams({})).toEqual({
      site: undefined,
      role: undefined,
      status: 'active',
    });
  });

  it('keeps valid filters', () => {
    expect(pickUsersListParams({ site: 'woodland', role: 'operator', status: 'all' })).toEqual({
      site: 'woodland',
      role: 'operator',
      status: 'all',
    });
  });

  it('drops an unknown role and falls back to the default status', () => {
    expect(pickUsersListParams({ role: 'superuser', status: 'banana' })).toEqual({
      site: undefined,
      role: undefined,
      status: 'active',
    });
  });

  it('whitelists — an unexpected param does not survive the round trip', () => {
    const picked = pickUsersListParams({
      site: 'woodland',
      next: '/somewhere-else',
      redirect: 'https://evil.example',
    } as Record<string, string>);
    expect(picked).toEqual({ site: 'woodland', role: undefined, status: 'active' });
    expect(buildUsersListHref(picked)).toBe('/admin/users?site=woodland');
  });
});

describe('buildUsersListHref', () => {
  it('round-trips the Woodland operator view', () => {
    expect(buildUsersListHref({ site: 'woodland', role: 'operator', status: 'active' })).toBe(
      '/admin/users?site=woodland&role=operator',
    );
  });

  it('omits status=active (the list default) so the canonical URL stays bare', () => {
    expect(buildUsersListHref({ site: undefined, role: undefined, status: 'active' })).toBe(
      '/admin/users',
    );
  });

  it('emits a non-default status', () => {
    expect(buildUsersListHref({ site: 'eugene', role: undefined, status: 'inactive' })).toBe(
      '/admin/users?site=eugene&status=inactive',
    );
  });

  it('survives a parse → build round trip', () => {
    const url = '/admin/users?site=woodland&role=manager&status=all';
    const sp = Object.fromEntries(new URLSearchParams(url.split('?')[1]));
    expect(buildUsersListHref(pickUsersListParams(sp))).toBe(url);
  });
});

describe('buildUsersListQuery / withUsersListQuery', () => {
  it('returns a bare query string with no leading ?', () => {
    expect(buildUsersListQuery({ site: 'woodland', role: undefined, status: 'active' })).toBe(
      'site=woodland',
    );
    expect(buildUsersListQuery({ site: undefined, role: undefined, status: 'active' })).toBe('');
  });

  it('appends the view state to a sub-route', () => {
    expect(
      withUsersListQuery('/admin/users/new', {
        site: 'woodland',
        role: 'operator',
        status: 'active',
      }),
    ).toBe('/admin/users/new?site=woodland&role=operator');
  });

  it('leaves a sub-route bare when there is no view state to carry', () => {
    expect(
      withUsersListQuery('/admin/users/new', {
        site: undefined,
        role: undefined,
        status: 'active',
      }),
    ).toBe('/admin/users/new');
  });
});
