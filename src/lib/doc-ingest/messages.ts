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

  // ── Pipeline surfaces (§3.4) ──────────────────────────────────────────────
  sources: {
    title: 'Shared documents',
    subtitle:
      'Everything shared with the document service account. Vision reads the live file — a rename or a move is the same document, not a new one.',
    confirmQueueHeading: 'Waiting for you',
    // CORRECTED 2026-07-29. This used to read "Nothing is ingested from a
    // document until you confirm what it is." That was false: an unconfirmed
    // document IS downloaded, archived, and placed in the file-drop inbox —
    // `doc_class` gates no admission anywhere in `ingest.ts`. Say what is
    // actually true, because an operator who catches one false assertion
    // rightly discounts every assertion after it.
    confirmQueueBody:
      'These are captured and archived already — confirming tells Vision what they ARE, so the right checks run on them. Confirm once; after that the kind is registered and you are never asked again.',
    watchedHeading: 'Watched documents',
    empty: 'Nothing has been shared with the service account yet.',
    columnDocument: 'Document',
    columnKind: 'Kind',
    columnSite: 'Site',
    columnPeriod: 'Period',
    columnOwner: 'Shared by',
    columnState: 'State',
    columnLastIngested: 'Last ingested',
    columnActions: 'Actions',
    proposal: 'Suggested',
    confidence: 'confidence',
    confirm: 'Confirm',
    correct: 'Correct',
    reclassify: 'Change kind',
    reclassifyReason: 'Why is the registered kind changing?',
    disable: 'Stop ingesting',
    enable: 'Resume ingesting',
    disabled: 'Ingestion stopped by you',
    unclassified: 'Unclassified',
    // Hard rule #2 made visible: a NULL site is UNSCOPED, never "both".
    noSite: 'No site yet',
    sharedTwice: 'shared by more than one person — tracked as one document',
    readBlocked: 'Cannot be read',
    stateAccessDenied: 'Access lost',
    stateDisappeared: 'Deleted in Microsoft',
    stateActive: 'Active',
    nestedIn: 'inside a shared folder',
    saving: 'Saving…',
    saveFailed: 'Could not save',
  },

  anomalies: {
    title: 'Ingestion anomalies',
    subtitle:
      'Changes propagate automatically once a document is confirmed. These are the changes that looked ABNORMAL and were held instead.',
    empty: 'Nothing is waiting. Every change has flowed through normally.',
    stagedHeading: 'Held for review',
    otherHeading: 'Other anomalies',
    before: 'Before (currently in force)',
    after: 'After (proposed)',
    apply: 'Apply this revision',
    discard: 'Discard this revision',
    discardReason: 'Why is this revision being discarded?',
    acknowledge: 'Acknowledge',
    resolve: 'Mark resolved',
    resolveNote: 'What was done?',
    occurrences: 'seen',
    times: 'times',
    showResolved: 'Show resolved',
    hideResolved: 'Hide resolved',
    noVersion: 'This anomaly is not about a specific revision.',
  },

  health: {
    title: 'Ingestion health',
    subtitle:
      'Push notifications give speed. The scheduled sweep gives correctness. This page answers whether the sweep is actually running.',
    sweepHeading: 'Delta sweep',
    lastSweep: 'Last successful sweep',
    lastAttempt: 'Last attempt',
    sweepStale: 'THE SWEEP HAS STOPPED',
    // The one sentence on the page that has to land. It is the MyMRC failure,
    // named, so nobody reads a stale sweep as a cosmetic problem.
    sweepStaleBody:
      'Shared documents are not being reconciled. Change notifications do NOT cover this — the sweep is what guarantees a change is never missed. Anything that changed since the last successful sweep is not in Vision.',
    sweepHealthy: 'Running normally',
    consecutiveFailures: 'Consecutive failed runs',
    subscriptionsHeading: 'Change notifications (speed only)',
    pushUnproven:
      'No change notification has been received yet. That is expected until a watched document actually changes — it is not a fault on its own.',
    subscriptionValidated: 'Validated',
    subscriptionUnvalidated: 'Never validated',
    notificationsReceived: 'Notifications received',
    expires: 'Expires',
    sourcesHeading: 'Documents',
    accessLost: 'Access lost',
    disappearedCount: 'Deleted in Microsoft',
    readBlockedCount: 'Unreadable',
    awaitingConfirmation: 'Awaiting your confirmation',
    stagedHeading: 'Held revisions',
    discoveryHeading: 'Shared-item discovery',
    // §A.9-adjacent: the deprecation is surfaced where an operator will see it.
    discoverySunset:
      'Microsoft has deprecated the API Vision uses to enumerate shared files. It stops returning data on',
    discoveryDaysLeft: 'days left',
    discoveryExpired:
      'This API has now stopped returning data. Shared-document discovery is BROKEN until the enumeration is replaced.',
  },

  // ── ADR-0069 reconciliation ────────────────────────────────────────────────
  // Every string here is checked against what the code actually does. This module
  // has shipped false UI assertions before (see `confirmQueueBody` above), and an
  // operator who catches one rightly discounts every claim after it. In
  // particular: this screen does NOT say the spreadsheet or Vision is correct. It
  // says where they agree. Deciding which is right is the manager's job and the
  // copy must not pretend otherwise.
  reconciliation: {
    title: 'Spreadsheet vs. Vision',
    subtitle:
      'What a shared daily-log workbook says about a day, next to what Vision holds for the same day. Reference only — nothing here changes a Vision figure.',
    intro:
      'Absorbed spreadsheet figures are kept as REFERENCE data. They never overwrite production numbers: the workbook sync (ADR-0049) is the only writer of daily production. This screen is the measure of how far apart the two are.',
    emptyHeading: 'Nothing absorbed yet',
    emptyBody:
      'No confirmed daily-log workbook has produced reference rows. Share the monthly daily-log workbook with the document service account and confirm its class and site on the shared-documents queue.',
    filterHeading: 'Period',
    from: 'From',
    to: 'To',
    apply: 'Show',
    site: 'Site',
    allSites: 'All sites',
    // Summary tiles
    agree: 'Agree',
    disagree: 'Disagree',
    missingInVision: 'Not in Vision',
    missingInReference: 'Not in spreadsheet',
    totalAbsDelta: 'Total absolute difference',
    coverage: 'Spreadsheet covers',
    coverageNone: 'nothing in this period',
    daysCovered: 'days',
    documents: 'From',
    // Table
    colDate: 'Day',
    colSite: 'Site',
    colMetric: 'Figure',
    colReference: 'Spreadsheet',
    colVision: 'Vision',
    colDelta: 'Difference',
    colStatus: 'Status',
    colDocument: 'Document',
    noRows: 'No days to compare in this period.',
    // Status labels
    statusAgree: 'Agrees',
    statusDisagree: 'Differs',
    statusMissingInVision: 'Vision has no row',
    statusMissingInReference: 'Spreadsheet is silent',
    // Metric labels — these name real processed_units_daily columns.
    metricStrippedProgram: 'Stripped — program',
    metricStrippedNonProgram: 'Stripped — non-program',
    metricSavedUnits: 'Saved units',
    // The migration question this screen exists to answer.
    retirableHeading: 'Can this spreadsheet be retired?',
    retirableYes:
      'Every compared figure agrees across this period. On this evidence Vision matches the workbook for this site.',
    retirableNo:
      'Figures still differ. Each difference is either a Vision gap or a workbook correction — both are findings, and neither is resolved by this screen.',
    referenceOnlyNote: 'Reference data. Not used for payroll, billing, bonus or inventory.',
  },

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
