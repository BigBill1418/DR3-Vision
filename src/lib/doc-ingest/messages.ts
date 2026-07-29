// ADR-0067 Amendment A §A.6 — copy for the document-ingestion connect surface.
//
// Admin-only English, matching the rest of /admin (CLAUDE.md #4's i18n mandate
// covers OPERATOR-facing copy; the admin surfaces are English-only until the
// admin i18n pass, same as `adminMessages`).
//
// The copy here is load-bearing, not decoration. Two lines in particular:
//
//   `signInAsWarning` — names `docs-dr3@svdp.us` explicitly, because the whole
//   failure mode this surface guards against is Bill signing in as HIMSELF by
//   reflex, which would connect his personal OneDrive instead of the service
//   account's shares.
//
//   `wrongAccount` — states plainly what was refused and why. A vague "sign-in
//   failed" here would send him round the loop a second time doing the same
//   wrong thing.

export const docIngestMessages = {
  pageTitle: 'Document ingestion',
  pageSubtitle:
    'Documents stay where they live in Microsoft and are shared to a service account. Vision reads the live document — not an emailed snapshot.',
  navLink: 'Document ingestion',

  // ── Disconnected state ────────────────────────────────────────────────────
  disconnectedHeading: 'Not connected',
  disconnectedBody:
    'A one-time interactive sign-in is required before Vision can read any shared document. This is a browser sign-in, done once, by a person.',
  signInAsWarning:
    'Sign in as docs-dr3@svdp.us — NOT your own account. Signing in as yourself would connect your personal OneDrive instead of the service account, and Vision would read your files rather than the documents shared with it.',
  connect: 'Connect document service account',
  connecting: 'Redirecting to Microsoft…',

  // ── Connected state ───────────────────────────────────────────────────────
  connectedHeading: 'Connected',
  reconnect: 'Reconnect',
  signedInAs: 'Signed in as',
  accountMismatch:
    'The stored connection is NOT the document service account. Reconnect as docs-dr3@svdp.us.',
  acquiredAt: 'Token acquired',
  lastRefresh: 'Last refresh',
  neverRefreshed: 'never — still on the original token',
  refreshTokenAge: 'Refresh token age',
  accessTokenExpires: 'Access token expires',
  days: 'days',

  scopesHeading: 'Granted permissions',
  scopesSatisfied: 'All required permissions are granted.',
  scopesMissing: 'MISSING required permissions',

  driveHeading: 'OneDrive',
  driveProvisioned: 'Provisioned',
  // §A.5 — OneDrive provisions asynchronously; a 404 before first sign-in is
  // EXPECTED, so this reads as a normal state and not as a fault.
  drivePending:
    'Still provisioning. OneDrive is created on the account’s first interactive sign-in — this is normal immediately after licensing, not an error.',
  driveError: 'Could not check OneDrive',
  driveUnknown: 'Not checked yet',

  subscriptionsHeading: 'Change subscriptions',
  activeSubscriptions: 'Active',
  nextRenewal: 'Next renewal',
  noSubscriptions: 'None yet — subscriptions are created by the ingestion sweep.',
  lastSweep: 'Last delta sweep',
  neverSwept: 'never',

  // ── reauth_required ───────────────────────────────────────────────────────
  reauthHeading: 'Disconnected — sign-in required',
  reauthBody:
    'The Microsoft connection can no longer refresh itself. Document ingestion is HALTED — nothing is being read from shared files — and stays halted until someone signs in again as docs-dr3@svdp.us.',
  reauthSince: 'Disconnected since',
  reauthReason: 'Reason',

  // ── Config health ─────────────────────────────────────────────────────────
  configHeading: 'Configuration',
  tenantId: 'Tenant',
  clientId: 'Application',
  redirectUri: 'Redirect URI',
  encryptionKey: 'Token encryption key',
  clientSecret: 'Client secret',
  configured: 'configured',
  notConfigured: 'NOT configured',
  clientSecretExpiry: 'Client secret expires',
  clientSecretShared:
    'This secret is shared with AP mailbox polling on the same app registration. If it expires, document ingestion and AP mail stop at the same moment and will look like two unrelated outages.',

  refresh: 'Refresh',
  loading: 'Loading…',
  loadFailed: 'Could not load connection status',

  errors: {
    keyMissing:
      'The token encryption key is not mounted on this host. Provision ~/.dr3-vision-secrets/doc-ingest.env before connecting.',
    secretMissing:
      'No client secret is available. Mount ~/.dr3-vision-secrets/msgraph-mail.env (the same app registration) before connecting.',
    handshake: 'The sign-in could not be verified. Start the connection again from this page.',
    wrongAccount: 'Connection refused: the wrong account signed in.',
    exchangeFailed: 'Microsoft rejected the sign-in.',
    serverError: 'Something went wrong. Try again.',
  },
} as const;
