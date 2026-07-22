// ADR-0057 — MyMRC admin-credential save endpoint: route tests.
//
// Verify:
//   - role gate (admin-only; manager + operator + anon all fail)
//   - zod validation (missing/blank username or password → 422)
//   - trimming + the whitespace warning (MyMRC rejects leading/trailing spaces)
//   - the store is called with the TRIMMED values + the admin actor id
//   - the password is NEVER echoed into the response body
//   - InvalidCredentialInputError from the store maps to 422; other store
//     failures (e.g. missing key) map to a generic 500

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockSession: { user: { id: string; role: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

// The route only passes `prisma` through to the (mocked) store — a trivial
// sentinel is enough.
vi.mock('@/lib/prisma', () => ({ prisma: { __sentinel: 'prisma' } }));

const setMymrcCredentials = vi.fn((): Promise<void> => Promise.resolve());

/** Shape of one recorded call to the store: (prisma, creds, actorUserId). */
type StoreCall = [unknown, { username: string; password: string }, string];

class InvalidCredentialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCredentialInputError';
  }
}

vi.mock('@/lib/mymrc', () => ({
  setMymrcCredentials,
  InvalidCredentialInputError,
}));

function makeReq(bodyObj: unknown): Request {
  return new Request('http://x/api/admin/mrc-scrape/credentials', {
    method: 'POST',
    body: typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockSession = null;
  setMymrcCredentials.mockClear();
  setMymrcCredentials.mockResolvedValue(undefined);
});

describe('POST /api/admin/mrc-scrape/credentials — role gate', () => {
  it('returns 401 when unauthenticated', async () => {
    const { POST } = await import('./route');
    mockSession = null;
    const res = await POST(makeReq({ username: 'u', password: 'p' }));
    expect(res.status).toBe(401);
    expect(setMymrcCredentials).not.toHaveBeenCalled();
  });

  it('returns 403 for a manager', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'm', role: 'manager' } };
    const res = await POST(makeReq({ username: 'u', password: 'p' }));
    expect(res.status).toBe(403);
    expect(setMymrcCredentials).not.toHaveBeenCalled();
  });

  it('returns 403 for an operator', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'o', role: 'operator' } };
    const res = await POST(makeReq({ username: 'u', password: 'p' }));
    expect(res.status).toBe(403);
    expect(setMymrcCredentials).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/mrc-scrape/credentials — validation', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
  });

  it('returns 400 on non-JSON body', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq('not json'));
    expect(res.status).toBe(400);
    expect(setMymrcCredentials).not.toHaveBeenCalled();
  });

  it('returns 422 when username is missing', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ password: 'p' }));
    expect(res.status).toBe(422);
    expect(setMymrcCredentials).not.toHaveBeenCalled();
  });

  it('returns 422 when password is missing', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ username: 'u' }));
    expect(res.status).toBe(422);
    expect(setMymrcCredentials).not.toHaveBeenCalled();
  });

  it('returns 422 when username is whitespace-only', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ username: '   ', password: 'p' }));
    expect(res.status).toBe(422);
    expect(setMymrcCredentials).not.toHaveBeenCalled();
  });

  it('returns 422 when password is whitespace-only', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ username: 'u', password: '   ' }));
    expect(res.status).toBe(422);
    expect(setMymrcCredentials).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/mrc-scrape/credentials — save', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
  });

  it('stores the credentials and returns 200 without echoing the password', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ username: 'bill@svdp.us', password: 'sup3r-s3cret!' }));
    expect(res.status).toBe(200);

    // Store called with the trimmed creds + the admin actor id (3rd arg).
    expect(setMymrcCredentials).toHaveBeenCalledTimes(1);
    const [, creds, actor] = setMymrcCredentials.mock.calls[0]! as unknown as StoreCall;
    expect(creds).toEqual({ username: 'bill@svdp.us', password: 'sup3r-s3cret!' });
    expect(actor).toBe('admin-1');

    // The password NEVER appears in the response body.
    const body = await res.json();
    const json = JSON.stringify(body);
    expect(json).not.toContain('sup3r-s3cret!');
    expect(json).not.toContain('password');
    expect(body).toEqual({ ok: true });
  });

  it('trims leading/trailing whitespace and warns; stores the trimmed values', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ username: '  bill  ', password: '  pw \t' }));
    expect(res.status).toBe(200);

    const [, creds] = setMymrcCredentials.mock.calls[0]! as unknown as StoreCall;
    expect(creds).toEqual({ username: 'bill', password: 'pw' });

    const body = (await res.json()) as { ok: boolean; warning?: string };
    expect(body.ok).toBe(true);
    expect(body.warning).toBeDefined();
    // Even the warning path never leaks the raw password.
    expect(JSON.stringify(body)).not.toContain('pw ');
  });

  it('does NOT set a warning when nothing was trimmed', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ username: 'bill', password: 'pw' }));
    const body = (await res.json()) as { ok: boolean; warning?: string };
    expect(body.warning).toBeUndefined();
  });

  it('maps InvalidCredentialInputError from the store to 422', async () => {
    const { POST } = await import('./route');
    setMymrcCredentials.mockRejectedValueOnce(new InvalidCredentialInputError('username is required'));
    const res = await POST(makeReq({ username: 'bill', password: 'pw' }));
    expect(res.status).toBe(422);
  });

  it('maps an unexpected store failure (e.g. missing key) to a generic 500', async () => {
    const { POST } = await import('./route');
    setMymrcCredentials.mockRejectedValueOnce(new Error('MYMRC_CRED_KEY is not set'));
    const res = await POST(makeReq({ username: 'bill', password: 'pw' }));
    expect(res.status).toBe(500);
    // The internal error message must not reach the client.
    const json = JSON.stringify(await res.json());
    expect(json).not.toContain('MYMRC_CRED_KEY');
  });
});
