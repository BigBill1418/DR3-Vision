// ADR-0046 C3/C9-D2/C10.4 — sender validation modes.

import { describe, expect, it } from 'vitest';
import { domainOf, isInternal, validateSender, type SenderPolicy } from './senders';

const tenantWide: SenderPolicy = { mode: 'tenant_wide', internalDomain: 'svdp.us', explicitAllow: new Set() };
const explicit: SenderPolicy = {
  mode: 'explicit_list',
  internalDomain: 'svdp.us',
  explicitAllow: new Set(['mary@svdp.us', 'morena@svdp.us']),
};

describe('domainOf / isInternal', () => {
  it('extracts the lowercased domain', () => {
    expect(domainOf('Morena@SVDP.us')).toBe('svdp.us');
    expect(domainOf('malformed')).toBe('');
  });
  it('isInternal matches the tenant domain only', () => {
    expect(isInternal('a@svdp.us', 'svdp.us')).toBe(true);
    expect(isInternal('a@vendor.example', 'svdp.us')).toBe(false);
  });
});

describe('validateSender — tenant_wide', () => {
  it('accepts any internal sender', () => {
    expect(validateSender('janette@svdp.us', tenantWide)).toEqual({ valid: true });
  });
  it('quarantines an external sender (external_sender)', () => {
    expect(validateSender('billing@vendor.example', tenantWide)).toEqual({ valid: false, reason: 'external_sender' });
  });
  it('C10.4 — a forward from an internal forwarder is valid regardless of the vendor address in the body', () => {
    // The vendor address is body context only; here the ENVELOPE sender is internal.
    expect(validateSender('MORENA@svdp.us', tenantWide)).toEqual({ valid: true });
  });
});

describe('validateSender — explicit_list', () => {
  it('accepts a listed address', () => {
    expect(validateSender('mary@svdp.us', explicit)).toEqual({ valid: true });
  });
  it('quarantines an internal-but-unlisted address (not_in_explicit_list)', () => {
    expect(validateSender('janette@svdp.us', explicit)).toEqual({ valid: false, reason: 'not_in_explicit_list' });
  });
  it('quarantines an external address', () => {
    expect(validateSender('billing@vendor.example', explicit)).toEqual({ valid: false, reason: 'not_in_explicit_list' });
  });
});
