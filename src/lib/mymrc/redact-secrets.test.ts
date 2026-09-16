// ADR-0133 — the page that carried the session cookie.
//
// Every fixture below is SYNTHESISED. The real 2026-09-16 values (a live
// Salesforce `sid`, `sid_Client`, `oid`, `BrowserId` and `renderCtx` for Bill's
// MyMRC admin session) are not reproduced anywhere in this repo — that is the
// whole point of the incident. The SHAPES are reproduced exactly, because a
// redactor tested against a shape it will never meet is a redactor that proves
// nothing.

import { describe, expect, it } from 'vitest';
import { redactSecrets, REDACTED, REDACTION_PATTERNS } from './redact-secrets';

/**
 * The shape of the string that reached Bill's phone, the ntfy server's 7-day
 * cache, `mymrc_sync_runs.error` and docker stdout on 2026-09-16 04:02 PT:
 * Playwright's full call log for a timed-out Aura POST, headers included.
 */
const LEAKED_CALL_LOG = [
  'apiRequestContext.post: Timeout 45000ms exceeded.',
  'Call log:',
  '  - → POST https://mymrc.example.force.com/s/sfsites/aura?r=7&other.RecordUi.getRecordWithFields=1',
  '  -   user-agent: Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/140.0.0.0 Safari/537.36',
  '  -   accept: */*',
  '  -   accept-encoding: gzip,deflate,br',
  '  -   content-type: application/x-www-form-urlencoded',
  '  -   content-length: 4312',
  '  -   x-sfdc-request-id: dr3-backfill',
  '  -   cookie: BrowserId=FAKEbrowseridFAKEvalue; sid=00Dxx0000000FAKE!AQEAQFAKEsessionFAKEtokenFAKE0000; sid_Client=00FAKEclientFAKEid; oid=00Dxx0000000FAKE; renderCtx=%7B%22pageId%22%3A%22fake%22%7D',
  '  -   authorization: Bearer FAKEbearerFAKEtokenFAKEvalue',
].join('\n');

describe('redactSecrets — the 2026-09-16 Playwright call log', () => {
  const out = redactSecrets(LEAKED_CALL_LOG);

  // PROVING THE FIXTURE IS THE SUBJECT. Without this, a typo'd fixture would make
  // every `not.toContain` below vacuously green — the trap `adr-record-integrity`
  // documents about guards whose failure mode is silence.
  it('the fixture really does carry the leak (so the assertions below can fail)', () => {
    expect(LEAKED_CALL_LOG).toContain('sid=');
    expect(LEAKED_CALL_LOG).toContain('cookie:');
    expect(LEAKED_CALL_LOG).toMatch(/00D[0-9A-Za-z]{12,15}!/);
    expect(LEAKED_CALL_LOG).toContain('Bearer');
  });

  it('drops the header block entirely', () => {
    expect(out).not.toContain('cookie:');
    expect(out).not.toContain('user-agent:');
    expect(out).not.toContain('authorization:');
    expect(out).not.toContain('x-sfdc-request-id:');
    expect(out).not.toContain('content-type:');
    expect(out).not.toContain('accept-encoding:');
  });

  it('leaves no session material of any shape behind', () => {
    expect(out).not.toContain('sid=');
    expect(out).not.toContain('sid_Client=');
    expect(out).not.toContain('oid=');
    expect(out).not.toContain('BrowserId=');
    expect(out).not.toContain('renderCtx=');
    expect(out).not.toMatch(/00D[0-9A-Za-z]{12,15}!/);
    expect(out).not.toContain('Bearer');
  });

  it('keeps the first line — the diagnosis lives there', () => {
    expect(out.split('\n')[0]).toBe('apiRequestContext.post: Timeout 45000ms exceeded.');
  });

  it('keeps the request line and its query string — which endpoint timed out', () => {
    expect(out).toContain(
      '→ POST https://mymrc.example.force.com/s/sfsites/aura?r=7&other.RecordUi.getRecordWithFields=1',
    );
  });

  it('says how many lines it removed rather than deleting them silently', () => {
    expect(out).toContain('8 header line(s) redacted');
  });

  it('is idempotent', () => {
    expect(redactSecrets(out)).toBe(out);
  });
});

describe('redactSecrets — masking anywhere in any text', () => {
  it('masks a Salesforce session id wherever it appears', () => {
    const out = redactSecrets('resumed with sid=00Dxx0000000FAKE!AQEAQFAKEsessionFAKEtoken0000 ok');
    expect(out).toContain(`sid=${REDACTED}`);
    expect(out).not.toMatch(/00D[0-9A-Za-z]{12,15}!/);
  });

  it('masks each named cookie key in a one-line cookie blob', () => {
    const out = redactSecrets(
      'headers={BrowserId=abc123def456; sid_Client=00FAKEclient; oid=00Dxx0000000FAKE; renderCtx=%7B%22a%22%3A1%7D}',
    );
    expect(out).toBe(
      `headers={BrowserId=${REDACTED}; sid_Client=${REDACTED}; oid=${REDACTED}; renderCtx=${REDACTED}}`,
    );
  });

  it('masks sid_Client without leaving a bare _Client fragment', () => {
    expect(redactSecrets('sid_Client=abc')).toBe(`sid_Client=${REDACTED}`);
  });

  it('masks an Authorization bearer, keeping the header name', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOi.FAKE.token')).toBe(
      `Authorization: ${REDACTED}`,
    );
  });

  it('masks a password in a form body', () => {
    expect(redactSecrets('username=bill%40example.test&password=FAKEpw123&next=/s/')).toBe(
      `username=bill%40example.test&password=${REDACTED}&next=/s/`,
    );
  });

  it('masks a Set-Cookie value on its own line', () => {
    expect(redactSecrets('Set-Cookie: sid=00Dxx0000000FAKE!AQEfake; Path=/')).toBe(
      `Set-Cookie: ${REDACTED}`,
    );
  });

  it('masks a cookie line that is NOT inside a Playwright call log', () => {
    const out = redactSecrets(
      'request failed\ncookie: sid=00Dxx0000000FAKE!AQEfakefakefakefake1\n',
    );
    expect(out).not.toContain('00Dxx');
    expect(out).toContain(`cookie: ${REDACTED}`);
  });

  it('is idempotent on every masked form', () => {
    for (const input of [
      'sid=00Dxx0000000FAKE!AQEfakefakefakefake1',
      'Authorization: Bearer abc.def',
      'cookie: a=b; c=d',
      'password=hunter2',
    ]) {
      const once = redactSecrets(input);
      expect(redactSecrets(once)).toBe(once);
    }
  });
});

describe('redactSecrets — safe on ordinary text', () => {
  it('leaves an ordinary sync error untouched', () => {
    const msg =
      'mirror not current: newest processed record is 2026-09-10 (5.2d behind); listed=800 details=0 complete=false';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('leaves prose bullets alone when there is no Playwright call log', () => {
    const msg = 'wedged:\n  - reason: portal never returned hasMoreData:false\n  - page: 7';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('does not eat identifiers that merely contain a key name', () => {
    const msg = 'Rate_ID__c=abc and Record_oid_ref=xyz and asid=1';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('handles empty and whitespace input', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets('   ')).toBe('   ');
  });
});

describe('the pattern list is documented, not incidental', () => {
  it('every pattern records what it matched in the 2026-09-16 leak', () => {
    expect(REDACTION_PATTERNS.length).toBeGreaterThan(0);
    for (const p of REDACTION_PATTERNS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.leaked.length).toBeGreaterThan(0);
    }
  });
});
