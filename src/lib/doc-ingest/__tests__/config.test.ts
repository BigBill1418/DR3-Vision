// ADR-0067 Amendment A §A.1/§A.3 — provisioned identity and the scope contract.
//
// The scope-diff tests exist because Entra returns scopes inconsistently —
// sometimes bare (`Files.Read.All`), sometimes fully qualified
// (`https://graph.microsoft.com/Files.Read.All`) — and a naive string compare
// reports a MISSING grant that is in fact present. A false "missing
// permissions" banner on the connect page would send the operator to re-consent
// an app that is already correctly consented.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOC_INGEST_CLIENT_ID,
  DOC_INGEST_REQUIRED_GRAPH_SCOPES,
  DOC_INGEST_SERVICE_OBJECT_ID,
  DOC_INGEST_SERVICE_UPN,
  DOC_INGEST_TENANT_ID,
  docIngestRedirectUri,
  missingRequiredScopes,
  normalizeScope,
  parseScopes,
  readClientSecret,
} from '../config';

describe('provisioned values (§A.1)', () => {
  it('pins the tenant, client, service account and object id verified live', () => {
    expect(DOC_INGEST_TENANT_ID).toBe('72843ea8-e50d-4500-a0d5-d924e9acb4d5');
    expect(DOC_INGEST_CLIENT_ID).toBe('2da92424-7397-435d-96a1-d2a382293a53');
    expect(DOC_INGEST_SERVICE_UPN).toBe('docs-dr3@svdp.us');
    expect(DOC_INGEST_SERVICE_OBJECT_ID).toBe('7ad08443-3d96-400e-9e4d-0c34208305e2');
  });

  it('defaults the redirect URI to the REGISTERED value, not the request host', () => {
    // A host-derived redirect both mismatches behind the Cloudflare tunnel and
    // is an open-redirect shape. It is a constant on purpose.
    const original = process.env['DOC_INGEST_REDIRECT_URI'];
    delete process.env['DOC_INGEST_REDIRECT_URI'];
    try {
      expect(docIngestRedirectUri()).toBe(
        'https://dr3-vision.svdp.us/api/admin/doc-ingest/oauth/callback',
      );
    } finally {
      if (original !== undefined) process.env['DOC_INGEST_REDIRECT_URI'] = original;
    }
  });
});

describe('scope normalization', () => {
  it('strips the Graph resource prefix', () => {
    expect(normalizeScope('https://graph.microsoft.com/Files.Read.All')).toBe('files.read.all');
  });

  it('is case-insensitive', () => {
    expect(normalizeScope('FILES.READ.ALL')).toBe(normalizeScope('files.read.all'));
  });

  it('splits and drops blanks', () => {
    expect(parseScopes('  Files.Read.All   Sites.Read.All ')).toEqual([
      'files.read.all',
      'sites.read.all',
    ]);
    expect(parseScopes('')).toEqual([]);
  });
});

describe('missingRequiredScopes', () => {
  it('reports nothing missing for the live tenant grant, bare form', () => {
    expect(missingRequiredScopes('Files.Read.All Sites.Read.All User.Read')).toEqual([]);
  });

  it('reports nothing missing for the FULLY QUALIFIED form — the false-negative trap', () => {
    expect(
      missingRequiredScopes(
        'https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Sites.Read.All https://graph.microsoft.com/User.Read',
      ),
    ).toEqual([]);
  });

  it('reports exactly what is absent', () => {
    expect(missingRequiredScopes('Files.Read.All User.Read')).toEqual(['Sites.Read.All']);
  });

  it('reports everything for an empty grant', () => {
    expect(missingRequiredScopes('')).toEqual([...DOC_INGEST_REQUIRED_GRAPH_SCOPES]);
  });

  it('does not require the OIDC scopes Entra never echoes back', () => {
    // openid/profile/email/offline_access are absent from the token response's
    // `scope` field by design. Requiring them here would report a PERMANENT
    // false negative on a perfectly healthy connection.
    expect(DOC_INGEST_REQUIRED_GRAPH_SCOPES).not.toContain('offline_access');
    expect(DOC_INGEST_REQUIRED_GRAPH_SCOPES).not.toContain('openid');
  });
});

describe('readClientSecret', () => {
  const OWN = process.env['DOC_INGEST_CLIENT_SECRET'];
  const MAIL = process.env['MSGRAPH_MAIL_SECRET'];

  beforeEach(() => {
    delete process.env['DOC_INGEST_CLIENT_SECRET'];
    delete process.env['MSGRAPH_MAIL_SECRET'];
  });

  afterEach(() => {
    if (OWN === undefined) delete process.env['DOC_INGEST_CLIENT_SECRET'];
    else process.env['DOC_INGEST_CLIENT_SECRET'] = OWN;
    if (MAIL === undefined) delete process.env['MSGRAPH_MAIL_SECRET'];
    else process.env['MSGRAPH_MAIL_SECRET'] = MAIL;
  });

  it('falls back to the AP mail secret — the SAME app registration', () => {
    // This fallback is the mechanism that stops anyone minting a SECOND secret
    // on an app that already has `DR3-Vision Production` valid to 2028-05-05.
    process.env['MSGRAPH_MAIL_SECRET'] = 'shared-secret';
    expect(readClientSecret()).toBe('shared-secret');
  });

  it('prefers its own secret when both are present', () => {
    process.env['DOC_INGEST_CLIENT_SECRET'] = 'own';
    process.env['MSGRAPH_MAIL_SECRET'] = 'shared';
    expect(readClientSecret()).toBe('own');
  });

  it('returns null when neither is set', () => {
    expect(readClientSecret()).toBeNull();
  });
});
