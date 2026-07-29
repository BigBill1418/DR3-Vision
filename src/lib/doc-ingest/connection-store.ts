// ADR-0067 Amendment A §A.6/§A.7 — the delegated-connection store.
//
// One singleton row. Writes go through `persistConnection` (which is the ONLY
// place a token is encrypted and stored); reads split hard in two:
//
//   getDocIngestConnectionStatus()  — NON-SECRET. Does not SELECT a single
//                                     ciphertext column. Safe for any API body.
//   loadRefreshToken()              — SERVER ONLY. The sole path that
//                                     materializes a token in memory.
//
// That split is copied deliberately from the MyMRC credential store (ADR-0057):
// the status shape physically cannot leak a token, because the token is not in
// the query.
//
// Prisma-client-as-a-parameter, same as credential-store.ts: this module never
// imports the app's `@/lib/prisma` singleton and never imports `server-only`, so
// a caller supplies its own client.
//
// Alias note, so the next phase does not trip on it: `config.ts`, `secret-box.ts`,
// `oauth.ts` and this file are `@/`-ALIAS-FREE and would survive a standalone
// `tsc` build the way src/lib/mymrc/ does. `reauth.ts` and `access-token.ts` are
// NOT — they import `@/lib/ntfy`, deliberately, because a reauth failure must
// page. That is fine for the fleet's established cron shape (a `.mjs` script
// calling an `/api/internal/*` route, which runs inside the app), and it is only
// a constraint if the sweep is ever compiled standalone like the MyMRC scrape.

import { Prisma } from '@prisma/client';
import type { AuditAction, DocIngestConnectionState, PrismaClient } from '@prisma/client';
import {
  DOC_INGEST_CLIENT_ID,
  DOC_INGEST_CLIENT_SECRET_EXPIRES_ON,
  DOC_INGEST_REQUIRED_GRAPH_SCOPES,
  DOC_INGEST_SERVICE_OBJECT_ID,
  DOC_INGEST_SERVICE_UPN,
  DOC_INGEST_TENANT_ID,
  missingRequiredScopes,
  parseScopes,
  readClientSecret,
} from './config';
import { CURRENT_KEY_VERSION, isKeyConfigured, open, seal } from './secret-box';
import type { DriveProbe, SignedInIdentity, TokenSet } from './oauth';

/** Fixed primary key of the one and only connection row. */
export const SINGLETON_ID = 'singleton';

const AUDIT_ACTOR_LABEL = 'doc-ingest-connect-surface';

// ── Write path ───────────────────────────────────────────────────────────────

export interface PersistConnectionArgs {
  tokens: TokenSet;
  identity: SignedInIdentity;
  drive: DriveProbe;
  actorUserId: string;
  now?: Date;
}

/**
 * Encrypt and persist a freshly acquired connection, clearing any
 * `reauth_required` latch. Appends a token-free audit row.
 *
 * The caller MUST have already asserted the identity is the service account —
 * this function does not re-check, because doing so in two places invites the
 * two places to disagree. `assertServiceAccount` is called at the callback
 * boundary, before this is ever reached.
 */
