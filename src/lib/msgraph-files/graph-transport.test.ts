// ADR-0102 — the LIVE Graph transport, against a double that models `$select`.
//
// ── Why this file exists ────────────────────────────────────────────────────
// `graph-transport.ts` shipped with the comment "UNTESTED by unit tests (no creds
// in CI); the mock is the tested path". The mock (`mock-transport.ts`) stores
// ready-made `DriveFile` objects and hands them back, so it models the SHAPE of
// the transport's output and nothing about Graph's request semantics. It is
// strictly more permissive than the real dependency, and a mock more permissive
// than the thing it stands in for cannot fail on the bug it should catch.
//
// It did not catch this one: `FILE_SELECT` omitted the `file` facet, and
// `$select` returns ONLY the properties you name. So `raw.file` was always
// `undefined`, `toDriveFile()` read that as "folder, not a file" and returned
// null for EVERY item, `listFolder` returned zero files for every folder in
// every drive, and `getFile` was structurally incapable of ever finding
// anything. DR3 Woodland polled 1098 times between 2026-07-31 and 2026-08-12
// and recorded `not_found` 1098 times — "last successful read NEVER" — while
// the workbook sat in the folder the whole time.
//
// The fetch double below therefore HONOURS `$select`: it returns only the
// properties the caller asked for, exactly as Graph does. That single fidelity
// detail is the whole point of the file — with it, the bug is a red test.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: class {
    async getToken() {
      return { token: 'test-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  },
}));

import { graphFilesTransport } from './graph-transport';
import { FilesContractDriftError, FilesForbiddenError } from './transport';

const CONFIG = { tenantId: 't', clientId: 'c', secret: 's' };

/** A driveItem as Graph stores it, before `$select` narrowing. */
const STORED = [
  {
    id: 'f1',
    name: 'MRC Billing',
    folder: { childCount: 2 },
    cTag: 'c1',
    size: 0,
    lastModifiedDateTime: '2026-08-01T00:00:00Z',
  },
  {
    id: 'f2',
    name: 'Uploads',
    folder: { childCount: 0 },
    cTag: 'c2',
    size: 0,
    lastModifiedDateTime: '2026-08-01T00:00:00Z',
  },
  {
    id: 'f3',
    name: 'AUGUST 2026 DAILY LOG WOODLAND.xlsm',
    file: { mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12' },
    cTag: 'c3',
    size: 710386,
    lastModifiedDateTime: '2026-08-12T02:45:57Z',
  },
];

let lastUrl = '';

/**
 * Graph's `$select` contract: the response carries ONLY the named properties.
 * Modelling this is the difference between a test that can fail and one that
 * cannot — omit it and every item keeps its `file` facet for free, which is
 * precisely the false comfort the old mock provided.
 */
function selectNarrow(item: Record<string, unknown>, select: string | null) {
  if (!select) return { ...item };
  const keep = new Set(select.split(',').map((s) => s.trim()));
  return Object.fromEntries(Object.entries(item).filter(([k]) => keep.has(k)));
}

function installFetch(opts: { status?: number; items?: Record<string, unknown>[] } = {}) {
  const items = opts.items ?? STORED;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      lastUrl = String(url);
      if (opts.status && opts.status !== 200) {
        return new Response('{}', { status: opts.status });
      }
      const select = new URL(String(url)).searchParams.get('$select');
      const value = items.map((i) => selectNarrow(i, select));
      return new Response(JSON.stringify({ value }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  lastUrl = '';
  vi.unstubAllGlobals();
});

describe('listFolder — the $select facet regression (ADR-0102)', () => {
  it('returns the FILE in a folder that also holds subfolders', async () => {
    // The whole bug in one assertion. Against the shipped `FILE_SELECT` this is
    // `[]`, because every item lost its `file` facet on the way back.
    installFetch();
    const t = graphFilesTransport(CONFIG);
    const files = await t.listFolder('kelsey.ruhland@svdp.us', 'DR3/Woodland');

    expect(files.map((f) => f.name)).toEqual(['AUGUST 2026 DAILY LOG WOODLAND.xlsm']);
    expect(files[0]?.id).toBe('f3');
    expect(files[0]?.ctag).toBe('c3');
    expect(files[0]?.size).toBe(710386);
  });

  it('asks Graph for the `file` facet it branches on', async () => {
    // `toDriveFile` decides file-vs-folder from `raw.file`. Selecting a field set
    // that omits it is self-defeating, so pin the request itself — this fails on
    // the shipped select even if a future refactor makes the mapping lenient.
    installFetch();
    await graphFilesTransport(CONFIG).listFolder('u@e.com', 'p');

    const select = new URL(lastUrl).searchParams.get('$select') ?? '';
    expect(select.split(',')).toContain('file');
    expect(select.split(',')).toContain('folder');
  });

  it('finds the file case-insensitively through getFile', async () => {
    installFetch();
    const t = graphFilesTransport(CONFIG);
    const hit = await t.getFile('u@e.com', 'p', 'august 2026 daily log woodland.XLSM');
    expect(hit?.id).toBe('f3');
  });

  it('returns null from getFile for a name that genuinely is not there', async () => {
    // The honest not_found, which must still work.
    installFetch();
    const t = graphFilesTransport(CONFIG);
    expect(await t.getFile('u@e.com', 'p', 'SEPTEMBER 2026 DAILY LOG WOODLAND.xlsm')).toBeNull();
  });
});

describe('listFolder — a silent zero must become a loud one', () => {
  it('THROWS when items come back carrying neither facet, instead of reporting an empty folder', async () => {
    // This is the shape of the defect itself: the response had three items and
    // the transport reported zero files, indistinguishable from an empty folder,
    // for six weeks. If the select is ever dropped again, fail loudly — a
    // subsystem whose failure mode is "nothing here" cannot be debugged.
    installFetch({ items: STORED.map(({ id, name, cTag, size }) => ({ id, name, cTag, size })) });
    const t = graphFilesTransport(CONFIG);
    await expect(t.listFolder('u@e.com', 'p')).rejects.toBeInstanceOf(FilesContractDriftError);
  });

  it('still reports a genuinely EMPTY folder as empty, not as drift', async () => {
    // The guard must not cry wolf on the legitimate case.
    installFetch({ items: [] });
    await expect(graphFilesTransport(CONFIG).listFolder('u@e.com', 'p')).resolves.toEqual([]);
  });

  it('treats a 404 as an empty folder (D5: a missing month is a no-op)', async () => {
    installFetch({ status: 404 });
    await expect(graphFilesTransport(CONFIG).listFolder('u@e.com', 'p')).resolves.toEqual([]);
  });

  it('surfaces a 403 as FilesForbiddenError rather than an empty folder', async () => {
    installFetch({ status: 403 });
    await expect(graphFilesTransport(CONFIG).listFolder('u@e.com', 'p')).rejects.toBeInstanceOf(
      FilesForbiddenError,
    );
  });
});
