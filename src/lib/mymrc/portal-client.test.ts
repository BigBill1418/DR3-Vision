import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AuthFailedError,
  PortalContractDriftError,
  extractListRecordIds,
  extractRecord,
  looksLoggedOut,
  parseAuraActions,
} from './portal-client';

import envelopeGetItems from './__fixtures__/aura-envelope-getitems-processed.json';
import haulRecord from './__fixtures__/aura-getrecord-haul.json';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

const envelopeBody = JSON.stringify(envelopeGetItems);
const haulRecordBody = JSON.stringify({ actions: [{ state: 'SUCCESS', returnValue: haulRecord }] });

describe('parseAuraActions', () => {
  it('extracts the actions array from a well-formed envelope', () => {
    const actions = parseAuraActions(envelopeBody);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]?.state).toBe('SUCCESS');
  });

  it('returns [] for non-JSON or actionless bodies', () => {
    expect(parseAuraActions('<html>not json</html>')).toEqual([]);
    expect(parseAuraActions('{"context":{}}')).toEqual([]);
  });
});

describe('extractListRecordIds', () => {
  it('pulls record ids from a real intercepted getItems envelope', () => {
    const ids = extractListRecordIds([envelopeBody], 'processed');
    expect(ids[0]).toBe('a2LUJ000001N4gf2AC');
    expect(ids.length).toBe(5);
  });

  it('throws PortalContractDriftError when no getItems action is present (never a silent empty)', () => {
    expect(() => extractListRecordIds(['{"actions":[]}'], 'hauls')).toThrow(
      PortalContractDriftError,
    );
    expect(() => extractListRecordIds([], 'hauls')).toThrow(/no ListViewDataManager/);
  });

  it('throws drift when the list view is an error view', () => {
    const errView = JSON.stringify({
      actions: [{ state: 'SUCCESS', returnValue: { recordIdActionsList: [], isErrorListView: true } }],
    });
    expect(() => extractListRecordIds([errView], 'processed')).toThrow(/isErrorListView/);
  });
});

describe('extractRecord', () => {
  it('locates the RecordRepresentation for an id (even nested in an envelope)', () => {
    const rec = extractRecord([haulRecordBody], 'a2KUJ00000G6id32AB');
    expect(rec.apiName).toBe('Haul_Request__c');
    expect(rec.fields['Name']?.value).toBe('H-133323');
  });

  it('throws PortalContractDriftError when the record id is absent', () => {
    expect(() => extractRecord([haulRecordBody], 'does-not-exist')).toThrow(
      PortalContractDriftError,
    );
  });
});

describe('looksLoggedOut (ADR-0038 D4 hardening)', () => {
  it('flags the 404 / expired-session error page the old scraper mis-read as ok', () => {
    expect(
      looksLoggedOut({ url: 'https://mrc-us.my.site.com/s/hauls', html: fixture('login-404-page.html'), usernameFieldVisible: false }),
    ).toBe(true);
  });

  it('flags a rendered login form even when the URL looks like an app route', () => {
    expect(
      looksLoggedOut({ url: 'https://mrc-us.my.site.com/s/hauls', html: fixture('login-form-page.html'), usernameFieldVisible: false }),
    ).toBe(true);
  });

  it('flags the /s/login URL and a visible username field directly', () => {
    expect(looksLoggedOut({ url: 'https://mrc-us.my.site.com/s/login/', html: '', usernameFieldVisible: false })).toBe(true);
    expect(looksLoggedOut({ url: 'https://mrc-us.my.site.com/s/hauls', html: '', usernameFieldVisible: true })).toBe(true);
  });

  it('does NOT flag an authenticated shell', () => {
    expect(
      looksLoggedOut({ url: 'https://mrc-us.my.site.com/s/hauls', html: fixture('authed-shell.html'), usernameFieldVisible: false }),
    ).toBe(false);
  });
});

describe('typed errors', () => {
  it('carry stable names for fingerprinting', () => {
    expect(new AuthFailedError('x').name).toBe('AuthFailedError');
    expect(new PortalContractDriftError('y').name).toBe('PortalContractDriftError');
    expect(new AuthFailedError('x')).toBeInstanceOf(Error);
  });
});
