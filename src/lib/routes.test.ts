/**
 * Unit tests for post-login / post-action redirect target resolution.
 *
 * Regression guard for the "finishing something lands you on the
 * Woodland/Eugene site picker" bug: the default landing target must be
 * the role-aware Vision Dashboard (`/`, HOME_ROUTE), never the
 * `/dashboard` site picker (SITE_PICKER_ROUTE). Safe deep-links are
 * honored; unsafe/external `next` values fall back to home (open-redirect
 * guard).
 *
 * Pure functions, no DOM — default `node` vitest environment.
 */

import { describe, it, expect } from 'vitest';
import {
  HOME_ROUTE,
  SITE_PICKER_ROUTE,
  isSafeInternalPath,
  resolvePostLoginTarget,
} from './routes';

describe('route constants', () => {
  it('HOME_ROUTE is the Vision Dashboard root, NOT the site picker', () => {
    expect(HOME_ROUTE).toBe('/');
    expect(HOME_ROUTE).not.toBe(SITE_PICKER_ROUTE);
  });

  it('SITE_PICKER_ROUTE is /dashboard (Woodland/Eugene picker)', () => {
    expect(SITE_PICKER_ROUTE).toBe('/dashboard');
  });
});

describe('resolvePostLoginTarget', () => {
  it('defaults to HOME_ROUTE when next is missing', () => {
    expect(resolvePostLoginTarget(null)).toBe(HOME_ROUTE);
    expect(resolvePostLoginTarget(undefined)).toBe(HOME_ROUTE);
    expect(resolvePostLoginTarget('')).toBe(HOME_ROUTE);
  });

  it('never defaults to the site picker (the bug)', () => {
    // The pre-fix default was `'/dashboard'`. Anyone with no deep-link
    // must now land on the dashboard, not the picker.
    expect(resolvePostLoginTarget(null)).not.toBe(SITE_PICKER_ROUTE);
    expect(resolvePostLoginTarget(undefined)).not.toBe(SITE_PICKER_ROUTE);
  });

  it('honors a safe internal deep-link verbatim', () => {
    expect(resolvePostLoginTarget('/bonus')).toBe('/bonus');
    expect(resolvePostLoginTarget('/dashboard/woodland/loads')).toBe('/dashboard/woodland/loads');
    expect(resolvePostLoginTarget('/admin/users')).toBe('/admin/users');
    expect(resolvePostLoginTarget('/operator/eugene/queue')).toBe('/operator/eugene/queue');
  });

  it('preserves query strings and fragments on safe deep-links', () => {
    expect(resolvePostLoginTarget('/bonus/months/m1?tab=sign')).toBe('/bonus/months/m1?tab=sign');
    expect(resolvePostLoginTarget('/admin/audit?page=2')).toBe('/admin/audit?page=2');
  });

  it('honoring the site picker as an explicit deep-link is allowed', () => {
    // If the user genuinely deep-linked to the picker, respect it; the
    // bug was only about the *default*, not about banning the route.
    expect(resolvePostLoginTarget('/dashboard')).toBe('/dashboard');
  });

  it('rejects external / protocol-relative targets (open-redirect guard)', () => {
    expect(resolvePostLoginTarget('https://evil.com')).toBe(HOME_ROUTE);
    expect(resolvePostLoginTarget('http://evil.com/path')).toBe(HOME_ROUTE);
    expect(resolvePostLoginTarget('//evil.com')).toBe(HOME_ROUTE);
    expect(resolvePostLoginTarget('/\\evil.com')).toBe(HOME_ROUTE);
    expect(resolvePostLoginTarget('javascript:alert(1)')).toBe(HOME_ROUTE);
    expect(resolvePostLoginTarget('mailto:a@b.com')).toBe(HOME_ROUTE);
  });

  it('rejects non-absolute (relative) paths', () => {
    expect(resolvePostLoginTarget('bonus')).toBe(HOME_ROUTE);
    expect(resolvePostLoginTarget('../admin')).toBe(HOME_ROUTE);
  });

  it('never sends the user back to the login page (loop guard)', () => {
    expect(resolvePostLoginTarget('/login')).toBe(HOME_ROUTE);
    expect(resolvePostLoginTarget('/login?next=/bonus')).toBe(HOME_ROUTE);
    expect(resolvePostLoginTarget('/login/whatever')).toBe(HOME_ROUTE);
  });
});

describe('isSafeInternalPath', () => {
  it('accepts single-leading-slash internal paths', () => {
    expect(isSafeInternalPath('/')).toBe(true);
    expect(isSafeInternalPath('/bonus')).toBe(true);
    expect(isSafeInternalPath('/a/b/c?q=1#h')).toBe(true);
  });

  it('rejects empty, null, undefined', () => {
    expect(isSafeInternalPath('')).toBe(false);
    expect(isSafeInternalPath(null)).toBe(false);
    expect(isSafeInternalPath(undefined)).toBe(false);
  });

  it('rejects host-changing forms', () => {
    expect(isSafeInternalPath('//host')).toBe(false);
    expect(isSafeInternalPath('/\\host')).toBe(false);
    expect(isSafeInternalPath('https://host')).toBe(false);
    expect(isSafeInternalPath('relative')).toBe(false);
  });
});
