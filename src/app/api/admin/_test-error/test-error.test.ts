// T-123 — API integration tests for /api/admin/_test-error.
//
// The route deliberately throws so GlitchTip can be verified end-to-end.
// These tests lock the role gate (anonymous -> 401, non-admin -> 403)
// and confirm that an admin caller reaches the deliberate throw, so the
// operator's step-7a curl actually exercises the error path.

import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { GET } from './route';

// ── Mocked session ─────────────────────────────────────────────
let mockSession: { user: { id: string; role: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

describe('GET /api/admin/_test-error', () => {
  beforeEach(() => {
    mockSession = null;
  });

  it('returns 401 for an anonymous caller', async () => {
    mockSession = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns 403 for an authenticated non-admin', async () => {
    mockSession = { user: { id: 'op-1', role: 'operator' } };
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('throws the deliberate error for an admin (so GlitchTip captures it)', async () => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
    await expect(GET()).rejects.toThrow(/T-123 GlitchTip ingest test/);
  });
});
