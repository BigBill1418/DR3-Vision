import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the JWT reader; control what token (if any) the route sees.
const getToken = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);
vi.mock('next-auth/jwt', () => ({ getToken: (...a: unknown[]) => getToken(...a) }));

import { GET } from './route';

const nowS = () => Math.floor(Date.now() / 1000);
const req = () => new Request('http://localhost:3000/api/me/photo') as never;

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env['NEXTAUTH_SECRET'] = 'test-secret';
  getToken.mockReset();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/me/photo', () => {
  it('404 (→ initials fallback) when there is no Graph token', async () => {
    getToken.mockResolvedValue({});
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('404 when the stored token is expired', async () => {
    getToken.mockResolvedValue({ ms_access_token: 'tok', ms_access_token_exp: nowS() - 10 });
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('streams the photo (200, 24h private cache) when Graph returns one', async () => {
    getToken.mockResolvedValue({ ms_access_token: 'tok', ms_access_token_exp: nowS() + 3000 });
    fetchSpy.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/me/photo/$value',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    );
  });

  it('404 when Graph has no photo (404) — silent fallback', async () => {
    getToken.mockResolvedValue({ ms_access_token: 'tok', ms_access_token_exp: nowS() + 3000 });
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    expect((await GET(req())).status).toBe(404);
  });

  it('404 (no throw) when Graph errors / token decode fails', async () => {
    getToken.mockRejectedValue(new Error('decode failed'));
    expect((await GET(req())).status).toBe(404);
  });
});
