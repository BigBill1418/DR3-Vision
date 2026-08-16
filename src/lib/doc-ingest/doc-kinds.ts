// ADR-0104 §D9 — the document VOCABULARY, in its own module.
//
// ── Why this is not in `classifier.ts` ──────────────────────────────────────
// `classifier.ts` reaches the Anthropic SDK through `await import(...)` inside
// its fallback. A CLIENT component that imports the vocabulary from there drags
// that dynamic import into the browser bundle. The confirm dropdown
// (`/admin/doc-ingest`) must hold an EXHAUSTIVE `Record<DocKind, string>` of
// labels — that is the mechanism that makes a new class fail to compile until
// somebody labels it — so the vocabulary has to be importable without the
// model-call machinery. `classifier.ts` re-exports everything below, so no
// existing import path changes.
/**
 * The document vocabulary (D5).
 *
 * `vendor_invoice` is in the list precisely so it can be RECOGNIZED and
 * REFUSED. It is not routed here — ADR-0046's AP mailbox is its address — and
 * detecting it lets Vision say where it should have gone instead of silently
 * filing a payable as a data source.
 */
export const DOC_KINDS = [
  'daily_log_workbook',
  'trailer_list',
  'terex_maintenance_log',
  'commodity_audit_tracker',
  // ADR-0104 §D1 — the two new ABSORBABLE classes. Grouped with the other
  // absorbable kinds deliberately; the archive-only kinds follow.
  'outbound_weight_audit',
  'facility_expense_log',
  // ADR-0104 §D8 — registered so the classifier stops asking, NOT to be
  // absorbed. An unconfirmed source is re-proposed every sweep and shows as an
  // open question forever; a registered one is answered. None of these is in
  // `ABSORBABLE_KINDS` and each refusal has a measured reason in the ADR.
  'facility_journal',
  'meeting_notes_log',
  'admin_task_tracker',
  'analysis_workbook',
  'ap_history_report',
  'equipment_inventory',
  'rate_table',
  'mrc_invoice',
  'vendor_invoice',
  'unknown',
] as const;

export type DocKind = (typeof DOC_KINDS)[number];

export function isDocKind(v: string): v is DocKind {
  return (DOC_KINDS as readonly string[]).includes(v);
}

/**
 * ADR-0104 §D9 — one description per kind, and the model's bullet list is
 * GENERATED from it.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 * `userPrompt()` told the model `kind must be exactly one of: ${DOC_KINDS}` —
 * all nine — and then hand-wrote a bullet list describing only six.
 * `trailer_list`, `terex_maintenance_log` and `commodity_audit_tracker` were
 * named as legal and never explained. The Outbound file's stored
 * `proposed_reasoning` shows the model reasoning its way through the
 * contradiction in prod:
 *
 *   "commodity_audit_tracker is the closest listed kind, but since that kind is
 *    not in the allowed list, and none of the allowed kinds clearly match…"
 *
 * It read the bullet list as the allow-list, because a DESCRIBED vocabulary
 * beats an undescribed one. That is not the model being wrong; it is the prompt
 * being two contradictory allow-lists.
 *
 * `Record<DocKind, string>` is the whole point: adding a kind to `DOC_KINDS`
 * without describing it here FAILS THE TYPE CHECK. A hand-maintained mirror of
 * an enum drifts; a derived one cannot.
 */
export const DOC_KIND_DESCRIPTIONS: Record<DocKind, string> = {
  daily_log_workbook:
    'a daily operations log of mattresses received/processed at a facility.',
  trailer_list:
    'a yard log of trailers, with entry date, trailer number, material, weight and exit date.',
  terex_maintenance_log:
    'a machine maintenance log: issues, measures taken, estimated and actual repair costs.',
  commodity_audit_tracker:
    'a coverage matrix recording whether each commodity stream has been audited against vendor invoices, by whom and when. It carries no weights and no amounts.',
  outbound_weight_audit:
    'a MyMRC outbound report export listing shipped loads with a Materials ID, BOL, shipment date, per-commodity weights and dispositions.',
  facility_expense_log:
    'a hand-kept log of facility expenses and invoices already paid, with categories, amounts and invoice numbers.',
  facility_journal: 'a free-text operations journal of daily facility events.',
  meeting_notes_log: 'a free-text log of meeting dates, attendees and notes.',
  admin_task_tracker: 'a project/task tracker with titles, priorities, due dates and % complete.',
  analysis_workbook:
    'a derived analytics workbook of forecasts, ratios, mass balance and pivots computed from other sources.',
  ap_history_report: 'a historical listing of accounts-payable invoices.',
  equipment_inventory: 'a register of physical assets/equipment.',
  rate_table: 'pricing or rates, usually with effective dates.',
  mrc_invoice: 'paperwork from the Mattress Recycling Council.',
  vendor_invoice: 'a single bill from a supplier requesting payment.',
  unknown: 'anything you are not confident about.',
};

