// ADR-0067 — shared-file document ingestion. Public surface of the foundation.
//
// What is HERE (this phase): the delegated Entra connection — auth-code flow,
// encrypted token store, refresh + `reauth_required` posture, and the
// non-secret status the connect page renders.
//
// What is NOT here (next phase): Graph change subscriptions, the delta sweep,
// the document classifier, and the anomaly guardrail. Their tables and enums
// exist (`doc_ingest_subscriptions`, `doc_sources`, `doc_source_versions`,
// `doc_ingest_anomalies`) and `acquireAccessToken` is the seam they call.

export {
  DOC_INGEST_CLIENT_ID,
  DOC_INGEST_CLIENT_SECRET_EXPIRES_ON,
  DOC_INGEST_REQUESTED_SCOPES,
  DOC_INGEST_REQUIRED_GRAPH_SCOPES,
  DOC_INGEST_SERVICE_OBJECT_ID,
  DOC_INGEST_SERVICE_UPN,
  DOC_INGEST_TENANT_ID,
  docIngestRedirectUri,
  missingRequiredScopes,
  normalizeScope,
  parseScopes,
  readClientSecret,
} from './config';

export {
  CURRENT_KEY_VERSION,
  DocIngestDecryptError,
  DocIngestKeyUnavailableError,
  isKeyConfigured,
} from './secret-box';

export {
  assertServiceAccount,
  DocIngestHandshakeError,
  DocIngestOAuthError,
  DocIngestReauthRequiredError,
  DocIngestSecretUnavailableError,
  DocIngestWrongAccountError,
  exchangeCode,
  fetchSignedInIdentity,
  HANDSHAKE_COOKIE,
  HANDSHAKE_TTL_MS,
  probeDefaultDrive,
  redeemRefreshToken,
  startHandshake,
  verifyHandshake,
  type DriveProbe,
  type FetchLike,
  type SignedInIdentity,
  type TokenSet,
} from './oauth';

export {
  getDocIngestConnectionStatus,
  loadCachedAccessToken,
  loadRefreshToken,
  persistConnection,
  persistDriveProbe,
  persistRefreshedTokens,
  SINGLETON_ID,
  type DocIngestConnectionStatus,
  type DriveProvisioningStatus,
} from './connection-store';

export {
  CONNECT_PAGE_PATH,
  docIngestReauthWarning,
  latchReauthRequired,
  recordTransientRefreshFailure,
  REPAGE_INTERVAL_MS,
} from './reauth';

export {
  acquireAccessToken,
  DocIngestHaltedError,
  DocIngestNotConnectedError,
} from './access-token';
