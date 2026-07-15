// ADR-0046 Amendment 4 — inline-preview allowlist for the AP attachment route.
// The route decides inline eligibility SERVER-SIDE off the stored content_type:
// pdf / png / jpeg / webp get an inline presigned URL; everything else stays a
// plain download. Placeholder / non-file keys still 409; missing → 404.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const signApAttachmentDownload = vi.fn<(k: string, o?: unknown) => Promise<string | null>>(
  async () => 'https://acc.r2.cloudflarestorage.com/x?sig=1',
);

vi.mock('@/lib/prisma', () => ({
  prisma: { apAttachment: { findFirst: (a: unknown) => findFirst(a) } },
}));
vi.mock('@/lib/ap/approvers', () => ({ requireApApprover: vi.fn(async () => ({})) }));
vi.mock('@/lib/r2', () => ({
  signApAttachmentDownload: (k: string, o: unknown) => signApAttachmentDownload(k, o),
}));

import { GET } from './route';

function call(id = 'req-1', attId = 'att-1'): Promise<Response> {
  return GET(new Request('http://127.0.0.1:3000/x'), {
    params: Promise.resolve({ id, attId }),
  });
}

beforeEach(() => {
  findFirst.mockReset();
  signApAttachmentDownload.mockClear();
});

describe('GET /api/ops/ap/[id]/attachment/[attId] — inline allowlist', () => {
  for (const ct of ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']) {
    it(`signs an INLINE url for ${ct}`, async () => {
      findFirst.mockResolvedValue({
        kind: 'file',
        storage_key: 'ap/req-1/att-1/f',
        content_type: ct,
      });
      const res = await call();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.inline).toBe(true);
      expect(body.contentType).toBe(ct);
      expect(signApAttachmentDownload).toHaveBeenCalledWith(
        'ap/req-1/att-1/f',
        expect.objectContaining({ inline: true, contentType: ct }),
      );
    });
  }

  it('keeps a plain (non-inline) download for a non-allowlisted type', async () => {
    findFirst.mockResolvedValue({
      kind: 'file',
      storage_key: 'ap/req-1/att-1/f',
      content_type: 'application/octet-stream',
    });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inline).toBe(false);
    expect(signApAttachmentDownload).toHaveBeenCalledWith(
      'ap/req-1/att-1/f',
      expect.objectContaining({ inline: false }),
    );
  });

  it('409s a reference_link (never fetched)', async () => {
    findFirst.mockResolvedValue({ kind: 'reference_link', storage_key: null, content_type: null });
    expect((await call()).status).toBe(409);
    expect(signApAttachmentDownload).not.toHaveBeenCalled();
  });

  it('409s a placeholder key (signer returns null)', async () => {
    findFirst.mockResolvedValue({
      kind: 'file',
      storage_key: 'pending-r2-ap-x.pdf',
      content_type: 'application/pdf',
    });
    signApAttachmentDownload.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(409);
  });

  it('404s an unknown attachment', async () => {
    findFirst.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