export async function persistConnection(
  prisma: PrismaClient,
  args: PersistConnectionArgs,
): Promise<void> {
  const now = args.now ?? new Date();
  // Encrypt BEFORE the DB round-trip so a key-config error aborts with no
  // partial write (ADR-0057's ordering, for the same reason).
  const refresh = seal(args.tokens.refreshToken);
  const access = seal(args.tokens.accessToken);

  const existing = await prisma.docIngestConnection.findUnique({
    where: { id: SINGLETON_ID },
    select: { id: true, account_upn: true, state: true },
  });

  const row = {
    tenant_id: DOC_INGEST_TENANT_ID,
    client_id: DOC_INGEST_CLIENT_ID,
    account_upn: args.identity.upn,
    account_object_id: args.identity.objectId,
    refresh_token_ciphertext: refresh.ciphertext,
    refresh_token_iv: refresh.iv,
    refresh_token_auth_tag: refresh.authTag,
    refresh_token_issued_at: now,
    access_token_ciphertext: access.ciphertext,
    access_token_iv: access.iv,
    access_token_auth_tag: access.authTag,
    access_token_expires_at: args.tokens.expiresAt,
    key_version: CURRENT_KEY_VERSION,
    granted_scopes: args.tokens.grantedScopes,
    acquired_at: now,
    last_refresh_at: null,
    last_refresh_error: null,
    // A successful interactive connect clears the latch outright — that IS the
    // resolution of `reauth_required`, so nothing else needs to notice.
    state: 'connected' as DocIngestConnectionState,
    reauth_reason: null,
    reauth_since: null,
    reauth_paged_at: null,
    drive_id: args.drive.driveId,
    drive_provisioned_at: args.drive.driveId ? now : null,
    drive_check_error: args.drive.error,
    connected_by: args.actorUserId,
  };

  await prisma.docIngestConnection.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...row },
    update: row,
  });

  const action: AuditAction = existing ? 'update' : 'insert';
  await prisma.auditLog.create({
    data: {
      actor_user_id: args.actorUserId,
      actor_label: AUDIT_ACTOR_LABEL,
      action,
      table_name: 'doc_ingest_connections',
      row_id: SINGLETON_ID,
      before: existing
        ? ({
            account_upn: existing.account_upn,
            state: existing.state,
          } satisfies Prisma.InputJsonObject)
        : Prisma.JsonNull,
      // Non-secret metadata only. No token, no ciphertext, no scope secret.
      after: {
        account_upn: args.identity.upn,
        state: 'connected',
        granted_scopes: args.tokens.grantedScopes,
        drive_provisioned: Boolean(args.drive.driveId),
        key_version: CURRENT_KEY_VERSION,
      } satisfies Prisma.InputJsonObject,
    },
  });
}

/**
 * Roll the token chain forward after a successful refresh. Entra issues a NEW
 * refresh token every redemption, so this MUST be called with the new one or
 * the chain dies silently when the old token ages out.
 */
export async function persistRefreshedTokens(
  prisma: PrismaClient,
  tokens: TokenSet,
  now: Date = new Date(),
): Promise<void> {
  const refresh = seal(tokens.refreshToken);
  const access = seal(tokens.accessToken);
  await prisma.docIngestConnection.update({
    where: { id: SINGLETON_ID },
    data: {
      refresh_token_ciphertext: refresh.ciphertext,
      refresh_token_iv: refresh.iv,
      refresh_token_auth_tag: refresh.authTag,
      refresh_token_issued_at: now,
      access_token_ciphertext: access.ciphertext,
      access_token_iv: access.iv,
      access_token_auth_tag: access.authTag,
      access_token_expires_at: tokens.expiresAt,
      key_version: CURRENT_KEY_VERSION,
      granted_scopes: tokens.grantedScopes,
      last_refresh_at: now,
      last_refresh_error: null,
      state: 'connected',
      reauth_reason: null,
      reauth_since: null,
      reauth_paged_at: null,
    },
  });
}

/** Record the OneDrive provisioning result of a later re-probe (§A.5). */
export async function persistDriveProbe(
  prisma: PrismaClient,
  drive: DriveProbe,
  now: Date = new Date(),
): Promise<void> {
  await prisma.docIngestConnection.update({
    where: { id: SINGLETON_ID },
    data: {
      drive_id: drive.driveId,
      drive_provisioned_at: drive.driveId ? now : null,
      drive_check_error: drive.error,
    },
  });
}

// ── Secret read path (SERVER/WORKER ONLY) ────────────────────────────────────

/**
 * Decrypt and return the stored refresh token, or `null` when no connection
 * exists at all. Throws (fail-closed) on tamper, wrong key, or a missing
 * encryption key — never returns `null` to mask corruption as "not connected",
 * which would present a broken key as an innocent unconfigured state.
 */
