// ADR-0017 Amendment 1 applied to the ADR-0066 AP configuration surface.
//
// `/admin/ap/routing` and `/admin/ap/notifications` are one screen behind two
// routes, so the admin's working view has to survive the cross-link between
// them. These lock the serializer/parser pair that makes that true.

import { describe, expect, it } from 'vitest';
import {
  buildApConfigHref,
  buildApConfigQuery,
  parseRoutingStatus,
  pickApConfigParams,
  withApConfigQuery,
} from './list-url';

describe('parseRoutingStatus', () => {
  it('accepts the three known filters', () => {
    expect(parseRoutingStatus('active')).toBe('active');
    expect(parseRoutingStatus('inactive')).toBe('inactive');
    expect(parseRoutingStatus('all')).toBe('all');
  });

  it('falls back to `active` for anything else', () => {
    expect(parseRoutingStatus(undefined)).toBe('active');
    expect(parseRoutingStatus('')).toBe('active');
    expect(parseRoutingStatus('deleted')).toBe('active');
  });
});

describe('pickApConfigParams', () => {
  it('whitelists — an unexpected key never rides the cross-link', () => {
    const params = pickApConfigParams({
      status: 'all',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ redirect: 'https://evil.example', role: 'admin' } as any),
    });
    expect(params).toEqual({ status: 'all' });
  });

  it('tolerates a missing bag', () => {
    expect(pickApConfigParams(undefined)).toEqual({ status: 'active' });
  });
});

describe('serialization', () => {
  it('omits the default status so the canonical URL stays bare', () => {
    expect(buildApConfigQuery({ status: 'active' })).toBe('');
    expect(buildApConfigHref('routing', { status: 'active' })).toBe('/admin/ap/routing');
    expect(buildApConfigHref('notifications', { status: 'active' })).toBe(
      '/admin/ap/notifications',
    );
  });

  it('carries a non-default filter across the cross-link', () => {
    expect(buildApConfigHref('notifications', { status: 'all' })).toBe(
      '/admin/ap/notifications?status=all',
    );
    expect(withApConfigQuery('/admin/ap/routing', { status: 'inactive' })).toBe(
      '/admin/ap/routing?status=inactive',
    );
  });

  it('round-trips', () => {
    for (const status of ['active', 'inactive', 'all'] as const) {
      const href = buildApConfigHref('routing', { status });
      const qs = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
      const parsed = pickApConfigParams(
        Object.fromEntries(new URLSearchParams(qs)) as { status?: string },
      );
      expect(parsed.status).toBe(status);
    }
  });
});
