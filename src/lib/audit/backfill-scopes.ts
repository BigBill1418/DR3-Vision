// ADR-0048 D1 — the ONLY allowed promotion scopes, table-driven.
//
// The directive fixes June as the tracking month: Woodland = 2026-06-01→30,
// Eugene = 2026-06-24→30 (Bill 2026-07-06). Scope enforcement lives in the
// promotion ROUTE — a request may only promote a window that appears here. It is
// a table so a future month is config, not code. `expectedCloseTotal` is the D2
// live-assertion figure (the promotion refuses commit unless the recomputed
// close matches it); null skips the assertion for a window with no known close.

export interface BackfillScopeConfig {
  key: string;
  label: string;
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  expectedCloseTotal: number | null;
}

/** Keyed by `Site.code`. */
export const BACKFILL_SCOPES: Record<string, BackfillScopeConfig[]> = {
  woodland: [
    { key: '2026-06', label: 'June 2026 (Jun 1–30)', from: '2026-06-01', to: '2026-06-30', expectedCloseTotal: 4062 },
  ],
  eugene: [
    { key: '2026-06', label: 'June 2026 (Jun 24–30)', from: '2026-06-24', to: '2026-06-30', expectedCloseTotal: null },
  ],
};

export function allowedScopesForSite(siteCode: string): BackfillScopeConfig[] {
  return BACKFILL_SCOPES[siteCode] ?? [];
}

export function resolveScope(siteCode: string, scopeKey: string): BackfillScopeConfig | null {
  return allowedScopesForSite(siteCode).find((s) => s.key === scopeKey) ?? null;
}
