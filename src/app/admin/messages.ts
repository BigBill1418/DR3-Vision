// ADR-0017 — single en-only string table for the /admin surface.
//
// CLAUDE.md hard rule #4 mandates EN/ES/UR on every user-facing
// surface. The admin Settings panel is admin-only and is staying in
// English for v1 per the Sprint-1-complete follow-up note ("Manager
// portal i18n still pending — don't pull i18n forward into this
// PR"). Concentrating every literal here keeps the eventual i18n
// pass to one mechanical conversion: rename this file to a JSON
// dictionary, drop the keys into ADR-0015's loader, swap callers to
// `t()`. Until then: NO HARD-CODED STRINGS in any /admin component
// — they all come from this object.

export const adminMessages = {
  pageTitle: 'User management',
  pageSubtitle: 'Seed and manage operators, managers, and admins for both sites.',
  backToDashboard: 'Back to dashboard',

  // ADR-0065 — app-chrome labels. /admin mounts no I18nProvider (ADR-0017,
  // English-only), so the chrome takes explicit labels from here rather than
  // `useT()`. When the eventual admin i18n pass happens these move with the
  // rest of this table.
  nav: {
    backToDashboard: 'Dashboard',
    backToDashboardAria: 'Back to dashboard',
    signOut: 'Log out',
    signOutAria: 'Log out of DR3-Vision',
  },

  forbiddenHeading: '403 — admin only',
  forbiddenBody: 'This area is restricted to administrators.',

  // List page
  list: {
    addUser: 'Add user',
    columnName: 'Name',
    columnEmail: 'Email',
    columnRole: 'Role',
    columnSite: 'Primary site',
    columnStatus: 'Status',
    columnLastLogin: 'Last sign-in',
    columnActions: 'Actions',
    edit: 'Edit',
    deactivate: 'Deactivate',
    reactivate: 'Reactivate',
    statusActive: 'Active',
    statusInactive: 'Inactive',
    allSitesBadge: 'All sites',
    filterSite: 'Site',
    filterRole: 'Role',
    filterStatus: 'Status',
    filterAllSites: 'All sites',
    filterAllRoles: 'All roles',
    filterStatusActive: 'Active only',
    filterStatusInactive: 'Inactive only',
    filterStatusAll: 'All',
    empty: 'No users match these filters.',
    neverSignedIn: 'Never',
    confirmDeactivate: 'Deactivate this user? They will be unable to sign in. This is reversible.',
  },

  // Create + edit forms
  form: {
    nameLabel: 'Name',
    nameRequired: 'Name is required.',
    roleLabel: 'Role',
    roleOperator: 'Operator (PIN sign-in)',
    roleManager: 'Manager (SSO sign-in)',
    roleAdmin: 'Admin (SSO sign-in)',
    emailLabel: 'Email',
    emailHelpManager: 'Required for managers and admins (used for SSO).',
    emailHelpOperator: 'Optional for operators.',
    emailRequired: 'Email is required for managers and admins.',
    emailInvalid: 'Enter a valid email address.',
    emailTaken: 'That email is already in use.',
    siteLabel: 'Primary site',
    siteRequired: 'Primary site is required.',
    siteHelpManager: 'Managers see only this site by default.',
    siteHelpAdmin: 'Admins see all sites; primary site is used for default-context routing.',
    processorRoleLabel: 'Processor role (Eugene only)',
    processorRoleHelp: 'Optional. Only meaningful at the Eugene site.',
    processorRoleNone: '—',
    allSitesLabel: 'Access to all sites',
    allSitesHelp:
      'Lets this manager see both Eugene and Woodland — not just their primary site. Grants no admin powers (no user management, bonus amendment, or override). For managers only.',
    canManageRatesLabel: 'Can manage billing rates',
    canManageRatesHelp:
      'Lets this manager edit the billing-rate tables (transport tiers, account overrides, container rentals, fuel prices) under Admin → Billing Rates. Grants no other admin power. For managers only (ADR-0040).',
    canViewBillingVerifyLabel: 'Can view billing verification',
    canViewBillingVerifyHelp:
      'Grants read-only access to Admin → Billing Verification (invoices ready for GP entry plus the audit posture of their windows). No writes, no other admin pages. For managers only; pair with "Access to all sites" for cross-site billing staff (2026-07-09 rollup §1.2 — intended for accounting).',
    pinLabel: 'PIN (4 digits)',
    pinConfirmLabel: 'Confirm PIN',
    pinHelp:
      'Set a 4-digit PIN for the operator. Cannot be all-same, sequential, or repeated-pair.',
    pinRequired: 'PIN is required for operators.',
    pinPattern: 'PIN must be exactly 4 digits.',
    pinMismatch: 'PIN entries do not match.',
    pinInvalidPattern: 'PIN cannot be all-same, sequential, or a repeated pair.',
    pinCollision: 'Another active operator at this site already uses that PIN.',
    submitCreate: 'Create user',
    submitUpdate: 'Save changes',
    cancel: 'Cancel',
    createHeading: 'New user',
    editHeading: 'Edit user',
    notFound: 'User not found.',
  },

  // Edit page extras
  edit: {
    resetPinHeading: 'Reset PIN',
    resetPinHelper: 'Set a new 4-digit PIN. The current PIN is replaced immediately.',
    resetPinButton: 'Reset PIN',
    resetPinSubmit: 'Set new PIN',
    resetPinSuccess: 'PIN updated.',
    deactivateHeading: 'Deactivate account',
    deactivateHelper:
      'Soft-deletes this user. They will be unable to sign in. Audit history is preserved; reactivation restores access.',
    deactivateButton: 'Deactivate user',
    reactivateButton: 'Reactivate user',
    deactivateConfirm: 'Confirm deactivation?',
    reactivateConfirm: 'Confirm reactivation?',
    cannotSelfDeactivate: 'You cannot deactivate your own account.',
  },

  // API surface
  errors: {
    unauthenticated: 'Sign in required.',
    forbidden: 'Admin role required.',
    notFound: 'User not found.',
    invalidPayload: 'Invalid request payload.',
    serverError: 'Unexpected server error.',
    siteNotFound: 'That site does not exist.',
    selfDeactivate: 'You cannot deactivate your own account.',
    notOperator: 'Only operator accounts have a PIN.',
  },

  // Audit log viewer (T-014)
  audit: {
    pageTitle: 'Audit log',
    pageSubtitle:
      'Append-only record of every mutation. Read-only and retained indefinitely (ADR-0007).',
    navLink: 'Audit log',
    filtersHeading: 'Filters',
    filterActor: 'Actor',
    filterTable: 'Table',
    filterFrom: 'From',
    filterTo: 'To',
    filterActions: 'Actions',
    filterAllActors: 'Any actor',
    filterAllTables: 'Any table',
    filterApply: 'Apply filters',
    filterReset: 'Reset',
    columnTimestamp: 'Timestamp',
    columnActor: 'Actor',
    columnAction: 'Action',
    columnTarget: 'Target record',
    columnDiff: 'Changes',
    expandDiff: 'View diff',
    collapseDiff: 'Hide diff',
    beforeLabel: 'Before',
    afterLabel: 'After',
    systemActor: 'System',
    actorRoleAdmin: 'Admin',
    actorRoleManager: 'Manager',
    actorRoleOperator: 'Operator',
    rowDeleted: '(record removed)',
    rowOpaque: '(unlinkable)',
    empty: 'No audit entries match these filters.',
    pageOf: (page: number, total: number) => `Page ${page} of ${total}`,
    summary: (total: number) => `${total.toLocaleString()} entr${total === 1 ? 'y' : 'ies'}`,
    actionInsert: 'Insert',
    actionUpdate: 'Update',
    actionDelete: 'Delete',
    actionSoftDelete: 'Soft-delete',
    actionRestore: 'Restore',
  },

  // MRC-Scrape credential surface (ADR-0057)
  mrc: {
    pageTitle: 'MRC-Scrape',
    heading: 'MyMRC credentials',
    subtitle:
      'The admin login the hourly portal scrape uses to pull DR3 data from MyMRC. Stored encrypted; the password is never displayed.',
    usernameLabel: 'MyMRC username',
    usernameHelp: 'The login id (email or username) for Bill’s MyMRC admin account.',
    passwordLabel: 'MyMRC password',
    passwordHelpUnset: 'Enter the MyMRC admin password. Stored encrypted; never shown again.',
    passwordHelpSet:
      'A password is already stored (encrypted) and is never pre-filled. Re-enter it to save any change.',
    passwordSetPlaceholder: '•••••••• (set)',
    statusConfigured: 'Configured',
    statusNotConfigured: 'Not configured',
    lastUpdated: 'Last updated',
    updatedBy: 'Updated by',
    save: 'Save credentials',
    saving: 'Saving…',
    saved: 'Credentials saved.',
    usernameRequired: 'MyMRC username is required.',
    passwordRequired: 'MyMRC password is required.',
    whitespaceTrimmed:
      'Leading or trailing spaces were removed before saving — MyMRC rejects them.',
  },

  // Equipment master (ADR-0063 — the admin surface C-27 was missing)
  equipment: {
    pageTitle: 'Equipment master',
    pageSubtitle:
      'The asset registry the AP approver picks from when linking an invoice to equipment. Site-scoped; deactivate to remove from the picker.',
    navLink: 'Equipment master',
    terexImportNote:
      'Looking for the Terex downtime spreadsheet? That is a different table — use Terex history import.',
    terexImportLink: 'Terex history import',
    addEquipment: 'Add equipment',

    // List
    columnName: 'Name',
    columnCategory: 'Category',
    columnSite: 'Site',
    columnStatus: 'Status',
    columnLinks: 'AP links',
    columnUpdated: 'Last updated',
    columnActions: 'Actions',
    edit: 'Edit',
    deactivate: 'Deactivate',
    reactivate: 'Reactivate',
    statusActive: 'Active',
    statusInactive: 'Inactive',
    filterSite: 'Site',
    filterCategory: 'Category',
    filterStatus: 'Status',
    filterAllSites: 'All sites',
    filterAllCategories: 'All categories',
    filterStatusActive: 'Active only',
    filterStatusInactive: 'Inactive only',
    filterStatusAll: 'All',
    searchLabel: 'Search',
    searchPlaceholder: 'Unit number or name — e.g. EQ43',
    searchSubmit: 'Search',
    searchClear: 'Clear',
    empty: 'No equipment matches these filters.',
    confirmDeactivate:
      'Deactivate this equipment? It disappears from the AP approver’s picker at BOTH sites — that picker is fleet-wide, and this is the only thing that removes an option from it. Existing approvals keep referencing it. This is reversible.',

    // Category labels
    categoryVehicle: 'Vehicle',
    categoryForklift: 'Forklift',
    categoryBaler: 'Baler',
    categoryTerex: 'Terex / shear',
    categoryOther: 'Other',

    // Create + edit form
    createHeading: 'New equipment',
    editHeading: 'Edit equipment',
    nameLabel: 'Display name',
    nameHelp:
      'What the approver sees in the picker. Convention from the seeded roster: “<Unit #> — <Make> <Type>”, e.g. “EQ43 — Terex Shear”.',
    nameRequired: 'Display name is required.',
    nameTooLong: 'Display name is too long (200 characters maximum).',
    nameTaken:
      'Another equipment record at this site already uses that name. Names must be unique per site — check the inactive rows too.',
    categoryLabel: 'Category',
    categoryHelp: 'Drives nothing today beyond grouping; shear machines belong under Terex.',
    siteLabel: 'Site',
    siteHelp:
      'Where this asset is filed. The AP approver’s picker is fleet-wide (ADR-0046 Amendment 7), so this does not limit who can select it — it is bookkeeping, and much of it came from a coarse jurisdiction guess at seed time, so correcting it here is expected. Editable even on assets an approval already cites.',
    siteRequired: 'Site is required.',
    submitCreate: 'Create equipment',
    submitUpdate: 'Save changes',
    cancel: 'Cancel',
    notFound: 'Equipment not found.',

    // Edit-page extras
    deactivateHeading: 'Deactivate equipment',
    deactivateHelper:
      'Removes this asset from the AP approver’s picker — and since that picker is fleet-wide, this is the only thing that takes an option off it. Approvers at BOTH sites lose it. The row is never deleted: approvals that already cite it stay intact, and reactivation puts it back.',
    deactivateButton: 'Deactivate equipment',
    reactivateButton: 'Reactivate equipment',
    linkedApprovalsNote: (n: number) =>
      `Cited by ${n} AP approval${n === 1 ? '' : 's'} as equipment evidence.`,
    noLinkedApprovals: 'Not yet cited by any AP approval.',
    resultCount: (shown: number) =>
      `${shown.toLocaleString()} record${shown === 1 ? '' : 's'} shown.`,
  },

  // File-drop inbox (O-2)
  fileDrop: {
    title: 'File Drop',
    subtitle:
      'Dump any file here. It is captured and listed — routing is handled downstream, per file.',
    pickFiles: 'Choose files',
    dropHint: 'Drag files here, or click to choose. Any type. Up to 100 MB each.',
    upload: 'Upload',
    uploading: 'Uploading…',
    selectedNone: 'No files selected.',
    uploadFailed: 'Upload failed',
    columnFile: 'File',
    columnKind: 'Detected kind',
    columnSize: 'Size',
    columnType: 'Content type',
    columnStatus: 'Status',
    columnUploadedBy: 'Uploaded by',
    columnWhen: 'When',
    columnNote: 'Note',
    columnActions: 'Actions',
    download: 'Download',
    notStored: 'Not stored (R2 unconfigured)',
    statusReceived: 'Received',
    statusRouted: 'Routed',
    statusDiscarded: 'Discarded',
    markRouted: 'Mark routed',
    markDiscarded: 'Discard',
    markReceived: 'Reopen',
    notePlaceholder: 'What did you do with this file?',
    saveNote: 'Save note',
    empty: 'Nothing dropped yet.',
    refresh: 'Refresh',
  },

  // AP configuration — routing (§1.4) + notification prefs (§1.6), ADR-0066.
  // ONE screen, two routes. Copy carries the semantics: the toggles here are
  // not self-explanatory and a wrong reading of them is what the ADR is about.
  apConfig: {
    pageTitle: 'AP configuration',
    pageSubtitle:
      'Who checks whose approvals, and who hears about what. Both halves feed the same resolver that decides where a second-approval request actually goes.',
    navLink: 'AP configuration',
    tabRouting: 'Second-approval routing',
    tabNotifications: 'Notification preferences',

    // Problems panel
    problemsHeading: 'Configuration warnings',
    problemsNone:
      'No warnings. Every active approver has a routing row and every routed person is reachable.',
    problemsIntro:
      'These are the same problems the resolver reports to the 06:00 digest. An approver with no routing row is not blocked — their second approvals fall back to an admin immediately, which is quiet enough to miss for a week.',
    severityError: 'Will degrade',
    severityWarning: 'Latent',

    // Routing half
    routingHeading: 'Second-approval routing',
    routingIntro:
      'Second approval is determined solely by who signed first (ADR-0066 §1.4). This table must be TOTAL — a first approver with no row falls back to the system admin immediately, with no 24-hour wait.',
    routingColumnFirst: 'First approver',
    routingColumnSecond: 'Second approver',
    routingColumnFallback: 'Fallback',
    routingColumnHours: 'Escalate after',
    routingColumnStatus: 'Status',
    routingColumnActions: '',
    routingEmpty: 'No routing rows match this filter.',
    routingAdd: 'Add routing pair',
    routingEdit: 'Edit',
    routingSave: 'Save pair',
    routingCancel: 'Cancel',
    routingActive: 'Active',
    routingInactive: 'Inactive',
    routingActiveLabel: 'Row is active',
    routingFilterStatus: 'Routing rows',
    routingFilterActive: 'Active only',
    routingFilterInactive: 'Inactive only',
    routingFilterAll: 'All',
    routingHoursLabel: 'Escalate after (business hours)',
    routingHoursHelp:
      'Business hours on the weekday clock (§1.5), not wall-clock hours. Escalation is additive — the routed peer stays able to sign.',
    routingFallbackNone: 'System admin',
    routingFallbackHelp:
      'Leave as “System admin” unless one specific person should be escalated to. NULL means every reachable admin.',
    routingFirstHelp:
      'One row per first approver. Picking someone who already has a row edits that row.',
    routingSecondHelp:
      'Only reachable people are listed: active, manager or admin, and holding an email address. Someone who cannot be emailed is not a second approver — routing to them looks configured and notifies nobody.',
    routingSelfPairNote: 'A person can never be their own second approver.',
    routingUpdatedBy: (who: string) => `Last changed by ${who}`,

    // Namesake disclosure — the operator PIN accounts
    namesakesHeading: 'Accounts deliberately excluded from the pickers',
    namesakesIntro:
      'These active accounts share a name with an approver but cannot be routed to — they are operator PIN accounts with no email address (created 2026-07-28 for the iPad rollout). Selecting one would leave the routing table looking populated while every notification resolved to nobody. Check the email, not the name.',
    namesakesNone: 'None — every active account sharing an approver name is reachable.',

    // Prefs half
    prefsHeading: 'Notification preferences',
    prefsIntro:
      'Per-user, per-event scoping (ADR-0066 §1.6). These filter inside the ADR-0047 notifyStaff() chokepoint and the ap_notify rollout gate — a preference can never promote a pilot-gated surface to live.',
    prefsColumnPerson: 'Person',
    prefsColumnRow: 'Stored',
    prefsRowStored: 'Saved row',
    prefsRowDefaults: 'Defaults',
    prefsRowDefaultsHelp:
      'No ap_notification_prefs row exists for this person. The values shown are the column defaults and are what the system actually uses — a missing row never means “notify nobody”. Toggling anything writes the row.',
    prefsEmpty: 'No approver-role accounts to configure.',

    eventNewInvoice: 'New invoice',
    eventNewInvoiceHelp:
      'The one genuine broadcast: every user with this on is emailed when an invoice lands in the queue.',
    eventSecondApproval: 'Second-approval request',
    eventSecondApprovalHelp:
      'NOT a broadcast. A person is emailed only for requests routed to THEM by the table above (plus the fallback approver on escalation). Switching this off removes someone from their OWN routed requests — it can never add them to anyone else’s.',
    eventDailyDigest: 'Daily digest',
    eventDailyDigestHelp: 'The 06:00 summary, including the configuration warnings above.',
    eventDecisionOutcome: 'Decision outcome',
    eventDecisionOutcomeHelp:
      'Inert. Ships as a column with everyone off and no send path wired — nobody is notified when a decision completes, and this cannot be switched on here. Present so the column is documented where it would be configured.',
    eventInertBadge: 'Not wired',

    // Errors
    errors: {
      selfPair: 'A person cannot be their own second approver.',
      selfFallback:
        'The fallback approver cannot be the first approver — on escalation they would become an authorized second approver on their own invoice.',
      firstApproverInvalid: 'The first approver must be an active manager or admin account.',
      secondApproverUnreachable:
        'That account cannot be a second approver — it is inactive, not a manager/admin, or has no email address. Routing to it would notify nobody.',
      fallbackUnreachable:
        'That fallback account is unreachable — it is inactive, not a manager/admin, or has no email address.',
      hoursOutOfRange: 'Escalation hours must be a whole number between 1 and 168.',
      userNotFound: 'That account no longer exists.',
      notAnApprover: 'Notification preferences apply only to active manager and admin accounts.',
      eventInert:
        'Decision-outcome notifications are not wired to any send path and cannot be enabled.',
    },
  },
} as const;

export type AdminMessages = typeof adminMessages;
