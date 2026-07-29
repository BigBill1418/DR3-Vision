// ADR-0067 Amendment A — the ONE path every consumer uses to get a Graph token.
//
// This is the seam the next phase (subscriptions / delta sweep / classifier)
// plugs into. It exists now, with nothing but auth behind it, so that the
// refresh-and-latch policy is written once and cannot be re-implemented three
// times with three different opinions about what counts as "broken".
//
// Order of operations, and why:
//   1. `reauth_required` → THROW immediately. Ingestion halts LOUDLY (§A.6).
//      Retrying is pointless — only an interactive sign-in clears the latch —
//      and a retry loop would look like progress while producing none.
//   2. A valid cached access token → return it. No network call.
//   3. Otherwise redeem the refresh token, persist the NEW one (Entra rotates
//      it on every redemption), and return the fresh access token.

import type { PrismaClient } from '@prisma/client';
import {
  loadCachedAccessToken,
  loadRefreshToken,
  persistRefreshedTokens,
  SINGLETON_ID,
} from './connection-store';
import {
  DocIngestOAuthError,
  DocIngestReauthRequiredError,
  redeemRefreshToken,
  type FetchLike,
} from './oauth';
import { latchReauthRequired, recordTransientRefreshFailure } from './reauth';

/**
 * No connection exists at all. Distinct from `reauth_required` (a connection
 * that broke) because the operator action differs: this one means "nobody has
 * connected the service account yet".
 */
export class DocIngestNotConnectedError extends Error {
  override readonly name = 'DocIngestNotConnectedError';
  constructor() {
    super('document ingestion is not connected — connect at /admin/doc-ingest/connect');
  }
}

/** The connection is latched at `reauth_required`. Ingestion is halted by design. */
export class DocIngestHaltedError extends Error {
  override readonly name = 'DocIngestHaltedError';
  constructor(reason: string | null) {
    super(
      `document ingestion is halted pending re-authentication${reason ? `: ${reason}` : ''} — sign in again at /admin/doc-ingest/connect`,
    );
  }
}

export interface AcquireAccessTokenOptions {
  fetchImpl?: FetchLike;
  now?: Date;
}

/**
 * Return a usable Graph access token for the service account.
 *
 * Throws — never returns null, never returns a stale token, never no-ops. Every
 * failure mode is a distinct typed error so a caller can tell "not set up yet"
 * from "broken and a human must act" from "the network wobbled".
 */
export async function acquireAccessToken(
  prisma: PrismaClient,
  options: AcquireAccessTokenOptions = {},
): Promise<string> {
  const now = options.now ?? new Date();

  const row = await prisma.docIngestConnection.findUnique({
    where: { id: SINGLETON_ID },
    select: { state: true, reauth_reason: true },
  });
  if (!row) throw new DocIngestNotConnectedError();
  if (row.state === 'reauth_required') throw new DocIngestHaltedError(row.reauth_reason);

  const cached = await loadCachedAccessToken(prisma, now);
  if (cached) return cached;

  const refreshToken = await loadRefreshToken(prisma);
  if (!refreshToken) throw new DocIngestNotConnectedError();

  try {
    const tokens = await redeemRefreshToken({
      refreshToken,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      now: now.getTime(),
    });
    await persistRefreshedTokens(prisma, tokens, now);
    return tokens.accessToken;
  } catch (e) {
    if (e instanceof DocIngestReauthRequiredError) {
      // The one class that means a human must act. Latch + page + halt.
      await latchReauthRequired(prisma, e.message, now);
      throw e;
    }
    if (e instanceof DocIngestOAuthError) {
      // Transient. Recorded so the surface is honest, but NOT latched — see
      // reauth.ts header on why a blip must never become a page.
      await recordTransientRefreshFailure(prisma, e.message);
    }
    throw e;
  }
}
