// ADR-0074 — canonical serializer for the iPad portal-haul list's view state.
//
// The list's state lives entirely in the URL (`?q=&page=&undated=`) — "the URL IS
// the state", the same contract `src/app/admin/users/list-url.ts` (ADR-0017 Am.1)
// and `src/app/admin/equipment/list-url.ts` (ADR-0063) established. On a shared
// iPad that matters more than on a desktop: an operator hands the device to the
// next shift mid-search, and the screen must be reproducible from what is on it.
//
// DELIBERATELY A SIBLING, NOT A GENERALISATION (ADR-0063 D5, applied again). The
// param sets differ — equipment carries `site`/`category`/`status`, this carries
// `page`/`undated` — and each surface's whitelist is intentionally its own closed
// set. A shared generic would need a schema-descriptor argument that reads worse
// at both call sites than the duplication buys. Function names are kept
// structurally identical so a future extraction stays mechanical.
//
// NO PRISMA. This module is imported by a client component; a value import from
// the data layer would drag the query engine into the browser bundle.

/** Longest `?q=` we round-trip. Anything past this is user error, not a query. */
export const SEARCH_MAX = 100;

/** Raw `searchParams` shape the page receives. */
export interface HaulsListSearchParams {
  q?: string;
  page?: string;
  undated?: string;
}

/** The parsed, validated view state. */
export interface HaulsListParams {
  q: string | undefined;
  page: number;
  undated: boolean;
}

/**
 * Trim and length-clamp a search term. Whitespace-only collapses to `undefined`
 * so a stray space from the iPad keyboard never pins the list to an empty result
 * set and never rides along in the round-trip query string.
 */
export function parseSearch(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t.slice(0, SEARCH_MAX) : undefined;
}

/** 1-based page. Anything non-numeric, zero, negative or fractional is page 1. */
export function parsePage(v: string | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** `undated=1` is the only truthy form; everything else is the full list. */
export function parseUndated(v: string | undefined): boolean {
  return v === '1';
}

/**
 * Whitelist the list-view params out of an arbitrary `searchParams` bag.
 * Deliberately a whitelist — only these three keys survive a round trip, and only
 * with values the list itself accepts.
 */
export function pickHaulsListParams(sp: HaulsListSearchParams | undefined): HaulsListParams {
  return {
    q: parseSearch(sp?.q),
    page: parsePage(sp?.page),
    undated: parseUndated(sp?.undated),
  };
}

/**
 * Serialize view state back into an `/operator/<site>/hauls` href.
 *
 * The defaults (`page=1`, `undated=0`) are OMITTED, so the canonical "no filters"
 * URL stays the bare path and two navigations that mean the same thing produce
 * the same string.
 */
export function buildHaulsListHref(siteCode: string, params: HaulsListParams): string {
  const base = `/operator/${siteCode}/hauls`;
  const sp = new URLSearchParams();
  if (params.q) sp.set('q', params.q);
  if (params.page > 1) sp.set('page', String(params.page));
  if (params.undated) sp.set('undated', '1');
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}
