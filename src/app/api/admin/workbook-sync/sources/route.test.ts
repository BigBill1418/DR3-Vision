// ADR-0130 D10 — the admin surface refuses an untokenised month folder on save.
//
// The live Woodland row held
// `DR3/Woodland/Woodland Operations/2026 Daily Logs/August 2026 Woodland`: the month
// already expanded, no `{…}` token. ADR-0102 §5 specified the tokenised value and
// `resolveMonthlyFolderPath` implements it correctly — a string with no tokens comes
// back unchanged. The CODE shipped; the ROW never moved. So on 2026-09-01 the file
// name rolled to SEPTEMBER, the folder stayed August, and the transport asked for
// September's file inside August's folder for 393 consecutive polls.
//
// The migration re-tokenises the existing rows. This guard is what stops the shape
// being typed back in — otherwise the fix survives exactly until the next edit.

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Data = Record<string, unknown>;

let lastCreate: Data = {};
const requireAdmin = vi.fn(async () => ({ userId: 'admin-1', email: 'a@x', name: 'Admin' }));
const create = vi.fn(async (args: { data: Data }) => {
  lastCreate = args.data;
  return { id: 'src-1', ...args.data };
});
const update = vi.fn(async (args: { data: Data }) => ({ id: 'src-1', ...args.data }));

vi.mock('@/lib/auth-helpers', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: { findUnique: async () => ({ id: 'site-woodland' }) },
    workbookSource: {
      findUnique: async () => null,
      create: (a: { data: Data }) => create(a),
      update: (a: { data: Data }) => update(a),
    },
  },
}));
vi.mock('@/lib/audit', () => ({ writeAudit: async () => undefined }));

import { POST } from './route';

/** The exact production value, verified on CHAD-HQ 2026-09-07. */
const LIVE_BAD = 'DR3/Woodland/Woodland Operations/2026 Daily Logs/August 2026 Woodland';
const TOKENISED =
  'DR3/Woodland/Woodland Operations/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR} Woodland';

function post(body: Data): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/admin/workbook-sync/sources', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  );
}

beforeEach(() => {
  lastCreate = {};
  vi.clearAllMocks();
});

describe('POST /api/admin/workbook-sync/sources — ADR-0130 D10 folder guard', () => {
  it('REFUSES the exact production value that broke September', async () => {
    const res = await post({
      siteId: 'site-woodland',
      driveUpn: 'kelsey@svdp.us',
      folderPath: LIVE_BAD,
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string; detail: string };
    expect(json.error).toBe('folder_path_untokenised_month');
    // The refusal has to teach, or the operator retypes a variant of the same thing.
    expect(json.detail).toMatch(/\{MONTH_TITLE\}/);
    // Nothing was written.
    expect(create).not.toHaveBeenCalled();
    expect(lastCreate).toEqual({});
  });

  it('ACCEPTS the tokenised form ADR-0102 specified', async () => {
    const res = await post({
      siteId: 'site-woodland',
      driveUpn: 'kelsey@svdp.us',
      folderPath: TOKENISED,
    });
    expect(res.status).toBeLessThan(400);
    expect(create).toHaveBeenCalledOnce();
    expect(lastCreate['folder_path']).toBe(TOKENISED);
  });

  it('ACCEPTS a path with no month at all, including the drive root', async () => {
    expect((await post({ siteId: 's', driveUpn: 'k@x.us', folderPath: '' })).status).toBeLessThan(
      400,
    );
    vi.clearAllMocks();
    expect(
      (await post({ siteId: 's', driveUpn: 'k@x.us', folderPath: 'DR3/Woodland/Daily Logs' }))
        .status,
    ).toBeLessThan(400);
  });

  it('does not mistake a place name for a month', async () => {
    // "Augusta" is a city. A substring match would refuse a perfectly valid path.
    const res = await post({
      siteId: 's',
      driveUpn: 'k@x.us',
      folderPath: 'DR3/Augusta Operations/Daily Logs',
    });
    expect(res.status).toBeLessThan(400);
  });
});
