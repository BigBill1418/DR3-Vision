// ADR-0067 §3.4 — the admin gate and failure taxonomy of POST
// /api/admin/doc-ingest/register.
//
// The authorization test is the load-bearing one. This route registers a source
// whose `site_id` is NULL — UNCLASSIFIED, never "both" (hard rule #2) — so a
// non-admin reaching it would both create an unscoped row and hand a
// site-scoped user a lever over the tenant-wide document pipeline. The gate has
// to be asserted, not assumed from a copied `requireAdmin()` line.
//
// The rest asserts that the four failures stay APART. A single "couldn't add
// it" would be true of all of them and actionable for none.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveMock, registerMock, auditMock } = vi.hoisted(() => ({
  resolveMock: vi.fn(),
  registerMock: vi.fn(),
  // Typed generically rather than by an unused parameter, so `mock.calls[0]` is
  // a real tuple under `noUncheckedIndexedAccess` and the assertions below can
  // read the audit payload.
  auditMock: vi.fn<(args: unknown) => Promise<void>>(async () => undefined),
}));

let mockSession: { user: { id: string; role: string; email?: string; name?: string } } | null =
  null;

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => mockSession) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: auditMock }));
vi.mock('@/lib/doc-ingest/discovery', () => ({ registerSharedItem: registerMock }));

// The REAL error classes, so the route's `instanceof` mapping is exercised
// rather than restated. Only the client factory is replaced.
vi.mock('@/lib/doc-ingest/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/doc-ingest/graph')>();
  return { ...actual, docIngestGraph: () => ({ resolveSharingUrl: resolveMock }) };
});

import {
  DocIngestAccessDeniedError,
  DocIngestGraphError,
  DocIngestNotFoundError,
  DocIngestSharingUrlError,
} from '@/lib/doc-ingest/graph';
import { POST } from '@/app/api/admin/doc-ingest/register/route';

const LINK = 'https://svdp.sharepoint.com/:x:/g/personal/docs_dr3_svdp_us/Ab12?e=xyz';

function post(body: unknown): Request {
  return new Request('https://dr3-vision.svdp.us/api/admin/doc-ingest/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const RESOLVED = {
  id: 'item-9',
  driveId: 'drive-Z',
  name: 'Attachment.xlsx',
  isFolder: false,
  webUrl: LINK,
  ctag: null,
  etag: null,
  size: 1024,
  contentType: null,
  lastModifiedAt: null,
  lastModifiedBy: null,
  ownerUpn: 'kelsey@svdp.us',
  createdByUpn: 'kelsey@svdp.us',
  sharedOwnerUpn: null,
  parentItemId: null,
  parentPath: null,
  deleted: false,
};

beforeEach(() => {
  mockSession = { user: { id: 'admin-1', role: 'admin' } };
  resolveMock.mockReset();
  registerMock.mockReset();
  auditMock.mockClear();
});

describe('authorization', () => {
  it('rejects an unauthenticated caller with 401 and never touches Graph', async () => {
    mockSession = null;
    const res = await POST(post({ url: LINK }));
    expect(res.status).toBe(401);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('rejects a NON-ADMIN caller with 403 and never touches Graph', async () => {
    mockSession = { user: { id: 'mgr-1', role: 'manager' } };
    const res = await POST(post({ url: LINK }));
    expect(res.status).toBe(403);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(registerMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('rejects an operator too — /admin powers are admin, never all_sites', async () => {
    mockSession = { user: { id: 'op-1', role: 'operator' } };
    expect((await POST(post({ url: LINK }))).status).toBe(403);
    expect(registerMock).not.toHaveBeenCalled();
  });
});

describe('request validation', () => {
  it('400s on a missing url without calling Graph', async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('400s on a non-JSON body', async () => {
    const res = await POST(
      new Request('https://dr3-vision.svdp.us/api/admin/doc-ingest/register', {
        method: 'POST',
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('the failure taxonomy stays apart', () => {
  it('an unrecognized link → 400 with the operator sentence, not a generic error', async () => {
    resolveMock.mockRejectedValue(
      new DocIngestSharingUrlError('Microsoft did not recognize that link.'),
    );
    const res = await POST(post({ url: LINK }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('unrecognized_url');
    expect(body.message).toContain('did not recognize');
  });

  it('never shared with the service account → 403 naming the fix', async () => {
    resolveMock.mockRejectedValue(new DocIngestAccessDeniedError('the document'));
    const res = await POST(post({ url: LINK }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('access_denied');
    // The operator can only act if the message names the account to share with.
    expect(body.message).toContain('docs-dr3@svdp.us');
  });

  it('deleted or revoked → 404, NOT folded into access_denied', async () => {
    resolveMock.mockRejectedValue(new DocIngestNotFoundError('the document'));
    const res = await POST(post({ url: LINK }));
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'not_found' });
  });

  it('a transient Graph failure → 502, and nothing is registered or audited', async () => {
    resolveMock.mockRejectedValue(new DocIngestGraphError('graph 500', 500));
    const res = await POST(post({ url: LINK }));
    expect(res.status).toBe(502);
    expect(registerMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('the success path', () => {
  it('registers through the discovery path and writes an audit row', async () => {
    resolveMock.mockResolvedValue(RESOLVED);
    registerMock.mockResolvedValue({
      id: 'src-1',
      driveId: 'drive-Z',
      itemId: 'item-9',
      displayName: 'Attachment.xlsx',
      ownerUpn: 'kelsey@svdp.us',
      webUrl: LINK,
      kind: 'file',
      created: true,
    });

    const res = await POST(post({ url: LINK }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      created: true,
      sourceId: 'src-1',
      name: 'Attachment.xlsx',
      ownerUpn: 'kelsey@svdp.us',
    });

    // Registration goes through the SAME upsert discovery uses, so
    // classification, the guardrail and the kill switch behave identically.
    expect(registerMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), RESOLVED);

    expect(auditMock).toHaveBeenCalledTimes(1);
    const audit = auditMock.mock.calls[0]?.[0] as unknown as {
      actor_user_id: string;
      action: string;
      table_name: string;
      row_id: string;
      after: Record<string, unknown>;
    };
    expect(audit.actor_user_id).toBe('admin-1');
    expect(audit.action).toBe('insert');
    expect(audit.table_name).toBe('doc_sources');
    expect(audit.row_id).toBe('src-1');
    // Provenance is the whole point: this source was asked for by a named admin,
    // not found by an enumeration.
    expect(audit.after['registered_via']).toBe('sharing_url');
  });

  it('an already-watched document audits as an update, not a second insert', async () => {
    resolveMock.mockResolvedValue(RESOLVED);
    registerMock.mockResolvedValue({
      id: 'src-1',
      driveId: 'drive-Z',
      itemId: 'item-9',
      displayName: 'Attachment.xlsx',
      ownerUpn: 'kelsey@svdp.us',
      webUrl: LINK,
      kind: 'file',
      created: false,
    });

    const res = await POST(post({ url: LINK }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: false });
    const audit = auditMock.mock.calls[0]?.[0] as unknown as {
      action: string;
      after: Record<string, unknown>;
    };
    expect(audit.action).toBe('update');
    expect(audit.after['already_registered']).toBe(true);
  });

  it('leaks nothing from a store failure', async () => {
    resolveMock.mockResolvedValue(RESOLVED);
    registerMock.mockRejectedValue(new Error('relation "doc_sources" does not exist'));

    const res = await POST(post({ url: LINK }));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('doc_sources');
  });
});
