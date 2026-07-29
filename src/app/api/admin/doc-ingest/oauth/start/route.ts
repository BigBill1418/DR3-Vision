// ADR-0067 Amendment A §A.6 — begin the delegated auth-code flow.
//
// POST /api/admin/doc-ingest/oauth/start
//
// Admin-only. Mints the CSRF `state` + PKCE verifier, seals them into an
// httpOnly cookie, and returns the authorize URL for the client to navigate to.
//
// POST, not GET, and a returned URL rather than a 302: CLAUDE.md #10 forbids
// HTML `<form>` elements, so the trigger is an `onClick` handler — and an
// onClick that fetches then assigns `location` keeps the CSRF cookie and the
// navigation in the right order without relying on redirect-following fetch
// semantics.
//
// FAILS LOUD on a missing encryption key or client secret (§A.7). It does not
// hand the operator an authorize URL that will only blow up after he has typed
// a password and completed MFA.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import {
  docIngestRedirectUri,
  DocIngestKeyUnavailableError,
  DocIngestSecretUnavailableError,
  HANDSHAKE_COOKIE,
  HANDSHAKE_TTL_MS,
  isKeyConfigured,
  readClientSecret,
  startHandshake,
} from '@/lib/doc-ingest';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  // Pre-flight both secrets BEFORE sending the operator to Entra. Discovering a
  // missing key after a completed MFA sign-in wastes the one interactive step
  // the whole design depends on.
  if (!isKeyConfigured()) {
    return NextResponse.json({ error: M.errors.keyMissing }, { status: 503 });
  }
  if (readClientSecret() === null) {
    return NextResponse.json({ error: M.errors.secretMissing }, { status: 503 });
  }

  let started;
  try {
    started = startHandshake(ctx.userId);
  } catch (e) {
    if (e instanceof DocIngestKeyUnavailableError || e instanceof DocIngestSecretUnavailableError) {
      return NextResponse.json({ error: M.errors.keyMissing }, { status: 503 });
    }
    throw e;
  }

  const res = NextResponse.json({ ok: true, authorizeUrl: started.authorizeUrl }, { status: 200 });
  res.cookies.set(HANDSHAKE_COOKIE, started.cookieValue, {
    httpOnly: true,
    // Lax, not Strict: the callback is a top-level GET navigation FROM
    // login.microsoftonline.com. Strict would withhold the cookie and every
    // connection attempt would fail its state check.
    sameSite: 'lax',
    // Tied to the flow's own origin scheme rather than hardcoded, so an http
    // dev origin still completes a handshake. Prod is https, so prod is secure.
    secure: docIngestRedirectUri().startsWith('https:'),
    path: '/api/admin/doc-ingest/oauth',
    maxAge: Math.floor(HANDSHAKE_TTL_MS / 1000),
  });
  return res;
}
