// ADR-0049 — Graph Files transport contract tests. The MOCK is the tested path
// (no creds in CI); the live transport is correctness-by-review. Also covers
// `readGraphFilesConfig` fallback to the shared MSGRAPH_MAIL_* creds (D6).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockFilesTransport } from './mock-transport';
import { buildFixtureWorkbookBytes } from './__fixtures__/workbook';
import { FilesForbiddenError, readGraphFilesConfig } from './transport';

const UPN = 'kelsey_ruhland@svdp.us';

describe('mockFilesTransport', () => {
  it('lists a folder, resolves a file by name (case-insensitive), and downloads bytes', async () => {
    const bytes = await buildFixtureWorkbookBytes();
    const t = mockFilesTransport({ files: [{ id: 'f1', name: 'JUNE 2026 DAILY LOG WOODLAND.xlsm', ctag: 'c1', bytes }] });

    const listed = await t.listFolder(UPN, '');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.ctag).toBe('c1');

    const found = await t.getFile(UPN, '', 'june 2026 daily log woodland.xlsm');
    expect(found?.id).toBe('f1');

    const dl = await t.downloadFile(UPN, 'f1');
    expect(dl.length).toBe(bytes.length);
    expect(t.downloadCount).toBe(1);
  });

  it('returns null for a not-yet-created month file (D5), never throws', async () => {
    const t = mockFilesTransport({ files: [] });
    expect(await t.getFile(UPN, '', 'JULY 2026 DAILY LOG WOODLAND.xlsm')).toBeNull();
    expect(await t.listFolder(UPN, '')).toEqual([]);
  });

  it('throws FilesForbiddenError from every method when the grant is missing (D6)', async () => {
    const t = mockFilesTransport({ forbidden: true });
    await expect(t.listFolder(UPN, '')).rejects.toBeInstanceOf(FilesForbiddenError);
    await expect(t.getFile(UPN, '', 'x.xlsm')).rejects.toBeInstanceOf(FilesForbiddenError);
    await expect(t.downloadFile(UPN, 'f1')).rejects.toBeInstanceOf(FilesForbiddenError);
  });

  it('setFile mutates bytes + ctag in place (simulates an edit between polls)', async () => {
    const v1 = await buildFixtureWorkbookBytes();
    const t = mockFilesTransport({ files: [{ id: 'f1', name: 'x.xlsm', ctag: 'c1', bytes: v1 }] });
    t.setFile('x.xlsm', new Uint8Array([1, 2, 3]), 'c2');
    const f = await t.getFile(UPN, '', 'x.xlsm');
    expect(f?.ctag).toBe('c2');
    expect(f?.id).toBe('f1'); // id is stable across an in-place edit
  });
});

describe('readGraphFilesConfig', () => {
  const KEYS = [
    'MSGRAPH_FILES_TENANT_ID', 'MSGRAPH_FILES_CLIENT_ID', 'MSGRAPH_FILES_SECRET',
    'MSGRAPH_MAIL_TENANT_ID', 'MSGRAPH_MAIL_CLIENT_ID', 'MSGRAPH_MAIL_SECRET',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns null when nothing is set (mock selection signal)', () => {
    expect(readGraphFilesConfig()).toBeNull();
  });

  it('falls back to the shared MSGRAPH_MAIL_* creds (one app, two capabilities — D6)', () => {
    process.env['MSGRAPH_MAIL_TENANT_ID'] = 't';
    process.env['MSGRAPH_MAIL_CLIENT_ID'] = 'c';
    process.env['MSGRAPH_MAIL_SECRET'] = 's';
    expect(readGraphFilesConfig()).toEqual({ tenantId: 't', clientId: 'c', secret: 's' });
  });

  it('prefers the Files-specific creds when present', () => {
    process.env['MSGRAPH_MAIL_TENANT_ID'] = 'mail-t';
    process.env['MSGRAPH_FILES_TENANT_ID'] = 'files-t';
    process.env['MSGRAPH_FILES_CLIENT_ID'] = 'c';
    process.env['MSGRAPH_FILES_SECRET'] = 's';
    expect(readGraphFilesConfig()?.tenantId).toBe('files-t');
  });
});