export async function loadRefreshToken(prisma: PrismaClient): Promise<string | null> {
  const row = await prisma.docIngestConnection.findUnique({
    where: { id: SINGLETON_ID },
    select: {
      refresh_token_ciphertext: true,
      refresh_token_iv: true,
      refresh_token_auth_tag: true,
      key_version: true,
    },
  });
  if (!row) return null;
  return open(
    {
      ciphertext: row.refresh_token_ciphertext,
      iv: row.refresh_token_iv,
      authTag: row.refresh_token_auth_tag,
    },
    row.key_version,
  );
}

/**
 * Decrypt the cached access token if it exists and is still valid at `now`
 * (with a 60 s safety margin). Returns null when absent or expired — an expired
 * access token is a routine state the caller resolves by refreshing, NOT an
 * error.
 */
export async function loadCachedAccessToken(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<string | null> {
  const row = await prisma.docIngestConnection.findUnique({
    where: { id: SINGLETON_ID },
    select: {
      access_token_ciphertext: true,
      access_token_iv: true,
      access_token_auth_tag: true,
      access_token_expires_at: true,
      key_version: true,
    },
  });
  if (
    !row ||
    !row.access_token_ciphertext ||
    !row.access_token_iv ||
    !row.access_token_auth_tag ||
    !row.access_token_expires_at
  ) {
    return null;
  }
  if (row.access_token_expires_at.getTime() - 60_000 <= now.getTime()) return null;
  return open(
    {
      ciphertext: row.access_token_ciphertext,
      iv: row.access_token_iv,
      authTag: row.access_token_auth_tag,
    },
    row.key_version,
  );
}

// ── Non-secret status (§A.6) ─────────────────────────────────────────────────

/** OneDrive provisioning state, as the connect surface renders it (§A.5). */
export type DriveProvisioningStatus = 'provisioned' | 'pending' | 'error' | 'unknown';

/** Everything the connect page shows. Carries NO token and NO ciphertext. */
export interface DocIngestConnectionStatus {
  connected: boolean;
  /** `connected` | `reauth_required`; null when nothing is connected yet. */
  state: DocIngestConnectionState | null;

  /** Non-secret directory coordinates (§A.1) — safe to display and to log. */
  tenantId: string;
  clientId: string;
  expectedUpn: string;
  expectedObjectId: string;

  /** The account that actually authenticated. Asserted equal to `expectedUpn` at connect time. */
  accountUpn: string | null;
  accountObjectId: string | null;
  /** Defence in depth: if this is ever false on a stored row, something bypassed the callback assertion. */
  accountMatches: boolean;

  acquiredAt: string | null;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  refreshTokenIssuedAt: string | null;
  /** Age of the CURRENT refresh token in whole days. */
  refreshTokenAgeDays: number | null;
  accessTokenExpiresAt: string | null;

  grantedScopes: string[];
  requiredScopes: string[];
  missingScopes: string[];

  driveStatus: DriveProvisioningStatus;
  driveId: string | null;
  driveProvisionedAt: string | null;
  driveCheckError: string | null;

  reauthReason: string | null;
  reauthSince: string | null;

  /** Subscription health, for the §A.6 panel. Populated now; written by the NEXT phase. */
  activeSubscriptionCount: number;
  nextSubscriptionRenewalAt: string | null;
  lastDeltaSweepAt: string | null;

  connectedBy: string | null;

  /** True when the ADR-0057 `MYMRC_CRED_KEY` is mounted (the doc-ingest key is derived from it — no second secret). False = connect fails LOUDLY, so say so up front. */
  encryptionKeyConfigured: boolean;
  /** True when a client secret is readable (its own or the shared mail secret). */
  clientSecretConfigured: boolean;
  /** Shared `DR3-Vision Production` secret expiry — a silent expiry kills AP mail AND ingestion together. */
  clientSecretExpiresOn: string;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Non-secret status for the connect page and its API. Selects no ciphertext
 * column at all, so no token can leave Postgres on this path regardless of what
 * the caller does with the result.
 */
export async function getDocIngestConnectionStatus(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<DocIngestConnectionStatus> {
  const [row, activeSubs, nextRenewal, lastSweep] = await Promise.all([
    prisma.docIngestConnection.findUnique({
      where: { id: SINGLETON_ID },
      select: {
        state: true,
        tenant_id: true,
        client_id: true,
        account_upn: true,
        account_object_id: true,
        acquired_at: true,
        last_refresh_at: true,
        last_refresh_error: true,
        refresh_token_issued_at: true,
        access_token_expires_at: true,
        granted_scopes: true,
        drive_id: true,
        drive_provisioned_at: true,
        drive_check_error: true,
        reauth_reason: true,
        reauth_since: true,
        connected_by: true,
      },
    }),
    prisma.docIngestSubscription.count({ where: { state: 'active' } }),
    prisma.docIngestSubscription.findFirst({
      where: { state: 'active', expires_at: { not: null } },
      orderBy: { expires_at: 'asc' },
      select: { expires_at: true },
    }),
    prisma.docIngestSubscription.findFirst({
      where: { delta_synced_at: { not: null } },
      orderBy: { delta_synced_at: 'desc' },
      select: { delta_synced_at: true },
    }),
  ]);

  const base = {
    tenantId: DOC_INGEST_TENANT_ID,
    clientId: DOC_INGEST_CLIENT_ID,
    expectedUpn: DOC_INGEST_SERVICE_UPN,
    expectedObjectId: DOC_INGEST_SERVICE_OBJECT_ID,
    requiredScopes: [...DOC_INGEST_REQUIRED_GRAPH_SCOPES],
    activeSubscriptionCount: activeSubs,
    nextSubscriptionRenewalAt: iso(nextRenewal?.expires_at),
    lastDeltaSweepAt: iso(lastSweep?.delta_synced_at),
    encryptionKeyConfigured: isKeyConfigured(),
    clientSecretConfigured: readClientSecret() !== null,
    clientSecretExpiresOn: DOC_INGEST_CLIENT_SECRET_EXPIRES_ON,
  };

  if (!row) {
    return {
      ...base,
      connected: false,
      state: null,
      accountUpn: null,
      accountObjectId: null,
      accountMatches: false,
      acquiredAt: null,
      lastRefreshAt: null,
      lastRefreshError: null,
      refreshTokenIssuedAt: null,
      refreshTokenAgeDays: null,
      accessTokenExpiresAt: null,
      grantedScopes: [],
      missingScopes: [...DOC_INGEST_REQUIRED_GRAPH_SCOPES],
      driveStatus: 'unknown',
      driveId: null,
      driveProvisionedAt: null,
      driveCheckError: null,
      reauthReason: null,
      reauthSince: null,
      connectedBy: null,
    };
  }

  const ageMs = now.getTime() - row.refresh_token_issued_at.getTime();
  const driveStatus: DriveProvisioningStatus = row.drive_id
    ? 'provisioned'
    : row.drive_check_error
      ? 'error'
      : 'pending';

  return {
    ...base,
    connected: true,
    state: row.state,
    // Displayed from the ROW, not the constant, so a drift is visible rather
    // than papered over by rendering what we wish were true.
    accountUpn: row.account_upn,
    accountObjectId: row.account_object_id,
    accountMatches: row.account_upn.trim().toLowerCase() === DOC_INGEST_SERVICE_UPN.toLowerCase(),
    acquiredAt: iso(row.acquired_at),
    lastRefreshAt: iso(row.last_refresh_at),
    lastRefreshError: row.last_refresh_error,
    refreshTokenIssuedAt: iso(row.refresh_token_issued_at),
    refreshTokenAgeDays: Math.max(0, Math.floor(ageMs / 86_400_000)),
    accessTokenExpiresAt: iso(row.access_token_expires_at),
    grantedScopes: parseScopes(row.granted_scopes),
    missingScopes: missingRequiredScopes(row.granted_scopes),
    driveStatus,
    driveId: row.drive_id,
    driveProvisionedAt: iso(row.drive_provisioned_at),
    driveCheckError: row.drive_check_error,
    reauthReason: row.reauth_reason,
    reauthSince: iso(row.reauth_since),
    connectedBy: row.connected_by,
  };
}
