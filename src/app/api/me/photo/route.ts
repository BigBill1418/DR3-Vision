// Microsoft Graph profile photo proxy (ADR-0020 / T-119).
//
// The Vision Dashboard avatar fetches /api/me/photo. We read the user's Graph
// access token from the (server-only, encrypted) session JWT — NEVER from the
// client-facing Session — and proxy GET /me/photo/$value, streaming the bytes back
// with a 24h PRIVATE cache (satisfies "cache for 24h" with no server storage and no
// cookie bloat from the photo itself). FAIL-OPEN: no token / expired / no photo /
// Graph outage all return 404 so the client avatar falls back to initials silently.

import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GRAPH_PHOTO_URL = 'https://graph.microsoft.com/v1.0/me/photo/$value';

function notFound(): NextResponse {
  // 404 (not 401/403) so the avatar's onError handler quietly shows initials.
  return new NextResponse(null, { status: 404 });
}

export async function GET(req: NextRequest): Promise<Response> {
  const secret = process.env['AUTH_SECRET'] ?? process.env['NEXTAUTH_SECRET'];
  if (!secret) return notFound();

  let accessToken: string | undefined;
  let exp: number | undefined;
  try {
    const token = await getToken({
      req,
      secret,
      secureCookie: (process.env['NEXTAUTH_URL'] ?? '').startsWith('https://'),
    });
    accessToken = token?.ms_access_token;
    exp = token?.ms_access_token_exp;
  } catch {
    return notFound();
  }

  const nowS = Math.floor(Date.now() / 1000);
  if (!accessToken || (typeof exp === 'number' && exp <= nowS)) {
    return notFound();
  }

  try {
    const res = await fetch(GRAPH_PHOTO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return notFound(); // 404 (no photo set) or token rejected
    const body = await res.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'image/jpeg',
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch {
    return notFound();
  }
}
