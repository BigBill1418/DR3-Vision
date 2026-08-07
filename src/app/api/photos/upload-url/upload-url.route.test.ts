// audit 2026-07-16 · UPLOAD — the photo upload-url route must reject any
// content_type outside the image allowlist at the boundary, before it can reach
// the presigned R2 PUT (src/lib/r2.ts sets it verbatim). text/html / image/svg+xml
// must 400; a real image type passes through to mintUploadUrl.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireOperatorAtLoadSite = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const mintUploadUrl = vi.fn<
  (...a: unknown[]) => Promise<{ storage_key: string; upload_url: string }>
>(async () => ({ storage_key: 'k', upload_url: 'https://r2/put' }));

vi.mock('@/lib/load-photo-guard', () => ({
  requireOperatorAtLoadSite: (...a: unknown[]) => requireOperatorAtLoadSite(...a),
}));
vi.mock('@/lib/r2', () => ({ mintUploadUrl: (...a: unknown[]) => mintUploadUrl(...a) }));

import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://127.0.0.1:3000/api/photos/upload-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireOperatorAtLoadSite.mockClear();
  mintUploadUrl.mockClear();
});

describe('POST /api/photos/upload-url — content_type allowlist', () => {
  it('rejects text/html with 400 and never mints an upload URL', async () => {
    const res = await POST(req({ load_id: 'L1', kind: 'bol', content_type: 'text/html' }));
    expect(res.status).toBe(400);
    expect(mintUploadUrl).not.toHaveBeenCalled();
    expect(requireOperatorAtLoadSite).not.toHaveBeenCalled();
  });

  it('rejects image/svg+xml (scriptable) with 400', async () => {
    const res = await POST(req({ load_id: 'L1', kind: 'bol', content_type: 'image/svg+xml' }));
    expect(res.status).toBe(400);
    expect(mintUploadUrl).not.toHaveBeenCalled();
  });

  it('accepts an allowlisted image type and mints the URL', async () => {
    const res = await POST(req({ load_id: 'L1', kind: 'bol', content_type: 'image/jpeg' }));
    expect(res.status).toBe(200);
    expect(mintUploadUrl).toHaveBeenCalledOnce();
    expect(mintUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/jpeg' }),
    );
  });
});
