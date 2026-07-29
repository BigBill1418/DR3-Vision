// ADR-0067 Amendment A §A.1/§A.3 — the provisioned, NON-SECRET identity of the
// document-ingestion Entra app, plus the scope contract.
//
// ── What is and is not a secret here ────────────────────────────────────────
// Tenant id, client id, service UPN and object id are NOT secrets (§A.1). They
// are directory coordinates, they appear in every redirect URL Bill's browser
// sees, and pretending otherwise only makes them harder to verify. They are
// therefore CONSTANTS in source, not env vars — no operator can mis-provision
// them, and a drift between the running config and the ADR is impossible.
//
// The CLIENT SECRET is a secret and lives only in the mounted secret file. It
// ALREADY EXISTS: `DR3-Vision Production`, valid to 2028-05-05, on the SAME app
// registration the AP mailbox authenticates with (verified live — the prod
// `~/.dr3-vision-secrets/msgraph-mail.env` carries exactly this tenant + client
// id). Do NOT create a second secret. See docs/operator/secret-rotation.md.
//
// The service-account PASSWORD is NOT a runtime credential and appears nowhere
// in this codebase. It is used once, by a human, in a browser, at first connect.
// If a future change needs it at runtime, that change is wrong.

/** Directory (tenant) id — SVdP. Non-secret (§A.1). */
export const DOC_INGEST_TENANT_ID = '72843ea8-e50d-4500-a0d5-d924e9acb4d5';

/**
 * App registration client id. The SAME registration as `MSGRAPH_MAIL_CLIENT_ID`
 * / `MSGRAPH_FILES_*` — one app, three capabilities. Non-secret (§A.1).
 */
export const DOC_INGEST_CLIENT_ID = '2da92424-7397-435d-96a1-d2a382293a53';

/**
 * The document service account. Bill must sign in AS THIS ACCOUNT, not as
 * himself — connecting as Bill personally would silently expose his own files
 * instead of the service account's shares. Asserted on every callback before a
 * single token byte is persisted (§A.6).
 */
export const DOC_INGEST_SERVICE_UPN = 'docs-dr3@svdp.us';

/** Service-account directory object id. Non-secret (§A.1); displayed for verification. */
export const DOC_INGEST_SERVICE_OBJECT_ID = '7ad08443-3d96-400e-9e4d-0c34208305e2';

/**
 * Registered redirect URI (§A.1). Entra matches this EXACTLY — it is not
 * derived from the request host, because a host-derived redirect is both a
 * mismatch waiting to happen behind the Cloudflare tunnel and an open-redirect
 * shape. `DOC_INGEST_REDIRECT_URI` overrides it for a non-prod tenant only.
 */
export function docIngestRedirectUri(): string {
  return (
    process.env['DOC_INGEST_REDIRECT_URI']?.trim() ||
    'https://dr3-vision.svdp.us/api/admin/doc-ingest/oauth/callback'
  );
}

/** Entra v2 authorize endpoint for the tenant. */
export function authorizeEndpoint(): string {
  return `https://login.microsoftonline.com/${DOC_INGEST_TENANT_ID}/oauth2/v2.0/authorize`;
}

/** Entra v2 token endpoint for the tenant. */
export function tokenEndpoint(): string {
  return `https://login.microsoftonline.com/${DOC_INGEST_TENANT_ID}/oauth2/v2.0/token`;
}

/**
 * The scopes requested at authorize time (§A.3), all admin-consented
 * tenant-wide and verified live on the registration:
 *   `email Files.Read.All offline_access openid profile Sites.Read.All User.Read`
 *
 * `offline_access` is what yields the refresh token — without it the whole
 * Amendment A design collapses back into interactive-only access.
 */
export const DOC_INGEST_REQUESTED_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Files.Read.All',
  'https://graph.microsoft.com/Sites.Read.All',
];

/**
 * The Graph RESOURCE scopes ingestion cannot work without. Compared against
 * what the token endpoint actually returned (§A.6 granted-vs-required).
 *
 * Deliberately excludes `openid`/`profile`/`email`/`offline_access`: Entra does
 * NOT echo the OIDC scopes back in the token response's `scope` field, so
 * requiring them there would report a permanent false negative. They are proven
 * differently and more strongly — `offline_access` by the presence of a refresh
 * token, the identity scopes by the presence of an id_token — which is asserted
 * at exchange time rather than diffed here.
 */
export const DOC_INGEST_REQUIRED_GRAPH_SCOPES: readonly string[] = [
  'User.Read',
  'Files.Read.All',
  'Sites.Read.All',
];

/**
 * Normalize one scope for comparison: drop the Graph resource prefix and
 * lowercase. Entra returns scopes inconsistently — sometimes bare
 * (`Files.Read.All`), sometimes fully qualified — and a naive string compare
 * reports a missing grant that is in fact present.
 */
export function normalizeScope(scope: string): string {
  return scope
    .trim()
    .replace(/^https:\/\/graph\.microsoft\.com\//i, '')
    .toLowerCase();
}

/** Split a space-delimited scope string into normalized scopes, dropping blanks. */
export function parseScopes(scopeString: string): string[] {
  return scopeString
    .split(/\s+/)
    .map(normalizeScope)
    .filter((s) => s.length > 0);
}

/**
 * Which required Graph scopes are absent from a granted scope string. Empty
 * array = the grant satisfies the contract.
 */
export function missingRequiredScopes(grantedScopeString: string): string[] {
  const granted = new Set(parseScopes(grantedScopeString));
  return DOC_INGEST_REQUIRED_GRAPH_SCOPES.filter((s) => !granted.has(normalizeScope(s)));
}

/**
 * Client secret for the app registration. Read from `DOC_INGEST_CLIENT_SECRET`,
 * falling back to `MSGRAPH_MAIL_SECRET` — the SAME registration's secret, which
 * is already mounted in prod. The fallback is the point: it is what stops
 * someone from minting a second secret on the same app.
 *
 * Returns null when neither is set; the caller decides whether that is a
 * boot-time no-op (status read) or a loud failure (connect attempt).
 */
export function readClientSecret(): string | null {
  return (
    process.env['DOC_INGEST_CLIENT_SECRET']?.trim() ||
    process.env['MSGRAPH_MAIL_SECRET']?.trim() ||
    null
  );
}

/**
 * Expiry of the shared `DR3-Vision Production` client secret. Surfaced on the
 * connect page because a silent expiry takes down AP mail polling AND document
 * ingestion SIMULTANEOUSLY, and those present as two unrelated outages — which
 * is exactly the kind of coincidence that costs a day of debugging.
 */
export const DOC_INGEST_CLIENT_SECRET_EXPIRES_ON = '2028-05-05';
