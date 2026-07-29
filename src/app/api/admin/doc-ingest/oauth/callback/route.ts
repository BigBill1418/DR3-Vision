// ADR-0067 Amendment A §A.1/§A.5/§A.6 — the OAuth redirect target.
//
// GET /api/admin/doc-ingest/oauth/callback   (the registered redirect URI)
//
// Entra sends the browser here after the interactive sign-in. This handler is
// the ONLY place a token enters the system, so it is where every control lives:
//
//   1. Admin session required. The callback is a top-level navigation carrying
//      the session cookie; an unauthenticated hit is rejected outright.
//   2. `state` verified against the sealed httpOnly cookie, constant-time, with
//      a TTL and an actor check (CSRF).
//   3. Code exchanged with the PKCE verifier.
//   4. `/me` resolves who ACTUALLY signed in, and the UPN is asserted equal to
//      docs-dr3@svdp.us. A mismatch REFUSES the connection and persists NOTHING
//      — connecting as Bill personally would silently expose his own files
//      instead of the service account's shares.
//   5. Only then are tokens encrypted and stored.
//
// The OneDrive probe (§A.5) runs after all of that and CANNOT fail the connect:
// a 404 means the drive is still provisioning, which is expected, not an error.
//
// Every outcome ends in a redirect back to the connect page with a `status`
// query param. Nothing about the failure is echoed from user-controlled input
// — the codes are a fixed vocabulary, so there is no reflected-content path.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import {
  assertServiceAccount,
  CONNECT_PAGE_PATH,
  DocIngestHandshakeError,
  DocIngestKeyUnavailableError,
  DocIngestOAuthError,
  DocIngestReauthRequiredError,
  DocIngestSecretUnavailableError,
  DocIngestWrongAccountError,
  exchangeCode,
  fetchSignedInIdentity,
  HANDSHAKE_COOKIE,
  persistConnection,
  probeDefaultDrive,
  verifyHandshake,
} from '@/lib/doc-ingest';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Fixed outcome vocabulary. The connect page maps these to copy; nothing is reflected. */
type CallbackStatus =
  | 'connected'
  | 'handshake_failed'
  | 'wrong_account'
  | 'denied'
  | 'exchange_failed'
  | 'key_missing'
  | 'error';

function back(status: CallbackStatus, req: Request, upn?: string): NextResponse {
  // Prefer the CONFIGURED origin over the request's. Behind the Cloudflare
  // tunnel the request origin can be the internal container host, and a redirect
  // to an internal host is one Bill can never open (fleet rule: never hand him a
  // private URL). `req.url` is the fallback for local dev only.
  const origin = process.env['NEXTAUTH_URL']?.trim() || new URL(req.url).origin;
  const url = new URL(CONNECT_PAGE_PATH, origin);
  url.searchParams.set('status', status);
  // The signed-in UPN is echoed ONLY on the wrong-account path, and only after
  // it came back from Graph — never from the query string. Bill needs to see
  // WHICH account he accidentally used, or he will do it again.
  if (upn) url.searchParams.set('upn', upn);
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.delete({ name: HANDSHAKE_COOKIE, path: '/api/admin/doc-ingest/oauth' });
  return res;
}

export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const params = url.searchParams;

  // Entra reports a user-cancelled or policy-blocked sign-in as `error` with no
  // code. That is not a fault of ours and must not look like one.
  if (params.get('error')) {
    log.warn(
      { event: 'doc_ingest.oauth.denied', error: params.get('error') },
      'document-ingestion sign-in was not completed',
    );
    return back('denied', req);
  }

  const code = params.get('code');
  if (!code) return back('handshake_failed', req);

  const cookie = req.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${HANDSHAKE_COOKIE}=`))
    ?.slice(HANDSHAKE_COOKIE.length + 1);

  let verifier: string;
  try {
    verifier = verifyHandshake(cookie, params.get('state') ?? undefined, ctx.userId).codeVerifier;
  } catch (e) {
    if (e instanceof DocIngestHandshakeError) {
      log.warn({ event: 'doc_ingest.oauth.handshake_failed', reason: e.message }, e.message);
      return back('handshake_failed', req);
    }
    if (e instanceof DocIngestKeyUnavailableError) return back('key_missing', req);
    throw e;
  }

  try {
    const tokens = await exchangeCode({ code, codeVerifier: verifier });

    // `offline_access` is proven by the refresh token (exchangeCode throws
    // without one); the identity scopes are proven by the id_token. Neither is
    // diffable from the response `scope` field, which omits OIDC scopes.
    if (!tokens.idToken) {
      log.warn(
        { event: 'doc_ingest.oauth.no_id_token' },
        'token response carried no id_token — identity scopes may not be granted',
      );
    }

    const identity = await fetchSignedInIdentity(tokens.accessToken);
    // THE control. Before this line no token has touched the database, and if
    // this throws none ever will.
    assertServiceAccount(identity);

    const drive = await probeDefaultDrive(tokens.accessToken);

    await persistConnection(prisma, { tokens, identity, drive, actorUserId: ctx.userId });

    log.info(
      {
        event: 'doc_ingest.oauth.connected',
        upn: identity.upn,
        drive_provisioned: Boolean(drive.driveId),
        scopes: tokens.grantedScopes,
      },
      'document-ingestion service account connected',
    );
    return back('connected', req);
  } catch (e) {
    if (e instanceof DocIngestWrongAccountError) {
      log.warn(
        { event: 'doc_ingest.oauth.wrong_account', signed_in_upn: e.signedInUpn },
        'document-ingestion connection refused — wrong account',
      );
      return back('wrong_account', req, e.signedInUpn);
    }
    if (e instanceof DocIngestKeyUnavailableError || e instanceof DocIngestSecretUnavailableError) {
      return back('key_missing', req);
    }
    if (e instanceof DocIngestOAuthError || e instanceof DocIngestReauthRequiredError) {
      log.warn({ event: 'doc_ingest.oauth.exchange_failed', reason: e.message }, e.message);
      return back('exchange_failed', req);
    }
    log.error({ event: 'doc_ingest.oauth.error', err: e }, 'document-ingestion callback failed');
    return back('error', req);
  }
}
