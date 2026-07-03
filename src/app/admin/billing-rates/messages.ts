// ADR-0040 D5 — English-only string table for the /admin/billing-rates surface.
//
// Mirrors the pattern in `src/app/admin/messages.ts` (CLAUDE.md hard rule #4:
// EN/ES/UR everywhere user-facing — the admin billing surface stays English for
// v1, concentrated here so the eventual i18n pass is one mechanical conversion).
// NO hard-coded strings in any billing-rates component: they all come from here.

export const rateMessages = {
  backToDashboard: 'Back to dashboard',
  backToRates: 'Back to billing rates',

  forbiddenHeading: '403 — managers and admins only',
  forbiddenBody: 'Billing rate tables are restricted to managers and administrators.',
  readOnlyNotice:
    'You have read-only access to the billing rate tables. Ask an administrator (or a rate manager) to make changes.',

  hub: {
    title: 'Billing rates',
    subtitle:
      'The four rate tables that feed transport, freight, container-rental, and fuel billing. Edits are audited and effective-date aware — history is never overwritten.',
    tiersLabel: 'Transport rate tiers',
    tiersDescription: 'Mileage-band freight rates per jurisdiction (California / Oregon).',
    haulRatesLabel: 'Account haul rates',
    haulRatesDescription: 'Per-account freight overrides. Seeded empty — Rick adds these from the workbook.',
    rentalsLabel: 'Container rentals',
    rentalsDescription: 'Monthly trailer/container rental sites. Seeded empty — Rick settles the values.',
    fuelLabel: 'Fuel prices',
    fuelDescription: 'Weekly diesel price (EIA auto-fetch plus manual overrides).',
    open: 'Open',
  },

  common: {
    effectiveFrom: 'Effective from',
    effectiveTo: 'Effective to',
    effectiveToOpen: 'Open-ended',
    note: 'Note',
    notePlaceholder: 'Optional note',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    edit: 'Edit',
    create: 'Add',
    serverError: 'Unexpected server error. Please try again.',
    dash: '—',
    required: 'This field is required.',
  },

  tiers: {
    title: 'Transport rate tiers',
    subtitle:
      'Freight is a zone table: the mileage band a haul falls in fixes a flat charge. A set for one jurisdiction and effective date must start at 0 miles and be gap-free and non-overlapping.',
    filterAll: 'All jurisdictions',
    filterCA: 'California',
    filterOR: 'Oregon',
    jurisdiction: 'Jurisdiction',
    jurisdictionCA: 'California (CA)',
    jurisdictionOR: 'Oregon (OR)',
    minMiles: 'Min miles',
    maxMiles: 'Max miles',
    rate: 'Rate ($)',
    empty: 'No transport rate tiers defined yet.',
    windowHeading: (jurisdiction: string, from: string) => `${jurisdiction} — effective ${from}`,
    editorHeading: 'Add or replace a tier set',
    editorHelp:
      'Saving replaces the entire tier set for the chosen jurisdiction and effective-from date. A renegotiation is a new effective date — older sets are left untouched.',
    editThisSet: 'Load into editor',
    addRow: 'Add band',
    removeRow: 'Remove',
    validateAndSave: 'Validate & save set',
    validProblemsHeading: 'Fix these before saving:',
    rowLabel: (n: number) => `Band ${n}`,
    savedOk: 'Tier set saved.',
  },

  haul: {
    title: 'Account haul rates',
    subtitle: 'Per-account freight overrides. When present, an account rate wins over the mileage-band rate.',
    emptyHeading: 'No account overrides yet',
    emptyBody:
      'This table seeds empty by design. Rick adds per-account haul overrides from the billing workbook. Until then, freight falls back to the transport rate tiers.',
    filterAll: 'All accounts',
    account: 'Account (source)',
    rate: 'Rate ($)',
    createHeading: 'Add an account override',
    columnAccount: 'Account',
    columnRate: 'Rate',
    columnEffective: 'Effective',
    columnNote: 'Note',
    columnActions: 'Actions',
    savedOk: 'Account haul rate saved.',
    invalidRate: 'Enter a rate greater than $0.',
    sourceRequired: 'Choose an account.',
  },

  rentals: {
    title: 'Container rentals',
    subtitle: 'Monthly trailer and container rental sites, per operating site.',
    emptyHeading: 'No rental sites yet',
    emptyBody:
      'This table seeds empty by design. Rick settles the rental values and adds each site here. The monthly total below sums every active row currently in force.',
    filterAll: 'All sites',
    monthlyTotalLabel: 'Monthly total (active rows in force)',
    site: 'Site',
    location: 'Location name',
    account: 'Account (source)',
    accountNone: '— none —',
    trailerCount: 'Trailer count',
    trailerSize: 'Trailer size',
    monthlyRate: 'Monthly rate ($)',
    active: 'Active',
    createHeading: 'Add a rental site',
    columnSite: 'Site',
    columnLocation: 'Location',
    columnTrailers: 'Trailers',
    columnMonthly: 'Monthly',
    columnActive: 'Active',
    columnEffective: 'Effective',
    columnActions: 'Actions',
    inForceBadge: 'In force',
    inactiveBadge: 'Inactive',
    savedOk: 'Rental site saved.',
    invalidRate: 'Enter a monthly rate greater than $0.',
    locationRequired: 'Enter a location name.',
    siteRequired: 'Choose a site.',
  },

  fuel: {
    title: 'Fuel prices',
    subtitle:
      'Weekly diesel price per gallon. The EIA feed fetches automatically; a manual entry overwrites that week and wins over a later auto-fetch.',
    manualOverwriteNote:
      'A manual entry replaces the whole week and is stored as source “manual”. It wins over any later EIA auto-fetch for that week.',
    weekOf: 'Week of',
    weekOfHelp: 'Any day in the target week — it is normalized to that week’s Monday.',
    usdPerGal: 'USD per gallon',
    createHeading: 'Add or overwrite a week (manual)',
    columnWeek: 'Week of',
    columnPrice: 'USD / gal',
    columnSource: 'Source',
    columnFetched: 'Recorded',
    columnNote: 'Note',
    sourceEia: 'EIA (auto)',
    sourceManual: 'Manual',
    empty: 'No fuel prices recorded yet.',
    savedOk: 'Fuel price saved.',
    invalidPrice: 'Enter a price greater than $0 and under $100.',
    weekRequired: 'Choose a week.',
  },
} as const;

export type RateMessages = typeof rateMessages;
